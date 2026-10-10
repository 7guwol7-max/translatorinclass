// AudioWorklet: 마이크 입력을 모아서 약 40ms 단위로 메인 스레드에 넘긴다.
// (AudioWorkletGlobalScope 전용 파일 — 다른 모듈을 import 하지 않는다)

declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  abstract process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;

const CHUNK = 2048;

class CaptureProcessor extends AudioWorkletProcessor {
  private buffer = new Float32Array(CHUNK);
  private filled = 0;

  process(inputs: Float32Array[][]): boolean {
    const channels = inputs[0];
    if (!channels || channels.length === 0) return true;
    const length = channels[0].length;
    for (let i = 0; i < length; i++) {
      let sample = 0;
      for (const ch of channels) sample += ch[i];
      this.buffer[this.filled++] = sample / channels.length; // 여러 채널이면 평균(모노)
      if (this.filled === CHUNK) {
        this.port.postMessage(this.buffer, [this.buffer.buffer]);
        this.buffer = new Float32Array(CHUNK);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
