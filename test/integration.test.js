'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const WebSocket = require('ws');
const { encodeRelayFrame, decodeRelayFrame } = require('../public/js/audio-protocol');

const ROOT = path.join(__dirname, '..');
const SEED = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'campaign-state.json'), 'utf8'));
const PIN = '9988';

async function freePort() {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  probe.close();
  return port;
}

async function startFakeKv() {
  const kv = new Map();
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const command = JSON.parse(body);
        const [name, key, value] = command;
        res.setHeader('content-type', 'application/json');
        if (name === 'GET') {
          res.end(JSON.stringify({ result: kv.has(key) ? kv.get(key) : null }));
        } else if (name === 'SET') {
          kv.set(key, value);
          res.end(JSON.stringify({ result: 'OK' }));
        } else {
          res.statusCode = 400;
          res.end(JSON.stringify([{ error: 'unsupported' }]));
        }
      } catch {
        res.statusCode = 400;
        res.end('{}');
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    keys: kv,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

async function startServer(env) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server start timeout:\n${output}`)), 15000);
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited early (${code}):\n${output}`));
    });
  });
  return child;
}

async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await exited;
}

async function connectClient(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const received = [];
  ws.on('message', (raw) => {
    try { received.push(JSON.parse(raw.toString())); } catch {}
  });
  await once(ws, 'open');
  return {
    ws,
    received,
    send(payload) { ws.send(JSON.stringify(payload)); },
    async waitFor(type, timeout = 4000) {
      const started = Date.now();
      while (Date.now() - started < timeout) {
        const idx = received.findIndex((m) => m.type === type);
        if (idx >= 0) return received.splice(idx, 1)[0];
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`Timeout waiting for ${type}; got: ${received.map((m) => m.type).join(', ') || 'nothing'}`);
    },
    count(type) { return received.filter((m) => m.type === type).length; },
    clear() { received.length = 0; }
  };
}

async function waitUntil(predicate, timeout = 4000, label = 'condition') {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timeout waiting for ${label}`);
}

async function waitForFlush(port, after = null) {
  for (let i = 0; i < 100; i++) {
    const health = await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.json());
    // lastSaveAt from an earlier write is not enough: the debounce timer may
    // not have fired for the mutation we are waiting on yet.
    if (health.pendingSaves === 0 && health.lastSaveAt && health.lastSaveAt !== after) return health;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('State was never flushed');
}

test('Render-style server: projection, whispers, validation and restart persistence', { timeout: 90000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feria-integration-'));
  const kv = await startFakeKv();
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = {
    PORT: String(port),
    HOST: '127.0.0.1',
    STATE_DIR: dir,
    STATE_KEY: `feria:test:${Date.now()}`,
    UPSTASH_REDIS_REST_URL: kv.url,
    UPSTASH_REDIS_REST_TOKEN: 'test-token',
    FERIA_DM_PIN: PIN
  };

  let server = await startServer(env);
  t.after(async () => {
    await stopServer(server);
    await kv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const health = await fetch(`${baseUrl}/api/health`).then((r) => r.json());
  assert.equal(health.status, 'ok');
  assert.equal(health.storageMode, 'upstash');

  const dm = await connectClient(port);
  const liora = await connectClient(port);
  const amenemhet = await connectClient(port);

  dm.send({ type: 'JOIN', role: 'dm', pin: PIN });
  liora.send({ type: 'JOIN', role: 'player', characterId: 'liora' });
  amenemhet.send({ type: 'JOIN', role: 'player', characterId: 'amenemhet' });
  const dmJoin = await dm.waitFor('JOIN_SUCCESS');
  const lioraJoin = await liora.waitFor('JOIN_SUCCESS');
  await amenemhet.waitFor('JOIN_SUCCESS');

  // 1. Language secrecy: Liora does not know Infernal.
  dm.clear();
  liora.clear();
  amenemhet.clear();
  dm.send({ type: 'CHAT_MESSAGE', text: 'Секретна фраза для перевірки', languageId: 'infernal' });
  const dmMessage = (await dm.waitFor('CHAT_MESSAGE_NEW')).message;
  const lioraMessage = (await liora.waitFor('CHAT_MESSAGE_NEW')).message;
  const amenemhetKnowsInfernal = SEED.characters.find((c) => c.id === 'amenemhet').languages.includes('infernal');
  assert.equal(dmMessage.text, 'Секретна фраза для перевірки');
  assert.equal(dmMessage.languageId, 'infernal');
  assert.notEqual(lioraMessage.text, dmMessage.text);
  assert.equal(lioraMessage.languageName, 'Невідома мова');
  assert.equal(lioraMessage.languageId, 'unknown');
  if (amenemhetKnowsInfernal) {
    const amenMessage = (await amenemhet.waitFor('CHAT_MESSAGE_NEW')).message;
    assert.equal(amenMessage.text, dmMessage.text);
  }

  // 2. Whisper isolation and cleanup when the target disappears.
  dm.clear();
  liora.clear();
  amenemhet.clear();
  dm.send({ type: 'SET_WHISPER_TARGET', targetClientId: lioraJoin.clientId, targetCharacterId: null });
  await dm.waitFor('SELF_WHISPER_UPDATED');
  dm.send({ type: 'CHAT_MESSAGE', text: 'Приватний шепіт', languageId: 'common' });
  const whisper = (await liora.waitFor('CHAT_MESSAGE_NEW')).message;
  assert.equal(whisper.isWhisper, true);
  assert.equal(amenemhet.count('CHAT_MESSAGE_NEW'), 0);

  liora.ws.terminate();
  const cleared = await dm.waitFor('SELF_WHISPER_UPDATED');
  assert.equal(cleared.targetClientId, null);
  assert.equal(cleared.targetCharacterId, null);

  // 3. Invalid and oversized frames are rejected without killing the server.
  const rejectedBefore = (await fetch(`${baseUrl}/api/health`).then((r) => r.json())).rejectedMessages;
  amenemhet.send({ type: 'CHAT_MESSAGE', text: 'x'.repeat(5000) });
  amenemhet.ws.send('y'.repeat(70000));
  await once(amenemhet.ws, 'close');
  const healthAfterAbuse = await fetch(`${baseUrl}/api/health`).then((r) => r.json());
  assert.equal(healthAfterAbuse.status, 'ok');
  assert.ok(healthAfterAbuse.rejectedMessages > rejectedBefore);

  // 4. PIN no longer travels in URLs: export is POST-only and body-authenticated.
  assert.equal((await fetch(`${baseUrl}/api/export-state?pin=${PIN}`)).status, 404);
  const exportBad = await fetch(`${baseUrl}/api/export-state`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pin: 'wrong' })
  });
  assert.equal(exportBad.status, 403);
  const exportOk = await fetch(`${baseUrl}/api/export-state`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pin: PIN })
  });
  assert.equal(exportOk.status, 200);
  const exported = await exportOk.json();
  assert.ok(Array.isArray(exported.languages));
  assert.equal(exported.dmPin, undefined); // PIN must never be part of an export
  assert.equal(exported.exportedAt > 0, true);

  // 5. Repeated bad DM PINs are throttled per IP.
  const pinProbe = await connectClient(port);
  for (let i = 0; i < 5; i++) {
    pinProbe.send({ type: 'JOIN', role: 'dm', pin: 'wrong' });
    await pinProbe.waitFor('JOIN_ERROR');
  }
  pinProbe.clear();
  pinProbe.send({ type: 'JOIN', role: 'dm', pin: PIN });
  const throttled = await pinProbe.waitFor('JOIN_ERROR');
  assert.match(throttled.error, /Забагато спроб/);
  pinProbe.ws.close();

  // 6. State survives a full process restart via Upstash.
  dm.clear();
  const beforeSave = await fetch(`http://127.0.0.1:${port}/api/health`)
    .then((r) => r.json())
    .then((h) => h.lastSaveAt);
  dm.send({ type: 'CHAT_MESSAGE', text: 'ПЕРЕВІРКА-ЗБЕРЕЖЕННЯ', languageId: 'common' });
  await dm.waitFor('CHAT_MESSAGE_NEW');
  await waitForFlush(port, beforeSave);
  assert.ok(kv.keys.has(env.STATE_KEY));

  await stopServer(server);
  server = await startServer(env);
  const reconnected = await connectClient(port);
  reconnected.send({ type: 'JOIN', role: 'player', characterId: 'adrian' });
  const rejoined = await reconnected.waitFor('JOIN_SUCCESS');
  assert.ok(rejoined.messages.some((m) => m.text === 'ПЕРЕВІРКА-ЗБЕРЕЖЕННЯ'));

  dm.ws.close();
  reconnected.ws.close();
});

test('Binary PCM relay routes by target, rewrites spoofed senders and keeps legacy clients working',
  { timeout: 60000 }, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feria-relay-'));
    const port = await freePort();
    const server = await startServer({
      PORT: String(port),
      HOST: '127.0.0.1',
      STATE_DIR: dir,
      FERIA_DM_PIN: PIN
    });
    t.after(async () => {
      await stopServer(server);
      fs.rmSync(dir, { recursive: true, force: true });
    });

    const alice = await connectClient(port);
    const bob = await connectClient(port);
    const carol = await connectClient(port);
    alice.send({ type: 'JOIN', role: 'player', characterId: 'liora', relayProtocol: 2 });
    bob.send({ type: 'JOIN', role: 'player', characterId: 'adrian', relayProtocol: 2 });
    carol.send({ type: 'JOIN', role: 'player', characterId: 'amenemhet', relayProtocol: 1 });
    const a = await alice.waitFor('JOIN_SUCCESS');
    const b = await bob.waitFor('JOIN_SUCCESS');
    const c = await carol.waitFor('JOIN_SUCCESS');

    const bobBinary = [];
    const carolBinary = [];
    const carolJson = [];
    bob.ws.on('message', (raw, isBinary) => { if (isBinary) bobBinary.push(Buffer.from(raw)); });
    carol.ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        carolBinary.push(Buffer.from(raw));
        return;
      }
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'AUDIO_RELAY_CHUNK') carolJson.push(msg);
      } catch {}
    });

    const pcm = new Int16Array(480).fill(1234);
    const targets = [b.clientId, c.clientId];
    alice.ws.send(encodeRelayFrame({
      senderId: a.clientId,
      targetIds: targets,
      sampleRate: 24000,
      sequence: 7,
      pcm
    }));

    await waitUntil(() => bobBinary.length === 1, 4000, 'bob binary frame');
    await waitUntil(() => carolJson.length === 1, 4000, 'carol legacy JSON frame');
    assert.equal(carolBinary.length, 0);

    const decoded = decodeRelayFrame(bobBinary[0]);
    assert.equal(decoded.senderId, a.clientId);
    assert.deepEqual(decoded.targetIds, targets);
    assert.equal(decoded.sequence, 7);
    assert.deepEqual(Array.from(decoded.pcm), Array.from(pcm));
    assert.equal(carolJson[0].fromClientId, a.clientId);
    assert.equal(carolJson[0].sampleRate, 24000);
    assert.equal(Buffer.from(carolJson[0].pcmBase64, 'base64').length, pcm.byteLength);

    // A spoofed sender field is replaced with the authenticated socket identity.
    bobBinary.length = 0;
    alice.ws.send(encodeRelayFrame({
      senderId: 'spoofed-id',
      targetIds: [b.clientId],
      sampleRate: 24000,
      sequence: 8,
      pcm
    }));
    await waitUntil(() => bobBinary.length === 1, 4000, 'rewritten frame');
    assert.equal(decodeRelayFrame(bobBinary[0]).senderId, a.clientId);

    // Whisper isolation also applies to the audio relay path.
    alice.send({ type: 'SET_WHISPER_TARGET', targetClientId: b.clientId, targetCharacterId: null });
    await alice.waitFor('SELF_WHISPER_UPDATED');
    bobBinary.length = 0;
    carolJson.length = 0;
    alice.ws.send(encodeRelayFrame({
      senderId: a.clientId,
      targetIds: [b.clientId, c.clientId],
      sampleRate: 24000,
      sequence: 9,
      pcm
    }));
    await waitUntil(() => bobBinary.length === 1, 4000, 'whisper relay to bob');
    assert.equal(carolJson.length, 0);

    // Malformed binary frames are counted, not fatal.
    const before = (await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.json())).rejectedMessages;
    alice.ws.send(Buffer.from([1, 0, 0, 0, 0, 0, 1, 120]));
    await new Promise((resolve) => setTimeout(resolve, 80));
    const after = await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.json());
    assert.ok(after.rejectedMessages > before);
    assert.equal(after.status, 'ok');

    alice.ws.close();
    bob.ws.close();
    carol.ws.close();
  });

