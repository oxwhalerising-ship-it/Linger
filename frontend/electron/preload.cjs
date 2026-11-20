/**
 * Electron Preload 预加载脚本（Step 4 桌宠与主控面板 IPC 桥接）
 * -----------------------------------------------------------
 * 通过 contextBridge 向渲染进程安全暴露最小权限的桌面 API，
 * 严禁直接把 ipcRenderer 或 Node.js 模块完整暴露给前端页面。
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("taiwanBotEnv", {
  platform: process.platform,
  backendBaseUrl: "http://127.0.0.1:8765",

  // 桌宠透明区域点击穿透开关
  setIgnoreMouseEvents: (ignore, options) => {
    ipcRenderer.send("pet:set-ignore-mouse-events", ignore, options);
  },

  // 桌宠平滑拖拽移动（主进程基于全局鼠标坐标追踪）
  startPetDrag: () => {
    ipcRenderer.send("pet:drag-start");
  },
  updatePetDrag: () => {
    ipcRenderer.send("pet:drag-move");
  },
  endPetDrag: () => {
    ipcRenderer.send("pet:drag-end");
  },
  setPetExpanded: (expanded) => {
    ipcRenderer.send("pet:set-expanded", Boolean(expanded));
  },
  setPetMode: (mode) => {
    ipcRenderer.send("pet:set-mode", mode);
  },
  setPetPeekRevealed: (revealed) => {
    ipcRenderer.send("pet:set-peek-revealed", Boolean(revealed));
  },

  // 双窗口实时语音通话互斥与记录同步
  notifyVoiceCallOwner: (owner) => {
    ipcRenderer.send("voice-call:notify-owner", owner);
  },
  syncVoiceCallTurn: (payload) => {
    ipcRenderer.send("voice-call:sync-turn", payload);
  },

  // 兼容旧版增量拖拽接口
  movePetWindow: (deltaX, deltaY) => {
    ipcRenderer.send("pet:move-window", deltaX, deltaY);
  },

  // 弹出桌宠原生右键菜单
  showPetContextMenu: () => {
    ipcRenderer.send("pet:show-context-menu");
  },

  // 打开主控面板窗口
  openDashboard: () => {
    ipcRenderer.send("app:open-dashboard");
  },

  // 显示 / 隐藏桌宠浮窗
  togglePetVisibility: () => {
    ipcRenderer.send("pet:toggle-visibility");
  },

  // 切换免打扰模式并同步托盘
  setPetDnd: (enabled) => {
    ipcRenderer.send("pet:set-dnd", Boolean(enabled));
  },

  // 退出整个应用
  quitApp: () => {
    ipcRenderer.send("app:quit");
  },

  // 向桌宠发送表情/气泡预览指令
  sendPetPreviewState: (payload) => {
    ipcRenderer.send("pet:preview-state", payload);
  },

  // 读取/设置 Windows 开机自启（Step 7）
  getAutoStart: () => ipcRenderer.invoke("app:get-autostart"),
  setAutoStart: (enabled) => ipcRenderer.invoke("app:set-autostart", Boolean(enabled)),

  // 监听主进程推送给桌宠的事件（返回取消订阅函数，防止内存泄漏）
  onPetPreviewState: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("pet:preview-state", listener);
    return () => ipcRenderer.removeListener("pet:preview-state", listener);
  },

  onPetDndChanged: (callback) => {
    const listener = (_event, enabled) => callback(Boolean(enabled));
    ipcRenderer.on("pet:dnd-changed", listener);
    return () => ipcRenderer.removeListener("pet:dnd-changed", listener);
  },

  onOpenQuickChat: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("pet:open-quick-chat", listener);
    return () => ipcRenderer.removeListener("pet:open-quick-chat", listener);
  },

  onTogglePetVoiceCall: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("pet:toggle-voice-call", listener);
    return () => ipcRenderer.removeListener("pet:toggle-voice-call", listener);
  },

  onForceStopVoiceCall: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("voice-call:force-stop", listener);
    return () => ipcRenderer.removeListener("voice-call:force-stop", listener);
  },

  onVoiceCallTurnSynced: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("voice-call:turn-synced", listener);
    return () => ipcRenderer.removeListener("voice-call:turn-synced", listener);
  },

  onPetDockStateChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("pet:dock-state-changed", listener);
    return () => ipcRenderer.removeListener("pet:dock-state-changed", listener);
  },

  onPetSummoned: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("pet:summoned", listener);
    return () => ipcRenderer.removeListener("pet:summoned", listener);
  },
});
