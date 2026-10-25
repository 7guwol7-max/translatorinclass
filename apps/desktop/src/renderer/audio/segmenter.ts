import type { LatencyMode, QuotaPressure } from '../../shared/types';

// 에너지 기반 VAD + 발화 구간 묶기 (16kHz mono).
// 말소리가 끝난 쉼에서 자르되, 너무 짧으면 다음 말과 합치고 너무 길면 강제로 자른다.
// 무료 한도를 아끼기 위해 '절약' 모드에서는 더 길게 묶는다.

export interface SegmenterParams {
  /** 이 길이 이상이면 쉼에서 바로 보낸다 */
  minSegmentSec: number;
  /** 이 길이에 닿으면 말하는 중이라도 자른다 */
  maxSegmentSec: number;
  /** 문장 끝으로 볼 쉼 길이 */
  pauseMs: number;
  /** 짧은 발화라도 이만큼 조용하면 보낸다 */
  flushSilenceMs: number;
  /** 실제 말소리가 이보다 짧으면 잡음으로 보고 버린다 */
  minSpeechSec: number;
  /** 말 시작 전 포함할 앞부분 */
  preRollMs: number;
  /** 배경 소음보다 이만큼(dB) 커야 말소리로 본다 */
  thresholdOffsetDb: number;
  /** 아무리 조용한 방이어도 이보다 작은 소리는 말소리로 보지 않는다 */
  minThresholdDb: number;
}

export const NORMAL_PARAMS: SegmenterParams = {
  minSegmentSec: 3,
  maxSegmentSec: 12,
  pauseMs: 600,
  flushSilenceMs: 1500,
  minSpeechSec: 0.5,
  preRollMs: 300,
  thresholdOffsetDb: 10,
  minThresholdDb: -50,
};

/** 빠르게: 짧은 쉼에서 바로 보내고, 쉬지 않고 말해도 5초마다 보내 자막이 늦게 쌓이지 않게 (요청 수는 늘어남) */
export const FAST_PARAMS: SegmenterParams = {
  ...NORMAL_PARAMS,
  minSegmentSec: 1,
  maxSegmentSec: 5,
  pauseMs: 350,
  flushSilenceMs: 700,
  minSpeechSec: 0.4,
};

export const SAVING_PARAMS: SegmenterParams = {
  ...NORMAL_PARAMS,
  minSegmentSec: 8,
  maxSegmentSec: 20,
  flushSilenceMs: 3000,
};

/** 속도 설정과 무료 한도 상황으로 구간 길이를 정한다 (한도가 빠듯하면 항상 절약) */
export function paramsFor(mode: LatencyMode, pressure: QuotaPressure): SegmenterParams {
  if (pressure !== 'normal' || mode === 'saving') return SAVING_PARAMS;
  return mode === 'fast' ? FAST_PARAMS : NORMAL_PARAMS;
}

/** Live 모드: 말하는 동안의 소리를 흘려 보낸다. 같은 말의 구간(onSegment)과 같은 번호를 쓴다 */
export interface SegmenterStream {
  /** 약 0.1초씩 (말 시작 직전 소리 포함) */
  audio(utterance: number, pcm: Float32Array): void;
  /** 쉼에서 말 한 덩이가 끝남 (길어서 강제로 자른 곳은 끝이 아니다) */
  end(utterance: number): void;
}

const SAMPLE_RATE = 16000;
const FRAME = 320; // 20ms
const FRAME_MS = 20;
const ONSET_FRAMES = 3; // 60ms 연속으로 커야 말 시작
const TAIL_KEEP_FRAMES = 10; // 끝부분 무음은 200ms 만 남긴다
/** 최대 길이에 가까워지면(이만큼 남으면) 짧은 숨 쉼에서도 자른다 — 단어 중간에서 강제로 자르는 일을 줄인다 */
const SOFT_CUT_WINDOW_SEC = 1.5;
const SOFT_CUT_PAUSE_MS = 120;
/** 그래도 쉼이 없어 강제로 자를 때 자를 곳을 찾는 범위 (20ms × 20 = 0.4초) */
const HARD_CUT_SEARCH_FRAMES = 20;
/** 흘려 보낼 때 묶는 프레임 수 (20ms × 5 = 0.1초) */
const STREAM_FRAMES = 5;
/** 말 한 덩이 번호 (마이크가 여러 개여도 겹치지 않게 모듈 전체에서 센다) */
let nextUtterance = 1;

export function frameDb(frame: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  const rms = Math.sqrt(sum / Math.max(1, frame.length));
  return rms > 0 ? 20 * Math.log10(rms) : -120;
}

export class Segmenter {
  private params: SegmenterParams;
  private pending = new Float32Array(0);
  private noiseFloorDb = -60;
  /** 시작 직후 0.5초는 방 소음 크기만 잰다 */
  private calibration: number[] = [];
  private calibrated = false;
  private onsetRun = 0;
  private preRoll: Frame[] = [];
  private onsetFrames: Frame[] = [];
  private active = false;
  private frames: Frame[] = [];
  private speechFrames = 0;
  private trailingSilence = 0;
  private utterance = 0;
  private streamBuf: Frame[] = [];

  constructor(
    params: SegmenterParams,
    private readonly onSegment: (pcm: Float32Array, utterance: number) => void,
    private readonly onLevel?: (db: number, speaking: boolean) => void,
    private readonly stream?: SegmenterStream,
  ) {
    this.params = params;
  }

  setParams(params: SegmenterParams): void {
    this.params = params;
  }

  /** 16kHz 샘플을 아무 길이로나 넣는다 */
  push(samples: Float32Array): void {
    const buf = new Float32Array(this.pending.length + samples.length);
    buf.set(this.pending, 0);
    buf.set(samples, this.pending.length);
    let offset = 0;
    while (offset + FRAME <= buf.length) {
      this.processFrame(buf.slice(offset, offset + FRAME));
      offset += FRAME;
    }
    this.pending = buf.slice(offset);
  }

  /** 정지할 때: 남은 구간을 내보낸다 */
  flush(): void {
    if (this.active) this.finish(true);
    this.pending = new Float32Array(0);
    this.onsetRun = 0;
    this.onsetFrames = [];
  }

  private threshold(): number {
    return Math.max(this.noiseFloorDb + this.params.thresholdOffsetDb, this.params.minThresholdDb);
  }

  private processFrame(samples: Float32Array): void {
    const frame: Frame = { samples, db: frameDb(samples) };

    if (!this.calibrated) {
      this.calibration.push(frame.db);
      if (this.calibration.length >= CALIBRATION_FRAMES) {
        this.noiseFloorDb = clampFloor(mean(this.calibration));
        this.calibrated = true;
      }
      this.onLevel?.(frame.db, false);
      return;
    }

    const loud = frame.db > this.threshold();
    this.onLevel?.(frame.db, this.active && this.trailingSilence === 0);
    this.updateNoiseFloor(frame.db);

    if (!this.active) {
      if (loud) {
        this.onsetRun++;
        this.onsetFrames.push(frame);
        if (this.onsetRun >= ONSET_FRAMES) this.begin();
      } else {
        // 짧은 잡음은 말 시작이 아니므로 앞부분 버퍼로 돌린다
        for (const f of this.onsetFrames) this.rememberPreRoll(f);
        this.onsetFrames = [];
        this.onsetRun = 0;
        this.rememberPreRoll(frame);
      }
      return;
    }

    this.frames.push(frame);
    this.streamPush([frame]);
    if (loud) {
      this.speechFrames++;
      this.trailingSilence = 0;
    } else {
      this.trailingSilence++;
    }

    const p = this.params;
    const silenceMs = this.trailingSilence * FRAME_MS;
    const voicedSec = ((this.frames.length - this.trailingSilence) * FRAME_MS) / 1000;
    const totalSec = (this.frames.length * FRAME_MS) / 1000;

    const nearMax = totalSec >= p.maxSegmentSec - SOFT_CUT_WINDOW_SEC;
    const pauseNeeded = nearMax ? Math.min(p.pauseMs, SOFT_CUT_PAUSE_MS) : p.pauseMs;
    if (silenceMs >= pauseNeeded && voicedSec >= p.minSegmentSec) {
      this.finish(false);
    } else if (silenceMs >= p.flushSilenceMs) {
      this.finish(false);
    } else if (totalSec >= p.maxSegmentSec) {
      const stillSpeaking = this.trailingSilence === 0;
      // 말하는 중에 잘라야 하면 마지막 0.4초 중 가장 조용한 곳(음절 사이)에서 자르고, 뒷부분은 다음 구간 앞에 붙인다
      const carry = stillSpeaking ? this.takeAfterQuietest() : [];
      this.finish(false, stillSpeaking);
      if (stillSpeaking) {
        this.begin(true); // 말이 계속되면 바로 다음 구간 시작 (같은 말 덩이, 소리는 이미 보냄)
        this.frames.push(...carry);
        this.speechFrames += carry.length;
      }
    }
  }

  /** 마지막 HARD_CUT_SEARCH_FRAMES 안에서 가장 조용한 프레임 뒤를 떼어 낸다 */
  private takeAfterQuietest(): Frame[] {
    const from = Math.max(1, this.frames.length - HARD_CUT_SEARCH_FRAMES);
    let quietest = this.frames.length - 1;
    for (let i = from; i < this.frames.length; i++) if (this.frames[i].db < this.frames[quietest].db) quietest = i;
    return this.frames.splice(quietest + 1);
  }

  private updateNoiseFloor(db: number): void {
    // 조용한 쪽으로는 빠르게 내려가고, 시끄러운 쪽(선풍기·냉난방 소음)으로는 천천히 올라간다.
    // 말하는 도중에는 거의 올리지 않아서 긴 설명이 소음으로 바뀌지 않게 한다.
    const rate = db < this.noiseFloorDb ? 0.1 : this.active ? 0.002 : 0.02;
    this.noiseFloorDb = clampFloor(this.noiseFloorDb + (db - this.noiseFloorDb) * rate);
  }

  private rememberPreRoll(frame: Frame): void {
    this.preRoll.push(frame);
    const max = Math.ceil(this.params.preRollMs / FRAME_MS);
    while (this.preRoll.length > max) this.preRoll.shift();
  }

  /** continued: 길어서 강제로 자른 뒤 이어지는 구간 (같은 말 덩이) */
  private begin(continued = false): void {
    if (!continued) {
      this.utterance = nextUtterance++;
      this.streamPush([...this.preRoll, ...this.onsetFrames]);
    }
    this.active = true;
    this.frames = [...this.preRoll, ...this.onsetFrames];
    this.speechFrames = this.onsetFrames.length;
    this.trailingSilence = 0;
    this.preRoll = [];
    this.onsetFrames = [];
    this.onsetRun = 0;
  }

  /** continuing: 말이 이어져 바로 다음 구간을 시작한다 (Live 로는 끝을 알리지 않는다) */
  private finish(force: boolean, continuing = false): void {
    const speechSec = (this.speechFrames * FRAME_MS) / 1000;
    const keep = this.frames.length - Math.max(0, this.trailingSilence - TAIL_KEEP_FRAMES);
    const frames = this.frames.slice(0, keep);
    this.active = false;
    this.frames = [];
    this.speechFrames = 0;
    this.trailingSilence = 0;
    const segment = this.keepSegment(frames, speechSec, force);
    if (segment) this.onSegment(segment, this.utterance);
    if (!continuing) this.streamEnd();
  }

  /** 버릴 구간이면 null: 너무 짧거나, 크기가 거의 일정한 소음 */
  private keepSegment(frames: Frame[], speechSec: number, force: boolean): Float32Array | null {
    if (speechSec < this.params.minSpeechSec && !(force && speechSec > 0.3)) return null;
    // 말소리는 음절마다 크기가 오르내린다. 크기가 거의 일정하면 선풍기 같은 지속 소음으로 보고 버린다.
    const levels = frames.map((f) => f.db);
    if (stdDev(levels) < STEADY_NOISE_STD_DB) {
      this.noiseFloorDb = clampFloor(mean(levels));
      return null;
    }
    const out = new Float32Array(frames.length * FRAME);
    frames.forEach((f, i) => out.set(f.samples, i * FRAME));
    return out;
  }

  private streamPush(frames: Frame[]): void {
    if (!this.stream || frames.length === 0) return;
    this.streamBuf.push(...frames);
    if (this.streamBuf.length >= STREAM_FRAMES) this.streamFlush();
  }

  private streamFlush(): void {
    if (!this.stream || this.streamBuf.length === 0) return;
    const out = new Float32Array(this.streamBuf.length * FRAME);
    this.streamBuf.forEach((f, i) => out.set(f.samples, i * FRAME));
    this.streamBuf = [];
    this.stream.audio(this.utterance, out);
  }

  private streamEnd(): void {
    if (!this.stream) return;
    this.streamFlush();
    this.stream.end(this.utterance);
  }
}

interface Frame {
  samples: Float32Array;
  db: number;
}

const CALIBRATION_FRAMES = 25;
const STEADY_NOISE_STD_DB = 2.5;

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
}

function stdDev(values: number[]): number {
  const m = mean(values);
  return Math.sqrt(mean(values.map((v) => (v - m) ** 2)));
}

function clampFloor(db: number): number {
  return Math.max(-90, Math.min(-25, db));
}

export const SEGMENTER_SAMPLE_RATE = SAMPLE_RATE;
