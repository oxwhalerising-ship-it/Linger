/**
 * 统一 16kHz 单声道 16-bit PCM WAV 编码器
 * ---------------------------------------
 * 供 LocalWavRecorder 与 VoiceCallEngine 共用，避免重复实现重采样与 WAV 封装逻辑。
 */

const TARGET_SAMPLE_RATE = 16000;

/** 将原始 Float32 PCM 分片重采样为 16kHz 单声道 16-bit WAV ArrayBuffer */
export function encodePcmWav16kBuffer(
  chunks: Float32Array[],
  inputSampleRate: number,
): ArrayBuffer {
  let totalLen = 0;
  for (const c of chunks) {
    totalLen += c.length;
  }
  const merged = new Float32Array(totalLen);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  const ratio = inputSampleRate / TARGET_SAMPLE_RATE;
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
  view.setUint32(24, TARGET_SAMPLE_RATE, true);
  view.setUint32(28, TARGET_SAMPLE_RATE * 2, true);
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

/** 将原始 Float32 PCM 分片编码为标准 WAV Blob */
export function encodePcmWav16kBlob(
  chunks: Float32Array[],
  inputSampleRate: number,
): Blob {
  return new Blob([encodePcmWav16kBuffer(chunks, inputSampleRate)], {
    type: "audio/wav",
  });
}
