'use strict';

// Regression tests for the P0 deployment blockers: health semantics, WS origin
// checks, whisper isolation on the signaling path, immediate-SIGTERM persistence,
// reconnect-resistant rate limits and stale-instance KV protection.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const PIN = '7711';

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
        if (name === 'GET') res.end(JSON.stringify({ result: kv.has(key) ? kv.get(key) : null }));
        else if (name === 'SET') {
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

async function startServer(env, ipc = false) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe']
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

async function startExpectedFailure(env) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const [code] = await once(child, 'exit');
  return { code, output };
}

async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await exited;
}

async function gracefulStop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.send('graceful-shutdown');
  await exited;
}

async function connectClient(port, options) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, options);
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

async function waitUntil(predicate, timeout = 5000, label = 'condition') {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timeout waiting for ${label}`);
}

function localEnv(port, dir, extra = {}) {
  return {
    NODE_ENV: 'test',
    PORT: String(port),
    HOST: '127.0.0.1',
    STATE_DIR: dir,
    FERIA_DM_PIN: PIN,
    ...extra
  };
}

test('lobby never advertises the seed PIN when an operator PIN is configured', { timeout: 30000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feria-pin-hint-'));
  const port = await freePort();
  const server = await startServer(localEnv(port, dir));
  t.after(async () => {
    await stopServer(server);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const res = await fetch(`http://127.0.0.1:${port}/api/lobby`);
  const lobby = await res.json();
  assert.equal(lobby.defaultPin, null, 'the browser must not receive a usable PIN');
  assert.ok(!JSON.stringify(lobby).includes(PIN), 'the operator PIN is not leaked either');
});

test('lobby exposes the seed PIN only for a local passwordless server', { timeout: 30000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feria-pin-hint-local-'));
  const port = await freePort();
  const server = await startServer(localEnv(port, dir, { FERIA_DM_PIN: '' }));
  t.after(async () => {
    await stopServer(server);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const res = await fetch(`http://127.0.0.1:${port}/api/lobby`);
  const lobby = await res.json();
  assert.equal(lobby.defaultPin, '1250');
});

test('rtc config advertises TURN so players can escape symmetric NATs', { timeout: 30000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feria-rtc-'));
  const port = await freePort();
  const server = await startServer(localEnv(port, dir, {
    TURN_URL: '', TURN_URLS: '', TURN_USERNAME: '', TURN_CREDENTIAL: ''
  }));
  t.after(async () => {
    await stopServer(server);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const res = await fetch(`http://127.0.0.1:${port}/api/rtc-config`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const config = await res.json();
  const turn = config.iceServers.find((entry) => String(entry.urls).includes('turn:'));
  assert.ok(turn, 'a TURN server is advertised by default');
  assert.ok(turn.username && turn.credential);
  assert.ok(config.iceServers.some((entry) => String(entry.urls).includes('stun:')));
});

test('rtc config uses operator-provided TURN credentials', { timeout: 30000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feria-rtc-override-'));
  const port = await freePort();
  const server = await startServer(localEnv(port, dir, {
    TURN_URL: 'turn:turn.example.com:3478?transport=tcp',
    TURN_USERNAME: 'operator-user',
    TURN_CREDENTIAL: 'operator-secret'
  }));
  t.after(async () => {
    await stopServer(server);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const res = await fetch(`http://127.0.0.1:${port}/api/rtc-config`);
  const config = await res.json();
  const turn = config.iceServers.find((entry) => String(entry.urls).includes('turn.example.com'));
  assert.ok(turn, 'default public TURN is replaced');
  assert.equal(turn.username, 'operator-user');
  assert.equal(turn.credential, 'operator-secret');
  assert.ok(!String(turn.urls).includes('openrelay.metered.ca'));
});

test('a custom TURN without credentials is advertised without empty auth fields', { timeout: 30000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feria-rtc-noauth-'));
  const port = await freePort();
  const server = await startServer(localEnv(port, dir, {
    TURN_URL: 'turn:turn.example.com:3478?transport=tcp',
    TURN_USERNAME: '', TURN_CREDENTIAL: ''
  }));
  t.after(async () => {
    await stopServer(server);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const config = await fetch(`http://127.0.0.1:${port}/api/rtc-config`).then((r) => r.json());
  const turn = config.iceServers.find((entry) => String(entry.urls).includes('turn.example.com'));
  assert.ok(turn);
  assert.equal(turn.username, undefined);
  assert.equal(turn.credential, undefined);
});

test('default TURN uses short-lived static-auth credentials', { timeout: 30000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feria-rtc-staticauth-'));
  const port = await freePort();
  const server = await startServer(localEnv(port, dir, {
    TURN_URL: '', TURN_URLS: '', TURN_USERNAME: '', TURN_CREDENTIAL: '',
    TURN_SHARED_SECRET: 'unit-test-secret'
  }));
  t.after(async () => {
    await stopServer(server);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const config = await fetch(`http://127.0.0.1:${port}/api/rtc-config`).then((r) => r.json());
  const turn = config.iceServers.find((entry) => String(entry.urls).includes('turn:'));
  assert.ok(turn);
  assert.match(String(turn.urls), /staticauth\.openrelay\.metered\.ca/);
  assert.doesNotMatch(String(turn.urls), /turn:openrelay\.metered\.ca/);
  assert.match(turn.username, /^\d{10}:feria$/);
  const expiry = Number(turn.username.split(':')[0]);
  assert.ok(expiry > Date.now() / 1000 && expiry <= Date.now() / 1000 + 6 * 60 * 60 + 5);
  assert.equal(
    turn.credential,
    crypto.createHmac('sha1', 'unit-test-secret').update(turn.username).digest('base64')
  );
});

test('every API response forbids caching', { timeout: 30000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feria-api-cache-'));
  const port = await freePort();
  const server = await startServer(localEnv(port, dir));
  t.after(async () => {
    await stopServer(server);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const requests = [
    fetch(`http://127.0.0.1:${port}/api/health`),
    fetch(`http://127.0.0.1:${port}/api/lobby`),
    fetch(`http://127.0.0.1:${port}/api/rtc-config`),
    fetch(`http://127.0.0.1:${port}/api/export-state`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: 'wrong' })
    })
  ];
  for (const response of await Promise.all(requests)) {
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
});

test('production refuses to start without an operator PIN', { timeout: 30000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feria-no-pin-'));
  const port = await freePort();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const { code, output } = await startExpectedFailure(localEnv(port, dir, {
    NODE_ENV: 'production',
    FERIA_DM_PIN: '',
    UPSTASH_REDIS_REST_URL: '',
    UPSTASH_REDIS_REST_TOKEN: ''
  }));
  assert.equal(code, 1);
  assert.match(output, /FERIA_DM_PIN must be set in production/);
  assert.doesNotMatch(output, /listening/, 'a misconfigured server must never accept players');
});

test('failed JOINs release their connection slot after the watchdog', { timeout: 30000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feria-join-watchdog-'));
  const port = await freePort();
  const server = await startServer(localEnv(port, dir, { FERIA_JOIN_TIMEOUT_MS: '250' }));
  t.after(async () => {
    await stopServer(server);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const stuck = new WebSocket(`ws://127.0.0.1:${port}`);
  await once(stuck, 'open');
  stuck.send(JSON.stringify({ type: 'JOIN', role: 'dm', pin: 'definitely-wrong' }));
  await once(stuck, 'close');

  const health = await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.json());
  assert.equal(health.clients, 0, 'unjoined sockets are removed from the registry');
});

test('health returns 503 when Upstash cannot be reached', { timeout: 30000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feria-health-'));
  const port = await freePort();
  const server = await startServer(localEnv(port, dir, {
    UPSTASH_REDIS_REST_URL: 'http://127.0.0.1:9',
    UPSTASH_REDIS_REST_TOKEN: 'bad-token',
    STATE_KEY: 'feria:health:test'
  }));
  t.after(async () => {
    await stopServer(server);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const res = await fetch(`http://127.0.0.1:${port}/api/health`);
  const body = await res.json();
  assert.equal(res.status, 503);
  assert.equal(body.status, 'degraded');
  assert.equal(body.degraded, true);
});

test('WebSocket rejects cross-origin browsers but accepts same-origin', { timeout: 30000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feria-origin-'));
  const port = await freePort();
  const server = await startServer(localEnv(port, dir));
  t.after(async () => {
    await stopServer(server);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const evil = new WebSocket(`ws://127.0.0.1:${port}`, { origin: 'https://evil.example' });
  let evilOpened = false;
  evil.on('open', () => { evilOpened = true; });
  await new Promise((resolve) => {
    evil.on('error', resolve);
    evil.on('close', resolve);
    setTimeout(resolve, 3000);
  });
  assert.equal(evilOpened, false, 'cross-origin upgrade must be refused');

  const good = await connectClient(port, { origin: `http://127.0.0.1:${port}` });
  good.ws.close();
});

test('WebRTC signaling honors whisper policy and lets the DM listen', { timeout: 30000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feria-whisper-signal-'));
  const port = await freePort();
  const server = await startServer(localEnv(port, dir));
  t.after(async () => {
    await stopServer(server);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const dm = await connectClient(port);
  const liora = await connectClient(port);
  const amenemhet = await connectClient(port);
  dm.send({ type: 'JOIN', role: 'dm', pin: PIN });
  liora.send({ type: 'JOIN', role: 'player', characterId: 'liora' });
  amenemhet.send({ type: 'JOIN', role: 'player', characterId: 'amenemhet' });
  const dmJoin = await dm.waitFor('JOIN_SUCCESS');
  const lioraJoin = await liora.waitFor('JOIN_SUCCESS');
  const amenJoin = await amenemhet.waitFor('JOIN_SUCCESS');

  dm.send({ type: 'SET_WHISPER_TARGET', targetClientId: lioraJoin.clientId, targetCharacterId: null });
  await dm.waitFor('SELF_WHISPER_UPDATED');
  dm.clear();
  liora.clear();
  amenemhet.clear();

  dm.send({ type: 'WEBRTC_OFFER', targetClientId: amenJoin.clientId, payload: { type: 'offer', sdp: 'v=0-blocked' } });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(amenemhet.count('WEBRTC_OFFER'), 0, 'non-target must not receive whisper signaling');

  dm.send({ type: 'WEBRTC_OFFER', targetClientId: lioraJoin.clientId, payload: { type: 'offer', sdp: 'v=0-allowed' } });
  const allowed = await liora.waitFor('WEBRTC_OFFER', 2000);
  assert.equal(allowed.payload.sdp, 'v=0-allowed');

  // The DM sees every whisper in chat, so it must also be allowed to hear it.
  liora.send({ type: 'WEBRTC_OFFER', targetClientId: dmJoin.clientId, payload: { type: 'offer', sdp: 'v=0-to-dm' } });
  const toDm = await dm.waitFor('WEBRTC_OFFER', 2000);
  assert.equal(toDm.payload.sdp, 'v=0-to-dm');

  dm.ws.close();
  liora.ws.close();
  amenemhet.ws.close();
});

test('a later player with the sender character cannot read old whispers', { timeout: 30000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feria-whisper-history-'));
  const port = await freePort();
  const server = await startServer(localEnv(port, dir));
  t.after(async () => {
    await stopServer(server);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const first = await connectClient(port);
  first.send({ type: 'JOIN', role: 'player', characterId: 'liora' });
  const joined = await first.waitFor('JOIN_SUCCESS');
  first.send({
    type: 'SET_WHISPER_TARGET', targetClientId: null, targetCharacterId: 'amenemhet'
  });
  await first.waitFor('SELF_WHISPER_UPDATED');
  first.send({ type: 'CHAT_MESSAGE', text: 'ТАЄМНИЦЯ-ІСТОРІЇ', languageId: 'common' });
  await first.waitFor('CHAT_MESSAGE_NEW');
  first.ws.close();

  const successor = await connectClient(port);
  successor.send({ type: 'JOIN', role: 'player', characterId: 'liora' });
  const rejoined = await successor.waitFor('JOIN_SUCCESS');
  assert.notEqual(joined.clientId, rejoined.clientId);
  assert.ok(!rejoined.messages.some((m) => m.text === 'ТАЄМНИЦЯ-ІСТОРІЇ'),
    'whispers are scoped to the original client, not a reusable character id');
  successor.ws.close();
});

test('a later player with the target character cannot read old whispers', { timeout: 30000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feria-whisper-target-history-'));
  const port = await freePort();
  const server = await startServer(localEnv(port, dir));
  t.after(async () => {
    await stopServer(server);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const sender = await connectClient(port);
  sender.send({ type: 'JOIN', role: 'player', characterId: 'liora' });
  await sender.waitFor('JOIN_SUCCESS');
  sender.send({
    type: 'SET_WHISPER_TARGET', targetClientId: null, targetCharacterId: 'amenemhet'
  });
  await sender.waitFor('SELF_WHISPER_UPDATED');
  sender.send({ type: 'CHAT_MESSAGE', text: 'ТАЄМНИЦЯ-ДЛЯ-АМЕНЕМХЕТА', languageId: 'common' });
  await sender.waitFor('CHAT_MESSAGE_NEW');
  sender.ws.close();

  const target = await connectClient(port);
  target.send({ type: 'JOIN', role: 'player', characterId: 'amenemhet' });
  const joined = await target.waitFor('JOIN_SUCCESS');
  assert.ok(!joined.messages.some((m) => m.text === 'ТАЄМНИЦЯ-ДЛЯ-АМЕНЕМХЕТА'),
    'character-targeted whispers are bound to the sessions online at send time');
  target.ws.close();
});

test('the graceful-shutdown path flushes a pending mutation before exit', { timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feria-sigterm-'));
  const kv = await startFakeKv();
  const port = await freePort();
  const env = localEnv(port, dir, {
    UPSTASH_REDIS_REST_URL: kv.url,
    UPSTASH_REDIS_REST_TOKEN: 'test-token',
    STATE_KEY: 'feria:sigterm:test'
  });
  let server = await startServer(env, true);
  t.after(async () => {
    await stopServer(server);
    await kv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const player = await connectClient(port);
  player.send({ type: 'JOIN', role: 'player', characterId: 'adrian' });
  await player.waitFor('JOIN_SUCCESS');
  player.clear();
  player.send({ type: 'CHAT_MESSAGE', text: 'ПЕРЕВІРКА-SIGTERM', languageId: 'common' });
  await player.waitFor('CHAT_MESSAGE_NEW'); // handled, but debounce has not run
  player.ws.close();

  await gracefulStop(server);
  const raw = kv.keys.get(env.STATE_KEY);
  assert.ok(raw && raw.includes('ПЕРЕВІРКА-SIGTERM'), 'final mutation must be flushed on SIGTERM');

  server = await startServer(env);
  const reconnected = await connectClient(port);
  reconnected.send({ type: 'JOIN', role: 'player', characterId: 'liora' });
  const joined = await reconnected.waitFor('JOIN_SUCCESS');
  assert.ok(joined.messages.some((m) => m.text === 'ПЕРЕВІРКА-SIGTERM'));
  reconnected.ws.close();
});

test('chat rate limit survives a reconnect with the same identity', { timeout: 40000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feria-ratelimit-'));
  const port = await freePort();
  const server = await startServer(localEnv(port, dir));
  t.after(async () => {
    await stopServer(server);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const first = await connectClient(port);
  first.send({ type: 'JOIN', role: 'player', characterId: 'liora' });
  await first.waitFor('JOIN_SUCCESS');
  for (let i = 0; i < 10; i++) first.send({ type: 'CHAT_MESSAGE', text: `burst-${i}`, languageId: 'common' });
  await waitUntil(() => first.count('ERROR') > 0, 3000, 'chat throttle');

  first.ws.close();
  const second = await connectClient(port);
  second.send({ type: 'JOIN', role: 'player', characterId: 'liora' });
  await second.waitFor('JOIN_SUCCESS');
  for (let i = 0; i < 5; i++) second.send({ type: 'CHAT_MESSAGE', text: `after-${i}`, languageId: 'common' });
  await waitUntil(() => second.count('ERROR') > 0, 3000, 'throttle after reconnect');
  second.ws.close();
});

test('a superseded instance cannot overwrite the newer KV snapshot', { timeout: 90000 }, async (t) => {
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'feria-owner-a-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'feria-owner-b-'));
  const kv = await startFakeKv();
  const portA = await freePort();
  const portB = await freePort();
  const shared = {
    UPSTASH_REDIS_REST_URL: kv.url,
    UPSTASH_REDIS_REST_TOKEN: 'test-token',
    STATE_KEY: 'feria:owner:test'
  };
  const a = await startServer(localEnv(portA, dirA, shared));
  let b = null;
  t.after(async () => {
    await stopServer(a);
    if (b) await stopServer(b);
    await kv.close();
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  });

  const clientA = await connectClient(portA);
  clientA.send({ type: 'JOIN', role: 'player', characterId: 'adrian' });
  await clientA.waitFor('JOIN_SUCCESS');
  clientA.clear();
  clientA.send({ type: 'CHAT_MESSAGE', text: 'STALE-MESSAGE', languageId: 'common' });
  await clientA.waitFor('CHAT_MESSAGE_NEW');
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.ok(kv.keys.get(shared.STATE_KEY).includes('STALE-MESSAGE'), 'first instance wrote while it owned the key');

  // B starts last and becomes the active writer.
  b = await startServer(localEnv(portB, dirB, shared));
  const rawBefore = kv.keys.get(shared.STATE_KEY);
  clientA.send({ type: 'CHAT_MESSAGE', text: 'OVERWRITE-ATTEMPT', languageId: 'common' });
  await clientA.waitFor('CHAT_MESSAGE_NEW');
  await new Promise((resolve) => setTimeout(resolve, 700));
  const rawAfter = kv.keys.get(shared.STATE_KEY);
  assert.equal(rawAfter, rawBefore, 'stale instance must not overwrite the active snapshot');
  assert.ok(!rawAfter.includes('OVERWRITE-ATTEMPT'));

  const healthA = await fetch(`http://127.0.0.1:${portA}/api/health`).then((r) => r.json());
  assert.equal(healthA.status, 'degraded');
  clientA.ws.close();
});

