'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const protocol = require('../public/js/audio-protocol');
const {
  RELAY_VERSION,
  RELAY_TARGET_RATE,
  RELAY_CHUNK_SAMPLES,
  MAX_RELAY_TARGETS,
  MAX_PCM_BYTES,
  encodeRelayFrame,
  decodeRelayFrame,
  int16ToFloat32,
  float32ToInt16,
  RelayPcmEncoder,
  chunkRelayTargets
} = protocol;

const SENDER = '11111111-2222-3333-4444-555555555555';
const TARGET_A = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const TARGET_B = 'ffffffff-0000-1111-2222-333333333333';

function makePcm(length = 960) {
  const pcm = new Int16Array(length);
  for (let i = 0; i < length; i++) pcm[i] = Math.round(Math.sin(i / 12) * 12000);
  return pcm;
}

test('encode/decode relay frame round-trips all fields without loss', () => {
  const pcm = makePcm();
  const buffer = encodeRelayFrame({
    senderId: SENDER,
    targetIds: [TARGET_A, TARGET_B],
    sampleRate: RELAY_TARGET_RATE,
    sequence: 4242,
    pcm
  });
  assert.equal(buffer.byteLength, 7 + SENDER.length + 1 + (1 + TARGET_A.length) + (1 + TARGET_B.length) + pcm.byteLength);

  const frame = decodeRelayFrame(buffer);
  assert.equal(frame.senderId, SENDER);
  assert.deepEqual(frame.targetIds, [TARGET_A, TARGET_B]);
  assert.equal(frame.sampleRate, RELAY_TARGET_RATE);
  assert.equal(frame.sequence, 4242);
  assert.deepEqual(Array.from(frame.pcm), Array.from(pcm));
  assert.equal(frame.pcmBytes.byteLength, pcm.byteLength);
});

test('decodeRelayFrame accepts Node Buffer views and rejects malformed input', () => {
  const valid = Buffer.from(encodeRelayFrame({
    senderId: SENDER,
    targetIds: [TARGET_A],
    sampleRate: 24000,
    sequence: 1,
    pcm: makePcm(480)
  }));
  // Force a non-zero byteOffset to exercise DataView offset handling.
  const padded = Buffer.concat([Buffer.from([9, 9, 9]), valid, Buffer.from([9, 9])]);
  const fromOffset = decodeRelayFrame(padded.subarray(3, 3 + valid.length));
  assert.equal(fromOffset.senderId, SENDER);
  assert.deepEqual(Array.from(fromOffset.pcm), Array.from(makePcm(480)));

  assert.throws(() => decodeRelayFrame(Buffer.from([RELAY_VERSION, 0, 1])), /too short/);
  assert.throws(() => decodeRelayFrame(Buffer.from([99, 0, 0, 0, 0, 0, 1, 97, 1, 1, 98, 0, 0])), /version/);
  assert.throws(() => decodeRelayFrame(Buffer.concat([valid.subarray(0, 6), Buffer.from([0]), valid.subarray(7)])), /sender length/);
  assert.throws(() => decodeRelayFrame(Buffer.concat([valid.subarray(0, 7), Buffer.from([200]), valid.subarray(8)])), /Invalid sender id/);
  assert.throws(() => decodeRelayFrame(Buffer.concat([valid.subarray(0, 1), Buffer.from([1]), valid.subarray(2)])), /flags/);
  assert.throws(() => decodeRelayFrame(encodeRelayFrame({
    senderId: SENDER,
    targetIds: Array.from({ length: MAX_RELAY_TARGETS + 1 }, (_, i) => `target-${i}`),
    sampleRate: 24000,
    sequence: 0,
    pcm: makePcm(2)
  })), /Invalid relay targets/);
  assert.throws(() => decodeRelayFrame(Buffer.concat([valid, Buffer.from([0])])), /Invalid PCM payload/);
  assert.throws(() => decodeRelayFrame(encodeRelayFrame({
    senderId: SENDER,
    targetIds: [TARGET_A],
    sampleRate: 24000,
    sequence: 0,
    pcm: new Int16Array(MAX_PCM_BYTES / 2 + 1)
  })), /Invalid PCM size/);
});

test('PCM conversion helpers invert each other within quantization tolerance', () => {
  const pcm = makePcm(64);
  const float = int16ToFloat32(pcm);
  assert.equal(float.length, pcm.length);
  assert.ok(Math.abs(float[0] - pcm[0] / 32767) < 0.0001);
  const back = float32ToInt16(float);
  for (let i = 0; i < pcm.length; i++) {
    assert.ok(Math.abs(back[i] - pcm[i]) <= 1, `sample ${i} differs`);
  }
  const clamped = float32ToInt16(new Float32Array([2, -2, 0]));
  assert.equal(clamped[0], 32767);
  assert.equal(clamped[1], -32768);
  assert.equal(clamped[2], 0);
});

test('RelayPcmEncoder downsamples 48kHz to 24kHz in fixed 20ms chunks', () => {
  const encoder = new RelayPcmEncoder({ inputRate: 48000, outputRate: 24000, chunkSamples: RELAY_CHUNK_SAMPLES });
  const block = new Float32Array(48000).fill(0.25);
  let emitted = 0;
  let totalSamples = 0;
  for (let step = 0; step < 4; step++) {
    for (const chunk of encoder.push(block, step * 1000)) {
      emitted++;
      totalSamples += chunk.length;
      assert.equal(chunk.length, RELAY_CHUNK_SAMPLES);
    }
  }
  // 4 seconds at 24kHz = 96,000 samples = 200 chunks of 480.
  assert.equal(totalSamples, 96000);
  assert.equal(emitted, 200);
});

test('chunkRelayTargets sends every PCM chunk to every target', () => {
  const ids = Array.from({ length: MAX_RELAY_TARGETS * 2 + 1 }, (_, i) => `p${i}`);
  const batches = chunkRelayTargets(ids);
  assert.equal(batches.length, 3);
  assert.deepEqual(batches.flat(), ids, 'each target appears exactly once per PCM chunk');
  for (const batch of batches) {
    assert.ok(batch.length <= MAX_RELAY_TARGETS);
    assert.equal(new Set(batch).size, batch.length, 'no duplicate target in a frame');
  }
  assert.deepEqual(chunkRelayTargets(ids.slice(0, 3)), [ids.slice(0, 3)]);
  assert.deepEqual(chunkRelayTargets(null), []);
  assert.deepEqual(chunkRelayTargets(ids, 0), [], 'a zero cap sends nobody');
  assert.deepEqual(chunkRelayTargets([...ids, 'p0']).flat(), ids, 'duplicate ids are dropped');
});

test('RelayPcmEncoder treats an explicit zero gate threshold as always-on', () => {
  const encoder = new RelayPcmEncoder({
    inputRate: 48000,
    outputRate: 24000,
    chunkSamples: 240,
    gateThreshold: 0,
    holdMs: 0
  });
  assert.equal(encoder.gateThreshold, 0);
  assert.ok(encoder.push(new Float32Array(480).fill(0), 0).length > 0);
});

test('RelayPcmEncoder does not let a trailing click reopen earlier silence', () => {
  const encoder = new RelayPcmEncoder({
    inputRate: 48000,
    outputRate: 24000,
    chunkSamples: 240,
    gateThreshold: 0.05,
    holdMs: 0
  });
  const block = new Float32Array(4800);
  block[4799] = 0.9; // one click in the last output sample of a 10-chunk block
  assert.equal(encoder.push(block, 0).length, 0);
});

test('RelayPcmEncoder gates silence and keeps transmitting during the hold window', () => {
  const encoder = new RelayPcmEncoder({
    inputRate: 48000,
    outputRate: 24000,
    chunkSamples: 240,
    gateThreshold: 0.01,
    holdMs: 100
  });
  const loud = new Float32Array(4800).fill(0.5); // 100 ms of speech
  const silent = new Float32Array(4800).fill(0);

  assert.equal(encoder.push(silent, 0).length, 0);
  const speechChunks = encoder.push(loud, 10).length;
  assert.ok(speechChunks >= 9, `expected speech chunks, got ${speechChunks}`);
  // Immediately after speech the hold is still active.
  assert.ok(encoder.push(silent, 80).length > 0);
  // Well past the hold window silence must stop entirely.
  assert.equal(encoder.push(silent, 1000).length, 0);
});
