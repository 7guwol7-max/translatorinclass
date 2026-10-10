// 마이크 샘플레이트(보통 48kHz) → 16kHz 로 낮추는 스트리밍 다운샘플러.
// 출력 샘플 하나는 그 구간에 들어가는 입력 샘플들의 평균 (간단한 저역통과 역할).

export class StreamingDownsampler {
  private readonly ratio: number;
  private carry: Float32Array = new Float32Array(0);
  /** carry[0] 기준, 다음 출력 구간의 시작 위치 (소수) */
  private pos = 0;

  constructor(inputRate: number, outputRate = 16000) {
    if (inputRate < outputRate) throw new Error(`입력 샘플레이트(${inputRate})가 ${outputRate}보다 낮습니다`);
    this.ratio = inputRate / outputRate;
  }

  process(input: Float32Array): Float32Array {
    const buf = new Float32Array(this.carry.length + input.length);
    buf.set(this.carry, 0);
    buf.set(input, this.carry.length);

    const out: number[] = [];
    let pos = this.pos;
    while (pos + this.ratio <= buf.length) {
      const start = Math.floor(pos);
      const end = Math.max(start + 1, Math.floor(pos + this.ratio));
      let sum = 0;
      for (let i = start; i < end; i++) sum += buf[i];
      out.push(sum / (end - start));
      pos += this.ratio;
    }
    const keepFrom = Math.floor(pos);
    this.carry = buf.slice(keepFrom);
    this.pos = pos - keepFrom;
    return Float32Array.from(out);
  }
}
