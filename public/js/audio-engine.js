/**
 * PolyglotAudioEngine — manages Web Audio API AudioWorklet chains for remote peers
 * and local self-monitoring ("Тест свого голосу") plus local VAD metering.
 */
class PolyglotAudioEngine {
  constructor() {
    this.ctx = null;
    this.workletLoaded = false;
    this.reverbBuffer = null;
    this.peerChains = new Map(); // clientId -> chain object
    this.selfMonitorChain = null;
    this.localStream = null;
    this.localAnalyser = null;
    this.localVadTimer = null;
    this.atmosphericEnabled = true;
    this.selfMonitorEnabled = false;
    this.selfMonitorMode = 'gibberish'; // 'gibberish' | 'atmospheric'
    this.currentSelfPreset = null;
    this.onLocalSpeakingChange = null;
    this.lastSpeakingState = false;
    this.lastSpeakingAt = 0;
  }

  async ensureInitialized() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioCtx({ latencyHint: 'interactive' });
    }
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
    if (!this.workletLoaded) {
      await this.ctx.audioWorklet.addModule('/js/scrambler-worklet.js');
      this.workletLoaded = true;
    }
    if (!this.reverbBuffer) {
      this.reverbBuffer = this.createImpulseResponse(1.65, 3.2);
    }
  }

  createImpulseResponse(durationSec, decay) {
    const rate = this.ctx.sampleRate;
    const length = Math.floor(rate * durationSec);
    const impulse = this.ctx.createBuffer(2, length, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = impulse.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        const env = Math.pow(1 - i / length, decay);
        data[i] = (Math.random() * 2 - 1) * env;
      }
    }
    return impulse;
  }

  createProcessingChain(stream, initialMode = 'CLEAN', initialPreset = null) {
    const ctx = this.ctx;
    const source = ctx.createMediaStreamSource(stream);

    // Granular AudioWorklet processor
    const scrambler = new AudioWorkletNode(ctx, 'polyglot-scrambler-processor');

    // Formant / flavor filter
    const filter = ctx.createBiquadFilter();
    filter.type = 'allpass';
    filter.frequency.value = 1000;
    filter.Q.value = 1.2;

    // Simple LFO-modulated chorus
    const chorusDelay = ctx.createDelay(0.1);
    chorusDelay.delayTime.value = 0.018;
    const chorusLfo = ctx.createOscillator();
    chorusLfo.type = 'sine';
    chorusLfo.frequency.value = 1.8;
    const chorusLfoGain = ctx.createGain();
    chorusLfoGain.gain.value = 0.004;
    chorusLfo.connect(chorusLfoGain);
    chorusLfoGain.connect(chorusDelay.delayTime);
    chorusLfo.start();

    const chorusWetGain = ctx.createGain();
    chorusWetGain.gain.value = 0;

    // Synthetic cathedral / cavern reverb
    const convolver = ctx.createConvolver();
    convolver.buffer = this.reverbBuffer;
    const reverbWetGain = ctx.createGain();
    reverbWetGain.gain.value = 0;

    // Direct signal vs clean bypass
    const dryGain = ctx.createGain();
    dryGain.gain.value = 1;
    const processedGain = ctx.createGain();
    processedGain.gain.value = 0;

    // Master output gain for this stream
    const masterGain = ctx.createGain();
    masterGain.gain.value = 1.0;

    // Wire graph:
    // Path 1: clean direct path (used in CLEAN mode)
    source.connect(dryGain);
    dryGain.connect(masterGain);

    // Path 2: scrambler -> filter -> processedGain (+ chorus + reverb)
    source.connect(scrambler);
    scrambler.connect(filter);
    filter.connect(processedGain);
    processedGain.connect(masterGain);

    filter.connect(chorusDelay);
    chorusDelay.connect(chorusWetGain);
    chorusWetGain.connect(masterGain);

    filter.connect(convolver);
    convolver.connect(reverbWetGain);
    reverbWetGain.connect(masterGain);

    masterGain.connect(ctx.destination);

    const chain = {
      source,
      scrambler,
      filter,
      chorusDelay,
      chorusLfo,
      chorusWetGain,
      convolver,
      reverbWetGain,
      dryGain,
      processedGain,
      masterGain,
      audioEl: null,
      mode: initialMode,
      preset: initialPreset
    };

    this.applyChainState(chain, initialMode, initialPreset);
    return chain;
  }

  applyChainState(chain, mode, preset) {
    if (!chain || !this.ctx) return;
    const now = this.ctx.currentTime;
    const tau = 0.035;
    const p = preset || {
      grainSizeMs: 145,
      pitchRatio: 1.0,
      formantShiftHz: 0,
      subOctaveMix: 0,
      ringModHz: 0,
      ringModMix: 0,
      reverbMix: 0,
      chorusMix: 0,
      filterType: 'allpass',
      filterFreq: 1000,
      atmosphereMix: 0
    };

    chain.mode = mode;
    chain.preset = p;

    const params = chain.scrambler.parameters;

    if (mode === 'CLEAN') {
      chain.dryGain.gain.setTargetAtTime(1.0, now, tau);
      chain.processedGain.gain.setTargetAtTime(0.0, now, tau);
      chain.chorusWetGain.gain.setTargetAtTime(0.0, now, tau);
      chain.reverbWetGain.gain.setTargetAtTime(0.0, now, tau);
      params.get('scrambleAmount').setTargetAtTime(0.0, now, tau);
      params.get('subOctaveMix').setTargetAtTime(0.0, now, tau);
      params.get('ringModMix').setTargetAtTime(0.0, now, tau);
      return;
    }

    if (mode === 'ATMOSPHERIC') {
      // 100% intelligible words + subtle atmospheric vocal color
      const atmo = Math.max(0.08, Math.min(0.4, p.atmosphereMix || 0.22));
      chain.dryGain.gain.setTargetAtTime(0.25, now, tau);
      chain.processedGain.gain.setTargetAtTime(0.85, now, tau);

      params.get('scrambleAmount').setTargetAtTime(0.0, now, tau);
      params.get('grainSizeMs').setTargetAtTime(p.grainSizeMs || 145, now, tau);
      params.get('pitchRatio').setTargetAtTime(1.0, now, tau);
      params.get('subOctaveMix').setTargetAtTime((p.subOctaveMix || 0) * atmo * 1.3, now, tau);
      params.get('ringModHz').setTargetAtTime(p.ringModHz || 0, now, tau);
      params.get('ringModMix').setTargetAtTime((p.ringModMix || 0) * atmo * 1.1, now, tau);

      chain.filter.type = p.filterType === 'bandpass' ? 'peaking' : (p.filterType || 'allpass');
      chain.filter.frequency.setTargetAtTime(Math.max(120, Math.min(8000, p.filterFreq || 1200)), now, tau);
      chain.filter.gain.setTargetAtTime(4.0, now, tau);

      chain.chorusWetGain.gain.setTargetAtTime((p.chorusMix || 0) * atmo * 1.4, now, tau);
      chain.reverbWetGain.gain.setTargetAtTime((p.reverbMix || 0) * atmo * 1.6, now, tau);
      return;
    }

    // GIBBERISH mode: 0% dry, 100% granular syllable reversal + acoustic flavor
    chain.dryGain.gain.setTargetAtTime(0.0, now, tau);
    chain.processedGain.gain.setTargetAtTime(1.0, now, tau);

    params.get('scrambleAmount').setTargetAtTime(1.0, now, tau);
    params.get('grainSizeMs').setTargetAtTime(p.grainSizeMs || 145, now, tau);
    params.get('pitchRatio').setTargetAtTime(p.pitchRatio || 1.0, now, tau);
    params.get('subOctaveMix').setTargetAtTime(p.subOctaveMix || 0, now, tau);
    params.get('ringModHz').setTargetAtTime(p.ringModHz || 0, now, tau);
    params.get('ringModMix').setTargetAtTime(p.ringModMix || 0, now, tau);

    const shiftedFreq = Math.max(120, Math.min(7500, (p.filterFreq || 1200) + (p.formantShiftHz || 0)));
    chain.filter.type = p.filterType || 'bandpass';
    chain.filter.frequency.setTargetAtTime(shiftedFreq, now, tau);
    chain.filter.Q.setTargetAtTime(p.filterType === 'bandpass' ? 1.15 : 0.9, now, tau);
    chain.filter.gain.setTargetAtTime(6.0, now, tau);

    chain.chorusWetGain.gain.setTargetAtTime(p.chorusMix || 0, now, tau);
    chain.reverbWetGain.gain.setTargetAtTime(p.reverbMix || 0, now, tau);
  }

  resolveModeForPeer(peerState) {
    if (!peerState) return 'CLEAN';
    if (!peerState.understood) return 'GIBBERISH';
    if (peerState.languageId === 'common') return 'CLEAN';
    return this.atmosphericEnabled ? 'ATMOSPHERIC' : 'CLEAN';
  }

  async attachPeerStream(clientId, stream, peerState) {
    await this.ensureInitialized();
    this.detachPeerStream(clientId);

    // Muted hidden <audio> element forces Chromium to pump remote WebRTC MediaStream frames
    const audioEl = document.createElement('audio');
    audioEl.srcObject = stream;
    audioEl.muted = true;
    audioEl.playsInline = true;
    audioEl.play().catch(() => {});

    const mode = this.resolveModeForPeer(peerState);
    const chain = this.createProcessingChain(stream, mode, peerState?.dspPreset || null);
    chain.audioEl = audioEl;
    chain.peerState = peerState;
    this.peerChains.set(clientId, chain);
  }

  updatePeerLanguage(clientId, peerState) {
    const chain = this.peerChains.get(clientId);
    if (!chain) return;
    chain.peerState = peerState;
    const mode = this.resolveModeForPeer(peerState);
    this.applyChainState(chain, mode, peerState?.dspPreset || null);
  }

  setPeerVolume(clientId, volume) {
    const chain = this.peerChains.get(clientId);
    if (!chain || !this.ctx) return;
    chain.masterGain.gain.setTargetAtTime(Math.max(0, Math.min(2, volume)), this.ctx.currentTime, 0.02);
  }

  detachPeerStream(clientId) {
    const chain = this.peerChains.get(clientId);
    if (!chain) return;
    this.destroyChain(chain);
    this.peerChains.delete(clientId);
  }

  destroyChain(chain) {
    try {
      chain.chorusLfo.stop();
    } catch {}
    try {
      chain.source.disconnect();
      chain.scrambler.disconnect();
      chain.filter.disconnect();
      chain.chorusDelay.disconnect();
      chain.chorusWetGain.disconnect();
      chain.convolver.disconnect();
      chain.reverbWetGain.disconnect();
      chain.dryGain.disconnect();
      chain.processedGain.disconnect();
      chain.masterGain.disconnect();
    } catch {}
    if (chain.audioEl) {
      chain.audioEl.srcObject = null;
    }
  }

  async setLocalStream(stream) {
    this.localStream = stream;
    await this.ensureInitialized();

    if (this.localVadTimer) {
      clearInterval(this.localVadTimer);
      this.localVadTimer = null;
    }

    if (!stream) {
      if (this.selfMonitorChain) {
        this.destroyChain(this.selfMonitorChain);
        this.selfMonitorChain = null;
      }
      return;
    }

    const src = this.ctx.createMediaStreamSource(stream);
    this.localAnalyser = this.ctx.createAnalyser();
    this.localAnalyser.fftSize = 512;
    src.connect(this.localAnalyser);

    const data = new Float32Array(this.localAnalyser.fftSize);
    this.localVadTimer = setInterval(() => {
      if (!this.localAnalyser) return;
      const track = this.localStream?.getAudioTracks()[0];
      const muted = !track || !track.enabled;
      if (muted) {
        if (this.lastSpeakingState) {
          this.lastSpeakingState = false;
          this.onLocalSpeakingChange?.(false, 0);
        }
        return;
      }

      this.localAnalyser.getFloatTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      const rms = Math.sqrt(sum / data.length);
      const level = Math.min(1, rms * 8);
      const now = Date.now();
      const speakingNow = rms > 0.014;
      if (speakingNow) this.lastSpeakingAt = now;

      const isSpeaking = speakingNow || (now - this.lastSpeakingAt < 320);
      if (isSpeaking !== this.lastSpeakingState || isSpeaking) {
        this.lastSpeakingState = isSpeaking;
        this.onLocalSpeakingChange?.(isSpeaking, Number(level.toFixed(2)));
      }
    }, 80);

    if (this.selfMonitorEnabled) {
      await this.enableSelfMonitor(true);
    }
  }

  setAtmosphericEnabled(enabled) {
    this.atmosphericEnabled = !!enabled;
    for (const chain of this.peerChains.values()) {
      const mode = this.resolveModeForPeer(chain.peerState);
      this.applyChainState(chain, mode, chain.peerState?.dspPreset || null);
    }
    this.refreshSelfMonitor();
  }

  async enableSelfMonitor(enabled) {
    this.selfMonitorEnabled = !!enabled;
    if (!this.selfMonitorEnabled) {
      if (this.selfMonitorChain) {
        this.destroyChain(this.selfMonitorChain);
        this.selfMonitorChain = null;
      }
      return;
    }

    if (!this.localStream) return;
    await this.ensureInitialized();
    if (this.selfMonitorChain) {
      this.destroyChain(this.selfMonitorChain);
    }

    const mode = this.resolveSelfMonitorMode();
    this.selfMonitorChain = this.createProcessingChain(this.localStream, mode, this.currentSelfPreset);
  }

  setSelfMonitorMode(mode) {
    this.selfMonitorMode = mode === 'atmospheric' ? 'atmospheric' : 'gibberish';
    this.refreshSelfMonitor();
  }

  updateSelfLanguagePreset(languageObj) {
    this.currentSelfPreset = languageObj?.dspPreset || null;
    this.currentSelfLanguageId = languageObj?.id || 'common';
    this.refreshSelfMonitor();
  }

  resolveSelfMonitorMode() {
    if (this.currentSelfLanguageId === 'common') return 'CLEAN';
    if (this.selfMonitorMode === 'gibberish') return 'GIBBERISH';
    return 'ATMOSPHERIC';
  }

  refreshSelfMonitor() {
    if (!this.selfMonitorChain) return;
    const mode = this.resolveSelfMonitorMode();
    this.applyChainState(this.selfMonitorChain, mode, this.currentSelfPreset);
  }
}

window.PolyglotAudioEngine = PolyglotAudioEngine;
