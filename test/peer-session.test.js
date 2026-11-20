'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TRANSPORT_STATE,
  reconcilePeers,
  capIceQueue,
  shouldSendRelay,
  withEpoch,
  TransportStateMachine,
  PerfectNegotiator
} = require('../public/js/peer-session');

function peer(id, overrides = {}) {
  return {
    clientId: id, characterId: `char-${id}`, role: 'player', displayName: id,
    understood: true, languageId: 'common', languageName: 'Загальна',
    ...overrides
  };
}

test('reconcilePeers diffs Maps and arrays into adds/removes/updates', () => {
  const a = peer('a');
  const b = peer('b');
  const bChanged = peer('b', { understood: false });
  const c = peer('c');

  let result = reconcilePeers(new Map([['a', a], ['b', b]]), [c, bChanged]);
  assert.deepEqual(result.added.map((p) => p.clientId), ['c']);
  assert.deepEqual(result.removed, ['a']);
  assert.deepEqual(result.updated.map((p) => p.clientId), ['b']);
  assert.deepEqual(result.unchanged, []);

  result = reconcilePeers([a, b], [a, b]);
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.updated, []);
  assert.deepEqual(result.unchanged, ['a', 'b']);

  result = reconcilePeers([], []);
  assert.deepEqual(result, { added: [], removed: [], updated: [], unchanged: [] });
});

test('reconcilePeers ignores unknown fields and treats null snapshots as empty', () => {
  const a = peer('a');
  const withExtra = { ...a, unrelatedTimer: 123, ephemeral: Math.random() };
  assert.deepEqual(reconcilePeers([a], [withExtra]).unchanged, ['a']);
  assert.deepEqual(reconcilePeers([a], null).removed, ['a']);
});

test('capIceQueue keeps only the newest candidates', () => {
  assert.deepEqual(capIceQueue([1, 2, 3, 4, 5], 3), [3, 4, 5]);
  assert.deepEqual(capIceQueue([1, 2], 5), [1, 2]);
  assert.deepEqual(capIceQueue(null, 5), []);
  assert.deepEqual(capIceQueue([1, 2, 3], 0), [1, 2, 3]);
});

test('relay stays armed until a direct connection is confirmed', () => {
  for (const state of ['connecting', 'reconnecting', 'relay', 'failed']) {
    assert.equal(shouldSendRelay(state), true, `${state} still needs the relay tap`);
  }
  assert.equal(shouldSendRelay('connected'), false);
});

test('withEpoch preserves WebIDL description/candidate fields on the prototype', () => {
  // Some browsers expose type/sdp as prototype accessors, not own properties.
  function FakeDescription(type, sdp) {
    Object.defineProperty(this, 'type', { get: () => type, enumerable: false });
    Object.defineProperty(this, 'sdp', { get: () => sdp, enumerable: false });
  }
  const desc = new FakeDescription('offer', 'v=0...');
  assert.deepEqual(withEpoch(desc, 7), { type: 'offer', sdp: 'v=0...', epoch: 7 });

  const candidate = { candidate: 'candidate:1 1 udp 1 127.0.0.1 5000 typ host', sdpMid: '0' };
  assert.deepEqual(withEpoch(candidate, 7), { ...candidate, epoch: 7 });

  const serializable = { toJSON: () => ({ type: 'answer', sdp: 'v=0...' }) };
  assert.deepEqual(withEpoch(serializable, 3), { type: 'answer', sdp: 'v=0...', epoch: 3 });

  assert.equal(withEpoch(null, 1), null);
});

test('transport state uses an available relay immediately and re-probes with backoff', () => {
  const sm = new TransportStateMachine({ fallbackMs: 1000, baseBackoffMs: 500, maxBackoffMs: 2000 });
  sm.reset(0);
  assert.equal(sm.state, TRANSPORT_STATE.CONNECTING);

  // An inbound relay frame proves the fallback path works; do not wait for a
  // timeout that would leave the peer stuck in "reconnecting" with no audio.
  assert.equal(sm.noteRelayAvailable(100), 'use-relay');
  assert.equal(sm.state, TRANSPORT_STATE.RELAY);
  assert.equal(sm.canSendRelay, true);

  // Repeated relay frames must not reschedule the direct probe on every chunk.
  const nextAttemptAt = sm.nextAttemptAt;
  assert.equal(sm.noteRelayAvailable(200), null);
  assert.equal(sm.nextAttemptAt, nextAttemptAt);

  // First probe after 500 ms, then exponential backoff capped at 2000 ms.
  assert.equal(sm.tick(599), null);
  assert.equal(sm.tick(600), 'restart-ice');
  assert.equal(sm.state, TRANSPORT_STATE.CONNECTING);

  // With relay already available, a direct failure returns to relay.
  sm.noteDirectFailure(1600);
  assert.equal(sm.state, TRANSPORT_STATE.RELAY);
  assert.equal(sm.tick(2599), null);
  assert.equal(sm.tick(2600), 'restart-ice');

  // With no relay available, a direct failure schedules a reconnect instead.
  const sm2 = new TransportStateMachine({ baseBackoffMs: 500, maxBackoffMs: 2000 });
  sm2.reset(3000);
  sm2.noteDirectFailure(3000);
  assert.equal(sm2.state, TRANSPORT_STATE.RECONNECTING);
  assert.equal(sm2.tick(3499), null);
  assert.equal(sm2.tick(3500), 'restart-ice');
  assert.equal(sm2.manualReconnect(3600), 'restart-ice');
  assert.equal(sm2.state, TRANSPORT_STATE.RECONNECTING);
});

test('transport state restarts ICE when neither direct nor relay becomes available', () => {
  const sm = new TransportStateMachine({ fallbackMs: 1000, baseBackoffMs: 500 });
  sm.reset(0);
  assert.equal(sm.tick(999), null);
  assert.equal(sm.tick(1000), 'restart-ice');
  assert.equal(sm.state, TRANSPORT_STATE.RECONNECTING);
});

test('transport state does not downgrade a healthy direct connection', () => {
  const sm = new TransportStateMachine({ fallbackMs: 10 });
  sm.reset(0);
  sm.noteDirectConnected(5);
  assert.equal(sm.state, TRANSPORT_STATE.DIRECT);
  assert.equal(sm.canSendRelay, false);
  assert.equal(sm.noteRelayAvailable(5000), null);
  assert.equal(sm.state, TRANSPORT_STATE.DIRECT);
  assert.equal(sm.tick(99999), null);

  // A real direct failure moves to relay because relay was observed.
  sm.noteDirectFailure(10000);
  assert.equal(sm.state, TRANSPORT_STATE.RELAY);
  assert.equal(sm.canSendRelay, true);
});

// ---- Fake RTCPeerConnection for negotiation tests ----
class FakePc {
  constructor(state = 'stable') {
    this.signalingState = state;
    this.localDescription = null;
    this.remoteDescription = null;
    this.offers = 0;
    this.answers = 0;
    this.rollbacks = 0;
    this.log = [];
  }
  async createOffer() { this.offers++; return { type: 'offer', sdp: `offer-${this.offers}` }; }
  async createAnswer() { this.answers++; return { type: 'answer', sdp: `answer-${this.answers}` }; }
  async setLocalDescription(desc) {
    this.log.push(`setLocal:${desc.type}`);
    if (desc.type === 'rollback') {
      this.rollbacks++;
      this.signalingState = 'stable';
      return;
    }
    this.localDescription = desc;
    this.signalingState = desc.type === 'offer' ? 'have-local-offer' : 'stable';
  }
  async setRemoteDescription(desc) {
    this.log.push(`setRemote:${desc.type}`);
    this.remoteDescription = desc;
    this.signalingState = desc.type === 'offer' ? 'have-remote-offer' : 'stable';
  }
}

test('perfect negotiation creates an offer once and answers offers without offering', async () => {
  const sent = [];
  const polite = new PerfectNegotiator({ polite: true, send: (d) => sent.push(d) });
  const pc = new FakePc();

  assert.equal(await polite.onNegotiationNeeded(pc), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'offer');
  // A second negotiation while waiting for an answer is ignored.
  assert.equal(await polite.onNegotiationNeeded(pc), false);
  assert.equal(sent.length, 1);

  const answerer = new PerfectNegotiator({ polite: false, send: (d) => sent.push(d) });
  const answerPc = new FakePc();
  assert.equal(await answerer.onRemoteDescription(answerPc, { type: 'offer', sdp: 'remote' }), true);
  assert.equal(answerPc.offers, 0, 'answerer never creates an offer');
  assert.equal(sent.length, 2);
  assert.equal(sent[1].type, 'answer');
});

test('glare: impolite peer ignores colliding offer, polite peer rolls back and answers', async () => {
  const sent = [];
  const impolite = new PerfectNegotiator({ polite: false, send: (d) => sent.push(d) });
  const pcA = new FakePc('have-local-offer');
  pcA.offers = 1;
  assert.equal(await impolite.onRemoteDescription(pcA, { type: 'offer', sdp: 'collision' }), false);
  assert.equal(impolite.ignoreOffer, true);
  assert.equal(impolite.shouldAcceptCandidate(), false);
  assert.equal(pcA.remoteDescription, null);

  const polite = new PerfectNegotiator({ polite: true, send: (d) => sent.push(d) });
  const pcB = new FakePc('have-local-offer');
  pcB.localDescription = { type: 'offer', sdp: 'mine' };
  assert.equal(await polite.onRemoteDescription(pcB, { type: 'offer', sdp: 'theirs' }), true);
  assert.equal(pcB.rollbacks, 1);
  assert.equal(pcB.remoteDescription.sdp, 'theirs');
  assert.equal(sent.at(-1).type, 'answer');

  // Answer with no pending offer is ignored.
  const stale = new FakePc('stable');
  assert.equal(await polite.onRemoteDescription(stale, { type: 'answer', sdp: 'late' }), false);
});

test('a fresh negotiation clears a sticky ignoreOffer after a lost glare', async () => {
  const sent = [];
  const impolite = new PerfectNegotiator({ polite: false, send: (d) => sent.push(d) });
  const pc = new FakePc('have-local-offer');
  pc.localDescription = { type: 'offer', sdp: 'mine' };

  assert.equal(await impolite.onRemoteDescription(pc, { type: 'offer', sdp: 'collision' }), false);
  assert.equal(impolite.ignoreOffer, true);
  assert.equal(impolite.shouldAcceptCandidate(), false);

  // The colliding offer never produced an answer and its ICE never arrives.
  // A later, unrelated renegotiation must not keep suppressing all candidates.
  pc.signalingState = 'stable';
  pc.localDescription = null;
  assert.equal(await impolite.onNegotiationNeeded(pc), true);
  assert.equal(impolite.ignoreOffer, false);
  assert.equal(impolite.shouldAcceptCandidate(), true);
  assert.equal(sent.at(-1).type, 'offer');
});
