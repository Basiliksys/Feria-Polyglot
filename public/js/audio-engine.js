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
    this.peerAudioPrefs = new Map(); // clientId -> { volume, muted } (survives chain replacement)
    this.buses = new DspBusRegistry((payload) => this.createDspBus(payload.mode, payload.preset));
    this.selfMonitorChain = null;

    this.rawLocalStream = null;
    this.gatedLocalStream = null;
    this.localSource = null;
    this.localHpFilter = null;
    this.localLpFilter = null;
    this.localCompressor = null;
    this.localMakeupGain = null;
    this.localGateGain = null;
    this.silentMonitorGain = null;
    this.localDest = null;
    this.localAnalyser = null;
    this.localVadTimer = null;
    this.localGateOpen = false;
    this.gateHoldUntil = 0;
    this.noiseFloor = 0.0015;
    this.aboveGateFrames = 0;

    // Relay capture node (AudioWorklet tap, replaces ScriptProcessorNode)
    this.relayTap = null;
    this.relayTargetsCount = 0;
    this.onAudioRelayChunk = null;
    this.isRelayAllowed = () => true; // overridden by app.js with transport state
    this.relaySequence = 0;
    this.localStreamGeneration = 0;

    this.atmosphericEnabled = true;
    this.dmHearAsGibberish = false;
    this.selfMonitorEnabled = false;
    this.selfMonitorMode = 'gibberish'; // 'gibberish' | 'atmospheric'
    this.currentSelfPreset = null;
    this.currentSelfLanguageId = 'common';
    this.noiseGateThreshold = 0.0012;

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
      await this.ctx.audioWorklet.addModule('/js/audio-protocol.js');
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

  /**
   * Builds the expensive shared DSP stage (scrambler + formant filter + chorus +
   * reverb) once per mode/preset combination. Lightweight per-peer chains feed
   * into `inputNode` through their own send gain.
   */
  createDspBus(mode, preset) {
    const ctx = this.ctx;
    const p = preset || this.demoGibberishPreset;

    const inputNode = ctx.createGain();
    const outputNode = ctx.createGain();
    outputNode.connect(ctx.destination);

    const scrambler = new AudioWorkletNode(ctx, 'polyglot-scrambler-processor');
    scrambler.parameters.get('noiseGateThreshold').value = this.noiseGateThreshold;

    const filter = ctx.createBiquadFilter();
    filter.type = 'allpass';
    filter.frequency.value = 1000;
    filter.Q.value = 1.2;

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

    const convolver = ctx.createConvolver();
    convolver.buffer = this.reverbBuffer;
    const reverbWetGain = ctx.createGain();
    reverbWetGain.gain.value = 0;

    const dryGain = ctx.createGain();
    dryGain.gain.value = 1;
    const processedGain = ctx.createGain();
    processedGain.gain.value = 0;

    inputNode.connect(dryGain);
    dryGain.connect(outputNode);
    inputNode.connect(scrambler);
    scrambler.connect(filter);
    filter.connect(processedGain);
    processedGain.connect(outputNode);
    filter.connect(chorusDelay);
    chorusDelay.connect(chorusWetGain);
    chorusWetGain.connect(outputNode);
    filter.connect(convolver);
    convolver.connect(reverbWetGain);
    reverbWetGain.connect(outputNode);

    const self = this;
    const bus = {
      inputNode,
      outputNode,
      scrambler,
      filter,
      chorusDelay,
      chorusLfo,
      chorusLfoGain,
      chorusWetGain,
      convolver,
      reverbWetGain,
      dryGain,
      processedGain,
      mode,
      preset: p,
      destroy() { self.destroyDspBus(bus); }
    };
    this.applyBusState(bus, mode, p);
    return bus;
  }

  applyBusState(bus, mode, preset) {
    if (!bus || !this.ctx) return;
    const now = this.ctx.currentTime;
    const tau = 0.035;
    const p = preset || this.demoGibberishPreset;
    bus.mode = mode;
    bus.preset = p;

    const params = bus.scrambler.parameters;
    params.get('noiseGateThreshold').setTargetAtTime(this.noiseGateThreshold, now, tau);

    if (mode === 'CLEAN') {
      bus.dryGain.gain.setTargetAtTime(1.0, now, tau);
      bus.processedGain.gain.setTargetAtTime(0.0, now, tau);
      bus.chorusWetGain.gain.setTargetAtTime(0.0, now, tau);
      bus.reverbWetGain.gain.setTargetAtTime(0.0, now, tau);
      params.get('scrambleAmount').setTargetAtTime(0.0, now, tau);
      params.get('subOctaveMix').setTargetAtTime(0.0, now, tau);
      params.get('ringModMix').setTargetAtTime(0.0, now, tau);
      return;
    }

    if (mode === 'ATMOSPHERIC') {
      bus.dryGain.gain.setTargetAtTime(1.0, now, tau);
      bus.processedGain.gain.setTargetAtTime(0.0, now, tau);
      params.get('scrambleAmount').setTargetAtTime(0.0, now, tau);
      params.get('grainSizeMs').setTargetAtTime(p.grainSizeMs || 145, now, tau);
      params.get('pitchRatio').setTargetAtTime(1.0, now, tau);
      params.get('subOctaveMix').setTargetAtTime((p.subOctaveMix || 0) >= 0.3 ? 0.12 : 0.0, now, tau);
      params.get('ringModHz').setTargetAtTime(p.ringModHz || 0, now, tau);
      params.get('ringModMix').setTargetAtTime(0.0, now, tau);
      bus.filter.type = p.filterType === 'bandpass' ? 'peaking' : (p.filterType || 'allpass');
      bus.filter.frequency.setTargetAtTime(Math.max(120, Math.min(8000, p.filterFreq || 1200)), now, tau);
      bus.filter.gain.setTargetAtTime(3.0, now, tau);
      bus.chorusWetGain.gain.setTargetAtTime(Math.min(0.08, (p.chorusMix || 0) * 0.18), now, tau);
      bus.reverbWetGain.gain.setTargetAtTime(Math.min(0.14, (p.reverbMix || 0) * 0.25), now, tau);
      return;
    }

    // GIBBERISH mode: 0% dry, 100% vocoder-resynthesized fantasy speech.
    bus.dryGain.gain.setTargetAtTime(0.0, now, tau);
    bus.processedGain.gain.setTargetAtTime(1.15, now, tau);
    params.get('scrambleAmount').setTargetAtTime(1.0, now, tau);
    params.get('grainSizeMs').setTargetAtTime(p.grainSizeMs || 145, now, tau);
    params.get('pitchRatio').setTargetAtTime(p.pitchRatio || 1.0, now, tau);
    params.get('subOctaveMix').setTargetAtTime(p.subOctaveMix || 0, now, tau);
    params.get('ringModHz').setTargetAtTime(p.ringModHz || 0, now, tau);
    params.get('ringModMix').setTargetAtTime(p.ringModMix || 0, now, tau);
    const shiftedFreq = Math.max(140, Math.min(7200, (p.filterFreq || 1200) + (p.formantShiftHz || 0)));
    bus.filter.type = p.filterType || 'bandpass';
    bus.filter.frequency.setTargetAtTime(shiftedFreq, now, tau);
    bus.filter.Q.setTargetAtTime(p.filterType === 'bandpass' ? 1.15 : 0.9, now, tau);
    bus.filter.gain.setTargetAtTime(6.0, now, tau);
    bus.chorusWetGain.gain.setTargetAtTime(p.chorusMix || 0, now, tau);
    bus.reverbWetGain.gain.setTargetAtTime((p.reverbMix || 0) * 0.85, now, tau);
  }

  destroyDspBus(bus) {
    try { bus.chorusLfo.stop(); } catch {}
    for (const node of [
      bus.inputNode, bus.outputNode, bus.scrambler, bus.filter, bus.chorusDelay,
      bus.chorusLfo, bus.chorusLfoGain, bus.chorusWetGain, bus.convolver, bus.reverbWetGain,
      bus.dryGain, bus.processedGain
    ]) {
      try { node.disconnect(); } catch {}
    }
  }

  /**
   * Lightweight per-peer chain: source -> input cleanup -> send gain -> shared bus.
   * The expensive scrambler/filter/chorus/reverb stage lives once in a DspBus,
   * shared by every peer with the same mode/preset. Per-peer volume and mute are
   * applied on `sendGain` before the signal is summed into the bus.
   */
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

    // Per-peer send gain carries user volume / mute into the shared DSP bus.
    const sendGain = ctx.createGain();
    sendGain.gain.value = 1.0;

    inputNode.connect(hpFilter);
    hpFilter.connect(lpFilter);
    lpFilter.connect(sendGain);

    const chain = {
      source,
      inputNode,
      hpFilter,
      lpFilter,
      sendGain,
      audioEl: null,
      mode: initialMode,
      preset: initialPreset,
      busKey: null,
      bus: null,
      userVolume: 1.0,
      userMuted: false,
      whisperMuted: false,
      nextRelayTime: 0,
      // Scheduled relay buffers must be cancellable when direct audio takes
      // over, otherwise the same phrase is heard twice (echo / "loop").
      relaySources: new Set()
    };

    this.applyChainState(chain, initialMode, initialPreset);
    return chain;
  }

  syncChainOutputGain(chain) {
    if (!chain || !this.ctx) return;
    const effective = (chain.userMuted || chain.whisperMuted) ? 0 : chain.userVolume;
    chain.sendGain.gain.setTargetAtTime(effective, this.ctx.currentTime, 0.02);
  }

  /**
   * Moves a peer chain onto the shared bus for the requested mode/preset. DSP
   * parameters are owned by the bus (set once when it is created), so switching
   * a peer only rewires one gain node instead of rebuilding the whole chain.
   */
  applyChainState(chain, mode, preset) {
    if (!chain || !this.ctx) return;
    const effectivePreset = preset || this.demoGibberishPreset;
    chain.mode = mode;
    chain.preset = effectivePreset;

    const key = DspBusRegistry.keyFor(mode, effectivePreset);
    if (key !== chain.busKey) {
      this.releaseChainBus(chain);
      const acquired = this.buses.acquire(key, { key, mode, preset: effectivePreset });
      chain.bus = acquired.bus;
      chain.busKey = key;
      try { chain.sendGain.connect(chain.bus.inputNode); } catch {}
    }
    this.syncChainOutputGain(chain);
  }

  releaseChainBus(chain) {
    if (!chain || !chain.busKey) return;
    try { chain.sendGain.disconnect(chain.bus.inputNode); } catch {}
    this.buses.release(chain.busKey);
    chain.bus = null;
    chain.busKey = null;
  }

  resolveModeForPeer(peerState) {
    if (!peerState) return 'CLEAN';
    if (!peerState.understood) return 'GIBBERISH';
    if (peerState.languageId !== 'common' && this.dmHearAsGibberish) return 'GIBBERISH';
    if (peerState.languageId === 'common') return 'CLEAN';
    return this.atmosphericEnabled ? 'ATMOSPHERIC' : 'CLEAN';
  }

  async attachPeerStream(clientId, stream, peerState, isCurrent = () => true) {
    // The caller may tear down the peer connection while initialization is
    // pending. Never create a fresh chain for a stale ontrack callback.
    if (!isCurrent()) return false;
    await this.ensureInitialized();
    if (this.ctx?.state === 'suspended') {
      try { await this.ctx.resume(); } catch {}
    }
    if (!isCurrent()) return false;
    const prevChain = this.peerChains.get(clientId);
    const storedPref = this.peerAudioPrefs.get(clientId);
    const prevVol = storedPref?.volume ?? prevChain?.userVolume ?? 1.0;
    const prevMuted = storedPref?.muted ?? prevChain?.userMuted ?? false;
    const preservedRelaySources = prevChain?.relaySources?.size ? [...prevChain.relaySources] : [];
    const preservedNextRelayTime = prevChain?.nextRelayTime || 0;
    if (prevChain?.relaySources) prevChain.relaySources.clear();

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
    chain.nextRelayTime = preservedNextRelayTime;
    for (const src of preservedRelaySources) {
      try {
        src.disconnect();
        src.connect(chain.inputNode);
        src.onended = () => {
          chain.relaySources.delete(src);
          try { src.disconnect(); } catch {}
        };
        chain.relaySources.add(src);
      } catch {}
    }
    this.syncChainOutputGain(chain);
    this.peerChains.set(clientId, chain);
    return true;
  }

  async ensureRelayChain(clientId, peerState) {
    await this.ensureInitialized();
    let chain = this.peerChains.get(clientId);
    if (!chain) {
      const mode = this.resolveModeForPeer(peerState);
      chain = this.createProcessingChain(null, mode, peerState?.dspPreset || null);
      chain.peerState = peerState;
      chain.whisperMuted = !!peerState?.mutedByWhisper;
      const storedPref = this.peerAudioPrefs.get(clientId);
      chain.userVolume = storedPref?.volume ?? 1.0;
      chain.userMuted = storedPref?.muted ?? false;
      this.syncChainOutputGain(chain);
      this.peerChains.set(clientId, chain);
    }
    return chain;
  }

  async playRelayedAudioChunk(clientId, frame, peerState) {
    if (peerState?.mutedByWhisper) return;
    if (!this.isRelayAllowed(clientId)) return;
    const chain = await this.ensureRelayChain(clientId, peerState);
    // A direct WebRTC track may have arrived while ensureInitialized/chain setup
    // was pending. Recheck before creating any audio source.
    if (!this.isRelayAllowed(clientId)) return;
    if (this.ctx?.state === 'suspended') {
      try { await this.ctx.resume(); } catch {}
    }
    if (!this.isRelayAllowed(clientId) || chain.userMuted || chain.whisperMuted) return;

    const int16 = frame.pcm;
    if (!int16 || int16.length === 0) return;

    const audioBuf = this.ctx.createBuffer(1, int16.length, frame.sampleRate || 24000);
    const chData = audioBuf.getChannelData(0);
    const toFloat = window.RelayProtocol.int16ToFloat32;
    const floatData = toFloat(int16);
    chData.set(floatData);

    const now = this.ctx.currentTime;
    const hasGap = chain.nextRelayTime < now || chain.nextRelayTime > now + 0.6;
    if (hasGap) {
      chain.nextRelayTime = now + 0.065;
      const fadeLen = Math.min(24, chData.length);
      for (let i = 0; i < fadeLen; i++) {
        chData[i] *= i / fadeLen;
      }
    }

    const src = this.ctx.createBufferSource();
    src.buffer = audioBuf;
    src.connect(chain.inputNode);
    const forget = () => {
      chain.relaySources.delete(src);
      try { src.disconnect(); } catch {}
    };
    src.onended = forget;
    chain.relaySources.add(src);
    src.start(chain.nextRelayTime);
    chain.nextRelayTime += audioBuf.duration;
  }

  /** Cancels queued relay audio for a peer that switched to direct WebRTC. */
  stopRelayPlayback(clientId) {
    const chain = this.peerChains.get(clientId);
    if (!chain) return;
    chain.nextRelayTime = 0;
    for (const src of [...chain.relaySources]) {
      src.onended = null;
      try { src.stop(); } catch {}
      try { src.disconnect(); } catch {}
    }
    chain.relaySources.clear();
  }

  updatePeerLanguage(clientId, peerState) {
    const chain = this.peerChains.get(clientId);
    if (!chain) return;
    chain.peerState = peerState;
    chain.whisperMuted = !!peerState?.mutedByWhisper;
    const mode = this.resolveModeForPeer(peerState);
    this.applyChainState(chain, mode, peerState?.dspPreset || null);
  }

  /** Stores per-peer audio prefs in the engine so they survive chain replacement. */
  setPeerAudioPref(clientId, patch) {
    const prev = this.peerAudioPrefs.get(clientId) || {};
    const next = {
      volume: typeof patch?.volume === 'number'
        ? Math.max(0, Math.min(2, patch.volume))
        : (prev.volume ?? 1.0),
      muted: patch?.muted === undefined ? (prev.muted ?? false) : !!patch.muted
    };
    this.peerAudioPrefs.set(clientId, next);
    const chain = this.peerChains.get(clientId);
    if (chain) {
      chain.userVolume = next.volume;
      chain.userMuted = next.muted;
      this.syncChainOutputGain(chain);
    }
  }

  setPeerVolume(clientId, volume) {
    this.setPeerAudioPref(clientId, { volume });
  }

  setPeerMuted(clientId, muted) {
    this.setPeerAudioPref(clientId, { muted });
  }

  detachPeerStream(clientId) {
    const chain = this.peerChains.get(clientId);
    if (!chain) return;
    this.destroyChain(chain);
    this.peerChains.delete(clientId);
  }

  destroyChain(chain) {
    this.releaseChainBus(chain);
    for (const src of [...(chain.relaySources || [])]) {
      src.onended = null;
      try { src.stop(); } catch {}
    }
    chain.relaySources?.clear();
    try {
      chain.source?.disconnect();
      chain.inputNode.disconnect();
      chain.hpFilter.disconnect();
      chain.lpFilter.disconnect();
      chain.sendGain.disconnect();
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
    const generation = ++this.localStreamGeneration;
    await this.ensureInitialized();
    // A second microphone switch may have started while the audio context was
    // loading; let the newest call win instead of building two pipelines.
    if (generation !== this.localStreamGeneration) return this.gatedLocalStream;

    if (this.localVadTimer) {
      clearInterval(this.localVadTimer);
      this.localVadTimer = null;
    }

    this.teardownLocalPipeline();

    if (!rawStream) {
      this.rawLocalStream = null;
      if (this.selfMonitorChain) {
        this.destroyChain(this.selfMonitorChain);
        this.selfMonitorChain = null;
      }
      return null;
    }

    this.rawLocalStream = rawStream;
    const ctx = this.ctx;
    this.localSource = ctx.createMediaStreamSource(rawStream);

    this.localHpFilter = ctx.createBiquadFilter();
    this.localHpFilter.type = 'highpass';
    this.localHpFilter.frequency.value = 75;

    this.localLpFilter = ctx.createBiquadFilter();
    this.localLpFilter.type = 'lowpass';
    this.localLpFilter.frequency.value = 12000;

    this.localCompressor = ctx.createDynamicsCompressor();
    this.localCompressor.threshold.value = -28;
    this.localCompressor.knee.value = 18;
    this.localCompressor.ratio.value = 3.5;
    this.localCompressor.attack.value = 0.005;
    this.localCompressor.release.value = 0.18;

    this.localMakeupGain = ctx.createGain();
    this.localMakeupGain.gain.value = 1.25;

    const initialTrack = rawStream.getAudioTracks()[0];
    this.localMicActive = !!(initialTrack && initialTrack.enabled);
    this.localGateGain = ctx.createGain();
    this.localGateGain.gain.value = this.localMicActive ? 1.0 : 0.0;
    // Keep the cached VAD state in sync with the initial gain, otherwise the
    // first quiet tick sees "already closed" and never actually mutes it.
    this.localGateOpen = this.localMicActive;

    this.localDest = ctx.createMediaStreamDestination();
    this.localAnalyser = ctx.createAnalyser();
    // ~43 ms at 48 kHz instead of ~10 ms: enough context to tell a sustained
    // syllable from a 5 ms keyboard/mouse impulse.
    this.localAnalyser.fftSize = 2048;
    this.noiseFloor = 0.0015;
    this.aboveGateFrames = 0;

    this.localSource.connect(this.localHpFilter);
    this.localHpFilter.connect(this.localLpFilter);
    this.localLpFilter.connect(this.localCompressor);
    this.localCompressor.connect(this.localMakeupGain);
    this.localMakeupGain.connect(this.localAnalyser);
    this.localMakeupGain.connect(this.localGateGain);
    this.localGateGain.connect(this.localDest);

    // Relay capture tap retained on `this` so GC never collects it while active.
    // The worklet encodes PCM off the main thread and transfers 20 ms Int16 chunks.
    this.relayTap = new AudioWorkletNode(ctx, 'polyglot-relay-tap-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1]
    });
    this.relayTap.port.onmessage = (event) => {
      const data = event.data || {};
      if (!data.pcm || this.relayTargetsCount <= 0 || !this.onAudioRelayChunk) return;
      this.onAudioRelayChunk(new Int16Array(data.pcm), data.sampleRate || 24000);
    };
    this.relayTap.port.postMessage({ enabled: this.relayTargetsCount > 0 });
    this.silentMonitorGain = ctx.createGain();
    this.silentMonitorGain.gain.value = 0;
    this.localGateGain.connect(this.relayTap);
    this.relayTap.connect(this.silentMonitorGain);
    this.silentMonitorGain.connect(ctx.destination);

    this.gatedLocalStream = this.localDest.stream;

    const data = new Float32Array(this.localAnalyser.fftSize);
    this.localVadTimer = setInterval(() => {
      if (!this.localAnalyser) return;
      const track = this.rawLocalStream?.getAudioTracks()[0];
      const muted = !track || !track.enabled;
      if (muted) {
        this.localGateOpen = false;
        if (this.localMicActive) {
          this.localMicActive = false;
          this.localGateGain?.gain.setTargetAtTime(0.0, ctx.currentTime, 0.02);
        }
        if (this.lastSpeakingState) {
          this.lastSpeakingState = false;
          this.onLocalSpeakingChange?.(false, 0);
        }
        return;
      }

      if (!this.localMicActive) {
        this.localMicActive = true;
        this.localGateGain?.gain.setTargetAtTime(this.localGateOpen ? 1.0 : 0.0, ctx.currentTime, 0.01);
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
      const crest = peak / Math.max(rms, 1e-6);
      const level = Math.min(1, rms * 8);
      const now = Date.now();

      // Discord-like gating: learn the quietest recent level, use hysteresis
      // around it, and reject short broadband impulses. Browser noise
      // suppression handles steady hiss; this removes the clicks it misses.
      if (rms < this.noiseFloor) {
        this.noiseFloor = this.noiseFloor * 0.85 + rms * 0.15;
      } else if (!this.localGateOpen) {
        this.noiseFloor = Math.min(0.0045, rms, this.noiseFloor * 1.002);
      }
      const openThreshold = Math.max(this.noiseGateThreshold, this.noiseFloor * 3);
      const closeThreshold = Math.max(this.noiseGateThreshold * 0.55, this.noiseFloor * 1.7);
      const isTransient = crest > 12 || (peak > openThreshold * 8 && rms < openThreshold);
      const above = rms >= openThreshold && !isTransient;

      if (above) {
        this.aboveGateFrames++;
        // A single strong frame can be speech; a weak one must persist for two
        // ticks (~40 ms) so one keyboard click cannot open the gate.
        if (this.aboveGateFrames >= 2 || rms >= openThreshold * 2.5) {
          this.gateHoldUntil = now + 420;
          this.lastSpeakingAt = now;
        }
      } else {
        this.aboveGateFrames = 0;
        if (this.localGateOpen && rms >= closeThreshold && !isTransient) {
          this.gateHoldUntil = now + 420;
          this.lastSpeakingAt = now;
        }
      }

      const gateOpenNow = now < this.gateHoldUntil;
      if (gateOpenNow !== this.localGateOpen) {
        this.localGateOpen = gateOpenNow;
        this.localGateGain?.gain.setTargetAtTime(
          gateOpenNow ? 1.0 : 0.0,
          ctx.currentTime,
          gateOpenNow ? 0.008 : 0.09
        );
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
    if (generation !== this.localStreamGeneration) return this.gatedLocalStream;

    return this.gatedLocalStream;
  }

  teardownLocalPipeline() {
    if (this.localVadTimer) {
      clearInterval(this.localVadTimer);
      this.localVadTimer = null;
    }
    try { this.relayTap?.port.postMessage({ enabled: false }); } catch {}
    try { this.relayTap?.disconnect(); } catch {}
    try { this.silentMonitorGain?.disconnect(); } catch {}
    try { this.localSource?.disconnect(); } catch {}
    try { this.localHpFilter?.disconnect(); } catch {}
    try { this.localLpFilter?.disconnect(); } catch {}
    try { this.localCompressor?.disconnect(); } catch {}
    try { this.localMakeupGain?.disconnect(); } catch {}
    try { this.localGateGain?.disconnect(); } catch {}
    this.relayTap = null;
    this.silentMonitorGain = null;
    this.localSource = null;
    this.localHpFilter = null;
    this.localLpFilter = null;
    this.localCompressor = null;
    this.localMakeupGain = null;
    this.localGateGain = null;
    this.localDest = null;
    this.localAnalyser = null;
    this.gatedLocalStream = null;
    this.localGateOpen = false;
    this.gateHoldUntil = 0;
    this.noiseFloor = 0.0015;
    this.aboveGateFrames = 0;
  }

  setRelayTargetsCount(count) {
    this.relayTargetsCount = Math.max(0, Number(count) || 0);
    if (this.relayTap) {
      try { this.relayTap.port.postMessage({ enabled: this.relayTargetsCount > 0 }); } catch {}
    }
  }

  setNoiseGateThreshold(threshold) {
    const parsed = Number(threshold);
    // Match the AudioWorklet parameter's minValue so the UI slider is honest.
    this.noiseGateThreshold = Math.max(0.001, Math.min(0.15, Number.isFinite(parsed) ? parsed : 0.0012));
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this.buses.forEach((bus) => {
      try {
        bus.scrambler.parameters.get('noiseGateThreshold').setTargetAtTime(this.noiseGateThreshold, now, 0.02);
      } catch {}
    });
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

    // Preview the same voice the other players will hear: take the tap after
    // the VAD gate, not the raw microphone, so "Тест голосу" respects the same
    // noise gate in both gibberish and atmospheric modes.
    const monitoredStream = this.gatedLocalStream || this.rawLocalStream;
    const mode = this.resolveSelfMonitorMode();
    const preset = this.resolveSelfMonitorPreset();
    this.selfMonitorChain = this.createProcessingChain(monitoredStream, mode, preset);
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
