'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { keyFor } = require('../public/js/dsp-bus-registry');

const PRESET = {
  grainSizeMs: 145, pitchRatio: 0.88, formantShiftHz: -220, subOctaveMix: 0.15,
  ringModHz: 0, ringModMix: 0, reverbMix: 0.35, chorusMix: 0.25,
  filterType: 'bandpass', filterFreq: 1100, atmosphereMix: 0.22
};

class FakeParam {
  constructor(value = 0) {
    this.value = value;
    this.calls = [];
  }
  setTargetAtTime(value, time, tau) {
    this.value = value;
    this.calls.push({ value, time, tau });
  }
}

class FakeNode {
  constructor(ctx, kind) {
    this.ctx = ctx;
    this.kind = kind;
    this.connections = [];
  }
  connect(target) {
    this.connections.push(target);
    return target;
  }
  disconnect(target) {
    if (target === undefined) this.connections = [];
    else this.connections = this.connections.filter((c) => c !== target);
  }
}

class FakeAudioWorkletNode extends FakeNode {
  constructor(ctx, name) {
    super(ctx, `worklet:${name}`);
    ctx.workletCount = (ctx.workletCount || 0) + 1;
    this.name = name;
    const params = new Map();
    this.parameters = {
      get(key) {
        if (!params.has(key)) params.set(key, new FakeParam(0));
        return params.get(key);
      }
    };
    this.port = { postMessage() {}, onmessage: null };
  }
}

class FakeAudioContext {
  constructor() {
    this.sampleRate = 48000;
    this.currentTime = 0;
    this.state = 'running';
    this.destination = new FakeNode(this, 'destination');
    this.audioWorklet = { addModule: async () => {} };
    this.workletCount = 0;
  }
  async resume() { this.state = 'running'; }
  createGain() {
    const node = new FakeNode(this, 'gain');
    node.gain = new FakeParam(1);
    return node;
  }
  createBiquadFilter() {
    const node = new FakeNode(this, 'biquad');
    node.type = 'allpass';
    node.frequency = new FakeParam(350);
    node.Q = new FakeParam(1);
    node.gain = new FakeParam(0);
    return node;
  }
  createDelay() {
    const node = new FakeNode(this, 'delay');
    node.delayTime = new FakeParam(0);
    return node;
  }
  createOscillator() {
    const node = new FakeNode(this, 'oscillator');
    node.type = 'sine';
    node.frequency = new FakeParam(440);
    node.start = () => {};
    node.stop = () => {};
    return node;
  }
  createConvolver() {
    const node = new FakeNode(this, 'convolver');
    node.buffer = null;
    return node;
  }
  createMediaStreamSource() { return new FakeNode(this, 'source'); }
  createBuffer(channels, length, rate) {
    const data = new Float32Array(length);
    return { getChannelData: () => data, duration: length / rate };
  }
  createBufferSource() {
    const node = new FakeNode(this, 'bufferSource');
    node.start = () => {};
    return node;
  }
}

const ENGINE_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'audio-engine.js'), 'utf8'
);

function createEngine() {
  const registryApi = require('../public/js/dsp-bus-registry');
  const registry = registryApi.DspBusRegistry;
  registry.keyFor = registryApi.keyFor;
  registry.presetSignature = registryApi.presetSignature;
  const sandbox = {
    window: { AudioContext: FakeAudioContext },
    document: { createElement: () => ({ play: () => Promise.resolve(), srcObject: null }) },
    AudioWorkletNode: FakeAudioWorkletNode,
    DspBusRegistry: registry,
    console,
    setInterval,
    clearInterval,
    Float32Array,
    Int16Array
  };
  vm.createContext(sandbox);
  vm.runInContext(ENGINE_SOURCE, sandbox);
  return new sandbox.window.PolyglotAudioEngine();
}

const gibberishPeer = (languageId) => ({ understood: false, languageId, dspPreset: PRESET });

test('peers with the same mode/preset share one DSP bus and keep separate send gains', async () => {
  const engine = createEngine();
  await engine.ensureInitialized();

  await engine.attachPeerStream('p1', {}, gibberishPeer('ancient'));
  await engine.attachPeerStream('p2', {}, gibberishPeer('vlach'));

  assert.equal(engine.buses.size, 1, 'one bus for two identical mode/preset peers');
  assert.equal(engine.ctx.workletCount, 1, 'one scrambler worklet instead of two');
  const bus = engine.buses.get(keyFor('GIBBERISH', PRESET));
  assert.ok(bus);
  const c1 = engine.peerChains.get('p1');
  const c2 = engine.peerChains.get('p2');
  assert.equal(c1.bus, bus);
  assert.equal(c2.bus, bus);
  assert.notEqual(c1.sendGain, c2.sendGain);
  assert.ok(c1.sendGain.connections.includes(bus.inputNode));
  assert.ok(c2.sendGain.connections.includes(bus.inputNode));
});

test('switching a peer to CLEAN adds a bus; detaching the last GIBBERISH peer destroys it', async () => {
  const engine = createEngine();
  await engine.ensureInitialized();

  await engine.attachPeerStream('p1', {}, gibberishPeer('ancient'));
  await engine.attachPeerStream('p2', {}, gibberishPeer('vlach'));
  const gibberishKey = keyFor('GIBBERISH', PRESET);
  const gibberishBus = engine.buses.get(gibberishKey);

  engine.updatePeerLanguage('p1', { understood: true, languageId: 'common' });
  assert.equal(engine.buses.size, 2);
  assert.equal(engine.peerChains.get('p1').busKey, 'CLEAN');
  assert.equal(engine.peerChains.get('p2').bus, gibberishBus);

  let destroyed = 0;
  gibberishBus.destroy = () => { destroyed++; };
  engine.detachPeerStream('p2');
  assert.equal(destroyed, 1, 'last reference triggers destroy');
  assert.equal(engine.buses.size, 1);
  assert.equal(engine.peerChains.has('p2'), false);
});

test('volume/mute apply to the per-peer send gain, not the shared bus', async () => {
  const engine = createEngine();
  await engine.ensureInitialized();
  await engine.attachPeerStream('p1', {}, gibberishPeer('ancient'));

  const chain = engine.peerChains.get('p1');
  engine.setPeerVolume('p1', 0.5);
  assert.equal(chain.sendGain.gain.value, 0.5);
  engine.setPeerMuted('p1', true);
  assert.equal(chain.sendGain.gain.value, 0);
  engine.setPeerMuted('p1', false);
  assert.equal(chain.sendGain.gain.value, 0.5);
});

test('per-peer audio prefs survive chain replacement and seed relay chains', async () => {
  const engine = createEngine();
  await engine.ensureInitialized();

  // app.js seeds prefs when the peer connection is created, before any chain exists.
  engine.setPeerAudioPref('p1', { volume: 0.35, muted: true });
  assert.equal(engine.peerChains.has('p1'), false, 'seeding prefs creates no chain');

  await engine.attachPeerStream('p1', {}, gibberishPeer('ancient'));
  let chain = engine.peerChains.get('p1');
  assert.equal(chain.userVolume, 0.35);
  assert.equal(chain.userMuted, true);
  assert.equal(chain.sendGain.gain.value, 0);

  // A WebRTC reconnect destroys and recreates the chain, but the pref persists.
  await engine.attachPeerStream('p1', {}, gibberishPeer('ancient'));
  chain = engine.peerChains.get('p1');
  assert.equal(chain.userVolume, 0.35);
  assert.equal(chain.userMuted, true);

  // Relay-only peers get the same stored prefs when their chain is created.
  engine.setPeerAudioPref('p2', { volume: 0.7, muted: false });
  const relayChain = await engine.ensureRelayChain('p2', { understood: true, languageId: 'common' });
  assert.equal(relayChain.userVolume, 0.7);
  assert.equal(relayChain.userMuted, false);

  // The legacy setters keep the stored pref in sync for future chains.
  engine.setPeerVolume('p2', 1.5);
  engine.setPeerMuted('p2', true);
  await engine.attachPeerStream('p2', {}, { understood: true, languageId: 'common' });
  assert.equal(engine.peerChains.get('p2').userVolume, 1.5);
  assert.equal(engine.peerChains.get('p2').userMuted, true);
});

test('setNoiseGateThreshold updates every live bus', async () => {
  const engine = createEngine();
  await engine.ensureInitialized();
  await engine.attachPeerStream('p1', {}, gibberishPeer('ancient'));
  await engine.attachPeerStream('p2', {}, { understood: true, languageId: 'common' });

  engine.setNoiseGateThreshold(0.01);
  let checked = 0;
  engine.buses.forEach((bus) => {
    assert.equal(bus.scrambler.parameters.get('noiseGateThreshold').value, 0.01);
    checked++;
  });
  assert.equal(checked, 2);
});
