/**
 * 一对一低延迟实时语音通话沉浸界面（VoiceCallOverlay）
 * ---------------------------------------------------
 * 覆盖在主控面板 ChatView 内部，提供类似电话 / ChatGPT Voice Mode 的沉浸实时语音体验：
 * - 顶部：通话计时、场景切换（白天随聊 / 晚间复盘）、端到端首音延迟指示、字幕开关
 * - 中央：动态声波光环 + 灵儿表情实时联动 + 实时流式字幕与后台静默归档胶囊
 * - 底部：静音（M）、插话打断 / 立刻发送（Space）、自动插话防回声开关、挂断（Esc）
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AvatarRenderer from "../pet/AvatarRenderer";
import Tooltip from "./Tooltip";
import {
  IconCaptions,
  IconCheck,
  IconHand,
  IconMic,
  IconMicOff,
  IconPhoneOff,
  IconWaveform,
} from "./AppleIcons";
import {
  VoiceCallEngine,
  type VoiceCallLatency,
  type VoiceCallReadyInfo,
  type VoiceCallState,
} from "../../services/voiceCallEngine";
import type { ChatMode } from "../../services/petApi";
import type { PetEmotion } from "../../types/pet";

export interface CommittedVoiceTurn {
  turnId: number;
  userText: string;
  assistantReply: string;
  durationMs: number;
  timestampMs: number;
}

interface CallSubtitleItem {
  id: string;
  turnId: number;
  role: "user" | "assistant";
  text: string;
  streaming?: boolean;
  tags?: string[];
}

interface VoiceCallOverlayProps {
  mode: ChatMode;
  voiceRate: string;
  onModeChange: (nextMode: ChatMode) => void;
  onTurnCommitted: (turn: CommittedVoiceTurn) => void;
  onArchiveUpdate: (payload: {
    turnId: number;
    tags: string[];
    pendingHabits: Array<{ id: number; title: string; category: string }>;
  }) => void;
  onClose: () => void;
}

function formatCallElapsed(totalSec: number): string {
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export default function VoiceCallOverlay({
  mode,
  voiceRate,
  onModeChange,
  onTurnCommitted,
  onArchiveUpdate,
  onClose,
}: VoiceCallOverlayProps) {
  const [callState, setCallState] = useState<VoiceCallState>("connecting");
  const [readyInfo, setReadyInfo] = useState<VoiceCallReadyInfo | null>(null);
  const [muted, setMuted] = useState(false);
  const [bargeInEnabled, setBargeInEnabled] = useState(true);
  const [manualCommitMode, setManualCommitMode] = useState(true);
  const [showSubtitles, setShowSubtitles] = useState(true);
  const [micVolume, setMicVolume] = useState(0);
  const [botVolume, setBotVolume] = useState(0);
  const [botEmotion, setBotEmotion] = useState<PetEmotion>("listening");
  const [elapsedSec, setElapsedSec] = useState(0);
  const [lastLatency, setLastLatency] = useState<VoiceCallLatency | null>(null);
  const [subtitles, setSubtitles] = useState<CallSubtitleItem[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [sessionSeed, setSessionSeed] = useState(0);

  const engineRef = useRef<VoiceCallEngine | null>(null);
  const turnUserTextRef = useRef<Map<number, string>>(new Map());
  const subtitleEndRef = useRef<HTMLDivElement | null>(null);
  const initialModeRef = useRef<ChatMode>(mode);
  const initialRateRef = useRef<string>(voiceRate);
  const onTurnCommittedRef = useRef(onTurnCommitted);
  const onArchiveUpdateRef = useRef(onArchiveUpdate);

  useEffect(() => {
    onTurnCommittedRef.current = onTurnCommitted;
    onArchiveUpdateRef.current = onArchiveUpdate;
  }, [onTurnCommitted, onArchiveUpdate]);

  const isCallActive = callState !== "error" && callState !== "ended";
  const noticeTimerRef = useRef<number | null>(null);
  const bargeInRef = useRef(bargeInEnabled);
  const manualCommitRef = useRef(manualCommitMode);
  const mutedRef = useRef(muted);

  useEffect(() => {
    bargeInRef.current = bargeInEnabled;
  }, [bargeInEnabled]);
  useEffect(() => {
    manualCommitRef.current = manualCommitMode;
  }, [manualCommitMode]);
  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

  const showTransientNotice = useCallback((msg: string, ms = 2600) => {
    setNotice(msg);
    if (noticeTimerRef.current !== null) {
      window.clearTimeout(noticeTimerRef.current);
    }
    noticeTimerRef.current = window.setTimeout(() => {
      noticeTimerRef.current = null;
      setNotice(null);
    }, ms);
  }, []);

  useEffect(() => {
    return () => {
      if (noticeTimerRef.current !== null) {
        window.clearTimeout(noticeTimerRef.current);
      }
    };
  }, []);

  // 通话计时器（仅依赖通话是否进行中，避免每次状态切换重置秒表）
  useEffect(() => {
    if (!isCallActive) return;
    const timer = window.setInterval(() => {
      setElapsedSec((prev) => prev + 1);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [isCallActive]);

  // 字幕自动滚动到底部
  useEffect(() => {
    if (showSubtitles) {
      subtitleEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [subtitles, showSubtitles]);

  // 启动与销毁全双工实时通话引擎（严格兼容 React 19 StrictMode 双挂载防竞态）
  useEffect(() => {
    let cancelled = false;
    setFatalError(null);
    setNotice(null);
    setCallState("connecting");
    setElapsedSec(0);
    turnUserTextRef.current.clear();

    const engine = new VoiceCallEngine({
      onStateChange: (nextState) => {
        if (cancelled) return;
        setCallState(nextState);
        if (nextState === "listening" || nextState === "user_speaking") {
          setBotEmotion("listening");
          window.taiwanBotEnv?.sendPetPreviewState({ emotion: "listening" });
        } else if (nextState === "transcribing" || nextState === "thinking") {
          setBotEmotion("thinking");
          window.taiwanBotEnv?.sendPetPreviewState({ emotion: "thinking" });
        } else if (nextState === "speaking") {
          setBotEmotion("speaking");
          window.taiwanBotEnv?.sendPetPreviewState({ emotion: "speaking" });
        }
      },
      onReady: (info) => {
        if (cancelled) return;
        setReadyInfo(info);
      },
      onMicVolume: (lvl) => {
        if (!cancelled) setMicVolume(lvl);
      },
      onBotVolume: (lvl) => {
        if (!cancelled) setBotVolume(lvl);
      },
      onGreetingText: (text) => {
        if (cancelled) return;
        setSubtitles((prev) => {
          if (prev.some((item) => item.id === "greeting")) return prev;
          return [
            ...prev,
            { id: "greeting", turnId: 0, role: "assistant", text },
          ];
        });
      },
      onUserTranscript: (turnId, text) => {
        if (cancelled) return;
        turnUserTextRef.current.set(turnId, text);
        setNotice(null);
        setSubtitles((prev) => [
          ...prev,
          { id: `u-${turnId}`, turnId, role: "user", text },
        ]);
      },
      onAssistantDelta: (turnId, fullText) => {
        if (cancelled) return;
        setSubtitles((prev) => {
          const aid = `a-${turnId}`;
          const exists = prev.some((item) => item.id === aid);
          if (exists) {
            return prev.map((item) =>
              item.id === aid
                ? { ...item, text: fullText, streaming: true }
                : item,
            );
          }
          return [
            ...prev,
            {
              id: aid,
              turnId,
              role: "assistant",
              text: fullText,
              streaming: true,
            },
          ];
        });
      },
      onTurnDone: ({ turnId, reply, emotion, latency }) => {
        if (cancelled) return;
        setLastLatency(latency);
        setBotEmotion(emotion);
        if (reply) {
          setSubtitles((prev) => {
            const aid = `a-${turnId}`;
            const exists = prev.some((item) => item.id === aid);
            if (exists) {
              return prev.map((item) =>
                item.id === aid
                  ? { ...item, text: reply, streaming: false }
                  : item,
              );
            }
            return [
              ...prev,
              {
                id: aid,
                turnId,
                role: "assistant",
                text: reply,
                streaming: false,
              },
            ];
          });
        }

        const userText = turnUserTextRef.current.get(turnId) || "";
        if (userText && reply) {
          onTurnCommittedRef.current({
            turnId,
            userText,
            assistantReply: reply,
            durationMs: latency.totalMs,
            timestampMs: Date.now(),
          });
        }
      },
      onArchived: ({ turnId, tags, pendingHabits }) => {
        if (cancelled) return;
        if (tags.length > 0) {
          setSubtitles((prev) =>
            prev.map((item) =>
              item.id === `a-${turnId}` ? { ...item, tags } : item,
            ),
          );
        }
        onArchiveUpdateRef.current({ turnId, tags, pendingHabits });
      },
      onBargeIn: () => {
        if (cancelled) return;
        setNotice("已打断灵儿，请继续说～");
        window.setTimeout(() => {
          setNotice((prev) =>
            prev === "已打断灵儿，请继续说～" ? null : prev,
          );
        }, 1800);
      },
      onWarning: (msg) => {
        if (!cancelled) setNotice(msg);
      },
      onError: (msg) => {
        if (!cancelled) setFatalError(msg);
      },
    });

    engineRef.current = engine;
    void engine
      .start({
        mode: initialModeRef.current,
        rate: initialRateRef.current,
        bargeInEnabled: bargeInRef.current,
        manualCommitMode: manualCommitRef.current,
      })
      .then(() => {
        if (!cancelled && mutedRef.current) {
          engine.setMuted(true);
        }
      });

    return () => {
      cancelled = true;
      engine.stop();
      engineRef.current = null;
      window.taiwanBotEnv?.sendPetPreviewState({ emotion: "idle" });
    };
  }, [sessionSeed]);

  // 模式或语速变化时热更新给正在运行的通话引擎
  useEffect(() => {
    initialModeRef.current = mode;
    initialRateRef.current = voiceRate;
    engineRef.current?.updateConfig({ mode, rate: voiceRate });
  }, [mode, voiceRate]);

  const handleToggleMute = useCallback(() => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    engineRef.current?.setMuted(next);
  }, []);

  const handleToggleBargeIn = useCallback(() => {
    const next = !bargeInRef.current;
    bargeInRef.current = next;
    setBargeInEnabled(next);
    engineRef.current?.setBargeInEnabled(next);
    showTransientNotice(
      next
        ? "已开启随时插话打断（说话时可直接开口打断灵儿）"
        : "已关闭自动插话（适合外放防回声，可按空格键手动打断）",
      2600,
    );
  }, [showTransientNotice]);

  const handleToggleManualCommit = useCallback(() => {
    const next = !manualCommitRef.current;
    manualCommitRef.current = next;
    setManualCommitMode(next);
    engineRef.current?.setManualCommitMode(next);
    showTransientNotice(
      next
        ? "已切换为「手动确认发送」：停顿思考不会被截断，说完按空格或点「确认发送」"
        : "已切换为「自动停顿发送」：说完停顿 1.4 秒自动回应",
      2800,
    );
  }, [showTransientNotice]);

  const handlePrimaryAction = useCallback(() => {
    engineRef.current?.manualInterruptOrCommit();
  }, []);

  const handleHangUp = useCallback(() => {
    engineRef.current?.stop();
    onClose();
  }, [onClose]);

  // 通话快捷键：Space 打断/立刻发送 · M 静音 · Esc 挂断
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }
      if (e.code === "Space") {
        e.preventDefault();
        handlePrimaryAction();
      } else if (e.key.toLowerCase() === "m") {
        e.preventDefault();
        handleToggleMute();
      } else if (e.key === "Escape") {
        e.preventDefault();
        handleHangUp();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleHangUp, handlePrimaryAction, handleToggleMute]);

  // 根据当前通话态计算光环色系、缩放振幅与引导文案
  const visualMeta = useMemo(() => {
    if (fatalError || callState === "error") {
      return {
        headline: "通话连接中断",
        subline: fatalError || "请检查后端服务与麦克风状态后重试",
        ringColor: "rgba(244, 63, 94, 0.25)",
        coreGlow: "rgba(244, 63, 94, 0.16)",
        dotClass: "bg-rose-500",
        scale: 1,
      };
    }
    if (muted) {
      return {
        headline: "麦克风已静音",
        subline: "点击下方麦克风按钮或按 M 键恢复说话",
        ringColor: "rgba(148, 163, 184, 0.24)",
        coreGlow: "rgba(148, 163, 184, 0.12)",
        dotClass: "bg-stone-400",
        scale: 1,
      };
    }
    switch (callState) {
      case "connecting":
        return {
          headline: "正在接通灵儿...",
          subline: "正在预热本地离线语音识别与通话通道",
          ringColor: "rgba(245, 158, 11, 0.24)",
          coreGlow: "rgba(245, 158, 11, 0.14)",
          dotClass: "bg-amber-500",
          scale: 1.02,
        };
      case "user_speaking":
        return {
          headline: "灵儿正在认真听你说...",
          subline: manualCommitMode
            ? "可以放心停顿思考，说完按「空格键」或点下方「确认发送」"
            : "说完停顿约 1.4 秒自动回应，或按空格立刻发送",
          ringColor: "rgba(37, 99, 235, 0.34)",
          coreGlow: "rgba(59, 130, 246, 0.22)",
          dotClass: "bg-blue-500",
          scale: 1 + micVolume * 0.22,
        };
      case "transcribing":
        return {
          headline: "听到了，正在转写整理...",
          subline: "本地高速识别并自动纠错整理语句中",
          ringColor: "rgba(245, 158, 11, 0.28)",
          coreGlow: "rgba(245, 158, 11, 0.16)",
          dotClass: "bg-amber-500",
          scale: 1.04,
        };
      case "thinking":
        return {
          headline: `${readyInfo?.botName || "灵儿"}思考中...`,
          subline: "流式生成首句中，马上开口回复你",
          ringColor: "rgba(245, 158, 11, 0.3)",
          coreGlow: "rgba(251, 191, 36, 0.2)",
          dotClass: "bg-amber-500",
          scale: 1.05,
        };
      case "speaking":
        return {
          headline: `${readyInfo?.botName || "灵儿"}正在说话`,
          subline: bargeInEnabled
            ? "随时可以直接开口插话，或按空格键打断"
            : "自动插话已关闭，按空格键可随时手动打断",
          ringColor: "rgba(245, 158, 11, 0.36)",
          coreGlow: "rgba(251, 146, 60, 0.24)",
          dotClass: "bg-emerald-500",
          scale: 1 + botVolume * 0.26,
        };
      default:
        return {
          headline: "正在倾听，直接开口就行～",
          subline: manualCommitMode
            ? "直接开始说，中间停顿不会抢话，说完按「空格键」确认发送"
            : "像打电话一样自然聊天，说完停顿自动发送",
          ringColor: "rgba(16, 185, 129, 0.24)",
          coreGlow: "rgba(16, 185, 129, 0.14)",
          dotClass: "bg-emerald-500",
          scale: 1 + micVolume * 0.12,
        };
    }
  }, [
    bargeInEnabled,
    botVolume,
    callState,
    fatalError,
    manualCommitMode,
    micVolume,
    muted,
    readyInfo?.botName,
  ]);

  const primaryActionState = useMemo(() => {
    if (callState === "speaking" || callState === "thinking") {
      return {
        label: "打断灵儿 (Space)",
        tooltip: "立刻打断灵儿并开始说话 (Space)",
        enabled: true,
        highlight: true,
      };
    }
    if (callState === "user_speaking") {
      return {
        label: "确认发送 (Space)",
        tooltip: "说完后确认发送给灵儿 (Space)",
        enabled: true,
        highlight: true,
      };
    }
    return {
      label: manualCommitMode ? "等待开口 (Space)" : "插话 / 发送",
      tooltip: "直接开口说话，说完按空格或点此确认发送 (Space)",
      enabled: false,
      highlight: false,
    };
  }, [callState, manualCommitMode]);

  const activeLevel =
    callState === "speaking" ? botVolume : muted ? 0 : micVolume;

  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-[var(--bg-canvas)]/98 backdrop-blur-xl animate-fade-up select-none">
      {/* 顶部极简通话状态栏 */}
      <header className="h-[54px] px-5 flex items-center justify-between gap-3 shrink-0 border-b border-[var(--border-subtle)]">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="relative flex h-2.5 w-2.5 shrink-0">
            {callState !== "error" && callState !== "ended" && (
              <span
                className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-60 ${visualMeta.dotClass}`}
              />
            )}
            <span
              className={`relative inline-flex rounded-full h-2.5 w-2.5 ${visualMeta.dotClass}`}
            />
          </span>
          <span className="text-[14px] font-semibold text-[var(--text-primary)] truncate">
            与 {readyInfo?.botName || "灵儿"} 实时通话
          </span>
          <span className="text-[12.5px] font-medium tabular-nums text-[var(--text-tertiary)]">
            {formatCallElapsed(elapsedSec)}
          </span>
        </div>

        {/* 右侧：场景快速切换 + 端到端首音延迟监控 + 字幕显示开关 */}
        <div className="flex items-center gap-2 shrink-0">
          <div className="inline-flex p-0.5 rounded-full bg-[var(--bg-subtle)] border border-[var(--border-subtle)]">
            {(
              [
                { id: "normal", label: "白天随聊" },
                { id: "evening_review", label: "晚间复盘" },
              ] as const
            ).map((opt) => {
              const active = mode === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => onModeChange(opt.id)}
                  className={`px-2.5 py-1 rounded-full text-[11.5px] font-medium transition-colors cursor-pointer ${
                    active
                      ? "bg-[var(--bg-surface)] text-[var(--text-primary)] shadow-xs"
                      : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>

          {lastLatency && (
            <Tooltip
              label={`语音识别 ${lastLatency.sttMs}ms · 首字生成 ${lastLatency.llmFirstTokenMs}ms · 首句出声 ${lastLatency.firstAudioMs}ms`}
              side="bottom"
            >
              <span className="hidden sm:inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-[11px] font-medium tabular-nums text-emerald-700 dark:text-emerald-300">
                首音 {(lastLatency.firstAudioMs / 1000).toFixed(1)}s
              </span>
            </Tooltip>
          )}

          <Tooltip
            label={
              manualCommitMode
                ? "当前：手动确认发送（说完按空格/按钮发送，思考停顿不断句）"
                : "当前：自动停顿发送（停顿 1.4 秒自动发送）"
            }
            side="bottom"
          >
            <button
              type="button"
              onClick={handleToggleManualCommit}
              className={`h-8 px-2.5 rounded-xl text-[11.5px] font-medium transition-colors cursor-pointer border ${
                manualCommitMode
                  ? "bg-blue-500/10 border-blue-500/25 text-blue-700 dark:text-blue-300"
                  : "bg-[var(--bg-subtle)] border-[var(--border-subtle)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
              }`}
            >
              {manualCommitMode ? "手动发送" : "自动停顿"}
            </button>
          </Tooltip>

          <Tooltip
            label={showSubtitles ? "隐藏实时字幕" : "显示实时字幕"}
            side="bottom"
          >
            <button
              type="button"
              onClick={() => setShowSubtitles((v) => !v)}
              className={`h-8 px-2.5 rounded-xl flex items-center gap-1.5 text-[12px] font-medium transition-colors cursor-pointer border ${
                showSubtitles
                  ? "bg-[var(--bg-active)] border-[var(--border-strong)] text-[var(--text-primary)]"
                  : "bg-transparent border-transparent text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              }`}
            >
              <IconCaptions className="w-4 h-4" />
              <span className="hidden sm:inline">字幕</span>
            </button>
          </Tooltip>
        </div>
      </header>

      {/* 中央主舞台：动态声波光环 + 灵儿形象 + 实时流式字幕 */}
      <div className="flex-1 min-h-0 flex flex-col items-center justify-center px-6 py-5 gap-5 overflow-hidden">
        {/* 实时声波光环球 */}
        <div className="relative flex items-center justify-center w-[210px] h-[210px] shrink-0">
          {/* 外圈呼吸光晕 */}
          <div
            className="absolute inset-2 rounded-full transition-transform duration-100 ease-out"
            style={{
              background: `radial-gradient(circle, ${visualMeta.ringColor} 0%, transparent 72%)`,
              transform: `scale(${(visualMeta.scale * 1.12).toFixed(3)})`,
            }}
          />
          {/* 中圈弹性声波环 */}
          <div
            className="absolute inset-7 rounded-full border transition-all duration-100 ease-out"
            style={{
              borderColor: visualMeta.ringColor,
              backgroundColor: visualMeta.coreGlow,
              transform: `scale(${visualMeta.scale.toFixed(3)})`,
            }}
          />
          {/* 中心灵儿头像圆盘 */}
          <div className="relative w-[132px] h-[132px] rounded-full bg-[#FFF7E6] dark:bg-amber-500/12 border border-[var(--border-subtle)] shadow-[0_12px_36px_rgba(0,0,0,0.08)] flex items-center justify-center overflow-hidden">
            <AvatarRenderer emotion={botEmotion} size={108} />
          </div>
        </div>

        {/* 动态声波指示条 + 状态文案 */}
        <div className="text-center space-y-1.5 max-w-md">
          <div className="flex items-center justify-center gap-1 h-4 mb-1">
            {[0.45, 0.85, 1, 0.72, 0.92, 0.58, 0.4].map((mult, idx) => (
              <span
                key={idx}
                className={`w-[3px] rounded-full transition-all duration-75 ${
                  callState === "user_speaking"
                    ? "bg-blue-500"
                    : callState === "speaking"
                      ? "bg-amber-500"
                      : callState === "thinking" || callState === "transcribing"
                        ? "bg-amber-400/80"
                        : "bg-[var(--text-tertiary)]/40"
                }`}
                style={{
                  height: `${Math.max(4, Math.min(16, 4 + activeLevel * 18 * mult))}px`,
                }}
              />
            ))}
          </div>

          <h3 className="text-[19px] font-semibold tracking-tight text-[var(--text-primary)]">
            {visualMeta.headline}
          </h3>
          <p className="text-[12.5px] text-[var(--text-tertiary)] leading-relaxed">
            {visualMeta.subline}
          </p>

          {notice && !fatalError && (
            <div className="inline-flex items-center px-3 py-1 mt-1 rounded-full bg-amber-500/12 border border-amber-500/20 text-[11.5px] text-amber-700 dark:text-amber-300">
              {notice}
            </div>
          )}

          {fatalError && (
            <div className="pt-2">
              <button
                type="button"
                onClick={() => setSessionSeed((s) => s + 1)}
                className="h-8 px-4 rounded-full bg-[var(--ink-primary)] hover:bg-[var(--ink-primary-hover)] text-[var(--ink-primary-fg)] text-[12.5px] font-medium transition-colors cursor-pointer"
              >
                重新连接通话
              </button>
            </div>
          )}
        </div>

        {/* 可折叠实时对话字幕区 */}
        {showSubtitles && (
          <div className="w-full max-w-[600px] flex-1 min-h-[108px] max-h-[210px] rounded-2xl bg-[var(--bg-surface)] border border-[var(--border-subtle)] px-4 py-3 overflow-y-auto select-text">
            {subtitles.length === 0 ? (
              <div className="h-full flex items-center justify-center text-[12.5px] text-[var(--text-tertiary)]">
                通话实时字幕将在这里同步显示，挂断后自动归档到今日聊天记录
              </div>
            ) : (
              <div className="space-y-2.5">
                {subtitles.map((item) => (
                  <div
                    key={item.id}
                    className={`flex flex-col gap-1 ${
                      item.role === "user" ? "items-end" : "items-start"
                    }`}
                  >
                    <div
                      className={`max-w-[86%] px-3 py-1.5 rounded-2xl text-[13px] leading-relaxed ${
                        item.role === "user"
                          ? "bg-[var(--user-bubble-bg)] text-[var(--user-bubble-fg)]"
                          : "bg-amber-500/8 border border-amber-500/15 text-[var(--text-primary)]"
                      }`}
                    >
                      <span>{item.text}</span>
                      {item.streaming && (
                        <span className="inline-block w-1.5 h-3.5 ml-1 align-middle rounded-xs bg-amber-500/70 animate-pulse" />
                      )}
                    </div>
                    {item.tags && item.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1 px-1">
                        {item.tags.map((tag) => (
                          <span
                            key={tag}
                            className="inline-flex items-center gap-1 text-[10.5px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 font-medium"
                          >
                            <IconCheck className="w-2.5 h-2.5" />
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
                <div ref={subtitleEndRef} />
              </div>
            )}
          </div>
        )}
      </div>

      {/* 底部电话控制坞 */}
      <footer className="px-6 pb-6 pt-3 shrink-0 flex flex-col items-center gap-2.5">
        <div className="flex items-center justify-center gap-3.5">
          {/* 1. 静音 / 取消静音 */}
          <Tooltip
            label={muted ? "取消麦克风静音 (M)" : "静音麦克风 (M)"}
            side="top"
          >
            <button
              type="button"
              onClick={handleToggleMute}
              className={`w-12 h-12 rounded-full flex items-center justify-center transition-all active:scale-95 cursor-pointer border ${
                muted
                  ? "bg-rose-500/12 border-rose-500/30 text-rose-600 dark:text-rose-400"
                  : "bg-[var(--bg-surface)] border-[var(--border-subtle)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
              }`}
            >
              {muted ? (
                <IconMicOff className="w-5 h-5" />
              ) : (
                <IconMic className="w-5 h-5" />
              )}
            </button>
          </Tooltip>

          {/* 2. 主快捷操作：打断灵儿 / 立刻提交本句 */}
          <Tooltip label={primaryActionState.tooltip} side="top">
            <button
              type="button"
              onClick={handlePrimaryAction}
              disabled={!primaryActionState.enabled}
              className={`h-12 px-5 rounded-full flex items-center justify-center gap-2 text-[13px] font-medium transition-all active:scale-95 cursor-pointer disabled:opacity-40 disabled:cursor-default border ${
                primaryActionState.highlight
                  ? "bg-[var(--ink-primary)] hover:bg-[var(--ink-primary-hover)] text-[var(--ink-primary-fg)] border-transparent shadow-sm"
                  : "bg-[var(--bg-surface)] border-[var(--border-subtle)] text-[var(--text-secondary)]"
              }`}
            >
              <IconHand className="w-4 h-4" />
              <span>{primaryActionState.label}</span>
            </button>
          </Tooltip>

          {/* 3. 自动插话打断开关（外放防回声保护） */}
          <Tooltip
            label={
              bargeInEnabled
                ? "随时插话：已开启（外放若易回声可点此关闭）"
                : "随时插话：已关闭（防回声模式，点此恢复）"
            }
            side="top"
          >
            <button
              type="button"
              onClick={handleToggleBargeIn}
              className={`w-12 h-12 rounded-full flex items-center justify-center transition-all active:scale-95 cursor-pointer border ${
                bargeInEnabled
                  ? "bg-blue-500/12 border-blue-500/25 text-blue-600 dark:text-blue-400"
                  : "bg-[var(--bg-surface)] border-[var(--border-subtle)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
              }`}
            >
              <IconWaveform className="w-5 h-5" />
            </button>
          </Tooltip>

          {/* 4. 挂断电话 */}
          <Tooltip label="挂断电话 (Esc)" side="top">
            <button
              type="button"
              onClick={handleHangUp}
              className="w-12 h-12 rounded-full bg-rose-500 hover:bg-rose-600 text-white flex items-center justify-center shadow-[0_6px_18px_rgba(244,63,94,0.35)] transition-all active:scale-95 cursor-pointer"
            >
              <IconPhoneOff className="w-5 h-5" />
            </button>
          </Tooltip>
        </div>

        <p className="text-[11px] text-[var(--text-tertiary)]">
          空格键确认发送 / 打断 · M 键静音 · Esc 挂断 ·{" "}
          {readyInfo
            ? `${
                readyInfo.sttEngine === "sherpa-onnx"
                  ? "SenseVoice Small + 自动纠错"
                  : readyInfo.sttEngine
              } + ${readyInfo.ttsProvider === "fish_audio" ? "Fish Audio 台湾腔" : "Edge-TTS 台湾腔"}`
            : "准备通话引擎中..."}
        </p>
      </footer>
    </div>
  );
}
