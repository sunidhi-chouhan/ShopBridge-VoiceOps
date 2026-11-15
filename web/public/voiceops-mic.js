// AudioWorklet: resamples microphone audio to 16 kHz mono PCM16 and posts 100 ms chunks.
class VoiceOpsMic extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.t = 0;
    this.carry = new Float32Array(0);
    this.out = new Int16Array(1600);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    const input = new Float32Array(this.carry.length + ch.length);
    input.set(this.carry, 0);
    input.set(ch, this.carry.length);
    while (this.t + 1 < input.length) {
      const i = Math.floor(this.t);
      const f = this.t - i;
      const v = input[i] + (input[i + 1] - input[i]) * f;
      this.out[this.n++] = Math.max(-1, Math.min(1, v)) * 32767;
      if (this.n === this.out.length) {
        this.port.postMessage(this.out.buffer, [this.out.buffer]);
        this.out = new Int16Array(1600);
        this.n = 0;
      }
      this.t += this.ratio;
    }
    const keep = Math.floor(this.t);
    this.carry = input.slice(keep);
    this.t -= keep;
    return true;
  }
}
registerProcessor("voiceops-mic", VoiceOpsMic);
