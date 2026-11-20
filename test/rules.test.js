'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { translateToRunes, canUnderstand, canSpeak } = require('../server');

const WORDS = 'альфа бета gamma дельта епсилон дзета ета theta'.split(' ');

function revealedPositions(original, translated) {
  const source = original.split(' ');
  const result = translated.split(' ');
  return source.map((word, index) => (result[index] === word ? index : -1)).filter((i) => i >= 0);
}

test('translateToRunes is deterministic and preserves layout', () => {
  const text = 'Привіт, світ! 123';
  const once = translateToRunes(text, 'runic', 0, 42);
  assert.equal(translateToRunes(text, 'runic', 0, 42), once);
  assert.notEqual(translateToRunes(text, 'runic', 0, 43), once);
  assert.equal(once.length, text.length);
  assert.equal(once[6], ',');
  assert.equal(once[7], ' ');
  assert.equal(once.slice(-3).length, 3);
  assert.doesNotMatch(once.slice(-3), /[0-9]/);
  assert.equal(translateToRunes('', 'runic', 0, 1), '');
});

test('translateToRunes reveals the exact percentage and stays stable across reveals', () => {
  const text = WORDS.join(' ');
  assert.equal(translateToRunes(text, 'runic', 100, 7), text);
  const none = revealedPositions(text, translateToRunes(text, 'runic', 0, 7));
  const quarter = revealedPositions(text, translateToRunes(text, 'runic', 25, 7));
  const half = revealedPositions(text, translateToRunes(text, 'runic', 50, 7));

  assert.equal(none.length, 0);
  assert.equal(quarter.length, 2);
  assert.equal(half.length, 4);
  for (const position of quarter) {
    assert.ok(half.includes(position), `word ${position} revealed at 25% must stay revealed at 50%`);
  }
});

test('language permissions respect common, DM role, spells and known languages', () => {
  const character = { languages: ['common', 'elvish'], comprehendLanguages: false, tongues: false };

  assert.equal(canUnderstand('player', character, 'common'), true);
  assert.equal(canSpeak('player', character, 'common'), true);
  assert.equal(canUnderstand('player', character, 'elvish'), true);
  assert.equal(canSpeak('player', character, 'elvish'), true);
  assert.equal(canUnderstand('player', character, 'infernal'), false);
  assert.equal(canSpeak('player', character, 'infernal'), false);
  assert.equal(canUnderstand('player', null, 'elvish'), false);

  assert.equal(canUnderstand('dm', null, 'infernal'), true);
  assert.equal(canSpeak('dm', null, 'infernal'), true);

  const comprehending = { ...character, comprehendLanguages: true };
  assert.equal(canUnderstand('player', comprehending, 'infernal'), true);
  assert.equal(canSpeak('player', comprehending, 'infernal'), false);

  const tongues = { ...character, tongues: true };
  assert.equal(canUnderstand('player', tongues, 'infernal'), true);
  assert.equal(canSpeak('player', tongues, 'infernal'), true);
});
