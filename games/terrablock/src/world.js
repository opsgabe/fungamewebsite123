// Terrablock world: chunk storage, streaming through a worker pool, player edits, synchronous remeshing,
// falling sand/gravel, and the chunk meshes in the scene. Browser only (uses Worker and three.js).
//
// Streaming model
// - The "mesh set" is every chunk within renderDistance (+0.5, a disc) of the player's chunk; each of those
//   needs its 8 neighbours' data too, so the "data set" is the mesh set dilated by one chunk.
// - Work is handed out nearest-first (with a mild bias towards the view direction) to a pool of module
//   workers, at most MAX_INFLIGHT jobs per worker so priorities stay fresh as the player moves.
// - A chunk is meshed only once all 8 neighbours have data (a superset of the "4 side neighbours" rule), so
//   AO and skylight at chunk borders are right the first time. If a neighbour arrives after a chunk was
//   meshed without it (possible after unloads or edits), that chunk is remeshed.
// - Finished meshes are uploaded within a per-frame budget. Chunks beyond renderDistance+2 are unloaded
//   and their GPU geometry disposed.
// - Each mesh request carries a sequence number; stale worker results (e.g. superseded by a synchronous
//   remesh after an edit) are dropped.

import * as THREE from '../vendor/three.module.min.js';
import {
  CHUNK_SIZE,
  WORLD_HEIGHT,
  DEFAULT_RENDER_DISTANCE,
  MAX_RENDER_DISTANCE,
  CHUNK_VOLUME,
  GRAVITY,
  chunkKey,
  tileUV,
} from './config.js';
import { BLOCKS, SOLID, CROSS, faceTile } from './blocks.js';
import { generateChunk } from './worldgen.js';
import { buildChunkMesh } from './mesher.js';
import { prepareGeometry } from './chunkworker.js';

const AIR = 0;
const BEDROCK = 6;
const MIN_RENDER_DISTANCE = 2;
const INIT_RADIUS = 2; // init() resolves once the chunks within this radius are meshed

const MAX_INFLIGHT = 3; // jobs queued per worker (keeps workers busy while the main thread renders)
const UPLOADS_PER_FRAME = 4; // chunk meshes turned into GPU geometry per update(), more when backlogged
const MAX_UPLOADS_PER_FRAME = 10;
const UPLOAD_BUDGET_MS = 4;
const MAIN_THREAD_BUDGET_MS = 6; // fallback (no workers): generation/meshing time per update()
const WORKER_STARTUP_TIMEOUT_MS = 15000;

const FALL_MAX_SPEED = 40;

const LAYERS = ['opaque', 'cutout', 'water'];

// Blocks affected by gravity (sand, gravel).
const FALLS = new Uint8Array(256);
for (let id = 0; id < 256; id++) if (BLOCKS[id] && BLOCKS[id].gravity) FALLS[id] = 1;

// Numeric chunk keys (much cheaper than strings in hot paths). Valid for |cx|, |cz| < 2^20.
const KEY_OFF = 1 << 20;
const KEY_MUL = 1 << 21;
function nkey(cx, cz) {
  return (cx + KEY_OFF) * KEY_MUL + (cz + KEY_OFF);
}

// Neighbour slot for offset (dx, dz) in {-1,0,1}^2, matching the worker's chunk array layout.
function nslot(dx, dz) {
  return (dz + 1) * 3 + (dx + 1);
}
const ALL_NEIGHBOURS = 0x1ff;

// Drop CPU copies of vertex data once uploaded: chunk geometry is never read back on the CPU (collision and
// picking use block data), and this halves the memory cost of a loaded world.
function releaseArray() {
  this.array = null;
}

function makeGeometry(g, minY, maxY) {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(g.positions, 3).onUpload(releaseArray));
  geom.setAttribute('uv', new THREE.BufferAttribute(g.uvs, 2).onUpload(releaseArray));
  geom.setAttribute('color', new THREE.BufferAttribute(g.colors, 3).onUpload(releaseArray));
  geom.setIndex(new THREE.BufferAttribute(g.indices, 1).onUpload(releaseArray));
  // Bounds are known, so three.js never has to compute them from the (released) arrays.
  geom.boundingBox = new THREE.Box3(new THREE.Vector3(0, minY, 0), new THREE.Vector3(CHUNK_SIZE, maxY, CHUNK_SIZE));
  geom.boundingSphere = geom.boundingBox.getBoundingSphere(new THREE.Sphere());
  return geom;
}

class Chunk {
  constructor(cx, cz) {
    this.cx = cx;
    this.cz = cz;
    this.k = nkey(cx, cz);
    this.skey = chunkKey(cx, cz);
    this.data = null; // Uint8Array(CHUNK_VOLUME) once generated
    this.genState = 0; // 0 = not requested, 1 = requested, 2 = has data
    this.genJob = 0;
    this.genFailures = 0;
    this.meshes = { opaque: null, cutout: null, water: null };
    this.meshed = false; // has a mesh (possibly empty) reflecting some version of the data
    this.dirty = true; // mesh is missing or out of date
    this.meshJob = 0; // in-flight worker job id
    this.meshFailures = 0;
    this.meshSeq = 0; // last mesh request issued
    this.appliedSeq = 0; // last mesh applied
    this.neighbourMask = 0; // which neighbours had data when the current mesh was built
    this.box = new THREE.Box3();
    this.inRange = false; // inside the mesh disc around the player
    this.base = null; // Map(index -> generated id) for edited cells, used to drop no-op edits
    this.disposed = false;
  }
}

const _frustum = new THREE.Frustum();
const _projScreen = new THREE.Matrix4();
const _dir = new THREE.Vector3();

export class World {
  constructor({ seed, renderer, renderDistance = DEFAULT_RENDER_DISTANCE, edits = {} } = {}) {
    this.seed = seed;
    this.renderer = renderer;
    this.renderDistance = clampRenderDistance(renderDistance);
    this.edits = sanitizeEdits(edits);
    // Edit revisions for incremental saving (getEditsDelta): a counter bumped on every change to `edits`,
    // and the revision at which each chunk's edits last changed.
    this._rev = 0;
    this._editRevs = new Map(); // "cx,cz" -> revision
    this._overlayKeys = new Set(); // chunks the last delta reported with falling blocks overlaid
    for (const key of Object.keys(this.edits)) this._editRevs.set(key, ++this._rev);

    this.chunks = new Map(); // nkey -> Chunk
    this.group = new THREE.Group();
    this.group.name = 'terrain';
    renderer.scene.add(this.group);

    this._cx = null; // current centre chunk
    this._cz = null;
    this._wanted = []; // [{ cx, cz, k, mesh }] in priority order
    this._wantedDirty = true;
    this._sortDir = { x: 0, z: -1 };
    this._lastSort = 0;

    this._lc = null; // last chunk lookup cache
    this._lcx = 0;
    this._lcz = 0;

    this._meshResults = []; // worker meshes waiting for upload
    this._syncSet = new Set(); // chunks to remesh synchronously at the end of the current setBlock batch
    this._batch = 0;
    this._falling = [];
    this._fallingGeo = new Map();
    this._lastTime = performance.now();
    this._initializing = false;
    this._initWaiter = null;
    this._disposed = false;

    this._jobs = new Map();
    this._nextJob = 1;
    this._slots = [];
    this._mainThread = false;
    this._startPool();

    if (renderer.setRenderDistance) renderer.setRenderDistance(this.renderDistance);
    // The renderer outlives every world: unsubscribe in dispose() so a disposed world can be collected.
    const off = renderer.onContextRestored ? renderer.onContextRestored(() => this._onContextRestored()) : null;
    this._offContextRestored = typeof off === 'function' ? off : null;
  }

  // ===========================================================================================
  // Public API

  /** Resolves once the chunks within radius 2 of (x, z) are generated and meshed. */
  init(x, z, onProgress) {
    const cx = Math.floor(Math.floor(x) / CHUNK_SIZE);
    const cz = Math.floor(Math.floor(z) / CHUNK_SIZE);
    this._setCenter(cx, cz);

    const meshNeed = [];
    const dataNeed = new Set();
    const r2 = (INIT_RADIUS + 0.5) ** 2;
    for (let dz = -INIT_RADIUS; dz <= INIT_RADIUS; dz++) {
      for (let dx = -INIT_RADIUS; dx <= INIT_RADIUS; dx++) {
        if (dx * dx + dz * dz > r2) continue;
        meshNeed.push(nkey(cx + dx, cz + dz));
        for (let nz = -1; nz <= 1; nz++) for (let nx = -1; nx <= 1; nx++) dataNeed.add(nkey(cx + dx + nx, cz + dz + nz));
      }
    }
    const total = meshNeed.length + dataNeed.size;

    this._initializing = true;
    return new Promise((resolve) => {
      let done = false;
      let lastReported = -1;
      const finish = () => {
        done = true;
        clearInterval(timer);
        this._initializing = false;
        this._initWaiter = null;
        resolve();
      };
      const check = () => {
        if (done) return;
        if (this._disposed) return finish();
        let have = 0;
        let meshed = 0;
        for (const k of dataNeed) {
          const c = this.chunks.get(k);
          if (c && c.data) have++;
        }
        for (const k of meshNeed) {
          const c = this.chunks.get(k);
          if (c && c.meshed) meshed++;
        }
        const p = (have + meshed) / total;
        if (onProgress && p !== lastReported) {
          lastReported = p;
          try {
            onProgress(p);
          } catch (err) {
            console.error(err);
          }
        }
        if (meshed === meshNeed.length) finish();
      };
      this._initWaiter = check;
      // Workers drive progress through their messages; the timer covers the main-thread fallback and the
      // worker start-up watchdog.
      const timer = setInterval(() => {
        if (done) return;
        this._checkWatchdog();
        if (this._mainThread) this._pumpMainThread(30);
        else this._dispatch();
        check();
      }, 16);
      this._dispatch();
      check();
    });
  }

  /**
   * Stream chunks around the player, upload finished meshes, animate falling blocks, cull.
   * `dt` (optional, seconds) is the simulation step for falling blocks, so they freeze with the rest of the
   * game while it is paused (dt = 0); without it they follow the wall clock.
   */
  update(playerPos, dt) {
    if (this._disposed) return;
    const now = performance.now();
    const wall = Math.min(0.05, Math.max(0, (now - this._lastTime) / 1000));
    this._lastTime = now;
    dt = Number.isFinite(dt) ? Math.min(0.05, Math.max(0, dt)) : wall;

    if (playerPos && Number.isFinite(playerPos.x) && Number.isFinite(playerPos.z)) {
      const cx = Math.floor(Math.floor(playerPos.x) / CHUNK_SIZE);
      const cz = Math.floor(Math.floor(playerPos.z) / CHUNK_SIZE);
      if (cx !== this._cx || cz !== this._cz || this._wantedDirty) this._setCenter(cx, cz);
      else if (now - this._lastSort > 250) this._maybeResort(now);
    } else if (this._wantedDirty && this._cx !== null) {
      this._setCenter(this._cx, this._cz);
    }

    this._checkWatchdog();
    const backlog = this._meshResults.length;
    this._applyMeshResults(Math.min(MAX_UPLOADS_PER_FRAME, UPLOADS_PER_FRAME + Math.floor(backlog / 6)), UPLOAD_BUDGET_MS);
    if (this._mainThread) this._pumpMainThread(MAIN_THREAD_BUDGET_MS);
    else this._dispatch();
    this._updateFalling(dt);
    this._cull();
  }

  /** Block id at a world position: 0 above the world, BEDROCK below it, -1 if the chunk is not loaded. */
  getBlock(x, y, z) {
    y = Math.floor(y);
    if (y >= WORLD_HEIGHT) return AIR;
    if (y < 0) return BEDROCK;
    x = Math.floor(x);
    z = Math.floor(z);
    const c = this._chunkAt(x >> 4, z >> 4);
    if (!c || !c.data) return -1;
    return c.data[(x & 15) + ((z & 15) << 4) + (y << 8)];
  }

  /**
   * True when the block at (x, y, z) differs from the generated terrain (the player placed, dug out or
   * changed it). False for untouched or unloaded cells.
   */
  isEdited(x, y, z) {
    y = Math.floor(y);
    if (y < 0 || y >= WORLD_HEIGHT) return false;
    x = Math.floor(x);
    z = Math.floor(z);
    const e = this.edits[chunkKey(x >> 4, z >> 4)];
    return !!e && ((x & 15) + ((z & 15) << 4) + (y << 8)) in e;
  }

  /** Solid for collision; unloaded chunks count as solid. */
  isSolid(x, y, z) {
    const id = this.getBlock(x, y, z);
    return id < 0 || SOLID[id] === 1;
  }

  /** y of the topmost solid block in the column, -1 if none or not loaded. */
  highestBlockAt(x, z) {
    x = Math.floor(x);
    z = Math.floor(z);
    const c = this._chunkAt(x >> 4, z >> 4);
    if (!c || !c.data) return -1;
    const d = c.data;
    const col = (x & 15) + ((z & 15) << 4);
    for (let y = WORLD_HEIGHT - 1; y >= 0; y--) if (SOLID[d[col + (y << 8)]] === 1) return y;
    return -1;
  }

  /**
   * Set a block. Records the edit and remeshes the chunk (and touching border neighbours) synchronously, so
   * the change is visible in the very next render. Sand/gravel left unsupported start falling.
   * Returns false when the position is outside the world or its chunk is not loaded.
   */
  setBlock(x, y, z, id) {
    if (this._disposed) return false;
    x = Math.floor(x);
    y = Math.floor(y);
    z = Math.floor(z);
    id = id | 0;
    if (y < 0 || y >= WORLD_HEIGHT || id < 0 || id > 255) return false;
    const c = this._chunkAt(x >> 4, z >> 4);
    if (!c || !c.data) return false;
    const lx = x & 15;
    const lz = z & 15;
    const idx = lx + (lz << 4) + (y << 8);
    if (c.data[idx] === id) return true;

    this._batch++;
    try {
      this._write(c, idx, id);
      this._queueRemesh(c, lx, lz);
      // A cell that can no longer support a block lets the gravity block above it fall, and the flower,
      // tall grass or dead bush growing on it pop off (Interaction hands out the plant's drop)...
      if (SOLID[id] !== 1 && y + 1 < WORLD_HEIGHT) {
        const above = c.data[idx + 256];
        if (FALLS[above]) this._startFalling(x, y + 1, z, above);
        else if (CROSS[above]) this.setBlock(x, y + 1, z, AIR);
      }
      // ...and a gravity block placed over a non-solid cell falls straight away.
      if (FALLS[id] && y > 0 && SOLID[c.data[idx - 256]] !== 1 && c.data[idx] === id) this._startFalling(x, y, z, id);
    } finally {
      if (--this._batch === 0) this._flushRemesh();
    }
    return true;
  }

  setRenderDistance(n) {
    const rd = clampRenderDistance(n);
    if (this.renderer.setRenderDistance) this.renderer.setRenderDistance(rd);
    if (rd === this.renderDistance) return;
    this.renderDistance = rd;
    this._wantedDirty = true;
    if (this._cx !== null) this._setCenter(this._cx, this._cz);
  }

  /**
   * Edits as { "cx,cz": { index: id } } (a copy). Blocks that are still falling are reported at the cell they
   * will land in, so a save taken mid-fall never loses them (the animation itself carries on).
   */
  getEdits() {
    const out = {};
    for (const key in this.edits) {
      const e = this.edits[key];
      if (isEmpty(e)) continue;
      out[key] = { ...e };
    }
    for (const f of this._falling) {
      const cell = this._fallingRestCell(f);
      if (cell === null) continue;
      const key = chunkKey(f.x >> 4, f.z >> 4);
      (out[key] || (out[key] = {}))[cell] = f.id;
    }
    return out;
  }

  // Chunk-local index of the cell a falling block will come to rest in, or null if unknown.
  _fallingRestCell(f) {
    const land = this._landingY(f.x, Math.floor(f.y), f.z);
    if (land === null) return null;
    let y = land;
    while (y < WORLD_HEIGHT && this.isSolid(f.x, y, f.z)) y++;
    if (y >= WORLD_HEIGHT) return null;
    return (f.x & 15) + ((f.z & 15) << 4) + (y << 8);
  }

  /** Current edit revision (see getEditsDelta). */
  get editRevision() {
    return this._rev;
  }

  /**
   * Edits changed since revision `since` (the `rev` of an earlier call; 0 = all of them), for incremental
   * saving: -> { rev, changed: { "cx,cz": { index: id } (a copy) | null (the chunk has no edits left) } }.
   * Falling blocks are overlaid at their landing cells like getEdits(); those chunks are reported again by
   * the next call, by which time the block has landed (or vanished).
   */
  getEditsDelta(since = 0) {
    const changed = {};
    const add = (key) => {
      const e = this.edits[key];
      changed[key] = e && !isEmpty(e) ? { ...e } : null;
    };
    for (const [key, rev] of this._editRevs) if (rev > since) add(key);
    for (const key of this._overlayKeys) if (!(key in changed)) add(key);
    this._overlayKeys.clear();
    for (const f of this._falling) {
      const cell = this._fallingRestCell(f);
      if (cell === null) continue;
      const key = chunkKey(f.x >> 4, f.z >> 4);
      if (!(key in changed)) add(key);
      (changed[key] || (changed[key] = {}))[cell] = f.id;
      this._overlayKeys.add(key);
    }
    return { rev: this._rev, changed };
  }

  stats() {
    let loaded = 0;
    let meshed = 0;
    for (const c of this.chunks.values()) {
      if (c.data) loaded++;
      if (c.meshed) meshed++;
    }
    let pending = 0;
    for (const w of this._wanted) {
      const c = this.chunks.get(w.k);
      if (!c || !c.data || (w.mesh && (!c.meshed || c.dirty || c.meshJob))) pending++;
    }
    return { loaded, meshed, pending };
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this._offContextRestored) this._offContextRestored();
    this._offContextRestored = null;
    for (const s of this._slots) s.worker.terminate();
    this._slots = [];
    this._jobs.clear();
    for (const c of this.chunks.values()) this._dropMeshes(c);
    this.chunks.clear();
    for (const f of this._falling) this.group.remove(f.mesh);
    this._falling = [];
    for (const g of this._fallingGeo.values()) g.dispose();
    this._fallingGeo.clear();
    this._meshResults = [];
    this._wanted = [];
    if (this.group.parent) this.group.parent.remove(this.group);
    this._lc = null;
  }

  // ===========================================================================================
  // Chunk lookup and edits

  _chunkAt(cx, cz) {
    const lc = this._lc;
    if (lc !== null && cx === this._lcx && cz === this._lcz && !lc.disposed) return lc;
    const c = this.chunks.get(nkey(cx, cz));
    if (c) {
      this._lc = c;
      this._lcx = cx;
      this._lcz = cz;
    }
    return c;
  }

  // Write one cell and keep the edit list minimal: an edit that restores the generated block is removed.
  _write(c, idx, id) {
    let e = this.edits[c.skey];
    if (!c.base) c.base = new Map();
    if (!(e && idx in e) && !c.base.has(idx)) c.base.set(idx, c.data[idx]);
    c.data[idx] = id;
    if (c.base.get(idx) === id) {
      if (e) {
        delete e[idx];
        if (isEmpty(e)) delete this.edits[c.skey];
      }
    } else {
      if (!e) e = this.edits[c.skey] = {};
      e[idx] = id;
    }
    this._editRevs.set(c.skey, ++this._rev);
  }

  // Generated data arrived: overlay saved edits, then let neighbours that were meshed without it remesh.
  _acceptData(c, data) {
    const e = this.edits[c.skey];
    if (e) {
      c.base = new Map();
      let left = 0;
      for (const k in e) {
        const i = +k;
        const v = e[k];
        if (data[i] === v) {
          delete e[k]; // redundant edit (matches the generated block)
          this._editRevs.set(c.skey, ++this._rev);
        } else {
          c.base.set(i, data[i]);
          data[i] = v;
          left++;
        }
      }
      if (left === 0) delete this.edits[c.skey];
    }
    c.data = data;
    c.genState = 2;
    c.genJob = 0;
    c.dirty = true;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue;
        const n = this.chunks.get(nkey(c.cx + dx, c.cz + dz));
        if (n && (n.meshed || n.meshJob) && !(n.neighbourMask & (1 << nslot(-dx, -dz)))) n.dirty = true;
      }
    }
  }

  // Mark the edited chunk, plus the neighbours sharing the edited cell's border, for a synchronous remesh.
  _queueRemesh(c, lx, lz) {
    this._syncSet.add(c);
    const ox = lx === 0 ? -1 : lx === 15 ? 1 : 0;
    const oz = lz === 0 ? -1 : lz === 15 ? 1 : 0;
    if (ox) this._queueNeighbour(c.cx + ox, c.cz);
    if (oz) this._queueNeighbour(c.cx, c.cz + oz);
    if (ox && oz) this._queueNeighbour(c.cx + ox, c.cz + oz); // AO/skylight reach diagonally at corners
  }

  _queueNeighbour(cx, cz) {
    const n = this.chunks.get(nkey(cx, cz));
    if (n && n.data) this._syncSet.add(n);
  }

  _flushRemesh() {
    if (!this._syncSet.size) return;
    const list = [...this._syncSet];
    this._syncSet.clear();
    for (const c of list) {
      if (c.disposed || !c.data) continue;
      // Visible chunks are rebuilt now; ones without a mesh yet just get (re)queued for the workers.
      if (c.meshed) this._meshSync(c);
      else c.dirty = true;
    }
  }

  // ===========================================================================================
  // Streaming

  _setCenter(cx, cz) {
    const prevCx = this._cx;
    const prevCz = this._cz;
    this._cx = cx;
    this._cz = cz;
    this._wantedDirty = false;

    const rd = this.renderDistance;
    const r2 = (rd + 0.5) * (rd + 0.5);
    const entries = new Map();
    for (let dz = -rd; dz <= rd; dz++) {
      for (let dx = -rd; dx <= rd; dx++) {
        if (dx * dx + dz * dz > r2) continue;
        const k = nkey(cx + dx, cz + dz);
        entries.set(k, { cx: cx + dx, cz: cz + dz, k, mesh: true, d2: dx * dx + dz * dz, score: 0 });
      }
    }
    // Data-only ring: neighbours of meshable chunks.
    for (const e of [...entries.values()]) {
      for (let nz = -1; nz <= 1; nz++) {
        for (let nx = -1; nx <= 1; nx++) {
          const k = nkey(e.cx + nx, e.cz + nz);
          if (entries.has(k)) continue;
          const dx = e.cx + nx - cx;
          const dz = e.cz + nz - cz;
          entries.set(k, { cx: e.cx + nx, cz: e.cz + nz, k, mesh: false, d2: dx * dx + dz * dz, score: 0 });
        }
      }
    }
    this._wanted = [...entries.values()];
    this._sortWanted(performance.now());

    // Unload beyond renderDistance + 2 (also measured from the previous centre after a one-chunk step, so
    // walking back and forth over a chunk border doesn't thrash the outer ring). Meshes of chunks that left
    // the visible disc by more than a chunk are freed early to bound GPU memory.
    const lim2 = (rd + 2) * (rd + 2);
    const meshKeep2 = (rd + 1.5) * (rd + 1.5);
    const stepped = prevCx !== null && Math.abs(prevCx - cx) <= 1 && Math.abs(prevCz - cz) <= 1;
    for (const c of [...this.chunks.values()]) {
      const dx = c.cx - cx;
      const dz = c.cz - cz;
      const d2 = dx * dx + dz * dz;
      c.inRange = d2 <= r2;
      if (d2 > lim2) {
        const px = c.cx - prevCx;
        const pz = c.cz - prevCz;
        if (!stepped || px * px + pz * pz > lim2) {
          this._unload(c);
          continue;
        }
      }
      if (c.meshed && d2 > meshKeep2) this._dropMeshes(c);
    }
    this._lc = null;
  }

  // Priority: squared distance, stretched by up to 45% for chunks behind the camera (beyond the first ring).
  _sortWanted(now) {
    const cam = this.renderer.camera;
    let fx = 0;
    let fz = 0;
    if (cam) {
      cam.getWorldDirection(_dir);
      const len = Math.hypot(_dir.x, _dir.z);
      if (len > 1e-3) {
        fx = _dir.x / len;
        fz = _dir.z / len;
      }
    }
    this._sortDir.x = fx;
    this._sortDir.z = fz;
    this._lastSort = now;
    const cx = this._cx;
    const cz = this._cz;
    for (const w of this._wanted) {
      let s = w.d2;
      if (w.d2 > 2 && (fx || fz)) {
        const d = Math.sqrt(w.d2);
        const dot = ((w.cx - cx) * fx + (w.cz - cz) * fz) / d;
        s *= 1 + 0.45 * (1 - dot) * 0.5;
      }
      w.score = s;
    }
    this._wanted.sort((a, b) => a.score - b.score);
  }

  _maybeResort(now) {
    const cam = this.renderer.camera;
    if (!cam || !this._wanted.length) return;
    cam.getWorldDirection(_dir);
    const len = Math.hypot(_dir.x, _dir.z);
    if (len < 1e-3) return;
    const dot = (_dir.x * this._sortDir.x + _dir.z * this._sortDir.z) / len;
    if (dot < 0.87) this._sortWanted(now); // turned by more than ~30 degrees
    else this._lastSort = now;
  }

  _getOrCreate(w) {
    let c = this.chunks.get(w.k);
    if (!c) {
      c = new Chunk(w.cx, w.cz);
      c.inRange = w.mesh;
      this.chunks.set(w.k, c);
    }
    return c;
  }

  _neighboursReady(c) {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue;
        const n = this.chunks.get(nkey(c.cx + dx, c.cz + dz));
        if (!n || !n.data) return false;
      }
    }
    return true;
  }

  _unload(c) {
    this._dropMeshes(c);
    c.disposed = true;
    c.data = null;
    c.base = null;
    this.chunks.delete(c.k);
    if (this._lc === c) this._lc = null;
  }

  _dropMeshes(c) {
    for (const layer of LAYERS) {
      const m = c.meshes[layer];
      if (!m) continue;
      this.group.remove(m);
      m.geometry.dispose();
      c.meshes[layer] = null;
    }
    if (c.meshed) {
      c.meshed = false;
      c.dirty = true;
    }
  }

  // ===========================================================================================
  // Worker pool

  _startPool() {
    let n = 2;
    try {
      n = (navigator.hardwareConcurrency || 2) - 1;
    } catch {
      // ignore
    }
    n = Math.max(1, Math.min(4, n));
    for (let i = 0; i < n; i++) {
      let worker;
      try {
        worker = new Worker(new URL('./chunkworker.js', import.meta.url), { type: 'module' });
      } catch (err) {
        console.warn('Terrablock: chunk workers unavailable, generating on the main thread.', err);
        break;
      }
      const slot = { worker, inflight: 0, alive: true, ready: false };
      worker.onmessage = (e) => this._onMessage(slot, e.data);
      worker.onerror = (e) => this._onWorkerError(slot, e);
      worker.onmessageerror = () => {};
      this._slots.push(slot);
    }
    this._poolStarted = performance.now();
    if (!this._slots.length) this._mainThread = true;
  }

  _pickSlot() {
    let best = null;
    for (const s of this._slots) {
      if (!s.alive || s.inflight >= MAX_INFLIGHT) continue;
      if (!best || s.inflight < best.inflight) best = s;
    }
    return best;
  }

  _dispatch() {
    if (this._disposed || this._mainThread) return;
    let slot = this._pickSlot();
    if (!slot) return;
    const wanted = this._wanted;
    for (let i = 0; i < wanted.length && slot; i++) {
      const w = wanted[i];
      const c = this._getOrCreate(w);
      if (c.genState === 0) {
        this._sendGenerate(slot, c);
        slot = this._pickSlot();
      } else if (w.mesh && c.data && c.dirty && !c.meshJob && this._neighboursReady(c)) {
        this._sendMesh(slot, c);
        slot = this._pickSlot();
      }
    }
  }

  _sendGenerate(slot, c) {
    const id = this._nextJob++;
    c.genState = 1;
    c.genJob = id;
    slot.inflight++;
    this._jobs.set(id, { type: 'generate', k: c.k, slot });
    slot.worker.postMessage({ type: 'generate', id, cx: c.cx, cz: c.cz, seed: this.seed });
  }

  _sendMesh(slot, c) {
    const id = this._nextJob++;
    const chunks = new Array(9);
    let mask = 0;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const n = dx || dz ? this.chunks.get(nkey(c.cx + dx, c.cz + dz)) : c;
        const s = nslot(dx, dz);
        if (n && n.data) {
          chunks[s] = n.data; // structured clone copies it; the main thread keeps its own
          mask |= 1 << s;
        } else chunks[s] = null;
      }
    }
    c.dirty = false;
    c.meshJob = id;
    const seq = ++c.meshSeq;
    slot.inflight++;
    this._jobs.set(id, { type: 'mesh', k: c.k, slot, seq, mask });
    slot.worker.postMessage({ type: 'mesh', id, cx: c.cx, cz: c.cz, chunks });
  }

  _onMessage(slot, msg) {
    if (this._disposed || !msg) return;
    if (msg.type === 'ready') {
      slot.ready = true;
      return;
    }
    const job = this._jobs.get(msg.id);
    if (!job) return;
    this._jobs.delete(msg.id);
    slot.inflight = Math.max(0, slot.inflight - 1);
    slot.ready = true;
    const c = this.chunks.get(job.k);

    if (msg.type === 'generated') {
      if (c && c.genJob === msg.id) this._acceptData(c, msg.data);
    } else if (msg.type === 'meshed') {
      if (c && c.meshJob === msg.id) {
        c.meshJob = 0;
        this._meshResults.push({ c, seq: job.seq, mask: job.mask, geo: msg.geo, minY: msg.minY, maxY: msg.maxY });
        if (this._initializing) this._applyMeshResults(Infinity, Infinity);
      }
    } else if (msg.type === 'error') {
      console.warn(`Terrablock: chunk ${job.type} failed for ${msg.cx},${msg.cz}:`, msg.message);
      if (c) this._jobFailed(c, job);
    }
    if (this._initWaiter) this._initWaiter();
    this._dispatch();
  }

  // A job failed inside a worker: retry once there, then do it on the main thread (which logs and gives up
  // gracefully if it fails again) so one bad chunk can never stall streaming.
  _jobFailed(c, job) {
    if (job.type === 'generate' && c.genState === 1) {
      c.genJob = 0;
      c.genState = 0;
      if (++c.genFailures >= 2) this._generateSync(c);
    } else if (job.type === 'mesh') {
      c.meshJob = 0;
      c.dirty = true;
      if (++c.meshFailures >= 2) this._meshSync(c);
    }
  }

  _onWorkerError(slot, e) {
    if (e && e.preventDefault) e.preventDefault();
    if (!slot.alive) return;
    console.warn('Terrablock: chunk worker failed', (e && e.message) || e);
    slot.alive = false;
    try {
      slot.worker.terminate();
    } catch {
      // ignore
    }
    this._requeueJobsOf(slot);
    if (!this._slots.some((s) => s.alive)) this._mainThread = true;
    else this._dispatch();
  }

  _requeueJobsOf(slot) {
    for (const [id, job] of this._jobs) {
      if (job.slot !== slot) continue;
      this._jobs.delete(id);
      const c = this.chunks.get(job.k);
      if (!c) continue;
      if (job.type === 'generate' && c.genJob === id) {
        c.genJob = 0;
        c.genState = 0;
      } else if (job.type === 'mesh' && c.meshJob === id) {
        c.meshJob = 0;
        c.dirty = true;
      }
    }
    slot.inflight = 0;
  }

  // If no worker ever answers (blocked module workers, broken environments), fall back to the main thread.
  _checkWatchdog() {
    if (this._mainThread || this._slots.some((s) => s.ready)) return;
    if (performance.now() - this._poolStarted < WORKER_STARTUP_TIMEOUT_MS) return;
    console.warn('Terrablock: chunk workers did not start; generating on the main thread.');
    for (const s of this._slots) {
      s.alive = false;
      try {
        s.worker.terminate();
      } catch {
        // ignore
      }
      this._requeueJobsOf(s);
    }
    this._mainThread = true;
  }

  // Main-thread fallback: same priority order, bounded by a time budget.
  _pumpMainThread(budgetMs) {
    const t0 = performance.now();
    for (const w of this._wanted) {
      if (performance.now() - t0 > budgetMs) break;
      const c = this._getOrCreate(w);
      if (!c.data) this._generateSync(c);
      else if (w.mesh && c.dirty && this._neighboursReady(c)) this._meshSync(c);
    }
    if (this._initWaiter) this._initWaiter();
  }

  _generateSync(c) {
    let data;
    try {
      data = generateChunk(c.cx, c.cz, this.seed);
    } catch (err) {
      console.error(`Terrablock: generating chunk ${c.skey} failed`, err);
      data = new Uint8Array(CHUNK_VOLUME);
      for (let i = 0; i < 256; i++) data[i] = BEDROCK; // keep the world floor so nothing falls out
    }
    this._acceptData(c, data);
  }

  // ===========================================================================================
  // Meshing

  _meshSync(c) {
    let mask = 0;
    const getChunk = (dx, dz) => {
      const n = dx || dz ? this.chunks.get(nkey(c.cx + dx, c.cz + dz)) : c;
      return n && n.data ? n.data : null;
    };
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (getChunk(dx, dz)) mask |= 1 << nslot(dx, dz);
    const seq = ++c.meshSeq;
    c.dirty = false;
    let prep;
    try {
      prep = prepareGeometry(buildChunkMesh(c.cx, c.cz, getChunk));
    } catch (err) {
      console.error(`Terrablock: meshing chunk ${c.skey} failed`, err);
      prep = { geo: { opaque: null, cutout: null, water: null }, minY: 0, maxY: 0 };
    }
    this._applyGeometry(c, prep.geo, prep.minY, prep.maxY, seq, mask);
  }

  _applyMeshResults(maxCount, budgetMs) {
    const q = this._meshResults;
    if (!q.length) return;
    const t0 = performance.now();
    let n = 0;
    let i = 0;
    for (; i < q.length && n < maxCount; i++) {
      const r = q[i];
      if (r.c.disposed || r.seq <= r.c.appliedSeq) continue; // stale
      if (!r.c.inRange) {
        r.c.dirty = true; // left the visible disc meanwhile: rebuild if it comes back
        continue;
      }
      this._applyGeometry(r.c, r.geo, r.minY, r.maxY, r.seq, r.mask);
      n++;
      if (performance.now() - t0 > budgetMs) {
        i++;
        break;
      }
    }
    q.splice(0, i);
  }

  _applyGeometry(c, geo, minY, maxY, seq, mask) {
    c.appliedSeq = seq;
    c.neighbourMask = mask;
    c.meshed = true;
    const ox = c.cx * CHUNK_SIZE;
    const oz = c.cz * CHUNK_SIZE;
    for (const layer of LAYERS) {
      const g = geo[layer];
      let mesh = c.meshes[layer];
      if (!g) {
        if (mesh) {
          this.group.remove(mesh);
          mesh.geometry.dispose();
          c.meshes[layer] = null;
        }
        continue;
      }
      const geom = makeGeometry(g, minY, maxY);
      if (mesh) {
        mesh.geometry.dispose();
        mesh.geometry = geom;
      } else {
        mesh = new THREE.Mesh(geom, this.renderer.materials[layer]);
        mesh.name = `chunk ${c.skey} ${layer}`;
        mesh.position.set(ox, 0, oz);
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        mesh.frustumCulled = false; // culled per chunk in _cull()
        this.group.add(mesh);
        c.meshes[layer] = mesh;
      }
    }
    c.box.min.set(ox, minY, oz);
    c.box.max.set(ox + CHUNK_SIZE, Math.max(maxY, minY + 1e-3), oz + CHUNK_SIZE);
    this._setChunkVisible(c, c.inRange);
  }

  _cull() {
    const cam = this.renderer.camera;
    if (!cam) return;
    cam.updateMatrixWorld();
    _projScreen.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_projScreen);
    for (const c of this.chunks.values()) {
      if (!c.meshed) continue;
      this._setChunkVisible(c, c.inRange && _frustum.intersectsBox(c.box));
    }
  }

  _setChunkVisible(c, v) {
    const m = c.meshes;
    if (m.opaque) m.opaque.visible = v;
    if (m.cutout) m.cutout.visible = v;
    if (m.water) m.water.visible = v;
  }

  _onContextRestored() {
    if (this._disposed) return;
    // GPU buffers are gone and the CPU copies were released after upload: rebuild every mesh. Results still
    // queued for upload have their arrays and stay valid.
    for (const c of this.chunks.values()) {
      this._dropMeshes(c);
      if (c.data) c.dirty = true;
    }
    for (const g of this._fallingGeo.values()) g.dispose();
    this._fallingGeo.clear();
    for (const f of this._falling) f.mesh.geometry = this._fallingGeometry(f.id);
  }

  // ===========================================================================================
  // Falling blocks (sand, gravel)

  _startFalling(x, y, z, id) {
    const mesh = new THREE.Mesh(this._fallingGeometry(id), this.renderer.materials.opaque);
    mesh.position.set(x, y, z);
    mesh.frustumCulled = false;
    this.group.add(mesh);
    this._falling.push({ x, y, z, vy: 0, id, mesh });
    this.setBlock(x, y, z, AIR); // may recursively release the block above as well
  }

  _updateFalling(dt) {
    if (!this._falling.length) return;
    this._batch++;
    try {
      for (let i = this._falling.length - 1; i >= 0; i--) {
        const f = this._falling[i];
        const prevY = f.y;
        f.vy = Math.max(f.vy - GRAVITY * dt, -FALL_MAX_SPEED);
        f.y += f.vy * dt;
        const land = this._landingY(f.x, Math.floor(prevY), f.z);
        if (land === null) {
          this._removeFalling(i); // chunk unloaded underneath: nothing to land on
        } else if (f.y <= land) {
          this._removeFalling(i);
          this._place(f.x, land, f.z, f.id);
        } else {
          f.mesh.position.y = f.y;
        }
      }
    } finally {
      if (--this._batch === 0) this._flushRemesh();
    }
  }

  // y where a block falling through cell `fromY` comes to rest: on top of the first solid block at or below.
  _landingY(x, fromY, z) {
    let y = Math.min(fromY, WORLD_HEIGHT - 1);
    for (; y >= 0; y--) {
      const id = this.getBlock(x, y, z);
      if (id < 0) return null;
      if (SOLID[id] === 1) break;
    }
    return y + 1;
  }

  // Put a landed block down, moving up past anything solid that was built into its path meanwhile.
  _place(x, y, z, id) {
    while (y < WORLD_HEIGHT && this.isSolid(x, y, z)) y++;
    if (y < WORLD_HEIGHT) this.setBlock(x, y, z, id);
  }

  _removeFalling(i) {
    const f = this._falling[i];
    this.group.remove(f.mesh);
    this._falling.splice(i, 1);
  }

  // Unit cube (0..1) textured like the block, with the mesher's face shading.
  _fallingGeometry(id) {
    let g = this._fallingGeo.get(id);
    if (g) return g;
    // [dir, shade, 4 corners BL, BR, TR, TL as seen from outside]
    const faces = [
      [0, 0.8, [1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]],
      [1, 0.8, [0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]],
      [2, 1.0, [0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]],
      [3, 0.5, [0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]],
      [4, 0.65, [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]],
      [5, 0.65, [1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]],
    ];
    const pos = new Float32Array(24 * 3);
    const uv = new Float32Array(24 * 2);
    const col = new Float32Array(24 * 3);
    const idx = new Uint16Array(36);
    faces.forEach(([dir, shade, ...corners], f) => {
      const t = tileUV(faceTile(id, dir));
      const uvs = [t.u0, t.v0, t.u1, t.v0, t.u1, t.v1, t.u0, t.v1];
      corners.forEach((p, j) => {
        const v = f * 4 + j;
        pos.set(p, v * 3);
        uv[v * 2] = uvs[j * 2];
        uv[v * 2 + 1] = uvs[j * 2 + 1];
        col[v * 3] = col[v * 3 + 1] = col[v * 3 + 2] = shade;
      });
      idx.set([f * 4, f * 4 + 1, f * 4 + 2, f * 4, f * 4 + 2, f * 4 + 3], f * 6);
    });
    // Same sRGB -> linear treatment as chunk meshes.
    const prep = prepareGeometry({ opaque: { positions: pos, uvs: uv, colors: col, indices: idx } });
    const o = prep.geo.opaque;
    g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(o.positions, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(o.uvs, 2));
    g.setAttribute('color', new THREE.BufferAttribute(o.colors, 3));
    g.setIndex(new THREE.BufferAttribute(o.indices, 1));
    this._fallingGeo.set(id, g);
    return g;
  }
}

function isEmpty(obj) {
  for (const _ in obj) return false;
  return true;
}

function clampRenderDistance(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return DEFAULT_RENDER_DISTANCE;
  return Math.max(MIN_RENDER_DISTANCE, Math.min(MAX_RENDER_DISTANCE, v));
}

// Copy and validate { "cx,cz": { index: id } }.
function sanitizeEdits(edits) {
  const out = {};
  if (!edits || typeof edits !== 'object') return out;
  for (const key of Object.keys(edits)) {
    if (!/^-?\d+,-?\d+$/.test(key)) continue;
    const e = edits[key];
    if (!e || typeof e !== 'object') continue;
    const copy = {};
    let any = false;
    for (const k of Object.keys(e)) {
      const i = Number(k);
      const id = Number(e[k]);
      if (!Number.isInteger(i) || i < 0 || i >= CHUNK_VOLUME) continue;
      if (!Number.isInteger(id) || id < 0 || id > 255) continue;
      copy[i] = id;
      any = true;
    }
    if (any) out[key] = copy;
  }
  return out;
}
