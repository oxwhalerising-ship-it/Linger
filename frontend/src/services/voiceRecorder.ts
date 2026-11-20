/**
 * 双模语音采集与 VAD 静音检测引擎（VoiceRecorder）
 * ------------------------------------------------
 * 为什么自己用原生 Web Audio API 封装？
 * 1. 可直接输出标准 16kHz 单声道 16-bit PCM WAV，后端 sherpa-onnx 零转码直接识别（无需 ffmpeg）。
 * 2. 实时计算麦克风 RMS 音量，既能驱动苹果风细腻声波条动画，也能实现「免提连续对话（VAD 静音自动停录）」。
 * 3. 若本机尚未下载 sherpa-onnx 模型，可优雅回退到浏览器原生 SpeechRecognition（zh-TW），开箱即用。
 */

export type VoiceInputMode = "push_to_talk" | "hands_free_vad";

/** 将原始 Float32 音频重采样到 16kHz 并编码为 16-bit PCM WAV Blob */
function encodePcmWav16k(chunks: Float32Array[], inputSampleRate: number): Blob {
  const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
  const merged = new Float32Array(totalLen);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  // 线性插值重采样至 16000Hz
  const targetRate = 16000;
  const ratio = inputSampleRate / targetRate;
  const outputLen = Math.max(1, Math.floor(merged.length / ratio));
  const resampled = new Float32Array(outputLen);
  for (let i = 0; i < outputLen; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const s1 = merged[idx] ?? 0;
    const s2 = merged[Math.min(idx + 1, merged.length - 1)] ?? 0;
    resampled[i] = s1 + (s2 - s1) * frac;
  }

  // 写入 44 字节标准 WAV 文件头 + PCM 16-bit 数据
  const buffer = new ArrayBuffer(44 + resampled.length * 2);
  const view = new DataView(buffer);

  const writeStr = (pos: number, text: string) => {
    for (let i = 0; i < text.length; i++) {
      view.setUint8(pos + i, text.charCodeAt(i));
    }
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + resampled.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // AudioFormat = PCM
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, targetRate, true);
  view.setUint32(28, targetRate * 2, true); // ByteRate
  view.setUint16(32, 2, true); // BlockAlign
  view.setUint16(34, 16, true); // BitsPerSample
  writeStr(36, "data");
  view.setUint32(40, resampled.length * 2, true);

  let dataPos = 44;
  for (let i = 0; i < resampled.length; i++) {
    const clamped = Math.max(-1, Math.min(1, resampled[i]));
    view.setInt16(
      dataPos,
      clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff,
      true,
    );
    dataPos += 2;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

export interface RecorderCallbacks {
  onVolumeChange?: (level: number) => void;
  onVadAutoStop?: (wavBlob: Blob) => void;
}

/**
 * 麦克风 WAV 录音器（支持手动停录与 VAD 静音自动停录）
 */
export class LocalWavRecorder {
  private stream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private chunks: Float32Array[] = [];
  private isRecording = false;
  private sampleRate = 48000;

  // VAD 能量检测参数
  private vadEnabled = false;
  private speechDetected = false;
  private silenceStartTime = 0;
  private callbacks: RecorderCallbacks = {};

  async start(
    options: { vadEnabled?: boolean } & RecorderCallbacks = {},
  ): Promise<void> {
    if (this.isRecording) return;
    this.vadEnabled = Boolean(options.vadEnabled);
    this.callbacks = options;
    this.chunks = [];
    this.speechDetected = false;
    this.silenceStartTime = 0;

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    this.audioCtx = new AudioContext();
    this.sampleRate = this.audioCtx.sampleRate;
    const source = this.audioCtx.createMediaStreamSource(this.stream);
    this.processor = this.audioCtx.createScriptProcessor(4096, 1, 1);

    this.processor.onaudioprocess = (event) => {
      if (!this.isRecording) return;
      const input = event.inputBuffer.getChannelData(0);
      this.chunks.push(new Float32Array(input));

      // 计算 RMS 音量（0 ~ 1）
      let sum = 0;
      for (let i = 0; i < input.length; i++) {
        sum += input[i] * input[i];
      }
      const rms = Math.sqrt(sum / input.length);
      this.callbacks.onVolumeChange?.(Math.min(1, rms * 6));

      // 免提 VAD：检测到有效人声后，若连续静音超过 1300ms 则自动停录并回调
      if (this.vadEnabled) {
        const now = performance.now();
        if (rms > 0.018) {
          this.speechDetected = true;
          this.silenceStartTime = 0;
        } else if (this.speechDetected) {
          if (this.silenceStartTime === 0) {
            this.silenceStartTime = now;
          } else if (now - this.silenceStartTime > 1300) {
            const blob = this.stop();
            if (blob) {
              this.callbacks.onVadAutoStop?.(blob);
            }
          }
        }
      }
    };

    source.connect(this.processor);
    this.processor.connect(this.audioCtx.destination);
    this.isRecording = true;
  }

  stop(): Blob | null {
    if (!this.isRecording) return null;
    this.isRecording = false;
    this.callbacks.onVolumeChange?.(0);

    this.processor?.disconnect();
    this.processor = null;
    if (this.audioCtx) {
      void this.audioCtx.close();
      this.audioCtx = null;
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;

    if (this.chunks.length === 0) return null;
    const wavBlob = encodePcmWav16k(this.chunks, this.sampleRate);
    this.chunks = [];
    return wavBlob;
  }
}

/** 浏览器原生 SpeechRecognition 兜底（当本机尚未下载 sherpa-onnx 模型时使用） */
export function isBrowserSpeechAvailable(): boolean {
  const w = window as unknown as Record<string, unknown>;
  return Boolean(w.SpeechRecognition || w.webkitSpeechRecognition);
}

export function startBrowserSpeechOnce(callbacks: {
  onResult: (text: string) => void;
  onEnd: () => void;
  onError: (msg: string) => void;
}): () => void {
  const w = window as unknown as Record<
    string,
    new () => {
      lang: string;
      continuous: boolean;
      interimResults: boolean;
      onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
      onerror: ((e: { error: string }) => void) | null;
      onend: (() => void) | null;
      start: () => void;
      stop: () => void;
    }
  >;
  const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
  if (!Ctor) {
    callbacks.onError("当前运行环境不支持浏览器原生语音识别");
    callbacks.onEnd();
    return () => {};
  }

  const rec = new Ctor();
  rec.lang = "zh-TW";
  rec.continuous = false;
  rec.interimResults = false;

  rec.onresult = (e) => {
    const transcript = e.results?.[0]?.[0]?.transcript?.trim() ?? "";
    if (transcript) {
      callbacks.onResult(transcript);
    }
  };
  rec.onerror = (e) => {
    callbacks.onError(`语音识别提示：${e.error}`);
  };
  rec.onend = () => {
    callbacks.onEnd();
  };

  rec.start();
  return () => {
    try {
      rec.stop();
    } catch {
      // ignore
    }
  };
}
