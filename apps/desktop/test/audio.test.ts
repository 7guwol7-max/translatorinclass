import { describe, expect, it } from 'vitest';
import { StreamingDownsampler } from '../src/renderer/audio/resampler';
import { FAST_PARAMS, NORMAL_PARAMS, SAVING_PARAMS, Segmenter, frameDb } from '../src/renderer/audio/segmenter';
import { concatWithGap, encodeWav } from '../src/shared/wav';

const SR = 16000;

/** 결정적인 잡음 (테스트마다 같은 값) */
function noise(seconds: number, amplitude: number, seed = 1): Float32Array {
  const out = new Float32Array(Math.round(seconds * SR));
  let x = seed;
  for (let i = 0; i < out.length; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out[i] = ((x / 2147483648) * 2 - 1) * amplitude;
  }
  return out;
}

/** 음절처럼 크기가 4Hz 로 오르내리는 '말소리' */
function speech(seconds: number, amplitude = 0.3): Float32Array {
  const out = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const envelope = 0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * t);
    out[i] = amplitude * envelope * Math.sin(2 * Math.PI * 220 * t);
  }
  return out;
}

function join(...parts: Float32Array[]): Float32Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Float32Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function run(params: typeof NORMAL_PARAMS, signal: Float32Array, chunk = 777): Float32Array[] {
  const segments: Float32Array[] = [];
  const seg = new Segmenter(params, (pcm) => segments.push(pcm));
  for (let i = 0; i < signal.length; i += chunk) seg.push(signal.subarray(i, i + chunk));
  seg.flush();
  return segments;
}

describe('StreamingDownsampler', () => {
  it('48kHz 를 16kHz 로 줄이고 샘플 수를 보존한다', () => {
    const ds = new StreamingDownsampler(48000, 16000);
    const input = new Float32Array(48000).map((_, i) => Math.sin((2 * Math.PI * 440 * i) / 48000));
    let total = 0;
    const out: number[] = [];
    for (let i = 0; i < input.length; i += 1000) {
      const r = ds.process(input.subarray(i, i + 1000));
      total += r.length;
      out.push(...r);
    }
    expect(total).toBeGreaterThanOrEqual(15999);
    expect(total).toBeLessThanOrEqual(16000);
    // 440Hz 사인파의 크기가 거의 유지된다
    const peak = Math.max(...out.slice(100, 2000).map(Math.abs));
    expect(peak).toBeGreaterThan(0.9);
  });

  it('44.1kHz 처럼 나누어떨어지지 않는 비율도 처리한다', () => {
    const ds = new StreamingDownsampler(44100, 16000);
    let total = 0;
    for (let i = 0; i < 44100; i += 512) total += ds.process(new Float32Array(Math.min(512, 44100 - i))).length;
    expect(Math.abs(total - 16000)).toBeLessThanOrEqual(1);
  });
});

describe('Segmenter', () => {
  it('조용한 방에서 쉼을 기준으로 문장을 자른다', () => {
    const signal = join(noise(1, 0.001), speech(4), noise(1, 0.001), speech(3.5), noise(2, 0.001));
    const segments = run(NORMAL_PARAMS, signal);
    expect(segments).toHaveLength(2);
    expect(segments[0].length / SR).toBeGreaterThan(3.9);
    expect(segments[0].length / SR).toBeLessThan(5);
  });

  it('짧은 말들은 최소 길이가 될 때까지 합친다', () => {
    const signal = join(noise(1, 0.001), speech(0.8), noise(0.7, 0.001), speech(0.8), noise(0.7, 0.001), speech(1.5), noise(2, 0.001));
    const segments = run(NORMAL_PARAMS, signal);
    expect(segments).toHaveLength(1);
    expect(segments[0].length / SR).toBeGreaterThan(4.5);
  });

  it('짧은 한마디도 조용해지면 보낸다', () => {
    const signal = join(noise(1, 0.001), speech(1.2), noise(2.5, 0.001));
    expect(run(NORMAL_PARAMS, signal)).toHaveLength(1);
  });

  it('너무 짧은 소리(기침 등)는 버린다', () => {
    const signal = join(noise(1, 0.001), speech(0.2), noise(2.5, 0.001));
    expect(run(NORMAL_PARAMS, signal)).toHaveLength(0);
  });

  it('쉬지 않고 길게 말하면 최대 길이에서 자른다', () => {
    const signal = join(noise(1, 0.001), speech(30), noise(2, 0.001));
    const segments = run(NORMAL_PARAMS, signal);
    expect(segments.length).toBeGreaterThanOrEqual(3);
    for (const s of segments) expect(s.length / SR).toBeLessThanOrEqual(NORMAL_PARAMS.maxSegmentSec + 0.5);
  });

  it('절약 모드에서는 더 길게 묶어 요청 수를 줄인다', () => {
    const parts: Float32Array[] = [noise(1, 0.001)];
    for (let i = 0; i < 10; i++) parts.push(speech(3), noise(0.8, 0.001));
    parts.push(noise(3, 0.001));
    const signal = join(...parts);
    const normal = run(NORMAL_PARAMS, signal).length;
    const saving = run(SAVING_PARAMS, signal).length;
    expect(saving).toBeLessThan(normal);
  });

  it('일정한 배경 소음(선풍기)은 말소리로 보내지 않는다', () => {
    const signal = join(noise(0.5, 0.001), noise(20, 0.05, 7), noise(1, 0.001));
    expect(run(NORMAL_PARAMS, signal)).toHaveLength(0);
  });

  it('Live 모드: 말하는 동안 소리를 0.1초씩 흘려 보내고, 쉼에서 끝을 알린다 (구간과 같은 번호)', () => {
    const segments: { len: number; utterance: number }[] = [];
    const audio: { utterance: number; len: number }[] = [];
    const ends: number[] = [];
    const seg = new Segmenter(NORMAL_PARAMS, (pcm, utterance) => segments.push({ len: pcm.length, utterance }), undefined, {
      audio: (utterance, pcm) => audio.push({ utterance, len: pcm.length }),
      end: (utterance) => ends.push(utterance),
    });
    const signal = join(noise(1, 0.001), speech(4), noise(1, 0.001), speech(3.5), noise(2, 0.001));
    for (let i = 0; i < signal.length; i += 777) seg.push(signal.subarray(i, i + 777));
    seg.flush();
    expect(segments).toHaveLength(2);
    expect(ends).toEqual(segments.map((x) => x.utterance));
    expect(ends[1]).toBeGreaterThan(ends[0]);
    for (const u of ends) {
      const sent = audio.filter((a) => a.utterance === u);
      const total = sent.reduce((n, a) => n + a.len, 0) / SR;
      expect(total).toBeGreaterThan(3.5); // 말 시작 직전 소리부터 쉼까지
      expect(sent.slice(0, -1).every((a) => a.len >= 1600)).toBe(true); // 0.1초 이상씩 묶어 보낸다
    }
  });

  it('Live 모드: 길어서 강제로 자른 곳은 말 끝이 아니다 (한 덩이로 이어 보낸다)', () => {
    const events: string[] = [];
    let streamed = 0;
    const seg = new Segmenter(FAST_PARAMS, (_pcm, utterance) => events.push(`seg${utterance}`), undefined, {
      audio: (_u, pcm) => (streamed += pcm.length),
      end: (utterance) => events.push(`end${utterance}`),
    });
    // 쉬지 않고 이어지는 말소리 (크기가 내려가도 말소리 기준 아래로는 안 떨어짐)
    const talk = new Float32Array(SR * 10).map((_, i) => Math.sin(i / 8) * (0.2 + 0.15 * Math.sin(i / 1600)));
    const signal = join(noise(1, 0.001), talk, noise(2, 0.001));
    for (let i = 0; i < signal.length; i += 777) seg.push(signal.subarray(i, i + 777));
    seg.flush();
    const first = events[0].slice(3);
    const ofFirst = events.filter((e) => e.replace(/^(seg|end)/, '') === first);
    expect(ofFirst.filter((e) => e.startsWith('seg')).length).toBeGreaterThanOrEqual(2); // 5초마다 잘린 구간들
    expect(ofFirst.filter((e) => e.startsWith('end'))).toHaveLength(1); // 끝은 한 번
    expect(ofFirst.at(-1)).toBe(`end${first}`);
    expect(streamed / SR).toBeGreaterThan(10);
  });

  it('배경 소음이 있어도 그보다 큰 말소리는 잡는다', () => {
    const signal = join(noise(5, 0.02, 3), join(speech(4, 0.4)).map((v, i) => v + ((i * 7919) % 100) / 5000 - 0.01), noise(3, 0.02, 5));
    expect(run(NORMAL_PARAMS, signal)).toHaveLength(1);
  });
});

describe('wav', () => {
  it('16-bit PCM WAV 헤더를 쓴다', () => {
    const wav = encodeWav(new Float32Array([0, 1, -1, 0.5]));
    const view = new DataView(wav.buffer);
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...wav.slice(8, 12))).toBe('WAVE');
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint32(40, true)).toBe(8);
    expect(view.getInt16(46, true)).toBe(32767);
    expect(view.getInt16(48, true)).toBe(-32768);
  });

  it('구간 사이에 무음을 넣어 합친다', () => {
    const merged = concatWithGap([new Float32Array(100).fill(0.5), new Float32Array(50).fill(0.5)], 0.01);
    expect(merged.length).toBe(100 + 160 + 50);
    expect(merged[150]).toBe(0);
  });

  it('frameDb 는 무음을 매우 작은 값으로 본다', () => {
    expect(frameDb(new Float32Array(320))).toBe(-120);
    expect(frameDb(new Float32Array(320).fill(1))).toBeCloseTo(0);
  });
});
