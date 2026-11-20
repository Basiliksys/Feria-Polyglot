'use strict';

const { SCRIPT_ALPHABETS, FILTER_TYPES, CATEGORIES, ID_RE, COLOR_RE, REVEAL_PERCENTS } = require('./state-store');

const MESSAGE_TYPES = new Set([
  'LEAVE', 'JOIN', 'ACTIVE_LANGUAGE_CHANGE', 'SPEAKING_STATE', 'SET_WHISPER_TARGET',
  'CHAT_MESSAGE', 'REVEAL_MESSAGE', 'TRANSLATE_FOR_PARTY', 'DELETE_MESSAGE', 'CLEAR_CHAT',
  'DM_FORCE_DIALOGUE', 'DM_RESET_FORCED_LANGUAGES', 'DM_TOGGLE_CHAR_LANGUAGE',
  'DM_SET_MAGIC_BUFF', 'DM_CREATE_LANGUAGE', 'DM_UPDATE_LANGUAGE', 'DM_DELETE_LANGUAGE',
  'DM_CREATE_CHARACTER', 'DM_DELETE_CHARACTER', 'DM_IMPORT_STATE',
  'AUDIO_RELAY_CHUNK', 'WEBRTC_OFFER', 'WEBRTC_ANSWER', 'WEBRTC_ICE'
]);

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const MAX_PCM_BASE64 = 32768;
const MAX_RELAY_TARGETS = 8;
const MAX_SIGNALING_PAYLOAD = 16384;
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isId(value) {
  return typeof value === 'string' && ID_RE.test(value);
}

function isColor(value) {
  return typeof value === 'string' && COLOR_RE.test(value);
}

function boundedText(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function jsonLength(value) {
  try {
    return JSON.stringify(value).length;
  } catch {
    return Infinity;
  }
}

/** Returns an error string when invalid, or null when the message is acceptable. */
function validateWsMessage(data) {
  if (!isPlainObject(data)) return 'Message must be an object';
  if (typeof data.type !== 'string' || !MESSAGE_TYPES.has(data.type)) return 'Unknown message type';

  switch (data.type) {
    case 'JOIN':
      if (data.relayProtocol !== undefined && data.relayProtocol !== 1 && data.relayProtocol !== 2) {
        return 'Invalid relayProtocol';
      }
      if (data.role !== 'dm' && data.role !== 'player') return 'Invalid role';
      if (data.role === 'dm') {
        if (!boundedText(data.pin, 64)) return 'Invalid PIN';
      } else if (!isId(data.characterId)) {
        return 'Invalid characterId';
      }
      return null;

    case 'ACTIVE_LANGUAGE_CHANGE':
      return isId(data.languageId) ? null : 'Invalid languageId';

    case 'SPEAKING_STATE':
      if (typeof data.isSpeaking !== 'boolean') return 'Invalid speaking state';
      if (data.level !== undefined && !Number.isFinite(Number(data.level))) return 'Invalid level';
      return null;

    case 'SET_WHISPER_TARGET':
      if (data.targetClientId !== null && data.targetClientId !== undefined && !isId(data.targetClientId)) {
        return 'Invalid targetClientId';
      }
      if (data.targetCharacterId !== null && data.targetCharacterId !== undefined && !isId(data.targetCharacterId)) {
        return 'Invalid targetCharacterId';
      }
      return null;

    case 'CHAT_MESSAGE':
      if (!boundedText(data.text, 4000)) return 'Invalid text';
      if (data.title !== undefined && data.title !== null && !boundedText(data.title, 200)) return 'Invalid title';
      if (data.languageId !== undefined && data.languageId !== null && !isId(data.languageId)) return 'Invalid languageId';
      if (data.whisperTargetCharacterId !== undefined && data.whisperTargetCharacterId !== null &&
          !isId(data.whisperTargetCharacterId)) return 'Invalid whisper target';
      return null;

    case 'REVEAL_MESSAGE':
      if (!isId(data.messageId)) return 'Invalid messageId';
      if (data.characterId !== 'ALL' && !isId(data.characterId)) return 'Invalid reveal target';
      if (!REVEAL_PERCENTS.has(Number(data.percent))) return 'Invalid reveal percent';
      return null;

    case 'TRANSLATE_FOR_PARTY':
    case 'DELETE_MESSAGE':
      return isId(data.messageId) ? null : 'Invalid messageId';

    case 'DM_FORCE_DIALOGUE':
      if (!isId(data.characterId)) return 'Invalid characterId';
      if (data.languageId !== null && data.languageId !== undefined && !isId(data.languageId)) return 'Invalid languageId';
      return null;

    case 'DM_TOGGLE_CHAR_LANGUAGE':
      return isId(data.characterId) && isId(data.languageId) ? null : 'Invalid target';

    case 'DM_SET_MAGIC_BUFF':
      if (!isId(data.characterId)) return 'Invalid characterId';
      if (data.buff !== 'comprehendLanguages' && data.buff !== 'tongues') return 'Invalid buff';
      if (typeof data.value !== 'boolean') return 'Invalid buff value';
      return null;

    case 'DM_CREATE_LANGUAGE':
    case 'DM_UPDATE_LANGUAGE': {
      const language = data.language;
      if (!isPlainObject(language) || !boundedText(language.name, 80)) return 'Invalid language';
      if (jsonLength(language) > 4000) return 'Language payload too large';
      if (language.id !== undefined && !isId(language.id)) return 'Invalid language id';
      if (language.color !== undefined && !isColor(language.color)) return 'Invalid color';
      if (language.icon !== undefined && (typeof language.icon !== 'string' || language.icon.length > 8)) return 'Invalid icon';
      if (language.scriptStyle !== undefined && !SCRIPT_ALPHABETS[language.scriptStyle]) return 'Invalid scriptStyle';
      if (language.category !== undefined && !CATEGORIES.has(language.category)) return 'Invalid category';
      if (language.dspPreset !== undefined && !isPlainObject(language.dspPreset)) return 'Invalid DSP preset';
      return null;
    }

    case 'DM_DELETE_LANGUAGE':
      return isId(data.languageId) ? null : 'Invalid languageId';

    case 'DM_CREATE_CHARACTER': {
      const character = data.character;
      if (!isPlainObject(character) || !boundedText(character.name, 80)) return 'Invalid character';
      if (jsonLength(character) > 2000) return 'Character payload too large';
      if (character.avatarColor !== undefined && !isColor(character.avatarColor)) return 'Invalid color';
      if (character.icon !== undefined && (typeof character.icon !== 'string' || character.icon.length > 8)) return 'Invalid icon';
      return null;
    }

    case 'DM_DELETE_CHARACTER':
      return isId(data.characterId) ? null : 'Invalid characterId';

    case 'DM_IMPORT_STATE': {
      const snapshot = data.snapshot;
      if (!isPlainObject(snapshot)) return 'Invalid snapshot';
      if (jsonLength(snapshot) > MAX_SNAPSHOT_BYTES) return 'Snapshot too large';
      if (!Array.isArray(snapshot.languages) || snapshot.languages.length > 100) return 'Invalid languages';
      if (!Array.isArray(snapshot.characters) || snapshot.characters.length > 100) return 'Invalid characters';
      if (snapshot.messages !== undefined && (!Array.isArray(snapshot.messages) || snapshot.messages.length > 150)) {
        return 'Invalid messages';
      }
      return null;
    }

    case 'AUDIO_RELAY_CHUNK': {
      const pcm = data.pcmBase64;
      if (typeof pcm !== 'string' || pcm.length === 0 || pcm.length > MAX_PCM_BASE64 ||
          pcm.length % 4 !== 0 || !BASE64_RE.test(pcm)) return 'Invalid audio chunk';
      if (!Array.isArray(data.targetClientIds) || data.targetClientIds.length < 1 ||
          data.targetClientIds.length > MAX_RELAY_TARGETS || !data.targetClientIds.every(isId)) {
        return 'Invalid relay targets';
      }
      const rate = Number(data.sampleRate);
      if (!Number.isFinite(rate) || rate < 8000 || rate > 48000) return 'Invalid sampleRate';
      return null;
    }

    case 'WEBRTC_OFFER':
    case 'WEBRTC_ANSWER':
    case 'WEBRTC_ICE':
      if (!isId(data.targetClientId)) return 'Invalid targetClientId';
      if (data.payload === undefined || jsonLength(data.payload) > MAX_SIGNALING_PAYLOAD) return 'Invalid signaling payload';
      return null;

    default:
      return null;
  }
}

/** Simple per-key token bucket with a shared refill rate. */
class RateLimiter {
  constructor({ capacity, refillPerSec }) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.buckets = new Map();
  }

  consume(key, cost = 1) {
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.capacity, last: now };
      this.buckets.set(key, bucket);
    }
    const refill = ((now - bucket.last) * this.refillPerSec) / 1000;
    if (refill > 0) {
      bucket.tokens = Math.min(this.capacity, bucket.tokens + refill);
      bucket.last = now;
    }
    if (bucket.tokens < cost) return false;
    bucket.tokens -= cost;
    return true;
  }

  reset(key) {
    this.buckets.delete(key);
  }

  prune(maxIdleMs = 300000) {
    const now = Date.now();
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.last > maxIdleMs) this.buckets.delete(key);
    }
  }
}

module.exports = {
  MESSAGE_TYPES,
  isPlainObject,
  isId,
  isColor,
  validateWsMessage,
  RateLimiter
};
