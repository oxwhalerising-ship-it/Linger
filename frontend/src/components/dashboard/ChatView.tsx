/**
 * ChatGPT Desktop 风格语音/文字对话室（ChatView）
 * ---------------------------------------------
 * 视觉与交互参考 ChatGPT Desktop 原生客户端：
 * - 顶部 52px 极简浮动栏 + 模式切换下拉菜单（白天随聊 / 晚间清单复盘）
 * - 居中 768px 编辑感消息流：用户消息为中性圆角胶囊，灵儿回复为无边框通栏排版 + 悬停操作栏（复制 / 重播语音）
 * - 底部标志性圆角悬浮输入胶囊：支持多行自适应输入、IME 中文选词防误触、双模语音（点击说话 / 免提 VAD）与声波反馈
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import {
  api,
  formatLocalDate,
  type ChatMessageItem,
  type SttStatusData,
} from "../../services/api";
import {
  playFillerSound,
  playTaiwanSentences,
  sendQuickChat,
  splitSentencesForSpeech,
  type ChatMode,
} from "../../services/petApi";
import {
  isBrowserSpeechAvailable,
  LocalWavRecorder,
  startBrowserSpeechOnce,
  type VoiceInputMode,
} from "../../services/voiceRecorder";
import AvatarRenderer from "../pet/AvatarRenderer";
import type { PetEmotion } from "../../types/pet";
import type { DashboardViewProps } from "./DashboardLayout";
import Tooltip from "./Tooltip";
import VoiceCallOverlay, {
  type CommittedVoiceTurn,
} from "./VoiceCallOverlay";
import {
  IconArrowUp,
  IconCheck,
  IconChevronDown,
  IconCopy,
  IconMic,
  IconPhone,
  IconSidebar,
  IconStop,
  IconVolumeOff,
  IconVolumeOn,
} from "./AppleIcons";

const SPEED_OPTIONS: Array<{ value: string; label: string; desc: string }> = [
  { value: "-20%", label: "0.8x", desc: "舒缓" },
  { value: "+0%", label: "1.0x", desc: "标准" },
  { value: "+25%", label: "1.25x", desc: "轻快" },
  { value: "+50%", label: "1.5x", desc: "爽快" },
  { value: "+100%", label: "2.0x", desc: "极速" },
];

interface LocalChatBubble {
  id: string;
  role: "user" | "assistant";
  content: string;
  sentences?: string[];
  time: string;
  createdAtMs: number;
  durationMs?: number;
  tags?: string[];
}

function parseTimestampMs(isoLike: string): number {
  const parsed = Date.parse(isoLike);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

function formatRelativeTime(createdAtMs: number, nowMs: number): string {
  const diffSec = Math.max(0, Math.floor((nowMs - createdAtMs) / 1000));
  if (diffSec < 60) return "刚刚";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}分钟前`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}小时前`;
  const diffDay = Math.floor(diffHour / 24);
  return `${diffDay}天前`;
}

function formatDuration(durationMs: number): string {
  const sec = Math.max(0.1, durationMs / 1000);
  if (sec < 60) {
    return `${sec.toFixed(1)} 秒`;
  }
  const mins = Math.floor(sec / 60);
  const remSec = sec - mins * 60;
  return `${mins} 分 ${remSec.toFixed(1)} 秒`;
}

const MODE_OPTIONS: Array<{
  id: ChatMode;
  title: string;
  shortTitle: string;
  desc: string;
}> = [
  {
    id: "normal",
    title: "白天随聊",
    shortTitle: "白天随聊",
    desc: "边聊边静默帮你记录习惯、心情与日常点滴",
  },
  {
    id: "evening_review",
    title: "晚间清单复盘",
    shortTitle: "晚间复盘",
    desc: "逐项核对今日未记录的习惯清单并收集小确幸",
  },
];

const QUICK_PROMPTS = [
  {
    title: "汇报今日习惯",
    prompt: "今天喝够水了，下午还去散步了半小时！",
  },
  {
    title: "倾诉此刻心情",
    prompt: "有点累捏，工作一直卡住好烦喔",
  },
  {
    title: "开启晚间复盘",
    prompt: "开始今天的晚间复盘吧，帮我核对一下清单",
  },
];

export default function ChatView({
  sidebarOpen,
  onToggleSidebar,
}: DashboardViewProps) {
  const [messages, setMessages] = useState<LocalChatBubble[]>([]);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<ChatMode>("normal");
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [activeVoiceMode, setActiveVoiceMode] = useState<VoiceInputMode | null>(
    null,
  );
  const [autoSpeak, setAutoSpeak] = useState(true);
  const [voiceRate, setVoiceRate] = useState("+25%");
  const [speedMenuOpen, setSpeedMenuOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [volumeLevel, setVolumeLevel] = useState(0);
  const [botEmotion, setBotEmotion] = useState<PetEmotion>("idle");
  const [pendingHabits, setPendingHabits] = useState<
    Array<{ id: number; title: string; category: string }>
  >([]);
  const [sttStatus, setSttStatus] = useState<SttStatusData | null>(null);
  const [statusHint, setStatusHint] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [replayingId, setReplayingId] = useState<string | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [thinkingElapsedMs, setThinkingElapsedMs] = useState(0);
  const [voiceCallOpen, setVoiceCallOpen] = useState(false);

  const listEndRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const modeMenuRef = useRef<HTMLDivElement | null>(null);
  const speedMenuRef = useRef<HTMLDivElement | null>(null);
  const ttsSettingsRef = useRef<Record<string, unknown>>({});
  const audioAbortRef = useRef<AbortController | null>(null);
  const recorderRef = useRef<LocalWavRecorder | null>(null);
  const stopBrowserSpeechRef = useRef<(() => void) | null>(null);
  const sendingRef = useRef(false);

  useEffect(() => {
    sendingRef.current = sending;
  }, [sending]);

  // 每 30 秒刷新一次相对时间（刚刚 / X分钟前）
  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowTick(Date.now());
    }, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  // 思考期间实时计时，方便直观看到当前等待时长
  useEffect(() => {
    if (!sending) {
      setThinkingElapsedMs(0);
      return;
    }
    const start = performance.now();
    setThinkingElapsedMs(0);
    const timer = window.setInterval(() => {
      setThinkingElapsedMs(Math.round(performance.now() - start));
    }, 100);
    return () => window.clearInterval(timer);
  }, [sending]);

  // 点击外部关闭模式 / 语速下拉菜单
  useEffect(() => {
    if (!modeMenuOpen && !speedMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (
        modeMenuRef.current &&
        !modeMenuRef.current.contains(e.target as Node)
      ) {
        setModeMenuOpen(false);
      }
      if (
        speedMenuRef.current &&
        !speedMenuRef.current.contains(e.target as Node)
      ) {
        setSpeedMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [modeMenuOpen, speedMenuOpen]);

  // 自动调整 textarea 高度
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  // 加载今日对话历史与本地离线 STT 状态
  useEffect(() => {
    const today = formatLocalDate();
    void api
      .getChatHistory(today)
      .then((res) => {
        const mapped: LocalChatBubble[] = res.messages
          .filter(
            (m: ChatMessageItem) => m.role === "user" || m.role === "assistant",
          )
          .map((m) => ({
            id: String(m.id),
            role: m.role === "user" ? "user" : "assistant",
            content: m.content,
            time: m.created_at.slice(11, 16),
            createdAtMs: parseTimestampMs(m.created_at),
            durationMs:
              typeof m.duration_ms === "number" ? m.duration_ms : undefined,
          }));
        setMessages(mapped);
      })
      .catch(() => {});

    void api
      .getSttStatus()
      .then((s) => setSttStatus(s))
      .catch(() => {});

    void api
      .getSettings()
      .then((settingsData) => {
        const tts = (settingsData.tts as Record<string, unknown>) || {};
        ttsSettingsRef.current = tts;
        if (typeof tts.rate === "string" && tts.rate) {
          setVoiceRate(tts.rate);
        }
      })
      .catch(() => {});

    void Promise.all([api.listHabits(true), api.getDailyLog(today)])
      .then(([activeHabits, dailyLog]) => {
        const recordedIds = new Set(
          dailyLog.habit_records.map((r) => r.habit_id),
        );
        setPendingHabits(
          activeHabits
            .filter((h) => !recordedIds.has(h.id))
            .map((h) => ({ id: h.id, title: h.title, category: h.category })),
        );
      })
      .catch(() => {});

    return () => {
      audioAbortRef.current?.abort();
      recorderRef.current?.stop();
      stopBrowserSpeechRef.current?.();
    };
  }, []);

  useEffect(() => {
    listEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending]);

  /** 发送消息给台湾腔小管家，并驱动垫词 + 流式分句语音播报 */
  const handleSendMessage = useCallback(
    async (rawText: string) => {
      const text = rawText.trim();
      if (!text || sending) return;

      audioAbortRef.current?.abort();
      const controller = new AbortController();
      audioAbortRef.current = controller;

      const sentAtMs = Date.now();
      const nowStr = new Date(sentAtMs).toTimeString().slice(0, 5);
      setMessages((prev) => [
        ...prev,
        {
          id: `u-${sentAtMs}`,
          role: "user",
          content: text,
          time: nowStr,
          createdAtMs: sentAtMs,
        },
      ]);
      setNowTick(sentAtMs);
      setInput("");
      setSending(true);
      setStatusHint(null);
      setBotEmotion("thinking");
      window.taiwanBotEnv?.sendPetPreviewState({
        emotion: "thinking",
        bubble: "嗯嗯～我想一下喔...",
      });

      if (autoSpeak) {
        void playFillerSound("uhhuh", controller.signal);
      }

      const startedPerf = performance.now();
      try {
        const res = await sendQuickChat(text, mode, "manual");
        const durationMs = Math.max(100, Math.round(performance.now() - startedPerf));
        const repliedAtMs = Date.now();
        const tags: string[] = [];
        if (res.extracted?.habit_updates?.length) {
          tags.push(`已静默记录 ${res.extracted.habit_updates.length} 项习惯`);
        }
        if (res.extracted?.new_highlights?.length) {
          tags.push(`收入 ${res.extracted.new_highlights.length} 条小确幸`);
        }
        if (res.extracted?.new_memories?.length) {
          tags.push(`记住 ${res.extracted.new_memories.length} 条长期记忆`);
        }
        if (res.used_offline_fallback) {
          tags.push("离线演示回复");
        }

        setMessages((prev) => [
          ...prev,
          {
            id: `a-${repliedAtMs}`,
            role: "assistant",
            content: res.reply,
            sentences: res.sentences,
            time: new Date(repliedAtMs).toTimeString().slice(0, 5),
            createdAtMs: repliedAtMs,
            durationMs,
            tags,
          },
        ]);
        setNowTick(repliedAtMs);
        setPendingHabits(res.pending_habits || []);
        // 收到文字回复后立刻结束“思考中”状态，让语音在后台异步播放，不再阻塞发送下一条消息
        setSending(false);
        window.taiwanBotEnv?.sendPetPreviewState({
          emotion: res.emotion,
          bubble: res.reply,
        });

        if (autoSpeak && res.sentences.length > 0) {
          void playTaiwanSentences(res.sentences, {
            rate: voiceRate,
            signal: controller.signal,
            onStartSpeaking: () => setBotEmotion("speaking"),
            onFinishSpeaking: () => setBotEmotion(res.emotion || "happy"),
          }).catch(() => {});
        } else {
          setBotEmotion(res.emotion || "happy");
        }
      } catch (err) {
        setBotEmotion("encouraging");
        setStatusHint(
          err instanceof Error
            ? err.message
            : "连接后端失败，请确认 8765 端口已启动",
        );
      } finally {
        setSending(false);
      }
    },
    [autoSpeak, mode, sending, voiceRate],
  );

  /** 将语音识别结果写入输入框，方便用户确认或编辑后再发送 */
  const appendRecognizedText = useCallback((recognizedText: string) => {
    const cleaned = recognizedText.trim();
    if (!cleaned) return;

    setInput((prev) => {
      if (!prev) return cleaned;
      const needsSpace =
        /[A-Za-z0-9]$/.test(prev) && /^[A-Za-z0-9]/.test(cleaned);
      return needsSpace ? `${prev} ${cleaned}` : `${prev}${cleaned}`;
    });

    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    });
  }, []);

  /** 将录好的 16kHz WAV 上传到本地离线 ASR / Fish Audio 识别，并填入文本框 */
  const transcribeWavToInput = useCallback(
    async (wavBlob: Blob) => {
      setIsTranscribing(true);
      setStatusHint("正在识别语音并填入输入框...");
      try {
        const res = await api.transcribeAudioWav(wavBlob);
        if (res.text?.trim()) {
          setStatusHint(null);
          appendRecognizedText(res.text);
        } else {
          setStatusHint("没有听清楚捏，要不要再靠近麦克风说一次？");
        }
      } catch (err) {
        setStatusHint(
          err instanceof Error ? err.message : "语音识别失败",
        );
      } finally {
        setIsTranscribing(false);
        setBotEmotion(sendingRef.current ? "thinking" : "idle");
      }
    },
    [appendRecognizedText],
  );

  /** 启动一次录音（支持按需传入 push_to_talk 或 hands_free_vad） */
  const startVoiceCapture = useCallback(
    async (targetMode: VoiceInputMode) => {
      if (isTranscribing) return;
      audioAbortRef.current?.abort();
      setStatusHint(null);

      if (sttStatus?.ready) {
        try {
          if (!recorderRef.current) {
            recorderRef.current = new LocalWavRecorder();
          }
          setIsRecording(true);
          setActiveVoiceMode(targetMode);
          setBotEmotion("listening");
          await recorderRef.current.start({
            vadEnabled: targetMode === "hands_free_vad",
            onVolumeChange: (lvl) => setVolumeLevel(lvl),
            onVadAutoStop: (wavBlob) => {
              setIsRecording(false);
              setActiveVoiceMode(null);
              setVolumeLevel(0);
              void transcribeWavToInput(wavBlob);
            },
          });
        } catch {
          setIsRecording(false);
          setActiveVoiceMode(null);
          setBotEmotion(sendingRef.current ? "thinking" : "idle");
          setStatusHint("无法访问麦克风，请检查 Windows 麦克风权限。");
        }
        return;
      }

      if (isBrowserSpeechAvailable()) {
        setIsRecording(true);
        setActiveVoiceMode(targetMode);
        setBotEmotion("listening");
        setStatusHint("本地离线模型未安装，已自动使用浏览器语音识别（zh-TW）");
        stopBrowserSpeechRef.current = startBrowserSpeechOnce({
          onResult: (transcript) => {
            appendRecognizedText(transcript);
            setStatusHint(null);
          },
          onError: (msg) => setStatusHint(msg),
          onEnd: () => {
            setIsRecording(false);
            setActiveVoiceMode(null);
            setBotEmotion(sendingRef.current ? "thinking" : "idle");
          },
        });
        return;
      }

      setStatusHint(
        "本地离线语音模型尚未配置，请先在「设置与记忆」查看 sherpa-onnx 模型路径，或直接打字聊天喔～",
      );
    },
    [appendRecognizedText, isTranscribing, sttStatus?.ready, transcribeWavToInput],
  );

  /** 停止当前语音采集 */
  const stopVoiceCapture = useCallback(() => {
    if (stopBrowserSpeechRef.current) {
      stopBrowserSpeechRef.current();
      stopBrowserSpeechRef.current = null;
    }
    const wavBlob = recorderRef.current?.stop();
    setIsRecording(false);
    setActiveVoiceMode(null);
    setVolumeLevel(0);
    if (wavBlob) {
      void transcribeWavToInput(wavBlob);
    } else {
      setBotEmotion(sendingRef.current ? "thinking" : "idle");
    }
  }, [transcribeWavToInput]);

  const handleDictationToggle = () => {
    if (isRecording) {
      stopVoiceCapture();
    } else {
      void startVoiceCapture("push_to_talk");
    }
  };

  /** 进入一对一低延迟实时语音通话模式（先停掉普通录音与朗读，避免麦克风与扬声器冲突） */
  const handleOpenVoiceCall = useCallback(() => {
    audioAbortRef.current?.abort();
    setReplayingId(null);
    if (stopBrowserSpeechRef.current) {
      stopBrowserSpeechRef.current();
      stopBrowserSpeechRef.current = null;
    }
    recorderRef.current?.stop();
    setIsRecording(false);
    setActiveVoiceMode(null);
    setVolumeLevel(0);
    setStatusHint(null);
    setVoiceCallOpen(true);
    window.taiwanBotEnv?.notifyVoiceCallOwner?.("dashboard");
  }, []);

  const handleCloseVoiceCall = useCallback(() => {
    setVoiceCallOpen(false);
    window.taiwanBotEnv?.notifyVoiceCallOwner?.("none");
  }, []);

  // 每次通话会话生成唯一前缀，防止多次通话 turnId 重置产生重复 React key 与标签误覆盖
  const voiceCallSessionSaltRef = useRef<number>(Date.now());
  const prevVoiceCallOpenRef = useRef<boolean>(false);
  useEffect(() => {
    if (voiceCallOpen && !prevVoiceCallOpenRef.current) {
      voiceCallSessionSaltRef.current = Date.now();
    }
    prevVoiceCallOpenRef.current = voiceCallOpen;
  }, [voiceCallOpen]);

  /** 通话每结束一轮，即时同步到当前聊天消息流，挂断后无缝保留完整记录 */
  const handleVoiceTurnCommitted = useCallback((turn: CommittedVoiceTurn) => {
    const salt = voiceCallSessionSaltRef.current;
    const timeStr = new Date(turn.timestampMs).toTimeString().slice(0, 5);
    setMessages((prev) => [
      ...prev,
      {
        id: `vc-u-${salt}-${turn.turnId}-${turn.timestampMs}`,
        role: "user",
        content: turn.userText,
        time: timeStr,
        createdAtMs: turn.timestampMs,
      },
      {
        id: `vc-a-${salt}-${turn.turnId}`,
        role: "assistant",
        content: turn.assistantReply,
        sentences: splitSentencesForSpeech(turn.assistantReply),
        time: timeStr,
        createdAtMs: turn.timestampMs,
        durationMs: turn.durationMs,
      },
    ]);
    setNowTick(turn.timestampMs);
  }, []);

  /** 通话后台静默归档完成后，回填胶囊标签并刷新待核对习惯条 */
  const handleVoiceArchiveUpdate = useCallback(
    (payload: {
      turnId: number;
      tags: string[];
      pendingHabits: Array<{ id: number; title: string; category: string }>;
    }) => {
      const targetId = `vc-a-${voiceCallSessionSaltRef.current}-${payload.turnId}`;
      if (payload.tags.length > 0) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === targetId ? { ...m, tags: payload.tags } : m,
          ),
        );
      }
      if (payload.pendingHabits) {
        setPendingHabits(payload.pendingHabits);
      }
    },
    [],
  );

  // 订阅桌宠实时通话的互斥指令与跨窗口对话记录同步
  useEffect(() => {
    const env = window.taiwanBotEnv;
    if (!env) return;

    const unsubForceStop = env.onForceStopVoiceCall?.(() => {
      setVoiceCallOpen(false);
    });

    const unsubTurnSynced = env.onVoiceCallTurnSynced?.((payload) => {
      if (payload.userText && payload.assistantReply) {
        handleVoiceTurnCommitted({
          turnId: payload.turnId,
          userText: payload.userText,
          assistantReply: payload.assistantReply,
          durationMs: payload.durationMs,
          timestampMs: payload.timestampMs,
        });
      }
      if (payload.tags || payload.pendingHabits) {
        handleVoiceArchiveUpdate({
          turnId: payload.turnId,
          tags: payload.tags || [],
          pendingHabits: payload.pendingHabits || [],
        });
      }
    });

    return () => {
      unsubForceStop?.();
      unsubTurnSynced?.();
    };
  }, [handleVoiceArchiveUpdate, handleVoiceTurnCommitted]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    void handleSendMessage(input);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void handleSendMessage(input);
    }
  };

  const handleCopyMessage = async (msg: LocalChatBubble) => {
    let copied = false;
    try {
      await navigator.clipboard.writeText(msg.content);
      copied = true;
    } catch {
      try {
        const temp = document.createElement("textarea");
        temp.value = msg.content;
        temp.style.position = "fixed";
        temp.style.opacity = "0";
        document.body.appendChild(temp);
        temp.select();
        copied = document.execCommand("copy");
        document.body.removeChild(temp);
      } catch {
        // ignore clipboard errors
      }
    }
    if (copied) {
      setCopiedId(msg.id);
      window.setTimeout(() => {
        setCopiedId((prev) => (prev === msg.id ? null : prev));
      }, 1600);
    }
  };

  const handleReplayMessage = async (msg: LocalChatBubble) => {
    // 再次点击当前正在朗读的消息时直接停止播报
    if (replayingId === msg.id) {
      audioAbortRef.current?.abort();
      setReplayingId(null);
      setBotEmotion(sendingRef.current ? "thinking" : "idle");
      return;
    }

    audioAbortRef.current?.abort();
    const controller = new AbortController();
    audioAbortRef.current = controller;
    setReplayingId(msg.id);
    const sentences =
      msg.sentences && msg.sentences.length > 0
        ? msg.sentences
        : splitSentencesForSpeech(msg.content);
    try {
      await playTaiwanSentences(sentences, {
        rate: voiceRate,
        signal: controller.signal,
        onStartSpeaking: () => setBotEmotion("speaking"),
        onFinishSpeaking: () =>
          setBotEmotion(sendingRef.current ? "thinking" : "idle"),
      });
    } finally {
      setReplayingId((prev) => (prev === msg.id ? null : prev));
    }
  };

  const handleSelectSpeed = async (nextRate: string) => {
    setVoiceRate(nextRate);
    setSpeedMenuOpen(false);
    const nextTts = { ...ttsSettingsRef.current, rate: nextRate };
    ttsSettingsRef.current = nextTts;
    try {
      await api.updateSettings({ tts: nextTts });
    } catch {
      // 忽略静默持久化异常，本次会话已即时生效
    }
  };

  const currentSpeedObj =
    SPEED_OPTIONS.find((s) => s.value === voiceRate) ?? SPEED_OPTIONS[2];

  const currentModeObj =
    MODE_OPTIONS.find((m) => m.id === mode) ?? MODE_OPTIONS[0];

  return (
    <div className="relative h-full flex flex-col bg-[var(--bg-canvas)]">
      {/* 顶部 52px ChatGPT Desktop 极简浮动栏 */}
      <header className="h-[52px] px-4 flex items-center justify-between shrink-0 select-none">
        <div className="flex items-center gap-1.5">
          {!sidebarOpen && (
            <button
              type="button"
              onClick={onToggleSidebar}
              title="展开侧边栏 (Ctrl+\)"
              className="w-8 h-8 rounded-lg flex items-center justify-center text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
            >
              <IconSidebar className="w-[17px] h-[17px]" />
            </button>
          )}

          {/* 模式选择器（仿 ChatGPT Desktop 模型切换下拉按钮） */}
          <div className="relative" ref={modeMenuRef}>
            <button
              type="button"
              onClick={() => setModeMenuOpen((v) => !v)}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl hover:bg-[var(--bg-hover)] transition-colors cursor-pointer"
            >
              <span className="text-[15px] font-semibold tracking-tight text-[var(--text-primary)]">
                灵儿
              </span>
              <span className="text-[14px] font-normal text-[var(--text-tertiary)]">
                {currentModeObj.shortTitle}
              </span>
              <IconChevronDown
                className={`w-3.5 h-3.5 text-[var(--text-tertiary)] transition-transform duration-150 ${
                  modeMenuOpen ? "rotate-180" : ""
                }`}
              />
            </button>

            {modeMenuOpen && (
              <div
                className="absolute left-0 top-full mt-1.5 w-[280px] rounded-2xl bg-[var(--bg-elevated)] p-1.5 z-30 animate-popover"
                style={{ boxShadow: "var(--popover-shadow)" }}
              >
                {MODE_OPTIONS.map((opt) => {
                  const selected = opt.id === mode;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => {
                        setMode(opt.id);
                        setModeMenuOpen(false);
                      }}
                      className={`w-full text-left px-3 py-2.5 rounded-xl flex items-start justify-between gap-3 transition-colors cursor-pointer ${
                        selected
                          ? "bg-[var(--bg-active)]"
                          : "hover:bg-[var(--bg-hover)]"
                      }`}
                    >
                      <div className="space-y-0.5">
                        <div className="text-[13.5px] font-medium text-[var(--text-primary)]">
                          {opt.title}
                        </div>
                        <div className="text-[11.5px] leading-snug text-[var(--text-tertiary)]">
                          {opt.desc}
                        </div>
                      </div>
                      {selected && (
                        <span className="mt-0.5 text-[var(--text-primary)] shrink-0">
                          <IconCheck className="w-4 h-4" />
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* 右侧极简控制：实时语音通话入口 + 语音朗读开关 + 内联语速调节胶囊 */}
        <div className="flex items-center gap-2">
          <Tooltip label="像打电话一样与灵儿实时语音沟通" side="bottom">
            <button
              type="button"
              onClick={handleOpenVoiceCall}
              className="h-8 px-3 rounded-xl bg-[#2563EB] hover:bg-[#1D4ED8] text-white flex items-center gap-1.5 text-[12px] font-medium shadow-[0_2px_8px_rgba(37,99,235,0.24)] transition-all active:scale-95 cursor-pointer"
            >
              <IconPhone className="w-3.5 h-3.5" />
              <span>实时通话</span>
            </button>
          </Tooltip>

          <div className="inline-flex items-center rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-0.5">
            <Tooltip
              label={autoSpeak ? "点击关闭自动朗读" : "点击开启自动朗读"}
              side="bottom"
            >
              <button
                type="button"
                onClick={() => {
                  if (autoSpeak) audioAbortRef.current?.abort();
                  setAutoSpeak((v) => !v);
                }}
                className={`h-7 px-2.5 rounded-[9px] flex items-center gap-1.5 text-[12px] font-medium transition-colors cursor-pointer ${
                  autoSpeak
                    ? "text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                    : "text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]"
                }`}
              >
                {autoSpeak ? (
                  <IconVolumeOn className="w-4 h-4" />
                ) : (
                  <IconVolumeOff className="w-4 h-4" />
                )}
                <span className="hidden sm:inline">
                  {autoSpeak ? "朗读已开" : "已静音"}
                </span>
              </button>
            </Tooltip>

            <span className="w-px h-4 bg-[var(--border-subtle)] mx-0.5" />

            {/* 语速下拉选择器 */}
            <div className="relative" ref={speedMenuRef}>
              <Tooltip
                label={`当前语速 ${currentSpeedObj.label} · 点击调节`}
                side="bottom"
                disabled={speedMenuOpen}
              >
                <button
                  type="button"
                  onClick={() => setSpeedMenuOpen((v) => !v)}
                  className="h-7 px-2 rounded-[9px] flex items-center gap-1 text-[12px] font-medium tabular-nums text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer"
                >
                  <span>{currentSpeedObj.label}</span>
                  <IconChevronDown
                    className={`w-3 h-3 text-[var(--text-tertiary)] transition-transform duration-150 ${
                      speedMenuOpen ? "rotate-180" : ""
                    }`}
                  />
                </button>
              </Tooltip>

              {speedMenuOpen && (
                <div
                  className="absolute right-0 top-full mt-2 w-[164px] rounded-2xl bg-[var(--bg-elevated)] p-1.5 z-30 animate-popover"
                  style={{ boxShadow: "var(--popover-shadow)" }}
                >
                  <div className="px-2.5 py-1 text-[11px] font-medium text-[var(--text-tertiary)]">
                    朗读语速
                  </div>
                  {SPEED_OPTIONS.map((opt) => {
                    const selected = opt.value === voiceRate;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => void handleSelectSpeed(opt.value)}
                        className={`w-full px-2.5 py-1.5 rounded-xl flex items-center justify-between text-[12.5px] transition-colors cursor-pointer ${
                          selected
                            ? "bg-[var(--bg-active)] text-[var(--text-primary)] font-medium"
                            : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                        }`}
                      >
                        <span className="flex items-center gap-2">
                          <span className="tabular-nums font-medium">
                            {opt.label}
                          </span>
                          <span className="text-[11px] text-[var(--text-tertiary)]">
                            {opt.desc}
                          </span>
                        </span>
                        {selected && <IconCheck className="w-3.5 h-3.5" />}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* 居中编辑感消息流区域 */}
      <div className="flex-1 overflow-y-auto px-4 sm:px-6">
        <div className="max-w-[740px] mx-auto h-full flex flex-col">
          {messages.length === 0 ? (
            /* ChatGPT Desktop 标志性居中欢迎空态 */
            <div className="flex-1 flex flex-col items-center justify-center py-10 text-center animate-fade-up">
              <div className="w-16 h-16 rounded-full bg-[#FFF7E6] dark:bg-amber-500/12 border border-[var(--border-subtle)] flex items-center justify-center mb-5 shadow-xs">
                <AvatarRenderer emotion={botEmotion} size={56} />
              </div>

              <h2 className="text-[24px] sm:text-[26px] font-semibold tracking-tight text-[var(--text-primary)]">
                欸～今天过得怎么样呀？
              </h2>
              <p className="text-[13.5px] text-[var(--text-tertiary)] mt-2 max-w-md leading-relaxed">
                直接开口说或打字分享。白天随聊会静默记录习惯与心情，晚上可切换「晚间复盘」一起逐项核对。
              </p>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 w-full max-w-[660px] mt-8">
                {QUICK_PROMPTS.map((item) => (
                  <button
                    key={item.title}
                    type="button"
                    onClick={() => void handleSendMessage(item.prompt)}
                    className="group text-left p-3.5 rounded-2xl bg-[var(--bg-surface)] hover:bg-[var(--bg-hover)] border border-[var(--border-subtle)] hover:border-[var(--border-strong)] transition-all cursor-pointer space-y-1"
                  >
                    <div className="text-[12px] font-medium text-[var(--text-tertiary)] group-hover:text-[var(--text-secondary)]">
                      {item.title}
                    </div>
                    <div className="text-[13px] text-[var(--text-primary)] leading-snug line-clamp-2">
                      {item.prompt}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="py-6 space-y-6">
              {messages.map((msg) => {
                const isUser = msg.role === "user";

                if (isUser) {
                  return (
                    <div
                      key={msg.id}
                      className="flex flex-col items-end gap-1 animate-fade-up"
                    >
                      <div className="max-w-[78%] px-4 py-2.5 rounded-[22px] bg-[var(--user-bubble-bg)] text-[var(--user-bubble-fg)] text-[14.5px] leading-[1.65]">
                        <p className="whitespace-pre-wrap break-words">
                          {msg.content}
                        </p>
                      </div>
                      <div className="flex items-center gap-1 pr-1 text-[var(--text-tertiary)]">
                        <Tooltip
                          label={copiedId === msg.id ? "已复制" : "复制消息"}
                          side="top"
                        >
                          <button
                            type="button"
                            onClick={() => void handleCopyMessage(msg)}
                            className="h-6 px-1.5 rounded-lg flex items-center gap-1 text-[11.5px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer"
                          >
                            {copiedId === msg.id ? (
                              <IconCheck className="w-3.5 h-3.5 text-emerald-500" />
                            ) : (
                              <IconCopy className="w-3.5 h-3.5" />
                            )}
                          </button>
                        </Tooltip>
                        <span className="text-[11px] tabular-nums">
                          {msg.time}
                        </span>
                      </div>
                    </div>
                  );
                }

                const relativeTime = formatRelativeTime(
                  msg.createdAtMs,
                  nowTick,
                );
                const durationLabel =
                  msg.durationMs !== undefined
                    ? formatDuration(msg.durationMs)
                    : null;

                return (
                  <div
                    key={msg.id}
                    className="flex items-start gap-3.5 animate-fade-up"
                  >
                    <div className="w-7 h-7 rounded-full bg-[#FFF7E6] dark:bg-amber-500/15 border border-[var(--border-subtle)] flex items-center justify-center shrink-0 mt-0.5 overflow-hidden">
                      <AvatarRenderer emotion="happy" size={26} />
                    </div>

                    <div className="flex-1 min-w-0 space-y-2">
                      <div className="text-[15px] leading-[1.72] text-[var(--text-primary)] whitespace-pre-wrap break-words">
                        {msg.content}
                      </div>

                      {/* 静默归档微标签 */}
                      {msg.tags && msg.tags.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                          {msg.tags.map((tag) => (
                            <span
                              key={tag}
                              className="inline-flex items-center gap-1 text-[11px] px-2.5 py-0.5 rounded-full border border-emerald-500/25 bg-emerald-500/8 text-emerald-700 dark:text-emerald-400 font-medium"
                            >
                              <IconCheck className="w-3 h-3" />
                              {tag}
                            </span>
                          ))}
                        </div>
                      )}

                      {/* 常驻极简操作栏（复制 / 重播朗读 / 回复时间与耗时） */}
                      <div className="flex items-center gap-1 pt-0.5 text-[var(--text-tertiary)]">
                        <Tooltip
                          label={copiedId === msg.id ? "已复制" : "复制回复"}
                          side="top"
                        >
                          <button
                            type="button"
                            onClick={() => void handleCopyMessage(msg)}
                            className="h-7 px-1.5 rounded-lg flex items-center gap-1 text-[11.5px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer"
                          >
                            {copiedId === msg.id ? (
                              <IconCheck className="w-3.5 h-3.5 text-emerald-500" />
                            ) : (
                              <IconCopy className="w-3.5 h-3.5" />
                            )}
                          </button>
                        </Tooltip>
                        <Tooltip
                          label={replayingId === msg.id ? "停止朗读" : "重新朗读"}
                          side="top"
                        >
                          <button
                            type="button"
                            onClick={() => void handleReplayMessage(msg)}
                            className={`h-7 px-1.5 rounded-lg flex items-center gap-1 text-[11.5px] transition-colors cursor-pointer ${
                              replayingId === msg.id
                                ? "text-[var(--text-primary)] bg-[var(--bg-hover)]"
                                : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                            }`}
                          >
                            <IconVolumeOn className="w-3.5 h-3.5" />
                          </button>
                        </Tooltip>
                        <Tooltip
                          label={
                            durationLabel
                              ? `回复于 ${msg.time} · 回复总耗时 ${durationLabel}`
                              : `回复于 ${msg.time}`
                          }
                          side="top"
                        >
                          <span className="text-[11.5px] text-[var(--text-tertiary)] ml-1 tabular-nums select-none">
                            {relativeTime} · {msg.time}
                            {durationLabel ? ` · 总耗时 ${durationLabel}` : ""}
                          </span>
                        </Tooltip>
                      </div>
                    </div>
                  </div>
                );
              })}

              {sending && (
                <div className="flex items-start gap-3.5 animate-fade-up">
                  <div className="w-7 h-7 rounded-full bg-[#FFF7E6] dark:bg-amber-500/15 border border-[var(--border-subtle)] flex items-center justify-center shrink-0 mt-0.5 overflow-hidden">
                    <AvatarRenderer emotion="thinking" size={26} />
                  </div>
                  <div className="flex items-center gap-2 py-1.5 text-[13.5px] text-[var(--text-tertiary)]">
                    <span className="inline-flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-[var(--text-secondary)] animate-thinking-dot-1" />
                      <span className="w-1.5 h-1.5 rounded-full bg-[var(--text-secondary)] animate-thinking-dot-2" />
                      <span className="w-1.5 h-1.5 rounded-full bg-[var(--text-secondary)] animate-thinking-dot-3" />
                    </span>
                    <span className="tabular-nums">
                      灵儿正在思考...{" "}
                      {thinkingElapsedMs >= 100
                        ? formatDuration(thinkingElapsedMs)
                        : ""}
                    </span>
                  </div>
                </div>
              )}
              <div ref={listEndRef} className="h-4" />
            </div>
          )}
        </div>
      </div>

      {/* 底部标志性 ChatGPT Desktop 悬浮输入胶囊 */}
      <footer className="px-4 sm:px-6 pb-4 pt-2 shrink-0">
        <div className="max-w-[740px] mx-auto space-y-2">
          {/* 待核对习惯轻提示胶囊条 */}
          {pendingHabits.length > 0 && (
            <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar pb-0.5">
              <span className="text-[11px] text-[var(--text-tertiary)] shrink-0 mr-0.5">
                待核对
              </span>
              {pendingHabits.map((h) => (
                <button
                  key={h.id}
                  type="button"
                  onClick={() => {
                    setInput(`我今天「${h.title}」已经完成啰！`);
                    textareaRef.current?.focus();
                  }}
                  className="px-2.5 py-1 rounded-full bg-[var(--bg-subtle)] hover:bg-[var(--bg-active)] border border-[var(--border-subtle)] text-[11.5px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors shrink-0 cursor-pointer"
                >
                  {h.title}
                </button>
              ))}
            </div>
          )}

          {/* 状态 / 识别提示条 */}
          {statusHint && (
            <div className="px-3 py-1.5 rounded-xl bg-amber-500/10 border border-amber-500/20 text-[12px] text-amber-700 dark:text-amber-300 flex items-center justify-between gap-2">
              <span>{statusHint}</span>
              <button
                type="button"
                onClick={() => setStatusHint(null)}
                className="text-[11px] opacity-70 hover:opacity-100 cursor-pointer"
              >
                关闭
              </button>
            </div>
          )}

          {/* 核心圆角悬浮胶囊容器 */}
          <form
            onSubmit={handleSubmit}
            className="rounded-[26px] bg-[var(--bg-surface)] px-4 pt-3 pb-2.5 transition-shadow duration-150 focus-within:[box-shadow:var(--composer-shadow-focus)]"
            style={{ boxShadow: "var(--composer-shadow)" }}
          >
            <textarea
              ref={textareaRef}
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="跟灵儿说说今天发生的事，或汇报习惯进度..."
              className="w-full resize-none bg-transparent text-[14.5px] leading-relaxed text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none max-h-40 px-1"
            />

            <div className="flex items-center justify-between gap-2 pt-2 mt-1">
              {/* 左侧：极简语音引擎状态点 */}
              <div className="flex items-center gap-1.5 px-1 min-w-0">
                <span
                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                    sttStatus?.ready ? "bg-emerald-500" : "bg-amber-500"
                  }`}
                />
                <span className="text-[11px] text-[var(--text-tertiary)] truncate">
                  {sttStatus?.ready
                    ? sttStatus.engine === "faster-whisper"
                      ? "Faster-Whisper 本地识别就绪"
                      : sttStatus.engine === "fish-audio"
                        ? "Fish Audio 语音识别就绪"
                        : "离线语音识别就绪"
                    : "浏览器语音识别"}
                </span>
              </div>

              {/* 右侧：ChatGPT 经典双键（麦克风听写 + 蓝色圆球实时声波 / 有文字时自动变为发送键） */}
              <div className="flex items-center gap-1.5 shrink-0">
                <Tooltip
                  label={
                    isTranscribing
                      ? "正在识别语音..."
                      : isRecording && activeVoiceMode === "push_to_talk"
                        ? "停止录音并填入输入框"
                        : "语音听写（识别后填入输入框）"
                  }
                  side="top"
                >
                  <button
                    type="button"
                    onClick={handleDictationToggle}
                    disabled={
                      isTranscribing ||
                      (isRecording && activeVoiceMode === "hands_free_vad")
                    }
                    className={`h-9 rounded-full flex items-center justify-center gap-1.5 transition-all cursor-pointer disabled:opacity-35 ${
                      isRecording && activeVoiceMode === "push_to_talk"
                        ? "px-3 bg-rose-500 text-white shadow-sm"
                        : "w-9 text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                    }`}
                  >
                    {isRecording && activeVoiceMode === "push_to_talk" ? (
                      <>
                        <span className="flex items-center gap-[2px] h-3">
                          {[0.65, 1, 0.75].map((mult, idx) => (
                            <span
                              key={idx}
                              className="w-[2.5px] rounded-full bg-white transition-all duration-75"
                              style={{
                                height: `${Math.max(4, Math.min(13, 4 + volumeLevel * 14 * mult))}px`,
                              }}
                            />
                          ))}
                        </span>
                        <IconStop className="w-3 h-3" />
                      </>
                    ) : (
                      <IconMic className="w-[18px] h-[18px]" />
                    )}
                  </button>
                </Tooltip>

                {input.trim().length > 0 ? (
                  <Tooltip
                    label={
                      sending
                        ? "灵儿正在思考，稍候可发送"
                        : "发送消息 (Enter)"
                    }
                    side="top"
                  >
                    <button
                      type="submit"
                      disabled={sending}
                      className="w-9 h-9 rounded-full bg-[var(--ink-primary)] hover:bg-[var(--ink-primary-hover)] disabled:opacity-30 text-[var(--ink-primary-fg)] flex items-center justify-center transition-all active:scale-95 cursor-pointer"
                    >
                      <IconArrowUp className="w-4 h-4" />
                    </button>
                  </Tooltip>
                ) : (
                  <Tooltip
                    label="开启实时语音通话（像打电话一样连续聊天、可随时插话）"
                    side="top"
                  >
                    <button
                      type="button"
                      onClick={handleOpenVoiceCall}
                      disabled={isTranscribing}
                      className="w-9 h-9 rounded-full bg-[#2563EB] hover:bg-[#1D4ED8] text-white shadow-[0_2px_10px_rgba(37,99,235,0.28)] flex items-center justify-center transition-all active:scale-95 cursor-pointer disabled:opacity-35"
                    >
                      <span className="flex items-center gap-[2.5px]">
                        <span className="w-[2.4px] h-[7px] rounded-full bg-white" />
                        <span className="w-[2.4px] h-[14px] rounded-full bg-white" />
                        <span className="w-[2.4px] h-[10px] rounded-full bg-white" />
                        <span className="w-[2.4px] h-[6px] rounded-full bg-white" />
                      </span>
                    </button>
                  </Tooltip>
                )}
              </div>
            </div>
          </form>

          <p className="text-center text-[11px] text-[var(--text-tertiary)] select-none">
            Enter 发送 · Shift + Enter 换行 · 点击蓝色声波键即可与灵儿实时语音通话
          </p>
        </div>
      </footer>

      {/* 一对一低延迟实时语音通话沉浸层 */}
      {voiceCallOpen && (
        <VoiceCallOverlay
          mode={mode}
          voiceRate={voiceRate}
          onModeChange={(nextMode) => setMode(nextMode)}
          onTurnCommitted={handleVoiceTurnCommitted}
          onArchiveUpdate={handleVoiceArchiveUpdate}
          onClose={handleCloseVoiceCall}
        />
      )}
    </div>
  );
}
