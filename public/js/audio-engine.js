/**
 * PolyglotAudioEngine — manages Web Audio API AudioWorklet chains (vocoder gibberish +
 * smart noise gate), local mic gating for WebRTC, self-monitoring ("Тест голосу"),
 * DM gibberish preview mode, and WebSocket PCM audio relay fallback.
 */
class PolyglotAudioEngine {
  constructor() {
    this.ctx = null;
    this.workletLoaded = false;
    this.reverbBuffer = null;

    this.peerChains = new Map(); // clientId -> chain object
    this.selfMonitorChain = null;

    this.rawLocalStream = null;
    this.gatedLocalStream = null;
    this.localSource = null;
    this.localHpFilter = null;
    this.localLpFilter = null;
    this.localGateGain = null;
    this.localDest = null;
    this.localAnalyser = null;
    this.localVadTimer = null;
    this.localGateOpen = false;
    this.gateHoldUntil = 0;

    // Relay capture node
    this.relayProcessor = null;
    this.relayTargetsCount = 0;
    this.onAudioRelayChunk = null;

    this.atmosphericEnabled = true;
    this.dmHearAsGibberish = false;
    this.selfMonitorEnabled = false;
    this.selfMonitorMode = 'gibberish'; // 'gibberish' | 'atmospheric'
    this.currentSelfPreset = null;
    this.currentSelfLanguageId = 'common';
    this.noiseGateThreshold = 0.015;

    this.onLocalSpeakingChange = null;
    this.lastSpeakingState = false;
    this.lastSpeakingAt = 0;

    this.demoGibberishPreset = {
      grainSizeMs: 145,
      pitchRatio: 0.88,
      formantShiftHz: -220,
      subOctaveMix: 0.15,
      ringModHz: 0,
      ringModMix: 0,
      reverbMix: 0.35,
      chorusMix: 0.25,
      filterType: 'bandpass',
      filterFreq: 1100,
      atmosphereMix: 0.22
    };
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
      this.reverbBuffer = this.createImpulseResponse(1.5, 3.4);
    }
  }

  createImpulseResponse(durationSec, decay) {
    const rate = this.ctx.sampleRate;
    const length = Math.floor(rate * durationSec);
    const impulse = this.ctx.createBuffer(2, length, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = impulse.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < length; i++) {
        const env = Math.pow(1 - i / length, decay);
        const white = (Math.random() * 2 - 1) * env;
        // Exponential low-pass smoothing removes high-frequency hiss from reverb tail
        lp = lp * 0.78 + white * 0.22;
        data[i] = lp;
      }
    }
    return impulse;
  }

  createProcessingChain(stream, initialMode = 'CLEAN', initialPreset = null) {
    const ctx = this.ctx;
    const inputNode = ctx.createGain();
    inputNode.gain.value = 1.0;

    let source = null;
    if (stream) {
      source = ctx.createMediaStreamSource(stream);
      source.connect(inputNode);
    }

    // Input cleanup: strip sub-bass rumble while keeping full 75Hz-12kHz vocal clarity
    const hpFilter = ctx.createBiquadFilter();
    hpFilter.type = 'highpass';
    hpFilter.frequency.value = 75;

    const lpFilter = ctx.createBiquadFilter();
    lpFilter.type = 'lowpass';
    lpFilter.frequency.value = 12000;

    inputNode.connect(hpFilter);
    hpFilter.connect(lpFilter);

    // Granular Vocoder + Noise Gate AudioWorklet
    const scrambler = new AudioWorkletNode(ctx, 'polyglot-scrambler-processor');
    scrambler.parameters.get('noiseGateThreshold').value = this.noiseGateThreshold;

    // Formant / flavor filter
    const filter = ctx.createBiquadFilter();
    filter.type = 'allpass';
    filter.frequency.value = 1000;
    filter.Q.value = 1.2;

    // Gentle LFO-modulated chorus (sub-millisecond sweep to avoid pitch wobble)
    const chorusDelay = ctx.createDelay(0.1);
    chorusDelay.delayTime.value = 0.018;
    const chorusLfo = ctx.createOscillator();
    chorusLfo.type = 'sine';
    chorusLfo.frequency.value = 0.65;
    const chorusLfoGain = ctx.createGain();
    chorusLfoGain.gain.value = 0.00045;
    chorusLfo.connect(chorusLfoGain);
    chorusLfoGain.connect(chorusDelay.delayTime);
    chorusLfo.start();

    const chorusWetGain = ctx.createGain();
    chorusWetGain.gain.value = 0;

    // Smoothed cavern / cathedral reverb
    const convolver = ctx.createConvolver();
    convolver.buffer = this.reverbBuffer;
    const reverbWetGain = ctx.createGain();
    reverbWetGain.gain.value = 0;

    // Clean bypass vs processed scrambler path
    const dryGain = ctx.createGain();
    dryGain.gain.value = 1;
    const processedGain = ctx.createGain();
    processedGain.gain.value = 0;

    // Master output gain for this peer
    const masterGain = ctx.createGain();
    masterGain.gain.value = 1.0;

    lpFilter.connect(dryGain);
    dryGain.connect(masterGain);

    lpFilter.connect(scrambler);
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
      inputNode,
      hpFilter,
      lpFilter,
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
      preset: initialPreset,
      userVolume: 1.0,
      userMuted: false,
      whisperMuted: false,
      nextRelayTime: 0
    };

    this.applyChainState(chain, initialMode, initialPreset);
    return chain;
  }

  syncChainOutputGain(chain) {
    if (!chain || !this.ctx) return;
    const effective = (chain.userMuted || chain.whisperMuted) ? 0 : chain.userVolume;
    chain.masterGain.gain.setTargetAtTime(effective, this.ctx.currentTime, 0.02);
  }

  applyChainState(chain, mode, preset) {
    if (!chain || !this.ctx) return;
    const now = this.ctx.currentTime;
    const tau = 0.035;
    const p = preset || this.demoGibberishPreset;

    chain.mode = mode;
    chain.preset = p;
    this.syncChainOutputGain(chain);

    const params = chain.scrambler.parameters;
    params.get('noiseGateThreshold').setTargetAtTime(this.noiseGateThreshold, now, tau);

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
      // Pure direct voice with zero AudioWorklet comb filtering + subtle room ambience
      chain.dryGain.gain.setTargetAtTime(1.0, now, tau);
      chain.processedGain.gain.setTargetAtTime(0.0, now, tau);

      params.get('scrambleAmount').setTargetAtTime(0.0, now, tau);
      params.get('grainSizeMs').setTargetAtTime(p.grainSizeMs || 145, now, tau);
      params.get('pitchRatio').setTargetAtTime(1.0, now, tau);
      params.get('subOctaveMix').setTargetAtTime((p.subOctaveMix || 0) >= 0.3 ? 0.12 : 0.0, now, tau);
      params.get('ringModHz').setTargetAtTime(p.ringModHz || 0, now, tau);
      params.get('ringModMix').setTargetAtTime(0.0, now, tau);

      chain.filter.type = p.filterType === 'bandpass' ? 'peaking' : (p.filterType || 'allpass');
      chain.filter.frequency.setTargetAtTime(Math.max(120, Math.min(8000, p.filterFreq || 1200)), now, tau);
      chain.filter.gain.setTargetAtTime(3.0, now, tau);

      chain.chorusWetGain.gain.setTargetAtTime(Math.min(0.08, (p.chorusMix || 0) * 0.18), now, tau);
      chain.reverbWetGain.gain.setTargetAtTime(Math.min(0.14, (p.reverbMix || 0) * 0.25), now, tau);
      return;
    }

    // GIBBERISH mode: 0% dry, 100% vocoder-resynthesized fantasy speech
    chain.dryGain.gain.setTargetAtTime(0.0, now, tau);
    chain.processedGain.gain.setTargetAtTime(1.15, now, tau);

    params.get('scrambleAmount').setTargetAtTime(1.0, now, tau);
    params.get('grainSizeMs').setTargetAtTime(p.grainSizeMs || 145, now, tau);
    params.get('pitchRatio').setTargetAtTime(p.pitchRatio || 1.0, now, tau);
    params.get('subOctaveMix').setTargetAtTime(p.subOctaveMix || 0, now, tau);
    params.get('ringModHz').setTargetAtTime(p.ringModHz || 0, now, tau);
    params.get('ringModMix').setTargetAtTime(p.ringModMix || 0, now, tau);

    const shiftedFreq = Math.max(140, Math.min(7200, (p.filterFreq || 1200) + (p.formantShiftHz || 0)));
    chain.filter.type = p.filterType || 'bandpass';
    chain.filter.frequency.setTargetAtTime(shiftedFreq, now, tau);
    chain.filter.Q.setTargetAtTime(p.filterType === 'bandpass' ? 1.15 : 0.9, now, tau);
    chain.filter.gain.setTargetAtTime(6.0, now, tau);

    chain.chorusWetGain.gain.setTargetAtTime(p.chorusMix || 0, now, tau);
    chain.reverbWetGain.gain.setTargetAtTime((p.reverbMix || 0) * 0.85, now, tau);
  }

  resolveModeForPeer(peerState) {
    if (!peerState) return 'CLEAN';
    if (!peerState.understood) return 'GIBBERISH';
    if (peerState.languageId !== 'common' && this.dmHearAsGibberish) return 'GIBBERISH';
    if (peerState.languageId === 'common') return 'CLEAN';
    return this.atmosphericEnabled ? 'ATMOSPHERIC' : 'CLEAN';
  }

  async attachPeerStream(clientId, stream, peerState) {
    await this.ensureInitialized();
    const prevChain = this.peerChains.get(clientId);
    const prevVol = prevChain?.userVolume ?? 1.0;
    const prevMuted = prevChain?.userMuted ?? false;

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
    chain.userVolume = prevVol;
    chain.userMuted = prevMuted;
    chain.whisperMuted = !!peerState?.mutedByWhisper;
    this.syncChainOutputGain(chain);
    this.peerChains.set(clientId, chain);
  }

  async ensureRelayChain(clientId, peerState) {
    await this.ensureInitialized();
    let chain = this.peerChains.get(clientId);
    if (!chain) {
      const mode = this.resolveModeForPeer(peerState);
      chain = this.createProcessingChain(null, mode, peerState?.dspPreset || null);
      chain.peerState = peerState;
      chain.whisperMuted = !!peerState?.mutedByWhisper;
      this.syncChainOutputGain(chain);
      this.peerChains.set(clientId, chain);
    }
    return chain;
  }

  async playRelayedAudioChunk(clientId, pcmBase64, sampleRate, peerState) {
    if (peerState?.mutedByWhisper) return;
    const chain = await this.ensureRelayChain(clientId, peerState);
    if (chain.userMuted || chain.whisperMuted) return;

    const binary = atob(pcmBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const int16 = new Int16Array(bytes.buffer);
    if (int16.length === 0) return;

    const audioBuf = this.ctx.createBuffer(1, int16.length, sampleRate || 16000);
    const chData = audioBuf.getChannelData(0);
    for (let i = 0; i < int16.length; i++) {
      chData[i] = int16[i] / 32768;
    }

    const src = this.ctx.createBufferSource();
    src.buffer = audioBuf;
    src.connect(chain.inputNode);

    const now = this.ctx.currentTime;
    if (chain.nextRelayTime < now || chain.nextRelayTime > now + 0.3) {
      chain.nextRelayTime = now + 0.025;
    }
    src.start(chain.nextRelayTime);
    chain.nextRelayTime += audioBuf.duration;
  }

  updatePeerLanguage(clientId, peerState) {
    const chain = this.peerChains.get(clientId);
    if (!chain) return;
    chain.peerState = peerState;
    chain.whisperMuted = !!peerState?.mutedByWhisper;
    const mode = this.resolveModeForPeer(peerState);
    this.applyChainState(chain, mode, peerState?.dspPreset || null);
  }

  setPeerVolume(clientId, volume) {
    const chain = this.peerChains.get(clientId);
    if (!chain) return;
    chain.userVolume = Math.max(0, Math.min(2, volume));
    this.syncChainOutputGain(chain);
  }

  setPeerMuted(clientId, muted) {
    const chain = this.peerChains.get(clientId);
    if (!chain) return;
    chain.userMuted = !!muted;
    this.syncChainOutputGain(chain);
  }

  detachPeerStream(clientId) {
    const chain = this.peerChains.get(clientId);
    if (!chain) return;
    this.destroyChain(chain);
    this.peerChains.delete(clientId);
  }

  destroyChain(chain) {
    try { chain.chorusLfo.stop(); } catch {}
    try {
      chain.source?.disconnect();
      chain.inputNode.disconnect();
      chain.hpFilter.disconnect();
      chain.lpFilter.disconnect();
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

  /**
   * Builds a noise-gated, filtered MediaStream for outgoing WebRTC transmission so
   * room noise / keyboard clicks are completely silenced when the user isn't speaking.
   */
  async setLocalStream(rawStream) {
    this.rawLocalStream = rawStream;
    await this.ensureInitialized();

    if (this.localVadTimer) {
      clearInterval(this.localVadTimer);
      this.localVadTimer = null;
    }

    this.teardownLocalPipeline();

    if (!rawStream) {
      if (this.selfMonitorChain) {
        this.destroyChain(this.selfMonitorChain);
        this.selfMonitorChain = null;
      }
      return null;
    }

    const ctx = this.ctx;
    this.localSource = ctx.createMediaStreamSource(rawStream);

    this.localHpFilter = ctx.createBiquadFilter();
    this.localHpFilter.type = 'highpass';
    this.localHpFilter.frequency.value = 75;

    this.localLpFilter = ctx.createBiquadFilter();
    this.localLpFilter.type = 'lowpass';
    this.localLpFilter.frequency.value = 12000;

    this.localGateGain = ctx.createGain();
    this.localGateGain.gain.value = 0.12;

    this.localDest = ctx.createMediaStreamDestination();
    this.localAnalyser = ctx.createAnalyser();
    this.localAnalyser.fftSize = 512;

    this.localSource.connect(this.localHpFilter);
    this.localHpFilter.connect(this.localLpFilter);
    this.localLpFilter.connect(this.localAnalyser);
    this.localLpFilter.connect(this.localGateGain);
    this.localGateGain.connect(this.localDest);

    // Optional relay capture node (downsamples to 16kHz Int16 only when relayTargetsCount > 0 & gate open)
    this.relayProcessor = ctx.createScriptProcessor(2048, 1, 1);
    const silentMonitorGain = ctx.createGain();
    silentMonitorGain.gain.value = 0;
    this.localGateGain.connect(this.relayProcessor);
    this.relayProcessor.connect(silentMonitorGain);
    silentMonitorGain.connect(ctx.destination);

    this.relayProcessor.onaudioprocess = (ev) => {
      if (this.relayTargetsCount <= 0 || !this.localGateOpen || !this.onAudioRelayChunk) return;
      const track = this.rawLocalStream?.getAudioTracks()[0];
      if (!track || !track.enabled) return;

      const input = ev.inputBuffer.getChannelData(0);
      const inRate = ctx.sampleRate;
      const outRate = 16000;
      const ratio = inRate / outRate;
      const outLen = Math.floor(input.length / ratio);
      const int16 = new Int16Array(outLen);

      for (let i = 0; i < outLen; i++) {
        const start = Math.floor(i * ratio);
        const end = Math.min(input.length, Math.floor((i + 1) * ratio));
        let sum = 0;
        for (let j = start; j < end; j++) sum += input[j];
        const sample = sum / Math.max(1, end - start);
        const clamped = Math.max(-1, Math.min(1, sample));
        int16[i] = clamped < 0 ? clamped * 32768 : clamped * 32767;
      }

      const bytes = new Uint8Array(int16.buffer);
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      this.onAudioRelayChunk(btoa(bin), outRate);
    };

    this.gatedLocalStream = this.localDest.stream;

    const data = new Float32Array(this.localAnalyser.fftSize);
    this.localVadTimer = setInterval(() => {
      if (!this.localAnalyser) return;
      const track = this.rawLocalStream?.getAudioTracks()[0];
      const muted = !track || !track.enabled;
      if (muted) {
        this.localGateOpen = false;
        this.localGateGain?.gain.setTargetAtTime(0.0, ctx.currentTime, 0.02);
        if (this.lastSpeakingState) {
          this.lastSpeakingState = false;
          this.onLocalSpeakingChange?.(false, 0);
        }
        return;
      }

      this.localAnalyser.getFloatTimeDomainData(data);
      let sum = 0;
      let peak = 0;
      for (let i = 0; i < data.length; i++) {
        const v = data[i];
        sum += v * v;
        const av = Math.abs(v);
        if (av > peak) peak = av;
      }
      const rms = Math.sqrt(sum / data.length);
      const level = Math.min(1, rms * 8);
      const now = Date.now();

      // Soft expander instead of hard walkie-talkie squelch
      if (rms >= this.noiseGateThreshold || peak >= this.noiseGateThreshold * 1.8) {
        this.gateHoldUntil = now + 420;
        this.lastSpeakingAt = now;
      }

      const gateOpenNow = now < this.gateHoldUntil;
      if (gateOpenNow !== this.localGateOpen) {
        this.localGateOpen = gateOpenNow;
        this.localGateGain?.gain.setTargetAtTime(gateOpenNow ? 1.0 : 0.12, ctx.currentTime, gateOpenNow ? 0.005 : 0.18);
      }

      const isSpeaking = gateOpenNow || (now - this.lastSpeakingAt < 350);
      if (isSpeaking !== this.lastSpeakingState || isSpeaking) {
        this.lastSpeakingState = isSpeaking;
        this.onLocalSpeakingChange?.(isSpeaking, Number(level.toFixed(2)));
      }
    }, 20);

    if (this.selfMonitorEnabled) {
      await this.enableSelfMonitor(true);
    }

    return this.gatedLocalStream;
  }

  teardownLocalPipeline() {
    try { this.relayProcessor?.disconnect(); } catch {}
    try { this.localSource?.disconnect(); } catch {}
    try { this.localHpFilter?.disconnect(); } catch {}
    try { this.localLpFilter?.disconnect(); } catch {}
    try { this.localGateGain?.disconnect(); } catch {}
    this.relayProcessor = null;
    this.localSource = null;
    this.localHpFilter = null;
    this.localLpFilter = null;
    this.localGateGain = null;
    this.localDest = null;
    this.localAnalyser = null;
    this.gatedLocalStream = null;
  }

  setRelayTargetsCount(count) {
    this.relayTargetsCount = Math.max(0, Number(count) || 0);
  }

  setNoiseGateThreshold(threshold) {
    this.noiseGateThreshold = Math.max(0.001, Math.min(0.15, Number(threshold) || 0.015));
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    for (const chain of this.peerChains.values()) {
      chain.scrambler.parameters.get('noiseGateThreshold').setTargetAtTime(this.noiseGateThreshold, now, 0.02);
    }
    if (this.selfMonitorChain) {
      this.selfMonitorChain.scrambler.parameters.get('noiseGateThreshold').setTargetAtTime(this.noiseGateThreshold, now, 0.02);
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

  setDmHearAsGibberish(enabled) {
    this.dmHearAsGibberish = !!enabled;
    for (const chain of this.peerChains.values()) {
      const mode = this.resolveModeForPeer(chain.peerState);
      this.applyChainState(chain, mode, chain.peerState?.dspPreset || null);
    }
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

    if (!this.rawLocalStream) return;
    await this.ensureInitialized();
    if (this.selfMonitorChain) {
      this.destroyChain(this.selfMonitorChain);
    }

    const mode = this.resolveSelfMonitorMode();
    const preset = this.resolveSelfMonitorPreset();
    this.selfMonitorChain = this.createProcessingChain(this.rawLocalStream, mode, preset);
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
    // Always demonstrate gibberish in gibberish test mode even if Common is currently selected
    if (this.selfMonitorMode === 'gibberish') return 'GIBBERISH';
    if (this.currentSelfLanguageId === 'common') return 'CLEAN';
    return 'ATMOSPHERIC';
  }

  resolveSelfMonitorPreset() {
    if (this.currentSelfLanguageId === 'common' && this.selfMonitorMode === 'gibberish') {
      return this.demoGibberishPreset;
    }
    return this.currentSelfPreset;
  }

  refreshSelfMonitor() {
    if (!this.selfMonitorChain) return;
    const mode = this.resolveSelfMonitorMode();
    const preset = this.resolveSelfMonitorPreset();
    this.applyChainState(this.selfMonitorChain, mode, preset);
  }
}

window.PolyglotAudioEngine = PolyglotAudioEngine;
