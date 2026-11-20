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

test('RateLimiter enforces capacity', () => {
  const limiter = new RateLimiter({ capacity: 2, refillPerSec: 0 });
  assert.equal(limiter.consume('client'), true);
  assert.equal(limiter.consume('client'), true);
  assert.equal(limiter.consume('client'), false);
  assert.equal(limiter.consume('other'), true);
});

test('RateLimiter refills over time', async () => {
  const limiter = new RateLimiter({ capacity: 1, refillPerSec: 1000 });
  assert.equal(limiter.consume('client'), true);
  assert.equal(limiter.consume('client'), false);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(limiter.consume('client'), true);
});
