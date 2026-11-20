'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { DspBusRegistry, keyFor, presetSignature } = require('../public/js/dsp-bus-registry');

const PRESET_A = {
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

test('bus keys ignore presets for CLEAN and are stable regardless of field order', () => {
  assert.equal(keyFor('CLEAN', PRESET_A), 'CLEAN');
  assert.equal(keyFor('CLEAN', null), 'CLEAN');

  const shuffled = Object.fromEntries(Object.entries(PRESET_A).reverse());
  assert.equal(keyFor('GIBBERISH', PRESET_A), keyFor('GIBBERISH', shuffled));
  assert.notEqual(keyFor('GIBBERISH', PRESET_A), keyFor('ATMOSPHERIC', PRESET_A));
  assert.notEqual(keyFor('GIBBERISH', PRESET_A), keyFor('GIBBERISH', { ...PRESET_A, pitchRatio: 0.9 }));
  assert.equal(presetSignature(null), 'default');
});

test('registry reuses one bus across peers and destroys it after the last release', () => {
  const created = [];
  const destroyed = [];
  const registry = new DspBusRegistry((payload) => {
    const bus = {
      key: payload.key,
      destroy() { destroyed.push(this.key); }
    };
    created.push(bus);
    return bus;
  });

  const key = keyFor('GIBBERISH', PRESET_A);
  const first = registry.acquire(key, { key, mode: 'GIBBERISH', preset: PRESET_A });
  const second = registry.acquire(key, { key, mode: 'GIBBERISH', preset: PRESET_A });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.bus, second.bus);
  assert.equal(created.length, 1);
  assert.equal(registry.refs(key), 2);

  assert.equal(registry.release(key), false);
  assert.equal(registry.get(key), first.bus);
  assert.equal(registry.release(key), true);
  assert.equal(registry.has(key), false);
  assert.deepEqual(destroyed, [key]);
});

test('registry isolates different modes/presets and clear() destroys everything', () => {
  const destroyed = [];
  const registry = new DspBusRegistry((payload) => ({
    key: payload.key,
    destroy() { destroyed.push(this.key); }
  }));

  const gibberish = keyFor('GIBBERISH', PRESET_A);
  const atmospheric = keyFor('ATMOSPHERIC', PRESET_A);
  registry.acquire(gibberish, { key: gibberish });
  registry.acquire(atmospheric, { key: atmospheric });
  assert.equal(registry.size, 2);

  const seen = [];
  registry.forEach((_bus, key) => seen.push(key));
  assert.deepEqual(seen.sort(), [atmospheric, gibberish].sort());

  registry.clear();
  assert.equal(registry.size, 0);
  assert.deepEqual(destroyed.sort(), [atmospheric, gibberish].sort());
});
