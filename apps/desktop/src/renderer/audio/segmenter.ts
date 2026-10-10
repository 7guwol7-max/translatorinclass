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

/** 빠르게: 짧은 쉼에서 바로 보내 말이 끝나고 1~2초 안에 자막이 나오게 (요청 수는 늘어남) */
export const FAST_PARAMS: SegmenterParams = {
  ...NORMAL_PARAMS,
  minSegmentSec: 1.2,
  maxSegmentSec: 7,
  pauseMs: 450,
  flushSilenceMs: 800,
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

const SAMPLE_RATE = 16000;
const FRAME = 320; // 20ms
const FRAME_MS = 20;
const ONSET_FRAMES = 3; // 60ms 연속으로 커야 말 시작
const TAIL_KEEP_FRAMES = 10; // 끝부분 무음은 200ms 만 남긴다

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

  constructor(
    params: SegmenterParams,
    private readonly onSegment: (pcm: Float32Array) => void,
    private readonly onLevel?: (db: number, speaking: boolean) => void,
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

    if (silenceMs >= p.pauseMs && voicedSec >= p.minSegmentSec) {
      this.finish(false);
    } else if (silenceMs >= p.flushSilenceMs) {
      this.finish(false);
    } else if (totalSec >= p.maxSegmentSec) {
      const stillSpeaking = this.trailingSilence === 0;
      this.finish(false);
      if (stillSpeaking) this.begin(); // 말이 계속되면 바로 다음 구간 시작
    }
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

  private begin(): void {
    this.active = true;
    this.frames = [...this.preRoll, ...this.onsetFrames];
    this.speechFrames = this.onsetFrames.length;
    this.trailingSilence = 0;
    this.preRoll = [];
    this.onsetFrames = [];
    this.onsetRun = 0;
  }

  private finish(force: boolean): void {
    const speechSec = (this.speechFrames * FRAME_MS) / 1000;
    const keep = this.frames.length - Math.max(0, this.trailingSilence - TAIL_KEEP_FRAMES);
    const frames = this.frames.slice(0, keep);
    this.active = false;
    this.frames = [];
    this.speechFrames = 0;
    this.trailingSilence = 0;
    if (speechSec < this.params.minSpeechSec && !(force && speechSec > 0.3)) return;

    // 말소리는 음절마다 크기가 오르내린다. 크기가 거의 일정하면 선풍기 같은 지속 소음으로 보고 버린다.
    const levels = frames.map((f) => f.db);
    if (stdDev(levels) < STEADY_NOISE_STD_DB) {
      this.noiseFloorDb = clampFloor(mean(levels));
      return;
    }

    const out = new Float32Array(frames.length * FRAME);
    frames.forEach((f, i) => out.set(f.samples, i * FRAME));
    this.onSegment(out);
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
