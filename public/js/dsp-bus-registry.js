/**
 * Pure reference-counted registry for shared DSP buses. Keys are derived from
 * the processing mode plus the DSP preset, so peers that hear the same language
 * treatment reuse one expensive scrambler/convolver chain instead of getting a
 * private copy each. No Web Audio APIs here — the engine supplies the factory.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    // Browsers get the constructor itself, with helpers attached as statics, so
    // both `new DspBusRegistry(...)` and `DspBusRegistry.keyFor(...)` work.
    const Klass = api.DspBusRegistry;
    Klass.keyFor = api.keyFor;
    Klass.presetSignature = api.presetSignature;
    Klass.PRESET_FIELDS = api.PRESET_FIELDS;
    root.DspBusRegistry = Klass;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PRESET_FIELDS = [
    'grainSizeMs', 'pitchRatio', 'formantShiftHz', 'subOctaveMix', 'ringModHz',
    'ringModMix', 'reverbMix', 'chorusMix', 'filterType', 'filterFreq', 'atmosphereMix'
  ];

  function presetSignature(preset) {
    if (!preset || typeof preset !== 'object') return 'default';
    return PRESET_FIELDS
      .map((field) => {
        const value = preset[field];
        if (typeof value === 'number') return `${field}=${Number(value.toFixed(3))}`;
        return `${field}=${value == null ? 'null' : String(value)}`;
      })
      .join(';');
  }

  function keyFor(mode, preset) {
    const normalizedMode = mode || 'CLEAN';
    if (normalizedMode === 'CLEAN') return 'CLEAN';
    return `${normalizedMode}|${presetSignature(preset)}`;
  }

  class DspBusRegistry {
    constructor(factory) {
      if (typeof factory !== 'function') throw new Error('Bus factory is required');
      this.factory = factory;
      this.entries = new Map();
    }

    get size() {
      return this.entries.size;
    }

    has(key) {
      return this.entries.has(key);
    }

    get(key) {
      const entry = this.entries.get(key);
      return entry ? entry.bus : null;
    }

    refs(key) {
      const entry = this.entries.get(key);
      return entry ? entry.refs : 0;
    }

    /** Returns { bus, key, created }. */
    acquire(key, payload) {
      let entry = this.entries.get(key);
      let created = false;
      if (!entry) {
        entry = { bus: this.factory(payload || { key }), refs: 0 };
        this.entries.set(key, entry);
        created = true;
      }
      entry.refs++;
      return { bus: entry.bus, key, created };
    }

    release(key) {
      const entry = this.entries.get(key);
      if (!entry) return false;
      entry.refs--;
      if (entry.refs > 0) return false;
      this.entries.delete(key);
      if (entry.bus && typeof entry.bus.destroy === 'function') entry.bus.destroy();
      return true;
    }

    forEach(callback) {
      for (const [key, entry] of this.entries) callback(entry.bus, key, entry.refs);
    }

    clear() {
      for (const [key, entry] of [...this.entries]) {
        this.entries.delete(key);
        if (entry.bus && typeof entry.bus.destroy === 'function') entry.bus.destroy();
      }
    }
  }

  return { DspBusRegistry, keyFor, presetSignature, PRESET_FIELDS };
});
