// Terrablock chunk mesher: turns one chunk's block ids (plus a one-block border taken from its eight
// neighbours) into three typed-array geometries: opaque, cutout (leaves, glass, plants, cactus) and water.
//
// Pure and DOM-free so it runs inside module Workers, on the main thread for instant remeshes after
// edits, and in Node tests. All scratch memory (the padded block volume and the growable output
// buffers) is allocated once per module instance and reused; the only allocations per call are the
// final right-sized output arrays, which the caller owns (and a worker can transfer).
//
// Lighting model (see ARCHITECTURE.md):
//   vertex grey = faceShade x AO x skyLight
//   faceShade: top 1.0, bottom 0.5, +/-x 0.8, +/-z 0.65
//   AO: classic 3-sample voxel AO (side1, side2, corner) -> [0.55, 0.7, 0.85, 1.0]
//   skyLight: a cell above its column's topmost opaque block is 1.0, otherwise 0.3; a vertex averages
//             the (non-opaque) cells touching it on the face's open side.

import { getBlock, B } from './blocks.js';
import { CHUNK_SIZE, CHUNK_AREA, WORLD_HEIGHT, ATLAS_COLS, ATLAS_ROWS, tileUV } from './config.js';

// ---------------------------------------------------------------------------------------------
// Per-block lookup tables (built once from the registry).

const LAYER_OPAQUE = 0;
const LAYER_CUTOUT = 1;
const LAYER_WATER = 2;

const K_NONE = 0; // not rendered (air, unknown ids, renderLayer 'none')
const K_CUBE = 1; // full cube, standard culling
const K_CROSS = 2; // two diagonal quads
const K_CACTUS = 3; // cube with sides inset 1/16, sides always drawn
const K_LIQUID = 4; // cube in the water layer with a lowered surface

const OPAQUE = new Uint8Array(256);
const KIND = new Uint8Array(256);
const LAYER = new Uint8Array(256);
// Atlas tile per block per face direction. Direction order (shared with blocks.faceTile):
// 0 = +x, 1 = -x, 2 = +y (top), 3 = -y (bottom), 4 = +z (front), 5 = -z.
const TILES = new Uint16Array(256 * 6);

for (let id = 0; id < 256; id++) {
  const def = getBlock(id); // unknown ids resolve to AIR
  OPAQUE[id] = def.opaque ? 1 : 0;
  const layer = def.renderLayer;
  const shape = def.shape;
  if (id === 0 || layer === 'none' || shape === 'none' || !def.textures) {
    KIND[id] = K_NONE;
    continue;
  }
  if (shape === 'cross') {
    KIND[id] = K_CROSS;
    LAYER[id] = layer === 'water' ? LAYER_WATER : layer === 'opaque' ? LAYER_OPAQUE : LAYER_CUTOUT;
  } else if (layer === 'water') {
    KIND[id] = K_LIQUID;
    LAYER[id] = LAYER_WATER;
  } else {
    KIND[id] = id === B.CACTUS ? K_CACTUS : K_CUBE;
    LAYER[id] = layer === 'cutout' ? LAYER_CUTOUT : LAYER_OPAQUE;
  }
  const t = def.textures;
  const side = t.side ?? t.top ?? 0;
  const top = t.top ?? side;
  const bottom = t.bottom ?? top;
  const front = t.front ?? side;
  const o = id * 6;
  TILES[o] = side;
  TILES[o + 1] = side;
  TILES[o + 2] = top;
  TILES[o + 3] = bottom;
  TILES[o + 4] = front;
  TILES[o + 5] = side;
}

// UV rectangle (u0, u1, v0, v1) per atlas tile, precomputed from config.tileUV.
const TILE_COUNT = ATLAS_COLS * ATLAS_ROWS;
const UVT = new Float32Array(TILE_COUNT * 4);
for (let t = 0; t < TILE_COUNT; t++) {
  const r = tileUV(t);
  UVT[t * 4] = r.u0;
  UVT[t * 4 + 1] = r.u1;
  UVT[t * 4 + 2] = r.v0;
  UVT[t * 4 + 3] = r.v1;
}

// ---------------------------------------------------------------------------------------------
// Padded working volume: the chunk plus a 1-cell border on x/z (from neighbour chunks) and y
// (y = -1 is treated as bedrock, y = WORLD_HEIGHT as air). Index = (x+1) + (z+1)*PX + (y+1)*PAREA.

const PX = CHUNK_SIZE + 2;
const PAREA = PX * PX;
const PY = WORLD_HEIGHT + 2;
const vol = new Uint8Array(PAREA * PY);
// Per-cell flags: bit0 = opaque, bit1 = sky-lit (above its column's topmost opaque block).
const flags = new Uint8Array(PAREA * PY);

const F_OPAQUE = 1;
const F_LIT = 2;
const LIGHT_LIT = 1.0;
const LIGHT_DARK = 0.3;
// Light of a non-opaque cell indexed by its flags value (bit1 set -> lit).
const LIGHT_OF = new Float32Array([LIGHT_DARK, LIGHT_DARK, LIGHT_LIT, LIGHT_LIT]);

const AO_CURVE = new Float32Array([0.55, 0.7, 0.85, 1.0]);
const FACE_SHADE = new Float32Array([0.8, 0.8, 1.0, 0.5, 0.65, 0.65]);

const WATER_SURFACE = 0.875; // height of a water block's surface when no water is above it
const CACTUS_INSET = 1 / 16;

// ---------------------------------------------------------------------------------------------
// Face geometry. Each face lists its 4 corners as unit-cube offsets in the order bottom-left,
// bottom-right, top-right, top-left as seen from outside, i.e. counter-clockwise (three.js front
// face). UVs are always (u0,v0) (u1,v0) (u1,v1) (u0,v1) in that order, so side textures are upright
// (v1 at the top edge). Top face: texture "up" points to -z; bottom face: texture "up" points to +z.

const FACE_POS = new Float32Array([
  /* 0 +x */ 1, 0, 1, 1, 0, 0, 1, 1, 0, 1, 1, 1,
  /* 1 -x */ 0, 0, 0, 0, 0, 1, 0, 1, 1, 0, 1, 0,
  /* 2 +y */ 0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 1, 0,
  /* 3 -y */ 0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1,
  /* 4 +z */ 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1,
  /* 5 -z */ 1, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 0,
]);
const FACE_NORMAL = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];
const AXIS_STRIDE = [1, PAREA, PX]; // padded-index step along x, y, z

// Padded-index offset of the face's open-side neighbour.
const NOFF = new Int32Array(6);
// For each face and vertex: offsets of [side1, side2, corner] cells (relative to the block) in the
// layer on the open side of the face. These drive both AO and the smooth skylight average.
const AO_OFF = new Int32Array(6 * 4 * 3);

for (let dir = 0; dir < 6; dir++) {
  const n = FACE_NORMAL[dir];
  const nAxis = n[0] !== 0 ? 0 : n[1] !== 0 ? 1 : 2;
  const open = n[0] * AXIS_STRIDE[0] + n[1] * AXIS_STRIDE[1] + n[2] * AXIS_STRIDE[2];
  NOFF[dir] = open;
  const tangents = [0, 1, 2].filter((a) => a !== nAxis);
  for (let v = 0; v < 4; v++) {
    const p = dir * 12 + v * 3;
    // A vertex at coordinate 1 along a tangent axis touches the +1 neighbour, at 0 the -1 one.
    const a = (FACE_POS[p + tangents[0]] ? 1 : -1) * AXIS_STRIDE[tangents[0]];
    const b = (FACE_POS[p + tangents[1]] ? 1 : -1) * AXIS_STRIDE[tangents[1]];
    const o = (dir * 4 + v) * 3;
    AO_OFF[o] = open + a;
    AO_OFF[o + 1] = open + b;
    AO_OFF[o + 2] = open + a + b;
  }
}

// ---------------------------------------------------------------------------------------------
// Growable output buffers, one set per layer, reused across calls.

function makeLayer(quads) {
  return {
    quadCap: quads,
    pos: new Float32Array(quads * 12),
    uv: new Float32Array(quads * 8),
    col: new Float32Array(quads * 12),
    idx: new Uint32Array(quads * 6),
    quads: 0,
  };
}

function growLayer(L) {
  const cap = L.quadCap * 2;
  const pos = new Float32Array(cap * 12);
  pos.set(L.pos);
  const uv = new Float32Array(cap * 8);
  uv.set(L.uv);
  const col = new Float32Array(cap * 12);
  col.set(L.col);
  const idx = new Uint32Array(cap * 6);
  idx.set(L.idx);
  L.pos = pos;
  L.uv = uv;
  L.col = col;
  L.idx = idx;
  L.quadCap = cap;
}

const layers = [makeLayer(8192), makeLayer(2048), makeLayer(1024)];

function finishLayer(L) {
  const q = L.quads;
  return {
    positions: L.pos.slice(0, q * 12),
    uvs: L.uv.slice(0, q * 8),
    colors: L.col.slice(0, q * 12),
    indices: L.idx.slice(0, q * 6),
  };
}

// Writes 6 indices for quad `q` (vertices base..base+3 in BL, BR, TR, TL order). The diagonal is
// chosen from the final vertex brightness so interpolation never smears a corner's darkness along
// the wrong diagonal (the AO anisotropy fix): split along the diagonal whose endpoints differ least;
// on a tie, along the brighter diagonal, which keeps dark corners local.
function writeIndices(idx, q, b0, b1, b2, b3) {
  const base = q * 4;
  const o = q * 6;
  const d02 = b0 > b2 ? b0 - b2 : b2 - b0;
  const d13 = b1 > b3 ? b1 - b3 : b3 - b1;
  if (d13 < d02 || (d13 === d02 && b1 + b3 > b0 + b2)) {
    // diagonal 1-3
    idx[o] = base + 1;
    idx[o + 1] = base + 2;
    idx[o + 2] = base + 3;
    idx[o + 3] = base + 1;
    idx[o + 4] = base + 3;
    idx[o + 5] = base;
  } else {
    // diagonal 0-2
    idx[o] = base;
    idx[o + 1] = base + 1;
    idx[o + 2] = base + 2;
    idx[o + 3] = base;
    idx[o + 4] = base + 2;
    idx[o + 5] = base + 3;
  }
}

// Emits one cube face. (x, y, z) is the block's chunk-local position. `topH` lowers the top edge
// (water surface), `inset` pulls side faces towards the block centre (cactus).
function pushFace(L, x, y, z, dir, tile, b0, b1, b2, b3, topH, inset) {
  if (L.quads >= L.quadCap) growLayer(L);
  const q = L.quads++;
  const pos = L.pos;
  const uv = L.uv;
  const col = L.col;
  const fp = dir * 12;
  let p = q * 12;

  for (let v = 0; v < 4; v++) {
    const k = fp + v * 3;
    let fx = FACE_POS[k];
    let fy = FACE_POS[k + 1];
    let fz = FACE_POS[k + 2];
    if (fy === 1) fy = topH;
    if (inset !== 0) {
      if (dir < 2) fx = fx === 1 ? 1 - inset : inset;
      else if (dir > 3) fz = fz === 1 ? 1 - inset : inset;
    }
    pos[p] = x + fx;
    pos[p + 1] = y + fy;
    pos[p + 2] = z + fz;
    p += 3;
  }

  const t = tile * 4;
  const u0 = UVT[t];
  const u1 = UVT[t + 1];
  const v0 = UVT[t + 2];
  let v1 = UVT[t + 3];
  // A shortened side face shows the top part of its tile cropped, not squashed.
  if (topH !== 1 && dir !== 2 && dir !== 3) v1 = v0 + (v1 - v0) * topH;
  const u = q * 8;
  uv[u] = u0;
  uv[u + 1] = v0;
  uv[u + 2] = u1;
  uv[u + 3] = v0;
  uv[u + 4] = u1;
  uv[u + 5] = v1;
  uv[u + 6] = u0;
  uv[u + 7] = v1;

  const c = q * 12;
  col[c] = col[c + 1] = col[c + 2] = b0;
  col[c + 3] = col[c + 4] = col[c + 5] = b1;
  col[c + 6] = col[c + 7] = col[c + 8] = b2;
  col[c + 9] = col[c + 10] = col[c + 11] = b3;

  writeIndices(L.idx, q, b0, b1, b2, b3);
}

// Emits a cross plant: two vertical quads along the block's diagonals, uniformly lit. The cutout
// material renders them double-sided.
function pushCross(L, x, y, z, tile, b) {
  const t = tile * 4;
  const u0 = UVT[t];
  const u1 = UVT[t + 1];
  const v0 = UVT[t + 2];
  const v1 = UVT[t + 3];
  for (let d = 0; d < 2; d++) {
    if (L.quads >= L.quadCap) growLayer(L);
    const q = L.quads++;
    const pos = L.pos;
    const p = q * 12;
    // d = 0: from (0,0) to (1,1) in xz; d = 1: from (1,0) to (0,1).
    const xa = d === 0 ? x : x + 1;
    const xb = d === 0 ? x + 1 : x;
    const za = z;
    const zb = z + 1;
    pos[p] = xa;
    pos[p + 1] = y;
    pos[p + 2] = za;
    pos[p + 3] = xb;
    pos[p + 4] = y;
    pos[p + 5] = zb;
    pos[p + 6] = xb;
    pos[p + 7] = y + 1;
    pos[p + 8] = zb;
    pos[p + 9] = xa;
    pos[p + 10] = y + 1;
    pos[p + 11] = za;
    const uv = L.uv;
    const u = q * 8;
    uv[u] = u0;
    uv[u + 1] = v0;
    uv[u + 2] = u1;
    uv[u + 3] = v0;
    uv[u + 4] = u1;
    uv[u + 5] = v1;
    uv[u + 6] = u0;
    uv[u + 7] = v1;
    L.col.fill(b, q * 12, q * 12 + 12);
    const idx = L.idx;
    const o = q * 6;
    const base = q * 4;
    idx[o] = base;
    idx[o + 1] = base + 1;
    idx[o + 2] = base + 2;
    idx[o + 3] = base;
    idx[o + 4] = base + 2;
    idx[o + 5] = base + 3;
  }
}

// AO x skylight for one face vertex. `i` is the block's padded index, `n` its open-side neighbour
// offset and `k` the vertex's entry in AO_OFF.
function vertexLight(i, n, k) {
  const f1 = flags[i + AO_OFF[k]];
  const f2 = flags[i + AO_OFF[k + 1]];
  const fc = flags[i + AO_OFF[k + 2]];
  const fo = flags[i + n];
  const o1 = f1 & F_OPAQUE;
  const o2 = f2 & F_OPAQUE;
  const oc = fc & F_OPAQUE;
  const bothSides = o1 & o2;
  const ao = bothSides ? 0 : 3 - (o1 + o2 + oc);

  // Smooth skylight: average the open-side cells around the vertex, skipping opaque cells (their
  // darkening is AO's job) and the corner when both sides block it from view.
  let sum = 0;
  let cnt = 0;
  if (!(fo & F_OPAQUE)) {
    sum += LIGHT_OF[fo];
    cnt++;
  }
  if (!o1) {
    sum += LIGHT_OF[f1];
    cnt++;
  }
  if (!o2) {
    sum += LIGHT_OF[f2];
    cnt++;
  }
  if (!oc && !bothSides) {
    sum += LIGHT_OF[fc];
    cnt++;
  }
  // Only possible for an inset cactus side pressed against opaque blocks: use the block's own cell.
  const light = cnt ? sum / cnt : LIGHT_OF[flags[i] & F_LIT];
  return AO_CURVE[ao] * light;
}

// ---------------------------------------------------------------------------------------------
// Volume fill.

// Copies a full-height column of a neighbour chunk (local lx, lz) into padded column (px, pz);
// a null chunk fills it with air.
function copyColumn(src, lx, lz, px, pz) {
  let d = px + pz * PX + PAREA; // padded y = 0
  if (!src) {
    for (let y = 0; y < WORLD_HEIGHT; y++, d += PAREA) vol[d] = 0;
    return;
  }
  let s = lx + lz * CHUNK_SIZE;
  for (let y = 0; y < WORLD_HEIGHT; y++, s += CHUNK_AREA, d += PAREA) vol[d] = src[s];
}

// Fills `vol` from the 3x3 chunk neighbourhood and returns the highest y holding a non-air block
// in the centre chunk (-1 when empty).
function fillVolume(getChunk) {
  const c = getChunk(0, 0);
  const last = CHUNK_SIZE - 1;
  let maxY = -1;

  // Centre chunk.
  for (let y = 0; y < WORLD_HEIGHT; y++) {
    const sy = y * CHUNK_AREA;
    const dy = (y + 1) * PAREA + 1;
    let any = 0;
    for (let z = 0; z < CHUNK_SIZE; z++) {
      let s = sy + z * CHUNK_SIZE;
      let d = dy + (z + 1) * PX;
      for (let x = 0; x < CHUNK_SIZE; x++, s++, d++) {
        const id = c[s];
        vol[d] = id;
        any |= id;
      }
    }
    if (any) maxY = y;
  }

  // Side neighbours: one column strip each.
  const nx = getChunk(-1, 0);
  const px = getChunk(1, 0);
  const nz = getChunk(0, -1);
  const pz = getChunk(0, 1);
  for (let i = 0; i < CHUNK_SIZE; i++) {
    copyColumn(nx, last, i, 0, i + 1);
    copyColumn(px, 0, i, PX - 1, i + 1);
    copyColumn(nz, i, last, i + 1, 0);
    copyColumn(pz, i, 0, i + 1, PX - 1);
  }
  // Diagonal neighbours: one corner column each (AO and light at the chunk's corners).
  copyColumn(getChunk(-1, -1), last, last, 0, 0);
  copyColumn(getChunk(1, -1), 0, last, PX - 1, 0);
  copyColumn(getChunk(-1, 1), last, 0, 0, PX - 1);
  copyColumn(getChunk(1, 1), 0, 0, PX - 1, PX - 1);

  // Below the world: bedrock (never shows a face); above: air.
  vol.fill(B.BEDROCK, 0, PAREA);
  vol.fill(0, (PY - 1) * PAREA, PY * PAREA);

  // Flags: opaque bit and the per-column heightmap skylight bit, scanning each column downwards.
  for (let col = 0; col < PAREA; col++) {
    let lit = F_LIT;
    for (let i = col + (PY - 1) * PAREA; i >= 0; i -= PAREA) {
      const op = OPAQUE[vol[i]];
      if (op) lit = 0;
      flags[i] = op | lit;
    }
  }
  return maxY;
}

// ---------------------------------------------------------------------------------------------

function emptyGeo() {
  return {
    positions: new Float32Array(0),
    uvs: new Float32Array(0),
    colors: new Float32Array(0),
    indices: new Uint32Array(0),
  };
}

/**
 * Builds the render geometry of chunk (cx, cz).
 * @param {number} cx chunk x (unused by the geometry, which is chunk-local)
 * @param {number} cz chunk z
 * @param {(dx:number, dz:number) => (Uint8Array|null)} getChunk neighbourhood accessor, dx/dz in
 *   {-1, 0, 1}; null is treated as air
 * @returns {{opaque: Geo, cutout: Geo, water: Geo}} Geo = { positions, uvs, colors, indices } with
 *   chunk-local xyz positions, rgb grey vertex colours and Uint32 triangle indices
 */
export function buildChunkMesh(cx, cz, getChunk) {
  if (!getChunk(0, 0)) return { opaque: emptyGeo(), cutout: emptyGeo(), water: emptyGeo() };

  const maxY = fillVolume(getChunk);
  for (let l = 0; l < 3; l++) layers[l].quads = 0;

  for (let y = 0; y <= maxY; y++) {
    for (let z = 0; z < CHUNK_SIZE; z++) {
      let i = 1 + (z + 1) * PX + (y + 1) * PAREA;
      for (let x = 0; x < CHUNK_SIZE; x++, i++) {
        const id = vol[i];
        if (id === 0) continue;
        const kind = KIND[id];
        if (kind === K_NONE) continue;
        const L = layers[LAYER[id]];
        const tiles = id * 6;

        if (kind === K_CROSS) {
          pushCross(L, x, y, z, TILES[tiles + 2], LIGHT_OF[flags[i] & F_LIT]);
          continue;
        }

        // Water is full height under more water (or under an opaque block, so no gap shows at the
        // sides); otherwise its surface sits at WATER_SURFACE.
        let topH = 1;
        if (kind === K_LIQUID) {
          const above = vol[i + PAREA];
          if (above !== id && !OPAQUE[above]) topH = WATER_SURFACE;
        }
        const inset = kind === K_CACTUS ? CACTUS_INSET : 0;

        for (let dir = 0; dir < 6; dir++) {
          const n = NOFF[dir];
          const nid = vol[i + n];
          // Cull against opaque neighbours and against the same block (glass-glass, water-water,
          // leaves-leaves). Inset cactus sides are always drawn since a gap remains visible.
          if ((OPAQUE[nid] || nid === id) && !(inset !== 0 && dir !== 2 && dir !== 3)) continue;

          const shade = FACE_SHADE[dir];
          const k = dir * 12;
          const b0 = shade * vertexLight(i, n, k);
          const b1 = shade * vertexLight(i, n, k + 3);
          const b2 = shade * vertexLight(i, n, k + 6);
          const b3 = shade * vertexLight(i, n, k + 9);
          pushFace(L, x, y, z, dir, TILES[tiles + dir], b0, b1, b2, b3, topH, inset);
        }
      }
    }
  }

  return {
    opaque: finishLayer(layers[LAYER_OPAQUE]),
    cutout: finishLayer(layers[LAYER_CUTOUT]),
    water: finishLayer(layers[LAYER_WATER]),
  };
}
