/**
 * 一对一低延迟实时语音通话全双工引擎（VoiceCallEngine）
 * ----------------------------------------------------
 * 核心能力：
 * 1. 常驻麦克风采集 + 420ms 预录环形缓冲（不吞首字、零重复开关延迟）。
 * 2. 自适应环境底噪 VAD：自动学习环境噪音水平，说话后自然停顿 ~780ms 自动提交，无需手动按键。
 * 3. 防回声随时插话打断（Barge-in）：配合浏览器硬件 AEC 回声消除 + 持续人声门限 + 起播保护窗，
 *    灵儿说话时你直接开口即可打断并无缝接入新一句，且保留插话前 420ms 首音。
 * 4. Web Audio 无缝流式队列（decodeAudioData + AudioBufferSourceNode 连续调度）：
 *    实现后端逐句推送 MP3 的零缝隙拼接播放，并用 AnalyserNode 实时输出声波振幅驱动通话 UI。
 */

import { getVoiceCallWebSocketUrl } from "./api";
import type { ChatMode } from "./petApi";
import type { PetEmotion } from "../types/pet";

export type VoiceCallState =
  | "connecting"
  | "listening"
  | "user_speaking"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "error"
  | "ended";

export interface VoiceCallLatency {
  sttMs: number;
  llmFirstTokenMs: number;
  firstAudioMs: number;
  totalMs: number;
}

export interface VoiceCallReadyInfo {
  botName: string;
  sttReady: boolean;
  sttEngine: string;
  ttsProvider: string;
}

export interface VoiceCallCallbacks {
  onStateChange?: (state: VoiceCallState) => void;
  onReady?: (info: VoiceCallReadyInfo) => void;
  onMicVolume?: (level: number) => void;
  onBotVolume?: (level: number) => void;
  onUserTranscript?: (turnId: number, text: string, sttMs: number) => void;
  onAssistantDelta?: (turnId: number, fullText: string) => void;
  onGreetingText?: (text: string) => void;
  onTurnDone?: (payload: {
    turnId: number;
    reply: string;
    emotion: PetEmotion;
    latency: VoiceCallLatency;
  }) => void;
  onArchived?: (payload: {
    turnId: number;
    tags: string[];
    pendingHabits: Array<{ id: number; title: string; category: string }>;
  }) => void;
  onBargeIn?: (turnId: number) => void;
  onWarning?: (message: string) => void;
  onError?: (message: string) => void;
}

/** 将多帧 Float32 麦克风采样重采样到 16kHz 单声道并编码为标准 16-bit PCM WAV ArrayBuffer */
function encodePcmWav16kBuffer(
  chunks: Float32Array[],
  inputSampleRate: number,
): ArrayBuffer {
  const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
  const merged = new Float32Array(totalLen);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

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
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, targetRate, true);
  view.setUint32(28, targetRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
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
  return buffer;
}

/** 将 Base64 字符串高效解码为 ArrayBuffer（供 Web Audio decodeAudioData 使用） */
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = window.atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

// VAD 与打断调优常量（兼顾低延迟与抗误触）
const MIC_BUFFER_SIZE = 2048; // 48kHz 下约 42.6ms 一帧
const PRE_ROLL_MAX_FRAMES = 10; // 约 420ms 预录缓冲，不吞首字
const SPEECH_START_FRAMES = 3; // 约 125ms 连续人声确认起说，过滤鼠标/键盘瞬时敲击
const SILENCE_COMMIT_MS = 1400; // 自动停顿模式下停顿 1.4 秒自动提交，避免思考停顿被抢截
const MIN_SPEECH_DURATION_MS = 260;
const MAX_SPEECH_DURATION_MS = 180_000; // 单段发言最长支持 3 分钟（180 秒），适合边思考边完整输出大段想法
const BARGE_IN_SUSTAIN_FRAMES = 6; // 说话期间需约 255ms 持续清晰人声才触发自动打断
const BARGE_IN_ARM_DELAY_MS = 320; // TTS 刚起播前 320ms 保护窗，防止扬声器冲击音自激
const ECHO_TAIL_SETTLE_MS = 180; // 播放结束后短暂等待房间混响散去再恢复倾听

export class VoiceCallEngine {
  private callbacks: VoiceCallCallbacks;
  private mode: ChatMode = "normal";
  private rate = "+25%";

  private ws: WebSocket | null = null;
  private state: VoiceCallState = "connecting";
  private disposed = false;
  private muted = false;
  private bargeInEnabled = true;
  private manualCommitMode = true;

  // 轮次与打断隔离 ID
  private nextTurnId = 1;
  private activeTurnId = 0;
  private currentAssistantSentences: string[] = [];
  private turnAudioStreamDone = true;

  // 麦克风常驻采集管线
  private micStream: MediaStream | null = null;
  private micCtx: AudioContext | null = null;
  private micProcessor: ScriptProcessorNode | null = null;
  private micSampleRate = 48000;

  // 自适应底噪 + 预录缓冲 + VAD 状态
  private noiseFloor = 0.008;
  private preRollChunks: Float32Array[] = [];
  private speechChunks: Float32Array[] = [];
  private isCapturingSpeech = false;
  private speechStartAt = 0;
  private silenceStartAt = 0;
  private consecutiveSpeechFrames = 0;
  private consecutiveBargeFrames = 0;
  private bargeInArmedAt = 0;
  private settleTimer: number | null = null;

  // Web Audio 无缝流式播放管线
  private playbackCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private analyserData: Uint8Array<ArrayBuffer> | null = null;
  private activeSources = new Set<AudioBufferSourceNode>();
  private nextPlayTime = 0;
  private playbackEpoch = 0;
  private pendingDecodes = 0;
  private decodeChain: Promise<void> = Promise.resolve();
  private botMeterRaf: number | null = null;

  constructor(callbacks: VoiceCallCallbacks = {}) {
    this.callbacks = callbacks;
  }

  private setState(next: VoiceCallState): void {
    if (this.disposed && next !== "ended") return;
    if (this.state === next) return;
    this.state = next;
    this.callbacks.onStateChange?.(next);
  }

  /** 启动一对一实时语音通话：同时初始化常驻麦克风、无缝播放引擎并建立 WebSocket */
  async start(options: {
    mode: ChatMode;
    rate: string;
    bargeInEnabled?: boolean;
    manualCommitMode?: boolean;
  }): Promise<void> {
    this.mode = options.mode;
    this.rate = options.rate;
    this.bargeInEnabled = options.bargeInEnabled ?? true;
    this.manualCommitMode = options.manualCommitMode ?? true;
    this.disposed = false;
    this.setState("connecting");

    try {
      await this.initAudioHardware();
      if (this.disposed) return;
      await this.connectWebSocket();
    } catch (err) {
      if (this.disposed) return;
      const msg =
        err instanceof Error
          ? err.message
          : "无法启动语音通话，请检查麦克风权限与本地后端连接";
      this.setState("error");
      this.callbacks.onError?.(msg);
      this.stop();
    }
  }

  private async initAudioHardware(): Promise<void> {
    // 1. 初始化播放用 AudioContext + AnalyserNode（驱动灵儿说话实时声波）
    const playbackCtx = new AudioContext();
    await playbackCtx.resume();
    if (this.disposed) {
      void playbackCtx.close();
      return;
    }
    this.playbackCtx = playbackCtx;
    this.analyser = this.playbackCtx.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0.72;
    this.analyser.connect(this.playbackCtx.destination);
    this.analyserData = new Uint8Array(
      new ArrayBuffer(this.analyser.frequencyBinCount),
    );
    this.startBotVolumeMeter();

    // 2. 初始化常驻麦克风（强制开启回声消除 AEC + 降噪 NS + 自动增益 AGC）
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch {
      throw new Error("无法访问麦克风，请检查 Windows 麦克风权限或设备连接");
    }
    if (this.disposed) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.micStream = stream;

    const micCtx = new AudioContext();
    await micCtx.resume();
    if (this.disposed) {
      void micCtx.close();
      return;
    }
    this.micCtx = micCtx;
    this.micSampleRate = this.micCtx.sampleRate;

    const source = this.micCtx.createMediaStreamSource(this.micStream);
    this.micProcessor = this.micCtx.createScriptProcessor(MIC_BUFFER_SIZE, 1, 1);

    // 接入静音增益节点防止麦克风回传产生啸叫
    const silentGain = this.micCtx.createGain();
    silentGain.gain.value = 0;

    this.micProcessor.onaudioprocess = (event) => {
      if (this.disposed) return;
      const input = event.inputBuffer.getChannelData(0);
      this.handleMicFrame(input);
    };

    source.connect(this.micProcessor);
    this.micProcessor.connect(silentGain);
    silentGain.connect(this.micCtx.destination);
  }

  private connectWebSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = getVoiceCallWebSocketUrl();
      const ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      this.ws = ws;

      let settled = false;
      const connectTimer = window.setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error("连接本地实时语音服务超时，请确认后端 8765 端口运行正常"));
        }
      }, 6000);

      ws.onopen = () => {
        window.clearTimeout(connectTimer);
        if (this.disposed) {
          ws.close();
          return;
        }
        settled = true;
        ws.send(
          JSON.stringify({
            type: "start_call",
            mode: this.mode,
            rate: this.rate,
            play_greeting: true,
          }),
        );
        resolve();
      };

      ws.onmessage = (event) => {
        if (this.disposed || typeof event.data !== "string") return;
        try {
          const msg = JSON.parse(event.data) as Record<string, unknown>;
          this.handleServerMessage(msg);
        } catch {
          // ignore malformed payload
        }
      };

      ws.onerror = () => {
        window.clearTimeout(connectTimer);
        if (!settled) {
          settled = true;
          reject(new Error("无法连接到本地实时语音通话服务（/ws/voice-call）"));
        }
      };

      ws.onclose = () => {
        if (!this.disposed && this.state !== "ended" && this.state !== "error") {
          this.setState("error");
          this.callbacks.onError?.("实时语音通话连接已断开，请确认后端服务仍在运行");
        }
      };
    });
  }

  private handleServerMessage(msg: Record<string, unknown>): void {
    const type = String(msg.type || "");

    if (type === "call_ready") {
      this.activeTurnId = 0;
      this.turnAudioStreamDone = false;
      this.callbacks.onReady?.({
        botName: String(msg.bot_name || "灵儿"),
        sttReady: Boolean(msg.stt_ready),
        sttEngine: String(msg.stt_engine || "faster-whisper"),
        ttsProvider: String(msg.tts_provider || "edge_tts"),
      });
      // 等待问候语或立刻倾听
      this.setState("listening");
      return;
    }

    const turnId = typeof msg.turn_id === "number" ? msg.turn_id : -1;

    // 后台归档完成通知不依赖当前 activeTurnId，始终回传给聊天记录
    if (type === "archived") {
      this.callbacks.onArchived?.({
        turnId,
        tags: Array.isArray(msg.tags) ? msg.tags.map(String) : [],
        pendingHabits: Array.isArray(msg.pending_habits)
          ? (msg.pending_habits as Array<{
              id: number;
              title: string;
              category: string;
            }>)
          : [],
      });
      return;
    }

    // 严格隔离已被打断或过期的旧轮次消息，彻底杜绝串音
    if (turnId >= 0 && turnId !== this.activeTurnId) {
      return;
    }

    if (type === "state") {
      if (turnId === 0 && this.isCapturingSpeech) {
        return;
      }
      const serverState = String(msg.state || "");
      if (serverState === "transcribing") {
        this.setState("transcribing");
      } else if (serverState === "thinking") {
        this.setState("thinking");
      } else if (serverState === "speaking") {
        if (this.state !== "speaking") {
          this.bargeInArmedAt = performance.now() + BARGE_IN_ARM_DELAY_MS;
          this.consecutiveBargeFrames = 0;
        }
        this.setState("speaking");
      } else if (serverState === "listening") {
        this.scheduleResumeListening();
      }
      return;
    }

    if (type === "no_speech") {
      this.turnAudioStreamDone = true;
      this.setState("listening");
      return;
    }

    if (type === "user_transcript") {
      this.callbacks.onUserTranscript?.(
        turnId,
        String(msg.text || ""),
        Number(msg.stt_ms || 0),
      );
      return;
    }

    if (type === "assistant_delta") {
      this.callbacks.onAssistantDelta?.(turnId, String(msg.full_text || ""));
      return;
    }

    if (type === "tts_audio") {
      // 如果用户在接通瞬间已经先开口说话，则自动礼让跳过开场问候语，绝不抢嘴
      if (turnId === 0 && this.isCapturingSpeech) {
        return;
      }
      const b64 = String(msg.audio_b64 || "");
      const sentence = String(msg.sentence || "");
      if (sentence) {
        this.currentAssistantSentences.push(sentence);
      }
      if (b64) {
        this.enqueueMp3Base64(b64, turnId);
      }
      return;
    }

    if (type === "greeting_done") {
      this.turnAudioStreamDone = true;
      const text = String(msg.text || "");
      if (text) {
        this.callbacks.onGreetingText?.(text);
      }
      this.checkPlaybackDrained();
      return;
    }

    if (type === "turn_done") {
      this.turnAudioStreamDone = true;
      this.callbacks.onTurnDone?.({
        turnId,
        reply: String(msg.reply || ""),
        emotion: (String(msg.emotion || "happy") as PetEmotion) || "happy",
        latency: {
          sttMs: Number(msg.stt_ms || 0),
          llmFirstTokenMs: Number(msg.llm_first_token_ms || 0),
          firstAudioMs: Number(msg.first_audio_ms || 0),
          totalMs: Number(msg.total_ms || 0),
        },
      });
      this.checkPlaybackDrained();
      return;
    }

    if (type === "warning") {
      this.callbacks.onWarning?.(String(msg.message || ""));
      return;
    }

    if (type === "error") {
      this.turnAudioStreamDone = true;
      this.callbacks.onWarning?.(String(msg.message || "语音处理出错"));
      this.scheduleResumeListening();
    }
  }

  /** 将后端流式推送的单句 MP3 音频按到达顺序无损解码并无缝排入播放时间线 */
  private enqueueMp3Base64(base64Audio: string, turnId: number): void {
    const ctx = this.playbackCtx;
    if (!ctx || this.disposed) return;

    const epoch = this.playbackEpoch;
    this.pendingDecodes += 1;

    this.decodeChain = this.decodeChain
      .then(async () => {
        if (
          this.disposed ||
          epoch !== this.playbackEpoch ||
          turnId !== this.activeTurnId ||
          !this.playbackCtx ||
          !this.analyser
        ) {
          return;
        }
        if (this.playbackCtx.state === "suspended") {
          await this.playbackCtx.resume();
        }
        const arrayBuf = base64ToArrayBuffer(base64Audio);
        const audioBuffer = await this.playbackCtx.decodeAudioData(arrayBuf);
        if (
          this.disposed ||
          epoch !== this.playbackEpoch ||
          turnId !== this.activeTurnId ||
          !this.playbackCtx ||
          !this.analyser
        ) {
          return;
        }

        const source = this.playbackCtx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(this.analyser);

        const now = this.playbackCtx.currentTime;
        const startAt = Math.max(now + 0.01, this.nextPlayTime);
        this.nextPlayTime = startAt + audioBuffer.duration;
        this.activeSources.add(source);

        if (this.state !== "speaking") {
          this.bargeInArmedAt = performance.now() + BARGE_IN_ARM_DELAY_MS;
          this.consecutiveBargeFrames = 0;
          this.setState("speaking");
        }

        source.onended = () => {
          this.activeSources.delete(source);
          if (epoch === this.playbackEpoch) {
            this.checkPlaybackDrained();
          }
        };

        source.start(startAt);
      })
      .catch(() => {
        // 单句解码失败不影响后续句子与状态恢复
      })
      .finally(() => {
        this.pendingDecodes = Math.max(0, this.pendingDecodes - 1);
        if (epoch === this.playbackEpoch) {
          this.checkPlaybackDrained();
        }
      });
  }

  /** 检查当前轮次所有已排队的语音是否全部播放完毕，完毕后自动切回倾听态 */
  private checkPlaybackDrained(): void {
    if (
      this.disposed ||
      !this.turnAudioStreamDone ||
      this.pendingDecodes > 0 ||
      this.activeSources.size > 0
    ) {
      return;
    }
    if (this.state === "speaking" || this.state === "thinking") {
      this.scheduleResumeListening();
    }
  }

  private scheduleResumeListening(): void {
    if (this.settleTimer) {
      window.clearTimeout(this.settleTimer);
    }
    this.settleTimer = window.setTimeout(() => {
      this.settleTimer = null;
      if (this.disposed || this.state === "ended" || this.state === "error") {
        return;
      }
      // 仅当未进入新一轮捕获时切回倾听并清空残留回声预录帧
      if (!this.isCapturingSpeech) {
        this.preRollChunks = [];
        this.consecutiveSpeechFrames = 0;
        this.consecutiveBargeFrames = 0;
        this.setState("listening");
      }
    }, ECHO_TAIL_SETTLE_MS);
  }

  /** 立即清空所有正在播放与已调度的音频（<5ms 静音，供插话打断与挂断使用） */
  private clearPlayback(): void {
    this.playbackEpoch += 1;
    this.nextPlayTime = 0;
    for (const source of this.activeSources) {
      try {
        source.onended = null;
        source.stop();
        source.disconnect();
      } catch {
        // ignore already stopped source
      }
    }
    this.activeSources.clear();
    this.callbacks.onBotVolume?.(0);
  }

  /** 60fps 读取灵儿语音输出能量，驱动中心声波光环随声音真实律动 */
  private startBotVolumeMeter(): void {
    const tick = () => {
      if (this.disposed) return;
      if (
        this.analyser &&
        this.analyserData &&
        this.activeSources.size > 0
      ) {
        this.analyser.getByteTimeDomainData(this.analyserData);
        let sumSq = 0;
        for (let i = 0; i < this.analyserData.length; i++) {
          const v = (this.analyserData[i] - 128) / 128;
          sumSq += v * v;
        }
        const rms = Math.sqrt(sumSq / this.analyserData.length);
        this.callbacks.onBotVolume?.(Math.min(1, rms * 4.2));
      } else {
        this.callbacks.onBotVolume?.(0);
      }
      this.botMeterRaf = window.requestAnimationFrame(tick);
    };
    this.botMeterRaf = window.requestAnimationFrame(tick);
  }

  /** 每 ~42ms 处理一帧麦克风采样：驱动音量指示、自适应 VAD 与防回声随时插话打断 */
  private handleMicFrame(rawFrame: Float32Array): void {
    if (this.muted) {
      this.callbacks.onMicVolume?.(0);
      return;
    }

    const frame = new Float32Array(rawFrame);
    let sumSq = 0;
    for (let i = 0; i < frame.length; i++) {
      sumSq += frame[i] * frame[i];
    }
    const rms = Math.sqrt(sumSq / frame.length);
    this.callbacks.onMicVolume?.(Math.min(1, rms * 7.5));

    // 始终维护 ~420ms 预录环形缓冲，确保起说与插话不吞首字
    this.preRollChunks.push(frame);
    if (this.preRollChunks.length > PRE_ROLL_MAX_FRAMES) {
      this.preRollChunks.shift();
    }

    const now = performance.now();

    // 场景 A：灵儿正在说话或思考中 -> 检测是否发生清晰人声插话打断（Barge-in）
    if (this.state === "speaking" || this.state === "thinking") {
      if (!this.bargeInEnabled) {
        this.consecutiveBargeFrames = 0;
        return;
      }
      if (this.state === "speaking" && now < this.bargeInArmedAt) {
        return;
      }
      const bargeThreshold = Math.max(0.052, this.noiseFloor * 4.8);
      if (rms > bargeThreshold) {
        this.consecutiveBargeFrames += 1;
        if (this.consecutiveBargeFrames >= BARGE_IN_SUSTAIN_FRAMES) {
          this.consecutiveBargeFrames = 0;
          this.triggerBargeIn(true);
        }
      } else {
        this.consecutiveBargeFrames = Math.max(
          0,
          this.consecutiveBargeFrames - 1,
        );
      }
      return;
    }

    // 场景 B：仅在 listening 或 user_speaking 态运行主 VAD 端点检测
    if (this.state !== "listening" && this.state !== "user_speaking") {
      return;
    }

    const startThreshold = Math.max(0.017, this.noiseFloor * 2.8);
    const continueThreshold = Math.max(0.013, this.noiseFloor * 2.0);

    if (!this.isCapturingSpeech) {
      if (rms > startThreshold) {
        this.consecutiveSpeechFrames += 1;
        if (this.consecutiveSpeechFrames >= SPEECH_START_FRAMES) {
          this.beginSpeechCapture(now);
        }
      } else {
        this.consecutiveSpeechFrames = 0;
        // 仅在安静倾听期平滑更新环境底噪基线
        this.noiseFloor = Math.max(
          0.004,
          Math.min(0.025, this.noiseFloor * 0.96 + rms * 0.04),
        );
      }
      return;
    }

    // 正在录制用户本句发言
    this.speechChunks.push(frame);

    if (rms > continueThreshold) {
      this.silenceStartAt = 0;
    } else if (this.silenceStartAt === 0) {
      this.silenceStartAt = now;
    }

    const speechElapsed = now - this.speechStartAt;
    const silenceElapsed =
      this.silenceStartAt > 0 ? now - this.silenceStartAt : 0;

    // 手动确认发送模式：停顿多久都不会自动截断，直到用户按空格/点击「确认发送」（或达到 3 分钟上限）
    if (this.manualCommitMode) {
      if (speechElapsed >= MAX_SPEECH_DURATION_MS) {
        this.commitCapturedSpeech();
      }
      return;
    }

    if (
      (silenceElapsed >= SILENCE_COMMIT_MS &&
        speechElapsed >= MIN_SPEECH_DURATION_MS) ||
      speechElapsed >= MAX_SPEECH_DURATION_MS
    ) {
      this.commitCapturedSpeech();
    }
  }

  private beginSpeechCapture(now: number): void {
    if (this.settleTimer) {
      window.clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    this.isCapturingSpeech = true;
    this.speechStartAt = now;
    this.silenceStartAt = 0;
    this.consecutiveSpeechFrames = 0;
    this.speechChunks = [...this.preRollChunks];
    this.setState("user_speaking");
  }

  private commitCapturedSpeech(): void {
    if (!this.isCapturingSpeech) return;
    this.isCapturingSpeech = false;
    this.silenceStartAt = 0;
    this.consecutiveSpeechFrames = 0;

    const chunks = this.speechChunks;
    this.speechChunks = [];
    if (chunks.length === 0) {
      this.setState("listening");
      return;
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.setState("error");
      this.callbacks.onError?.("通话连接已断开");
      return;
    }

    const turnId = this.nextTurnId++;
    this.activeTurnId = turnId;
    this.currentAssistantSentences = [];
    this.turnAudioStreamDone = false;
    this.setState("transcribing");

    const wavBuffer = encodePcmWav16kBuffer(chunks, this.micSampleRate);
    this.ws.send(
      JSON.stringify({
        type: "audio_meta",
        turn_id: turnId,
        mode: this.mode,
        rate: this.rate,
      }),
    );
    this.ws.send(wavBuffer);
  }

  /** 触发插话打断：毫秒级静音 + 通知后端取消当前轮次 + 可选立刻保留预录首音开始新句 */
  private triggerBargeIn(startCapturingImmediately: boolean): void {
    const oldTurnId = this.activeTurnId;
    const spokenText = this.currentAssistantSentences.join("");

    this.clearPlayback();
    this.turnAudioStreamDone = true;
    this.activeTurnId = this.nextTurnId++;
    this.currentAssistantSentences = [];

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          type: "interrupt",
          turn_id: oldTurnId,
          spoken_text: spokenText,
        }),
      );
    }

    this.callbacks.onBargeIn?.(oldTurnId);

    if (startCapturingImmediately) {
      this.beginSpeechCapture(performance.now());
    } else {
      this.isCapturingSpeech = false;
      this.speechChunks = [];
      this.preRollChunks = [];
      this.setState("listening");
    }
  }

  /** 供 UI 按钮 / 空格键调用：灵儿说话或思考时一键打断；自己说话时一键立刻发送 */
  manualInterruptOrCommit(): void {
    if (this.state === "speaking" || this.state === "thinking") {
      this.triggerBargeIn(false);
    } else if (this.state === "user_speaking" && this.isCapturingSpeech) {
      this.commitCapturedSpeech();
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) {
      this.callbacks.onMicVolume?.(0);
      if (this.isCapturingSpeech) {
        this.isCapturingSpeech = false;
        this.speechChunks = [];
        this.setState("listening");
      }
    }
  }

  setBargeInEnabled(enabled: boolean): void {
    this.bargeInEnabled = enabled;
    this.consecutiveBargeFrames = 0;
  }

  setManualCommitMode(enabled: boolean): void {
    this.manualCommitMode = enabled;
    if (!enabled && this.isCapturingSpeech) {
      this.silenceStartAt = performance.now();
    }
  }

  updateConfig(options: { mode?: ChatMode; rate?: string }): void {
    if (options.mode) this.mode = options.mode;
    if (options.rate) this.rate = options.rate;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          type: "update_config",
          mode: this.mode,
          rate: this.rate,
        }),
      );
    }
  }

  /** 挂断电话并彻底释放麦克风、Web Audio 与 WebSocket 资源 */
  stop(): void {
    if (this.disposed) return;
    this.disposed = true;

    if (this.settleTimer) {
      window.clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    if (this.botMeterRaf !== null) {
      window.cancelAnimationFrame(this.botMeterRaf);
      this.botMeterRaf = null;
    }

    this.clearPlayback();

    this.micProcessor?.disconnect();
    this.micProcessor = null;
    if (this.micCtx) {
      void this.micCtx.close();
      this.micCtx = null;
    }
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micStream = null;

    if (this.playbackCtx) {
      void this.playbackCtx.close();
      this.playbackCtx = null;
    }
    this.analyser = null;
    this.analyserData = null;

    if (this.ws) {
      try {
        if (this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: "end_call" }));
        }
        this.ws.close();
      } catch {
        // ignore close error
      }
      this.ws = null;
    }

    this.setState("ended");
  }
}
