// Terrablock persistence: world list, per-world save data and settings in localStorage.
//
// Every storage access is wrapped in try/catch. If localStorage is unavailable altogether (blocked
// cookies, sandboxed iframe), an in-memory store is used so the game still works for the session.
// Quota errors are reported to the caller (saveWorld/saveSettings return false).
//
// Keys:
//   terrablock:worlds        -> [meta]   meta = { id, name, seed, mode, created, lastPlayed }
//   terrablock:world:<id>    -> { v, player, inventory, survival, time, furnaces, ..., edits }
//   terrablock:settings      -> { renderDistance, fov, sensitivity, invertY, volume, ... }
//
// Edits are stored compactly: per chunk, a base64 string of (varint index delta, block id) pairs sorted
// by index — about 2.5x smaller than the JSON object form, which is still accepted when loading.

import { DEFAULT_RENDER_DISTANCE, MAX_RENDER_DISTANCE, CHUNK_VOLUME } from './config.js';

const PREFIX = 'terrablock:';
const INDEX_KEY = PREFIX + 'worlds';
const SETTINGS_KEY = PREFIX + 'settings';
const SAVE_VERSION = 1;
const worldKey = (id) => PREFIX + 'world:' + id;

export const DEFAULT_SETTINGS = Object.freeze({
  renderDistance: DEFAULT_RENDER_DISTANCE,
  fov: 70,
  sensitivity: 1,
  invertY: false,
  volume: 0.8,
});

// ---------------------------------------------------------------------------------------------
// Storage access

const memoryStore = new Map();
const memoryStorage = {
  getItem: (k) => (memoryStore.has(k) ? memoryStore.get(k) : null),
  setItem: (k, v) => void memoryStore.set(k, String(v)),
  removeItem: (k) => void memoryStore.delete(k),
};

let cachedStorage = null;
function storage() {
  if (cachedStorage) return cachedStorage;
  try {
    const ls = globalThis.localStorage;
    if (ls) {
      // Probe: Safari private mode and some sandboxes expose localStorage but throw on use.
      const probe = PREFIX + 'probe';
      ls.setItem(probe, '1');
      ls.removeItem(probe);
      cachedStorage = ls;
      return ls;
    }
  } catch (err) {
    // A full quota also fails the probe, yet reads still work: keep using localStorage then.
    try {
      if (globalThis.localStorage && isQuotaError(err)) {
        cachedStorage = globalThis.localStorage;
        return cachedStorage;
      }
    } catch {
      // fall through to memory
    }
  }
  cachedStorage = memoryStorage;
  return cachedStorage;
}

function isQuotaError(err) {
  return (
    !!err &&
    (err.name === 'QuotaExceededError' ||
      err.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
      err.code === 22 ||
      err.code === 1014)
  );
}

function readJSON(key) {
  try {
    const s = storage().getItem(key);
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

function writeJSON(key, value) {
  try {
    storage().setItem(key, JSON.stringify(value));
    return true;
  } catch (err) {
    if (!isQuotaError(err)) console.warn('Terrablock: saving failed', err);
    return false;
  }
}

function remove(key) {
  try {
    storage().removeItem(key);
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------------------------
// World index

function cleanMeta(m) {
  if (!m || typeof m !== 'object' || typeof m.id !== 'string' || !m.id) return null;
  return {
    id: m.id,
    name: cleanName(m.name),
    seed: m.seed == null ? '' : m.seed,
    mode: m.mode === 'creative' ? 'creative' : 'survival',
    created: Number.isFinite(m.created) ? m.created : Number.isFinite(m.lastPlayed) ? m.lastPlayed : 0,
    lastPlayed: Number.isFinite(m.lastPlayed) ? m.lastPlayed : 0,
  };
}

function readIndex() {
  const raw = readJSON(INDEX_KEY);
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const m of raw) {
    const c = cleanMeta(m);
    if (c && !seen.has(c.id)) {
      seen.add(c.id);
      out.push(c);
    }
  }
  return out;
}

function writeIndex(list) {
  return writeJSON(INDEX_KEY, list);
}

function cleanName(name) {
  const s = String(name == null ? '' : name)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 32);
  return s || 'New World';
}

function cleanSeed(seed) {
  if (typeof seed === 'number' && Number.isFinite(seed)) return Math.trunc(seed);
  const s = String(seed == null ? '' : seed).trim().slice(0, 64);
  if (s) return s;
  // No seed given: pick a random one (shown to the player, so a plain integer string).
  return String(Math.floor(Math.random() * 2147483647) - Math.floor(Math.random() * 2147483647));
}

function newId() {
  return 'w' + Date.now().toString(36) + Math.floor(Math.random() * 0x100000).toString(36);
}

/** [{ id, name, seed, mode, lastPlayed }], most recently played first. */
export function listWorlds() {
  return readIndex()
    .sort((a, b) => b.lastPlayed - a.lastPlayed)
    .map(({ id, name, seed, mode, lastPlayed }) => ({ id, name, seed, mode, lastPlayed }));
}

/** Register a new world and return its meta (with a fresh id). */
export function createWorld({ name, seed, mode } = {}) {
  const now = Date.now();
  const list = readIndex();
  let id = newId();
  while (list.some((m) => m.id === id)) id = newId();
  const meta = {
    id,
    name: cleanName(name),
    seed: cleanSeed(seed),
    mode: mode === 'creative' ? 'creative' : 'survival',
    created: now,
    lastPlayed: now,
  };
  list.push(meta);
  writeIndex(list);
  return { ...meta };
}

/** -> { meta, player, inventory, survival, time, edits, furnaces, ... } or null if the world doesn't exist. */
export function loadWorld(id) {
  const meta = readIndex().find((m) => m.id === id);
  if (!meta) return null;
  const raw = readJSON(worldKey(id));
  const data = raw && typeof raw === 'object' ? raw : {};
  const { v: _v, meta: _m, edits, ...rest } = data;
  return {
    ...rest, // any extra fields main.js chose to save
    meta: { ...meta },
    player: data.player ?? null,
    inventory: data.inventory ?? null,
    survival: data.survival ?? null,
    time: data.time ?? null,
    edits: decodeEdits(edits),
    furnaces: data.furnaces ?? null,
  };
}

/**
 * Save a world's state. `data` = { player, inventory, survival, time, edits, furnaces, meta?, ... }.
 * Returns false if storage refused it (quota), true otherwise. Also bumps the world's lastPlayed.
 */
export function saveWorld(id, data = {}) {
  if (typeof id !== 'string' || !id) return false;
  let payload;
  try {
    const { meta, edits, ...rest } = data || {};
    payload = { v: SAVE_VERSION, ...rest, edits: encodeEdits(edits) };
  } catch (err) {
    console.warn('Terrablock: could not serialise world', err);
    return false;
  }
  if (!writeJSON(worldKey(id), payload)) return false;

  const list = readIndex();
  const now = Date.now();
  const i = list.findIndex((m) => m.id === id);
  const metaIn = data && data.meta && typeof data.meta === 'object' ? data.meta : null;
  if (i >= 0) {
    const m = list[i];
    if (metaIn) {
      if (metaIn.name != null) m.name = cleanName(metaIn.name);
      if (metaIn.mode === 'creative' || metaIn.mode === 'survival') m.mode = metaIn.mode;
    }
    m.lastPlayed = now;
  } else {
    // Saved without an index entry (e.g. the index was cleared): re-register it.
    list.push(cleanMeta({ name: 'World', seed: '', mode: 'survival', created: now, ...(metaIn || {}), id, lastPlayed: now }));
  }
  writeIndex(list);
  return true;
}

export function deleteWorld(id) {
  remove(worldKey(id));
  const list = readIndex();
  const next = list.filter((m) => m.id !== id);
  if (next.length !== list.length) writeIndex(next);
}

// ---------------------------------------------------------------------------------------------
// Settings

function clampNum(v, lo, hi, def) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
}

function cleanSettings(s) {
  const src = s && typeof s === 'object' ? s : {};
  return {
    ...src, // keep settings other modules may add
    renderDistance: Math.round(clampNum(src.renderDistance, 2, MAX_RENDER_DISTANCE, DEFAULT_SETTINGS.renderDistance)),
    fov: clampNum(src.fov, 30, 110, DEFAULT_SETTINGS.fov),
    sensitivity: clampNum(src.sensitivity, 0.05, 10, DEFAULT_SETTINGS.sensitivity),
    invertY: typeof src.invertY === 'boolean' ? src.invertY : DEFAULT_SETTINGS.invertY,
    volume: clampNum(src.volume, 0, 1, DEFAULT_SETTINGS.volume),
  };
}

/** { renderDistance, fov, sensitivity, invertY, volume } with defaults for anything missing or invalid. */
export function loadSettings() {
  return cleanSettings(readJSON(SETTINGS_KEY));
}

export function saveSettings(s) {
  return writeJSON(SETTINGS_KEY, cleanSettings(s));
}

// ---------------------------------------------------------------------------------------------
// Compact edit encoding

// { "cx,cz": { index: id } } -> { "cx,cz": base64 }
export function encodeEdits(edits) {
  const out = {};
  if (!edits || typeof edits !== 'object') return out;
  for (const key of Object.keys(edits)) {
    const e = edits[key];
    if (typeof e === 'string') {
      if (e) out[key] = e; // already encoded
      continue;
    }
    if (!e || typeof e !== 'object') continue;
    const pairs = [];
    for (const k of Object.keys(e)) {
      const i = Number(k);
      const id = Number(e[k]);
      if (Number.isInteger(i) && i >= 0 && i < CHUNK_VOLUME && Number.isInteger(id) && id >= 0 && id <= 255) pairs.push(i, id);
    }
    if (!pairs.length) continue;
    // Sort pairs by index.
    const order = [];
    for (let p = 0; p < pairs.length; p += 2) order.push(p);
    order.sort((a, b) => pairs[a] - pairs[b]);
    const bytes = [];
    let prev = -1;
    for (const p of order) {
      let delta = pairs[p] - prev - 1; // >= 0 since indices are unique
      prev = pairs[p];
      while (delta >= 0x80) {
        bytes.push((delta & 0x7f) | 0x80);
        delta >>>= 7;
      }
      bytes.push(delta, pairs[p + 1]);
    }
    out[key] = bytesToBase64(bytes);
  }
  return out;
}

// Inverse of encodeEdits; also accepts the plain object form. Invalid entries are skipped.
export function decodeEdits(stored) {
  const out = {};
  if (!stored || typeof stored !== 'object') return out;
  for (const key of Object.keys(stored)) {
    if (!/^-?\d+,-?\d+$/.test(key)) continue;
    const v = stored[key];
    const e = {};
    let any = false;
    if (typeof v === 'string') {
      let bytes;
      try {
        bytes = base64ToBytes(v);
      } catch {
        continue;
      }
      let prev = -1;
      let p = 0;
      while (p < bytes.length) {
        let delta = 0;
        let shift = 0;
        let b;
        do {
          b = bytes[p++];
          delta += (b & 0x7f) * 2 ** shift;
          shift += 7;
        } while (b & 0x80 && p < bytes.length && shift < 35);
        if (p >= bytes.length) break; // truncated
        const index = prev + 1 + delta;
        const id = bytes[p++];
        prev = index;
        if (index >= CHUNK_VOLUME) break;
        e[index] = id;
        any = true;
      }
    } else if (v && typeof v === 'object') {
      for (const k of Object.keys(v)) {
        const i = Number(k);
        const id = Number(v[k]);
        if (Number.isInteger(i) && i >= 0 && i < CHUNK_VOLUME && Number.isInteger(id) && id >= 0 && id <= 255) {
          e[i] = id;
          any = true;
        }
      }
    }
    if (any) out[key] = e;
  }
  return out;
}

function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x2000) {
    bin += String.fromCharCode.apply(null, bytes.slice(i, i + 0x2000));
  }
  return btoa(bin);
}

function base64ToBytes(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
