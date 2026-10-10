// 16kHz mono Float32 PCM ↔ WAV, 구간 합치기

export const TARGET_SAMPLE_RATE = 16000;

/** 16-bit PCM WAV 로 인코딩 */
export function encodeWav(samples: Float32Array, sampleRate = TARGET_SAMPLE_RATE): Uint8Array {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, 'data');
  view.setUint32(40, dataBytes, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buffer);
}

/** 여러 구간을 짧은 무음을 사이에 두고 하나로 합친다 */
export function concatWithGap(parts: Float32Array[], gapSec = 0.25, sampleRate = TARGET_SAMPLE_RATE): Float32Array {
  if (parts.length === 1) return parts[0];
  const gap = Math.round(gapSec * sampleRate);
  const total = parts.reduce((n, p) => n + p.length, 0) + gap * Math.max(0, parts.length - 1);
  const out = new Float32Array(total);
  let offset = 0;
  parts.forEach((p, i) => {
    out.set(p, offset);
    offset += p.length + (i < parts.length - 1 ? gap : 0);
  });
  return out;
}

export function durationSec(samples: Float32Array | number, sampleRate = TARGET_SAMPLE_RATE): number {
  const n = typeof samples === 'number' ? samples : samples.length;
  return n / sampleRate;
}
