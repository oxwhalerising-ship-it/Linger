/**
 * 桌宠快捷对话与流式分句语音播报客户端（对齐 Step 3 后端接口）
 * ------------------------------------------------------------
 * 1. 对接 POST /api/chat（使用 mode 参数，解析 reply / sentences / emotion）。
 * 2. 支持播报前播放 0.3s 本地台湾腔反应垫词，消除等待冷场感。
 * 3. 支持按句串行请求 POST /api/voice/tts 并随时打断（AbortSignal）。
 */

import type { PetEmotion } from "../types/pet";

export type ChatMode =
  | "normal"
  | "evening_review"
  | "morning_plan"
  | "noon_checkin"
  | "bedtime_nudge"
  | "random_bubble";

export interface ChatResponseData {
  date: string;
  reply: string;
  sentences: string[];
  emotion: PetEmotion;
  duration_ms?: number | null;
  used_offline_fallback: boolean;
  extracted: {
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

/** 获取后端基础地址 */
export function getBackendBaseUrl(): string {
  return window.taiwanBotEnv?.backendBaseUrl ?? "http://127.0.0.1:8765";
}

/** 发送一轮对话给台湾腔小管家 */
export async function sendQuickChat(
  message: string,
  mode: ChatMode = "normal",
  triggerType: "manual" | "schedule" | "random" | "wakeword" = "manual",
): Promise<ChatResponseData> {
  const response = await fetch(`${getBackendBaseUrl()}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, mode, trigger_type: triggerType }),
  });

  if (!response.ok) {
    throw new Error(`对话接口请求失败（HTTP ${response.status}）`);
  }

  return (await response.json()) as ChatResponseData;
}

/** 播放 0.3 秒本地缓存的台湾腔反应垫词（例如「嗯嗯～」），让等待 LLM 回复时也有活人感 */
export async function playFillerSound(
  fillerId = "uhhuh",
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return;
  try {
    const url = `${getBackendBaseUrl()}/api/voice/fillers/${fillerId}`;
    await new Promise<void>((resolve) => {
      const audio = new Audio(url);
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
      headers: { "Content-Type": "application/json" },
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
        "当前 8765 端口运行的是旧版后端（仍在用 Edge-TTS），请关闭旧窗口后重新双击 start_taiwanbot.bat",
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
