const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');
const {
  SCRIPT_ALPHABETS,
  MAX_MESSAGES,
  clampNum,
  sanitizeGlyph,
  normalizeState,
  CampaignStore
} = require('./state-store');
const { validateWsMessage, RateLimiter } = require('./validation');
const { encodeRelayFrame, decodeRelayFrame, decodeBase64Pcm } = require('./public/js/audio-protocol');

const PORT = Number(process.env.PORT) || 3456;
const HOST = process.env.HOST || undefined;
const KV_CONFIGURED = !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
const DATA_DIR = process.env.STATE_DIR || path.join(__dirname, 'data');
// Local-only mode keeps the legacy file; KV mode uses a separate cache so the
// git-tracked seed is never overwritten.
const DEFAULT_STATE_FILE = KV_CONFIGURED ? 'runtime-state.json' : 'campaign-state.json';
const DATA_PATH = process.env.STATE_PATH || path.join(DATA_DIR, DEFAULT_STATE_FILE);
const SEED_PATH = path.join(__dirname, 'data', 'campaign-state.json');
const DM_PIN = process.env.FERIA_DM_PIN || null;
// Render exposes RENDER_GIT_COMMIT; local runs fall back to a per-boot id. The
// browser compares this value and reconnects as soon as a new instance takes over.
const BUILD_ID = process.env.RENDER_GIT_COMMIT || process.env.FERIA_BUILD_ID || crypto.randomUUID();
const INSTANCE_ID = crypto.randomUUID();
const MAX_CONNECTIONS_PER_IP = 24;
// Shortened only by local regression tests; production always gets 20 s.
const JOIN_TIMEOUT_MS = Math.max(100, Number(process.env.FERIA_JOIN_TIMEOUT_MS) || 20000);
let shuttingDown = false;

const store = new CampaignStore({
  dataPath: DATA_PATH,
  seedPath: SEED_PATH === DATA_PATH ? null : SEED_PATH,
  url: process.env.UPSTASH_REDIS_REST_URL || '',
  token: process.env.UPSTASH_REDIS_REST_TOKEN || '',
  key: process.env.STATE_KEY || 'feria:campaign-state',
  ownerId: INSTANCE_ID
});

let state = normalizeState(null);
let messages = [];
let languageIndex = new Map();
let characterIndex = new Map();
let indexesVersion = -1;
let stateVersion = 0;
const clients = new Map(); // clientId -> client record
const stats = { rejectedMessages: 0, droppedAudioChunks: 0 };

const rateLimits = {
  chat: new RateLimiter({ capacity: 5, refillPerSec: 2 }),
  mutation: new RateLimiter({ capacity: 10, refillPerSec: 5 }),
  speaking: new RateLimiter({ capacity: 20, refillPerSec: 20 }),
  relay: new RateLimiter({ capacity: 131072, refillPerSec: 131072 }),
  signaling: new RateLimiter({ capacity: 30, refillPerSec: 10 }),
  pin: new RateLimiter({ capacity: 5, refillPerSec: 1 / 60 })
};

async function initialize() {
  if (process.env.NODE_ENV === 'production' && !DM_PIN) {
    // Never fall back to the public seed PIN on a public deployment.
    throw new Error('FERIA_DM_PIN must be set in production');
  }
  // Claim ownership before loading: an older instance must not overwrite KV
  // during Render's zero-downtime overlap window.
  await store.claimOwnership();
  state = await store.load();
  messages = Array.isArray(state.messages) ? state.messages : [];
  state.messages = messages;
  indexesVersion = -1;
  stateVersion++;
  const info = store.status();
  console.log(`[state] storage=${info.storageMode} languages=${state.languages.length} characters=${state.characters.length} messages=${messages.length}`);
}

function rebuildIndexes() {
  if (indexesVersion === stateVersion) return;
  languageIndex = new Map(state.languages.map((l) => [l.id, l]));
  characterIndex = new Map(state.characters.map((c) => [c.id, c]));
  indexesVersion = stateVersion;
}

function saveState() {
  if (shuttingDown) return;
  state.messages = messages;
  stateVersion++;
  store.scheduleSave(() => state);
}

function getLanguageById(languageId) {
  rebuildIndexes();
  return languageIndex.get(languageId) || null;
}

function getCharacterById(characterId) {
  rebuildIndexes();
  return characterIndex.get(characterId) || null;
}

function deterministicHash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Deterministically translates text into fantasy runes/glyphs while keeping spaces,
 * punctuation, and word lengths intact. When revealPercent > 0, reveals an exact
 * percentage of words deterministically (stable across 25% -> 50% -> 100%).
 */
const RUNE_CACHE = new Map();
const RUNE_CACHE_MAX = 500;

function translateToRunes(text, scriptStyle = 'runic', revealPercent = 0, seed = 1) {
  if (!text) return '';
  const key = JSON.stringify([scriptStyle, revealPercent, seed, text]);
  if (RUNE_CACHE.has(key)) {
    const cached = RUNE_CACHE.get(key);
    RUNE_CACHE.delete(key);
    RUNE_CACHE.set(key, cached);
    return cached;
  }
  const value = computeRunes(text, scriptStyle, revealPercent, seed);
  RUNE_CACHE.set(key, value);
  if (RUNE_CACHE.size > RUNE_CACHE_MAX) {
    RUNE_CACHE.delete(RUNE_CACHE.keys().next().value);
  }
  return value;
}

function computeRunes(text, scriptStyle = 'runic', revealPercent = 0, seed = 1) {
  if (revealPercent >= 100) return text;

  const alphabetStr = Object.prototype.hasOwnProperty.call(SCRIPT_ALPHABETS, scriptStyle)
    ? SCRIPT_ALPHABETS[scriptStyle]
    : SCRIPT_ALPHABETS.runic;
  const glyphs = Array.from(alphabetStr);

  // Split text preserving words and separators
  const tokens = text.match(/[\p{L}\p{N}_'-]+|[^\p{L}\p{N}_'-]+/gu) || [text];
  const wordIndices = [];

  for (let i = 0; i < tokens.length; i++) {
    if (/^[\p{L}\p{N}_'-]+$/u.test(tokens[i])) {
      wordIndices.push(i);
    }
  }

  const revealedSet = new Set();
  if (revealPercent > 0 && wordIndices.length > 0) {
    const targetCount = Math.max(
      0,
      Math.min(wordIndices.length, Math.round((wordIndices.length * revealPercent) / 100))
    );
    const ranked = wordIndices
      .map((tokenIdx, wordOrder) => ({
        tokenIdx,
        score: deterministicHash(`${seed}:${wordOrder}:${tokens[tokenIdx]}`)
      }))
      .sort((a, b) => a.score - b.score);

    for (let i = 0; i < targetCount; i++) {
      revealedSet.add(ranked[i].tokenIdx);
    }
  }

  return tokens
    .map((token, tokenIdx) => {
      if (!/^[\p{L}\p{N}_'-]+$/u.test(token)) {
        return token;
      }
      if (revealedSet.has(tokenIdx)) {
        return token;
      }
      const chars = Array.from(token);
      return chars
        .map((ch, charIdx) => {
          if (ch === '-' || ch === "'") return ch;
          const idx = deterministicHash(`${seed}:${scriptStyle}:${tokenIdx}:${charIdx}:${ch}`) % glyphs.length;
          return glyphs[idx];
        })
        .join('');
    })
    .join('');
}

function canUnderstand(clientRole, character, languageId) {
  if (languageId === 'common') return true;
  if (clientRole === 'dm') return true;
  if (!character) return false;
  if (character.comprehendLanguages === true || character.tongues === true) return true;
  return Array.isArray(character.languages) && character.languages.includes(languageId);
}

function canSpeak(clientRole, character, languageId) {
  if (languageId === 'common') return true;
  if (clientRole === 'dm') return true;
  if (!character) return false;
  if (character.tongues === true) return true;
  return Array.isArray(character.languages) && character.languages.includes(languageId);
}

function getClientCharacter(client) {
  if (!client || client.role === 'dm' || !client.characterId) return null;
  return getCharacterById(client.characterId);
}

function getSpeakableLanguagesForClient(client) {
  if (client.role === 'dm') {
    return state.languages;
  }
  const character = getClientCharacter(client);
  return state.languages.filter((lang) => canSpeak('player', character, lang.id));
}

function buildPublicCharacter(char) {
  return {
    id: char.id,
    name: char.name,
    title: char.title,
    icon: char.icon,
    avatarColor: char.avatarColor,
    comprehendLanguages: !!char.comprehendLanguages,
    tongues: !!char.tongues,
    forcedLanguage: char.forcedLanguage || null
  };
}

function buildCharactersForClient(client) {
  if (client.role === 'dm') {
    return state.characters;
  }
  return state.characters.map((char) => {
    const pub = buildPublicCharacter(char);
    if (char.id === client.characterId) {
      pub.languages = [...(char.languages || [])];
    }
    return pub;
  });
}

function isWhisperActive(client) {
  return !!(client.whisperTargetClientId || client.whisperTargetCharacterId);
}

function isWhisperAllowed(speakerClient, listenerClient) {
  if (!isWhisperActive(speakerClient)) return true;
  // DMs already see every whisper in the chat projection; keep audio consistent.
  if (listenerClient.role === 'dm') return true;
  if (listenerClient.id === speakerClient.id) return true;
  if (speakerClient.whisperTargetClientId && listenerClient.id === speakerClient.whisperTargetClientId) {
    return true;
  }
  if (speakerClient.whisperTargetCharacterId && listenerClient.characterId === speakerClient.whisperTargetCharacterId) {
    return true;
  }
  return false;
}

function canSeeMessage(msg, recipient) {
  if (!msg.isWhisper) return true;
  if (recipient.role === 'dm') return true;
  if (recipient.id === msg.senderClientId) return true;
  // Character ids are reusable. Granting access by senderCharacterId would let
  // a later player joining the same character read the previous session's
  // private whispers from history.
  // Bind history access to the sessions that were online when the whisper was
  // written. Character ids are reusable, so a later player taking the same
  // character must not inherit the previous session's private conversation.
  if (Array.isArray(msg.whisperTargetClientIds) && msg.whisperTargetClientIds.includes(recipient.id)) return true;
  if (msg.whisperTargetClientId && recipient.id === msg.whisperTargetClientId) return true;
  return false;
}

function buildFullStateSnapshot() {
  return {
    version: 1,
    exportedAt: Date.now(),
    languages: state.languages,
    characters: state.characters,
    messages
  };
}

/**
 * Projects a speaker's language state for a specific listener, hiding language identity
 * if the listener cannot understand it while preserving dspPreset for audio scrambling.
 * Handles Telepathy/Whisper isolation so non-target listeners are muted completely.
 */
function projectLanguageForListener(speakerClient, listenerClient) {
  const lang = getLanguageById(speakerClient.activeLanguageId) || getLanguageById('common');
  const whisperOn = isWhisperActive(speakerClient);
  const whisperAllowed = isWhisperAllowed(speakerClient, listenerClient);

  if (whisperOn && !whisperAllowed) {
    return {
      languageId: 'whisper',
      languageName: 'Таємний шепіт',
      languageIcon: '~',
      languageColor: '#64748b',
      scriptStyle: lang.scriptStyle,
      understood: false,
      canReplyInLanguage: false,
      isWhisperToMe: false,
      mutedByWhisper: true,
      dspPreset: lang.dspPreset
    };
  }

  const listenerChar = getClientCharacter(listenerClient);
  const understood = canUnderstand(listenerClient.role, listenerChar, lang.id);
  const canReplyInLanguage = canSpeak(listenerClient.role, listenerChar, lang.id);

  if (understood) {
    return {
      languageId: lang.id,
      languageName: lang.name,
      languageIcon: lang.icon,
      languageColor: lang.color,
      scriptStyle: lang.scriptStyle,
      understood: true,
      canReplyInLanguage,
      isWhisperToMe: whisperOn && whisperAllowed,
      mutedByWhisper: false,
      dspPreset: lang.dspPreset
    };
  }

  return {
    languageId: 'unknown',
    languageName: 'Невідома мова',
    languageIcon: '?',
    languageColor: '#64748b',
    scriptStyle: lang.scriptStyle,
    understood: false,
    canReplyInLanguage: false,
    isWhisperToMe: whisperOn && whisperAllowed,
    mutedByWhisper: false,
    dspPreset: lang.dspPreset
  };
}

function buildPeerSummaryForListener(peerClient, listenerClient) {
  const char = getClientCharacter(peerClient);
  const projected = projectLanguageForListener(peerClient, listenerClient);
  return {
    clientId: peerClient.id,
    role: peerClient.role,
    characterId: peerClient.characterId || null,
    displayName: peerClient.role === 'dm' ? 'Майстер (ГМ)' : (char ? char.name : 'Гравець'),
    title: peerClient.role === 'dm' ? 'Game Master' : (char ? char.title : ''),
    icon: peerClient.role === 'dm' ? '♔' : (char ? char.icon : '❖'),
    avatarColor: peerClient.role === 'dm' ? '#c89d54' : (char ? char.avatarColor : '#6366f1'),
    isSpeaking: !!peerClient.isSpeaking,
    speakingLevel: peerClient.speakingLevel || 0,
    ...projected
  };
}

function projectMessageForListener(msg, listenerClient) {
  const listenerChar = getClientCharacter(listenerClient);
  const lang = getLanguageById(msg.languageId) || getLanguageById('common');
  const nativeUnderstood = canUnderstand(listenerClient.role, listenerChar, lang.id);

  // Check manual reveal percentage from DM (for specific character or 'ALL')
  let revealPercent = 0;
  if (nativeUnderstood || msg.translatedForParty) {
    revealPercent = 100;
  } else if (listenerChar && msg.revealMap) {
    const charPercent = msg.revealMap[listenerChar.id] || 0;
    const allPercent = msg.revealMap.ALL || 0;
    revealPercent = Math.max(charPercent, allPercent);
  }

  const isFullyRevealed = revealPercent >= 100;
  const isPartiallyRevealed = revealPercent > 0 && revealPercent < 100;
  const visibleText = isFullyRevealed
    ? msg.text
    : translateToRunes(msg.text, lang.scriptStyle, revealPercent, msg.seed);

  // Language name is hidden unless listener natively understands it, it was translated, or fully deciphered
  const showLanguageName = nativeUnderstood || msg.translatedForParty || revealPercent >= 100;

  const base = {
    id: msg.id,
    senderClientId: msg.senderClientId,
    senderCharacterId: msg.senderCharacterId,
    senderName: msg.senderName,
    senderIcon: msg.senderIcon,
    senderColor: msg.senderColor,
    isHandout: !!msg.isHandout,
    title: msg.title || null,
    timestamp: msg.timestamp,
    languageId: showLanguageName ? lang.id : 'unknown',
    languageName: showLanguageName ? lang.name : 'Невідома мова',
    languageIcon: showLanguageName ? lang.icon : '?',
    languageColor: showLanguageName ? lang.color : '#64748b',
    scriptStyle: lang.scriptStyle,
    understood: isFullyRevealed,
    nativeUnderstood,
    partiallyDeciphered: isPartiallyRevealed,
    revealPercent,
    translatedForParty: !!msg.translatedForParty,
    translatedBy: msg.translatedBy || null,
    isWhisper: !!msg.isWhisper,
    whisperTargetName: msg.whisperTargetName || null,
    text: visibleText
  };

  if (listenerClient.role === 'dm') {
    base.revealMap = { ...(msg.revealMap || {}) };
    base.originalLanguageId = lang.id;
    base.originalLanguageName = lang.name;
  }

  return base;
}

function sendJson(ws, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch (err) {
    console.warn('[ws] send failed:', err.message);
  }
}

/**
 * Forwards one decoded relay frame to every allowed target. Protocol-2 clients
 * receive the original binary frame unchanged; legacy clients receive the old
 * base64 JSON envelope so a cached client bundle keeps working during rollout.
 */
function forwardRelayFrame(sender, frame, rawFrame) {
  const allowed = new Set(frame.targetIds);
  let delivered = 0;
  for (const target of clients.values()) {
    if (!allowed.has(target.id) || !target.joined || target.id === sender.id) continue;
    if (!isWhisperAllowed(sender, target)) continue;
    if (target.ws.readyState !== WebSocket.OPEN) continue;

    try {
      if (target.relayProtocol === 2) {
        target.ws.send(rawFrame, { binary: true });
      } else {
        sendJson(target.ws, {
          type: 'AUDIO_RELAY_CHUNK',
          fromClientId: sender.id,
          pcmBase64: Buffer.from(frame.pcmBytes).toString('base64'),
          sampleRate: frame.sampleRate
        });
      }
      delivered++;
    } catch (err) {
      stats.droppedAudioChunks++;
    }
  }
  return delivered;
}

function broadcastStateSync(options = {}) {
  const includeMessages = options.includeMessages !== false;
  for (const client of clients.values()) {
    if (!client.joined) continue;
    const char = getClientCharacter(client);

    // Ensure client's activeLanguageId is still speakable by them
    if (!canSpeak(client.role, char, client.activeLanguageId)) {
      client.activeLanguageId = 'common';
    }

    const peers = [];
    for (const other of clients.values()) {
      if (other.joined && other.id !== client.id) {
        peers.push(buildPeerSummaryForListener(other, client));
      }
    }

    const payload = {
      type: 'STATE_SYNC',
      character: char,
      activeLanguageId: client.activeLanguageId,
      languages: getSpeakableLanguagesForClient(client),
      characters: buildCharactersForClient(client),
      peers
    };
    if (includeMessages) {
      payload.messages = messages.filter((m) => canSeeMessage(m, client)).map((m) => projectMessageForListener(m, client));
    }
    if (client.role === 'dm') {
      payload.fullStateSnapshot = buildFullStateSnapshot();
    }
    sendJson(client.ws, payload);
  }
}

function broadcastPeerLanguageUpdate(speakerClient) {
  for (const listener of clients.values()) {
    if (!listener.joined || listener.id === speakerClient.id) continue;
    const projected = projectLanguageForListener(speakerClient, listener);
    sendJson(listener.ws, {
      type: 'PEER_LANGUAGE_UPDATE',
      clientId: speakerClient.id,
      ...projected
    });
  }
}

const DEFAULT_STUN_URLS = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
  'stun:stun.cloudflare.com:3478'
];
// The old openrelay.metered.ca host now resolves to black-hole addresses. The
// current Open Relay endpoint uses coturn-style shared-secret auth, so generate
// short-lived browser credentials instead of shipping a fixed public password.
// Operators can still override everything with TURN_URL(S)/USERNAME/CREDENTIAL.
const DEFAULT_TURN_HOST = 'staticauth.openrelay.metered.ca';
const DEFAULT_TURN_SECRET = 'openrelayprojectsecret';
const DEFAULT_TURN_URLS = [
  `turn:${DEFAULT_TURN_HOST}:80`,
  `turn:${DEFAULT_TURN_HOST}:80?transport=tcp`,
  `turn:${DEFAULT_TURN_HOST}:443?transport=tcp`,
  `turns:${DEFAULT_TURN_HOST}:443?transport=tcp`
];

function openRelayCredentials() {
  const secret = process.env.TURN_SHARED_SECRET || DEFAULT_TURN_SECRET;
  const expiresAt = Math.floor(Date.now() / 1000) + 6 * 60 * 60;
  const username = `${expiresAt}:feria`;
  const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
  return { username, credential };
}

function parseIceUrls(value, fallback) {
  const raw = typeof value === 'string' && value.trim() ? value : fallback;
  return String(raw)
    .split(',')
    .map((url) => url.trim())
    .filter((url) => /^(stuns?|turns?):/i.test(url) && url.length <= 512)
    .slice(0, 16);
}

function buildRtcConfig() {
  const stunUrls = parseIceUrls(process.env.STUN_URLS, DEFAULT_STUN_URLS.join(','));
  const customTurn = process.env.TURN_URL || process.env.TURN_URLS;
  const turnUrls = parseIceUrls(customTurn, DEFAULT_TURN_URLS.join(','));
  const iceServers = stunUrls.map((urls) => ({ urls }));
  if (turnUrls.length) {
    // Default OpenRelay uses coturn static-auth and needs generated credentials.
    // A custom TURN may be no-auth, so never advertise empty username/credential
    // fields unless the operator actually provided them.
    const auth = customTurn
      ? {
          ...(process.env.TURN_USERNAME ? { username: String(process.env.TURN_USERNAME).slice(0, 256) } : {}),
          ...(process.env.TURN_CREDENTIAL ? { credential: String(process.env.TURN_CREDENTIAL).slice(0, 512) } : {})
        }
      : openRelayCredentials();
    iceServers.push({ urls: turnUrls, ...auth });
  }
  return { iceServers };
}

const app = express();
// One trusted proxy hop in front of Render; X-Forwarded-For alone is untrusted.
app.set('trust proxy', 1);
app.use(express.json({ limit: '256kb' }));
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (_req, res) => {
  const info = store.status();
  const unhealthy = info.degraded || (info.kvConfigured && (!info.lastSyncAt || !!info.lastSaveError));
  res.status(unhealthy ? 503 : 200).json({
    status: unhealthy ? 'degraded' : 'ok',
    uptime: process.uptime(),
    clients: clients.size,
    ...info,
    buildId: BUILD_ID,
    rejectedMessages: stats.rejectedMessages,
    droppedAudioChunks: stats.droppedAudioChunks
  });
});

app.get('/api/rtc-config', (_req, res) => {
  res.json(buildRtcConfig());
});

app.post('/api/export-state', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  // Share one bucket with WebSocket DM joins so switching transports cannot
  // reset the brute-force budget.
  const bucket = `pin:${ip}`;
  if (!rateLimits.pin.consume(bucket)) {
    res.status(429).json({ error: 'Too many attempts' });
    return;
  }
  const expectedPin = DM_PIN || String(state.dmPin);
  if (String(req.body?.pin || '') !== String(expectedPin)) {
    res.status(403).json({ error: 'Invalid DM PIN' });
    return;
  }
  rateLimits.pin.reset(bucket);
  res.json(buildFullStateSnapshot());
});

app.get('/api/lobby', (_req, res) => {
  const onlineCharIds = new Set();
  let dmOnline = false;
  for (const c of clients.values()) {
    if (!c.joined) continue;
    if (c.role === 'dm') dmOnline = true;
    if (c.characterId) onlineCharIds.add(c.characterId);
  }

  res.json({
    dmOnline,
    buildId: BUILD_ID,
    // Never advertise the seed PIN on a deployment with a configured secret.
    defaultPin: DM_PIN ? null : String(state.dmPin || ''),
    characters: state.characters.map((c) => ({
      id: c.id,
      name: c.name,
      title: c.title,
      icon: c.icon,
      avatarColor: c.avatarColor,
      online: onlineCharIds.has(c.id)
    }))
  });
});

// Malformed JSON must not leak a development stack trace on a public service.
app.use((err, _req, res, _next) => {
  console.error('[http] request error:', err.message);
  if (!res.headersSent) res.status(400).json({ error: 'Invalid request' });
});

const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  maxPayload: 64 * 1024,
  perMessageDeflate: false,
  verifyClient: (info, done) => {
    // Non-browser clients (tests, scripts) send no Origin and stay allowed.
    const origin = info.req.headers.origin;
    if (!origin) return done(true);
    const host = info.req.headers.host;
    if (!host) return done(false);
    try {
      const url = new URL(origin);
      const forwardedProto = String(info.req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
      const expectedProto = forwardedProto || (info.req.socket.encrypted ? 'https' : 'http');
      // Tunnels may rewrite Host; browsers cannot set X-Forwarded-Host themselves.
      const forwardedHost = String(info.req.headers['x-forwarded-host'] || '').split(',')[0].trim();
      const allowedHosts = [host, forwardedHost].filter(Boolean);
      done(allowedHosts.includes(url.host) && url.protocol === `${expectedProto}:`);
    } catch {
      done(false);
    }
  }
});
wss.on('error', (err) => console.error('[ws] server error:', err.message));

function rateBucketForType(type) {
  if (type === 'CHAT_MESSAGE') return 'chat';
  if (type === 'SPEAKING_STATE') return 'speaking';
  if (type === 'AUDIO_RELAY_CHUNK') return 'relay';
  if (type === 'WEBRTC_OFFER' || type === 'WEBRTC_ANSWER' || type === 'WEBRTC_ICE') return 'signaling';
  if (type === 'REVEAL_MESSAGE' || type === 'TRANSLATE_FOR_PARTY' || type === 'DELETE_MESSAGE' ||
      type === 'CLEAR_CHAT' || type.startsWith('DM_')) return 'mutation';
  return null;
}

// Buckets are keyed on the trusted proxy IP plus the joined identity so a
// reconnect cannot refresh an abuser's budget (and one household does not share
// a single audio bucket with every other visitor).
function rateKey(client, bucket) {
  if (bucket === 'relay') return `${client.id}:relay`;
  return `${client.ip}:${client.characterId || client.role || 'anon'}:${bucket}`;
}

function disconnectClient(targetClient, closeWs = true) {
  if (!targetClient) return;
  const wasJoined = targetClient.joined;
  targetClient.joined = false;
  if (targetClient.joinTimer) {
    clearTimeout(targetClient.joinTimer);
    targetClient.joinTimer = null;
  }
  clients.delete(targetClient.id);

  if (wasJoined) {
    for (const other of clients.values()) {
      if (!other.joined) continue;
      if (other.whisperTargetClientId === targetClient.id ||
          (targetClient.characterId && other.whisperTargetCharacterId === targetClient.characterId)) {
        other.whisperTargetClientId = null;
        other.whisperTargetCharacterId = null;
        sendJson(other.ws, {
          type: 'SELF_WHISPER_UPDATED',
          targetClientId: null,
          targetCharacterId: null,
          targetName: null
        });
        broadcastPeerLanguageUpdate(other);
      }
      sendJson(other.ws, { type: 'PEER_LEFT', clientId: targetClient.id });
    }
  }

  if (closeWs && targetClient.ws) {
    try {
      if (targetClient.ws.readyState === WebSocket.OPEN || targetClient.ws.readyState === WebSocket.CONNECTING) {
        targetClient.ws.close(4000, 'Session closed or replaced');
      }
    } catch {}
  }
}

/** Drops sessions/whisper targets that no longer exist after a DM state edit. */
function pruneStaleSessions() {
  const validCharIds = new Set(state.characters.map((c) => c.id));
  for (const client of [...clients.values()]) {
    if (client.joined && client.role === 'player' && client.characterId &&
        !validCharIds.has(client.characterId)) {
      disconnectClient(client, true);
    }
  }
  const joinedIds = new Set([...clients.values()]
    .filter((c) => c.joined).map((c) => c.id));
  for (const client of clients.values()) {
    if (!client.joined) continue;
    const staleClient = client.whisperTargetClientId &&
      !joinedIds.has(client.whisperTargetClientId);
    const staleChar = client.whisperTargetCharacterId &&
      !validCharIds.has(client.whisperTargetCharacterId);
    if (!staleClient && !staleChar) continue;
    client.whisperTargetClientId = null;
    client.whisperTargetCharacterId = null;
    sendJson(client.ws, {
      type: 'SELF_WHISPER_UPDATED',
      targetClientId: null,
      targetCharacterId: null,
      targetName: null
    });
    broadcastPeerLanguageUpdate(client);
  }
}

/** Failed JOINs must not leave unjoined sockets occupying per-IP connection slots. */
function armJoinWatchdog(client) {
  if (client.joined || client.joinTimer) return;
  client.joined = false;
  client.joinTimer = setTimeout(() => {
    if (!client.joined && !shuttingDown) {
      try { client.ws.terminate(); } catch {}
      disconnectClient(client, false);
    }
  }, JOIN_TIMEOUT_MS);
  client.joinTimer.unref?.();
}

wss.on('connection', (ws, req) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  let connectionsFromIp = 0;
  for (const existing of clients.values()) {
    if (existing.ip === ip) connectionsFromIp++;
  }
  if (connectionsFromIp >= MAX_CONNECTIONS_PER_IP) {
    try { ws.close(1008, 'Too many connections'); } catch {}
    return;
  }
  const clientId = crypto.randomUUID();
  const client = {
    id: clientId,
    ws,
    ip,
    isAlive: true,
    joined: false,
    role: 'player',
    characterId: null,
    activeLanguageId: 'common',
    whisperTargetClientId: null,
    whisperTargetCharacterId: null,
    isSpeaking: false,
    speakingLevel: 0,
    lastSpeakingForwardAt: 0,
    relayProtocol: 1
  };
  clients.set(clientId, client);
  armJoinWatchdog(client);

  ws.on('error', (err) => {
    console.warn('[ws] connection error:', err.message);
  });

  ws.on('pong', () => {
    client.isAlive = true;
  });

  ws.on('message', (rawData, isBinary) => {
    // Binary frames are compact PCM relay packets (see public/js/audio-protocol.js).
    if (isBinary || (Buffer.isBuffer(rawData) && rawData.length > 0 && rawData[0] === 1)) {
      try {
        const frame = decodeRelayFrame(rawData);
        if (!client.joined) return;
        const cost = frame.pcmBytes.length;
        if (!rateLimits.relay.consume(rateKey(client, 'relay'), cost)) {
          stats.droppedAudioChunks++;
          return;
        }
        // The sender is authenticated from the socket, never trusted from the frame.
        // Re-encoding is only needed if a client tried to spoof the sender field.
        const outbound = frame.senderId === client.id
          ? rawData
          : Buffer.from(encodeRelayFrame({
            senderId: client.id,
            targetIds: frame.targetIds,
            sampleRate: frame.sampleRate,
            sequence: frame.sequence,
            pcm: frame.pcm
          }));
        frame.senderId = client.id;
        forwardRelayFrame(client, frame, outbound);
      } catch (err) {
        stats.rejectedMessages++;
      }
      return;
    }

    let data;
    try {
      data = JSON.parse(rawData.toString());
    } catch {
      stats.rejectedMessages++;
      return;
    }

    const error = validateWsMessage(data);
    if (error) {
      stats.rejectedMessages++;
      if (data && (data.type === 'CHAT_MESSAGE' ||
          (typeof data.type === 'string' && data.type.startsWith('DM_')))) {
        sendJson(ws, { type: 'ERROR', error });
      }
      return;
    }

    const bucket = rateBucketForType(data.type);
    if (bucket) {
      const cost = data.type === 'AUDIO_RELAY_CHUNK' ? data.pcmBase64.length : 1;
      if (!rateLimits[bucket].consume(rateKey(client, bucket), cost)) {
        stats.rejectedMessages++;
        if (bucket === 'chat' || bucket === 'mutation') {
          sendJson(ws, { type: 'ERROR', error: 'Занадто багато дій, зачекайте.' });
        }
        return;
      }
    }

    try {
      handleMessage(client, data);
    } catch (err) {
      console.error('[ws] handler error:', err.message);
    }
  });

  ws.on('close', () => {
    disconnectClient(client, false);
  });
});

// 20-second heartbeat ping to purge stale/ghost WebSocket connections behind proxies
const heartbeatTimer = setInterval(() => {
  for (const client of [...clients.values()]) {
    if (client.isAlive === false) {
      try { client.ws.terminate(); } catch {}
      disconnectClient(client, false);
      continue;
    }
    client.isAlive = false;
    try {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.ping();
      }
    } catch {}
  }
  for (const limiter of Object.values(rateLimits)) limiter.prune();
  // Health must be able to recover after a transient KV/local write failure even
  // if no player sends another mutation. Retries remain ownership-guarded.
  if (!shuttingDown && store.status().lastSaveError) {
    store.scheduleSave(() => buildFullStateSnapshot());
  }
}, 20000);
heartbeatTimer.unref();

function handleMessage(client, data) {
  switch (data.type) {
    case 'LEAVE': {
      disconnectClient(client, true);
      break;
    }

    case 'JOIN': {
      const role = data.role === 'dm' ? 'dm' : 'player';
      // LEAVE removes the record; a same-socket JOIN must restore it or the
      // client can mutate state while being invisible to every broadcast.
      clients.set(client.id, client);
      // Only a successful JOIN disarms the watchdog. Re-arm it after LEAVE,
      // where disconnectClient() removed the original timer.
      armJoinWatchdog(client);
      client.whisperTargetClientId = null;
      client.whisperTargetCharacterId = null;
      client.isSpeaking = false;
      client.speakingLevel = 0;
      client.relayProtocol = data.relayProtocol === 2 ? 2 : 1;
      if (role === 'dm') {
        const expectedPin = DM_PIN || String(state.dmPin);
        const pinBucket = `pin:${client.ip}`;
        if (!rateLimits.pin.consume(pinBucket)) {
          sendJson(client.ws, { type: 'JOIN_ERROR', error: 'Забагато спроб входу. Спробуйте пізніше.' });
          return;
        }
        if (String(data.pin || '') !== String(expectedPin)) {
          sendJson(client.ws, { type: 'JOIN_ERROR', error: 'Невірний PIN-код Майстра.' });
          return;
        }
        rateLimits.pin.reset(pinBucket);
        // Evict any existing ghost/duplicate DM sessions cleanly
        for (const other of [...clients.values()]) {
          if (other.id !== client.id && other.joined && other.role === 'dm') {
            disconnectClient(other, true);
          }
        }
        client.role = 'dm';
        client.characterId = null;
      } else {
        const char = getCharacterById(data.characterId);
        if (!char) {
          sendJson(client.ws, { type: 'JOIN_ERROR', error: 'Персонажа не знайдено.' });
          return;
        }
        // Evict any existing ghost/duplicate sessions for the same character
        for (const other of [...clients.values()]) {
          if (other.id !== client.id && other.joined && other.characterId === char.id) {
            disconnectClient(other, true);
          }
        }
        client.role = 'player';
        client.characterId = char.id;
        client.activeLanguageId = char.forcedLanguage && canSpeak('player', char, char.forcedLanguage)
          ? char.forcedLanguage
          : 'common';
      }

      client.joined = true;
      if (client.joinTimer) {
        clearTimeout(client.joinTimer);
        client.joinTimer = null;
      }
      const myChar = getClientCharacter(client);

      const peers = [];
      for (const other of clients.values()) {
        if (other.joined && other.id !== client.id) {
          peers.push(buildPeerSummaryForListener(other, client));
          sendJson(other.ws, {
            type: 'PEER_JOINED',
            peer: buildPeerSummaryForListener(client, other)
          });
        }
      }

      const joinPayload = {
        type: 'JOIN_SUCCESS',
        clientId: client.id,
        role: client.role,
        character: myChar,
        activeLanguageId: client.activeLanguageId,
        languages: getSpeakableLanguagesForClient(client),
        characters: buildCharactersForClient(client),
        peers,
        messages: messages.filter((m) => canSeeMessage(m, client)).map((m) => projectMessageForListener(m, client))
      };
      if (client.role === 'dm') {
        joinPayload.fullStateSnapshot = buildFullStateSnapshot();
      }
      sendJson(client.ws, joinPayload);
      break;
    }

    case 'ACTIVE_LANGUAGE_CHANGE': {
      if (!client.joined) return;
      const lang = getLanguageById(data.languageId);
      if (!lang) return;
      const char = getClientCharacter(client);
      if (!canSpeak(client.role, char, lang.id)) {
        sendJson(client.ws, {
          type: 'ERROR',
          error: 'Ваш персонаж не може говорити цією мовою.'
        });
        return;
      }
      client.activeLanguageId = lang.id;
      sendJson(client.ws, {
        type: 'SELF_LANGUAGE_UPDATED',
        languageId: lang.id
      });
      broadcastPeerLanguageUpdate(client);
      break;
    }

    case 'SPEAKING_STATE': {
      if (!client.joined) return;
      const wasSpeaking = client.isSpeaking;
      client.isSpeaking = !!data.isSpeaking;
      client.speakingLevel = Math.max(0, Math.min(1, Number(data.level) || 0));
      const now = Date.now();
      if (!wasSpeaking && !client.isSpeaking) return;
      if (client.isSpeaking === wasSpeaking && now - client.lastSpeakingForwardAt < 100) return;
      client.lastSpeakingForwardAt = now;
      for (const other of clients.values()) {
        if (other.joined && other.id !== client.id && isWhisperAllowed(client, other)) {
          sendJson(other.ws, {
            type: 'PEER_SPEAKING_UPDATE',
            clientId: client.id,
            isSpeaking: client.isSpeaking,
            speakingLevel: client.speakingLevel
          });
        }
      }
      break;
    }

    case 'SET_WHISPER_TARGET': {
      if (!client.joined) return;
      const targetClientId = data.targetClientId || null;
      const targetCharacterId = data.targetCharacterId || null;

      if (!targetClientId && !targetCharacterId) {
        client.whisperTargetClientId = null;
        client.whisperTargetCharacterId = null;
        sendJson(client.ws, {
          type: 'SELF_WHISPER_UPDATED',
          targetClientId: null,
          targetCharacterId: null,
          targetName: null
        });
        broadcastPeerLanguageUpdate(client);
        break;
      }

      const targetPeer = targetClientId ? clients.get(targetClientId) : null;
      const targetChar = targetCharacterId
        ? getCharacterById(targetCharacterId)
        : (targetPeer ? getClientCharacter(targetPeer) : null);

      client.whisperTargetClientId = targetPeer ? targetPeer.id : targetClientId;
      client.whisperTargetCharacterId = targetChar ? targetChar.id : targetCharacterId;

      const targetName = targetPeer?.role === 'dm'
        ? 'Майстер (ГМ)'
        : (targetChar ? targetChar.name : 'Обраний гравець');

      sendJson(client.ws, {
        type: 'SELF_WHISPER_UPDATED',
        targetClientId: client.whisperTargetClientId,
        targetCharacterId: client.whisperTargetCharacterId,
        targetName
      });
      broadcastPeerLanguageUpdate(client);
      break;
    }

    case 'CHAT_MESSAGE': {
      if (!client.joined) return;
      const rawText = String(data.text || '').trim();
      if (!rawText) return;

      const char = getClientCharacter(client);
      const requestedLangId = data.languageId || client.activeLanguageId || 'common';
      const langId = canSpeak(client.role, char, requestedLangId) ? requestedLangId : 'common';

      const wClientId = client.whisperTargetClientId || null;
      const wCharId = client.whisperTargetCharacterId || null;
      // Snapshot the concrete sessions allowed to read this whisper. A character
      // target is resolved to the players currently playing it, never to a
      // future player who happens to reuse the same character id.
      const wClientIds = new Set();
      if (wClientId) wClientIds.add(wClientId);
      if (wCharId) {
        for (const peer of clients.values()) {
          if (peer.joined && peer.characterId === wCharId) wClientIds.add(peer.id);
        }
      }
      const isWhisper = !!(wClientId || wCharId);
      let whisperTargetName = null;
      if (isWhisper) {
        const wPeer = wClientId ? clients.get(wClientId) : null;
        const wChar = wCharId ? getCharacterById(wCharId) : (wPeer ? getClientCharacter(wPeer) : null);
        whisperTargetName = wPeer?.role === 'dm' ? 'Майстер (ГМ)' : (wChar ? wChar.name : 'Співрозмовник');
      }

      const msg = {
        id: crypto.randomUUID(),
        senderClientId: client.id,
        senderCharacterId: char ? char.id : null,
        senderName: client.role === 'dm' ? 'Майстер (ГМ)' : (char ? char.name : 'Гравець'),
        senderIcon: client.role === 'dm' ? '♔' : (char ? char.icon : '❖'),
        senderColor: client.role === 'dm' ? '#c89d54' : (char ? char.avatarColor : '#6366f1'),
        languageId: langId,
        text: rawText,
        isHandout: !!data.isHandout && client.role === 'dm',
        title: data.title ? String(data.title).trim() : null,
        timestamp: Date.now(),
        seed: Math.floor(Math.random() * 1000000) + 1,
        revealMap: Object.create(null),
        translatedForParty: false,
        translatedBy: null,
        isWhisper,
        whisperTargetClientId: wClientId,
        whisperTargetClientIds: [...wClientIds],
        whisperTargetCharacterId: wCharId,
        whisperTargetName
      };

      messages.push(msg);
      if (messages.length > MAX_MESSAGES) {
        messages.shift();
      }
      saveState();

      for (const recipient of clients.values()) {
        if (recipient.joined && canSeeMessage(msg, recipient)) {
          sendJson(recipient.ws, {
            type: 'CHAT_MESSAGE_NEW',
            message: projectMessageForListener(msg, recipient)
          });
        }
      }
      break;
    }

    case 'REVEAL_MESSAGE': {
      if (!client.joined || client.role !== 'dm') return;
      const msg = messages.find((m) => m.id === data.messageId);
      if (!msg) return;

      const targetCharId = data.characterId || 'ALL';
      if (targetCharId !== 'ALL' && !getCharacterById(targetCharId)) return;
      const percent = Number(data.percent);
      msg.revealMap[targetCharId] = percent;
      saveState();

      for (const recipient of clients.values()) {
        if (recipient.joined && canSeeMessage(msg, recipient)) {
          sendJson(recipient.ws, {
            type: 'CHAT_MESSAGE_UPDATED',
            message: projectMessageForListener(msg, recipient)
          });
        }
      }
      break;
    }

    case 'TRANSLATE_FOR_PARTY': {
      if (!client.joined) return;
      const msg = messages.find((m) => m.id === data.messageId);
      if (!msg) return;

      const char = getClientCharacter(client);
      const allowed = canUnderstand(client.role, char, msg.languageId)
        || (char && (msg.revealMap[char.id] >= 100 || msg.revealMap.ALL >= 100));
      if (!allowed) return;

      msg.translatedForParty = true;
      msg.translatedBy = client.role === 'dm' ? 'Майстер (ГМ)' : (char ? char.name : 'Гравець');
      saveState();

      for (const recipient of clients.values()) {
        if (recipient.joined && canSeeMessage(msg, recipient)) {
          sendJson(recipient.ws, {
            type: 'CHAT_MESSAGE_UPDATED',
            message: projectMessageForListener(msg, recipient)
          });
        }
      }
      break;
    }

    case 'DELETE_MESSAGE': {
      if (!client.joined || client.role !== 'dm') return;
      const idx = messages.findIndex((m) => m.id === data.messageId);
      if (idx < 0) return;

      messages.splice(idx, 1);
      saveState();
      for (const recipient of clients.values()) {
        if (recipient.joined) {
          sendJson(recipient.ws, {
            type: 'CHAT_MESSAGE_DELETED',
            messageId: data.messageId
          });
        }
      }
      break;
    }

    case 'CLEAR_CHAT': {
      if (!client.joined || client.role !== 'dm') return;
      messages.length = 0;
      saveState();
      for (const recipient of clients.values()) {
        if (recipient.joined) {
          sendJson(recipient.ws, {
            type: 'CHAT_CLEARED'
          });
        }
      }
      break;
    }

    case 'DM_FORCE_DIALOGUE': {
      if (!client.joined || client.role !== 'dm') return;
      const targetChar = getCharacterById(data.characterId);
      if (!targetChar) return;

      const targetLangId = data.languageId ? data.languageId : 'common';
      const lang = getLanguageById(targetLangId);
      if (!lang) return;

      // Toggle off if already forced to this language
      const isClearing = data.languageId === null || (targetChar.forcedLanguage === targetLangId && targetLangId !== 'common');
      const finalLangId = isClearing ? 'common' : targetLangId;
      const finalLang = getLanguageById(finalLangId);

      // Switch DM to this language too so both speak it immediately
      client.activeLanguageId = finalLangId;
      sendJson(client.ws, {
        type: 'SELF_LANGUAGE_UPDATED',
        languageId: finalLangId
      });
      broadcastPeerLanguageUpdate(client);

      targetChar.forcedLanguage = isClearing ? null : finalLangId;
      saveState();

      // Switch connected client(s) playing targetChar if they can speak it (or force temporary dialogue)
      for (const peer of clients.values()) {
        if (peer.joined && peer.characterId === targetChar.id) {
          if (canSpeak('player', targetChar, finalLangId)) {
            peer.activeLanguageId = finalLangId;
            sendJson(peer.ws, {
              type: 'SELF_LANGUAGE_UPDATED',
              languageId: finalLangId
            });
            broadcastPeerLanguageUpdate(peer);
            sendJson(peer.ws, {
              type: 'FORCED_LANGUAGE_NOTICE',
              active: !isClearing,
              languageId: finalLang.id,
              languageName: finalLang.name,
              languageIcon: finalLang.icon,
              languageColor: finalLang.color
            });
          } else {
            sendJson(client.ws, {
              type: 'ERROR',
              error: `${targetChar.name} не знає мову «${finalLang.name}» для відповіді.`
            });
          }
        }
      }

      broadcastStateSync({ includeMessages: false });
      break;
    }

    case 'DM_RESET_FORCED_LANGUAGES': {
      if (!client.joined || client.role !== 'dm') return;
      state.characters.forEach((c) => {
        c.forcedLanguage = null;
      });
      saveState();
      for (const peer of clients.values()) {
        if (peer.joined) {
          peer.activeLanguageId = 'common';
          sendJson(peer.ws, { type: 'SELF_LANGUAGE_UPDATED', languageId: 'common' });
          broadcastPeerLanguageUpdate(peer);
        }
      }
      broadcastStateSync({ includeMessages: false });
      break;
    }

    case 'DM_TOGGLE_CHAR_LANGUAGE': {
      if (!client.joined || client.role !== 'dm') return;
      const char = getCharacterById(data.characterId);
      const lang = getLanguageById(data.languageId);
      if (!char || !lang || lang.id === 'common') return;

      if (!Array.isArray(char.languages)) char.languages = ['common'];
      const idx = char.languages.indexOf(lang.id);
      if (idx >= 0) {
        char.languages.splice(idx, 1);
      } else {
        char.languages.push(lang.id);
      }
      saveState();
      broadcastStateSync({ includeMessages: false });
      // Also update speaking language permissions for peers
      for (const peer of clients.values()) {
        if (peer.joined && peer.characterId === char.id) {
          broadcastPeerLanguageUpdate(peer);
        }
      }
      break;
    }

    case 'DM_SET_MAGIC_BUFF': {
      if (!client.joined || client.role !== 'dm') return;
      const char = getCharacterById(data.characterId);
      if (!char) return;
      if (data.buff !== 'comprehendLanguages' && data.buff !== 'tongues') return;

      char[data.buff] = !!data.value;
      saveState();
      broadcastStateSync({ includeMessages: false });
      break;
    }

    case 'DM_CREATE_LANGUAGE':
    case 'DM_UPDATE_LANGUAGE': {
      if (!client.joined || client.role !== 'dm') return;
      const payload = data.language || {};
      const name = String(payload.name || '').trim();
      if (!name) return;

      const sanitizedPreset = {
        grainSizeMs: clampNum(payload.dspPreset?.grainSizeMs, 80, 260, 145),
        pitchRatio: clampNum(payload.dspPreset?.pitchRatio, 0.55, 1.65, 1.0),
        formantShiftHz: clampNum(payload.dspPreset?.formantShiftHz, -600, 600, 0),
        subOctaveMix: clampNum(payload.dspPreset?.subOctaveMix, 0, 0.8, 0),
        ringModHz: clampNum(payload.dspPreset?.ringModHz, 0, 250, 0),
        ringModMix: clampNum(payload.dspPreset?.ringModMix, 0, 0.6, 0),
        reverbMix: clampNum(payload.dspPreset?.reverbMix, 0, 0.85, 0.3),
        chorusMix: clampNum(payload.dspPreset?.chorusMix, 0, 0.85, 0.2),
        filterType: ['allpass', 'lowpass', 'highpass', 'bandpass', 'lowshelf', 'highshelf'].includes(payload.dspPreset?.filterType)
          ? payload.dspPreset.filterType
          : 'bandpass',
        filterFreq: clampNum(payload.dspPreset?.filterFreq, 120, 6000, 1200),
        atmosphereMix: clampNum(payload.dspPreset?.atmosphereMix, 0, 0.45, 0.2)
      };

      const existing = payload.id ? getLanguageById(payload.id) : null;
      if (existing) {
        existing.name = name;
        existing.category = ['standard', 'exotic', 'feria'].includes(payload.category) ? payload.category : existing.category;
        existing.color = payload.color || existing.color;
        existing.icon = sanitizeGlyph(payload.icon, existing.id, existing.icon || '✦');
        existing.scriptStyle = Object.prototype.hasOwnProperty.call(SCRIPT_ALPHABETS, payload.scriptStyle)
          ? payload.scriptStyle
          : existing.scriptStyle;
        existing.dspPreset = sanitizedPreset;
      } else {
        const slug = name
          .toLowerCase()
          .replace(/[^a-z0-9а-яіїєґ]+/gi, '_')
          .replace(/^_+|_+$/g, '');
        const newId = `${slug || 'lang'}_${Date.now().toString(36).slice(-4)}`;
        state.languages.push({
          id: newId,
          name,
          category: ['standard', 'exotic', 'feria'].includes(payload.category) ? payload.category : 'feria',
          color: payload.color || '#c084fc',
          icon: sanitizeGlyph(payload.icon, newId, '✦'),
          scriptStyle: Object.prototype.hasOwnProperty.call(SCRIPT_ALPHABETS, payload.scriptStyle)
            ? payload.scriptStyle
            : 'ancient',
          dspPreset: sanitizedPreset
        });
      }

      saveState();
      broadcastStateSync({ includeMessages: false });
      for (const peer of clients.values()) {
        if (peer.joined) broadcastPeerLanguageUpdate(peer);
      }
      break;
    }

    case 'DM_DELETE_LANGUAGE': {
      if (!client.joined || client.role !== 'dm') return;
      const langId = data.languageId;
      if (!langId || langId === 'common') return;
      state.languages = state.languages.filter((l) => l.id !== langId);
      state.characters.forEach((c) => {
        if (Array.isArray(c.languages)) {
          c.languages = c.languages.filter((id) => id !== langId);
        }
        if (c.forcedLanguage === langId) c.forcedLanguage = null;
      });
      saveState();
      broadcastStateSync({ includeMessages: false });
      break;
    }

    case 'DM_CREATE_CHARACTER': {
      if (!client.joined || client.role !== 'dm') return;
      const payload = data.character || {};
      const name = String(payload.name || '').trim();
      if (!name) return;

      const id = `char_${Date.now().toString(36)}`;
      const knownLangs = Array.isArray(payload.languages) ? payload.languages.filter((l) => getLanguageById(l)) : [];
      if (!knownLangs.includes('common')) knownLangs.unshift('common');

      state.characters.push({
        id,
        name,
        title: String(payload.title || 'Авантюрист').trim(),
        icon: sanitizeGlyph(payload.icon, id, '❖'),
        avatarColor: payload.avatarColor || '#38bdf8',
        languages: knownLangs,
        comprehendLanguages: false,
        tongues: false,
        forcedLanguage: null
      });
      saveState();
      broadcastStateSync({ includeMessages: false });
      break;
    }

    case 'DM_DELETE_CHARACTER': {
      if (!client.joined || client.role !== 'dm') return;
      const charId = data.characterId;
      state.characters = state.characters.filter((c) => c.id !== charId);
      // Refresh indexes before pruning broadcasts peer projections.
      saveState();
      pruneStaleSessions();
      broadcastStateSync({ includeMessages: false });
      break;
    }

    case 'DM_IMPORT_STATE': {
      if (!client.joined || client.role !== 'dm') return;
      const snap = data.snapshot;
      if (!snap || !Array.isArray(snap.languages) || !Array.isArray(snap.characters)) {
        sendJson(client.ws, { type: 'ERROR', error: 'Некоректний формат резервної копії.' });
        return;
      }

      if (!snap.languages.some((l) => l && l.id === 'common')) {
        sendJson(client.ws, { type: 'ERROR', error: 'У резервній копії відсутня базова мова Загальна (common).' });
        return;
      }

      const normalized = normalizeState(snap);
      state.languages = normalized.languages;
      state.characters = normalized.characters;
      messages.length = 0;
      for (const msg of normalized.messages) messages.push(msg);
      state.messages = messages;
      // Refresh indexes before pruning broadcasts peer projections.
      saveState();
      pruneStaleSessions();
      broadcastStateSync();
      for (const peer of clients.values()) {
        if (peer.joined) broadcastPeerLanguageUpdate(peer);
      }
      sendJson(client.ws, { type: 'IMPORT_SUCCESS' });
      break;
    }

    case 'AUDIO_RELAY_CHUNK': {
      if (!client.joined) return;
      let pcm;
      try {
        pcm = decodeBase64Pcm(data.pcmBase64);
      } catch {
        stats.rejectedMessages++;
        return;
      }
      const frame = {
        senderId: client.id,
        targetIds: data.targetClientIds,
        sampleRate: Number(data.sampleRate),
        pcm,
        pcmBytes: new Uint8Array(pcm.buffer)
      };
      const outbound = encodeRelayFrame({
        senderId: client.id,
        targetIds: frame.targetIds,
        sampleRate: frame.sampleRate,
        sequence: 0,
        pcm
      });
      forwardRelayFrame(client, frame, outbound);
      break;
    }

    case 'WEBRTC_OFFER':
    case 'WEBRTC_ANSWER':
    case 'WEBRTC_ICE': {
      if (!client.joined || !data.targetClientId) return;
      const target = clients.get(data.targetClientId);
      // The server stamps the sender; clients cannot spoof fromClientId. Apply
      // the same whisper policy as relayed audio so P2P cannot bypass it.
      if (target && target.joined &&
          isWhisperAllowed(client, target) && isWhisperAllowed(target, client)) {
        sendJson(target.ws, {
          type: data.type,
          fromClientId: client.id,
          payload: data.payload
        });
      }
      break;
    }
  }
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} received, closing connections...`);
  // Worst case is two ownership GETs plus one SET at 6 s each; leave enough
  // headroom so a slow Upstash cannot truncate the final state flush.
  const forceExit = setTimeout(() => process.exit(1), 25000);
  forceExit.unref();
  clearInterval(heartbeatTimer);
  // Stop new work before the final flush, otherwise a frame arriving during
  // shutdown can arm a debounce timer that never fires.
  for (const client of [...clients.values()]) {
    try { client.ws.close(1001, 'Server shutdown'); } catch {}
  }
  try {
    wss.close();
    await Promise.race([
      new Promise((resolve) => server.close(resolve)),
      new Promise((resolve) => setTimeout(resolve, 2000))
    ]);
    if (await store.stillOwner()) {
      await store.close();
      console.log('[server] state flushed');
    } else {
      store.discardPending();
      console.log('[server] newer instance active; stale state discarded');
    }
  } catch (err) {
    console.error('[server] shutdown error:', err.message);
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
// Inert in production (no IPC channel); lets tests exercise the exact same
// graceful-shutdown path on platforms where SIGTERM cannot be delivered.
process.on('message', (message) => {
  if (message === 'graceful-shutdown') shutdown('IPC');
});
process.on('unhandledRejection', (reason) => console.error('[server] unhandled rejection:', reason));
server.on('error', (err) => console.error('[server] error:', err.message));
server.on('clientError', (_err, socket) => {
  try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch {}
});

if (require.main === module) {
  initialize().then(() => {
    const onListening = () => console.log(`Feria Polyglot server listening on http://localhost:${PORT}`);
    if (HOST) server.listen(PORT, HOST, onListening);
    else server.listen(PORT, onListening);
  }).catch((err) => {
    console.error('[server] failed to initialize:', err);
    process.exit(1);
  });
}

module.exports = {
  app,
  server,
  initialize,
  store,
  translateToRunes,
  canUnderstand,
  canSpeak
};
