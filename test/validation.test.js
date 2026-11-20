'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateWsMessage, RateLimiter } = require('../validation');

test('validateWsMessage accepts well-formed messages', () => {
  assert.equal(validateWsMessage({ type: 'JOIN', role: 'dm', pin: '1250' }), null);
  assert.equal(validateWsMessage({ type: 'JOIN', role: 'player', characterId: 'liora' }), null);
  assert.equal(validateWsMessage({ type: 'JOIN', role: 'player', characterId: 'liora', relayProtocol: 2 }), null);
  assert.equal(validateWsMessage({ type: 'CHAT_MESSAGE', text: 'Привіт', languageId: 'elvish' }), null);
  // The browser client used to send title: '' for every ordinary message.
  assert.equal(validateWsMessage({ type: 'CHAT_MESSAGE', text: 'Привіт', title: '' }), null);
  assert.equal(validateWsMessage({ type: 'CHAT_MESSAGE', text: 'Привіт', title: 'Свиток' }), null);
  assert.equal(validateWsMessage({
    type: 'AUDIO_RELAY_CHUNK',
    pcmBase64: 'AAAA',
    targetClientIds: ['abc-123'],
    sampleRate: 24000
  }), null);
  assert.equal(validateWsMessage({ type: 'REVEAL_MESSAGE', messageId: 'm-1', characterId: 'ALL', percent: 50 }), null);
});

test('validateWsMessage rejects malformed and oversized payloads', () => {
  assert.match(validateWsMessage(null), /object/);
  assert.match(validateWsMessage({ type: 'NOPE' }), /Unknown/);
  assert.match(validateWsMessage({ type: 'CHAT_MESSAGE', text: 'x'.repeat(4001) }), /text/);
  assert.match(validateWsMessage({ type: 'CHAT_MESSAGE', text: '' }), /text/);
  assert.match(validateWsMessage({ type: 'CHAT_MESSAGE', text: 'x', title: 'т'.repeat(201) }), /title/);
  assert.match(validateWsMessage({ type: 'JOIN', role: 'dm' }), /PIN/);
  assert.match(validateWsMessage({ type: 'JOIN', role: 'player', characterId: 'liora', relayProtocol: 3 }), /relayProtocol/);
  assert.match(validateWsMessage({
    type: 'AUDIO_RELAY_CHUNK', pcmBase64: 'AAAA', targetClientIds: [], sampleRate: 24000
  }), /relay targets/);
  assert.match(validateWsMessage({ type: 'REVEAL_MESSAGE', messageId: 'm-1', characterId: 'ALL', percent: 33 }), /percent/);
  assert.match(validateWsMessage({
    type: 'AUDIO_RELAY_CHUNK', pcmBase64: 'AAAA', targetClientIds: ['abc'], sampleRate: 999999
  }), /sampleRate/);
  assert.match(validateWsMessage({
    type: 'AUDIO_RELAY_CHUNK', pcmBase64: 'not*base64', targetClientIds: ['abc'], sampleRate: 24000
  }), /audio chunk/);
  assert.match(validateWsMessage({ type: 'WEBRTC_ICE', targetClientId: '../bad', payload: {} }), /targetClientId/);
  assert.match(validateWsMessage({
    type: 'DM_CREATE_LANGUAGE', language: { name: 'x'.repeat(200), icon: '<script>' }
  }), /language/);
});

test('scriptStyle prototype keys and non-ASCII relay ids are rejected', () => {
  for (const key of ['__proto__', 'constructor', 'toString']) {
    assert.match(validateWsMessage({
      type: 'DM_CREATE_LANGUAGE', language: { name: 'X', scriptStyle: key }
    }), /scriptStyle/);
  }
  assert.equal(validateWsMessage({
    type: 'DM_CREATE_LANGUAGE', language: { name: 'X', scriptStyle: 'runic' }
  }), null);
  assert.equal(validateWsMessage({
    type: 'AUDIO_RELAY_CHUNK', pcmBase64: 'AAAA',
    targetClientIds: ['abc-123'], sampleRate: 24000
  }), null);
  assert.match(validateWsMessage({
    type: 'AUDIO_RELAY_CHUNK', pcmBase64: 'AAAA',
    targetClientIds: ['абв'], sampleRate: 24000
  }), /relay targets/, 'binary relay frames cannot carry non-ASCII ids');
});

test('RateLimiter enforces capacity', () => {
  const limiter = new RateLimiter({ capacity: 2, refillPerSec: 0 });
  assert.equal(limiter.consume('client'), true);
  assert.equal(limiter.consume('client'), true);
  assert.equal(limiter.consume('client'), false);
  assert.equal(limiter.consume('other'), true);
});

test('RateLimiter refills over time', () => {
  let now = 1000;
  const limiter = new RateLimiter({ capacity: 1, refillPerSec: 100, now: () => now });
  assert.equal(limiter.consume('client'), true);
  assert.equal(limiter.consume('client'), false);
  now += 20; // 2 tokens' worth of refill, capped at capacity
  assert.equal(limiter.consume('client'), true);
});
