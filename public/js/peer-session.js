/**
 * Pure helpers for WebRTC session robustness: peer reconciliation, recoverable
 * transport state, perfect-negotiation decision logic and ICE queue bounds.
 * No browser globals are touched at import time so everything can be unit
 * tested in Node and loaded as a classic script in the browser.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PeerSession = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const TRANSPORT_STATE = {
    CONNECTING: 'connecting',
    DIRECT: 'direct',
    RELAY: 'relay',
    RECONNECTING: 'reconnecting'
  };

  const RELEVANT_PEER_FIELDS = [
    'clientId', 'characterId', 'role', 'displayName', 'title', 'icon', 'avatarColor',
    'understood', 'languageId', 'languageName', 'languageIcon', 'languageColor',
    'isSpeaking', 'speakingLevel', 'mutedByWhisper', 'isWhisperToMe'
  ];

  function peerSignature(peer) {
    if (!peer) return '';
    return RELEVANT_PEER_FIELDS
      .map((field) => `${field}=${peer[field] == null ? '' : String(peer[field])}`)
      .join('|');
  }

  /**
   * Diffs the current peer map against an authoritative snapshot.
   * Accepts Maps or arrays of peer objects (from `JOIN_SUCCESS` / `STATE_SYNC`).
   */
  function toPeerMap(value) {
    if (value instanceof Map) return value;
    if (!value) return new Map();
    if (Array.isArray(value)) return new Map(value.map((p) => [p.clientId, p]));
    const map = new Map();
    for (const [id, peer] of Object.entries(value)) map.set(id, peer);
    return map;
  }

  function reconcilePeers(current, snapshot) {
    const before = toPeerMap(current);
    const after = toPeerMap(snapshot);
    const added = [];
    const removed = [];
    const updated = [];
    const unchanged = [];

    for (const [id, peer] of after) {
      if (!before.has(id)) added.push(peer);
      else if (peerSignature(before.get(id)) !== peerSignature(peer)) updated.push(peer);
      else unchanged.push(id);
    }
    for (const id of before.keys()) {
      if (!after.has(id)) removed.push(id);
    }
    return { added, removed, updated, unchanged };
  }

  function capIceQueue(queue, limit) {
    const max = Math.max(1, Number(limit) || 64);
    if (!Array.isArray(queue)) return [];
    return queue.length > max ? queue.slice(queue.length - max) : queue.slice();
  }

  /** Attaches a session epoch to signaling payloads without losing WebIDL fields. */
  function withEpoch(value, epoch) {
    if (!value) return value;
    const plain = typeof value.toJSON === 'function' ? value.toJSON() : { ...value };
    // RTCSessionDescription exposes type/sdp via prototype accessors in some
    // browsers, so an object spread alone can silently drop them.
    if (plain.type === undefined && value.type !== undefined) plain.type = value.type;
    if (plain.sdp === undefined && value.sdp !== undefined) plain.sdp = value.sdp;
    return { ...plain, epoch };
  }

  /**
   * Per-peer transport state. Direct audio is always preferred; relay is a
   * fallback that is progressively re-probed, never a sticky dead end. Inbound
   * relay packets only mark relay availability — they do not downgrade a healthy
   * direct connection.
   */
  class TransportStateMachine {
    constructor(options = {}) {
      this.fallbackMs = Number(options.fallbackMs) || 12000;
      this.baseBackoffMs = Number(options.baseBackoffMs) || 1000;
      this.maxBackoffMs = Number(options.maxBackoffMs) || 30000;
      this.reset(0);
    }

    reset(nowMs = 0) {
      this.state = TRANSPORT_STATE.CONNECTING;
      this.relayAvailable = false;
      this.directAttempts = 0;
      this.startedAt = nowMs;
      this.nextAttemptAt = Infinity;
    }

    get canSendRelay() {
      return this.state === TRANSPORT_STATE.RELAY;
    }

    noteDirectConnected(nowMs) {
      this.state = TRANSPORT_STATE.DIRECT;
      this.directAttempts = 0;
      this.nextAttemptAt = Infinity;
      this.lastDirectAt = nowMs;
    }

    /** Inbound relay audio: availability only, never a downgrade by itself. */
    noteRelayAvailable(nowMs) {
      this.relayAvailable = true;
      return this.tick(nowMs);
    }

    noteDirectFailure(nowMs) {
      if (this.relayAvailable) {
        this.enterRelay(nowMs);
      } else {
        this.scheduleProbe(nowMs);
        this.state = TRANSPORT_STATE.RECONNECTING;
      }
    }

    enterRelay(nowMs) {
      this.state = TRANSPORT_STATE.RELAY;
      this.scheduleProbe(nowMs);
    }

    scheduleProbe(nowMs) {
      this.directAttempts++;
      const backoff = Math.min(
        this.maxBackoffMs,
        this.baseBackoffMs * (2 ** Math.max(0, this.directAttempts - 1))
      );
      this.nextAttemptAt = nowMs + backoff;
    }

    manualReconnect(nowMs) {
      this.directAttempts = 0;
      // The caller performs the restart; schedule the next automatic probe so
      // the periodic tick does not immediately issue a duplicate ICE restart.
      this.scheduleProbe(nowMs);
      this.state = TRANSPORT_STATE.RECONNECTING;
      return 'restart-ice';
    }

    /** Returns an action to perform ('use-relay' | 'restart-ice') or null. */
    tick(nowMs) {
      if (this.state === TRANSPORT_STATE.CONNECTING && nowMs - this.startedAt >= this.fallbackMs) {
        if (this.relayAvailable) {
          this.enterRelay(nowMs);
          return 'use-relay';
        }
        // No direct connection and no relay path yet: retry ICE rather than
        // leaving the peer stuck in "connecting" forever.
        this.scheduleProbe(nowMs);
        this.state = TRANSPORT_STATE.RECONNECTING;
        return 'restart-ice';
      }
      if ((this.state === TRANSPORT_STATE.RECONNECTING || this.state === TRANSPORT_STATE.RELAY) &&
          nowMs >= this.nextAttemptAt) {
        this.state = TRANSPORT_STATE.CONNECTING;
        this.startedAt = nowMs;
        return 'restart-ice';
      }
      return null;
    }
  }

  /**
   * Perfect-negotiation policy (https://w3c.github.io/webrtc-pc/#perfect-negotiation).
   * `pc` only needs: signalingState, localDescription, createOffer(),
   * createAnswer(), setLocalDescription(), setRemoteDescription(). `send` gets
   * the local description to signal to the peer.
   */
  class PerfectNegotiator {
    constructor(options = {}) {
      this.polite = !!options.polite;
      this.send = typeof options.send === 'function' ? options.send : () => {};
      this.makingOffer = false;
      this.ignoreOffer = false;
      this.isSettingRemoteAnswerPending = false;
    }

    async onNegotiationNeeded(pc) {
      if (this.makingOffer || pc.signalingState !== 'stable') return false;
      this.ignoreOffer = false; // a fresh negotiation supersedes a lost glare
      this.makingOffer = true;
      try {
        await pc.setLocalDescription(await pc.createOffer());
        this.send(pc.localDescription);
        return true;
      } finally {
        this.makingOffer = false;
      }
    }

    /** Handles both offers and answers. The answerer never creates an offer. */
    async onRemoteDescription(pc, description) {
      if (!description || !description.type) return false;
      if (description.type === 'answer') {
        if (pc.signalingState !== 'have-local-offer') return false;
        this.isSettingRemoteAnswerPending = true;
        try {
          await pc.setRemoteDescription(description);
          return true;
        } finally {
          this.isSettingRemoteAnswerPending = false;
        }
      }

      const readyForOffer = !this.makingOffer &&
        (pc.signalingState === 'stable' || this.isSettingRemoteAnswerPending);
      const offerCollision = !readyForOffer;
      this.ignoreOffer = !this.polite && offerCollision;
      if (this.ignoreOffer) return false;

      if (offerCollision && pc.signalingState !== 'closed') {
        try { await pc.setLocalDescription({ type: 'rollback' }); } catch {}
      }
      await pc.setRemoteDescription(description);
      await pc.setLocalDescription(await pc.createAnswer());
      this.send(pc.localDescription);
      return true;
    }

    shouldAcceptCandidate() {
      return !this.ignoreOffer;
    }
  }

  return {
    TRANSPORT_STATE,
    RELEVANT_PEER_FIELDS,
    peerSignature,
    reconcilePeers,
    capIceQueue,
    withEpoch,
    TransportStateMachine,
    PerfectNegotiator
  };
});
