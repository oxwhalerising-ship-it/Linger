/**
 * Electron 主进程入口（双窗口架构 + 透明桌宠浮窗 + 系统托盘）
 * -----------------------------------------------------------
 * 负责管理：
 * 1. 透明无边框置顶的「桌宠浮窗（Pet Window）」：支持全局平滑任意拖拽、双击唤起主控面板、右键菜单。
 * 2. 标准带边框的「主控面板窗口（Dashboard Window）」：启动时与桌宠同时出现，关闭时隐藏到托盘不退出。
 * 3. Windows 系统托盘图标与右键菜单：保证灵儿常驻后台不打扰办公。
 */

const path = require("path");
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  screen,
  nativeImage,
  globalShortcut,
} = require("electron");
const { attachWindowSecurityGuards } = require("./security.cjs");
const { createWin32WindowTracker } = require("./docking/win32Tracker.cjs");

let petWindow = null;
let dashboardWindow = null;
let tray = null;

// 是否真正退出应用（区分“关闭面板隐藏到托盘”与“托盘点击退出”）
let isQuitting = false;
// 当前桌宠状态标记（用于同步托盘菜单勾选状态）
let isAlwaysOnTop = true;
let isDndEnabled = false;
// 桌宠当前尺寸模式："compact" | "quick-chat" | "call"
let petWindowMode = "compact";
// 当前正在占用实时语音通话的窗口："none" | "pet" | "dashboard"
let activeVoiceCallOwner = "none";

// 紧凑态预留 380×360 充裕透明环绕舞台（彻底杜绝灵儿手臂/云朵枕头/7 枚环绕水晶按钮及悬浮标签被裁切）
// 展开态与通话态向下/向上延展，为头顶实时通话字幕气泡与底部输入条/通话卡预留零遮挡空间
const PET_COMPACT_WIDTH = 380;
const PET_COMPACT_HEIGHT = 360;
const PET_EXPANDED_WIDTH = 380;
const PET_EXPANDED_HEIGHT = 440;
const PET_CALL_WIDTH = 380;
const PET_CALL_HEIGHT = 476;

// 主进程拖拽追踪状态（基于全局光标坐标，彻底规避 Windows DPI 缩放漂移与跨屏断触）
let petDragState = null;
let petDragTimer = null;
// 边缘躲藏偷看 / 应用窗口边框倚靠与坐下 / 主控面板跟随状态
let petDockState = {
  mode: "none", // "none" | "edge-peek" | "window-dock" | "dashboard-dock"
  pose: "none",
  peekBounds: null,
  revealBounds: null,
  revealed: false,
  targetHwnd: null,
  anchorX: "left", // "left" | "right"
  anchorY: "top", // "top" | "bottom"
  offsetX: 0,
  offsetY: 0,
};
let petSlideTimer = null;
let peekRetractTimer = null;
let externalWindowTrackProc = null;
let dockDetectSeq = 0;
let summonShortcutLabel = "Alt+Shift+L";

/**
 * 动态生成 16x16 的暖黄色治愈系小精灵托盘图标（无需外部 .ico 文件即可在 Windows 稳定显示）
 */
function createTrayIcon() {
  const size = 16;
  const buffer = Buffer.alloc(size * size * 4);
  const cx = 7.5;
  const cy = 8.0;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // 默认透明像素
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      // 头顶小嫩芽（绿色像素）
      if ((x === 7 || x === 8) && (y === 1 || y === 2)) {
        r = 74;
        g = 222;
        b = 128;
        a = 255;
      } else if (dist <= 6.2) {
        // 小精灵圆润主体（暖橘杏色）
        r = 251;
        g = 191;
        b = 36;
        a = 255;
        // 外圈微深轮廓
        if (dist > 5.2) {
          r = 245;
          g = 158;
          b = 11;
        }
        // 两只可爱深棕色小眼睛
        if ((x === 5 || x === 10) && y === 8) {
          r = 68;
          g = 64;
          b = 60;
        }
        // 粉红腮红
        if ((x === 4 || x === 11) && y === 9) {
          r = 251;
          g = 113;
          b = 133;
        }
      }

      buffer[idx] = r;
      buffer[idx + 1] = g;
      buffer[idx + 2] = b;
      buffer[idx + 3] = a;
    }
  }

  return nativeImage.createFromBuffer(buffer, { width: size, height: size });
}

/**
 * 加载指定窗口模式的前端页面（开发期走 Vite，生产期加载 dist/index.html）
 * @param {BrowserWindow} win 目标窗口实例
 * @param {"pet" | "dashboard"} mode 窗口模式
 */
function loadWindowPage(win, mode) {
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    win.loadURL(`${devServerUrl}/?window=${mode}`);
  } else {
    win.loadFile(path.join(__dirname, "../dist/index.html"), {
      query: { window: mode },
    });
  }
}

function getPetDimensionsForMode(mode) {
  if (mode === "call") {
    return { width: PET_CALL_WIDTH, height: PET_CALL_HEIGHT };
  }
  if (mode === "quick-chat") {
    return { width: PET_EXPANDED_WIDTH, height: PET_EXPANDED_HEIGHT };
  }
  return { width: PET_COMPACT_WIDTH, height: PET_COMPACT_HEIGHT };
}

/**
 * 计算桌宠默认停靠位置（主屏幕右下角工作区，避开 Windows 任务栏）
 */
function getDefaultPetPosition(mode = "compact") {
  const normalized =
    typeof mode === "boolean" ? (mode ? "quick-chat" : "compact") : mode;
  const { width, height, x, y } = screen.getPrimaryDisplay().workArea;
  const { width: winW, height: winH } = getPetDimensionsForMode(normalized);
  const extraRight =
    normalized === "compact"
      ? 20 + Math.round((PET_EXPANDED_WIDTH - PET_COMPACT_WIDTH) / 2)
      : 20;
  const extraBottom =
    normalized === "compact"
      ? 12 + (PET_EXPANDED_HEIGHT - PET_COMPACT_HEIGHT)
      : 12;
  return {
    x: Math.round(x + width - winW - extraRight),
    y: Math.round(y + height - winH - extraBottom),
  };
}

/** 停止拖拽轮询定时器 */
function stopPetDragLoop() {
  if (petDragTimer) {
    clearInterval(petDragTimer);
    petDragTimer = null;
  }
  petDragState = null;
}

/** 停止窗口滑行补间动画与缩回计时器 */
function stopPetSlideAnim() {
  if (petSlideTimer) {
    clearInterval(petSlideTimer);
    petSlideTimer = null;
  }
  if (peekRetractTimer) {
    clearTimeout(peekRetractTimer);
    peekRetractTimer = null;
  }
}

/** 平滑将桌宠窗口滑行到目标坐标（ease-out cubic，60fps） */
function animatePetWindowTo(targetX, targetY, durationMs = 220, onDone) {
  if (!petWindow || petWindow.isDestroyed()) return;
  stopPetSlideAnim();
  const bounds = petWindow.getBounds();
  const { width: targetW, height: targetH } =
    getPetDimensionsForMode(petWindowMode);
  const startX = bounds.x;
  const startY = bounds.y;
  const endX = Math.round(targetX);
  const endY = Math.round(targetY);

  if (Math.abs(endX - startX) <= 1 && Math.abs(endY - startY) <= 1) {
    petWindow.setBounds({ x: endX, y: endY, width: targetW, height: targetH });
    if (onDone) onDone();
    return;
  }

  const startMs = Date.now();
  petSlideTimer = setInterval(() => {
    if (!petWindow || petWindow.isDestroyed()) {
      stopPetSlideAnim();
      return;
    }
    const elapsed = Date.now() - startMs;
    const t = Math.min(1, elapsed / Math.max(16, durationMs));
    const ease = 1 - Math.pow(1 - t, 3);
    const curX = Math.round(startX + (endX - startX) * ease);
    const curY = Math.round(startY + (endY - startY) * ease);
    petWindow.setBounds({ x: curX, y: curY, width: targetW, height: targetH });
    if (t >= 1) {
      stopPetSlideAnim();
      if (onDone) onDone();
    }
  }, 16);
}

const win32WindowTracker = createWin32WindowTracker({
  screen,
  getPetWindow: () => petWindow,
});

/** 停止外部应用窗口实时跟随子进程 */
function stopExternalWindowTracker() {
  win32WindowTracker.stop();
}

/** 根据宿主窗口矩形与锚点偏移，计算桌宠跟随位置并立即同步 */
function syncPetToHostRect(hostRect) {
  if (!petWindow || petWindow.isDestroyed() || petDragState || petWindowMode !== "compact") {
    return;
  }
  const { width: targetW, height: targetH } = getPetDimensionsForMode("compact");
  const baseX =
    petDockState.anchorX === "right" ? hostRect.x + hostRect.width : hostRect.x;
  const baseY =
    petDockState.anchorY === "bottom" ? hostRect.y + hostRect.height : hostRect.y;
  const nextX = Math.round(baseX + petDockState.offsetX);
  const nextY = Math.round(baseY + petDockState.offsetY);
  const cur = petWindow.getBounds();
  if (cur.x === nextX && cur.y === nextY && cur.width === targetW && cur.height === targetH) {
    return;
  }
  petWindow.setBounds({ x: nextX, y: nextY, width: targetW, height: targetH });
}

/** 启动单窗口轻量化外部应用位置追踪器（已抽离至 docking/win32Tracker.cjs） */
function startExternalWindowTracker(hwnd) {
  win32WindowTracker.start(hwnd, {
    onGone: (targetHwnd) => {
      if (petDockState.mode === "window-dock" && petDockState.targetHwnd === targetHwnd) {
        clearPetDockState(true);
      }
    },
    onMove: (targetHwnd, dip) => {
      if (
        petDockState.mode !== "window-dock" ||
        petDockState.targetHwnd !== targetHwnd ||
        !petWindow ||
        petWindow.isDestroyed() ||
        petDragState
      ) {
        return;
      }
      stopPetSlideAnim();
      syncPetToHostRect(dip);
    },
  });
}

/** 重置边缘躲藏/窗口依附状态并通知渲染层 */
function clearPetDockState(notifyRenderer = true) {
  stopPetSlideAnim();
  stopExternalWindowTracker();
  const hadPose = petDockState.pose !== "none" || petDockState.mode !== "none";
  petDockState = {
    mode: "none",
    pose: "none",
    peekBounds: null,
    revealBounds: null,
    revealed: false,
    targetHwnd: null,
    anchorX: "left",
    anchorY: "top",
    offsetX: 0,
    offsetY: 0,
  };
  if (notifyRenderer && hadPose) {
    sendToPet("pet:dock-state-changed", { pose: "none", isPeeking: false });
  }
}

/** 在 Windows 上查询当前可见的顶层应用窗口矩形（已抽离至 docking/win32Tracker.cjs） */
function queryVisibleAppWindowRects() {
  return win32WindowTracker.queryVisibleAppWindowRects();
}

/** 检测灵儿是否靠近某个目标窗口的四条边框，返回最佳吸附姿态与锚点偏移 */
function matchWindowBorder(r, bounds, winW, winH, bodyCX, bodyCY, avatarHalfW, avatarHalfH) {
  const snapThreshold = 46;
  let best = null;
  const inXSpan = bodyCX >= r.x + 12 && bodyCX <= r.x + r.width - 12;
  const inYSpan = bodyCY >= r.y + 24 && bodyCY <= r.y + r.height - 24;

  if (inXSpan) {
    // 上边框（窗口标题栏上方坐下）
    const dTop = Math.abs(bodyCY + avatarHalfH - r.y);
    if (dTop <= snapThreshold && (!best || dTop < best.dist)) {
      const targetX = bounds.x;
      const targetY = Math.round(r.y - winH / 2 - avatarHalfH + 18);
      best = {
        dist: dTop,
        pose: "sit-top",
        targetX,
        targetY,
        anchorX: "left",
        anchorY: "top",
        offsetX: targetX - r.x,
        offsetY: targetY - r.y,
      };
    }
    // 下边框（窗口底边坐下）
    const dBottom = Math.abs(bodyCY + avatarHalfH - (r.y + r.height));
    if (dBottom <= snapThreshold && (!best || dBottom < best.dist)) {
      const targetX = bounds.x;
      const targetY = Math.round(r.y + r.height - winH / 2 - avatarHalfH + 18);
      best = {
        dist: dBottom,
        pose: "sit-bottom",
        targetX,
        targetY,
        anchorX: "left",
        anchorY: "bottom",
        offsetX: targetX - r.x,
        offsetY: targetY - (r.y + r.height),
      };
    }
  }

  if (inYSpan) {
    // 左边框（倚靠）
    const dLeft = Math.abs(bodyCX - r.x);
    if (dLeft <= snapThreshold + avatarHalfW * 0.65 && (!best || dLeft < best.dist)) {
      const isOutsideLeft = bodyCX <= r.x;
      const targetX = Math.round(
        isOutsideLeft ? r.x - winW / 2 - 28 : r.x - winW / 2 + 28,
      );
      const targetY = bounds.y;
      best = {
        dist: dLeft,
        pose: isOutsideLeft ? "lean-right" : "lean-left",
        targetX,
        targetY,
        anchorX: "left",
        anchorY: "top",
        offsetX: targetX - r.x,
        offsetY: targetY - r.y,
      };
    }
    // 右边框（倚靠）
    const dRight = Math.abs(bodyCX - (r.x + r.width));
    if (dRight <= snapThreshold + avatarHalfW * 0.65 && (!best || dRight < best.dist)) {
      const isOutsideRight = bodyCX >= r.x + r.width;
      const targetX = Math.round(
        isOutsideRight
          ? r.x + r.width - winW / 2 + 28
          : r.x + r.width - winW / 2 - 28,
      );
      const targetY = bounds.y;
      best = {
        dist: dRight,
        pose: isOutsideRight ? "lean-left" : "lean-right",
        targetX,
        targetY,
        anchorX: "right",
        anchorY: "top",
        offsetX: targetX - (r.x + r.width),
        offsetY: targetY - r.y,
      };
    }
  }

  return best;
}

/** 若灵儿当前处于主控面板区域内且尚未绑定其他宿主，则自动融入主控面板并记录相对偏移 */
function tryAttachPetToDashboardIfInside() {
  if (
    !petWindow ||
    petWindow.isDestroyed() ||
    !petWindow.isVisible() ||
    !dashboardWindow ||
    dashboardWindow.isDestroyed() ||
    !dashboardWindow.isVisible() ||
    dashboardWindow.isMinimized() ||
    petDragState ||
    petWindowMode !== "compact" ||
    petDockState.mode !== "none"
  ) {
    return false;
  }
  const bounds = petWindow.getBounds();
  const { width: winW, height: winH } = getPetDimensionsForMode("compact");
  const bodyCX = bounds.x + winW / 2;
  const bodyCY = bounds.y + winH / 2;
  const db = dashboardWindow.getBounds();

  if (
    bodyCX >= db.x &&
    bodyCX <= db.x + db.width &&
    bodyCY >= db.y &&
    bodyCY <= db.y + db.height
  ) {
    petDockState = {
      mode: "dashboard-dock",
      pose: "none",
      peekBounds: null,
      revealBounds: null,
      revealed: false,
      targetHwnd: null,
      anchorX: "left",
      anchorY: "top",
      offsetX: bounds.x - db.x,
      offsetY: bounds.y - db.y,
    };
    return true;
  }
  return false;
}

/**
 * 拖拽结束后的智能吸附检测：
 * 1. 靠近显示器左/右/上边缘 -> 自动躲藏并探出小脑袋偷看
 * 2. 靠近其他应用窗口左右边框 -> 自动倚靠
 * 3. 靠近其他应用窗口上下边框 -> 自动坐下晃脚
 */
async function detectAndApplyDockState() {
  if (!petWindow || petWindow.isDestroyed() || petWindowMode !== "compact") {
    return;
  }
  const mySeq = ++dockDetectSeq;
  const bounds = petWindow.getBounds();
  const { width: winW, height: winH } = getPetDimensionsForMode("compact");
  const display = screen.getDisplayMatching(bounds);
  const wa = display.workArea;

  // 灵儿本体中心与大致身形半宽/半高（在 380×360 透明舞台居中）
  const bodyCX = bounds.x + winW / 2;
  const bodyCY = bounds.y + winH / 2;
  const avatarHalfW = 46;
  const avatarHalfH = 74;

  // 1. 优先检测：是否贴近显示器左 / 右 / 上边缘 -> 缩进边缘只漏侧边身与小脑袋探头探脑偷看
  const edgeThreshold = 72;
  const distLeft = bodyCX - avatarHalfW - wa.x;
  const distRight = wa.x + wa.width - (bodyCX + avatarHalfW);
  const distTop = bodyCY - avatarHalfH - wa.y;

  const clampedRevealY = Math.max(
    wa.y + 8,
    Math.min(wa.y + wa.height - winH - 8, bounds.y),
  );
  const clampedRevealX = Math.max(
    wa.x + 8,
    Math.min(wa.x + wa.width - winW - 8, bounds.x),
  );

  if (distLeft <= edgeThreshold) {
    // 缩进左边缘，仅露出右侧半身与探头偷看的小脑袋
    const peekX = Math.round(wa.x - winW / 2 + 8);
    const revealX = wa.x + 6;
    petDockState = {
      mode: "edge-peek",
      pose: "peek-left",
      peekBounds: { x: peekX, y: clampedRevealY },
      revealBounds: { x: revealX, y: clampedRevealY },
      revealed: false,
      targetHwnd: null,
      anchorX: "left",
      anchorY: "top",
      offsetX: 0,
      offsetY: 0,
    };
    sendToPet("pet:dock-state-changed", { pose: "peek-left", isPeeking: true });
    animatePetWindowTo(peekX, clampedRevealY, 240);
    return;
  }

  if (distRight <= edgeThreshold) {
    // 缩进右边缘，仅露出左侧半身与探头偷看的小脑袋
    const peekX = Math.round(wa.x + wa.width - winW / 2 - 8);
    const revealX = wa.x + wa.width - winW - 6;
    petDockState = {
      mode: "edge-peek",
      pose: "peek-right",
      peekBounds: { x: peekX, y: clampedRevealY },
      revealBounds: { x: revealX, y: clampedRevealY },
      revealed: false,
      targetHwnd: null,
      anchorX: "left",
      anchorY: "top",
      offsetX: 0,
      offsetY: 0,
    };
    sendToPet("pet:dock-state-changed", { pose: "peek-right", isPeeking: true });
    animatePetWindowTo(peekX, clampedRevealY, 240);
    return;
  }

  if (distTop <= edgeThreshold) {
    // 缩进上边缘，仅探出小脑袋往下偷看
    const peekY = Math.round(wa.y - winH / 2 + 16);
    const revealY = wa.y + 6;
    petDockState = {
      mode: "edge-peek",
      pose: "peek-top",
      peekBounds: { x: clampedRevealX, y: peekY },
      revealBounds: { x: clampedRevealX, y: revealY },
      revealed: false,
      targetHwnd: null,
      anchorX: "left",
      anchorY: "top",
      offsetX: 0,
      offsetY: 0,
    };
    sendToPet("pet:dock-state-changed", { pose: "peek-top", isPeeking: true });
    animatePetWindowTo(clampedRevealX, peekY, 240);
    return;
  }

  // 2. 检测灵儿自己的主控面板（边框贴靠/坐下，或落在面板区域内部直接融入并跟随移动）
  const hasVisibleDashboard = Boolean(
    dashboardWindow &&
      !dashboardWindow.isDestroyed() &&
      dashboardWindow.isVisible() &&
      !dashboardWindow.isMinimized(),
  );
  const dashBounds = hasVisibleDashboard ? dashboardWindow.getBounds() : null;

  if (dashBounds) {
    const dashBorderMatch = matchWindowBorder(
      dashBounds,
      bounds,
      winW,
      winH,
      bodyCX,
      bodyCY,
      avatarHalfW,
      avatarHalfH,
    );
    if (dashBorderMatch) {
      petDockState = {
        mode: "dashboard-dock",
        pose: dashBorderMatch.pose,
        peekBounds: null,
        revealBounds: null,
        revealed: false,
        targetHwnd: null,
        anchorX: dashBorderMatch.anchorX,
        anchorY: dashBorderMatch.anchorY,
        offsetX: dashBorderMatch.offsetX,
        offsetY: dashBorderMatch.offsetY,
      };
      sendToPet("pet:dock-state-changed", {
        pose: dashBorderMatch.pose,
        isPeeking: false,
      });
      animatePetWindowTo(dashBorderMatch.targetX, dashBorderMatch.targetY, 200);
      return;
    }

    // 落在主控面板内部：直接融入主控面板随其一起运动（灵儿仍可随时单独拖动）
    if (
      bodyCX >= dashBounds.x &&
      bodyCX <= dashBounds.x + dashBounds.width &&
      bodyCY >= dashBounds.y &&
      bodyCY <= dashBounds.y + dashBounds.height
    ) {
      petDockState = {
        mode: "dashboard-dock",
        pose: "none",
        peekBounds: null,
        revealBounds: null,
        revealed: false,
        targetHwnd: null,
        anchorX: "left",
        anchorY: "top",
        offsetX: bounds.x - dashBounds.x,
        offsetY: bounds.y - dashBounds.y,
      };
      sendToPet("pet:dock-state-changed", { pose: "none", isPeeking: false });
      return;
    }
  }

  // 3. 检测其他应用窗口的四条边框：上下边框坐下，左右边框倚靠，并吸附跟随该应用一起移动
  const appRects = await queryVisibleAppWindowRects();
  if (mySeq !== dockDetectSeq || !petWindow || petWindow.isDestroyed() || petDragState) {
    return;
  }

  let best = null;
  for (const r of appRects) {
    // 忽略几乎铺满整个工作区的最大化窗口（其边框与屏幕边缘重合）
    if (r.width >= wa.width * 0.94 && r.height >= wa.height * 0.92) {
      continue;
    }
    const matched = matchWindowBorder(
      r,
      bounds,
      winW,
      winH,
      bodyCX,
      bodyCY,
      avatarHalfW,
      avatarHalfH,
    );
    if (matched) {
      best = { ...matched, hwnd: r.hwnd };
      break; // 按 Z-order 优先匹配最顶层应用窗口
    }
  }

  if (best) {
    petDockState = {
      mode: "window-dock",
      pose: best.pose,
      peekBounds: null,
      revealBounds: null,
      revealed: false,
      targetHwnd: best.hwnd,
      anchorX: best.anchorX,
      anchorY: best.anchorY,
      offsetX: best.offsetX,
      offsetY: best.offsetY,
    };
    sendToPet("pet:dock-state-changed", { pose: best.pose, isPeeking: false });
    animatePetWindowTo(best.targetX, best.targetY, 200, () => {
      if (petDockState.mode === "window-dock" && petDockState.targetHwnd === best.hwnd) {
        startExternalWindowTracker(best.hwnd);
      }
    });
    return;
  }

  clearPetDockState(true);
}

/** 快捷键/托盘召唤灵儿出场（若隐藏则现身，若在边缘偷看则滑出并开心打招呼） */
function summonPetToStage() {
  if (!petWindow || petWindow.isDestroyed()) {
    createPetWindow();
  }
  stopPetSlideAnim();

  const { width: targetW, height: targetH } =
    getPetDimensionsForMode(petWindowMode);
  const wasHidden = !petWindow.isVisible();
  const wasPeeking = petDockState.mode === "edge-peek";
  const revealTarget = petDockState.revealBounds;

  clearPetDockState(true);

  if (wasHidden) {
    // 从隐藏状态召唤出场：定位到当前鼠标所在显示器舒适位置
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    const wa = display.workArea;
    const x = Math.max(
      wa.x + 16,
      Math.min(wa.x + wa.width - targetW - 16, Math.round(cursor.x - targetW / 2)),
    );
    const y = Math.max(
      wa.y + 16,
      Math.min(wa.y + wa.height - targetH - 16, Math.round(cursor.y - targetH / 2)),
    );
    applyPetWindowBounds(x, y, targetW, targetH);
    petWindow.showInactive();
  } else if (wasPeeking && revealTarget) {
    petWindow.showInactive();
    animatePetWindowTo(revealTarget.x, revealTarget.y, 240);
  } else {
    // 已在屏幕上可见：确保处于当前屏幕工作区内并置顶亮相
    const bounds = petWindow.getBounds();
    const display = screen.getDisplayMatching(bounds);
    const wa = display.workArea;
    const clampedX = Math.max(
      wa.x + 12,
      Math.min(wa.x + wa.width - targetW - 12, bounds.x),
    );
    const clampedY = Math.max(
      wa.y + 12,
      Math.min(wa.y + wa.height - targetH - 12, bounds.y),
    );
    petWindow.showInactive();
    if (clampedX !== bounds.x || clampedY !== bounds.y) {
      animatePetWindowTo(clampedX, clampedY, 200);
    }
  }

  petWindow.setAlwaysOnTop(isAlwaysOnTop, "screen-saver");
  petWindow.moveTop();
  lockPetWindowZoom();
  sendToPet("pet:summoned", { shortcut: summonShortcutLabel });
  refreshTrayMenu();
}

/** 注册全局快捷键召唤灵儿出场（优先 Alt+Shift+L，被占用时降级 Ctrl+Alt+L） */
function registerSummonShortcut() {
  const candidates = ["Alt+Shift+L", "CommandOrControl+Alt+L"];
  for (const accel of candidates) {
    try {
      const ok = globalShortcut.register(accel, () => {
        summonPetToStage();
      });
      if (ok) {
        summonShortcutLabel = accel.replace("CommandOrControl", "Ctrl");
        return;
      }
    } catch {
      // try next candidate
    }
  }
}

/**
 * 强制校准桌宠窗口内容区尺寸与位置（规避 Windows HiDPI + resizable:false 下 setBounds 失效或缩放漂移）
 */
function applyPetWindowBounds(x, y, targetW, targetH) {
  if (!petWindow || petWindow.isDestroyed()) return;
  const roundedX = Math.round(x);
  const roundedY = Math.round(y);
  const [curCW, curCH] = petWindow.getContentSize();
  const curBounds = petWindow.getBounds();

  if (
    curBounds.x === roundedX &&
    curBounds.y === roundedY &&
    curCW === targetW &&
    curCH === targetH
  ) {
    return;
  }

  const needsResize = curCW !== targetW || curCH !== targetH;
  if (needsResize) {
    petWindow.setResizable(true);
    petWindow.setBounds({
      x: roundedX,
      y: roundedY,
      width: targetW,
      height: targetH,
    });
    petWindow.setContentSize(targetW, targetH);
    petWindow.setResizable(false);
  } else {
    petWindow.setBounds({
      x: roundedX,
      y: roundedY,
      width: targetW,
      height: targetH,
    });
  }
}

/** 锁定桌宠页面缩放为 100%，防止主控面板同源缩放（Ctrl+滚轮）连带放大裁切桌宠 */
function lockPetWindowZoom() {
  if (!petWindow || petWindow.isDestroyed()) return;
  try {
    petWindow.webContents.setZoomFactor(1);
    void petWindow.webContents.setVisualZoomLevelLimits(1, 1);
  } catch {
    // ignore zoom lock errors before webContents ready
  }
}

/** 根据当前全局鼠标坐标更新桌宠窗口位置（支持全桌面/多屏任意拖拽，始终锁定标准模式尺寸防 DPI 缩小） */
function applyPetDragPosition() {
  if (!petWindow || petWindow.isDestroyed() || !petDragState) return;
  const cursor = screen.getCursorScreenPoint();
  const nextX = Math.round(
    petDragState.startWinX + (cursor.x - petDragState.startCursorX),
  );
  const nextY = Math.round(
    petDragState.startWinY + (cursor.y - petDragState.startCursorY),
  );
  if (nextX === petDragState.lastX && nextY === petDragState.lastY) return;
  petDragState.lastX = nextX;
  petDragState.lastY = nextY;
  const { width: targetW, height: targetH } =
    getPetDimensionsForMode(petWindowMode);
  petWindow.setBounds({
    x: nextX,
    y: nextY,
    width: targetW,
    height: targetH,
  });
}

/** 切换桌宠窗口模式（compact / quick-chat / call），保持小精灵在屏幕上的视觉位置不动并避免贴边裁切 */
function setPetWindowMode(nextMode) {
  const normalized =
    typeof nextMode === "boolean"
      ? nextMode
        ? "quick-chat"
        : "compact"
      : nextMode === "call" || nextMode === "quick-chat"
        ? nextMode
        : "compact";

  if (!petWindow || petWindow.isDestroyed()) {
    return;
  }
  const bounds = petWindow.getBounds();
  const [contentW, contentH] = petWindow.getContentSize();
  const { width: targetW, height: targetH } = getPetDimensionsForMode(normalized);
  if (
    petWindowMode === normalized &&
    bounds.width === targetW &&
    bounds.height === targetH &&
    contentW === targetW &&
    contentH === targetH
  ) {
    lockPetWindowZoom();
    return;
  }
  const deltaX = Math.round((bounds.width - targetW) / 2);
  let nextX = bounds.x + deltaX;
  let nextY = bounds.y;

  // 展开为通话卡片或输入条时，先退出边缘躲藏/依附状态，若靠屏幕底部/边缘太近则轻柔内收，避免按钮被任务栏遮挡
  if (normalized !== "compact") {
    clearPetDockState(true);
    const display = screen.getDisplayMatching(bounds);
    const workArea = display.workArea;
    if (nextX + targetW > workArea.x + workArea.width - 8) {
      nextX = workArea.x + workArea.width - targetW - 8;
    }
    if (nextX < workArea.x + 8) {
      nextX = workArea.x + 8;
    }
    if (nextY + targetH > workArea.y + workArea.height - 8) {
      nextY = workArea.y + workArea.height - targetH - 8;
    }
    if (nextY < workArea.y + 8) {
      nextY = workArea.y + 8;
    }
  }

  petWindowMode = normalized;
  applyPetWindowBounds(nextX, nextY, targetW, targetH);
  lockPetWindowZoom();

  // 仅快捷输入框需要键盘聚焦；通话态保持不抢占办公窗口焦点，且仍可正常点击静音/打断/挂断按钮
  const needsKeyboardFocus = normalized === "quick-chat";
  petWindow.setFocusable(needsKeyboardFocus);
  if (needsKeyboardFocus) {
    petWindow.focus();
  }
}

/**
 * 创建无边框透明置顶的桌宠浮窗
 */
function createPetWindow() {
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.showInactive();
    return petWindow;
  }

  petWindowMode = "compact";
  const pos = getDefaultPetPosition("compact");

  petWindow = new BrowserWindow({
    width: PET_COMPACT_WIDTH,
    height: PET_COMPACT_HEIGHT,
    useContentSize: true,
    x: pos.x,
    y: pos.y,
    title: "",
    transparent: true,
    backgroundColor: "#00000000",
    backgroundMaterial: "none",
    frame: false,
    thickFrame: false,
    roundedCorners: false,
    autoHideMenuBar: true,
    alwaysOnTop: isAlwaysOnTop,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  // 彻底移除窗口菜单与标题更新，防止桌宠顶部出现任何系统标题栏或字符
  petWindow.removeMenu();
  petWindow.on("page-title-updated", (event) => {
    event.preventDefault();
  });

  // 紧凑窗口紧贴小精灵，直接保持正常鼠标交互，确保 Windows 下拖拽、双击、右键 100% 灵敏不丢事件
  petWindow.setIgnoreMouseEvents(false);

  // 提升 Windows 置顶层级，确保在普通办公软件上方可见
  petWindow.setAlwaysOnTop(isAlwaysOnTop, "screen-saver");

  // 页面加载完成时强制重置缩放为 100% 并校准内容区尺寸，彻底杜绝同源缩放或 HiDPI 裁切
  petWindow.webContents.on("dom-ready", () => {
    lockPetWindowZoom();
  });
  petWindow.webContents.on("did-finish-load", () => {
    if (!petWindow || petWindow.isDestroyed()) return;
    lockPetWindowZoom();
    const bounds = petWindow.getBounds();
    const { width: targetW, height: targetH } =
      getPetDimensionsForMode(petWindowMode);
    applyPetWindowBounds(bounds.x, bounds.y, targetW, targetH);
    tryAttachPetToDashboardIfInside();
    sendToPet("pet:dnd-changed", isDndEnabled);
  });

  attachWindowSecurityGuards(petWindow);
  loadWindowPage(petWindow, "pet");

  petWindow.on("blur", () => {
    stopPetDragLoop();
  });

  petWindow.on("hide", () => {
    stopPetDragLoop();
    stopPetSlideAnim();
    stopExternalWindowTracker();
  });

  petWindow.on("closed", () => {
    stopPetDragLoop();
    stopPetSlideAnim();
    stopExternalWindowTracker();
    clearPetDockState(false);
    petWindowMode = "compact";
    if (activeVoiceCallOwner === "pet") {
      activeVoiceCallOwner = "none";
      refreshTrayMenu();
    }
    petWindow = null;
  });

  return petWindow;
}

/**
 * 创建或唤醒主控面板窗口
 */
function openDashboardWindow() {
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    if (dashboardWindow.isMinimized()) {
      dashboardWindow.restore();
    }
    dashboardWindow.show();
    // 借助短暂置顶再取消，确保在 Windows 上从桌宠双击或托盘点击时能稳定弹出到最前
    dashboardWindow.setAlwaysOnTop(true);
    dashboardWindow.focus();
    dashboardWindow.moveTop();
    dashboardWindow.setAlwaysOnTop(false);
    return dashboardWindow;
  }

  dashboardWindow = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 780,
    minHeight: 560,
    title: "灵儿 — 台湾腔治愈系小管家",
    backgroundColor: "#ffffff",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  dashboardWindow.on("page-title-updated", (event) => {
    event.preventDefault();
  });

  attachWindowSecurityGuards(dashboardWindow);
  loadWindowPage(dashboardWindow, "dashboard");

  dashboardWindow.once("ready-to-show", () => {
    if (dashboardWindow && !dashboardWindow.isDestroyed()) {
      dashboardWindow.show();
      dashboardWindow.focus();
    }
  });

  // 当灵儿处于主控面板内或边框上时，自动融入主控面板并原生 60fps 同步跟随移动与缩放（灵儿自身仍可随时单独拖动）
  const handleDashboardTransform = () => {
    if (
      petDockState.mode === "dashboard-dock" &&
      dashboardWindow &&
      !dashboardWindow.isDestroyed() &&
      !petDragState
    ) {
      stopPetSlideAnim();
      syncPetToHostRect(dashboardWindow.getBounds());
    }
  };
  dashboardWindow.on("focus", () => {
    tryAttachPetToDashboardIfInside();
  });
  dashboardWindow.on("show", () => {
    tryAttachPetToDashboardIfInside();
  });
  dashboardWindow.on("will-move", () => {
    tryAttachPetToDashboardIfInside();
  });
  dashboardWindow.on("move", handleDashboardTransform);
  dashboardWindow.on("resize", handleDashboardTransform);
  dashboardWindow.on("minimize", () => {
    if (petDockState.mode === "dashboard-dock") {
      clearPetDockState(true);
    }
  });
  dashboardWindow.on("hide", () => {
    if (petDockState.mode === "dashboard-dock") {
      clearPetDockState(true);
    }
  });

  // 关闭主控面板时隐藏到后台，不打断桌宠陪伴
  dashboardWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      dashboardWindow.hide();
    }
  });

  dashboardWindow.on("closed", () => {
    if (petDockState.mode === "dashboard-dock") {
      clearPetDockState(true);
    }
    dashboardWindow = null;
  });

  return dashboardWindow;
}

/**
 * 向桌宠窗口发送指令事件（如切换表情、开关免打扰、弹出快捷输入、拨号通话）
 */
function sendToPet(channel, payload) {
  if (!petWindow || petWindow.isDestroyed()) return;
  if (petWindow.webContents.isLoading()) {
    petWindow.webContents.once("did-finish-load", () => {
      if (petWindow && !petWindow.isDestroyed()) {
        petWindow.webContents.send(channel, payload);
      }
    });
    return;
  }
  petWindow.webContents.send(channel, payload);
}

/**
 * 向主控面板窗口发送指令事件（如通话互斥控制、桌宠通话记录实时同步）
 */
function sendToDashboard(channel, payload) {
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    dashboardWindow.webContents.send(channel, payload);
  }
}

/**
 * 刷新系统托盘右键菜单
 */
function refreshTrayMenu() {
  if (!tray) return;

  const isPetVisible = Boolean(
    petWindow && !petWindow.isDestroyed() && petWindow.isVisible(),
  );
  const isPetCalling = activeVoiceCallOwner === "pet";

  const contextMenu = Menu.buildFromTemplate([
    {
      label: `召唤灵儿出场 (${summonShortcutLabel})`,
      click: () => summonPetToStage(),
    },
    {
      label: isPetCalling ? "挂断桌宠语音通话" : "跟灵儿打电话（桌宠）",
      click: () => {
        if (!petWindow || petWindow.isDestroyed()) {
          createPetWindow();
        } else if (!petWindow.isVisible()) {
          petWindow.show();
        }
        sendToPet("pet:toggle-voice-call");
        refreshTrayMenu();
      },
    },
    {
      label: "打开主控面板",
      click: () => openDashboardWindow(),
    },
    {
      label: isPetVisible ? "隐藏灵儿桌宠" : "显示灵儿桌宠",
      click: () => {
        if (!petWindow || petWindow.isDestroyed()) {
          createPetWindow();
        } else if (petWindow.isVisible()) {
          petWindow.hide();
        } else {
          petWindow.show();
        }
        refreshTrayMenu();
      },
    },
    {
      label: "归位到屏幕右下角",
      click: () => {
        if (!petWindow || petWindow.isDestroyed()) {
          createPetWindow();
        }
        clearPetDockState(true);
        const pos = getDefaultPetPosition(petWindowMode);
        const { width: targetW, height: targetH } =
          getPetDimensionsForMode(petWindowMode);
        applyPetWindowBounds(pos.x, pos.y, targetW, targetH);
        lockPetWindowZoom();
        petWindow.show();
        refreshTrayMenu();
      },
    },
    { type: "separator" },
    {
      label: "窗口始终置顶",
      type: "checkbox",
      checked: isAlwaysOnTop,
      click: (menuItem) => {
        isAlwaysOnTop = menuItem.checked;
        if (petWindow && !petWindow.isDestroyed()) {
          petWindow.setAlwaysOnTop(isAlwaysOnTop, "screen-saver");
        }
      },
    },
    {
      label: "免打扰模式（静音）",
      type: "checkbox",
      checked: isDndEnabled,
      click: (menuItem) => {
        isDndEnabled = menuItem.checked;
        sendToPet("pet:dnd-changed", isDndEnabled);
      },
    },
    { type: "separator" },
    {
      label: "退出灵儿",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
}

/**
 * 初始化系统托盘
 */
function setupTray() {
  const icon = createTrayIcon();
  tray = new Tray(icon);
  tray.setToolTip("灵儿 — 台湾腔治愈系小管家");
  refreshTrayMenu();

  // 左键单击托盘图标直接打开主控面板
  tray.on("click", () => {
    openDashboardWindow();
  });
}

/**
 * 注册前后端 IPC 通信通道
 */
function setupIpcHandlers() {
  // 1. 动态切换桌宠点击穿透状态（保留兼容接口）
  ipcMain.on("pet:set-ignore-mouse-events", (_event, ignore, options) => {
    if (petWindow && !petWindow.isDestroyed()) {
      petWindow.setIgnoreMouseEvents(Boolean(ignore), options || { forward: true });
    }
  });

  // 2. 平滑全局拖拽：记录起点并基于主进程实时光标坐标同步窗口位置
  ipcMain.on("pet:drag-start", () => {
    if (!petWindow || petWindow.isDestroyed()) return;
    stopPetDragLoop();
    clearPetDockState(true);
    petWindow.setIgnoreMouseEvents(false);
    const cursor = screen.getCursorScreenPoint();
    const bounds = petWindow.getBounds();
    petDragState = {
      startCursorX: cursor.x,
      startCursorY: cursor.y,
      startWinX: bounds.x,
      startWinY: bounds.y,
      width: bounds.width,
      height: bounds.height,
      lastX: bounds.x,
      lastY: bounds.y,
    };
  });

  ipcMain.on("pet:drag-move", () => {
    if (!petWindow || petWindow.isDestroyed() || !petDragState) return;
    applyPetDragPosition();
    if (!petDragTimer) {
      petDragTimer = setInterval(applyPetDragPosition, 12);
    }
  });

  ipcMain.on("pet:drag-end", () => {
    stopPetDragLoop();
    void detectAndApplyDockState();
  });

  // 2.2 靠边躲藏偷看状态下：鼠标悬浮探头平滑滑出，离开后延时重新缩回偷看
  ipcMain.on("pet:set-peek-revealed", (_event, revealed) => {
    if (
      !petWindow ||
      petWindow.isDestroyed() ||
      petDockState.mode !== "edge-peek" ||
      petWindowMode !== "compact"
    ) {
      return;
    }
    const wantReveal = Boolean(revealed);
    if (peekRetractTimer) {
      clearTimeout(peekRetractTimer);
      peekRetractTimer = null;
    }
    if (wantReveal) {
      if (!petDockState.revealed && petDockState.revealBounds) {
        petDockState.revealed = true;
        sendToPet("pet:dock-state-changed", { pose: "none", isPeeking: false });
        animatePetWindowTo(
          petDockState.revealBounds.x,
          petDockState.revealBounds.y,
          200,
        );
      }
    } else if (petDockState.revealed && petDockState.peekBounds) {
      peekRetractTimer = setTimeout(() => {
        peekRetractTimer = null;
        if (
          !petWindow ||
          petWindow.isDestroyed() ||
          petDockState.mode !== "edge-peek" ||
          petWindowMode !== "compact" ||
          petDragState
        ) {
          return;
        }
        petDockState.revealed = false;
        sendToPet("pet:dock-state-changed", {
          pose: petDockState.pose,
          isPeeking: true,
        });
        animatePetWindowTo(
          petDockState.peekBounds.x,
          petDockState.peekBounds.y,
          240,
        );
      }, 520);
    }
  });

  // 兼容旧版增量移动接口（统一锁定标准模式尺寸，避免 Windows DPI 缩放尺寸漂移）
  ipcMain.on("pet:move-window", (_event, deltaX, deltaY) => {
    if (petWindow && !petWindow.isDestroyed()) {
      const bounds = petWindow.getBounds();
      const { width: targetW, height: targetH } =
        getPetDimensionsForMode(petWindowMode);
      petWindow.setBounds({
        x: Math.round(bounds.x + Number(deltaX || 0)),
        y: Math.round(bounds.y + Number(deltaY || 0)),
        width: targetW,
        height: targetH,
      });
    }
  });

  // 2.5 桌宠窗口尺寸模式切换（compact / quick-chat / call，兼容旧版布尔值）
  ipcMain.on("pet:set-expanded", (_event, expanded) => {
    setPetWindowMode(Boolean(expanded) ? "quick-chat" : "compact");
  });

  ipcMain.on("pet:set-mode", (_event, mode) => {
    setPetWindowMode(mode);
  });

  // 2.6 双窗口实时语音通话互斥锁（避免主控面板与桌宠同时抢占麦克风与音频输出）
  ipcMain.on("voice-call:notify-owner", (event, owner) => {
    const normalized =
      owner === "pet" || owner === "dashboard" ? owner : "none";
    const senderIsPet = Boolean(
      petWindow && !petWindow.isDestroyed() && event.sender === petWindow.webContents,
    );
    const senderIsDashboard = Boolean(
      dashboardWindow &&
        !dashboardWindow.isDestroyed() &&
        event.sender === dashboardWindow.webContents,
    );

    if (normalized === "none") {
      // 仅允许当前持有通话权的窗口释放归属权，避免被强停的旧窗口回写覆盖新持有者
      if (
        (activeVoiceCallOwner === "pet" && senderIsPet) ||
        (activeVoiceCallOwner === "dashboard" && senderIsDashboard)
      ) {
        activeVoiceCallOwner = "none";
        refreshTrayMenu();
      }
      return;
    }

    if (normalized === "pet" && activeVoiceCallOwner === "dashboard") {
      sendToDashboard("voice-call:force-stop");
    } else if (normalized === "dashboard" && activeVoiceCallOwner === "pet") {
      sendToPet("voice-call:force-stop");
    }
    activeVoiceCallOwner = normalized;
    refreshTrayMenu();
  });

  // 2.7 桌宠实时通话每轮结束后同步对话到主控面板聊天流
  ipcMain.on("voice-call:sync-turn", (_event, payload) => {
    sendToDashboard("voice-call:turn-synced", payload);
  });

  // 3. 从桌宠或面板唤起主控面板
  ipcMain.on("app:open-dashboard", () => {
    openDashboardWindow();
  });

  // 4. 从面板唤起/隐藏桌宠
  ipcMain.on("pet:toggle-visibility", () => {
    if (!petWindow || petWindow.isDestroyed()) {
      createPetWindow();
    } else if (petWindow.isVisible()) {
      petWindow.hide();
    } else {
      petWindow.show();
    }
    refreshTrayMenu();
  });

  // 5. 从面板向桌宠转发表情状态同步指令
  ipcMain.on("pet:preview-state", (_event, payload) => {
    sendToPet("pet:preview-state", payload);
  });

  // 5.1 桌宠环绕菜单切换免打扰状态（同步系统托盘勾选）
  ipcMain.on("pet:set-dnd", (_event, enabled) => {
    isDndEnabled = Boolean(enabled);
    sendToPet("pet:dnd-changed", isDndEnabled);
    refreshTrayMenu();
  });

  // 5.2 桌宠环绕菜单一键退出应用
  ipcMain.on("app:quit", () => {
    isQuitting = true;
    app.quit();
  });

  // 5.5 Windows 开机自启状态读取与切换
  ipcMain.handle("app:get-autostart", () => {
    try {
      return Boolean(app.getLoginItemSettings().openAtLogin);
    } catch {
      return false;
    }
  });

  ipcMain.handle("app:set-autostart", (_event, enabled) => {
    try {
      if (!app.isPackaged) {
        return false;
      }
      app.setLoginItemSettings({ openAtLogin: Boolean(enabled) });
      return Boolean(app.getLoginItemSettings().openAtLogin);
    } catch {
      return false;
    }
  });

  // 6. 原右键原生功能面板已由桌宠环绕水晶道具菜单全面取代，此处保持空实现防止旧面板弹出
  ipcMain.on("pet:show-context-menu", () => {
    // intentionally disabled: replaced by PetRadialMenu
  });
}

// 单实例锁：重复打开程序时，直接同时唤起主控面板和桌宠，不重复创建进程
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    openDashboardWindow();
    createPetWindow();
    refreshTrayMenu();
  });

  // Electron 初始化完成：同时打开主控面板与透明桌宠浮窗，注册全局召唤快捷键，并驻留系统托盘
  app.whenReady().then(() => {
    setupIpcHandlers();
    openDashboardWindow();
    createPetWindow();
    registerSummonShortcut();
    setupTray();

    app.on("activate", () => {
      openDashboardWindow();
      if (!petWindow || petWindow.isDestroyed()) {
        createPetWindow();
      }
    });
  });
}

// 拦截退出前标记，确保彻底关闭
app.on("before-quit", () => {
  stopPetDragLoop();
  stopPetSlideAnim();
  stopExternalWindowTracker();
  isQuitting = true;
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

// 保持系统托盘常驻，仅在明确退出时结束进程
app.on("window-all-closed", () => {
  if (isQuitting && process.platform !== "darwin") {
    app.quit();
  }
});
