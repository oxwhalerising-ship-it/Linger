/**
 * Windows 透明桌宠浮窗主视图（PetWindow）
 * ---------------------------------------
 * 运行在 Electron 透明置顶窗口（?window=pet）中，负责：
 * 1. 基于主进程全局鼠标坐标的平滑任意拖拽（支持多屏与高 DPI，任意拖放到桌面各处）。
 * 2. 精准区分“拖拽移动 / 单击快捷互动 / 双击打开主控面板 / 右键菜单”，避免单击抢占双击事件。
 * 3. 免打扰状态同步、表情动效联动以及对接后端的台湾腔快捷语音回复。
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import AvatarRenderer from "./AvatarRenderer";
import PetCallBar, {
  type PetCallSubtitle,
  type PetCallVisualState,
} from "./PetCallBar";
import PetRadialMenu from "./PetRadialMenu";
import QuickVoiceBar from "./QuickVoiceBar";
import { api } from "../../services/api";
import { openAuthedWebSocket } from "../../services/api/client";
import {
  createSentencePlayer,
  playTaiwanSentences,
  sendQuickChat,
} from "../../services/petApi";
import {
  playPetSound,
  preloadPetSounds,
} from "../../services/petSoundEffects";
import {
  POKE_RESPONSES,
  type AvatarConfig,
  type PetDockPose,
  type PetEmotion,
} from "../../types/pet";

const DEFAULT_AVATAR_CONFIG: AvatarConfig = {
  provider: "builtin-sprite",
};

const DRAG_THRESHOLD_PX = 5;
const SINGLE_CLICK_DELAY_MS = 240;

export default function PetWindow() {
  const [emotion, setEmotion] = useState<PetEmotion>("idle");
  const [quickChatOpen, setQuickChatOpen] = useState(false);
  const [callOpen, setCallOpen] = useState(false);
  const [callVisual, setCallVisual] = useState<PetCallVisualState>({
    state: "ended",
    micVolume: 0,
    botVolume: 0,
    muted: false,
  });
  const [sending, setSending] = useState(false);
  const [dndEnabled, setDndEnabled] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isPatting, setIsPatting] = useState(false);
  const [patMood, setPatMood] = useState<"shy" | "happy">("shy");

  // 悬浮环绕水晶菜单 + 撒向天空施法动效 + 表情快选条
  const [radialMenuOpen, setRadialMenuOpen] = useState(false);
  const [isCastingMenu, setIsCastingMenu] = useState(false);
  const [emotionPickerOpen, setEmotionPickerOpen] = useState(false);
  // 边缘躲藏偷看 / 应用窗口边框倚靠与坐下姿态
  const [dockPose, setDockPose] = useState<PetDockPose>("none");
  const [isPeeking, setIsPeeking] = useState(false);
  // 鼠标视线与头部追踪归一化坐标（x,y ∈ [-1, 1]）
  const [lookTarget, setLookTarget] = useState<{ x: number; y: number } | null>(
    null,
  );
  // 实时通话模式：灵儿头顶浮动的双人对话字幕
  const [callSubtitle, setCallSubtitle] = useState<PetCallSubtitle>({
    text: "正在接通灵儿并预热语音...",
    role: "system",
  });
  // 追踪实际窗口视口尺寸，防止任何情况下（如高 DPI / 旧窗口未重启）灵儿与环绕按钮被裁切
  const [brainNote, setBrainNote] = useState<string | null>(null);
  const [viewport, setViewport] = useState(() => ({
    width: typeof window !== "undefined" ? window.innerWidth : 380,
    height: typeof window !== "undefined" ? window.innerHeight : 360,
  }));

  const radialCloseTimerRef = useRef<number | null>(null);
  const castAnimTimerRef = useRef<number | null>(null);
  const radialMenuOpenRef = useRef(false);
  // 标记当前一次「进入整个功能区与桌宠舞台」会话中是否尚未触发过灵儿悬浮音效
  const hoverSfxArmedRef = useRef(true);
  const stageRef = useRef<HTMLDivElement | null>(null);

  const dndRef = useRef(false);
  const callOpenRef = useRef(false);
  const isPointerDownRef = useRef(false);
  const activePointerIdRef = useRef<number | null>(null);
  const movedDuringDragRef = useRef(false);
  const suppressClickUntilRef = useRef(0);
  const lastDashboardOpenRef = useRef(0);
  const downScreenPosRef = useRef({ x: 0, y: 0 });
  const singleClickTimerRef = useRef<number | null>(null);
  const emotionResetTimerRef = useRef<number | null>(null);
  const audioAbortRef = useRef<AbortController | null>(null);

  // 摸头检测（在头顶上半区轻轻左右抚摸，不冲突左键拖拽）
  const lastPatXRef = useRef<number | null>(null);
  const patStrokeAccumRef = useRef(0);
  const patReleaseTimerRef = useRef<number | null>(null);
  const isPattingRef = useRef(false);

  // 长时间无操作自动过渡：待机 → 无聊（40s）→ 困倦（85s）
  const lastActivityMsRef = useRef(Date.now());
  const emotionRef = useRef<PetEmotion>("idle");

  useEffect(() => {
    emotionRef.current = emotion;
  }, [emotion]);

  useEffect(() => {
    isPattingRef.current = isPatting;
  }, [isPatting]);

  useEffect(() => {
    radialMenuOpenRef.current = radialMenuOpen;
  }, [radialMenuOpen]);

  /** 丝滑展开环绕水晶菜单，并同步触发灵儿「双手张开撒向天空」施法动效 */
  const openRadialMenu = useCallback(() => {
    if (callOpenRef.current || movedDuringDragRef.current) return;
    if (radialCloseTimerRef.current) {
      window.clearTimeout(radialCloseTimerRef.current);
      radialCloseTimerRef.current = null;
    }
    if (!radialMenuOpenRef.current) {
      setRadialMenuOpen(true);
      setIsCastingMenu(true);
      if (castAnimTimerRef.current) {
        window.clearTimeout(castAnimTimerRef.current);
      }
      castAnimTimerRef.current = window.setTimeout(() => {
        setIsCastingMenu(false);
        castAnimTimerRef.current = null;
      }, 420);
    }
  }, []);

  /** 延时收起环绕菜单（300ms 宽容期，在灵儿与四周按钮间移动绝不误收起） */
  const scheduleCloseRadialMenu = useCallback(() => {
    if (radialCloseTimerRef.current) {
      window.clearTimeout(radialCloseTimerRef.current);
    }
    radialCloseTimerRef.current = window.setTimeout(() => {
      radialCloseTimerRef.current = null;
      setRadialMenuOpen(false);
      setEmotionPickerOpen(false);
    }, 300);
  }, []);

  const cancelCloseRadialMenu = useCallback(() => {
    if (radialCloseTimerRef.current) {
      window.clearTimeout(radialCloseTimerRef.current);
      radialCloseTimerRef.current = null;
    }
  }, []);

  /** 鼠标在桌宠舞台内移动时实时计算相对中心方向，驱动灵儿眼睛与头部丝滑追踪 */
  const handleStagePointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const el = stageRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const nx = Math.max(-1, Math.min(1, (e.clientX - cx) / (rect.width * 0.48)));
      const ny = Math.max(-1, Math.min(1, (e.clientY - cy) / (rect.height * 0.48)));
      setLookTarget({ x: nx, y: ny });
    },
    [],
  );

  const handleStagePointerLeave = useCallback(() => {
    setLookTarget(null);
    hoverSfxArmedRef.current = true;
    scheduleCloseRadialMenu();
    window.taiwanBotEnv?.setPetPeekRevealed?.(false);
  }, [scheduleCloseRadialMenu]);

  const markActivity = useCallback(() => {
    lastActivityMsRef.current = Date.now();
    if (emotionRef.current === "bored" || emotionRef.current === "sleepy") {
      setEmotion("idle");
    }
  }, []);

  useEffect(() => {
    dndRef.current = dndEnabled;
  }, [dndEnabled]);

  useEffect(() => {
    callOpenRef.current = callOpen;
  }, [callOpen]);

  // 开启 html.pet-mode 透明根样式，预加载交互音效，并清空窗口文档标题防止系统标题栏显示文字
  useEffect(() => {
    document.title = "";
    document.documentElement.classList.add("pet-mode");
    preloadPetSounds();
    return () => {
      document.documentElement.classList.remove("pet-mode");
    };
  }, []);

  // 监听窗口尺寸变化，用于自适应防裁切兜底
  useEffect(() => {
    const updateViewport = () => {
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    };
    updateViewport();
    window.addEventListener("resize", updateViewport);
    return () => window.removeEventListener("resize", updateViewport);
  }, []);

  // 根据快捷输入框 / 实时语音通话状态同步桌宠窗口尺寸模式
  useEffect(() => {
    const mode = callOpen ? "call" : quickChatOpen ? "quick-chat" : "compact";
    if (window.taiwanBotEnv?.setPetMode) {
      window.taiwanBotEnv.setPetMode(mode);
    } else {
      window.taiwanBotEnv?.setPetExpanded(mode !== "compact");
    }
  }, [callOpen, quickChatOpen]);

  /** 切换表情并可选在一段时间后回到待机态 */
  const triggerEmotion = useCallback(
    (nextEmotion: PetEmotion, resetAfterMs = 5000) => {
      setEmotion(nextEmotion);
      if (emotionResetTimerRef.current) {
        window.clearTimeout(emotionResetTimerRef.current);
      }
      if (resetAfterMs > 0 && nextEmotion !== "idle") {
        emotionResetTimerRef.current = window.setTimeout(() => {
          setEmotion("idle");
        }, resetAfterMs);
      }
    },
    [],
  );

  /** 在桌宠窗口直接发起实时语音通话（自动暂停普通播报并通知主进程互斥主控面板通话） */
  const startPetCall = useCallback(() => {
    audioAbortRef.current?.abort();
    setQuickChatOpen(false);
    setRadialMenuOpen(false);
    setEmotionPickerOpen(false);
    setCallSubtitle({ text: "正在接通灵儿并预热语音...", role: "system" });
    setCallOpen(true);
    triggerEmotion("listening", 0);
    window.taiwanBotEnv?.notifyVoiceCallOwner?.("pet");
  }, [triggerEmotion]);

  const startPetCallRef = useRef(startPetCall);
  useEffect(() => {
    startPetCallRef.current = startPetCall;
  }, [startPetCall]);

  /** 结束桌宠实时语音通话（播放 Stack 挂断音效） */
  const stopPetCall = useCallback(() => {
    playPetSound("stack");
    setCallOpen(false);
    setCallVisual({
      state: "ended",
      micVolume: 0,
      botVolume: 0,
      muted: false,
    });
    triggerEmotion("idle", 0);
    window.taiwanBotEnv?.notifyVoiceCallOwner?.("none");
  }, [triggerEmotion]);

  /** 安全结束拖拽并复位状态 */
  const finishDrag = useCallback((target?: HTMLElement | null) => {
    const pointerId = activePointerIdRef.current;
    if (target && pointerId !== null) {
      try {
        if (target.hasPointerCapture(pointerId)) {
          target.releasePointerCapture(pointerId);
        }
      } catch {
        // ignore capture release errors
      }
    }
    activePointerIdRef.current = null;

    if (isPointerDownRef.current || movedDuringDragRef.current) {
      window.taiwanBotEnv?.endPetDrag();
    }
    isPointerDownRef.current = false;
    setIsDragging(false);

    const wasDragged = movedDuringDragRef.current;
    if (wasDragged) {
      suppressClickUntilRef.current = Date.now() + 260;
      movedDuringDragRef.current = false;
      // 放下 → 松一口气（安心），约 2.2 秒后自然回到待机
      if (!callOpenRef.current) {
        triggerEmotion("relieved", 2200);
      }
    }
  }, [triggerEmotion]);

  // 全局兜底监听：窗口失焦或外部抬起鼠标时立刻结束拖拽，避免粘滞
  useEffect(() => {
    const handleGlobalEnd = () => {
      if (isPointerDownRef.current) {
        finishDrag();
      }
    };
    window.addEventListener("pointerup", handleGlobalEnd);
    window.addEventListener("blur", handleGlobalEnd);
    return () => {
      window.removeEventListener("pointerup", handleGlobalEnd);
      window.removeEventListener("blur", handleGlobalEnd);
    };
  }, [finishDrag]);

  // 首次启动时同步后端免打扰初始状态，并清理计时器与音频
  useEffect(() => {
    void api
      .getScheduleStatus()
      .then((st) => setDndEnabled(Boolean(st.dnd_enabled)))
      .catch(() => {});

    // 长时间无操作自动进入「无聊 → 困倦」状态机
    const idleCheckTimer = window.setInterval(() => {
      if (callOpenRef.current || isPointerDownRef.current || isPattingRef.current) {
        return;
      }
      const idleSec = (Date.now() - lastActivityMsRef.current) / 1000;
      if (idleSec >= 85 && emotionRef.current !== "sleepy") {
        setEmotion("sleepy");
      } else if (
        idleSec >= 40 &&
        idleSec < 85 &&
        emotionRef.current === "idle"
      ) {
        setEmotion("bored");
      }
    }, 3000);

    return () => {
      window.clearInterval(idleCheckTimer);
      if (singleClickTimerRef.current) {
        window.clearTimeout(singleClickTimerRef.current);
      }
      if (emotionResetTimerRef.current) {
        window.clearTimeout(emotionResetTimerRef.current);
      }
      if (patReleaseTimerRef.current) {
        window.clearTimeout(patReleaseTimerRef.current);
      }
      if (radialCloseTimerRef.current) {
        window.clearTimeout(radialCloseTimerRef.current);
      }
      if (castAnimTimerRef.current) {
        window.clearTimeout(castAnimTimerRef.current);
      }
      window.taiwanBotEnv?.endPetDrag();
      audioAbortRef.current?.abort();
    };
  }, []);

  // 订阅后端 WebSocket `/ws/events`：接收全天作息提醒、唤醒词与主动语音陪伴
  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      void (async () => {
        try {
          const socket = await openAuthedWebSocket("/ws/events");
          if (disposed) {
            socket.close();
            return;
          }
          ws = socket;
          ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data as string) as {
              type?: string;
              emotion?: PetEmotion;
              sentences?: string[];
              enabled?: boolean;
            };

            if (msg.type === "dnd_changed") {
              setDndEnabled(Boolean(msg.enabled));
              return;
            }

            if (msg.type === "wakeword_detected") {
              // 若桌宠已经在通话中，忽略唤醒事件避免冲突
              if (callOpenRef.current) return;
              // 与桌宠打电话保持完全统一的 UI 与全双工实时通话功能（含空格手动发送/打断、字幕、静音、插话等）
              playPetSound("dispatch", { muted: dndRef.current });
              startPetCallRef.current();
              return;
            }

            if (msg.type === "proactive_nudge") {
              // 正在实时通话时不打断当前通话音频
              if (callOpenRef.current) return;
              const targetEmotion = msg.emotion || "happy";

              if (!dndRef.current && msg.sentences?.length) {
                audioAbortRef.current?.abort();
                const controller = new AbortController();
                audioAbortRef.current = controller;
                void playTaiwanSentences(msg.sentences, {
                  muted: dndRef.current,
                  signal: controller.signal,
                  onStartSpeaking: () => triggerEmotion("speaking", 0),
                  onFinishSpeaking: () => triggerEmotion(targetEmotion, 6000),
                });
              } else {
                triggerEmotion(targetEmotion, 7000);
              }
            }
          } catch {
            // 忽略无法解析的推送消息
          }
        };

          ws.onclose = () => {
            if (!disposed) {
              reconnectTimer = window.setTimeout(connect, 5000);
            }
          };
        } catch {
          if (!disposed) {
            reconnectTimer = window.setTimeout(connect, 5000);
          }
        }
      })();
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, [triggerEmotion]);

  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      try {
        await api.getHealth();
        const models = await api.getModelStatus();
        if (stopped) return;
        if (models.downloading) setBrainNote("正在下载本地语音模型…");
        else if (models.error) setBrainNote("语音模型下载失败");
        else if (models.missing.length > 0) setBrainNote("本地语音模型还没准备好");
        else setBrainNote(null);
      } catch {
        if (!stopped) setBrainNote("大脑还没连上");
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 4000);
    const off = window.taiwanBotEnv?.onBackendStatus?.((status) => {
      if (status.state === "ready") return;
      setBrainNote(status.detail);
    });
    return () => {
      stopped = true;
      window.clearInterval(timer);
      off?.();
    };
  }, []);

  // 订阅 Electron 主进程推送的菜单/表情同步/免打扰事件
  useEffect(() => {
    const env = window.taiwanBotEnv;
    if (!env) return;

    const unsubPreview = env.onPetPreviewState((payload) => {
      if (payload.emotion) {
        triggerEmotion(payload.emotion, 7000);
      }
    });

    const unsubDnd = env.onPetDndChanged((enabled) => {
      setDndEnabled(enabled);
      void api.toggleDnd(enabled).catch(() => {});
      if (enabled) {
        audioAbortRef.current?.abort();
      }
    });

    const unsubQuickChat = env.onOpenQuickChat(() => {
      if (callOpenRef.current) return;
      setQuickChatOpen(true);
      triggerEmotion("listening", 0);
    });

    const unsubToggleCall = env.onTogglePetVoiceCall?.(() => {
      if (callOpenRef.current) {
        stopPetCall();
      } else {
        startPetCall();
      }
    });

    const unsubForceStop = env.onForceStopVoiceCall?.(() => {
      if (callOpenRef.current) {
        stopPetCall();
      }
    });

    const unsubDockState = env.onPetDockStateChanged?.((payload) => {
      setDockPose(payload.pose || "none");
      setIsPeeking(Boolean(payload.isPeeking));
      if (payload.isPeeking) {
        setRadialMenuOpen(false);
        setEmotionPickerOpen(false);
      }
    });

    const unsubSummoned = env.onPetSummoned?.(() => {
      markActivity();
      setDockPose("none");
      setIsPeeking(false);
      playPetSound("dispatch", { muted: dndRef.current });
      triggerEmotion("happy", 3600);
    });

    return () => {
      unsubPreview();
      unsubDnd();
      unsubQuickChat();
      unsubToggleCall?.();
      unsubForceStop?.();
      unsubDockState?.();
      unsubSummoned?.();
    };
  }, [markActivity, startPetCall, stopPetCall, triggerEmotion]);

  /** 统一打开主控面板（内置防抖，避免 click(detail=2) 与 dblclick 重复触发） */
  const triggerOpenDashboard = useCallback(() => {
    if (singleClickTimerRef.current) {
      window.clearTimeout(singleClickTimerRef.current);
      singleClickTimerRef.current = null;
    }
    const now = Date.now();
    if (now - lastDashboardOpenRef.current < 350) return;
    lastDashboardOpenRef.current = now;
    triggerEmotion("happy", 2500);
    window.taiwanBotEnv?.openDashboard();
  }, [triggerEmotion]);

  /** 结束摸头（进入回落阶段） */
  const stopHeadPat = useCallback(() => {
    if (patReleaseTimerRef.current) {
      window.clearTimeout(patReleaseTimerRef.current);
      patReleaseTimerRef.current = null;
    }
    lastPatXRef.current = null;
    patStrokeAccumRef.current = 0;
    if (isPattingRef.current) {
      setIsPatting(false);
    }
  }, []);

  /** 按下灵儿：捕获指针并通知主进程记录拖拽起点 */
  const handleAvatarPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    markActivity();
    stopHeadPat();
    if (e.button !== 0) return;
    isPointerDownRef.current = true;
    activePointerIdRef.current = e.pointerId;
    movedDuringDragRef.current = false;
    downScreenPosRef.current = { x: e.screenX, y: e.screenY };

    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore capture errors
    }
    window.taiwanBotEnv?.startPetDrag();
  };

  /** 指针移动：按下左键时驱动拖拽（拖起受惊）；未按下时在头顶区域轻抚触发摸头三段式交互 */
  const handleAvatarPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    markActivity();

    // 1. 左键按住拖拽逻辑
    if (isPointerDownRef.current) {
      if ((e.buttons & 1) === 0) {
        finishDrag(e.currentTarget);
        return;
      }

      const dist = Math.hypot(
        e.screenX - downScreenPosRef.current.x,
        e.screenY - downScreenPosRef.current.y,
      );

      if (!movedDuringDragRef.current && dist >= DRAG_THRESHOLD_PX) {
        movedDuringDragRef.current = true;
        setIsDragging(true);
        setRadialMenuOpen(false);
        setEmotionPickerOpen(false);
        if (singleClickTimerRef.current) {
          window.clearTimeout(singleClickTimerRef.current);
          singleClickTimerRef.current = null;
        }
      }

      if (movedDuringDragRef.current) {
        window.taiwanBotEnv?.updatePetDrag();
      }
      return;
    }

    // 2. 未按键时：在灵儿头顶上半区（前 48% 高度）轻轻左右抚摸触发「摸头」
    if (callOpenRef.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const relY = (e.clientY - rect.top) / Math.max(1, rect.height);
    if (relY > 0.5) {
      lastPatXRef.current = null;
      return;
    }

    if (lastPatXRef.current !== null) {
      const dx = Math.abs(e.clientX - lastPatXRef.current);
      if (dx >= 1.5 && dx <= 45) {
        patStrokeAccumRef.current += dx;
        if (!isPattingRef.current && patStrokeAccumRef.current >= 22) {
          // 交替触发害羞 / 开心摸头反应
          setPatMood((prev) => (prev === "shy" ? "happy" : "shy"));
          setIsPatting(true);
        }
        if (isPattingRef.current || patStrokeAccumRef.current >= 22) {
          if (patReleaseTimerRef.current) {
            window.clearTimeout(patReleaseTimerRef.current);
          }
          // 停止抚摸 420ms 后进入约 0.8s 的回落（视线先回 → 头再摆正 → 水晶坠最后停下）
          patReleaseTimerRef.current = window.setTimeout(() => {
            stopHeadPat();
          }, 420);
        }
      }
    }
    lastPatXRef.current = e.clientX;
  };

  /** 抬起指针或失去捕获：立即结束拖拽 */
  const handleAvatarPointerEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    finishDrag(e.currentTarget);
  };

  /** 单击轻戳小精灵（延迟判定，避免干扰双击打开主控面板） */
  const handleAvatarClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (Date.now() < suppressClickUntilRef.current || movedDuringDragRef.current) {
      return;
    }

    if (e.detail >= 2) {
      triggerOpenDashboard();
      return;
    }

    if (singleClickTimerRef.current) {
      window.clearTimeout(singleClickTimerRef.current);
    }
    singleClickTimerRef.current = window.setTimeout(() => {
      singleClickTimerRef.current = null;
      // 正在通话时轻点头像不误收起通话卡
      if (callOpenRef.current) return;
      const randomItem =
        POKE_RESPONSES[Math.floor(Math.random() * POKE_RESPONSES.length)];
      triggerEmotion(randomItem.emotion, 4500);
      // 不再自动弹出旧快捷面板，文本交流统一由环绕水晶道具「文本交流」触发
    }, SINGLE_CLICK_DELAY_MS);
  };

  /** 双击小精灵：直接打开主控面板 */
  const handleAvatarDoubleClick = () => {
    if (Date.now() < suppressClickUntilRef.current) return;
    triggerOpenDashboard();
  };

  /** 右键灵儿：彻底禁用旧原生右键功能面板，改为直接展开/切换新环绕水晶菜单 */
  const handleAvatarContextMenu = (e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!callOpenRef.current) {
      openRadialMenu();
    }
  };

  /** 快捷输入框发送消息 -> 对接台湾腔大脑与流式语音播报 */
  const handleQuickSend = async (text: string) => {
    audioAbortRef.current?.abort();
    const controller = new AbortController();
    audioAbortRef.current = controller;

    setSending(true);
    triggerEmotion("thinking", 0);

    let emotion: PetEmotion = "happy";
    const isDnd = dndRef.current;
    const player = isDnd
      ? null
      : createSentencePlayer({
          muted: isDnd,
          signal: controller.signal,
          onStartSpeaking: () => triggerEmotion("speaking", 0),
          onFinishSpeaking: () => triggerEmotion(emotion, 5000),
        });
    try {
      const res = await sendQuickChat(text, "normal", "manual", {
        signal: controller.signal,
        onSentence: (sentence) => player?.push(sentence),
        onReply: (reply) => {
          emotion = reply.emotion || "happy";
          setSending(false);
        },
      });
      emotion = res.emotion || emotion;
      setSending(false);
      if (!player) triggerEmotion(emotion, 5500);
      await player?.close();
    } catch {
      triggerEmotion("encouraging", 5000);
    } finally {
      setSending(false);
      await player?.close();
    }
  };

  // 灵儿专属蓝白水晶星辉背景光效（随通话状态与音量动态流转）
  const callHaloStyle = (() => {
    if (!callOpen) return null;
    if (callVisual.muted) {
      return {
        core: "rgba(148, 163, 184, 0.24)",
        mid: "rgba(203, 213, 225, 0.14)",
        ringBorder: "rgba(148, 163, 184, 0.38)",
        waveColor: "rgba(148, 163, 184, 0.3)",
        scale: 1,
        pulse: false,
        spin: false,
      };
    }
    if (callVisual.state === "user_speaking") {
      return {
        core: "rgba(37, 99, 235, 0.38)",
        mid: "rgba(96, 165, 250, 0.24)",
        ringBorder: "rgba(59, 130, 246, 0.55)",
        waveColor: "rgba(59, 130, 246, 0.45)",
        scale: 1 + callVisual.micVolume * 0.2,
        pulse: true,
        spin: true,
      };
    }
    if (callVisual.state === "speaking") {
      return {
        core: "rgba(56, 189, 248, 0.42)",
        mid: "rgba(129, 140, 248, 0.24)",
        ringBorder: "rgba(56, 189, 248, 0.68)",
        waveColor: "rgba(96, 165, 250, 0.52)",
        scale: 1.03 + callVisual.botVolume * 0.24,
        pulse: true,
        spin: true,
      };
    }
    if (callVisual.state === "thinking" || callVisual.state === "transcribing") {
      return {
        core: "rgba(99, 102, 241, 0.32)",
        mid: "rgba(56, 189, 248, 0.2)",
        ringBorder: "rgba(129, 140, 248, 0.55)",
        waveColor: "rgba(129, 140, 248, 0.36)",
        scale: 1.05,
        pulse: false,
        spin: true,
      };
    }
    return {
      core: "rgba(56, 189, 248, 0.28)",
      mid: "rgba(186, 230, 253, 0.2)",
      ringBorder: "rgba(96, 165, 250, 0.48)",
      waveColor: "rgba(56, 189, 248, 0.35)",
      scale: 1 + callVisual.micVolume * 0.1,
      pulse: true,
      spin: true,
    };
  })();

  // 根据当前模式所需舞台尺寸计算零裁切缩放比例（正常 380×360+ 窗口下恒为 1，绝不影响清晰度）
  const requiredStageWidth = callOpen ? 320 : 356;
  const requiredStageHeight = callOpen ? 440 : quickChatOpen ? 408 : 336;
  const fitScale = Math.min(
    1,
    Math.max(
      0.45,
      Math.min(
        viewport.width / requiredStageWidth,
        viewport.height / requiredStageHeight,
      ),
    ),
  );

  return (
    <div
      ref={stageRef}
      onPointerMove={handleStagePointerMove}
      onPointerLeave={handleStagePointerLeave}
      className="relative w-screen h-screen flex flex-col items-center justify-center bg-transparent overflow-hidden select-none"
    >
      {brainNote && (
        <div className="absolute top-2 left-1/2 z-20 -translate-x-1/2 max-w-[240px] truncate rounded-full bg-white/92 px-2.5 py-1 text-[11px] text-slate-700 shadow pointer-events-none">
          {brainNote}
        </div>
      )}
      <div
        className="flex flex-col items-center justify-start pt-1.5 px-1.5 gap-1.5 shrink-0"
        style={
          fitScale < 0.995
            ? {
                transform: `scale(${fitScale.toFixed(4)})`,
                transformOrigin: "center center",
              }
            : undefined
        }
      >
      {/* === 实时通话模式：灵儿头顶浮动的实时双人对话字幕气泡（零遮挡、磨砂水晶质感） === */}
      {callOpen && (
        <div className="w-[302px] min-h-[62px] flex items-end justify-center px-1 pt-0.5">
          <div className="relative w-full rounded-2xl px-3.5 py-2 bg-white/92 backdrop-blur-md border border-sky-200/90 shadow-[0_8px_22px_rgba(37,99,235,0.18)] animate-bubble-pop">
            <div className="flex items-start gap-2">
              <span
                className={`shrink-0 mt-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-semibold ${
                  callSubtitle.role === "user"
                    ? "bg-blue-500/15 text-blue-700"
                    : callSubtitle.role === "assistant"
                      ? "bg-sky-500/18 text-sky-700"
                      : "bg-slate-200/80 text-slate-600"
                }`}
              >
                {callSubtitle.role === "user"
                  ? "你"
                  : callSubtitle.role === "assistant"
                    ? "灵儿"
                    : "通话"}
              </span>
              <p className="text-[12px] leading-[1.45] font-medium text-slate-800 line-clamp-2 break-words">
                {callSubtitle.text}
              </p>
            </div>
            {/* 气泡小尖角，优雅指向灵儿头顶 */}
            <div className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 w-3 h-3 rotate-45 bg-white/92 border-r border-b border-sky-200/90" />
          </div>
        </div>
      )}

      {/* === 灵儿与 7 枚水晶道具环绕舞台（344×324 充裕舞台，确保身体/云朵枕头/环绕按钮 100% 完整无裁切） === */}
      <div
        className={`relative flex items-center justify-center shrink-0 overflow-visible ${
          callOpen ? "w-[260px] h-[184px]" : "w-[344px] h-[320px]"
        }`}
      >
        {/* 鼠标悬浮灵儿时：双手张开撒向天空，5 枚水晶道具按钮沿正圆环绕四周 */}
        {!callOpen && (
          <PetRadialMenu
            open={radialMenuOpen && !isDragging && !isPeeking}
            callOpen={callOpen}
            dndEnabled={dndEnabled}
            emotionPickerOpen={emotionPickerOpen}
            currentEmotion={emotion}
            onToggleCall={startPetCall}
            onToggleEmotionPicker={() => {
              setEmotionPickerOpen((prev) => !prev);
            }}
            onSelectEmotion={(emo) => {
              markActivity();
              // 选云朵睡觉或待机时保持住，其他情绪展示 8 秒后回到待机
              triggerEmotion(emo, emo === "sleepy" || emo === "idle" ? 0 : 8000);
            }}
            onToggleDnd={() => {
              const next = !dndEnabled;
              setDndEnabled(next);
              window.taiwanBotEnv?.setPetDnd?.(next);
              void api.toggleDnd(next).catch(() => {});
              if (next) {
                audioAbortRef.current?.abort();
              }
            }}
            onHideToTray={() => {
              setRadialMenuOpen(false);
              window.taiwanBotEnv?.togglePetVisibility();
            }}
            onQuitApp={() => {
              window.taiwanBotEnv?.quitApp?.();
            }}
            onHoverChange={(hovering) => {
              if (hovering) {
                cancelCloseRadialMenu();
                window.taiwanBotEnv?.setPetPeekRevealed?.(true);
              }
            }}
          />
        )}

        {/* 灵儿本体可交互区域（悬浮展开环绕道具、鼠标视线+头部追踪、头顶轻抚摸头、拖拽受惊、双击开面板） */}
        <div
          role="button"
          tabIndex={0}
          title={
            callOpen
              ? "实时通话中｜按住左键可拖动位置｜双击打开主控面板"
              : "悬浮展开环绕功能｜轻抚头顶摸头｜按住左键拖动｜双击打开主控面板｜快捷键 Alt+Shift+L 召唤"
          }
          onDragStart={(e) => e.preventDefault()}
          onPointerEnter={() => {
            cancelCloseRadialMenu();
            window.taiwanBotEnv?.setPetPeekRevealed?.(true);
            if (
              hoverSfxArmedRef.current &&
              !callOpenRef.current &&
              !movedDuringDragRef.current
            ) {
              hoverSfxArmedRef.current = false;
              playPetSound("dispatch", { muted: dndRef.current });
            }
            openRadialMenu();
          }}
          onPointerDown={handleAvatarPointerDown}
          onPointerMove={handleAvatarPointerMove}
          onPointerUp={handleAvatarPointerEnd}
          onPointerCancel={handleAvatarPointerEnd}
          onPointerLeave={stopHeadPat}
          onLostPointerCapture={handleAvatarPointerEnd}
          onClick={handleAvatarClick}
          onDoubleClick={handleAvatarDoubleClick}
          onContextMenu={handleAvatarContextMenu}
          className={`relative z-10 touch-none select-none focus:outline-none transition-transform duration-100 ${
            isDragging ? "cursor-grabbing scale-[1.03]" : "cursor-grab"
          }`}
        >
          {/* 实时通话态专属灵儿蓝白水晶星辉背景光效（多层呼吸光晕 + 旋转晶环 + 声波扩散） */}
          {callHaloStyle && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              {/* 外层柔和冰蓝星雾光晕（随音量缩放） */}
              <div
                className="absolute inset-0 rounded-full transition-transform duration-100 ease-out"
                style={{
                  background: `radial-gradient(circle, ${callHaloStyle.core} 0%, ${callHaloStyle.mid} 48%, transparent 74%)`,
                  transform: `scale(${callHaloStyle.scale.toFixed(3)})`,
                }}
              />
              {/* 旋转冰晶星辉细环 */}
              {callHaloStyle.spin && (
                <div
                  className="absolute w-[142px] h-[142px] rounded-full border border-dashed animate-pet-crystal-spin"
                  style={{
                    borderColor: callHaloStyle.ringBorder,
                    boxShadow: `0 0 18px ${callHaloStyle.mid} inset`,
                  }}
                />
              )}
              {/* 反向微光内环 */}
              {callHaloStyle.spin && (
                <div
                  className="absolute w-[118px] h-[118px] rounded-full border animate-pet-crystal-spin-reverse"
                  style={{
                    borderColor: "rgba(224, 242, 254, 0.72)",
                    borderTopColor: callHaloStyle.ringBorder,
                  }}
                />
              )}
              {/* 说话/倾听态水波纹声波扩散 */}
              {callHaloStyle.pulse && (
                <>
                  <span
                    className="absolute w-[124px] h-[124px] rounded-full border-2 animate-pet-pulse-ring"
                    style={{ borderColor: callHaloStyle.waveColor }}
                  />
                  <span
                    className="absolute w-[112px] h-[112px] rounded-full border animate-pet-pulse-ring"
                    style={{
                      borderColor: "rgba(186, 230, 253, 0.65)",
                      animationDelay: "0.7s",
                    }}
                  />
                </>
              )}
            </div>
          )}
          <AvatarRenderer
            emotion={emotion}
            config={DEFAULT_AVATAR_CONFIG}
            size={154}
            dndEnabled={dndEnabled && !callOpen}
            isPatting={isPatting}
            patMood={patMood}
            isDragging={isDragging}
            isCastingMenu={isCastingMenu}
            dockPose={dockPose}
            lookTarget={lookTarget}
          />
        </div>
      </div>

      {/* 桌宠实时语音通话浮动控制卡 */}
      {callOpen && (
        <PetCallBar
          onEmotionChange={(next) => triggerEmotion(next, 0)}
          onVisualChange={setCallVisual}
          onSubtitleChange={setCallSubtitle}
          onHangUp={stopPetCall}
        />
      )}

      {/* 底部快捷聊天浮条（点击环绕「文本交流」或单击按需展开） */}
      {!callOpen && quickChatOpen && (
        <QuickVoiceBar
          visible={quickChatOpen}
          sending={sending}
          onSend={(text) => void handleQuickSend(text)}
          onStartCall={startPetCall}
          onOpenDashboard={() => window.taiwanBotEnv?.openDashboard()}
          onClose={() => {
            setQuickChatOpen(false);
            triggerEmotion("idle", 0);
          }}
        />
      )}
      </div>
    </div>
  );
}
