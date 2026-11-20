const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.PORT) || 3456;
const DATA_PATH = path.join(__dirname, 'data', 'campaign-state.json');

// Rune / glyph alphabets per scriptStyle using widely supported Unicode characters
const SCRIPT_ALPHABETS = {
  common: 'abcdefghijklmnopqrstuvwxyz',
  elvish: 'αεηθικλμνξοπρστυφχψωάέήίόύώ',
  runic: 'ᚠᚢᚦᚨᚱᚲᚷᚹᚺᚾᛁᛃᛇᛈᛉᛊᛏᛒᛖᛗᛚᛜᛞᛟ',
  infernal: 'ΨΩΔΘΛΞΠΣΦΧѰѮѲѴЖҘҠҤҪҮ†‡§∆∇',
  draconic: 'ΔΘΛΞΠΣΦΨΩΓΒΖΚΜΠᚠᚲᚺᛉᛏᛒᛗᛟ',
  druidic: 'ᚠᚦᚱᚲᚹᛁᛃᛈᛊᛏᛖᛚᛞᛟ❦❧✿❀❁✾✽❃',
  alien: '⊗⊕⊘⊙⊚⊛⊜⊝⊞⊟⊠⊡◈◉◊○◍◎●◐◑⌖⌗',
  ancient: 'ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩѢѲѴѦ',
  imperial: '⌸⌖⌗⌬⌭⌸⌹⊞⊟⊠⊡§¶∆0123456789ABCDEF',
  steppe: 'ҚҒҢҮҰҺӨӘҖӜӞӤӦӨӪӬӮӰӲӴᚠᚱᛏᚺ',
  cipher: '†‡§¤¿¡‽※◊○●□■△▲▽▼★☆♠♣♥♦'
};

const DEFAULT_GLYPHS = {
  common: '◈',
  elvish: '❧',
  dwarvish: 'ᛏ',
  draconic: 'Δ',
  infernal: 'Ψ',
  abyssal: '⸸',
  druidic: 'ᛉ',
  primordial: '≈',
  deep_speech: '◉',
  celestial: '✦',
  thieves_cant: '‡',
  undercommon: '⊘',
  kiros_ancient: 'Ѫ',
  niman_cipher: '⌬',
  steppe_turs: 'ᚱ',
  amenemhet: '☽',
  adrian: '†',
  liora: 'ᛉ',
  jagatai: 'ᚱ'
};

function sanitizeGlyph(icon, id, fallback = '✦') {
  const str = String(icon || '').trim();
  if (!str || /\p{Extended_Pictographic}/u.test(str) || str === '⚔️' || str === '⚒️' || str === '👁️' || str === '🗝️' || str === '🕳️' || str === '🕯️' || str === '⚙️' || str === '🗣️' || str === '🛡️') {
    return DEFAULT_GLYPHS[id] || fallback;
  }
  return str;
}

function sanitizeStateIcons(targetState) {
  if (!targetState) return;
  if (Array.isArray(targetState.languages)) {
    targetState.languages.forEach((l) => {
      if (l) l.icon = sanitizeGlyph(l.icon, l.id, '✦');
    });
  }
  if (Array.isArray(targetState.characters)) {
    targetState.characters.forEach((c) => {
      if (c) c.icon = sanitizeGlyph(c.icon, c.id, '❖');
    });
  }
  if (Array.isArray(targetState.messages)) {
    targetState.messages.forEach((m) => {
      if (m) m.senderIcon = sanitizeGlyph(m.senderIcon, m.senderCharacterId, m.senderCharacterId ? '❖' : '♔');
    });
  }
}

let state = loadState();
sanitizeStateIcons(state);
const clients = new Map(); // clientId -> client record
const messages = Array.isArray(state.messages) ? state.messages : []; // Persisted session messages & handouts
state.messages = messages;

function loadState() {
  try {
    const raw = fs.readFileSync(DATA_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    sanitizeStateIcons(parsed);
    return parsed;
  } catch (err) {
    console.error('Failed to read campaign-state.json:', err);
    return { dmPin: '1250', languages: [], characters: [], messages: [] };
  }
}

function saveState() {
  try {
    state.messages = messages;
    const dir = path.dirname(DATA_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const tmpPath = DATA_PATH + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmpPath, DATA_PATH);
  } catch (err) {
    console.error('Failed to persist campaign-state.json:', err);
  }
}

function getLanguageById(languageId) {
  return state.languages.find((l) => l.id === languageId) || null;
}

function getCharacterById(characterId) {
  return state.characters.find((c) => c.id === characterId) || null;
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
function translateToRunes(text, scriptStyle = 'runic', revealPercent = 0, seed = 1) {
  if (!text) return '';
  if (revealPercent >= 100) return text;

  const alphabetStr = SCRIPT_ALPHABETS[scriptStyle] || SCRIPT_ALPHABETS.runic;
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
  if (msg.senderCharacterId && recipient.characterId === msg.senderCharacterId) return true;
  if (msg.whisperTargetClientId && recipient.id === msg.whisperTargetClientId) return true;
  if (msg.whisperTargetCharacterId && recipient.characterId === msg.whisperTargetCharacterId) return true;
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
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function broadcastStateSync() {
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
      peers,
      messages: messages.filter((m) => canSeeMessage(m, client)).map((m) => projectMessageForListener(m, client))
    };
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

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), clients: clients.size });
});

app.get('/api/export-state', (req, res) => {
  if (String(req.query.pin || '') !== String(state.dmPin)) {
    res.status(403).json({ error: 'Invalid DM PIN' });
    return;
  }
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

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function disconnectClient(targetClient, closeWs = true) {
  if (!targetClient) return;
  const wasJoined = targetClient.joined;
  targetClient.joined = false;
  clients.delete(targetClient.id);

  if (wasJoined) {
    for (const other of clients.values()) {
      if (other.joined) {
        sendJson(other.ws, { type: 'PEER_LEFT', clientId: targetClient.id });
      }
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

wss.on('connection', (ws) => {
  const clientId = crypto.randomUUID();
  const client = {
    id: clientId,
    ws,
    isAlive: true,
    joined: false,
    role: 'player',
    characterId: null,
    activeLanguageId: 'common',
    whisperTargetClientId: null,
    whisperTargetCharacterId: null,
    isSpeaking: false,
    speakingLevel: 0
  };
  clients.set(clientId, client);

  ws.on('pong', () => {
    client.isAlive = true;
  });

  ws.on('message', (rawData) => {
    let data;
    try {
      data = JSON.parse(rawData.toString());
    } catch {
      return;
    }

    handleMessage(client, data);
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
      if (role === 'dm') {
        if (String(data.pin || '') !== String(state.dmPin)) {
          sendJson(client.ws, { type: 'JOIN_ERROR', error: 'Невірний PIN-код Майстра.' });
          return;
        }
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
      client.isSpeaking = !!data.isSpeaking;
      client.speakingLevel = Number(data.level) || 0;
      for (const other of clients.values()) {
        if (other.joined && other.id !== client.id) {
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
      const wCharId = data.whisperTargetCharacterId || client.whisperTargetCharacterId || null;
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
        revealMap: {},
        translatedForParty: false,
        translatedBy: null,
        isWhisper,
        whisperTargetClientId: wClientId,
        whisperTargetCharacterId: wCharId,
        whisperTargetName
      };

      messages.push(msg);
      if (messages.length > 150) {
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
      const percent = [0, 25, 50, 100].includes(Number(data.percent)) ? Number(data.percent) : 0;
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

      broadcastStateSync();
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
      broadcastStateSync();
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
      broadcastStateSync();
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
      broadcastStateSync();
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
        existing.scriptStyle = SCRIPT_ALPHABETS[payload.scriptStyle] ? payload.scriptStyle : existing.scriptStyle;
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
          scriptStyle: SCRIPT_ALPHABETS[payload.scriptStyle] ? payload.scriptStyle : 'ancient',
          dspPreset: sanitizedPreset
        });
      }

      saveState();
      broadcastStateSync();
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
      broadcastStateSync();
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
      broadcastStateSync();
      break;
    }

    case 'DM_DELETE_CHARACTER': {
      if (!client.joined || client.role !== 'dm') return;
      const charId = data.characterId;
      state.characters = state.characters.filter((c) => c.id !== charId);
      saveState();
      broadcastStateSync();
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

      state.languages = snap.languages;
      state.characters = snap.characters;
      messages.length = 0;
      if (Array.isArray(snap.messages)) {
        snap.messages.slice(-150).forEach((m) => messages.push(m));
      }
      state.messages = messages;
      sanitizeStateIcons(state);
      saveState();
      broadcastStateSync();
      for (const peer of clients.values()) {
        if (peer.joined) broadcastPeerLanguageUpdate(peer);
      }
      sendJson(client.ws, { type: 'IMPORT_SUCCESS' });
      break;
    }

    case 'AUDIO_RELAY_CHUNK': {
      if (!client.joined || typeof data.pcmBase64 !== 'string' || data.pcmBase64.length > 32768) return;
      const targetIds = Array.isArray(data.targetClientIds) ? data.targetClientIds : [];
      const sampleRate = Number(data.sampleRate) || 16000;

      for (const targetId of targetIds) {
        const target = clients.get(targetId);
        if (!target || !target.joined || target.id === client.id) continue;
        if (!isWhisperAllowed(client, target)) continue;
        sendJson(target.ws, {
          type: 'AUDIO_RELAY_CHUNK',
          fromClientId: client.id,
          pcmBase64: data.pcmBase64,
          sampleRate
        });
      }
      break;
    }

    case 'WEBRTC_OFFER':
    case 'WEBRTC_ANSWER':
    case 'WEBRTC_ICE': {
      if (!client.joined || !data.targetClientId) return;
      const target = clients.get(data.targetClientId);
      if (target && target.joined) {
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

function clampNum(val, min, max, fallback) {
  const num = Number(val);
  if (Number.isNaN(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Feria Polyglot server listening on http://localhost:${PORT}`);
  });
}

module.exports = {
  app,
  server,
  translateToRunes,
  canUnderstand,
  canSpeak
};
