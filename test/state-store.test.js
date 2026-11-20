'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  normalizeState,
  CampaignStore,
  DEFAULT_COMMON_LANGUAGE
} = require('../state-store');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'feria-store-'));
}

function fakeFetch(kv) {
  const calls = [];
  const fetchImpl = async (_url, options) => {
    const command = JSON.parse(options.body);
    // Guard against regressing to the pipeline body format, which Upstash
    // rejects with HTTP 400.
    assert.ok(Array.isArray(command) && typeof command[0] === 'string');
    calls.push(command);
    const [name, key, value] = command;
    if (name === 'GET') {
      return { ok: true, json: async () => ({ result: kv[key] ?? null }) };
    }
    if (name === 'SET') {
      kv[key] = value;
      return { ok: true, json: async () => ({ result: 'OK' }) };
    }
    throw new Error(`Unexpected command ${name}`);
  };
  return { fetchImpl, calls };
}

test('normalizeState always provides a usable common language', () => {
  const state = normalizeState(null);
  assert.equal(state.dmPin, '1250');
  assert.deepEqual(state.languages, [DEFAULT_COMMON_LANGUAGE]);
  assert.deepEqual(state.characters, []);
  assert.deepEqual(state.messages, []);
});

test('normalizeState clamps, filters and sanitizes hostile input', () => {
  const state = normalizeState({
    dmPin: 'x'.repeat(500),
    languages: [
      { id: 'elvish', name: '  Ельфійська  ', color: 'red', icon: '<script>', scriptStyle: 'nope', dspPreset: { grainSizeMs: 99999 } },
      { id: 'elvish', name: 'Дублюват' },
      { id: '../../bad', name: 'Bad id' }
    ],
    characters: [
      { id: 'liora', name: 'Ліора', avatarColor: '#zzzzzz', languages: ['elvish', 'missing'], forcedLanguage: 'ghost' },
      { id: 'liora', name: 'Дублюват' }
    ],
    messages: [
      {
        id: 'msg-1',
        text: 'a'.repeat(9000),
        languageId: 'ghost',
        revealMap: { ALL: 25, liora: 50, __proto__: 100, constructor: 100, bogus: 75 },
        timestamp: 'bad',
        senderIcon: '👁️'
      }
    ]
  });

  assert.equal(state.dmPin.length, 64);
  assert.equal(state.languages.length, 2);
  assert.equal(state.languages[0].id, 'common');
  assert.equal(state.languages[1].id, 'elvish');
  assert.equal(state.languages[1].color, '#c084fc');
  assert.equal(state.languages[1].icon, '❧');
  assert.equal(state.languages[1].scriptStyle, 'ancient');
  assert.equal(state.languages[1].dspPreset.grainSizeMs, 260);

  assert.equal(state.characters.length, 1);
  assert.deepEqual(state.characters[0].languages, ['common', 'elvish']);
  assert.equal(state.characters[0].forcedLanguage, null);
  assert.equal(state.characters[0].avatarColor, '#6366f1');

  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0].text.length, 4000);
  assert.equal(state.messages[0].languageId, 'common');
  assert.deepEqual(Object.keys(state.messages[0].revealMap).sort(), ['ALL', 'liora']);
  assert.equal(Object.getPrototypeOf(state.messages[0].revealMap), null);
  assert.ok(Number.isFinite(state.messages[0].timestamp));
});

test('CampaignStore reads from Upstash, writes back, and restores after a restart', async () => {
  const dir = tempDir();
  const dataPath = path.join(dir, 'campaign-state.json');
  const kv = {};
  const one = fakeFetch(kv);
  const store = new CampaignStore({
    dataPath,
    seedPath: path.join(__dirname, '..', 'data', 'campaign-state.json'),
    url: 'https://example.upstash.io',
    token: 'token',
    fetchImpl: one.fetchImpl,
    debounceMs: 0,
    logger: { warn() {}, error() {} }
  });

  const loaded = await store.load();
  assert.equal(loaded.languages[0].id, 'common');
  assert.equal(one.calls[0][0], 'GET');

  loaded.messages.push({
    id: 'msg-42',
    text: 'Привіт',
    languageId: 'common',
    timestamp: 1,
    seed: 1,
    revealMap: {}
  });
  store.scheduleSave(() => loaded);
  await store.flush();
  assert.equal(one.calls.at(-1)[0], 'SET');
  assert.ok(kv['feria:campaign-state'].includes('msg-42'));
  assert.equal(store.status().degraded, false);

  const two = fakeFetch(kv);
  const restarted = new CampaignStore({
    dataPath: path.join(tempDir(), 'campaign-state.json'),
    url: 'https://example.upstash.io',
    token: 'token',
    fetchImpl: two.fetchImpl,
    debounceMs: 0,
    logger: { warn() {}, error() {} }
  });
  const restored = await restarted.load();
  assert.equal(restored.messages[0].id, 'msg-42');
});

test('CampaignStore coalesces rapid saves into one KV write', async () => {
  const kv = {};
  const { fetchImpl, calls } = fakeFetch(kv);
  const store = new CampaignStore({
    dataPath: path.join(tempDir(), 'campaign-state.json'),
    url: 'https://example.upstash.io',
    token: 'token',
    fetchImpl,
    debounceMs: 2000,
    logger: { warn() {}, error() {} }
  });
  const state = normalizeState(null);
  store.scheduleSave(() => state);
  store.scheduleSave(() => state);
  store.scheduleSave(() => state);
  await store.close();
  assert.equal(calls.filter((c) => c[0] === 'SET').length, 1);
});

test('CampaignStore falls back to the local seed when KV is unavailable', async () => {
  const store = new CampaignStore({
    dataPath: path.join(tempDir(), 'runtime.json'),
    seedPath: path.join(__dirname, '..', 'data', 'campaign-state.json'),
    url: 'https://example.upstash.io',
    token: 'token',
    fetchImpl: async () => { throw new Error('offline'); },
    debounceMs: 0,
    logger: { warn() {}, error() {} }
  });
  const state = await store.load();
  assert.ok(state.languages.length > 5);
  assert.equal(store.status().degraded, true);
  assert.match(store.status().lastSaveError, /KV read failed/);
});

test('CampaignStore quarantines a corrupt local state file', () => {
  const dir = tempDir();
  const dataPath = path.join(dir, 'campaign-state.json');
  fs.writeFileSync(dataPath, '{not json', 'utf8');
  const store = new CampaignStore({
    dataPath,
    seedPath: path.join(__dirname, '..', 'data', 'campaign-state.json'),
    logger: { warn() {}, error() {} }
  });
  const state = store.readLocalFile();
  assert.equal(state, null);
  assert.equal(fs.existsSync(dataPath), false);
  assert.equal(fs.readdirSync(dir).some((name) => name.includes('.corrupt-')), true);
});
