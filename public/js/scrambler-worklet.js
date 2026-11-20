/**
 * PolyglotScramblerProcessor — real-time vocoder-resynthesis gibberish & smart noise gate.
 * Combines:
 *  1) Smart envelope noise gate with hold/release so pauses are completely silent.
 *  2) Active-voice ring buffer with distant syllable permutation & reversal.
 *  3) Dual-band Chamberlin SVF formant vowel morpher + consonant burst synthesis
 *     driven by the speaker's cadence, pitch, and dynamics so original words are
 *     100% unintelligible while sounding like organic fantasy speech.
 */
class PolyglotScramblerProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'scrambleAmount', defaultValue: 1.0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'grainSizeMs', defaultValue: 145, minValue: 60, maxValue: 280, automationRate: 'k-rate' },
      { name: 'pitchRatio', defaultValue: 1.0, minValue: 0.5, maxValue: 1.8, automationRate: 'k-rate' },
      { name: 'subOctaveMix', defaultValue: 0.0, minValue: 0, maxValue: 1.0, automationRate: 'k-rate' },
      { name: 'ringModHz', defaultValue: 0.0, minValue: 0, maxValue: 400, automationRate: 'k-rate' },
      { name: 'ringModMix', defaultValue: 0.0, minValue: 0, maxValue: 1.0, automationRate: 'k-rate' },
      { name: 'noiseGateThreshold', defaultValue: 0.015, minValue: 0.001, maxValue: 0.15, automationRate: 'k-rate' }
    ];
  }

  constructor() {
    super();
    this.bufSize = 96000; // 2 seconds of active speech @ 48kHz
    this.ring = new Float32Array(this.bufSize);
    this.writeIdx = 0;
    this.activeWritten = 0;

    // Permutation offsets for distant syllable jumps
    this.permOffsets = [0.35, 0.72, 0.18, 0.55, 0.85, 0.42];
    this.permIdx = 0;

    // Two overlapping grains staggered by 50%
    this.grainA = { active: false, pos: 0, anchor: 0, len: 6720, rate: 1.0 };
    this.grainB = { active: false, pos: 3360, anchor: 0, len: 6720, rate: 1.0 };
    this.grainCounter = 0;

    // Noise gate & syllable onset detection
    this.fastEnv = 0;
    this.slowEnv = 0;
    this.gateGain = 0;
    this.holdSamples = 0;
    this.syllableCooldown = 0;

    // Dual-band formant vowel morpher state (Chamberlin SVF)
    this.vowels = [
      [420, 1850],
      [650, 1150],
      [310, 2250],
      [520, 1400],
      [360, 1050],
      [580, 1980]
    ];
    this.targetF1 = 420;
    this.targetF2 = 1850;
    this.curF1 = 420;
    this.curF2 = 1850;
    this.svf1 = { lp: 0, bp: 0 };
    this.svf2 = { lp: 0, bp: 0 };
    this.burstEnv = 0;
    this.consLp = 0;

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

  triggerSyllableMorph(pitchRatio) {
    const idx = Math.floor(this.nextRand() * this.vowels.length);
    const pair = this.vowels[idx];
    const pScale = Math.max(0.72, Math.min(1.38, pitchRatio));
    this.targetF1 = pair[0] * pScale;
    this.targetF2 = pair[1] * pScale;
    this.burstEnv = 1.0;
    this.syllableCooldown = Math.round(0.085 * sampleRate);
  }

  resetGrain(grain, grainLen, pitchRatio) {
    grain.active = true;
    grain.pos = 0;
    grain.len = grainLen;
    const jitter = 0.92 + this.nextRand() * 0.16;
    grain.rate = Math.max(0.45, Math.min(1.9, pitchRatio * jitter));

    const neededBack = Math.ceil(grainLen * grain.rate) + 32;
    const maxAvail = Math.min(this.activeWritten, Math.round(sampleRate * 1.4));

    let offsetBack = 16;
    if (maxAvail > neededBack * 2) {
      const permFrac = this.permOffsets[this.permIdx % this.permOffsets.length];
      this.permIdx++;
      const lookbackSpan = maxAvail - neededBack;
      offsetBack = Math.max(16, Math.min(lookbackSpan, Math.floor(permFrac * lookbackSpan)));
    }

    grain.anchor = (this.writeIdx - offsetBack + this.bufSize) % this.bufSize;
  }

  stepSvf(svf, input, freqHz, qInv) {
    const safeFreq = Math.max(120, Math.min(sampleRate * 0.21, freqHz));
    const f = 2 * Math.sin((Math.PI * safeFreq) / (sampleRate * 2));
    for (let s = 0; s < 2; s++) {
      const hp = input - svf.lp - qInv * svf.bp;
      svf.bp += f * hp;
      svf.lp += f * svf.bp;
    }
    return svf.bp;
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
    const noiseGateThreshold = parameters.noiseGateThreshold[0];

    const grainLen = Math.max(2048, Math.min(18000, Math.round((grainSizeMs / 1000) * sampleRate)));
    const halfLen = Math.floor(grainLen / 2);
    const ringInc = (2 * Math.PI * ringModHz) / sampleRate;

    const attackAlpha = 1 - Math.exp(-1 / (0.004 * sampleRate));
    const releaseAlpha = 1 - Math.exp(-1 / (0.070 * sampleRate));
    const fastAttack = 1 - Math.exp(-1 / (0.003 * sampleRate));
    const fastRelease = 1 - Math.exp(-1 / (0.035 * sampleRate));
    const holdLimit = Math.round(0.320 * sampleRate);

    for (let i = 0; i < outCh0.length; i++) {
      const dry = inCh0[i];
      const absDry = Math.abs(dry);

      // Envelope followers for smart gate & syllable onset detection
      this.fastEnv += (absDry - this.fastEnv) * (absDry > this.fastEnv ? fastAttack : fastRelease);
      this.slowEnv = this.slowEnv * 0.99985 + absDry * 0.00015;

      if (this.fastEnv >= noiseGateThreshold) {
        this.holdSamples = holdLimit;
      } else if (this.holdSamples > 0) {
        this.holdSamples--;
      }

      const gateTarget = this.holdSamples > 0 ? 1.0 : 0.0;
      const gAlpha = gateTarget > this.gateGain ? attackAlpha : releaseAlpha;
      this.gateGain += (gateTarget - this.gateGain) * gAlpha;
      if (this.gateGain < 0.0001 && gateTarget === 0) this.gateGain = 0;

      // Only record active speech phonemes into the vocal ring buffer
      if (this.gateGain > 0.1) {
        this.ring[this.writeIdx] = dry;
        this.writeIdx = (this.writeIdx + 1) % this.bufSize;
        if (this.activeWritten < this.bufSize) this.activeWritten++;
      }

      if (this.syllableCooldown > 0) this.syllableCooldown--;
      if (this.gateGain > 0.25 && this.fastEnv > this.slowEnv * 1.45 && this.syllableCooldown === 0) {
        this.triggerSyllableMorph(pitchRatio);
      }

      // Trigger staggered overlapping grains
      if (this.grainCounter === 0) {
        this.resetGrain(this.grainA, grainLen, pitchRatio);
        if (this.syllableCooldown === 0 && this.gateGain > 0.25) {
          this.triggerSyllableMorph(pitchRatio);
        }
      } else if (this.grainCounter === halfLen) {
        this.resetGrain(this.grainB, grainLen, pitchRatio);
      }
      this.grainCounter = (this.grainCounter + 1) % grainLen;

      // Compute distant-permuted granular speech + vocoder formant resynthesis
      let scrambled = 0;
      if (scrambleAmount > 0.001 && this.gateGain > 0.001) {
        let gSum = 0;
        if (this.grainA.active) {
          const wA = this.hann(this.grainA.pos, this.grainA.len);
          const readIdxA = this.grainA.anchor - this.grainA.pos * this.grainA.rate;
          gSum += this.readRingLinear(readIdxA) * wA;
          this.grainA.pos++;
          if (this.grainA.pos >= this.grainA.len) this.grainA.active = false;
        }
        if (this.grainB.active) {
          const wB = this.hann(this.grainB.pos, this.grainB.len);
          const readIdxB = this.grainB.anchor - this.grainB.pos * this.grainB.rate;
          gSum += this.readRingLinear(readIdxB) * wB;
          this.grainB.pos++;
          if (this.grainB.pos >= this.grainB.len) this.grainB.active = false;
        }

        // Smooth formant transition (diphthong glide)
        this.curF1 += (this.targetF1 - this.curF1) * 0.008;
        this.curF2 += (this.targetF2 - this.curF2) * 0.008;

        const bp1 = this.stepSvf(this.svf1, gSum, this.curF1, 0.24);
        const bp2 = this.stepSvf(this.svf2, gSum, this.curF2, 0.26);

        // Consonant burst at start of each morphed syllable
        let cons = 0;
        if (this.burstEnv > 0.005) {
          const white = this.nextRand() * 2 - 1;
          this.consLp = this.consLp * 0.45 + white * 0.55;
          cons = (white - this.consLp) * this.burstEnv * Math.min(0.4, this.fastEnv * 2.2);
          this.burstEnv *= 0.9985;
        }

        // Full formant-morphed synthetic syllable driven by speaker cadence
        scrambled = (bp1 * 1.15 + bp2 * 0.85 + gSum * 0.14 + cons * 0.85) * 1.25;
      }

      // Base mix between unscrambled and vocoder-resynthesized speech
      let sig = dry * (1 - scrambleAmount) + scrambled * scrambleAmount;

      // Envelope follower + pitch-tracking sub-octave divider (only when gate is open)
      this.env = absDry > this.env ? this.env * 0.9 + absDry * 0.1 : this.env * 0.996 + absDry * 0.004;
      const prevLp = this.lpSignal;
      this.lpSignal = this.lpSignal * 0.92 + dry * 0.08;
      if (prevLp <= 0.0015 && this.lpSignal > 0.0015) {
        this.subSign = -this.subSign;
      }
      this.subLp = this.subLp * 0.86 + this.subSign * this.env * 0.14;

      const gateActive = scrambleAmount < 0.01 || this.gateGain > 0.01;
      if (subOctaveMix > 0.001 && gateActive) {
        sig += this.subLp * subOctaveMix * 1.45;
      }

      // Ring modulation (metallic/otherworldly voice texture)
      if (ringModHz > 1 && ringModMix > 0.001 && gateActive) {
        this.ringPhase += ringInc;
        if (this.ringPhase > Math.PI * 2) this.ringPhase -= Math.PI * 2;
        const mod = Math.sin(this.ringPhase);
        sig = sig * (1 - ringModMix) + sig * mod * ringModMix * 1.35;
      }

      // Apply noise gate cleanly only during gibberish synthesis so normal speech never gets chopped
      if (scrambleAmount >= 0.01) {
        sig *= this.gateGain;
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

/**
 * PolyglotRelayTapProcessor — replaces the deprecated ScriptProcessorNode used
 * for the WebSocket audio fallback. Encoding runs on the audio render thread,
 * and completed 20 ms Int16 chunks are transferred (zero-copy) to the main
 * thread. The node itself outputs silence; it is only tapped for capture.
 */
class PolyglotRelayTapProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    const protocol = globalThis.RelayProtocol;
    if (!protocol) {
      throw new Error('RelayProtocol must be loaded before polyglot-relay-tap-processor');
    }
    this.enabledFromPort = false;
    this.outputRate = protocol.RELAY_TARGET_RATE;
    this.encoder = new protocol.RelayPcmEncoder({
      inputRate: sampleRate,
      outputRate: this.outputRate,
      chunkSamples: protocol.RELAY_CHUNK_SAMPLES,
      gateThreshold: 0.0008,
      holdMs: 800
    });
    this.port.onmessage = (event) => {
      const data = event.data || {};
      if (typeof data.enabled === 'boolean') this.enabledFromPort = data.enabled;
      if (data.reset === true) this.encoder.reset();
    };
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (output && output[0]) {
      for (let ch = 0; ch < output.length; ch++) output[ch].fill(0);
    }

    const input = inputs[0] && inputs[0][0];
    if (this.enabledFromPort && input) {
      const chunks = this.encoder.push(input, currentTime * 1000);
      for (const chunk of chunks) {
        // Transfer the underlying buffer to the main thread (zero copy).
        const buffer = chunk.buffer;
        this.port.postMessage({ pcm: buffer, sampleRate: this.outputRate }, [buffer]);
      }
    }
    return true;
  }
}

registerProcessor('polyglot-relay-tap-processor', PolyglotRelayTapProcessor);
