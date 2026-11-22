/**
 * 桌宠快捷对话与流式分句语音播报客户端（对齐 Step 3 后端接口）
 * ------------------------------------------------------------
 * 1. 对接 POST /api/chat（使用 mode 参数，解析 reply / sentences / emotion）。
 * 2. 支持播报前播放 0.3s 本地台湾腔反应垫词，消除等待冷场感。
 * 3. 支持按句串行请求 POST /api/voice/tts 并随时打断（AbortSignal）。
 */

import type { PetEmotion } from "../types/pet";
import { buildAuthHeaders, getBackendBaseUrl } from "./api/client";

export { getBackendBaseUrl };

export type ChatMode =
  | "normal"
  | "evening_review"
  | "morning_plan"
  | "noon_checkin"
  | "bedtime_nudge"
  | "random_bubble";

export interface ToolActionEvent {
  tool: string;
  ok: boolean;
  badge?: string | null;
  error?: string | null;
}

export interface ChatResponseData {
  archive_failed?:boolean;
  source_id?:number;
  date: string;
  reply: string;
  sentences: string[];
  emotion: PetEmotion;
  duration_ms?: number | null;
  used_offline_fallback: boolean;
  tool_actions?: ToolActionEvent[];
  extracted: {
    summary_updated?:boolean;
    habit_updates?: Array<{
      habit_id: number;
      title: string;
      status: string;
      note: string;
    }>;
    mood_score?: number | null;
    energy_score?: number | null;
    new_highlights?: string[];
    new_memories?: Array<{ memory_type: string; content: string }>;
  };
  pending_habits: Array<{ id: number; title: string; category: string }>;
  md_path: string;
}

export interface ChatStreamHandlers {
  threadId?:string;
  signal?: AbortSignal;
  onSentence?: (sentence: string, index: number) => void;
  onToolAction?: (action: ToolActionEvent) => void;
  onReply?: (reply: {
    reply: string;
    sentences: string[];
    emotion: PetEmotion;
    duration_ms?: number | null;
    used_offline_fallback: boolean;
    tool_actions?: ToolActionEvent[];
  }) => void;
}

/** 文字对话走 SSE：第一句出来就回调，归档结束才 resolve。 */
export async function sendQuickChat(
  message: string,
  mode: ChatMode = "normal",
  triggerType: "manual" | "schedule" | "random" | "wakeword" = "manual",
  handlers?: ChatStreamHandlers,
): Promise<ChatResponseData> {
  const timeout = new AbortController();
  const timer = window.setTimeout(() => timeout.abort(), 90_000);
  const onAbort = () => timeout.abort();
  handlers?.signal?.addEventListener("abort", onAbort);
  try {
    const headers = await buildAuthHeaders({
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    });
    const res = await fetch(`${getBackendBaseUrl()}/api/chat/stream`, {
      method: "POST",
      headers,
      body: JSON.stringify({ message, mode, trigger_type: triggerType, thread_id:handlers?.threadId }),
      signal: timeout.signal,
    });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const body = await res.json();
        if (body?.detail) detail = String(body.detail);
      } catch {
        // 非 JSON 错误体忽略
      }
      throw new Error(detail);
    }
    if (!res.body) {
      throw new Error("对话流没有返回内容");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let donePayload: ChatResponseData | null = null;

    const handleBlock = (block: string) => {
      let event = "message";
      const dataLines: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length === 0) return;
      const data = JSON.parse(dataLines.join("\n")) as Record<string, unknown>;
      if (event === "sentence" && typeof data.text === "string") {
        handlers?.onSentence?.(data.text, Number(data.index ?? 0));
      } else if (event === "tool_action") {
        handlers?.onToolAction?.({
          tool: String(data.tool ?? ""),
          ok: Boolean(data.ok),
          badge: typeof data.badge === "string" ? data.badge : null,
          error: typeof data.error === "string" ? data.error : null,
        });
      } else if (event === "reply") {
        handlers?.onReply?.({
          reply: String(data.reply ?? ""),
          sentences: Array.isArray(data.sentences) ? data.sentences.map(String) : [],
          emotion: (data.emotion as PetEmotion) || "happy",
          duration_ms: typeof data.duration_ms === "number" ? data.duration_ms : null,
          used_offline_fallback: Boolean(data.used_offline_fallback),
          tool_actions: Array.isArray(data.tool_actions)
            ? (data.tool_actions as ToolActionEvent[])
            : undefined,
        });
      } else if (event === "error") {
        throw new Error(String(data.detail || "对话中断了"));
      } else if (event === "done") {
        donePayload = data as unknown as ChatResponseData;
      }
    };

    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        if (block.trim()) handleBlock(block);
      }
    }
    if (buffer.trim()) handleBlock(buffer);
    if (!donePayload) {
      throw new Error("对话还没说完就断开了");
    }
    return donePayload;
  } finally {
    window.clearTimeout(timer);
    handlers?.signal?.removeEventListener("abort", onAbort);
  }
}

/** 边收句子边念。第一句到达就开始合成，不用等整段回复。 */
export function createSentencePlayer(options: {
  muted?: boolean;
  rate?: string;
  signal?: AbortSignal;
  onStartSpeaking?: () => void;
  onFinishSpeaking?: () => void;
}): {
  push: (sentence: string) => void;
  close: () => Promise<void>;
} {
  const queue: string[] = [];
  const waiters: Array<() => void> = [];
  let closed = false;
  let started = false;

  const wake = () => {
    const pending = waiters.splice(0);
    pending.forEach((resolve) => resolve());
  };

  const takeBatch = async (): Promise<string[] | null> => {
    while (queue.length === 0 && !closed) {
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        if (queue.length > 0 || closed) {
          const index = waiters.indexOf(resolve);
          if (index >= 0) waiters.splice(index, 1);
          resolve();
        }
      });
    }
    if (queue.length === 0) return null;
    return queue.splice(0, queue.length);
  };

  const finished = (async () => {
    try {
      while (!options.signal?.aborted) {
        const batch = await takeBatch();
        if (!batch || batch.length === 0) break;
        if (!started) {
          started = true;
          options.onStartSpeaking?.();
        }
        await playTaiwanSentences(batch, {
          muted: options.muted,
          rate: options.rate,
          signal: options.signal,
        });
      }
    } finally {
      options.onFinishSpeaking?.();
    }
  })();

  return {
    push(sentence: string) {
      const text = sentence.trim();
      if (!text || options.signal?.aborted) return;
      queue.push(text);
      wake();
    },
    close() {
      closed = true;
      wake();
      return finished;
    },
  };
}

/** 播放 0.3 秒本地缓存的台湾腔反应垫词（例如「嗯嗯～」），让等待 LLM 回复时也有活人感 */
export async function playFillerSound(
  fillerId = "uhhuh",
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return;
  try {
    const headers = await buildAuthHeaders();
    const res = await fetch(`${getBackendBaseUrl()}/api/voice/fillers/${fillerId}`, {
      headers,
      signal,
    });
    if (!res.ok) return;
    const blobUrl = URL.createObjectURL(await res.blob());
    await new Promise<void>((resolve) => {
      const audio = new Audio(blobUrl);
      let settled = false;
      const onAbort = () => {
        audio.pause();
        cleanup();
      };
      const cleanup = () => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        audio.onended = null;
        audio.onerror = null;
        URL.revokeObjectURL(blobUrl);
        resolve();
      };
      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
      }
      audio.onended = cleanup;
      audio.onerror = cleanup;
      void audio.play().catch(cleanup);
    });
  } catch {
    // 垫词播放失败不阻塞主对话流程
  }
}

/** 按中英文句末标点切分为短句（与后端 split_sentences_for_streaming 规则一致，确保命中本地 TTS 缓存并降低首字延迟） */
export function splitSentencesForSpeech(text: string): string[] {
  const cleaned = text.trim();
  if (!cleaned) return [];

  const rawParts = cleaned
    .split(/(?<=[。！？!?～~…\n])\s*/u)
    .map((part) => part.trim())
    .filter(Boolean);

  const merged: string[] = [];
  for (const part of rawParts) {
    if (/^[。！？!?～~…、，,\s]+$/u.test(part)) {
      continue;
    }
    if (merged.length > 0 && merged[merged.length - 1].length < 6) {
      merged[merged.length - 1] = `${merged[merged.length - 1]}${part}`;
    } else {
      merged.push(part);
    }
  }
  return merged.length > 0 ? merged : [cleaned];
}

/** 将后端返回的分句列表预取合成并无缝顺序播放（播第 1 句的同时后台预取下一句，消除句间卡顿） */
export async function playTaiwanSentences(
  sentences: string[],
  options?: {
    muted?: boolean;
    provider?: string;
    voice?: string;
    rate?: string;
    pitch?: string;
    fish_api_key?: string;
    fish_reference_id?: string;
    fish_model?: string;
    throwOnError?: boolean;
    signal?: AbortSignal;
    onStartSpeaking?: () => void;
    onFinishSpeaking?: () => void;
  },
): Promise<void> {
  const validSentences = sentences.map((s) => s.trim()).filter(Boolean);
  if (options?.muted || validSentences.length === 0) {
    return;
  }

  const baseUrl = getBackendBaseUrl();
  options?.onStartSpeaking?.();

  const fetchSentenceAudio = async (text: string): Promise<Blob | null> => {
    if (options?.signal?.aborted) return null;

    const res = await fetch(`${baseUrl}/api/voice/tts`, {
      method: "POST",
      headers: await buildAuthHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        text,
        provider: options?.provider,
        voice: options?.voice,
        rate: options?.rate,
        pitch: options?.pitch,
        fish_api_key: options?.fish_api_key,
        fish_reference_id: options?.fish_reference_id,
        fish_model: options?.fish_model,
      }),
      signal: options?.signal,
    });

    if (!res.ok) {
      if (options?.throwOnError) {
        let detail = `HTTP ${res.status}`;
        try {
          const err = await res.json();
          if (err?.detail) detail = String(err.detail);
        } catch {
          // ignore
        }
        throw new Error(detail);
      }
      return null;
    }

    const actualProvider = res.headers.get("X-TTS-Provider");
    if (
      options?.throwOnError &&
      options?.provider === "fish_audio" &&
      actualProvider !== "fish_audio"
    ) {
      throw new Error(
        "当前 8765 端口运行的是旧版后端（仍在用 Edge-TTS），请关闭旧窗口后重新双击 start_linger.bat",
      );
    }

    return await res.blob();
  };

  // 滑动预取窗口：始终提前并发拉取下一句音频（最多同时 2 路），兼顾零停顿与限流友好
  const prefetched = new Map<number, Promise<Blob | null>>();
  const ensurePrefetch = (idx: number) => {
    if (idx >= validSentences.length || prefetched.has(idx)) return;
    if (options?.signal?.aborted) return;
    const p = fetchSentenceAudio(validSentences[idx]).catch((err) => {
      if (options?.throwOnError && !options?.signal?.aborted) {
        throw err;
      }
      return null;
    });
    // 防止中途 abort 或跳过时出现未捕获 Rejection
    p.catch(() => {});
    prefetched.set(idx, p);
  };

  try {
    ensurePrefetch(0);
    ensurePrefetch(1);

    for (let i = 0; i < validSentences.length; i++) {
      if (options?.signal?.aborted) break;

      const blob = await prefetched.get(i);
      prefetched.delete(i);
      if (options?.signal?.aborted) break;

      // 当前句音频一就绪，立即启动后续句子的后台预合成
      ensurePrefetch(i + 1);
      ensurePrefetch(i + 2);

      if (!blob) continue;

      const audioUrl = URL.createObjectURL(blob);
      await new Promise<void>((resolve) => {
        const audio = new Audio(audioUrl);
        let settled = false;
        const onAbort = () => {
          audio.pause();
          cleanup();
        };
        const cleanup = () => {
          if (settled) return;
          settled = true;
          options?.signal?.removeEventListener("abort", onAbort);
          audio.onended = null;
          audio.onerror = null;
          URL.revokeObjectURL(audioUrl);
          resolve();
        };

        if (options?.signal) {
          options.signal.addEventListener("abort", onAbort, { once: true });
        }

        audio.onended = cleanup;
        audio.onerror = cleanup;
        void audio.play().catch(cleanup);
      });
    }
  } finally {
    options?.onFinishSpeaking?.();
  }
}
