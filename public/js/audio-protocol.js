/**
 * Binary PCM relay protocol shared by the browser, the AudioWorklet, the server,
 * and Node tests. Loaded as a classic script (window.RelayProtocol), as a worklet
 * module (globalThis.RelayProtocol) or through require() — no browser-only APIs
 * are used at import time.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RelayProtocol = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const RELAY_VERSION = 1;
  const RELAY_TARGET_RATE = 24000;
  const RELAY_CHUNK_SAMPLES = 480; // 20 ms at 24 kHz
  const MAX_RELAY_TARGETS = 8;
  const MAX_PCM_BYTES = 32768;
  const MAX_ID_BYTES = 64;
  const RELAY_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

  function isRelayId(id) {
    return typeof id === 'string' && RELAY_ID_RE.test(id);
  }

  /**
   * Splits relay targets into frames of at most MAX_RELAY_TARGETS ids. Every
   * frame carries the same PCM chunk: rotating mutually exclusive subsets would
   * make listeners in a room larger than 8 lose most of their audio.
   */
  function chunkRelayTargets(ids, size = MAX_RELAY_TARGETS) {
    const requested = size === undefined || size === null ? MAX_RELAY_TARGETS : Number(size);
    const limit = Number.isFinite(requested) ? Math.max(0, Math.floor(requested)) : MAX_RELAY_TARGETS;
    if (limit === 0) return [];
    const seen = new Set();
    const list = (Array.isArray(ids) ? ids : []).filter((id) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    const batches = [];
    for (let i = 0; i < list.length; i += limit) batches.push(list.slice(i, i + limit));
    return batches;
  }

  function asciiBytes(str) {
    const out = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0x7f;
    return out;
  }

  function asciiString(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
    return out;
  }

  /**
   * Encodes one relay frame. PCM is Int16 little-endian, uncompressed.
   * Layout: version, flags, sampleRate(u16), sequence(u16), senderLen+sender,
   * targetCount, [len+id]*, pcm.
   */
  function encodeRelayFrame(frame) {
    const { senderId, targetIds, sampleRate, sequence, pcm } = frame || {};
    if (!isRelayId(senderId)) throw new Error('Invalid senderId');
    if (!Array.isArray(targetIds) || targetIds.length < 1 || targetIds.length > MAX_RELAY_TARGETS) {
      throw new Error('Invalid relay targets');
    }
    for (const id of targetIds) {
      if (!isRelayId(id)) throw new Error('Invalid relay target id');
    }
    const rate = Number(sampleRate);
    if (!Number.isInteger(rate) || rate < 8000 || rate > 48000) throw new Error('Invalid sampleRate');
    if (!(pcm instanceof Int16Array)) throw new Error('PCM must be Int16Array');

    const pcmBytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    if (pcmBytes.length === 0 || pcmBytes.length > MAX_PCM_BYTES) throw new Error('Invalid PCM size');

    const sender = asciiBytes(senderId);
    const targets = targetIds.map(asciiBytes);
    let total = 7 + sender.length + 1;
    for (const bytes of targets) total += 1 + bytes.length;
    total += pcmBytes.length;

    const buffer = new ArrayBuffer(total);
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    view.setUint8(0, RELAY_VERSION);
    view.setUint8(1, 0);
    view.setUint16(2, rate, true);
    view.setUint16(4, (Number(sequence) || 0) & 0xffff, true);
    view.setUint8(6, sender.length);

    let offset = 7;
    bytes.set(sender, offset);
    offset += sender.length;
    view.setUint8(offset++, targets.length);
    for (const bytesOfId of targets) {
      view.setUint8(offset++, bytesOfId.length);
      bytes.set(bytesOfId, offset);
      offset += bytesOfId.length;
    }
    bytes.set(pcmBytes, offset);
    return buffer;
  }

  /** Decodes and fully validates a frame. Throws on any malformed input. */
  function decodeRelayFrame(data) {
    const bytes = data instanceof Uint8Array
      ? data
      : new Uint8Array(data && data.buffer ? data.buffer : data);
    if (bytes.byteLength < 8) throw new Error('Relay frame too short');

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint8(0) !== RELAY_VERSION) throw new Error('Unsupported relay version');
    if (view.getUint8(1) !== 0) throw new Error('Unsupported relay flags');

    const sampleRate = view.getUint16(2, true);
    if (sampleRate < 8000 || sampleRate > 48000) throw new Error('Invalid sampleRate in frame');
    const sequence = view.getUint16(4, true);

    const senderLen = view.getUint8(6);
    let offset = 7;
    if (senderLen < 1 || senderLen > MAX_ID_BYTES || offset + senderLen > bytes.length) {
      throw new Error('Invalid sender length');
    }
    const senderId = asciiString(bytes.subarray(offset, offset + senderLen));
    offset += senderLen;
    if (!isRelayId(senderId)) throw new Error('Invalid sender id');

    if (offset >= bytes.length) throw new Error('Missing target count');
    const targetCount = view.getUint8(offset++);
    if (targetCount < 1 || targetCount > MAX_RELAY_TARGETS) throw new Error('Invalid target count');

    const targetIds = [];
    for (let i = 0; i < targetCount; i++) {
      if (offset >= bytes.length) throw new Error('Truncated target list');
      const len = view.getUint8(offset++);
      if (len < 1 || len > MAX_ID_BYTES || offset + len > bytes.length) {
        throw new Error('Invalid target id length');
      }
      const id = asciiString(bytes.subarray(offset, offset + len));
      offset += len;
      if (!isRelayId(id)) throw new Error('Invalid target id');
      targetIds.push(id);
    }

    // Buffer.slice() is zero-copy in Node; construct a fresh typed array so the
    // Int16Array always starts at byte 0 of its own buffer.
    const pcmBytes = new Uint8Array(bytes.subarray(offset));
    if (pcmBytes.length === 0 || pcmBytes.length > MAX_PCM_BYTES || pcmBytes.length % 2 !== 0) {
      throw new Error('Invalid PCM payload');
    }
    const pcm = new Int16Array(pcmBytes.buffer);
    return { senderId, targetIds, sampleRate, sequence, pcm, pcmBytes };
  }

  function int16ToFloat32(pcm) {
    const out = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) {
      out[i] = pcm[i] / (pcm[i] < 0 ? 32768 : 32767);
    }
    return out;
  }

  /** Decodes legacy base64 JSON relay payloads from pre-v2 clients. */
  function decodeBase64Pcm(base64) {
    if (typeof base64 !== 'string' || base64.length === 0 || base64.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
      throw new Error('Invalid base64 PCM');
    }
    let binary;
    if (typeof atob === 'function') {
      binary = atob(base64);
    } else {
      binary = Buffer.from(base64, 'base64').toString('binary');
    }
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i) & 0xff;
    if (bytes.length === 0 || bytes.length % 2 !== 0 || bytes.length > MAX_PCM_BYTES) {
      throw new Error('Invalid PCM payload');
    }
    return new Int16Array(bytes.buffer);
  }

  function float32ToInt16(input) {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const clamped = Math.max(-1, Math.min(1, input[i]));
      out[i] = clamped < 0 ? clamped * 32768 : clamped * 32767;
    }
    return out;
  }

  /**
   * Pure, browser-independent resampler + voice hold used by the relay tap
   * worklet. It uses no AudioContext APIs so it can be unit tested in Node.
   */
  class RelayPcmEncoder {
    constructor(options = {}) {
      this.inputRate = Number(options.inputRate) || 48000;
      this.outputRate = Number(options.outputRate) || RELAY_TARGET_RATE;
      this.ratio = this.inputRate / this.outputRate;
      this.chunkSamples = Number(options.chunkSamples) || RELAY_CHUNK_SAMPLES;
      const gateThreshold = Number(options.gateThreshold);
      // Explicit 0 means "always relay"; do not collapse it to the default.
      this.gateThreshold = Number.isFinite(gateThreshold) ? Math.max(0, gateThreshold) : 0.0008;
      this.holdMs = Number(options.holdMs) || 800;

      this.carry = 0;
      this.sum = 0;
      this.sumCount = 0;
      this.pending = new Int16Array(this.chunkSamples);
      this.pendingCount = 0;
      this.holdUntilMs = -Infinity;
    }

    reset() {
      this.carry = 0;
      this.sum = 0;
      this.sumCount = 0;
      this.pendingCount = 0;
      this.holdUntilMs = -Infinity;
    }

    /** Pushes one block of Float32 samples; returns completed Int16Array chunks. */
    push(input, nowMs) {
      const chunks = [];
      let blockPeak = 0;
      for (let i = 0; i < input.length; i++) {
        const sample = input[i];
        const abs = sample < 0 ? -sample : sample;
        if (abs > blockPeak) blockPeak = abs;

        this.sum += sample;
        this.sumCount++;
        this.carry++;

        if (this.carry >= this.ratio) {
          this.carry -= this.ratio;
          // Only the samples feeding this output count. A click at the end of a
          // large block must not reopen the gate for its earlier silence.
          if (blockPeak >= this.gateThreshold) this.holdUntilMs = nowMs + this.holdMs;
          blockPeak = 0;
          if (nowMs <= this.holdUntilMs) {
            const value = this.sum / Math.max(1, this.sumCount);
            this.pending[this.pendingCount++] = value < 0
              ? Math.max(-32768, value * 32768)
              : Math.min(32767, value * 32767);
            if (this.pendingCount >= this.chunkSamples) {
              chunks.push(this.pending);
              this.pending = new Int16Array(this.chunkSamples);
              this.pendingCount = 0;
            }
          }
          this.sum = 0;
          this.sumCount = 0;
        }
      }
      return chunks;
    }
  }

  return {
    RELAY_VERSION,
    RELAY_TARGET_RATE,
    RELAY_CHUNK_SAMPLES,
    MAX_RELAY_TARGETS,
    MAX_PCM_BYTES,
    MAX_ID_BYTES,
    RELAY_ID_RE,
    isRelayId,
    chunkRelayTargets,
    encodeRelayFrame,
    decodeRelayFrame,
    decodeBase64Pcm,
    int16ToFloat32,
    float32ToInt16,
    RelayPcmEncoder
  };
});
