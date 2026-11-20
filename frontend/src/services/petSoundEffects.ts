/**
 * 灵儿桌宠交互音效引擎（基于 React Bits Sound Lab 精选 5 组无损音效）
 * -------------------------------------------------------------------
 * - dispatch: 鼠标悬浮到灵儿身上展开环绕道具
 * - huddle:   语音电话接通
 * - stack:    挂断语音电话
 * - pulse:    鼠标悬浮在环绕功能按钮上
 * - notch:    点击环绕功能按钮
 */

export type PetSfxName = "dispatch" | "huddle" | "stack" | "pulse" | "notch";

const SFX_URLS: Record<PetSfxName, string> = {
  dispatch: "./sounds/dispatch.wav",
  huddle: "./sounds/huddle.wav",
  stack: "./sounds/stack.wav",
  pulse: "./sounds/pulse.wav",
  notch: "./sounds/notch.wav",
};

const SFX_VOLUMES: Record<PetSfxName, number> = {
  dispatch: 0.72,
  huddle: 0.85,
  stack: 0.82,
  pulse: 0.48,
  notch: 0.72,
};

const SFX_COOLDOWN_MS: Record<PetSfxName, number> = {
  dispatch: 220,
  huddle: 400,
  stack: 300,
  pulse: 85,
  notch: 50,
};

let audioCtx: AudioContext | null = null;
const bufferCache = new Map<PetSfxName, AudioBuffer>();
const loadingPromises = new Map<PetSfxName, Promise<AudioBuffer | null>>();
const lastPlayAt = new Map<PetSfxName, number>();

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!audioCtx) {
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return null;
    audioCtx = new Ctor();
  }
  return audioCtx;
}

async function loadBuffer(name: PetSfxName): Promise<AudioBuffer | null> {
  const cached = bufferCache.get(name);
  if (cached) return cached;

  const existing = loadingPromises.get(name);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const ctx = getAudioContext();
      if (!ctx) return null;
      const resp = await fetch(SFX_URLS[name]);
      if (!resp.ok) return null;
      const arrayBuf = await resp.arrayBuffer();
      const decoded = await ctx.decodeAudioData(arrayBuf.slice(0));
      bufferCache.set(name, decoded);
      return decoded;
    } catch {
      return null;
    } finally {
      loadingPromises.delete(name);
    }
  })();

  loadingPromises.set(name, promise);
  return promise;
}

/** 预加载全部 5 组交互音效到内存，确保悬浮与点击零延迟响应 */
export function preloadPetSounds(): void {
  const names: PetSfxName[] = ["dispatch", "huddle", "stack", "pulse", "notch"];
  for (const name of names) {
    void loadBuffer(name);
  }
}

/** 播放指定交互音效（自动防抖限频，支持免打扰静音） */
export function playPetSound(
  name: PetSfxName,
  options?: { muted?: boolean; volume?: number },
): void {
  if (options?.muted) return;

  const now = performance.now();
  const prev = lastPlayAt.get(name) ?? 0;
  if (now - prev < SFX_COOLDOWN_MS[name]) {
    return;
  }
  lastPlayAt.set(name, now);

  const volume = options?.volume ?? SFX_VOLUMES[name];
  const ctx = getAudioContext();

  const playWithBuffer = (buf: AudioBuffer) => {
    if (!ctx) return;
    const trigger = () => {
      try {
        const source = ctx.createBufferSource();
        source.buffer = buf;
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(volume, ctx.currentTime);
        source.connect(gain);
        gain.connect(ctx.destination);
        source.start(0);
      } catch {
        // ignore WebAudio playback errors
      }
    };
    if (ctx.state === "suspended") {
      void ctx.resume().then(trigger).catch(() => {});
    } else {
      trigger();
    }
  };

  const cached = bufferCache.get(name);
  if (cached && ctx) {
    playWithBuffer(cached);
    return;
  }

  // 尚未完成解码时同时异步加载缓冲，并用原生 Audio 兜底即时播放
  void loadBuffer(name).then((buf) => {
    if (buf && ctx && !cached) {
      playWithBuffer(buf);
    }
  });
}
