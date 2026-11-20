/**
 * 桌宠专属浮动实时语音通话控制卡（PetCallBar）
 * ---------------------------------------------
 * 悬浮在透明桌面小精灵正下方（w-[288px]），复用了与主控面板完全一致的
 * 全双工低延迟 VoiceCallEngine（常驻麦克风 + 自适应 VAD + 防回声随时插话 + 流式无缝播放）：
 * - 实时驱动上方桌宠表情与动态声波光环
 * - 展示通话时长、当前状态、首音延迟与 2 行紧凑实时字幕
 * - 提供静音 / 打断或立刻发送 / 自动插话防回声 / 挂断 4 枚快捷按钮
 * - 每轮结束自动通过 Electron IPC 实时同步回主控面板聊天记录
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../services/api";
import { playPetSound } from "../../services/petSoundEffects";
import {
  VoiceCallEngine,
  type VoiceCallLatency,
  type VoiceCallState,
} from "../../services/voiceCallEngine";
import type { PetEmotion } from "../../types/pet";
import {
  IconHand,
  IconMic,
  IconMicOff,
  IconPhoneOff,
  IconWaveform,
} from "../dashboard/AppleIcons";

export interface PetCallVisualState {
  state: VoiceCallState;
  micVolume: number;
  botVolume: number;
  muted: boolean;
}

export interface PetCallSubtitle {
  text: string;
  role: "system" | "user" | "assistant";
}

interface PetCallBarProps {
  onEmotionChange: (emotion: PetEmotion) => void;
  onVisualChange: (visual: PetCallVisualState) => void;
  onSubtitleChange?: (subtitle: PetCallSubtitle) => void;
  onHangUp: () => void;
}

function formatElapsed(totalSec: number): string {
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export default function PetCallBar({
  onEmotionChange,
  onVisualChange,
  onSubtitleChange,
  onHangUp,
}: PetCallBarProps) {
  const [callState, setCallState] = useState<VoiceCallState>("connecting");
  const [muted, setMuted] = useState(false);
  const [bargeInEnabled, setBargeInEnabled] = useState(true);
  const [manualCommitMode, setManualCommitMode] = useState(true);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [caption, setCaption] = useState("正在接通灵儿并预热语音...");
  const [captionRole, setCaptionRole] = useState<"system" | "user" | "assistant">(
    "system",
  );
  const [lastLatency, setLastLatency] = useState<VoiceCallLatency | null>(null);
  const [archiveBadge, setArchiveBadge] = useState<string | null>(null);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [sessionSeed, setSessionSeed] = useState(0);

  const engineRef = useRef<VoiceCallEngine | null>(null);
  const connectedSfxPlayedRef = useRef(false);
  const syncSessionBaseRef = useRef(0);
  const turnUserTextRef = useRef<Map<number, string>>(new Map());
  const micVolRef = useRef(0);
  const botVolRef = useRef(0);
  const stateRef = useRef<VoiceCallState>("connecting");
  const mutedRef = useRef(false);

  const onEmotionChangeRef = useRef(onEmotionChange);
  const onVisualChangeRef = useRef(onVisualChange);
  const onSubtitleChangeRef = useRef(onSubtitleChange);

  useEffect(() => {
    onEmotionChangeRef.current = onEmotionChange;
    onVisualChangeRef.current = onVisualChange;
    onSubtitleChangeRef.current = onSubtitleChange;
  }, [onEmotionChange, onVisualChange, onSubtitleChange]);

  useEffect(() => {
    onSubtitleChangeRef.current?.({ text: caption, role: captionRole });
  }, [caption, captionRole]);

  const emitVisual = useCallback(() => {
    onVisualChangeRef.current({
      state: stateRef.current,
      micVolume: micVolRef.current,
      botVolume: botVolRef.current,
      muted: mutedRef.current,
    });
  }, []);

  const isCallActive = callState !== "error" && callState !== "ended";
  const bargeInRef = useRef(bargeInEnabled);
  const manualCommitRef = useRef(manualCommitMode);

  useEffect(() => {
    bargeInRef.current = bargeInEnabled;
  }, [bargeInEnabled]);
  useEffect(() => {
    manualCommitRef.current = manualCommitMode;
  }, [manualCommitMode]);

  // 通话时长计时器（仅依赖通话是否进行中，避免每次状态切换重置秒表）
  useEffect(() => {
    if (!isCallActive) return;
    const timer = window.setInterval(() => {
      setElapsedSec((prev) => prev + 1);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [isCallActive]);

  // 启动与销毁全双工实时通话引擎（严格防 React StrictMode 双挂载竞态）
  useEffect(() => {
    let cancelled = false;
    setFatalError(null);
    setArchiveBadge(null);
    setElapsedSec(0);
    setCallState("connecting");
    stateRef.current = "connecting";
    connectedSfxPlayedRef.current = false;
    setCaption("正在接通灵儿并预热语音...");
    setCaptionRole("system");
    syncSessionBaseRef.current = (Date.now() % 1_000_000) * 1000;
    turnUserTextRef.current.clear();

    const engine = new VoiceCallEngine({
      onStateChange: (nextState) => {
        if (cancelled) return;
        // 首次从接通中进入正式通话态时播放「Huddle」接通音效
        if (
          !connectedSfxPlayedRef.current &&
          (nextState === "listening" ||
            nextState === "speaking" ||
            nextState === "user_speaking")
        ) {
          connectedSfxPlayedRef.current = true;
          playPetSound("huddle");
        }
        stateRef.current = nextState;
        setCallState(nextState);
        emitVisual();

        if (nextState === "listening" || nextState === "user_speaking") {
          onEmotionChangeRef.current("listening");
        } else if (nextState === "transcribing" || nextState === "thinking") {
          onEmotionChangeRef.current("thinking");
        } else if (nextState === "speaking") {
          onEmotionChangeRef.current("speaking");
        }
      },
      onMicVolume: (lvl) => {
        if (cancelled) return;
        micVolRef.current = lvl;
        emitVisual();
      },
      onBotVolume: (lvl) => {
        if (cancelled) return;
        botVolRef.current = lvl;
        emitVisual();
      },
      onGreetingText: (text) => {
        if (cancelled) return;
        setCaption(text);
        setCaptionRole("assistant");
      },
      onUserTranscript: (turnId, text) => {
        if (cancelled) return;
        turnUserTextRef.current.set(turnId, text);
        setArchiveBadge(null);
        setCaption(`你：${text}`);
        setCaptionRole("user");
      },
      onAssistantDelta: (_turnId, fullText) => {
        if (cancelled) return;
        setCaption(fullText);
        setCaptionRole("assistant");
      },
      onTurnDone: ({ turnId, reply, emotion, latency }) => {
        if (cancelled) return;
        setLastLatency(latency);
        onEmotionChangeRef.current(emotion);
        if (reply) {
          setCaption(reply);
          setCaptionRole("assistant");
          const userText = turnUserTextRef.current.get(turnId) || "";
          if (userText) {
            window.taiwanBotEnv?.syncVoiceCallTurn?.({
              turnId: syncSessionBaseRef.current + turnId,
              userText,
              assistantReply: reply,
              durationMs: latency.totalMs,
              timestampMs: Date.now(),
            });
          }
        }
      },
      onArchived: ({ turnId, tags, pendingHabits }) => {
        if (cancelled) return;
        if (tags.length > 0) {
          setArchiveBadge(tags[0]);
          window.setTimeout(() => {
            if (!cancelled) setArchiveBadge(null);
          }, 3200);
        }
        window.taiwanBotEnv?.syncVoiceCallTurn?.({
          turnId: syncSessionBaseRef.current + turnId,
          userText: "",
          assistantReply: "",
          durationMs: 0,
          timestampMs: Date.now(),
          tags,
          pendingHabits,
        });
      },
      onBargeIn: () => {
        if (cancelled) return;
        setCaption("已打断灵儿，请继续说～");
        setCaptionRole("system");
      },
      onWarning: (msg) => {
        if (cancelled) return;
        setCaption(msg);
        setCaptionRole("system");
      },
      onError: (msg) => {
        if (cancelled) return;
        setFatalError(msg);
        setCaption(msg);
        setCaptionRole("system");
      },
    });

    engineRef.current = engine;

    const boot = async () => {
      let rate = "+25%";
      try {
        const settings = await api.getSettings();
        const tts = (settings.tts as Record<string, unknown>) || {};
        if (typeof tts.rate === "string" && tts.rate) {
          rate = tts.rate;
        }
      } catch {
        // 读取设置失败时回退默认轻快语速
      }
      if (cancelled) return;
      await engine.start({
        mode: "normal",
        rate,
        bargeInEnabled: bargeInRef.current,
        manualCommitMode: manualCommitRef.current,
      });
      if (!cancelled && mutedRef.current) {
        engine.setMuted(true);
      }
    };

    void boot();

    return () => {
      cancelled = true;
      engine.stop();
      engineRef.current = null;
      micVolRef.current = 0;
      botVolRef.current = 0;
      stateRef.current = "ended";
      onVisualChangeRef.current({
        state: "ended",
        micVolume: 0,
        botVolume: 0,
        muted: false,
      });
    };
  }, [emitVisual, sessionSeed]);

  const handleToggleMute = () => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    engineRef.current?.setMuted(next);
    emitVisual();
  };

  const handleToggleBargeIn = () => {
    const next = !bargeInRef.current;
    bargeInRef.current = next;
    setBargeInEnabled(next);
    engineRef.current?.setBargeInEnabled(next);
    setCaption(
      next ? "随时插话已开启，开口就能打断灵儿" : "防回声模式：已关闭自动插话",
    );
    setCaptionRole("system");
  };

  const handleToggleManualCommit = () => {
    const next = !manualCommitRef.current;
    manualCommitRef.current = next;
    setManualCommitMode(next);
    engineRef.current?.setManualCommitMode(next);
    setCaption(
      next
        ? "手动发送模式：说完按空格或点「确认发送」"
        : "自动停顿模式：说完停顿 1.4 秒自动发送",
    );
    setCaptionRole("system");
  };

  const handleInterruptOrCommit = useCallback(() => {
    engineRef.current?.manualInterruptOrCommit();
  }, []);

  // 桌宠通话浮窗全局空格键快捷键：手动确认发送 / 打断（捕获阶段拦截，避免触发已聚焦按钮的重复点击）
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        (e.target instanceof HTMLElement && e.target.isContentEditable)
      ) {
        return;
      }
      if (e.code === "Space" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        handleInterruptOrCommit();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [handleInterruptOrCommit]);

  const handleHangUpClick = () => {
    engineRef.current?.stop();
    onHangUp();
  };

  const statusMeta = useMemo(() => {
    if (fatalError || callState === "error") {
      return { label: "连接中断", dotClass: "bg-rose-500" };
    }
    if (muted) {
      return { label: "已静音", dotClass: "bg-slate-400" };
    }
    switch (callState) {
      case "connecting":
        return { label: "接通中", dotClass: "bg-indigo-400" };
      case "user_speaking":
        return { label: "听你说中", dotClass: "bg-blue-600" };
      case "transcribing":
        return { label: "识别中", dotClass: "bg-indigo-400" };
      case "thinking":
        return { label: "思考中", dotClass: "bg-indigo-500" };
      case "speaking":
        return { label: "说话中", dotClass: "bg-sky-400" };
      default:
        return { label: "正在倾听", dotClass: "bg-cyan-500" };
    }
  }, [callState, fatalError, muted]);

  const actionActive =
    callState === "speaking" ||
    callState === "thinking" ||
    callState === "user_speaking";
  const actionLabel =
    callState === "user_speaking" ? "确认发送" : "打断";

  return (
    <div className="w-[292px] rounded-2xl bg-white/94 backdrop-blur-md border border-sky-200/90 shadow-[0_10px_28px_rgba(37,99,235,0.16)] px-3 py-2.5 space-y-2 animate-bubble-pop text-slate-800">
      {/* 顶行：状态脉动点 + 计时 + 首音延迟 */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="relative flex h-2 w-2 shrink-0">
            {callState !== "error" && callState !== "ended" && (
              <span
                className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-65 ${statusMeta.dotClass}`}
              />
            )}
            <span
              className={`relative inline-flex rounded-full h-2 w-2 ${statusMeta.dotClass}`}
            />
          </span>
          <span className="text-[11.5px] font-semibold text-slate-700 truncate">
            {statusMeta.label}
          </span>
          <span className="text-[11px] font-medium tabular-nums text-slate-400">
            {formatElapsed(elapsedSec)}
          </span>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={handleToggleManualCommit}
            title={
              manualCommitMode
                ? "当前：手动确认发送（思考停顿不断句，说完按空格或点确认发送）"
                : "当前：自动停顿发送（停顿 1.4 秒自动发送）"
            }
            className={`px-1.5 py-0.5 rounded-full text-[10px] font-medium border transition-colors cursor-pointer ${
              manualCommitMode
                ? "bg-sky-50 text-blue-700 border-sky-200/90"
                : "bg-slate-100 text-slate-500 border-slate-200/80"
            }`}
          >
            {manualCommitMode ? "手动发" : "自动发"}
          </button>
          {archiveBadge && (
            <span className="px-1.5 py-0.5 rounded-full bg-cyan-50 text-cyan-700 border border-cyan-200/80 text-[10px] font-medium">
              ✓ {archiveBadge}
            </span>
          )}
          {!archiveBadge && lastLatency && (
            <span className="px-1.5 py-0.5 rounded-full bg-indigo-50/90 text-indigo-700 border border-indigo-200/80 text-[10px] font-medium tabular-nums">
              首音 {(lastLatency.firstAudioMs / 1000).toFixed(1)}s
            </span>
          )}
        </div>
      </div>

      {/* 中段：紧凑实时字幕 / 异常重连提示 */}
      <div className="min-h-[32px] max-h-[42px] overflow-hidden rounded-xl bg-sky-50/75 border border-sky-100/95 px-2.5 py-1.5 flex items-center justify-between gap-2">
        <p
          className={`text-[11.5px] leading-[1.38] line-clamp-2 break-words flex-1 ${
            captionRole === "user"
              ? "text-blue-700 font-medium"
              : captionRole === "assistant"
                ? "text-slate-700"
                : "text-slate-500"
          }`}
        >
          {caption}
        </p>
        {fatalError && (
          <button
            type="button"
            onClick={() => setSessionSeed((s) => s + 1)}
            className="px-2 py-0.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-[10.5px] font-medium shrink-0 cursor-pointer"
          >
            重连
          </button>
        )}
      </div>

      {/* 底行：紧凑 4 键电话控制条 */}
      <div className="flex items-center justify-between gap-1.5 pt-0.5">
        <button
          type="button"
          onClick={handleToggleMute}
          title={muted ? "取消麦克风静音" : "静音麦克风"}
          className={`h-8 w-8 rounded-full flex items-center justify-center transition-all active:scale-95 cursor-pointer border ${
            muted
              ? "bg-rose-50 border-rose-200 text-rose-600"
              : "bg-sky-50/80 border-sky-200/80 text-slate-700 hover:bg-sky-100/80"
          }`}
        >
          {muted ? (
            <IconMicOff className="w-3.5 h-3.5" />
          ) : (
            <IconMic className="w-3.5 h-3.5" />
          )}
        </button>

        <button
          type="button"
          onClick={handleInterruptOrCommit}
          disabled={!actionActive}
          title="灵儿说话时按「空格」或点击立刻打断；自己说话时按「空格」或点击立刻发送"
          className={`flex-1 h-8 px-2.5 rounded-full flex items-center justify-center gap-1 text-[11.5px] font-medium transition-all active:scale-95 cursor-pointer disabled:opacity-45 disabled:cursor-default ${
            actionActive
              ? "bg-gradient-to-r from-blue-600 to-sky-500 hover:from-blue-700 hover:to-sky-600 text-white shadow-[0_4px_12px_rgba(37,99,235,0.26)]"
              : "bg-slate-100 text-slate-400 border border-slate-200/70"
          }`}
        >
          <IconHand className="w-3.5 h-3.5" />
          <span>{actionLabel}</span>
          <kbd
            className={`ml-0.5 px-1 py-0.2 rounded text-[9.5px] font-mono leading-tight ${
              actionActive
                ? "bg-white/20 text-white/95"
                : "bg-slate-200/70 text-slate-400"
            }`}
          >
            空格
          </kbd>
        </button>

        <button
          type="button"
          onClick={handleToggleBargeIn}
          title={
            bargeInEnabled
              ? "随时插话：已开启（外放若易回声可点此关闭）"
              : "随时插话：已关闭（防回声模式）"
          }
          className={`h-8 w-8 rounded-full flex items-center justify-center transition-all active:scale-95 cursor-pointer border ${
            bargeInEnabled
              ? "bg-sky-50 border-sky-200 text-blue-600 hover:bg-sky-100/80"
              : "bg-slate-100/90 border-slate-200/70 text-slate-400 hover:text-slate-600"
          }`}
        >
          <IconWaveform className="w-3.5 h-3.5" />
        </button>

        <button
          type="button"
          onClick={handleHangUpClick}
          title="挂断语音通话"
          className="h-8 px-3 rounded-full bg-gradient-to-r from-rose-500 to-pink-500 hover:from-rose-600 hover:to-pink-600 text-white flex items-center justify-center gap-1 text-[11.5px] font-medium shadow-[0_4px_12px_rgba(244,63,94,0.28)] transition-all active:scale-95 cursor-pointer"
        >
          <IconPhoneOff className="w-3.5 h-3.5" />
          <span>挂断</span>
        </button>
      </div>
    </div>
  );
}
