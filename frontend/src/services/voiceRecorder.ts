/**
 * 双模语音采集与 VAD 静音检测引擎（VoiceRecorder）
 * ------------------------------------------------
 * 为什么自己用原生 Web Audio API 封装？
 * 1. 可直接输出标准 16kHz 单声道 16-bit PCM WAV，后端 sherpa-onnx 零转码直接识别（无需 ffmpeg）。
 * 2. 实时计算麦克风 RMS 音量，既能驱动苹果风细腻声波条动画，也能实现「免提连续对话（VAD 静音自动停录）」。
 * 3. 若本机尚未下载 sherpa-onnx 模型，可优雅回退到浏览器原生 SpeechRecognition（zh-TW），开箱即用。
 */

import { encodePcmWav16kBlob } from "./voice/pcmWavEncoder";

export type VoiceInputMode = "push_to_talk" | "hands_free_vad";

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
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private silentGain: GainNode | null = null;
  private chunks: Float32Array[] = [];
  private isRecording = false;
  private sampleRate = 48000;
  private startGeneration = 0;

  // VAD 能量检测参数
  private vadEnabled = false;
  private speechDetected = false;
  private silenceStartTime = 0;
  private callbacks: RecorderCallbacks = {};

  async start(
    options: { vadEnabled?: boolean } & RecorderCallbacks = {},
  ): Promise<void> {
    if (this.isRecording) return;
    const myGen = ++this.startGeneration;
    this.vadEnabled = Boolean(options.vadEnabled);
    this.callbacks = options;
    this.chunks = [];
    this.speechDetected = false;
    this.silenceStartTime = 0;

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    // 若在等待麦克风授权期间外部调用了 stop()，立即释放流，避免麦克风泄漏
    if (myGen !== this.startGeneration) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }

    this.stream = stream;
    this.audioCtx = new AudioContext();
    if (this.audioCtx.state === "suspended") {
      await this.audioCtx.resume();
    }
    if (myGen !== this.startGeneration) {
      void this.audioCtx.close();
      this.audioCtx = null;
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
      return;
    }

    this.sampleRate = this.audioCtx.sampleRate;
    this.sourceNode = this.audioCtx.createMediaStreamSource(this.stream);
    this.processor = this.audioCtx.createScriptProcessor(4096, 1, 1);
    this.silentGain = this.audioCtx.createGain();
    this.silentGain.gain.value = 0;

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

    this.sourceNode.connect(this.processor);
    this.processor.connect(this.silentGain);
    this.silentGain.connect(this.audioCtx.destination);
    this.isRecording = true;
  }

  stop(): Blob | null {
    this.startGeneration += 1;
    if (!this.isRecording) {
      this.stream?.getTracks().forEach((t) => t.stop());
      this.stream = null;
      return null;
    }
    this.isRecording = false;
    this.callbacks.onVolumeChange?.(0);

    if (this.processor) {
      this.processor.onaudioprocess = null;
      this.processor.disconnect();
      this.processor = null;
    }
    this.sourceNode?.disconnect();
    this.sourceNode = null;
    this.silentGain?.disconnect();
    this.silentGain = null;
    if (this.audioCtx) {
      void this.audioCtx.close();
      this.audioCtx = null;
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;

    if (this.chunks.length === 0) return null;
    const wavBlob = encodePcmWav16kBlob(this.chunks, this.sampleRate);
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
