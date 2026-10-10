// 마이크 하나를 열어 16kHz 로 바꾼 뒤 Segmenter 에 흘려 넣는다.
import { StreamingDownsampler } from './resampler';
import { NORMAL_PARAMS, Segmenter, paramsFor } from './segmenter';
import type { LatencyMode, QuotaPressure } from '../../shared/types';

export interface MicCaptureOptions {
  deviceId: string;
  onSegment: (pcm16k: Float32Array) => void;
  onLevel?: (db: number, speaking: boolean) => void;
}

export class MicCapture {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private readonly segmenter: Segmenter;

  constructor(private readonly options: MicCaptureOptions) {
    this.segmenter = new Segmenter(NORMAL_PARAMS, options.onSegment, options.onLevel);
  }

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: this.options.deviceId ? { exact: this.options.deviceId } : undefined,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    this.context = new AudioContext();
    if (this.context.state === 'suspended') await this.context.resume();
    await this.context.audioWorklet.addModule('capture-worklet.js');
    const downsampler = new StreamingDownsampler(this.context.sampleRate, 16000);
    const source = this.context.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.context, 'capture-processor', { numberOfOutputs: 1 });
    this.node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      this.segmenter.push(downsampler.process(event.data));
    };
    // 출력은 소리 없이 destination 에 연결해야 브라우저가 노드를 계속 처리한다
    const mute = this.context.createGain();
    mute.gain.value = 0;
    source.connect(this.node);
    this.node.connect(mute);
    mute.connect(this.context.destination);
  }

  /** 속도 설정·한도 상황에 맞춰 구간 길이를 바꾼다 */
  setTuning(mode: LatencyMode, pressure: QuotaPressure): void {
    this.segmenter.setParams(paramsFor(mode, pressure));
  }

  async stop(): Promise<void> {
    this.segmenter.flush();
    this.node?.port.close();
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    await this.context?.close().catch(() => undefined);
    this.node = null;
    this.stream = null;
    this.context = null;
  }
}

export async function listMicrophones(): Promise<MediaDeviceInfo[]> {
  // 장치 이름을 보려면 한 번은 마이크 권한을 받아야 한다
  try {
    const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
    probe.getTracks().forEach((t) => t.stop());
  } catch {
    // 권한이 없으면 이름 없이 목록만 보여준다
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications');
}
