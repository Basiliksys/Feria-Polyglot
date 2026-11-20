'use strict';

const fs = require('fs');
const path = require('path');
const {
  LEGACY_DSP_PRESETS,
  NATURAL_DSP_PRESETS,
  presetEquals
} = require('./dsp-presets');

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

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

const DEFAULT_COMMON_LANGUAGE = {
  id: 'common',
  name: 'Загальна',
  category: 'standard',
  color: '#e2e8f0',
  icon: '◈',
  scriptStyle: 'common',
  dspPreset: {
    grainSizeMs: 140,
    pitchRatio: 1.0,
    formantShiftHz: 0,
    subOctaveMix: 0,
    ringModHz: 0,
    ringModMix: 0,
    reverbMix: 0,
    chorusMix: 0,
    filterType: 'allpass',
    filterFreq: 1000,
    atmosphereMix: 0
  }
};

const DSP_LIMITS = {
  grainSizeMs: [80, 260, 145],
  pitchRatio: [0.55, 1.65, 1.0],
  formantShiftHz: [-600, 600, 0],
  subOctaveMix: [0, 0.8, 0],
  ringModHz: [0, 250, 0],
  ringModMix: [0, 0.6, 0],
  reverbMix: [0, 0.85, 0.3],
  chorusMix: [0, 0.85, 0.2],
  filterFreq: [120, 6000, 1200],
  atmosphereMix: [0, 0.45, 0.2]
};
const FILTER_TYPES = new Set(['allpass', 'lowpass', 'highpass', 'bandpass', 'lowshelf', 'highshelf']);
const CATEGORIES = new Set(['standard', 'exotic', 'feria']);

const MAX_LANGUAGES = 100;
const MAX_CHARACTERS = 100;
const MAX_MESSAGES = 150;
const MAX_TEXT = 4000;
const MAX_TITLE = 200;
const MAX_NAME = 80;
const MAX_PIN = 64;
const REVEAL_PERCENTS = new Set([0, 25, 50, 100]);
// Allow Unicode letters (generated slugs may be Cyrillic) while rejecting path/control characters.
const ID_RE = /^[\p{L}\p{N}_-]{1,64}$/u;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function clampNum(val, min, max, fallback) {
  const num = Number(val);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}

function sanitizeGlyph(icon, id, fallback = '✦') {
  const str = String(icon || '').trim();
  if (!str || /\p{Extended_Pictographic}/u.test(str) || str.length > 8 ||
      /[<>&"'`{}[\]\\]/.test(str)) {
    return hasOwn(DEFAULT_GLYPHS, id) ? String(DEFAULT_GLYPHS[id]) : fallback;
  }
  return str;
}

function safeText(value, fallback, max) {
  const str = typeof value === 'string' ? value.trim() : '';
  return str ? str.slice(0, max) : fallback;
}

function safeId(value) {
  if (typeof value !== 'string' || !ID_RE.test(value)) return null;
  // These strings are valid identifiers but dangerous as dynamic object keys.
  if (value === '__proto__' || value === 'constructor' || value === 'toString') return null;
  return value;
}

function safeColor(value, fallback) {
  return typeof value === 'string' && COLOR_RE.test(value) ? value : fallback;
}

function normalizeDspPreset(preset) {
  const p = preset && typeof preset === 'object' && !Array.isArray(preset) ? preset : {};
  const result = {};
  for (const [key, [min, max, fallback]] of Object.entries(DSP_LIMITS)) {
    result[key] = clampNum(p[key], min, max, fallback);
  }
  result.filterType = FILTER_TYPES.has(p.filterType) ? p.filterType : 'bandpass';
  return result;
}

/** Upgrades untouched built-in presets while preserving DM customisations. */
function resolveDspPreset(id, preset) {
  const normalized = normalizeDspPreset(preset);
  const next = NATURAL_DSP_PRESETS[id];
  if (!next) return normalized;
  const legacy = LEGACY_DSP_PRESETS[id];
  if (legacy && presetEquals(normalized, normalizeDspPreset(legacy))) {
    return normalizeDspPreset(next);
  }
  return normalized;
}

/**
 * Validates and clamps any state coming from disk, KV or a DM backup so that
 * malformed data can never break projection or crash a connected client.
 */
function normalizeState(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const languages = [];
  const languageIds = new Set();

  for (const lang of (Array.isArray(source.languages) ? source.languages.slice(0, MAX_LANGUAGES) : [])) {
    if (!lang || typeof lang !== 'object') continue;
    const id = safeId(lang.id);
    if (!id || languageIds.has(id)) continue;
    languageIds.add(id);
    languages.push({
      id,
      name: safeText(lang.name, 'Мова', MAX_NAME),
      category: CATEGORIES.has(lang.category) ? lang.category : 'feria',
      color: safeColor(lang.color, '#c084fc'),
      icon: sanitizeGlyph(lang.icon, id, '✦'),
      scriptStyle: hasOwn(SCRIPT_ALPHABETS, lang.scriptStyle) ? lang.scriptStyle : 'ancient',
      dspPreset: resolveDspPreset(id, lang.dspPreset)
    });
  }
  if (!languageIds.has('common')) {
    languages.unshift(JSON.parse(JSON.stringify(DEFAULT_COMMON_LANGUAGE)));
    languageIds.add('common');
  }

  const characters = [];
  const characterIds = new Set();
  for (const char of (Array.isArray(source.characters) ? source.characters.slice(0, MAX_CHARACTERS) : [])) {
    if (!char || typeof char !== 'object') continue;
    const id = safeId(char.id);
    if (!id || characterIds.has(id)) continue;
    characterIds.add(id);
    const known = Array.isArray(char.languages) ? char.languages.filter((l) => languageIds.has(l)) : [];
    if (!known.includes('common')) known.unshift('common');
    characters.push({
      id,
      name: safeText(char.name, 'Авантюрист', MAX_NAME),
      title: safeText(char.title, '', MAX_TITLE),
      icon: sanitizeGlyph(char.icon, id, '❖'),
      avatarColor: safeColor(char.avatarColor, '#6366f1'),
      languages: known.slice(0, MAX_LANGUAGES),
      comprehendLanguages: char.comprehendLanguages === true,
      tongues: char.tongues === true,
      forcedLanguage: languageIds.has(char.forcedLanguage) ? char.forcedLanguage : null
    });
  }

  const messages = [];
  for (const msg of (Array.isArray(source.messages) ? source.messages.slice(-MAX_MESSAGES) : [])) {
    if (!msg || typeof msg !== 'object') continue;
    const id = safeId(msg.id);
    if (!id) continue;
    const revealMap = Object.create(null);
    if (msg.revealMap && typeof msg.revealMap === 'object') {
      for (const [key, value] of Object.entries(msg.revealMap)) {
        if (key !== 'ALL' && !characterIds.has(key)) continue;
        const pct = Number(value);
        if (REVEAL_PERCENTS.has(pct)) revealMap[key] = pct;
      }
    }
    messages.push({
      id,
      senderClientId: safeId(msg.senderClientId),
      senderCharacterId: safeId(msg.senderCharacterId),
      senderName: safeText(msg.senderName, 'Гравець', MAX_NAME),
      senderIcon: sanitizeGlyph(msg.senderIcon, msg.senderCharacterId, msg.senderCharacterId ? '❖' : '♔'),
      senderColor: safeColor(msg.senderColor, msg.senderCharacterId ? '#6366f1' : '#c89d54'),
      languageId: languageIds.has(msg.languageId) ? msg.languageId : 'common',
      text: typeof msg.text === 'string' ? msg.text.slice(0, MAX_TEXT) : '',
      isHandout: msg.isHandout === true,
      title: msg.title ? safeText(msg.title, null, MAX_TITLE) : null,
      timestamp: Number.isFinite(msg.timestamp) ? msg.timestamp : Date.now(),
      seed: Number.isFinite(msg.seed) ? Math.floor(msg.seed) : 1,
      revealMap,
      translatedForParty: msg.translatedForParty === true,
      translatedBy: msg.translatedBy ? safeText(msg.translatedBy, null, MAX_NAME) : null,
      isWhisper: msg.isWhisper === true,
      whisperTargetClientId: safeId(msg.whisperTargetClientId),
      whisperTargetClientIds: [...new Set(
        (Array.isArray(msg.whisperTargetClientIds) ? msg.whisperTargetClientIds.slice(0, 64) : [])
          .map((id) => safeId(id)).filter(Boolean)
      )],
      whisperTargetCharacterId: safeId(msg.whisperTargetCharacterId),
      whisperTargetName: msg.whisperTargetName ? safeText(msg.whisperTargetName, null, MAX_NAME) : null
    });
  }

  return {
    dmPin: safeText(source.dmPin, '1250', MAX_PIN),
    languages,
    characters,
    messages
  };
}

/**
 * Persists campaign state to Upstash Redis REST (zero npm dependencies) with a
 * local file as a cache/fallback. Writes are serialized, debounced and atomic.
 */
class CampaignStore {
  constructor(options = {}) {
    this.dataPath = options.dataPath;
    this.seedPath = options.seedPath;
    this.url = options.url || '';
    this.token = options.token || '';
    this.key = options.key || 'feria:campaign-state';
    this.ownerId = options.ownerId || null;
    this.ownerKey = `${this.key}:owner`;
    this.fetchImpl = options.fetchImpl || ((...args) => fetch(...args));
    this.debounceMs = options.debounceMs ?? 300;
    this.logger = options.logger || console;
    this.kvConfigured = !!(this.url && this.token);

    this.snapshot = null;
    this.pending = false;
    this.writeTimer = null;
    this.writeChain = Promise.resolve();
    this.fetchDisabledUntil = 0;
    this.lastSaveAt = null;
    this.lastSyncAt = null;
    this.lastSaveError = null;
  }

  async kvCommand(command) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const res = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json'
        },
        // Upstash REST expects one flat command array per request, e.g.
        // ["SET","key","value"]. A nested array is the pipeline format and
        // returns HTTP 400 from the live API.
        body: JSON.stringify(command),
        signal: controller.signal
      });
      if (!res.ok) throw new Error(`Upstash HTTP ${res.status}`);
      const json = await res.json();
      const entry = Array.isArray(json) ? json[0] : json;
      if (entry && entry.error) throw new Error(String(entry.error));
      return entry && entry.result !== undefined ? entry.result : null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Marks this process as the active writer so an old deploy cannot overwrite KV. */
  async claimOwnership() {
    if (!this.kvConfigured || !this.ownerId) return;
    try {
      await this.kvCommand(['SET', this.ownerKey, JSON.stringify({ id: this.ownerId, at: Date.now() })]);
      if (this.lastSaveError?.startsWith('KV ownership claim failed')) this.lastSaveError = null;
    } catch (err) {
      this.lastSaveError = `KV ownership claim failed: ${err.message}`;
      this.logger.warn?.('[state] Upstash ownership claim failed:', err.message);
    }
  }

  /** Conservative ownership check: unreadable marker means "not owner". */
  async stillOwner() {
    if (!this.kvConfigured || !this.ownerId) return true;
    try {
      const raw = await this.kvCommand(['GET', this.ownerKey]);
      if (!raw) return false;
      return JSON.parse(raw).id === this.ownerId;
    } catch (err) {
      this.logger.warn?.('[state] Ownership check failed:', err.message);
      return false;
    }
  }

  /** Drops pending writes when a newer deploy has taken over. */
  discardPending() {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    this.pending = false;
    this.snapshot = null;
  }

  async load() {
    let raw = null;

    if (this.kvConfigured && Date.now() >= this.fetchDisabledUntil) {
      try {
        raw = await this.kvCommand(['GET', this.key]);
        this.lastSyncAt = new Date().toISOString();
        if (this.lastSaveError?.startsWith('KV read failed')) this.lastSaveError = null;
      } catch (err) {
        this.lastSaveError = `KV read failed: ${err.message}`;
        this.fetchDisabledUntil = Date.now() + 30000;
        this.logger.warn?.('[state] Upstash read failed, using local copy:', err.message);
      }
    }

    if (typeof raw === 'string' && raw.trim()) {
      try {
        const state = normalizeState(JSON.parse(raw));
        if (this.lastSaveError?.startsWith('KV payload invalid')) this.lastSaveError = null;
        this.writeLocalSync(raw);
        return state;
      } catch (err) {
        this.lastSaveError = `KV payload invalid: ${err.message}`;
        this.logger.warn?.('[state] Upstash payload invalid, using local copy:', err.message);
        raw = null;
      }
    }

    const local = this.readLocalFile();
    if (local) return local;

    const seed = this.readSeedFile();
    if (seed) return seed;

    return normalizeState(null);
  }

  readJsonFile(filePath) {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      if (!raw.trim()) return null;
      return normalizeState(JSON.parse(raw));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      return { error: err };
    }
  }

  readLocalFile() {
    if (!this.dataPath) return null;
    const result = this.readJsonFile(this.dataPath);
    if (!result) return null;
    if (result.error) {
      this.lastSaveError = `Local state invalid: ${result.error.message}`;
      this.logger.warn?.('[state] Local state invalid, quarantining:', result.error.message);
      try {
        fs.renameSync(this.dataPath, `${this.dataPath}.corrupt-${Date.now()}`);
      } catch {}
      return null;
    }
    if (this.lastSaveError?.startsWith('Local state invalid')) this.lastSaveError = null;
    return result;
  }

  readSeedFile() {
    if (!this.seedPath || this.seedPath === this.dataPath) return null;
    const result = this.readJsonFile(this.seedPath);
    if (!result || result.error) return null;
    return result;
  }

  writeLocalSync(raw) {
    if (!this.dataPath) return true;
    try {
      fs.mkdirSync(path.dirname(this.dataPath), { recursive: true });
      const tmp = `${this.dataPath}.tmp`;
      fs.writeFileSync(tmp, raw, 'utf8');
      const handle = fs.openSync(tmp, 'r+');
      try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
      fs.renameSync(tmp, this.dataPath);
      if (this.lastSaveError?.startsWith('Local write failed')) this.lastSaveError = null;
      return true;
    } catch (err) {
      this.lastSaveError = `Local write failed: ${err.message}`;
      this.logger.error?.('[state] Local write failed:', err.message);
      return false;
    }
  }

  scheduleSave(getSnapshot) {
    this.snapshot = getSnapshot;
    this.pending = true;
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.flush();
    }, this.debounceMs);
  }

  flush() {
    const run = async () => {
      if (!this.pending || typeof this.snapshot !== 'function') return;
      this.pending = false;
      let raw;
      try {
        raw = JSON.stringify(this.snapshot());
        if (this.lastSaveError?.startsWith('State serialize failed')) this.lastSaveError = null;
      } catch (err) {
        this.lastSaveError = `State serialize failed: ${err.message}`;
        this.logger.error?.('[state] State serialize failed:', err.message);
        return;
      }

      const localOk = this.writeLocalSync(raw);

      if (this.kvConfigured) {
        // A previous deploy must never overwrite a newer instance's snapshot
        // during Render's zero-downtime overlap.
        if (!(await this.stillOwner())) {
          this.lastSaveError = 'KV ownership lost; write skipped';
          this.fetchDisabledUntil = Date.now() + 30000;
          return;
        }
        if (this.lastSaveError?.startsWith('KV ownership lost')) this.lastSaveError = null;
        try {
          await this.kvCommand(['SET', this.key, raw]);
          this.lastSyncAt = new Date().toISOString();
          // Only clear the health error when both durable writes succeeded.
          if (localOk) this.lastSaveError = null;
          this.fetchDisabledUntil = 0;
        } catch (err) {
          this.lastSaveError = `KV write failed: ${err.message}`;
          this.fetchDisabledUntil = Date.now() + 30000;
          this.logger.warn?.('[state] Upstash write failed:', err.message);
        }
      }
      this.lastSaveAt = new Date().toISOString();
    };

    this.writeChain = this.writeChain.then(run, run);
    return this.writeChain;
  }

  status() {
    return {
      storageMode: this.kvConfigured ? 'upstash' : 'local',
      kvConfigured: this.kvConfigured,
      lastSyncAt: this.lastSyncAt,
      lastSaveAt: this.lastSaveAt,
      lastSaveError: this.lastSaveError,
      pendingSaves: this.pending ? 1 : 0,
      degraded: !!this.lastSaveError
    };
  }

  async close() {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    await this.flush();
  }
}

module.exports = {
  SCRIPT_ALPHABETS,
  DEFAULT_GLYPHS,
  DEFAULT_COMMON_LANGUAGE,
  DSP_LIMITS,
  FILTER_TYPES,
  MAX_MESSAGES,
  MAX_TEXT,
  MAX_TITLE,
  ID_RE,
  COLOR_RE,
  REVEAL_PERCENTS,
  clampNum,
  sanitizeGlyph,
  safeColor,
  safeId,
  normalizeDspPreset,
  resolveDspPreset,
  NATURAL_DSP_PRESETS,
  LEGACY_DSP_PRESETS,
  normalizeState,
  CampaignStore
};
