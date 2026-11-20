'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const protocol = require('../public/js/audio-protocol');
const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'scrambler-worklet.js'), 'utf8'
);

class FakePort {
  constructor() {
    this.messages = [];
    this.onmessage = null;
  }
  postMessage(data, transfer) {
    this.messages.push({ data, transfer });
  }
  send(data) {
    if (this.onmessage) this.onmessage({ data });
  }
}

class FakeAudioWorkletProcessor {
  constructor() {
    this.port = new FakePort();
  }
}

function loadProcessors() {
  const registered = Object.create(null);
  const sandbox = {
    AudioWorkletProcessor: FakeAudioWorkletProcessor,
    registerProcessor: (name, klass) => { registered[name] = klass; },
    RelayProtocol: protocol,
    sampleRate: 48000,
    currentTime: 0,
    ArrayBuffer,
    Float32Array,
    Int16Array,
    Math
  };
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox);
  return { registered, sandbox };
}

test('relay tap is registered and encodes transferable PCM only while enabled', () => {
  const { registered, sandbox } = loadProcessors();
  assert.ok(registered['polyglot-scrambler-processor']);
  assert.ok(registered['polyglot-relay-tap-processor']);

  const Tap = registered['polyglot-relay-tap-processor'];
  const tap = new Tap();
  const input = new Float32Array(4800).fill(0.5); // 100 ms of speech at 48 kHz
  const outputs = [[new Float32Array(128)]];
  const inputs = [[input]];

  // Disabled by default; output stays silent.
  assert.equal(tap.process(inputs, outputs), true);
  assert.equal(tap.port.messages.length, 0);
  assert.ok(outputs[0][0].every((v) => v === 0));

  // Port message alone enables capture (no AudioParam involved).
  tap.port.send({ enabled: true });
  sandbox.currentTime = 0.1;
  tap.process(inputs, outputs);
  assert.ok(tap.port.messages.length > 0, 'enabled tap emits PCM chunks');

  const first = tap.port.messages[0];
  assert.equal(first.data.sampleRate, 24000);
  assert.ok(first.data.pcm instanceof ArrayBuffer);
  assert.equal(first.data.pcm.byteLength, 480 * 2, '20 ms at 24 kHz as Int16');
  assert.equal(first.transfer[0], first.data.pcm, 'buffer is transferred, not copied');

  // Disabling stops capture immediately.
  tap.port.send({ enabled: false });
  const before = tap.port.messages.length;
  sandbox.currentTime = 0.3;
  tap.process(inputs, outputs);
  assert.equal(tap.port.messages.length, before);
});

test('relay tap fails fast when RelayProtocol is missing', () => {
  let captured;
  const sandbox = {
    AudioWorkletProcessor: FakeAudioWorkletProcessor,
    registerProcessor: (name, klass) => {
      if (name === 'polyglot-relay-tap-processor') captured = klass;
    },
    sampleRate: 48000,
    currentTime: 0,
    ArrayBuffer,
    Float32Array,
    Int16Array,
    Math
  };
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox);
  assert.ok(captured);
  assert.throws(() => new captured(), /RelayProtocol must be loaded/);
});
