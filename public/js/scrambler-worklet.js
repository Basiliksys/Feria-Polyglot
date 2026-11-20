/**
 * PolyglotScramblerProcessor — real-time granular syllable-reversal & vocal flavor DSP.
 * Preserves speech cadence, pauses, volume, and emotion while scrambling phonemes
 * into unintelligible fantasy speech when scrambleAmount > 0.
 */
class PolyglotScramblerProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'scrambleAmount', defaultValue: 1.0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'grainSizeMs', defaultValue: 145, minValue: 60, maxValue: 280, automationRate: 'k-rate' },
      { name: 'pitchRatio', defaultValue: 1.0, minValue: 0.5, maxValue: 1.8, automationRate: 'k-rate' },
      { name: 'subOctaveMix', defaultValue: 0.0, minValue: 0, maxValue: 1.0, automationRate: 'k-rate' },
      { name: 'ringModHz', defaultValue: 0.0, minValue: 0, maxValue: 400, automationRate: 'k-rate' },
      { name: 'ringModMix', defaultValue: 0.0, minValue: 0, maxValue: 1.0, automationRate: 'k-rate' }
    ];
  }

  constructor() {
    super();
    this.bufSize = 96000; // 2 seconds @ 48kHz
    this.ring = new Float32Array(this.bufSize);
    this.writeIdx = 0;

    // Two overlapping grains staggered by 50%
    this.grainA = { active: false, pos: 0, anchor: 0, len: 6720, rate: 1.0 };
    this.grainB = { active: false, pos: 3360, anchor: 0, len: 6720, rate: 1.0 };
    this.grainCounter = 0;

    // Sub-octave & ring-mod state
    this.lpSignal = 0;
    this.subSign = 1;
    this.env = 0;
    this.subLp = 0;
    this.ringPhase = 0;
    this.prngState = 1337;
  }

  nextRand() {
    this.prngState = (Math.imul(this.prngState, 1664525) + 1013904223) >>> 0;
    return this.prngState / 4294967296;
  }

  readRingLinear(floatIdx) {
    let idx = floatIdx % this.bufSize;
    if (idx < 0) idx += this.bufSize;
    const i0 = Math.floor(idx);
    const i1 = (i0 + 1) % this.bufSize;
    const frac = idx - i0;
    return this.ring[i0] * (1 - frac) + this.ring[i1] * frac;
  }

  hann(phase, len) {
    return 0.5 * (1 - Math.cos((2 * Math.PI * phase) / len));
  }

  resetGrain(grain, grainLen, pitchRatio) {
    grain.active = true;
    grain.pos = 0;
    grain.len = grainLen;
    // Slight per-grain prosody variation (±6%) + occasional syllable offset
    const jitter = 0.94 + this.nextRand() * 0.12;
    grain.rate = Math.max(0.45, Math.min(1.9, pitchRatio * jitter));
    const offsetBack = this.nextRand() < 0.35 ? Math.floor(grainLen * 0.25) : 1;
    grain.anchor = (this.writeIdx - offsetBack + this.bufSize) % this.bufSize;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const outCh0 = output[0];
    const inCh0 = input && input.length > 0 ? input[0] : null;
    if (!inCh0) {
      outCh0.fill(0);
      for (let ch = 1; ch < output.length; ch++) output[ch].fill(0);
      return true;
    }

    const scrambleAmount = parameters.scrambleAmount[0];
    const grainSizeMs = parameters.grainSizeMs[0];
    const pitchRatio = parameters.pitchRatio[0];
    const subOctaveMix = parameters.subOctaveMix[0];
    const ringModHz = parameters.ringModHz[0];
    const ringModMix = parameters.ringModMix[0];

    const grainLen = Math.max(2048, Math.min(18000, Math.round((grainSizeMs / 1000) * sampleRate)));
    const halfLen = Math.floor(grainLen / 2);
    const ringInc = (2 * Math.PI * ringModHz) / sampleRate;

    for (let i = 0; i < outCh0.length; i++) {
      const dry = inCh0[i];

      // Write incoming sample into circular history
      this.ring[this.writeIdx] = dry;
      this.writeIdx = (this.writeIdx + 1) % this.bufSize;

      // Trigger staggered overlapping grains
      if (this.grainCounter === 0) {
        this.resetGrain(this.grainA, grainLen, pitchRatio);
      } else if (this.grainCounter === halfLen) {
        this.resetGrain(this.grainB, grainLen, pitchRatio);
      }
      this.grainCounter = (this.grainCounter + 1) % grainLen;

      // Compute granular reversed speech
      let scrambled = 0;
      if (scrambleAmount > 0.001) {
        if (this.grainA.active) {
          const wA = this.hann(this.grainA.pos, this.grainA.len);
          const readIdxA = this.grainA.anchor - this.grainA.pos * this.grainA.rate;
          scrambled += this.readRingLinear(readIdxA) * wA;
          this.grainA.pos++;
          if (this.grainA.pos >= this.grainA.len) this.grainA.active = false;
        }
        if (this.grainB.active) {
          const wB = this.hann(this.grainB.pos, this.grainB.len);
          const readIdxB = this.grainB.anchor - this.grainB.pos * this.grainB.rate;
          scrambled += this.readRingLinear(readIdxB) * wB;
          this.grainB.pos++;
          if (this.grainB.pos >= this.grainB.len) this.grainB.active = false;
        }
        scrambled *= 1.15;
      }

      // Base mix between unscrambled and scrambled voice
      let sig = dry * (1 - scrambleAmount) + scrambled * scrambleAmount;

      // Envelope follower + pitch-tracking sub-octave divider
      const absDry = Math.abs(dry);
      this.env = absDry > this.env ? this.env * 0.9 + absDry * 0.1 : this.env * 0.996 + absDry * 0.004;
      const prevLp = this.lpSignal;
      this.lpSignal = this.lpSignal * 0.92 + dry * 0.08;
      if (prevLp <= 0.0015 && this.lpSignal > 0.0015) {
        this.subSign = -this.subSign;
      }
      this.subLp = this.subLp * 0.86 + this.subSign * this.env * 0.14;

      if (subOctaveMix > 0.001) {
        sig = sig + this.subLp * subOctaveMix * 1.45;
      }

      // Ring modulation (metallic/otherworldly voice texture)
      if (ringModHz > 1 && ringModMix > 0.001) {
        this.ringPhase += ringInc;
        if (this.ringPhase > Math.PI * 2) this.ringPhase -= Math.PI * 2;
        const mod = Math.sin(this.ringPhase);
        sig = sig * (1 - ringModMix) + sig * mod * ringModMix * 1.35;
      }

      // Soft limiter to prevent digital clipping
      if (sig > 0.95) sig = 0.95 + Math.tanh(sig - 0.95) * 0.05;
      else if (sig < -0.95) sig = -0.95 + Math.tanh(sig + 0.95) * 0.05;

      outCh0[i] = sig;
      for (let ch = 1; ch < output.length; ch++) {
        output[ch][i] = sig;
      }
    }

    return true;
  }
}

registerProcessor('polyglot-scrambler-processor', PolyglotScramblerProcessor);
