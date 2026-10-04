// Terrablock procedural texture atlas, crack overlay tiles and inventory icons.
//
// Everything is painted pixel-by-pixel into plain RGBA buffers from a seeded PRNG, so the atlas is
// identical on every load and the generator itself runs without a DOM (handy for Node tests).
// Only createAtlas() / drawItemIcon() / getItemIconCanvas() touch canvases.
//
// Layout (see config.js / ARCHITECTURE.md): 256x256 px, 16x16 tiles of 16 px.
//   0..175   block faces (indices from TILE in blocks.js)
//   176..185 crack overlay stages 0..9
//   192..255 item icons, itemTile(id) = 192 + (id - 256)

import { BLOCKS, TILE, getBlock } from './blocks.js';
import { TILE_SIZE, ATLAS_COLS, ATLAS_ROWS } from './config.js';

const N = TILE_SIZE; // 16
const ATLAS_W = ATLAS_COLS * N; // 256
const ATLAS_H = ATLAS_ROWS * N; // 256

export const CRACK_TILES = Object.freeze([176, 177, 178, 179, 180, 181, 182, 183, 184, 185]);
export const ITEM_TILE_BASE = 192;

export function itemTile(id) {
  return ITEM_TILE_BASE + (id - 256);
}

// ---------------------------------------------------------------------------------------------
// Deterministic randomness.

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ATLAS_SEED = 0x7e3a91c5;
// Each tile gets its own stream so editing one painter never changes another tile.
function rngFor(key) {
  return mulberry32((Math.imul(key + 101, 0x9e3779b1) ^ ATLAS_SEED) >>> 0);
}

// ---------------------------------------------------------------------------------------------
// Colours: [r, g, b, a] arrays (0..255).

function hex(s, a = 255) {
  const n = parseInt(s.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a];
}
const pal = (...xs) => xs.map((x) => hex(x));
const CLEAR = [0, 0, 0, 0];

function scale(c, f) {
  return [c[0] * f, c[1] * f, c[2] * f, c[3]];
}
function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];
}
function withAlpha(c, a) {
  return [c[0], c[1], c[2], a];
}
// Pick a ramp entry for v in [0, 1].
function pick(ramp, v) {
  const i = Math.floor(v * ramp.length);
  return ramp[i < 0 ? 0 : i >= ramp.length ? ramp.length - 1 : i];
}
function clampi(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// ---------------------------------------------------------------------------------------------
// A 16x16 RGBA tile.

class Tile {
  constructor() {
    this.px = new Uint8ClampedArray(N * N * 4);
  }
  // Wrapping write (keeps patterns seamless across block borders).
  set(x, y, c) {
    const i = (((y & 15) << 4) | (x & 15)) << 2;
    const p = this.px;
    p[i] = c[0];
    p[i + 1] = c[1];
    p[i + 2] = c[2];
    p[i + 3] = c[3] === undefined ? 255 : c[3];
  }
  // Clipped write (for sprites that must not wrap).
  put(x, y, c) {
    if (x >= 0 && y >= 0 && x < N && y < N) this.set(x, y, c);
  }
  get(x, y) {
    const i = (((y & 15) << 4) | (x & 15)) << 2;
    const p = this.px;
    return [p[i], p[i + 1], p[i + 2], p[i + 3]];
  }
  alpha(x, y) {
    if (x < 0 || y < 0 || x >= N || y >= N) return 0;
    return this.px[(((y << 4) | x) << 2) + 3];
  }
  fill(fn) {
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const c = fn(x, y);
      if (c) this.set(x, y, c);
    }
  }
  tint(x, y, f) {
    this.set(x, y, scale(this.get(x, y), f));
  }
  clone() {
    const t = new Tile();
    t.px.set(this.px);
    return t;
  }
}

// ---------------------------------------------------------------------------------------------
// Tileable noise. Lattice sizes must divide 16 so every layer wraps seamlessly.

function smooth(t) {
  return t * t * (3 - 2 * t);
}

function valueLayer(rng, cx, cy) {
  const nx = N / cx;
  const ny = N / cy;
  const lat = new Float32Array(nx * ny);
  for (let i = 0; i < lat.length; i++) lat[i] = rng();
  const out = new Float32Array(N * N);
  for (let y = 0; y < N; y++) {
    const gy = y / cy;
    const y0 = Math.floor(gy);
    const ty = smooth(gy - y0);
    const y1 = (y0 + 1) % ny;
    for (let x = 0; x < N; x++) {
      const gx = x / cx;
      const x0 = Math.floor(gx);
      const tx = smooth(gx - x0);
      const x1 = (x0 + 1) % nx;
      const a = lat[y0 * nx + x0];
      const b = lat[y0 * nx + x1];
      const c = lat[y1 * nx + x0];
      const d = lat[y1 * nx + x1];
      out[y * N + x] = (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
    }
  }
  return out;
}

// layers: [[cellX, cellY, weight], ...] -> Float32Array(256) normalised to 0..1.
function noise(rng, layers) {
  const out = new Float32Array(N * N);
  for (const [cx, cy, w] of layers) {
    const l = valueLayer(rng, cx, cy);
    for (let i = 0; i < out.length; i++) out[i] += l[i] * w;
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of out) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const k = hi > lo ? 1 / (hi - lo) : 0;
  for (let i = 0; i < out.length; i++) out[i] = (out[i] - lo) * k;
  return out;
}

// Value below which `frac` of the samples fall.
function percentile(arr, frac) {
  const s = Array.from(arr).sort((a, b) => a - b);
  return s[clampi(Math.floor(frac * s.length), 0, s.length - 1)];
}

// Wrapped Voronoi cells from well-spread random points (best-candidate sampling).
function voronoi(rng, count) {
  const pts = [];
  const wrapD2 = (ax, ay, bx, by) => {
    let dx = Math.abs(ax - bx);
    let dy = Math.abs(ay - by);
    if (dx > N / 2) dx = N - dx;
    if (dy > N / 2) dy = N - dy;
    return dx * dx + dy * dy;
  };
  for (let i = 0; i < count; i++) {
    let best = null;
    let bestD = -1;
    for (let c = 0; c < 10; c++) {
      const x = rng() * N;
      const y = rng() * N;
      let d = Infinity;
      for (const p of pts) d = Math.min(d, wrapD2(x, y, p[0], p[1]));
      if (d > bestD) {
        bestD = d;
        best = [x, y];
      }
    }
    pts.push(best);
  }
  const id = new Int16Array(N * N);
  const dx = new Float32Array(N * N); // pixel offset from its cell point (wrapped)
  const dy = new Float32Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let bi = 0;
    let bd = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const d = wrapD2(x + 0.5, y + 0.5, pts[i][0], pts[i][1]);
      if (d < bd) {
        bd = d;
        bi = i;
      }
    }
    const k = y * N + x;
    id[k] = bi;
    let ox = x + 0.5 - pts[bi][0];
    let oy = y + 0.5 - pts[bi][1];
    if (ox > N / 2) ox -= N;
    if (ox < -N / 2) ox += N;
    if (oy > N / 2) oy -= N;
    if (oy < -N / 2) oy += N;
    dx[k] = ox;
    dy[k] = oy;
  }
  // 1-px gaps on the bottom/right side of each cell read as shadowed cracks between stones.
  const edge = new Uint8Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const k = y * N + x;
    if (id[k] !== id[y * N + ((x + 1) & 15)] || id[k] !== id[((y + 1) & 15) * N + x]) edge[k] = 1;
  }
  return { count: pts.length, id, dx, dy, edge };
}

function line(x0, y0, x1, y1, fn) {
  // Bresenham; fn(x, y, i)
  let dx = Math.abs(x1 - x0);
  let dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let i = 0;
  for (;;) {
    fn(x0, y0, i++);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
}

// Paint a character template. Letters map to colours, '.' is transparent.
function stamp(t, rows, colors, ox = 0, oy = 0) {
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y];
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      if (ch === '.' || ch === ' ') continue;
      const c = colors[ch];
      if (c) t.put(x + ox, y + oy, c);
    }
  }
}

// 1-px dark outline around opaque pixels (4-neighbourhood) for sprite-like tiles and icons.
function outline(t, darkness = 0.62, color = null) {
  const src = t.clone();
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    if (src.alpha(x, y) !== 0) continue;
    let nb = null;
    if (src.alpha(x - 1, y)) nb = src.get(x - 1, y);
    else if (src.alpha(x + 1, y)) nb = src.get(x + 1, y);
    else if (src.alpha(x, y - 1)) nb = src.get(x, y - 1);
    else if (src.alpha(x, y + 1)) nb = src.get(x, y + 1);
    if (nb) t.set(x, y, color || withAlpha(mix(nb, [8, 6, 10, 255], darkness), 255));
  }
}

// ---------------------------------------------------------------------------------------------
// Palettes.

const STONE_RAMP = pal('#5c5c60', '#69696d', '#76767a', '#838387', '#909094', '#9e9ea2');
const DIRT_RAMP = pal('#563a25', '#64442c', '#724f33', '#805a3b', '#8e6644', '#9b724e');
const GRASS_RAMP = pal('#356b1f', '#3f7a25', '#4a882c', '#559633', '#61a33b', '#6eb044', '#7dbd4f');
const SAND_RAMP = pal('#cbb67f', '#d4c08a', '#dcca94', '#e4d39e', '#ebdca9', '#f2e5b5');
const SANDSTONE_RAMP = pal('#b59b64', '#c1a86f', '#ccb47b', '#d6bf86', '#dfc991', '#e7d39d');
const SNOW_RAMP = pal('#c7d3e1', '#d7e1ec', '#e3eaf2', '#edf2f7', '#f6f9fc', '#ffffff');
const ICE_RAMP = pal('#76a6e0', '#83b1e8', '#90bcee', '#9ec7f3', '#aed2f7', '#c2dffb');
const WATER_RAMP = pal('#1d479b', '#2350a8', '#295ab3', '#3064bd', '#3a6fc6', '#4a7ecf');
const PLANK_RAMP = pal('#7a5730', '#886338', '#957040', '#a27c48', '#ae8851', '#bb955c');
const PLANK_SEAM = hex('#563d20');
const OAK_BARK = pal('#36260f', '#423017', '#4e3a1e', '#5a4425', '#674e2c', '#755935');
const OAK_RINGS = pal('#8a663a', '#9a7443', '#aa834e', '#b89058', '#c49c63');
const BIRCH_BARK = pal('#c4beb0', '#d1ccbf', '#ddd8cc', '#e8e4da', '#f2efe8', '#fbf9f5');
const BIRCH_RINGS = pal('#bfa77a', '#cbb487', '#d6c093', '#e0cb9f', '#e9d6ab');
const SPRUCE_BARK = pal('#21160c', '#2b1d11', '#352516', '#402d1c', '#4b3622', '#573f29');
const SPRUCE_RINGS = pal('#664829', '#735331', '#815e39', '#8e6942', '#9a744b');
const OAK_LEAF = pal('#1b4f15', '#225e1a', '#2a6d20', '#337c26', '#3d8b2d', '#489a35', '#56a93f');
const BIRCH_LEAF = pal('#3e6721', '#4a7728', '#57872f', '#659737', '#74a740', '#85b64c', '#97c45a');
const SPRUCE_LEAF = pal('#11301f', '#163a26', '#1c452e', '#235136', '#2b5e3f', '#336b48', '#3d7852');
const CACTUS_RAMP = pal('#14431a', '#1b5321', '#226328', '#2a7430', '#338539', '#3f9744', '#4fa852');
const CLAY_RAMP = pal('#878ea0', '#9098a9', '#99a1b2', '#a2aabb', '#abb3c3', '#b5bccb');
const BEDROCK_RAMP = pal('#121214', '#232325', '#353538', '#4a4a4d', '#606064', '#7a7a7e');
const OBSIDIAN_RAMP = pal('#0c0813', '#120c1c', '#191026', '#211631', '#2b1d3f', '#3a2953');
const BRICK_COLORS = pal('#8c3a2b', '#9a4231', '#a64a37', '#93402f', '#a0472f');
const MORTAR_RAMP = pal('#9d9282', '#aba090', '#b8ae9f', '#c4bbac');
const PUMPKIN_RAMP = pal('#97490b', '#ad580f', '#c26814', '#d4781c', '#e18927', '#eb9b36');
const MELON_RAMP = pal('#355f14', '#3f6e19', '#4a7d1f', '#568c25', '#639b2d', '#72aa37');

// ---------------------------------------------------------------------------------------------
// Block tile painters. paint(tile, fn) registers fn(t, rng); `painted(tile)` returns the
// finished (memoised) tile so variants can start from a shared base.

const PAINTERS = new Map();
const paintedCache = new Map();

function paint(tile, fn) {
  PAINTERS.set(tile, fn);
}

function painted(key) {
  let t = paintedCache.get(key);
  if (!t) {
    t = new Tile();
    const fn = PAINTERS.get(key);
    if (fn) fn(t, rngFor(key));
    paintedCache.set(key, t);
  }
  return t;
}

// --- Stone family ---------------------------------------------------------------------------

paint(TILE.STONE, (t, r) => {
  const n = noise(r, [[8, 8, 0.35], [4, 4, 0.35], [2, 2, 0.15], [1, 1, 0.15]]);
  t.fill((x, y) => pick(STONE_RAMP, 0.08 + n[y * N + x] * 0.84));
  // Short engraved fissures: dark groove with a lit lower lip.
  for (let k = 0; k < 6; k++) {
    let x = (r() * N) | 0;
    let y = (r() * N) | 0;
    const len = 2 + ((r() * 3) | 0);
    const sx = r() < 0.5 ? 1 : -1;
    const slope = r() < 0.55 ? 0 : 1;
    for (let i = 0; i < len; i++) {
      t.set(x, y, STONE_RAMP[0]);
      t.set(x, y + 1, STONE_RAMP[4]);
      x += sx;
      if (slope && i % 2 === 1) y += 1;
    }
  }
  // Scattered single-pixel grit.
  for (let k = 0; k < 10; k++) t.set((r() * N) | 0, (r() * N) | 0, r() < 0.5 ? STONE_RAMP[1] : STONE_RAMP[5]);
});

// Stones packed together with dark gaps; each stone lit from the top-left.
function paintCobbleLike(t, r, count, ramp, gapA, gapB, colorFor) {
  const v = voronoi(r, count);
  const n = noise(r, [[4, 4, 0.5], [1, 1, 0.5]]);
  const base = [];
  for (let i = 0; i < v.count; i++) base.push(colorFor ? colorFor(i, r) : 1.4 + r() * 1.8);
  t.fill((x, y) => {
    const k = y * N + x;
    if (v.edge[k]) return n[k] < 0.5 ? gapA : gapB;
    const light = -(v.dx[k] + v.dy[k]) * 0.32; // toward top-left of the stone is brighter
    if (Array.isArray(base[v.id[k]])) {
      const c = base[v.id[k]];
      return scale(c, clampi(1 + light * 0.08 + (n[k] - 0.5) * 0.14, 0.7, 1.25));
    }
    const idx = clampi(Math.round(base[v.id[k]] + light + (n[k] - 0.5) * 1.1), 0, ramp.length - 1);
    return ramp[idx];
  });
  // Shade stone pixels that sit just above/left of a gap (the gap's shadow side).
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const k = y * N + x;
    if (v.edge[k]) continue;
    if (v.edge[y * N + ((x - 1) & 15)] || v.edge[((y - 1) & 15) * N + x]) t.tint(x, y, 1.1);
  }
}

paint(TILE.COBBLESTONE, (t, r) => {
  paintCobbleLike(t, r, 11, STONE_RAMP, hex('#3a3a3e'), hex('#444448'));
});

paint(TILE.MOSSY_COBBLESTONE, (t, r) => {
  const base = painted(TILE.COBBLESTONE);
  t.px.set(base.px);
  const moss = pal('#33561f', '#3e6626', '#4a772d', '#578735', '#66973e');
  const n = noise(r, [[8, 8, 0.45], [4, 4, 0.35], [1, 1, 0.2]]);
  const cut = percentile(n, 0.55);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const v = n[y * N + x];
    if (v > cut) {
      const m = (v - cut) / (1 - cut);
      const old = t.get(x, y);
      const lum = (old[0] + old[1] + old[2]) / 3 / 160; // keep the stone's shading under the moss
      t.set(x, y, scale(pick(moss, 0.2 + m * 0.8), clampi(0.75 + lum * 0.35, 0.7, 1.15)));
    }
  }
  for (let k = 0; k < 8; k++) t.set((r() * N) | 0, (r() * N) | 0, moss[4]);
});

paint(TILE.STONE_BRICKS, (t, r) => {
  const ramp = pal('#5f5e60', '#6c6b6d', '#79787a', '#868587', '#939294', '#a1a0a2');
  const n = noise(r, [[4, 4, 0.4], [2, 2, 0.3], [1, 1, 0.3]]);
  t.fill((x, y) => {
    const ly = y & 7;
    const course = y >> 3;
    const jx = course === 0 ? x & 7 : (x + 4) & 7; // joint position inside the brick row
    if (ly === 7 || jx === 7) return hex('#3d3c3f');
    let idx = 2 + Math.round((n[y * N + x] - 0.5) * 1.6);
    if (ly === 0 || jx === 0) idx += 2; // lit top/left bevel
    else if (ly === 6 || jx === 6) idx -= 1; // shadowed bottom/right bevel
    return ramp[clampi(idx, 0, 5)];
  });
  // A couple of hairline cracks.
  for (let k = 0; k < 2; k++) {
    let x = 1 + ((r() * 13) | 0);
    let y = (r() < 0.5 ? 1 : 9) + ((r() * 3) | 0);
    for (let i = 0; i < 3; i++) {
      t.set(x, y, ramp[0]);
      x += r() < 0.5 ? 1 : 0;
      y += 1;
    }
  }
});

paint(TILE.BRICKS, (t, r) => {
  const n = noise(r, [[4, 4, 0.4], [1, 1, 0.6]]);
  const brickColor = [];
  for (let i = 0; i < 8; i++) brickColor.push(BRICK_COLORS[(r() * BRICK_COLORS.length) | 0]);
  t.fill((x, y) => {
    const course = y >> 2;
    const ly = y & 3;
    const off = (course & 1) * 4;
    const lx = (x + off) & 7;
    const v = n[y * N + x];
    if (ly === 3 || lx === 7) return pick(MORTAR_RAMP, v);
    const id = course * 2 + (((x + off) >> 3) & 1);
    let f = 0.92 + v * 0.16;
    if (ly === 0) f += 0.1; // lit top edge
    if (lx === 0) f += 0.05;
    if (ly === 2) f -= 0.08;
    return scale(brickColor[id], f);
  });
  // Pitting.
  for (let k = 0; k < 9; k++) {
    const x = (r() * N) | 0;
    const y = (r() * N) | 0;
    if ((y & 3) !== 3 && ((x + ((y >> 2) & 1) * 4) & 7) !== 7) t.tint(x, y, 0.78);
  }
});

paint(TILE.BEDROCK, (t, r) => {
  const n = noise(r, [[4, 4, 0.45], [2, 2, 0.35], [1, 1, 0.2]]);
  t.fill((x, y) => pick(BEDROCK_RAMP, n[y * N + x]));
  for (let k = 0; k < 6; k++) t.set((r() * N) | 0, (r() * N) | 0, BEDROCK_RAMP[5]);
});

paint(TILE.OBSIDIAN, (t, r) => {
  const n = noise(r, [[8, 8, 0.3], [4, 4, 0.35], [2, 2, 0.2], [1, 1, 0.15]]);
  t.fill((x, y) => pick(OBSIDIAN_RAMP.slice(0, 5), n[y * N + x]));
  // Glassy glints: short diagonal streaks.
  for (let k = 0; k < 5; k++) {
    let x = (r() * N) | 0;
    let y = (r() * N) | 0;
    const len = 1 + ((r() * 3) | 0);
    for (let i = 0; i < len; i++) {
      t.set(x, y, i === 0 ? hex('#7a63b0') : OBSIDIAN_RAMP[5]);
      x++;
      y--;
    }
  }
});

// --- Ores ------------------------------------------------------------------------------------

const ORE_SHAPES = [
  [[0, 0], [1, 0], [0, 1], [1, 1]],
  [[1, 0], [0, 1], [1, 1], [2, 1], [1, 2]],
  [[0, 0], [1, 0], [2, 0], [1, 1]],
  [[0, 0], [1, 0], [1, 1], [2, 1]],
  [[0, 1], [1, 0], [1, 1], [2, 0]],
  [[0, 0], [1, 0], [1, 1]],
  [[0, 0], [0, 1], [1, 1], [1, 2]],
  [[1, 0], [0, 1], [1, 1], [2, 1]],
];

// colors: [dark, mid, light, highlight]
function paintOre(t, r, colors, clusters) {
  t.px.set(painted(TILE.STONE).px);
  const used = new Uint8Array(N * N);
  let placed = 0;
  for (let attempt = 0; attempt < 200 && placed < clusters; attempt++) {
    const shape = ORE_SHAPES[(r() * ORE_SHAPES.length) | 0];
    const ox = 1 + ((r() * 12) | 0);
    const oy = 1 + ((r() * 12) | 0);
    let ok = true;
    for (const [sx, sy] of shape) {
      for (let dy = -1; dy <= 1 && ok; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (used[(oy + sy + dy) * N + ox + sx + dx]) {
          ok = false;
          break;
        }
      }
    }
    if (!ok) continue;
    placed++;
    let minS = Infinity;
    let maxS = -Infinity;
    for (const [sx, sy] of shape) {
      minS = Math.min(minS, sx + sy);
      maxS = Math.max(maxS, sx + sy);
    }
    for (const [sx, sy] of shape) used[(oy + sy) * N + ox + sx] = 1;
    for (const [sx, sy] of shape) {
      const s = sx + sy;
      const c = s === minS ? colors[3] : s === maxS ? colors[0] : r() < 0.6 ? colors[1] : colors[2];
      t.set(ox + sx, oy + sy, c);
    }
    // Drop shadow on the stone below-right of the nugget.
    for (const [sx, sy] of shape) {
      const x = ox + sx + 1;
      const y = oy + sy + 1;
      if (!used[y * N + x]) t.tint(x, y, 0.72);
    }
  }
}

paint(TILE.COAL_ORE, (t, r) => paintOre(t, r, pal('#0f0f10', '#1f1f21', '#303033', '#4c4c50'), 6));
paint(TILE.IRON_ORE, (t, r) => paintOre(t, r, pal('#8a5a3c', '#c08762', '#dcab86', '#f3d2b4'), 5));
paint(TILE.GOLD_ORE, (t, r) => paintOre(t, r, pal('#9c740c', '#e3b81f', '#f6d754', '#fff3a6'), 5));
paint(TILE.DIAMOND_ORE, (t, r) => paintOre(t, r, pal('#10716d', '#27c9be', '#78eee4', '#dafffb'), 4));

// --- Soil family -----------------------------------------------------------------------------

paint(TILE.DIRT, (t, r) => {
  const n = noise(r, [[4, 4, 0.4], [2, 2, 0.3], [1, 1, 0.3]]);
  t.fill((x, y) => pick(DIRT_RAMP, 0.05 + n[y * N + x] * 0.85));
  for (let k = 0; k < 7; k++) {
    // Little pebbles with a shadow underneath.
    const x = (r() * N) | 0;
    const y = (r() * N) | 0;
    t.set(x, y, hex('#a88763'));
    if (r() < 0.5) t.set(x + 1, y, hex('#957552'));
    t.set(x, y + 1, hex('#4a3120'));
  }
  for (let k = 0; k < 8; k++) t.set((r() * N) | 0, (r() * N) | 0, hex('#4a3120'));
});

function grassColor(n, x, y) {
  return pick(GRASS_RAMP, n[(y & 15) * N + (x & 15)]);
}

paint(TILE.GRASS_TOP, (t, r) => {
  const n = noise(r, [[4, 4, 0.3], [2, 2, 0.3], [1, 1, 0.4]]);
  t.fill((x, y) => grassColor(n, x, y));
  // Blade tips catching light, each with a shadowed root below it.
  for (let k = 0; k < 14; k++) {
    const x = (r() * N) | 0;
    const y = (r() * N) | 0;
    t.set(x, y, GRASS_RAMP[6]);
    t.set(x, y + 1, GRASS_RAMP[1]);
  }
});

// Soil side with a hanging fringe of `fringe` colours; depth per column 2..5 px.
function paintFringeSide(t, r, ramp, edge, shadowF) {
  t.px.set(painted(TILE.DIRT).px);
  const n = noise(r, [[2, 2, 0.4], [1, 1, 0.6]]);
  let depth = 3;
  for (let x = 0; x < N; x++) {
    // Random walk keeps neighbouring columns similar, with occasional long drips.
    depth = clampi(depth + ((r() * 3) | 0) - 1, 2, 4);
    const d = r() < 0.18 ? depth + 2 : depth;
    for (let y = 0; y < d; y++) {
      t.set(x, y, y === d - 1 ? edge : pick(ramp, 0.25 + n[y * N + x] * 0.75 - y * 0.06));
    }
    t.tint(x, d, shadowF);
  }
}

paint(TILE.GRASS_SIDE, (t, r) => paintFringeSide(t, r, GRASS_RAMP, GRASS_RAMP[1], 0.72));
paint(TILE.SNOWY_GRASS_SIDE, (t, r) => paintFringeSide(t, r, SNOW_RAMP.slice(2), hex('#bfcbda'), 0.7));

paint(TILE.SNOW, (t, r) => {
  const n = noise(r, [[4, 4, 0.4], [2, 2, 0.3], [1, 1, 0.3]]);
  t.fill((x, y) => pick(SNOW_RAMP.slice(1, 5), n[y * N + x]));
  for (let k = 0; k < 8; k++) t.set((r() * N) | 0, (r() * N) | 0, SNOW_RAMP[5]);
  for (let k = 0; k < 5; k++) t.set((r() * N) | 0, (r() * N) | 0, SNOW_RAMP[0]);
});

paint(TILE.ICE, (t, r) => {
  const n = noise(r, [[8, 8, 0.4], [4, 4, 0.35], [2, 2, 0.25]]);
  t.fill((x, y) => pick(ICE_RAMP.slice(0, 5), n[y * N + x]));
  // Frosty fracture lines running up-right, with a deeper blue shadow beneath.
  for (let k = 0; k < 4; k++) {
    let x = (r() * N) | 0;
    let y = (r() * N) | 0;
    const len = 3 + ((r() * 5) | 0);
    for (let i = 0; i < len; i++) {
      t.set(x, y, i === 0 || i === len - 1 ? ICE_RAMP[5] : hex('#e6f3fe'));
      t.set(x, y + 1, ICE_RAMP[0]);
      x++;
      if (r() < 0.6) y--;
    }
  }
});

paint(TILE.SAND, (t, r) => {
  const n = noise(r, [[4, 4, 0.3], [2, 2, 0.3], [1, 1, 0.4]]);
  t.fill((x, y) => pick(SAND_RAMP.slice(0, 5), n[y * N + x]));
  for (let k = 0; k < 10; k++) t.set((r() * N) | 0, (r() * N) | 0, hex('#b9a46e'));
  for (let k = 0; k < 6; k++) t.set((r() * N) | 0, (r() * N) | 0, SAND_RAMP[5]);
});

paint(TILE.GRAVEL, (t, r) => {
  const pebbles = pal('#8b8681', '#79746f', '#9c968f', '#6c6966', '#a8a29a', '#857b70', '#948e88');
  paintCobbleLike(t, r, 20, null, hex('#45413e'), hex('#4f4a46'), (i, rr) => pebbles[(rr() * pebbles.length) | 0]);
});

paint(TILE.CLAY, (t, r) => {
  const n = noise(r, [[8, 8, 0.45], [4, 4, 0.3], [1, 1, 0.25]]);
  t.fill((x, y) => pick(CLAY_RAMP.slice(0, 5), n[y * N + x]));
  for (let k = 0; k < 6; k++) {
    const x = (r() * N) | 0;
    const y = (r() * N) | 0;
    t.set(x, y, CLAY_RAMP[5]);
    t.set(x + 1, y, CLAY_RAMP[4]);
  }
});

// --- Sandstone -------------------------------------------------------------------------------

paint(TILE.SANDSTONE_SIDE, (t, r) => {
  const n = noise(r, [[8, 2, 0.4], [4, 1, 0.3], [1, 1, 0.3]]);
  t.fill((x, y) => {
    const v = n[y * N + x];
    if (y <= 2) return pick(SANDSTONE_RAMP.slice(3), v); // smooth cap
    if (y === 3) return SANDSTONE_RAMP[1];
    if (y >= 13) return pick(SANDSTONE_RAMP.slice(1, 4), v); // weathered base
    if (y === 12) return SANDSTONE_RAMP[0];
    // Wavy strata through the body.
    const wave = Math.round(Math.sin(((x + 2) / 16) * Math.PI * 2) * 0.8);
    if (y === 7 + wave) return SANDSTONE_RAMP[1];
    return pick(SANDSTONE_RAMP.slice(2, 6), v);
  });
  for (let k = 0; k < 4; k++) t.set((r() * N) | 0, 13 + ((r() * 3) | 0), SANDSTONE_RAMP[0]);
});

paint(TILE.SANDSTONE_TOP, (t, r) => {
  const n = noise(r, [[4, 4, 0.4], [2, 2, 0.3], [1, 1, 0.3]]);
  t.fill((x, y) => {
    const v = n[y * N + x];
    if (x === 0 || y === 0) return SANDSTONE_RAMP[5];
    if (x === 15 || y === 15) return SANDSTONE_RAMP[1];
    return pick(SANDSTONE_RAMP.slice(2, 6), v);
  });
});

paint(TILE.SANDSTONE_BOTTOM, (t, r) => {
  const n = noise(r, [[4, 4, 0.4], [1, 1, 0.6]]);
  t.fill((x, y) => pick(SANDSTONE_RAMP.slice(1, 5), n[y * N + x]));
  for (let k = 0; k < 3; k++) {
    let x = (r() * N) | 0;
    const y = (r() * N) | 0;
    const len = 3 + ((r() * 4) | 0);
    for (let i = 0; i < len; i++) t.set(x++, y, SANDSTONE_RAMP[0]);
  }
});

// --- Wood --------------------------------------------------------------------------------------

paint(TILE.PLANKS, (t, r) => {
  const n = noise(r, [[8, 1, 0.45], [4, 1, 0.3], [16, 2, 0.25]]);
  const boardShift = [0, 0, 0, 0].map(() => Math.round((r() - 0.5) * 1.5));
  const joints = [3 + ((r() * 4) | 0), 9 + ((r() * 5) | 0), 1 + ((r() * 5) | 0), 8 + ((r() * 5) | 0)];
  t.fill((x, y) => {
    const b = y >> 2;
    const ly = y & 3;
    if (ly === 3) return PLANK_SEAM;
    if (x === joints[b]) return PLANK_SEAM;
    let idx = 1 + Math.round(n[y * N + x] * 3) + boardShift[b];
    if (ly === 0) idx += 1;
    if (x === ((joints[b] + 1) & 15)) idx += 1;
    return PLANK_RAMP[clampi(idx, 0, 5)];
  });
  // Grain flecks.
  for (let k = 0; k < 10; k++) {
    const x = (r() * N) | 0;
    const y = (r() * N) | 0;
    if ((y & 3) !== 3) t.set(x, y, PLANK_RAMP[0]);
  }
});

// Bark: vertical fibres with dark furrows; `plates` adds horizontal breaks (spruce).
function paintBark(t, r, ramp, furrows, plates) {
  const n = noise(r, [[2, 16, 0.35], [4, 8, 0.35], [1, 4, 0.3]]);
  t.fill((x, y) => pick(ramp.slice(1), n[y * N + x]));
  for (let k = 0; k < furrows; k++) {
    const x = (r() * N) | 0;
    const y0 = (r() * N) | 0;
    const len = 5 + ((r() * 9) | 0);
    for (let i = 0; i < len; i++) {
      t.set(x, y0 + i, ramp[0]);
      t.set(x - 1, y0 + i, ramp[ramp.length - 1]);
    }
  }
  if (plates) {
    for (let k = 0; k < plates; k++) {
      const x = (r() * N) | 0;
      const y = (r() * N) | 0;
      const len = 2 + ((r() * 2) | 0);
      for (let i = 0; i < len; i++) {
        t.set(x + i, y, ramp[0]);
        t.set(x + i, y + 1, ramp[3]);
      }
    }
  }
}

// End grain: growth rings around the pith, framed by a 1-px bark ring.
function paintRings(t, r, rings, bark) {
  const n = noise(r, [[4, 4, 0.6], [2, 2, 0.4]]);
  t.fill((x, y) => {
    if (x === 0 || y === 0 || x === 15 || y === 15) return pick(bark.slice(1, 5), r());
    const dx = x - 7.5;
    const dy = y - 7.5;
    const d = Math.max(Math.abs(dx), Math.abs(dy)) * 0.55 + Math.hypot(dx, dy) * 0.45 + (n[y * N + x] - 0.5) * 0.9;
    if (d < 1.1) return rings[0];
    const ring = (d - 1.1) / 1.6;
    const frac = ring - Math.floor(ring);
    if (frac < 0.32) return rings[1];
    return rings[3 + (Math.floor(ring) & 1)] || rings[3];
  });
  // Inner shadow just inside the bark.
  for (let i = 1; i < 15; i++) {
    t.tint(i, 1, 0.9);
    t.tint(1, i, 0.92);
    t.tint(i, 14, 0.88);
    t.tint(14, i, 0.88);
  }
}

paint(TILE.LOG_SIDE, (t, r) => paintBark(t, r, OAK_BARK, 5, 0));
paint(TILE.LOG_TOP, (t, r) => paintRings(t, r, OAK_RINGS, OAK_BARK));

paint(TILE.SPRUCE_LOG_SIDE, (t, r) => paintBark(t, r, SPRUCE_BARK, 4, 6));
paint(TILE.SPRUCE_LOG_TOP, (t, r) => paintRings(t, r, SPRUCE_RINGS, SPRUCE_BARK));

paint(TILE.BIRCH_LOG_SIDE, (t, r) => {
  const n = noise(r, [[4, 16, 0.4], [2, 4, 0.3], [1, 2, 0.3]]);
  t.fill((x, y) => pick(BIRCH_BARK.slice(1), n[y * N + x]));
  // Dark horizontal lenticel marks with soft grey edges.
  const ink = hex('#2a2825');
  const soft = hex('#6a675f');
  for (let k = 0; k < 8; k++) {
    const x = (r() * N) | 0;
    const y = (r() * N) | 0;
    const len = 2 + ((r() * 4) | 0);
    for (let i = 0; i < len; i++) t.set(x + i, y, i === 0 || i === len - 1 ? soft : ink);
    if (len > 3) t.set(x + 1, y + 1, soft);
  }
  for (let k = 0; k < 6; k++) t.set((r() * N) | 0, (r() * N) | 0, soft);
});

paint(TILE.BIRCH_LOG_TOP, (t, r) => {
  paintRings(t, r, BIRCH_RINGS, BIRCH_BARK);
  // Birch bark ring has dark flecks.
  for (let i = 0; i < 16; i++) {
    if (r() < 0.25) t.set(i, 0, hex('#3b3934'));
    if (r() < 0.25) t.set(i, 15, hex('#3b3934'));
    if (r() < 0.25) t.set(0, i, hex('#3b3934'));
    if (r() < 0.25) t.set(15, i, hex('#3b3934'));
  }
});

// Foliage with see-through gaps for the cutout pass.
function paintLeaves(t, r, ramp, holeFrac, needles) {
  const n = noise(r, [[4, 4, 0.35], [2, 2, 0.35], [1, 1, 0.3]]);
  const cut = percentile(n, holeFrac);
  t.fill((x, y) => {
    const v = n[y * N + x];
    if (v < cut) return CLEAR;
    let s = (v - cut) / (1 - cut);
    if (needles && ((x + y * 2) & 3) === 0) s -= 0.25;
    return pick(ramp, s);
  });
  // Leaves just below a gap sit in its shadow; leaves just above one catch light.
  const src = t.clone();
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    if (!src.alpha(x, y)) continue;
    if (y > 0 && !src.alpha(x, y - 1)) t.tint(x, y, 0.82);
    else if (y < 15 && !src.alpha(x, y + 1)) t.tint(x, y, 1.12);
  }
  for (let k = 0; k < 8; k++) {
    const x = (r() * N) | 0;
    const y = (r() * N) | 0;
    if (t.alpha(x, y)) t.set(x, y, ramp[ramp.length - 1]);
  }
}

paint(TILE.LEAVES, (t, r) => paintLeaves(t, r, OAK_LEAF, 0.2, false));
paint(TILE.BIRCH_LEAVES, (t, r) => paintLeaves(t, r, BIRCH_LEAF, 0.2, false));
paint(TILE.SPRUCE_LEAVES, (t, r) => paintLeaves(t, r, SPRUCE_LEAF, 0.16, true));

// --- Glass, water, ice -----------------------------------------------------------------------

paint(TILE.GLASS, (t) => {
  const light = hex('#eef8fa');
  const mid = hex('#bfdce2');
  const dark = hex('#8fb2ba');
  t.fill((x, y) => {
    if (y === 0 || x === 0) return x === 15 || y === 15 ? mid : light;
    if (y === 15 || x === 15) return dark;
    return CLEAR;
  });
  // Inner corner brackets.
  for (const [x, y] of [[1, 1], [14, 1], [1, 14], [14, 14]]) t.set(x, y, mid);
  // Reflection streaks (opaque so they survive the alpha test).
  const streak = hex('#e4f3f6');
  for (const [x, y] of [[3, 6], [4, 5], [5, 4], [6, 3], [3, 8], [4, 7], [5, 6], [6, 5], [7, 4], [8, 3], [10, 12], [11, 11], [12, 10]]) {
    t.set(x, y, streak);
  }
});

paint(TILE.WATER, (t, r) => {
  const n = noise(r, [[8, 2, 0.45], [4, 2, 0.3], [2, 1, 0.25]]);
  const hi = percentile(n, 0.9);
  t.fill((x, y) => {
    const v = n[y * N + x];
    if (v >= hi) return hex('#6f9fe0', 200);
    return withAlpha(pick(WATER_RAMP, v), 178);
  });
});

// --- Desert plants -----------------------------------------------------------------------------

// Cactus sides are drawn on quads moved 1/16 inward, so the outer columns are transparent and the
// top/bottom have a transparent 1-px rim: the visible cactus is 14/16 wide like its sides.
paint(TILE.CACTUS_SIDE, (t, r) => {
  const n = noise(r, [[1, 4, 0.5], [1, 1, 0.5]]);
  const colIdx = [0, 1, 3, 5, 3, 1, 3, 5, 3, 1, 3, 5, 3, 2, 1, 0];
  t.fill((x, y) => {
    if (x === 0 || x === 15) return CLEAR;
    const idx = clampi(colIdx[x] + Math.round((n[y * N + x] - 0.5) * 1.2), 0, 6);
    return CACTUS_RAMP[idx];
  });
  // Spines along the ridges.
  const spine = hex('#ece8bd');
  const base = hex('#20431b');
  for (const x of [3, 7, 11]) {
    const off = (r() * 4) | 0;
    for (let y = off; y < N; y += 4 + ((r() * 2) | 0)) {
      const sx = x + (r() < 0.5 ? -1 : 1);
      t.set(sx, y, spine);
      t.set(sx, y + 1, base);
    }
  }
});

function paintCactusCap(t, r, withSpines) {
  const n = noise(r, [[2, 2, 0.5], [1, 1, 0.5]]);
  t.fill((x, y) => {
    if (x === 0 || y === 0 || x === 15 || y === 15) return CLEAR;
    const d = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
    const v = n[y * N + x];
    if (d > 6) return CACTUS_RAMP[1];
    if (d > 4.5 && d < 5.5) return CACTUS_RAMP[2];
    return CACTUS_RAMP[clampi(4 + Math.round((v - 0.5) * 1.5) - (withSpines ? 0 : 1), 0, 6)];
  });
  if (withSpines) {
    const spine = hex('#ece8bd');
    for (const [x, y] of [[7, 7], [8, 8], [4, 4], [11, 4], [4, 11], [11, 11], [7, 3], [3, 8], [12, 7], [8, 12]]) {
      t.set(x, y, spine);
    }
    t.set(7, 8, CACTUS_RAMP[6]);
    t.set(8, 7, CACTUS_RAMP[6]);
  }
}
paint(TILE.CACTUS_TOP, (t, r) => paintCactusCap(t, r, true));
paint(TILE.CACTUS_BOTTOM, (t, r) => paintCactusCap(t, r, false));

// --- Crafting table / furnace / bookshelf --------------------------------------------------------

paint(TILE.CRAFTING_TABLE_TOP, (t, r) => {
  t.px.set(painted(TILE.PLANKS).px);
  const frameDark = hex('#4a321b');
  const frameMid = hex('#6c4a28');
  const groove = hex('#6a4a27');
  const lip = hex('#c29b63');
  for (let i = 0; i < N; i++) {
    t.set(i, 0, frameMid);
    t.set(0, i, frameMid);
    t.set(i, 15, frameDark);
    t.set(15, i, frameDark);
  }
  for (let i = 1; i < 15; i++) {
    t.set(i, 1, lip);
    t.set(1, i, lip);
    t.set(i, 14, frameMid);
    t.set(14, i, frameMid);
  }
  // Carved 3x3 work grid.
  for (const g of [5, 10]) {
    for (let i = 2; i < 14; i++) {
      t.set(g, i, groove);
      t.set(g + 1, i, scale(t.get(g + 1, i), 1.1));
      t.set(i, g, groove);
      t.set(i, g + 1, scale(t.get(i, g + 1), 1.1));
    }
  }
  // Iron corner studs.
  for (const [x, y] of [[1, 1], [14, 1], [1, 14], [14, 14]]) t.set(x, y, hex('#b4b4b8'));
  void r;
});

function paintTableSide(t, r) {
  const n = noise(r, [[1, 8, 0.5], [1, 2, 0.5]]);
  const plank = painted(TILE.PLANKS);
  t.fill((x, y) => {
    if (y === 0) return hex('#c39d66');
    if (y <= 2) return plank.get(x, y + 4);
    if (y === 3) return hex('#3e2914');
    const leg = x <= 1 || x >= 14;
    if (leg) {
      const c = PLANK_RAMP[clampi(1 + Math.round(n[y * N + x] * 3), 0, 5)];
      return x === 0 || x === 14 ? scale(c, 1.12) : scale(c, 0.86);
    }
    if (y <= 5) return plank.get(x, y + 8); // apron board
    if (y === 6) return hex('#3e2914');
    if (y === 12) return PLANK_RAMP[3]; // lower stretcher
    if (y === 13) return PLANK_RAMP[1];
    return y === 7 ? hex('#21160b') : hex('#2d1e10'); // shadowed interior
  });
}

paint(TILE.CRAFTING_TABLE_SIDE, (t, r) => {
  paintTableSide(t, r);
  // A drawer pull on the apron and a few jars on the stretcher shelf.
  t.set(7, 4, hex('#b4b4b8'));
  t.set(8, 4, hex('#7c7c80'));
  stamp(t, ['.b..g...', '.b..g.c.', 'bb.gg.c.'], { b: hex('#4f6fae'), g: hex('#5f9a4a'), c: hex('#c9a24a') }, 4, 9);
});

paint(TILE.CRAFTING_TABLE_FRONT, (t, r) => {
  paintTableSide(t, r);
  // Tools hung inside: a hammer and a saw.
  stamp(
    t,
    [
      'ggggg.......',
      'gGGGg..sss..',
      '..h...sSSSs.',
      '..h...sSSSs.',
      '..h...sSSSs.',
      '..h...sSSSs.',
      '..k....hhh..',
    ],
    {
      g: hex('#6d6d72'),
      G: hex('#a9a9ae'),
      h: hex('#9a7040'),
      k: hex('#6b4a25'),
      s: hex('#77777c'),
      S: hex('#c4c4c9'),
    },
    2,
    5,
  );
  // Saw teeth.
  for (let y = 7; y <= 10; y++) t.set(13, y, y & 1 ? hex('#4d4d52') : hex('#c4c4c9'));
  t.set(7, 4, hex('#b4b4b8'));
});

// Dressed stone with a bevelled border used by the furnace body.
function paintFurnaceBody(t, r) {
  const n = noise(r, [[4, 4, 0.5], [2, 2, 0.2], [1, 1, 0.3]]);
  t.fill((x, y) => {
    if (x === 0 || y === 0) return STONE_RAMP[5];
    if (x === 15 || y === 15) return STONE_RAMP[0];
    return pick(STONE_RAMP.slice(2, 5), n[y * N + x]);
  });
}

paint(TILE.FURNACE_SIDE, (t, r) => {
  paintFurnaceBody(t, r);
  // Two stacked courses of dressed stone.
  for (let x = 1; x < 15; x++) {
    t.set(x, 7, STONE_RAMP[1]);
    t.set(x, 8, STONE_RAMP[4]);
  }
  t.set(6, 1, STONE_RAMP[1]);
  t.set(10, 9, STONE_RAMP[1]);
  for (let y = 1; y < 7; y++) t.set(6, y, STONE_RAMP[1]);
  for (let y = 9; y < 15; y++) t.set(10, y, STONE_RAMP[1]);
});

paint(TILE.FURNACE_TOP, (t, r) => {
  paintFurnaceBody(t, r);
  // Chimney grate.
  for (let y = 5; y <= 10; y++) for (let x = 5; x <= 10; x++) {
    const edge = x === 5 || y === 5 || x === 10 || y === 10;
    t.set(x, y, edge ? STONE_RAMP[1] : (x & 1) ? hex('#1e1b1a') : hex('#4b4b50'));
  }
  for (let i = 5; i <= 10; i++) t.set(i, 11, STONE_RAMP[5]);
});

paint(TILE.FURNACE_FRONT, (t, r) => {
  paintFurnaceBody(t, r);
  // Vent slot near the top.
  for (let x = 5; x <= 10; x++) {
    t.set(x, 2, hex('#26221f'));
    t.set(x, 3, STONE_RAMP[5]);
  }
  // Arched fire mouth.
  const inside = (x, y) => y >= 7 && y <= 13 && x >= 3 && x <= 12 && !(y === 7 && (x < 5 || x > 10)) && !(y === 8 && (x < 4 || x > 11));
  for (let y = 6; y <= 14; y++) for (let x = 2; x <= 13; x++) {
    if (inside(x, y)) {
      let c = y >= 12 ? hex('#3c1c0e') : hex('#1a1614');
      if (y === 13 && (x * 7 + 3) % 5 < 2) c = hex('#7a3714'); // banked embers
      if (y === 12 && (x * 5 + 1) % 7 === 0) c = hex('#5b2a10');
      t.set(x, y, c);
    } else if (inside(x + 1, y) || inside(x, y + 1) || inside(x + 1, y + 1)) {
      t.set(x, y, STONE_RAMP[1]); // shadowed rim above/left of the mouth
    } else if (inside(x - 1, y) || inside(x, y - 1)) {
      t.set(x, y, STONE_RAMP[5]); // lit rim below/right
    }
  }
  // Grate bars.
  for (let x = 4; x <= 11; x += 2) t.set(x, 11, hex('#5a5a60'));
  for (let x = 3; x <= 12; x++) t.set(x, 14, STONE_RAMP[5]);
});

paint(TILE.BOOKSHELF, (t, r) => {
  const plank = painted(TILE.PLANKS);
  // Shelves: rows 0-1, 7-8, 14-15.
  t.fill((x, y) => {
    if (y <= 1) return plank.get(x, y + 1);
    if (y === 7 || y === 8) return plank.get(x, y - 2);
    if (y >= 14) return plank.get(x, y - 13);
    return hex('#24180c');
  });
  for (let x = 0; x < N; x++) {
    t.set(x, 1, scale(t.get(x, 1), 0.85));
    t.set(x, 8, scale(t.get(x, 8), 0.85));
  }
  const bookColors = pal('#8e2b23', '#2d4d8f', '#2f6d35', '#7b5525', '#5d3070', '#1f6d6d', '#a3812b', '#6e2324', '#3e4f5c');
  for (const top of [2, 9]) {
    let x = 0;
    while (x < N) {
      const w = r() < 0.7 ? 2 : r() < 0.5 ? 1 : 3;
      if (r() < 0.1 && x > 0) {
        x += 1; // a gap on the shelf
        continue;
      }
      const h = 3 + ((r() * 3) | 0); // 3..5 tall, standing on the shelf (rows top..top+4)
      const c = bookColors[(r() * bookColors.length) | 0];
      const band = r() < 0.6;
      for (let bx = x; bx < Math.min(N, x + w); bx++) {
        for (let by = top + 5 - h; by < top + 5; by++) {
          let col = c;
          if (bx === x && w > 1) col = scale(c, 1.2);
          else if (bx === x + w - 1 && w > 1) col = scale(c, 0.78);
          if (band && by === top + 5 - h + 1) col = mix(col, hex('#e0c46a'), 0.6);
          t.set(bx, by, col);
        }
      }
      x += w;
    }
  }
});

// --- Wool ---------------------------------------------------------------------------------------

function paintWool(t, r, base) {
  const c = hex(base);
  const black = [0, 0, 0, 255];
  const white = [255, 255, 255, 255];
  const ramp = [mix(c, black, 0.3), mix(c, black, 0.18), mix(c, black, 0.08), c, mix(c, white, 0.1), mix(c, white, 0.2)];
  const n = noise(r, [[4, 4, 0.35], [2, 2, 0.25], [1, 1, 0.4]]);
  // Knit stitches: columns of small chevrons, light on the upper arms.
  const stitch = [
    [1, 0, 0, 1],
    [0, 1, 1, 0],
    [0, 0, 0, 0],
    [-1, 0, 0, -1],
  ];
  t.fill((x, y) => {
    const s = stitch[(y + ((x >> 2) & 1) * 2) & 3][x & 3];
    return ramp[clampi(Math.round(2.4 + (n[y * N + x] - 0.5) * 2.2 + s * 0.9), 0, 5)];
  });
}

paint(TILE.WOOL_WHITE, (t, r) => paintWool(t, r, '#e3e6e6'));
paint(TILE.WOOL_RED, (t, r) => paintWool(t, r, '#b23a31'));
paint(TILE.WOOL_BLUE, (t, r) => paintWool(t, r, '#3a4fa5'));
paint(TILE.WOOL_YELLOW, (t, r) => paintWool(t, r, '#e5c33c'));
paint(TILE.WOOL_GREEN, (t, r) => paintWool(t, r, '#588b2d'));
paint(TILE.WOOL_BLACK, (t, r) => paintWool(t, r, '#2b2b31'));

// --- Storage blocks --------------------------------------------------------------------------------

// Bevelled metal plate with brushed grain and corner rivets.
function paintMetal(t, r, ramp, rim) {
  const n = noise(r, [[16, 1, 0.35], [8, 1, 0.35], [2, 1, 0.3]]);
  t.fill((x, y) => {
    if (x === 0 || y === 0) return ramp[5];
    if (x === 15 || y === 15) return rim;
    if (x === 1 || y === 1) return ramp[4];
    if (x === 14 || y === 14) return ramp[1];
    if (y === 7) return ramp[1];
    if (y === 8) return ramp[4];
    return pick(ramp.slice(2, 5), n[y * N + x]);
  });
  for (const [x, y] of [[3, 3], [12, 3], [3, 11], [12, 11]]) {
    t.set(x, y, ramp[5]);
    t.set(x + 1, y + 1, ramp[0]);
    t.set(x + 1, y, ramp[2]);
    t.set(x, y + 1, ramp[2]);
  }
}

paint(TILE.IRON_BLOCK, (t, r) => paintMetal(t, r, pal('#8a8b90', '#a6a7ac', '#babbc0', '#cbccd1', '#dcdde1', '#efeff2'), hex('#6c6d72')));
paint(TILE.GOLD_BLOCK, (t, r) => paintMetal(t, r, pal('#99700d', '#c29318', '#d8aa24', '#e8bf35', '#f4d34f', '#fde87e'), hex('#7a5807')));

paint(TILE.DIAMOND_BLOCK, (t, r) => {
  const ramp = pal('#178580', '#27aba2', '#3ac4ba', '#58d9cf', '#80e9e1', '#b6f7f2');
  const n = noise(r, [[4, 4, 0.5], [1, 1, 0.5]]);
  t.fill((x, y) => {
    if (x === 0 || y === 0) return ramp[5];
    if (x === 15 || y === 15) return hex('#106360');
    const dx = x - 7.5;
    const dy = y - 7.5;
    const v = n[y * N + x];
    // Faceted gem plate: four triangles meeting in the centre, lit from the top-left.
    let base;
    if (Math.abs(dx) > Math.abs(dy)) base = dx < 0 ? 4 : 1;
    else base = dy < 0 ? 3 : 2;
    if (Math.abs(Math.abs(dx) - Math.abs(dy)) < 0.6) base = 5; // facet ridges
    return ramp[clampi(base + Math.round((v - 0.5) * 1.2), 0, 5)];
  });
  t.set(7, 7, hex('#ffffff'));
});

paint(TILE.COAL_BLOCK, (t, r) => {
  const ramp = pal('#101012', '#17171a', '#1f1f22', '#27272b', '#303035', '#3e3e44');
  const v = voronoi(r, 7);
  const shade = [];
  for (let i = 0; i < v.count; i++) shade.push(1 + ((r() * 3) | 0));
  t.fill((x, y) => {
    if (x === 0 || y === 0) return ramp[4];
    if (x === 15 || y === 15) return ramp[0];
    const k = y * N + x;
    if (v.edge[k]) return ramp[0];
    return ramp[clampi(shade[v.id[k]] + (-(v.dx[k] + v.dy[k]) > 2 ? 1 : 0), 0, 5)];
  });
  for (let k = 0; k < 6; k++) t.set(1 + ((r() * 14) | 0), 1 + ((r() * 14) | 0), hex('#5d5d66'));
});

// --- Pumpkin & melon -----------------------------------------------------------------------------

paint(TILE.PUMPKIN_SIDE, (t, r) => {
  const n = noise(r, [[1, 8, 0.5], [1, 2, 0.5]]);
  const ribIdx = [1, 3, 5, 4]; // groove, flank, crest, flank
  t.fill((x, y) => {
    let idx = ribIdx[(x + 1) & 3] + Math.round((n[y * N + x] - 0.5) * 1.4);
    if (y === 0 || y === 15) idx -= 1;
    return PUMPKIN_RAMP[clampi(idx, 0, 5)];
  });
});

paint(TILE.PUMPKIN_FRONT, (t, r) => {
  t.px.set(painted(TILE.PUMPKIN_SIDE).px);
  const face = [
    '................',
    '................',
    '................',
    '...XX......XX...',
    '..XXXX....XXXX..',
    '..XXXX....XXXX..',
    '...XX......XX...',
    '.......XX.......',
    '................',
    '..X..........X..',
    '..XX.XX..XX.XXX.',
    '...XXXXXXXXXXX..',
    '....XXX..XXXX...',
    '................',
    '................',
    '................',
  ];
  const deep = hex('#2c1303');
  const hollow = hex('#4a2208');
  const rim = hex('#f7c45a');
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    if (face[y][x] !== 'X') continue;
    const above = y > 0 && face[y - 1][x] === 'X';
    t.set(x, y, above ? hollow : deep);
  }
  // Freshly cut flesh catches the light along the lower lip of each hole.
  for (let y = 1; y < N; y++) for (let x = 0; x < N; x++) {
    if (face[y][x] !== 'X' && face[y - 1][x] === 'X') t.set(x, y, rim);
  }
  void r;
});

function paintPumpkinCap(t, r, stem) {
  const n = noise(r, [[2, 2, 0.5], [1, 1, 0.5]]);
  t.fill((x, y) => {
    const dx = x - 7.5;
    const dy = y - 7.5;
    const a = Math.atan2(dy, dx);
    const rib = Math.cos(a * 8); // eight lobes radiating from the centre
    const d = Math.hypot(dx, dy);
    let idx = 3 + Math.round(rib * 1.3 + (n[y * N + x] - 0.5) * 1.2);
    if (d < 3) idx -= 1;
    return PUMPKIN_RAMP[clampi(idx, 0, 5)];
  });
  if (stem) {
    stamp(t, ['.ss.', 'sSSs', 'sSsd', '.dd.'], { s: hex('#4f6420'), S: hex('#7d9636'), d: hex('#33410f') }, 6, 6);
  } else {
    stamp(t, ['.d.', 'ddd', '.d.'], { d: hex('#6b330a') }, 6, 6);
  }
}
paint(TILE.PUMPKIN_TOP, (t, r) => paintPumpkinCap(t, r, true));
paint(TILE.PUMPKIN_BOTTOM, (t, r) => paintPumpkinCap(t, r, false));

paint(TILE.MELON_SIDE, (t, r) => {
  const n = noise(r, [[4, 4, 0.4], [1, 1, 0.6]]);
  const stripe = hex('#284e0f');
  t.fill((x, y) => {
    const wob = Math.round(Math.sin((y / 16) * Math.PI * 2) * 0.9);
    const lx = (x + wob) & 3;
    if (lx === 0) return stripe;
    if (lx === 1) return MELON_RAMP[4 + (n[y * N + x] > 0.6 ? 1 : 0)];
    return pick(MELON_RAMP.slice(1, 5), n[y * N + x]);
  });
  for (let k = 0; k < 7; k++) {
    const x = (r() * N) | 0;
    const y = (r() * N) | 0;
    t.set(x, y, hex('#a6cf68'));
  }
});

paint(TILE.MELON_TOP, (t, r) => {
  const n = noise(r, [[4, 4, 0.4], [1, 1, 0.6]]);
  t.fill((x, y) => {
    const d = Math.hypot(x - 7.5, y - 7.5);
    const v = n[y * N + x];
    if ((d > 5.2 && d < 6.2) || (d > 2.4 && d < 3.2)) return hex('#2c5512');
    return pick(MELON_RAMP.slice(1), v);
  });
  stamp(t, ['.b.', 'bBb', '.b.'], { b: hex('#5a4a22'), B: hex('#8a7440') }, 6, 6);
});

// --- Cross plants (transparent background) ---------------------------------------------------------

paint(TILE.TALL_GRASS, (t, r) => {
  const blades = 9;
  for (let k = 0; k < blades; k++) {
    const x0 = 1 + ((k / blades) * 13 + r() * 2) | 0;
    const h = 6 + ((r() * 9) | 0);
    const lean = (r() - 0.5) * 5;
    for (let i = 0; i < h; i++) {
      const f = i / h;
      const x = clampi(Math.round(x0 + lean * f * f), 0, 15);
      const y = 15 - i;
      t.put(x, y, pick(GRASS_RAMP, 0.1 + f * 0.85 + (r() - 0.5) * 0.15));
      if (i < 2 && x + 1 < N) t.put(x + 1, y, GRASS_RAMP[1]);
    }
  }
});

paint(TILE.FLOWER_RED, (t) => {
  stamp(
    t,
    [
      '................',
      '................',
      '.....aLL.La.....',
      '....aLRRaRRa....',
      '...aRRRRRRRRd...',
      '...RRRRyyRRRd...',
      '...aRRycyRRdd...',
      '....RRRyRRRd....',
      '....dRRRRRdd....',
      '.....ddddd......',
      '.......s.lL.....',
      '...lL..s.ll.....',
      '....ll.s.l......',
      '.....lls........',
      '.......s........',
      '.......s........',
    ],
    {
      a: hex('#c23a2c'),
      L: hex('#f2735a'),
      R: hex('#d8322a'),
      d: hex('#8c1a18'),
      y: hex('#f4cf4a'),
      c: hex('#5a2a0e'),
      s: hex('#3b7a25'),
      l: hex('#4f962f'),
      L_: null,
    },
  );
  // Leaf highlights.
  t.set(4, 11, hex('#73b748'));
  t.set(10, 10, hex('#73b748'));
});

paint(TILE.FLOWER_YELLOW, (t) => {
  stamp(
    t,
    [
      '................',
      '................',
      '.......Y........',
      '...Y..YLY..Y....',
      '....YLYYYLY.....',
      '.....YooOY......',
      '..YLYYoOOYYLY...',
      '.....YOOdY......',
      '....YdYYYdY.....',
      '...d..YdY..d....',
      '.......d........',
      '.......s..l.....',
      '...ll..s.ll.....',
      '....lllsll......',
      '.......s........',
      '.......s........',
    ],
    {
      Y: hex('#f0cf2e'),
      L: hex('#fff08a'),
      d: hex('#b8901a'),
      o: hex('#f09a2a'),
      O: hex('#c46a14'),
      s: hex('#3b7a25'),
      l: hex('#4f962f'),
    },
  );
});

paint(TILE.DEAD_BUSH, (t) => {
  const twig = hex('#8a6233');
  const dark = hex('#5e4120');
  const light = hex('#a77d48');
  const segs = [
    [7, 15, 7, 11, dark],
    [7, 11, 4, 7, twig],
    [4, 7, 2, 4, light],
    [4, 7, 5, 4, twig],
    [7, 11, 9, 7, twig],
    [9, 7, 8, 3, light],
    [9, 7, 12, 5, twig],
    [12, 5, 13, 3, light],
    [8, 12, 11, 10, twig],
    [11, 10, 13, 9, light],
    [6, 13, 3, 11, twig],
    [3, 11, 1, 10, light],
  ];
  for (const [x0, y0, x1, y1, c] of segs) line(x0, y0, x1, y1, (x, y) => t.put(x, y, c));
});

// ---------------------------------------------------------------------------------------------
// Crack overlay: one branching fracture network grown from the centre; stage s reveals the
// first (s + 1) / 10 of its growth, so cracks visibly spread as a block is mined.

function crackNetwork() {
  const r = rngFor(9001);
  const order = new Int16Array(N * N).fill(-1);
  const walkers = [];
  const mains = 5;
  for (let i = 0; i < mains; i++) {
    const a = (i / mains) * Math.PI * 2 + r() * 0.9;
    walkers.push({ x: 7.5 + Math.cos(a), y: 7.5 + Math.sin(a), a, life: 8 + r() * 5, born: i });
  }
  let step = 0;
  order[7 * N + 7] = 0;
  order[8 * N + 8] = 0;
  while (walkers.length && step < 200) {
    step++;
    for (let w = walkers.length - 1; w >= 0; w--) {
      const k = walkers[w];
      if (k.born > step) continue;
      k.a += (r() - 0.5) * 0.9;
      k.x += Math.cos(k.a) * 0.9;
      k.y += Math.sin(k.a) * 0.9;
      k.life--;
      const ix = Math.floor(k.x);
      const iy = Math.floor(k.y);
      if (ix < 0 || iy < 0 || ix >= N || iy >= N || k.life <= 0) {
        walkers.splice(w, 1);
        continue;
      }
      if (order[iy * N + ix] < 0) order[iy * N + ix] = step;
      if (r() < 0.16 && k.life > 3) {
        const side = r() < 0.5 ? -1 : 1;
        walkers.push({ x: k.x, y: k.y, a: k.a + side * (0.8 + r() * 0.6), life: k.life * 0.6, born: step + 1 });
      }
    }
  }
  return { order, max: step };
}

function paintCrack(t, net, stage) {
  const limit = Math.max(1, Math.round((net.max * (stage + 1)) / 10));
  const core = hex('#0a0a0a', 215);
  const halo = hex('#2c2c2c', 140);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const o = net.order[y * N + x];
    if (o >= 0 && o <= limit) t.set(x, y, core);
  }
  // Late stages chip the faces around the fractures.
  if (stage >= 5) {
    const src = t.clone();
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      if (src.alpha(x, y)) continue;
      const nb = src.alpha(x + 1, y) + src.alpha(x, y + 1);
      if (nb && ((x * 13 + y * 7 + stage) % 9) < stage - 4) t.set(x, y, halo);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Item icons (tiles 192+). Hand-laid pixel templates, then a dark outline pass.

const HANDLE_COLORS = { h: hex('#b98d55'), w: hex('#93693a'), k: hex('#5e4120') };

const TOOL_MATERIALS = {
  wood: { H: hex('#c9a26a'), M: hex('#a17844'), D: hex('#6c4c24') },
  stone: { H: hex('#b3b3b7'), M: hex('#88888d'), D: hex('#5a5a5f') },
  iron: { H: hex('#f6f6f8'), M: hex('#cfd0d5'), D: hex('#9a9ca3') },
  diamond: { H: hex('#c8fff8'), M: hex('#4ee2d3'), D: hex('#1c9a91') },
};

const PICKAXE = [
  '................',
  '.....HHHHH......',
  '...HHMMMMMHH....',
  '..HMMDDDDDMMH...',
  '..MD......DMMH..',
  '..D.......DDMH..',
  '.........wk.DMH.',
  '........hk..DMH.',
  '.......wk...DMH.',
  '......hk....DMH.',
  '.....wk.....DMH.',
  '....hk......MH..',
  '...wk......DMH..',
  '..hk......DMH...',
  '.wk.............',
  '................',
];

const AXE = [
  '................',
  '....HM..........',
  '...HMMMD........',
  '...HMMMMMMMDwk..',
  '...HMMMMMMDwkD..',
  '...HMMMMMDwkD...',
  '...HMMDD.wk.....',
  '....HD..wk......',
  '.......wk.......',
  '......hk........',
  '.....wk.........',
  '....hk..........',
  '...wk...........',
  '..hk............',
  '.wk.............',
  '................',
];

const SHOVEL = [
  '................',
  '...........HH...',
  '..........HHMM..',
  '.........HHMMMD.',
  '........HHMMMDD.',
  '........HMMMDD..',
  '........MMMDD...',
  '........hMDD....',
  '.......wk.......',
  '......hk........',
  '.....wk.........',
  '....hk..........',
  '...wk...........',
  '..hk............',
  '.wk.............',
  '................',
];

const SWORD = [
  '................',
  '..............H.',
  '............HMD.',
  '...........HMD..',
  '..........HMD...',
  '.........HMD....',
  '........HMD.....',
  '.......HMD......',
  '......HMD.......',
  '..D..HMD........',
  '...DHMD.........',
  '....DD..........',
  '...wkDD.........',
  '..hk..D.........',
  '.MM.............',
  '.M..............',
];

function paintTool(t, template, mat) {
  stamp(t, template, { ...HANDLE_COLORS, ...mat });
  outline(t, 0.7);
}

const ITEM_PAINTERS = new Map();
function paintItem(id, fn) {
  ITEM_PAINTERS.set(id, fn);
}

const TOOL_KINDS = [PICKAXE, AXE, SHOVEL, SWORD];
const TOOL_MATS = ['wood', 'stone', 'iron', 'diamond'];
for (let m = 0; m < 4; m++) {
  for (let k = 0; k < 4; k++) {
    const id = 261 + m * 4 + k;
    paintItem(id, (t) => paintTool(t, TOOL_KINDS[k], TOOL_MATERIALS[TOOL_MATS[m]]));
  }
}

paintItem(256, (t) => {
  // Stick
  stamp(
    t,
    [
      '................',
      '................',
      '.............wk.',
      '............hk..',
      '...........wk...',
      '..........hk....',
      '.........wk.....',
      '........hk......',
      '.......wk.......',
      '......hk........',
      '.....wk.........',
      '....hk..........',
      '...wk...........',
      '..hk............',
      '................',
      '................',
    ],
    HANDLE_COLORS,
  );
  t.set(8, 6, hex('#d2a96d'));
  outline(t, 0.7);
});

paintItem(257, (t) => {
  // Coal lump
  stamp(
    t,
    [
      '................',
      '................',
      '................',
      '......LLL.......',
      '....LLMMMMD.....',
      '...LMMLMMMMD....',
      '...MMMMMMMMMD...',
      '..LMMMMMDMMMDD..',
      '..MMMMMDDMMMMD..',
      '..MMMMMMMMMMDD..',
      '...MMLMMMMMDD...',
      '....DMMMMDDD....',
      '......DDDD......',
      '................',
      '................',
      '................',
    ],
    { L: hex('#5c5c64'), M: hex('#2f2f35'), D: hex('#1a1a1e') },
  );
  outline(t, 0.6);
});

function paintIngot(t, c) {
  stamp(
    t,
    [
      '................',
      '................',
      '................',
      '................',
      '................',
      '.....TTTTTT.....',
      '....TLLTTTTT....',
      '...TLTTTTTTTT...',
      '..EFFFFFFFFFFS..',
      '..EFFFFFFFFFFS..',
      '..EFFFFFFFFFFS..',
      '..SSSSSSSSSSSS..',
      '................',
      '................',
      '................',
      '................',
    ],
    c,
  );
  outline(t, 0.72);
}
paintItem(258, (t) => paintIngot(t, { L: hex('#ffffff'), T: hex('#e4e5e9'), E: hex('#d6d7dc'), F: hex('#bfc0c6'), S: hex('#8a8c93') }));
paintItem(259, (t) => paintIngot(t, { L: hex('#fff7c4'), T: hex('#fbdf68'), E: hex('#f2cc45'), F: hex('#e2b22a'), S: hex('#a97b0c') }));

paintItem(260, (t) => {
  stamp(
    t,
    [
      '................',
      '................',
      '................',
      '.....LLLLLL.....',
      '....LHHLLHHM....',
      '...LHHHLHHHMM...',
      '..LLLLLLLLMMMM..',
      '...HHHHMMMMMD...',
      '....HHHMMMMD....',
      '.....HHMMMD.....',
      '......HMMD......',
      '.......MD.......',
      '................',
      '................',
      '................',
      '................',
    ],
    { L: hex('#e8fffc'), H: hex('#90f3e8'), M: hex('#3fcfc3'), D: hex('#1b8c84') },
  );
  outline(t, 0.75);
});

paintItem(277, (t) => {
  // Apple: round body with a dimple, stem and leaf.
  const R = pal('#7d1414', '#a81e1c', '#cc2c24', '#e2443a', '#f27a68');
  for (let y = 3; y < 15; y++) for (let x = 1; x < 15; x++) {
    const dx = (x + 0.5 - 8) / 5.6;
    const dy = (y + 0.5 - 9) / 5.2;
    if (dx * dx + dy * dy > 1) continue;
    if (y <= 4 && x >= 7 && x <= 8) continue; // dimple
    const light = -(dx * 0.7 + dy * 0.9);
    t.set(x, y, pick(R, 0.45 + light * 0.45));
  }
  t.set(5, 6, hex('#ffd2c4'));
  t.set(4, 7, hex('#ffb3a2'));
  t.set(5, 7, hex('#f27a68'));
  stamp(t, ['.....l', '.s.lLl', '.s.ll.', 's.....'], { s: hex('#5e3d1c'), l: hex('#3f8a2a'), L: hex('#6cb846') }, 6, 1);
  outline(t, 0.6);
});

function paintMeat(t, cooked) {
  const meat = cooked ? pal('#4c240e', '#6a3416', '#87461f', '#a35d2c', '#bd7a42') : pal('#7d1f2a', '#a3303c', '#c4444f', '#dc6670', '#ef9198');
  const fat = cooked ? pal('#c99a52', '#e5bf78') : pal('#e3d2c8', '#fbf1ea');
  for (let y = 2; y < 15; y++) for (let x = 1; x < 15; x++) {
    // Slightly tilted, lumpy steak.
    const dx = x + 0.5 - 8;
    const dy = y + 0.5 - 8.5;
    const u = (dx * 0.94 + dy * 0.34) / 6.6;
    const v = (-dx * 0.34 + dy * 0.94) / 4.9;
    const d = u * u + v * v + Math.sin(x * 1.7 + y) * 0.04;
    if (d > 1) continue;
    let c;
    if (d > 0.62 && v < 0.15) c = d > 0.8 ? fat[0] : fat[1]; // fat cap along the top edge
    else c = pick(meat, 0.55 - (u + v) * 0.35 + ((x * 7 + y * 3) % 5) * 0.03);
    t.set(x, y, c);
  }
  if (cooked) {
    // Grill marks.
    for (const o of [0, 4, 8]) line(4 + o, 12, 7 + o, 6, (x, y) => t.alpha(x, y) && t.set(x, y, hex('#2e1407')));
  } else {
    // Marbling and a round bone.
    for (const [x, y] of [[5, 9], [6, 9], [9, 11], [10, 11], [11, 8]]) if (t.alpha(x, y)) t.set(x, y, hex('#f0b4b8'));
    stamp(t, ['.ww.', 'wbbw', 'wbbw', '.ww.'], { w: hex('#f4efe4'), b: hex('#c9bca4') }, 8, 6);
  }
  outline(t, 0.65);
}
paintItem(278, (t) => paintMeat(t, false));
paintItem(279, (t) => paintMeat(t, true));

// ---------------------------------------------------------------------------------------------
// Atlas assembly.

let atlasPixels = null;

function blit(dst, tile, t) {
  const ox = (tile % ATLAS_COLS) * N;
  const oy = Math.floor(tile / ATLAS_COLS) * N;
  for (let y = 0; y < N; y++) {
    dst.set(t.px.subarray(y * N * 4, (y + 1) * N * 4), ((oy + y) * ATLAS_W + ox) * 4);
  }
}

// Pure RGBA buffer (Uint8ClampedArray, 256*256*4) of the whole atlas. Memoised.
export function getAtlasPixels() {
  if (atlasPixels) return atlasPixels;
  const out = new Uint8ClampedArray(ATLAS_W * ATLAS_H * 4);
  for (const key of PAINTERS.keys()) blit(out, key, painted(key));
  const net = crackNetwork();
  for (let s = 0; s < CRACK_TILES.length; s++) {
    const t = new Tile();
    paintCrack(t, net, s);
    blit(out, CRACK_TILES[s], t);
  }
  for (const [id, fn] of ITEM_PAINTERS) {
    const t = new Tile();
    fn(t, rngFor(10000 + id));
    blit(out, itemTile(id), t);
  }
  atlasPixels = out;
  return out;
}

function makeCanvas(w, h) {
  if (typeof document !== 'undefined' && document.createElement) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }
  return new OffscreenCanvas(w, h);
}

function pixelsToCanvas(px, w, h) {
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.putImageData(new ImageData(px, w, h), 0, 0);
  return c;
}

let atlasCanvas = null;

export function createAtlas() {
  if (!atlasCanvas) atlasCanvas = pixelsToCanvas(new Uint8ClampedArray(getAtlasPixels()), ATLAS_W, ATLAS_H);
  return atlasCanvas;
}

// ---------------------------------------------------------------------------------------------
// Icons. Rendered once per (id, size) into RGBA pixels, then cached as canvases.

const FACE_SHADE = { top: 1.0, left: 0.8, right: 0.62 };

function texel(px, tile, u, v) {
  const tx = clampi(Math.floor(u * N), 0, N - 1);
  const ty = clampi(Math.floor(v * N), 0, N - 1);
  return (((Math.floor(tile / ATLAS_COLS) * N + ty) * ATLAS_W + (tile % ATLAS_COLS) * N + tx) << 2);
}

// Isometric cube: top face plus the front (left) and side (right) faces, shaded like the world.
function renderCubeIcon(def, s) {
  const px = getAtlasPixels();
  const out = new Uint8ClampedArray(s * s * 4);
  const hw = Math.round(s * 0.44); // half width of the hexagon
  const th = hw / 2; // half height of the top rhombus (2:1 pixel-art isometric)
  const sh = Math.round(hw * 1.12); // side height
  const cx = s / 2;
  const y0 = Math.round((s - (2 * th + sh)) / 2);
  const det = 2 * hw * th;
  const tex = def.textures;
  // Cactus faces are inset in the world; crop the transparent rim so the icon reads solid.
  const inset = def.id === 20 ? 1 / 16 : 0;
  const crop = (u) => inset + u * (1 - 2 * inset);
  const ss = s < 24 ? 4 : s < 40 ? 2 : 1; // supersample small icons
  for (let py = 0; py < s; py++) for (let qx = 0; qx < s; qx++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
      const X = qx + (sx + 0.5) / ss;
      const Y = py + (sy + 0.5) / ss;
      let tile;
      let u;
      let v;
      let shade;
      const dx = X - cx;
      const dy = Y - y0;
      const tu = (dx * th + dy * hw) / det;
      const tv = (hw * dy - th * dx) / det;
      if (tu >= 0 && tu < 1 && tv >= 0 && tv < 1) {
        tile = tex.top;
        u = tu;
        v = tv;
        shade = FACE_SHADE.top;
      } else if (dx < 0 && dx >= -hw) {
        u = (dx + hw) / hw;
        v = (Y - (y0 + th) - u * th) / sh;
        tile = tex.front;
        shade = FACE_SHADE.left;
      } else if (dx >= 0 && dx < hw) {
        u = dx / hw;
        v = (Y - (y0 + 2 * th) + u * th) / sh;
        tile = tex.side;
        shade = FACE_SHADE.right;
      } else continue;
      if (v < 0 || v >= 1) continue;
      const i = texel(px, tile, crop(u), crop(v));
      const al = px[i + 3] / 255;
      if (al === 0) continue;
      r += px[i] * shade * al;
      g += px[i + 1] * shade * al;
      b += px[i + 2] * shade * al;
      a += al;
    }
    if (a > 0) {
      const o = (py * s + qx) * 4;
      out[o] = r / a;
      out[o + 1] = g / a;
      out[o + 2] = b / a;
      out[o + 3] = (a / (ss * ss)) * 255;
    }
  }
  return out;
}

// Flat tile scaled into the box: whole-pixel scaling when it fits well, area-averaged below 16 px.
function renderFlatIcon(tile, s) {
  const px = getAtlasPixels();
  const out = new Uint8ClampedArray(s * s * 4);
  const k = Math.floor(s / N);
  const box = k >= 1 && N * k >= s * 0.8 ? N * k : s;
  const off = Math.floor((s - box) / 2);
  const ss = box < N ? 4 : 1;
  for (let py = 0; py < box; py++) for (let qx = 0; qx < box; qx++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
      const i = texel(px, tile, (qx + (sx + 0.5) / ss) / box, (py + (sy + 0.5) / ss) / box);
      const al = px[i + 3] / 255;
      r += px[i] * al;
      g += px[i + 1] * al;
      b += px[i + 2] * al;
      a += al;
    }
    if (a > 0) {
      const o = ((py + off) * s + qx + off) * 4;
      out[o] = r / a;
      out[o + 1] = g / a;
      out[o + 2] = b / a;
      out[o + 3] = (a / (ss * ss)) * 255;
    }
  }
  return out;
}

// RGBA pixels for an item/block icon of size s x s, or null for air / unknown ids. Pure.
export function renderIconPixels(id, s) {
  if (id >= 256) {
    if (!ITEM_PAINTERS.has(id)) return null;
    return renderFlatIcon(itemTile(id), s);
  }
  const def = BLOCKS[id];
  if (!def || def.shape === 'none') return null;
  if (def.shape === 'cube') return renderCubeIcon(def, s);
  return renderFlatIcon(def.textures.side, s);
}

const iconCache = new Map();

// Cached canvas holding the icon at `size` px (null for air / unknown ids).
export function getItemIconCanvas(id, size) {
  const s = Math.max(1, Math.round(size));
  const key = id * 4096 + s;
  let c = iconCache.get(key);
  if (c === undefined) {
    if (iconCache.size > 4000) iconCache.clear();
    const px = renderIconPixels(id, s);
    c = px ? pixelsToCanvas(px, s, s) : null;
    iconCache.set(key, c);
  }
  return c;
}

export function drawItemIcon(ctx, id, x, y, size) {
  if (id === null || id === undefined || id <= 0) return;
  const c = getItemIconCanvas(id, size);
  if (!c) return;
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(c, x, y, size, size);
  ctx.restore();
}

// Convenience for debugging / particles: the block definition behind an icon id.
export function iconBlock(id) {
  return id > 0 && id < 256 ? getBlock(id) : null;
}
