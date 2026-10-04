// Terrablock world generator: terrain, biomes, caves, ores, water, trees and plants.
// Pure and deterministic (same seed + chunk -> identical bytes), worker-safe (no DOM, no globals
// other than per-seed caches), importable from Node.
//
// Contract (ARCHITECTURE.md):
//   hashSeed(str)                -> 32-bit int seed (re-exported from noise.js)
//   generateChunk(cx, cz, seed)  -> Uint8Array(CHUNK_VOLUME), index = lx + lz*16 + y*256
//   findSpawn(seed)              -> {x, y, z} feet position on dry land near (0, 0) with 2 air blocks above
//   biomeAt(x, z, seed)          -> 'ocean'|'beach'|'plains'|'forest'|'birch_forest'|'desert'|'snowy'|'taiga'|'mountains'
//
// Purity across chunk borders: every decision that can affect more than one chunk (tree placement,
// ore veins, caves under a tree) is computed from world coordinates only, through the same functions
// whether the column lies inside the chunk being generated or in a neighbour. Cave densities are
// trilinearly interpolated from a world-aligned 4x4x4 lattice with one canonical operation order, so a
// direct point query (`carvedAt`) returns bit-identical results to the bulk per-chunk pass.

import { CHUNK_SIZE, WORLD_HEIGHT, CHUNK_VOLUME, SEA_LEVEL } from './config.js';
import {
  hashSeed,
  mixSeed,
  mulberry32,
  hash2,
  hash3,
  rand2,
  rand3,
  createNoise2D,
  createNoise3D,
  fbm2,
  ridged2,
} from './noise.js';

export { hashSeed };

// Block ids — identical to `B` in blocks.js (fixed by the architecture contract). Defined locally so the
// generator has no dependency beyond config.js/noise.js and stays loadable in a bare worker or Node test.
const AIR = 0, STONE = 1, GRASS = 2, DIRT = 3, BEDROCK = 6, WATER = 7, SAND = 8, GRAVEL = 9;
const GOLD_ORE = 10, IRON_ORE = 11, COAL_ORE = 12, LOG = 13, LEAVES = 14, SANDSTONE = 16;
const SNOWY_GRASS = 17, SNOW = 18, ICE = 19, CACTUS = 20, CLAY = 21, DIAMOND_ORE = 22;
const TALL_GRASS = 26, FLOWER_RED = 27, FLOWER_YELLOW = 28, BIRCH_LOG = 29, BIRCH_LEAVES = 30;
const SPRUCE_LOG = 31, SPRUCE_LEAVES = 32, DEAD_BUSH = 33, PUMPKIN = 48, MELON = 49;

// Biome codes (internal) and names (contract).
const OCEAN = 0, BEACH = 1, PLAINS = 2, FOREST = 3, BIRCH_FOREST = 4, DESERT = 5, SNOWY = 6, TAIGA = 7, MOUNTAINS = 8;
const BIOME_NAMES = ['ocean', 'beach', 'plains', 'forest', 'birch_forest', 'desert', 'snowy', 'taiga', 'mountains'];
export const BIOMES = BIOME_NAMES.slice();

const CS = CHUNK_SIZE;
const CA = CHUNK_SIZE * CHUNK_SIZE; // y stride in chunk data
const MAX_Y = WORLD_HEIGHT - 1;

// Climate thresholds (temperature T and humidity Hu are ~N(0, 0.35) fractal noise).
const T_SNOWY = -0.53;
const T_TAIGA = -0.33;
const T_DESERT = 0.25;
const HU_DESERT = -0.05;
const HU_FOREST = 0.15;
const T_BIRCH = -0.11;

// Cave lattice spacing (blocks). Must be a power of two for the bit tricks below.
const CG = 4;
const CAVE_MIN_Y = 5; // keep the bedrock floor and a little stone intact

// Trees: candidate lattice cell size, max canopy radius (how far a tree can reach into a neighbour).
const TREE_CELL = 4;
const TREE_REACH = 3;
const CACTUS_CELL = 6;
const PATCH_CELL = 48; // pumpkin/melon patch lattice
const PATCH_RADIUS = 3;

// ---------------------------------------------------------------------------------------------
// Small math helpers

function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}
function smoothstep(e0, e1, v) {
  const t = clamp((v - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}
function lerp(a, b, t) {
  return a + (b - a) * t;
}
function floorDiv(a, b) {
  return Math.floor(a / b);
}

// Continentalness -> base terrain height. Piecewise linear spline.
const CONT_X = [-1.2, -0.55, -0.3, -0.15, -0.06, 0.0, 0.08, 0.25, 0.5, 1.2];
const CONT_Y = [16, 24, 34, 42, 46.5, 49, 51.5, 56, 62, 72];
function contSpline(c) {
  if (c <= CONT_X[0]) return CONT_Y[0];
  for (let i = 1; i < CONT_X.length; i++) {
    if (c < CONT_X[i]) {
      const t = (c - CONT_X[i - 1]) / (CONT_X[i] - CONT_X[i - 1]);
      return CONT_Y[i - 1] + (CONT_Y[i] - CONT_Y[i - 1]) * t;
    }
  }
  return CONT_Y[CONT_Y.length - 1];
}

// ---------------------------------------------------------------------------------------------
// Per-seed generator

const WIN = CS + 2; // column window: the chunk plus a 1-block margin (slopes, water adjacency)
const WIN_AREA = WIN * WIN;

class Generator {
  constructor(seed) {
    this.seed = seed | 0;
    const s = this.seed;
    const n2 = (salt) => createNoise2D(mixSeed(s, salt));
    const n3 = (salt) => createNoise3D(mixSeed(s, salt));
    this.nWarpX = n2(101);
    this.nWarpZ = n2(102);
    this.nCont = n2(103);
    this.nEro = n2(104);
    this.nHill = n2(105);
    this.nDetail = n2(106);
    this.nMnt = n2(107);
    this.nRidge = n2(108);
    this.nRiver = n2(109);
    this.nTemp = n2(110);
    this.nHum = n2(111);
    this.nJit = n2(112);
    this.nPatch = n2(113);
    this.nForest = n2(114);
    this.nFlower = n2(115);
    this.nDune = n2(116);
    this.nRav = n2(117);
    this.nRavMask = n2(118);
    this.nCheese = n3(201);
    this.nCheese2 = n3(202);
    this.nSpagA = n3(203);
    this.nSpagB = n3(204);
    this.nSpagC = n3(205);
    this.nSpagD = n3(206);

    this.sDirt = mixSeed(s, 301);
    this.sBedrock = mixSeed(s, 302);
    this.sTree = mixSeed(s, 303);
    this.sTreeShape = mixSeed(s, 304);
    this.sPlant = mixSeed(s, 305);
    this.sOre = mixSeed(s, 306);
    this.sCactus = mixSeed(s, 307);
    this.sPatch = mixSeed(s, 308);
    this.sSurf = mixSeed(s, 309);

    // Column window (struct of arrays). Floats are stored as float64 so values read back from the window
    // are bit-identical to values computed directly for out-of-window columns.
    this.wX0 = 0;
    this.wZ0 = 0;
    this.wH = new Int32Array(WIN_AREA);
    this.wBiome = new Uint8Array(WIN_AREA);
    this.wT = new Float64Array(WIN_AREA);
    this.wHu = new Float64Array(WIN_AREA);
    this.wMh = new Float64Array(WIN_AREA);
    this.wC = new Float64Array(WIN_AREA);
    this.wValley = new Float64Array(WIN_AREA);
    this.extra = new Map(); // out-of-window column cache, cleared per chunk

    this.col = { h: 0, biome: 0, T: 0, Hu: 0, mh: 0, c: 0, valley: 0 };
    this.surf = { top: 0, filler: 0, depth: 0, deep: 0, deepDepth: 0 };
    this.rav = { active: false, lo: 0, hi: 0 };

    // Cave lattice scratch: 5 x 33 x 5 corners x 3 fields.
    const GX = CS / CG + 1;
    const GY = WORLD_HEIGHT / CG + 1;
    this.GX = GX;
    this.GY = GY;
    this.gCheese = new Float64Array(GX * GX * GY);
    this.gA = new Float64Array(GX * GX * GY);
    this.gB = new Float64Array(GX * GX * GY);
    this.gC = new Float64Array(GX * GX * GY);
    this.gD = new Float64Array(GX * GX * GY);
    this.corner = new Float64Array(5);
    this.pointCorners = new Float64Array(40);
    this.pointFields = new Float64Array(5);
    // Per-column y-lattice values after x/z interpolation (canonical order: x, then z, then y).
    this.colCheese = new Float64Array(GY);
    this.colA = new Float64Array(GY);
    this.colB = new Float64Array(GY);
    this.colC = new Float64Array(GY);
    this.colD = new Float64Array(GY);
  }

  // -------------------------------------------------------------------------------------------
  // Columns: heightmap + climate. Pure function of (x, z).

  computeColumn(x, z, out) {
    // Domain warp for organic coastlines and biome shapes.
    const wx = x + fbm2(this.nWarpX, x * (1 / 240), z * (1 / 240), 2) * 48;
    const wz = z + fbm2(this.nWarpZ, x * (1 / 240), z * (1 / 240), 2) * 48;

    let c = fbm2(this.nCont, wx * (1 / 1000), wz * (1 / 1000), 4) * 1.25 + 0.27;
    // Nudge towards land around the origin so spawn is never far out at sea.
    const r2 = x * x + z * z;
    if (r2 < 4e6) c += 0.32 * Math.exp(-r2 * (1 / (2 * 360 * 360)));

    // Climate (with a little high-frequency jitter so biome borders aren't perfectly smooth curves).
    const jit = this.nJit(x * (1 / 14), z * (1 / 14));
    const T = fbm2(this.nTemp, wx * (1 / 1100), wz * (1 / 1100), 2) + jit * 0.014;
    const Hu = fbm2(this.nHum, wx * (1 / 950) + 300, wz * (1 / 950), 2) - jit * 0.014;

    const land = smoothstep(-0.25, 0.05, c);
    const desertness = smoothstep(T_DESERT - 0.08, T_DESERT + 0.1, T) * smoothstep(HU_DESERT + 0.1, HU_DESERT - 0.1, Hu);
    const flatness = smoothstep(HU_FOREST + 0.05, HU_FOREST - 0.2, Hu) * (1 - desertness);

    let h = contSpline(c);

    // Rolling hills; amplitude driven by an "erosion" field, calmer under the sea and on plains/deserts.
    const ero = fbm2(this.nEro, x * (1 / 520), z * (1 / 520), 2);
    const hillAmp = (4 + 15 * smoothstep(-0.35, 0.55, ero)) * (0.35 + 0.65 * land) * (1 - 0.45 * flatness) * (1 - 0.5 * desertness);
    h += fbm2(this.nHill, x * (1 / 120), z * (1 / 120), 3) * hillAmp;
    h += this.nDetail(x * (1 / 26), z * (1 / 26)) * 1.1;
    // Low dunes in deserts.
    if (desertness > 0) h += desertness * (ridged2(this.nDune, x * (1 / 40), z * (1 / 55), 2) - 0.35) * 5;

    // Mountains: a low-frequency mask times ridged noise.
    const mm = fbm2(this.nMnt, wx * (1 / 720), wz * (1 / 720), 2);
    const mf = smoothstep(0.1, 0.42, mm) * smoothstep(0.0, 0.22, c);
    let mh = 0;
    if (mf > 0) {
      const ridge = ridged2(this.nRidge, x * (1 / 210), z * (1 / 210), 4);
      mh = mf * (10 + 58 * ridge);
      h += mh;
    }

    // Rivers: valleys along the zero contour of a noise field; carve below sea level in the middle.
    let valley = 0;
    const riverF = smoothstep(-0.04, 0.14, c);
    if (riverF > 0) {
      const rv = Math.abs(fbm2(this.nRiver, wx * (1 / 760), wz * (1 / 760), 3));
      if (rv < 0.09) {
        valley = (1 - smoothstep(0.0, 0.09, rv)) * riverF;
        const bank = SEA_LEVEL + 2;
        if (h > bank) h -= (h - bank) * valley * valley * (3 - 2 * valley);
        const chan = (1 - smoothstep(0.008, 0.03, rv)) * riverF;
        const bed = SEA_LEVEL - 3 - chan * 2;
        if (h > bed) h -= (h - bed) * chan;
      }
    }

    // Soft cap so peaks stay below the build limit (with room for snow).
    if (h > 96) h = 96 + (h - 96) * 0.55;
    const hi = clamp(Math.floor(h), 6, WORLD_HEIGHT - 12);

    out.h = hi;
    out.T = T;
    out.Hu = Hu;
    out.mh = mh;
    out.c = c;
    out.valley = valley;
    out.biome = classifyBiome(hi, T, Hu, mh, c, valley);
    return out;
  }

  // Fill the column window for chunk (cx, cz).
  prepareWindow(cx, cz) {
    const x0 = cx * CS - 1;
    const z0 = cz * CS - 1;
    this.wX0 = x0;
    this.wZ0 = z0;
    this.extra.clear();
    const col = this.col;
    for (let j = 0; j < WIN; j++) {
      for (let i = 0; i < WIN; i++) {
        this.computeColumn(x0 + i, z0 + j, col);
        const k = i + j * WIN;
        this.wH[k] = col.h;
        this.wBiome[k] = col.biome;
        this.wT[k] = col.T;
        this.wHu[k] = col.Hu;
        this.wMh[k] = col.mh;
        this.wC[k] = col.c;
        this.wValley[k] = col.valley;
      }
    }
  }

  // Column record for any (x, z): from the window if inside, else computed (and cached per chunk).
  // Returns an object with the same fields as `col`. Callers must not keep it across calls.
  columnAt(x, z) {
    const i = x - this.wX0;
    const j = z - this.wZ0;
    if (i >= 0 && i < WIN && j >= 0 && j < WIN) {
      const k = i + j * WIN;
      const o = this._winRec || (this._winRec = { h: 0, biome: 0, T: 0, Hu: 0, mh: 0, c: 0, valley: 0 });
      o.h = this.wH[k];
      o.biome = this.wBiome[k];
      o.T = this.wT[k];
      o.Hu = this.wHu[k];
      o.mh = this.wMh[k];
      o.c = this.wC[k];
      o.valley = this.wValley[k];
      return o;
    }
    const key = x + ',' + z;
    let rec = this.extra.get(key);
    if (!rec) {
      rec = this.computeColumn(x, z, { h: 0, biome: 0, T: 0, Hu: 0, mh: 0, c: 0, valley: 0 });
      this.extra.set(key, rec);
    }
    return rec;
  }

  heightAt(x, z) {
    const i = x - this.wX0;
    const j = z - this.wZ0;
    if (i >= 0 && i < WIN && j >= 0 && j < WIN) return this.wH[i + j * WIN];
    return this.columnAt(x, z).h;
  }

  // Max height difference to the 4 side neighbours.
  slopeAt(x, z, h) {
    let s = Math.abs(this.heightAt(x + 1, z) - h);
    let d = Math.abs(this.heightAt(x - 1, z) - h);
    if (d > s) s = d;
    d = Math.abs(this.heightAt(x, z + 1) - h);
    if (d > s) s = d;
    d = Math.abs(this.heightAt(x, z - 1) - h);
    if (d > s) s = d;
    return s;
  }

  // -------------------------------------------------------------------------------------------
  // Surface materials for a column. Writes this.surf: top block, `depth` filler blocks below it,
  // then `deepDepth` blocks of `deep` (e.g. sandstone under sand), then stone.

  surfaceFor(x, z, h, biome, T, Hu, mh, c, slope) {
    const s = this.surf;
    const r = hash2(this.sDirt, x, z);
    const patch = this.nPatch(x * (1 / 18), z * (1 / 18));
    s.deep = STONE;
    s.deepDepth = 0;
    s.depth = 3 + (r & 1); // 3-4 dirt like the original
    switch (biome) {
      case OCEAN: {
        const d = SEA_LEVEL - h;
        const inland = c > 0.14;
        if (d <= 2) {
          s.top = patch > 0.5 ? CLAY : SAND;
        } else if (inland) {
          s.top = patch > 0.42 ? CLAY : patch < -0.3 ? GRAVEL : patch < 0.05 ? SAND : DIRT;
        } else if (d <= 10) {
          s.top = patch > 0.55 ? CLAY : patch < -0.35 ? GRAVEL : SAND;
        } else {
          s.top = patch < -0.1 ? GRAVEL : patch > 0.65 ? CLAY : SAND;
        }
        s.filler = s.top === CLAY ? CLAY : s.top;
        s.depth = s.top === CLAY ? 1 + (r & 1) : 2 + (r & 1);
        if (s.top === SAND) {
          s.deep = SANDSTONE;
          s.deepDepth = 1 + ((r >>> 1) & 1);
        } else if (s.top === CLAY) {
          s.deep = s.top === CLAY && d <= 2 ? SAND : DIRT;
          s.deepDepth = 1;
        }
        return s;
      }
      case BEACH: {
        if (slope >= 3) {
          s.top = STONE;
          s.filler = STONE;
          return s;
        }
        // Cold shores are stony.
        s.top = T < T_TAIGA && patch > -0.15 ? GRAVEL : SAND;
        s.filler = s.top;
        s.depth = 3 + (r & 1);
        s.deep = SANDSTONE;
        s.deepDepth = 2 + ((r >>> 1) & 1);
        return s;
      }
      case DESERT: {
        if (slope >= 4) {
          s.top = SANDSTONE;
          s.filler = SANDSTONE;
          s.depth = 4;
          return s;
        }
        s.top = SAND;
        s.filler = SAND;
        s.depth = 3 + (r & 3) % 3; // 3..5
        s.deep = SANDSTONE;
        s.deepDepth = 3 + ((r >>> 2) & 1);
        return s;
      }
      case MOUNTAINS: {
        const snowLine = 94 + T * 22 + this.nJit(x * (1 / 9), z * (1 / 9)) * 3;
        if (h >= snowLine) {
          s.top = SNOW;
          s.filler = h >= snowLine + 4 ? SNOW : STONE;
          s.depth = 1;
          return s;
        }
        const stoneLine = snowLine - 13 + patch * 4;
        if (h >= stoneLine || slope >= 3) {
          s.top = patch > 0.55 ? GRAVEL : STONE;
          s.filler = s.top;
          s.depth = s.top === GRAVEL ? 2 : 1;
          return s;
        }
        s.top = T < T_SNOWY ? SNOWY_GRASS : GRASS;
        s.filler = DIRT;
        s.depth = 2 + (r & 1);
        return s;
      }
      default: {
        // plains, forest, birch_forest, snowy, taiga
        if (slope >= 4) {
          s.top = STONE;
          s.filler = STONE;
          return s;
        }
        s.top = biome === SNOWY ? SNOWY_GRASS : GRASS;
        s.filler = DIRT;
        return s;
      }
    }
  }

  // Top block of a column before caves (used for tree checks outside the chunk window).
  surfaceTopAt(x, z) {
    const col = this.columnAt(x, z);
    const h = col.h;
    const biome = col.biome;
    const T = col.T, Hu = col.Hu, mh = col.mh, c = col.c;
    const slope = this.slopeAt(x, z, h);
    return this.surfaceFor(x, z, h, biome, T, Hu, mh, c, slope).top;
  }

  // -------------------------------------------------------------------------------------------
  // Caves

  // Noise fields at one lattice corner (world coords, multiples of CG). Writes this.corner.
  caveCorner(wx, wy, wz) {
    const o = this.corner;
    o[0] = this.nCheese(wx * (1 / 72), wy * (1 / 38), wz * (1 / 72)) * 0.68 +
      this.nCheese2(wx * (1 / 26), wy * (1 / 18), wz * (1 / 26)) * 0.32;
    // Two pairs of "spaghetti" fields: tunnels run where both fields of a pair are near zero.
    // Simplex noise is exactly zero on its lattice vertices, so the two fields of a pair are sampled
    // with different scales and offsets; otherwise their shared zeros line up into straight tunnels.
    o[1] = this.nSpagA(wx * (1 / 62), wy * (1 / 34), wz * (1 / 62));
    o[2] = this.nSpagB(wx * (1 / 57) + 311.7, wy * (1 / 31) + 71.3, wz * (1 / 57) - 157.9);
    o[3] = this.nSpagC(wx * (1 / 105) - 93.1, wy * (1 / 44) + 17.7, wz * (1 / 105) + 251.3);
    o[4] = this.nSpagD(wx * (1 / 97) + 413.9, wy * (1 / 41) - 39.5, wz * (1 / 97) - 77.1);
  }

  // Ravine for a column: sets this.rav.{active, lo, hi} (carve lo..hi inclusive when active).
  ravineFor(x, z) {
    const r = this.rav;
    r.active = false;
    const m = this.nRavMask(x * (1 / 640), z * (1 / 640));
    if (m < 0.42) return r;
    const strength = smoothstep(0.42, 0.62, m);
    const halfW = 0.03 * strength; // in noise units (~2-4 blocks)
    const d = Math.abs(this.nRav(x * (1 / 300), z * (1 / 300)));
    if (d >= halfW) return r;
    const s = d / halfW; // 0 at the centre line, 1 at the edge
    const floorY = 12 + this.nRavMask(x * (1 / 90) + 50, z * (1 / 90)) * 5;
    const topY = floorY + 40 + this.nRav(x * (1 / 120) + 70, z * (1 / 120)) * 10;
    const mid = (floorY + topY) * 0.5;
    const half = (topY - floorY) * 0.5 * Math.sqrt(1 - s * s); // elliptical cross-section
    r.active = true;
    r.lo = Math.ceil(mid - half);
    r.hi = Math.floor(mid + half);
    return r;
  }

  // Highest y caves may carve in a column, and the lowest neighbour height (water adjacency guard).
  carveTopFor(h) {
    // Under water keep a 5-block floor so caves never open into the sea.
    return h < SEA_LEVEL ? h - 5 : h;
  }

  // The carve rule shared by the bulk pass and point queries.
  // ch/a/b/c2/d2: interpolated fields; y: cell; h: column surface; waterLim: min height of the 3x3
  // column neighbourhood (cells at y <= SEA_LEVEL above it could touch water, so they stay solid).
  static carveRule(ch, a, b, c2, d2, y, h, waterLim) {
    if (y <= SEA_LEVEL && y > waterLim) return false;
    const depth = h - y;
    // Large caverns ("cheese"): more common deep down, suppressed near the surface.
    let thr = 0.6;
    if (depth < 12) thr += (12 - depth) * 0.04;
    if (y < 32) thr -= (32 - y) * 0.004;
    if (ch > thr) return true;
    // Tunnels: thinner near the surface so entrances are modest.
    let r2 = depth < 4 ? 0.0032 : 0.0055;
    if (a * a + b * b < r2) return true;
    r2 = depth < 4 ? 0.0024 : 0.0042;
    if (y < 72 && c2 * c2 + d2 * d2 < r2) return true;
    return false;
  }

  // Point query: is (x, y, z) carved out by caves/ravines? Bit-identical to the bulk pass.
  carvedAt(x, y, z) {
    if (y < CAVE_MIN_Y) return false;
    const h = this.heightAt(x, z);
    const top = this.carveTopFor(h);
    if (y > top) return false;
    let waterLim = 1 << 30;
    if (y <= SEA_LEVEL) {
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const nh = this.heightAt(x + dx, z + dz);
        if (nh < waterLim) waterLim = nh;
      }
    }
    const rv = this.ravineFor(x, z);
    if (rv.active && y >= rv.lo && y <= rv.hi && !(y <= SEA_LEVEL && y > waterLim)) return true;

    const gx = floorDiv(x, CG) * CG;
    const gz = floorDiv(z, CG) * CG;
    const gy = (y >> 2) << 2;
    const fx = (x - gx) / CG;
    const fz = (z - gz) / CG;
    const fy = (y - gy) / CG;
    // Corners in canonical order.
    const v = this.pointCorners; // 8 corners x 5 fields
    let n = 0;
    for (let dy = 0; dy <= 1; dy++) for (let dz = 0; dz <= 1; dz++) for (let dx = 0; dx <= 1; dx++) {
      this.caveCorner(gx + dx * CG, gy + dy * CG, gz + dz * CG);
      for (let f = 0; f < 5; f++) v[n * 5 + f] = this.corner[f];
      n++;
    }
    const out = this.pointFields;
    for (let f = 0; f < 5; f++) {
      // corner index = dx + dz*2 + dy*4
      const y0 = lerp(lerp(v[0 * 5 + f], v[1 * 5 + f], fx), lerp(v[2 * 5 + f], v[3 * 5 + f], fx), fz);
      const y1 = lerp(lerp(v[4 * 5 + f], v[5 * 5 + f], fx), lerp(v[6 * 5 + f], v[7 * 5 + f], fx), fz);
      out[f] = lerp(y0, y1, fy);
    }
    return Generator.carveRule(out[0], out[1], out[2], out[3], out[4], y, h, waterLim);
  }

  // Bulk cave carving for the chunk. topY[col] receives the original surface height.
  carveChunk(data, cx, cz, colH) {
    const x0 = cx * CS;
    const z0 = cz * CS;
    const GX = this.GX;
    const GY = this.GY;
    // Highest y any column may carve -> how many lattice rows we need.
    let maxTop = 0;
    for (let i = 0; i < CA; i++) {
      const t = this.carveTopFor(colH[i]);
      if (t > maxTop) maxTop = t;
    }
    if (maxTop < CAVE_MIN_Y) return;
    const rows = Math.min(GY, (maxTop >> 2) + 2);
    const gCh = this.gCheese, gA = this.gA, gB = this.gB, gC = this.gC, gD = this.gD;
    const corner = this.corner;
    for (let gj = 0; gj < rows; gj++) {
      for (let gk = 0; gk < GX; gk++) {
        for (let gi = 0; gi < GX; gi++) {
          this.caveCorner(x0 + gi * CG, gj * CG, z0 + gk * CG);
          const k = gi + gk * GX + gj * GX * GX;
          gCh[k] = corner[0];
          gA[k] = corner[1];
          gB[k] = corner[2];
          gC[k] = corner[3];
          gD[k] = corner[4];
        }
      }
    }
    const cCh = this.colCheese, cA = this.colA, cB = this.colB, cC = this.colC, cD = this.colD;
    const wH = this.wH;
    for (let lz = 0; lz < CS; lz++) {
      const gk = lz >> 2;
      const fz = (lz & 3) / CG;
      for (let lx = 0; lx < CS; lx++) {
        const h = colH[lx + lz * CS];
        const top = this.carveTopFor(h);
        if (top < CAVE_MIN_Y) continue;
        const gi = lx >> 2;
        const fx = (lx & 3) / CG;
        // Water-adjacency guard from the 3x3 neighbourhood (window has a 1-block margin).
        let waterLim = 1 << 30;
        for (let dz = 0; dz <= 2; dz++) for (let dx = 0; dx <= 2; dx++) {
          const nh = wH[lx + dx + (lz + dz) * WIN];
          if (nh < waterLim) waterLim = nh;
        }
        const rv = this.ravineFor(x0 + lx, z0 + lz);
        const rvActive = rv.active;
        const rvLo = rv.lo, rvHi = rv.hi;
        // x/z interpolation of each lattice row for this column (same op order as carvedAt).
        const lastRow = Math.min(rows - 1, (top >> 2) + 1);
        for (let gj = 0; gj <= lastRow; gj++) {
          const k00 = gi + gk * GX + gj * GX * GX;
          const k10 = k00 + 1;
          const k01 = k00 + GX;
          const k11 = k01 + 1;
          cCh[gj] = lerp(lerp(gCh[k00], gCh[k10], fx), lerp(gCh[k01], gCh[k11], fx), fz);
          cA[gj] = lerp(lerp(gA[k00], gA[k10], fx), lerp(gA[k01], gA[k11], fx), fz);
          cB[gj] = lerp(lerp(gB[k00], gB[k10], fx), lerp(gB[k01], gB[k11], fx), fz);
          cC[gj] = lerp(lerp(gC[k00], gC[k10], fx), lerp(gC[k01], gC[k11], fx), fz);
          cD[gj] = lerp(lerp(gD[k00], gD[k10], fx), lerp(gD[k01], gD[k11], fx), fz);
        }
        let idx = lx + lz * CS + CAVE_MIN_Y * CA;
        for (let y = CAVE_MIN_Y; y <= top; y++, idx += CA) {
          if (rvActive && y >= rvLo && y <= rvHi && !(y <= SEA_LEVEL && y > waterLim)) {
            data[idx] = AIR;
            continue;
          }
          const gj = y >> 2;
          const fy = (y & 3) / CG;
          const ch = lerp(cCh[gj], cCh[gj + 1], fy);
          const a = lerp(cA[gj], cA[gj + 1], fy);
          const b = lerp(cB[gj], cB[gj + 1], fy);
          const c2 = lerp(cC[gj], cC[gj + 1], fy);
          const d2 = lerp(cD[gj], cD[gj + 1], fy);
          if (Generator.carveRule(ch, a, b, c2, d2, y, h, waterLim)) data[idx] = AIR;
        }
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // Ore veins and underground blobs. Veins are seeded per chunk and may spill into neighbours, so each
  // chunk replays the veins of its 3x3 neighbourhood and keeps the cells that land inside itself.

  placeVeins(data, cx, cz) {
    const x0 = cx * CS;
    const z0 = cz * CS;
    const px = new Int32Array(40);
    const py = new Int32Array(40);
    const pz = new Int32Array(40);
    for (let ncz = cz - 1; ncz <= cz + 1; ncz++) {
      for (let ncx = cx - 1; ncx <= cx + 1; ncx++) {
        const rng = mulberry32(hash2(this.sOre, ncx, ncz));
        for (let t = 0; t < VEIN_TYPES.length; t++) {
          const vt = VEIN_TYPES[t];
          // Fractional counts: e.g. 1.5 -> 1 or 2.
          const count = Math.floor(vt.count + rng());
          for (let v = 0; v < count; v++) {
            const ox = ncx * CS + Math.floor(rng() * CS);
            const oz = ncz * CS + Math.floor(rng() * CS);
            const oy = vt.minY + Math.floor(rng() * (vt.maxY - vt.minY));
            const size = vt.minSize + Math.floor(rng() * (vt.maxSize - vt.minSize + 1));
            const walkSeed = (rng() * 4294967296) | 0;
            // A blob of `size` cells built by random steps stays within ~size/2 of its origin; skip veins
            // that can't reach this chunk.
            const reach = (size >> 1) + 1;
            if (ox + reach < x0 || ox - reach >= x0 + CS || oz + reach < z0 || oz - reach >= z0 + CS) continue;
            const wr = mulberry32(walkSeed);
            let n = 1;
            px[0] = ox;
            py[0] = oy;
            pz[0] = oz;
            for (let s = 1; s < size; s++) {
              // Step from a random existing cell -> compact blobs rather than snakes.
              const from = Math.floor(wr() * n);
              let x = px[from], y = py[from], z = pz[from];
              const dir = Math.floor(wr() * 6);
              if (dir === 0) x++;
              else if (dir === 1) x--;
              else if (dir === 2) y++;
              else if (dir === 3) y--;
              else if (dir === 4) z++;
              else z--;
              // Clamp to the reach box so the skip test above stays valid.
              if (x > ox + reach || x < ox - reach || z > oz + reach || z < oz - reach) continue;
              px[n] = x;
              py[n] = y;
              pz[n] = z;
              n++;
            }
            for (let k = 0; k < n; k++) {
              const lx = px[k] - x0;
              const lz = pz[k] - z0;
              const y = py[k];
              if (lx < 0 || lx >= CS || lz < 0 || lz >= CS || y < 1 || y >= vt.maxY) continue;
              const idx = lx + lz * CS + y * CA;
              if (data[idx] === STONE) data[idx] = vt.block;
            }
          }
        }
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // Trees

  // Tree for a candidate lattice cell, or null. Pure function of the cell coordinates.
  treeForCell(tcx, tcz) {
    const r = hash2(this.sTree, tcx, tcz);
    const x = tcx * TREE_CELL + (r & 3) % 3; // jitter 0..2 keeps at least one block between trunks
    const z = tcz * TREE_CELL + ((r >>> 2) & 3) % 3;
    const roll = ((r >>> 8) & 0xffff) / 65536;
    const col = this.columnAt(x, z);
    const biome = col.biome;
    const h = col.h;
    if (h <= SEA_LEVEL + 1) return null;
    let density = 0;
    switch (biome) {
      case FOREST:
        density = 0.42 + 0.4 * smoothstep(-0.4, 0.4, this.nForest(x * (1 / 90), z * (1 / 90)));
        break;
      case BIRCH_FOREST:
        density = 0.36 + 0.3 * smoothstep(-0.4, 0.4, this.nForest(x * (1 / 90), z * (1 / 90)));
        break;
      case TAIGA:
        density = 0.38 + 0.35 * smoothstep(-0.4, 0.4, this.nForest(x * (1 / 90), z * (1 / 90)));
        break;
      case SNOWY:
        density = 0.05;
        break;
      case PLAINS:
        density = 0.014 + 0.05 * smoothstep(0.35, 0.7, this.nForest(x * (1 / 90), z * (1 / 90)));
        break;
      case MOUNTAINS:
        density = h < 84 + col.T * 20 ? 0.12 : 0;
        break;
      default:
        return null;
    }
    if (roll >= density) return null;
    // Must stand on grass that caves haven't removed.
    const top = this.surfaceTopAt(x, z);
    if (top !== GRASS && top !== SNOWY_GRASS) return null;
    if (this.carvedAt(x, h, z) || this.carvedAt(x, h - 1, z)) return null;

    const r2 = hash2(this.sTreeShape, x, z);
    const pick = (r2 & 0xff) / 256;
    let type;
    if (biome === FOREST) type = pick < 0.2 ? 'birch' : pick < 0.3 ? 'bigoak' : 'oak';
    else if (biome === BIRCH_FOREST) type = pick < 0.06 ? 'oak' : 'birch';
    else if (biome === PLAINS) type = pick < 0.15 ? 'bigoak' : 'oak';
    else type = pick < 0.2 ? 'bigspruce' : 'spruce';
    const hr = (r2 >>> 8) & 0xffff;
    let height;
    if (type === 'oak') height = 4 + (hr % 3); // 4..6
    else if (type === 'bigoak') height = 6 + (hr % 3); // 6..8
    else if (type === 'birch') height = 5 + (hr % 3); // 5..7
    else if (type === 'spruce') height = 6 + (hr % 4); // 6..9
    else height = 9 + (hr % 4); // 9..12
    if (h + height + 3 > MAX_Y) return null;
    return { x, z, base: h, type, height, seed: r2 };
  }

  placeTrees(data, cx, cz) {
    const x0 = cx * CS;
    const z0 = cz * CS;
    const tx0 = floorDiv(x0 - TREE_REACH - 2, TREE_CELL);
    const tx1 = floorDiv(x0 + CS - 1 + TREE_REACH, TREE_CELL);
    const tz0 = floorDiv(z0 - TREE_REACH - 2, TREE_CELL);
    const tz1 = floorDiv(z0 + CS - 1 + TREE_REACH, TREE_CELL);
    // Canonical global order (z, then x) so overlapping canopies resolve identically in every chunk.
    for (let tcz = tz0; tcz <= tz1; tcz++) {
      for (let tcx = tx0; tcx <= tx1; tcx++) {
        // Quick reject before any column work: the trunk lies in [tcx*4, tcx*4+2].
        const bx = tcx * TREE_CELL;
        const bz = tcz * TREE_CELL;
        if (bx + 2 + TREE_REACH < x0 || bx - TREE_REACH >= x0 + CS) continue;
        if (bz + 2 + TREE_REACH < z0 || bz - TREE_REACH >= z0 + CS) continue;
        const t = this.treeForCell(tcx, tcz);
        if (!t) continue;
        if (t.x + TREE_REACH < x0 || t.x - TREE_REACH >= x0 + CS) continue;
        if (t.z + TREE_REACH < z0 || t.z - TREE_REACH >= z0 + CS) continue;
        this.buildTree(data, x0, z0, t);
      }
    }
  }

  buildTree(data, x0, z0, t) {
    const lx = t.x - x0;
    const lz = t.z - z0;
    const base = t.base;
    const top = base + t.height;
    const sd = t.seed;
    let log, leaf;
    if (t.type === 'birch') {
      log = BIRCH_LOG;
      leaf = BIRCH_LEAVES;
    } else if (t.type === 'spruce' || t.type === 'bigspruce') {
      log = SPRUCE_LOG;
      leaf = SPRUCE_LEAVES;
    } else {
      log = LOG;
      leaf = LEAVES;
    }

    const putLeaf = (dx, y, dz) => {
      const x = lx + dx;
      const z = lz + dz;
      if (x < 0 || x >= CS || z < 0 || z >= CS || y < 0 || y > MAX_Y) return;
      const i = x + z * CS + y * CA;
      if (data[i] === AIR) data[i] = leaf;
    };
    // Randomised corner/edge leaves: deterministic per tree + offset.
    const chance = (dx, y, dz, p) => (hash3(sd, dx, y - base, dz) & 0xffff) < p * 65536;

    if (t.type === 'oak' || t.type === 'birch') {
      for (let y = top - 2; y <= top + 1; y++) {
        const r = y >= top ? 1 : 2;
        for (let dz = -r; dz <= r; dz++) {
          for (let dx = -r; dx <= r; dx++) {
            const corner = Math.abs(dx) === r && Math.abs(dz) === r;
            if (y === top + 1) {
              if (Math.abs(dx) + Math.abs(dz) > 1) continue;
            } else if (corner && !chance(dx, y, dz, 0.5)) continue;
            putLeaf(dx, y, dz);
          }
        }
      }
    } else if (t.type === 'bigoak') {
      // Rounded canopy, radius 3 in the middle layers.
      for (let y = top - 3; y <= top + 1; y++) {
        const k = y - (top - 3); // 0..4
        const r = k === 0 ? 2 : k <= 2 ? 3 : k === 3 ? 2 : 1;
        const rr = r * r + (r >= 2 ? 1.2 : 0.5);
        for (let dz = -r; dz <= r; dz++) {
          for (let dx = -r; dx <= r; dx++) {
            const d2 = dx * dx + dz * dz;
            if (d2 > rr) continue;
            if (d2 > (r - 1) * (r - 1) + 1 && !chance(dx, y, dz, 0.72)) continue;
            putLeaf(dx, y, dz);
          }
        }
      }
    } else {
      // Spruce: tiered cone, tip above the trunk.
      const big = t.type === 'bigspruce';
      const rmax = big ? 3 : 2;
      const bottom = base + (big ? 3 : 2) + (sd >>> 24) % 2;
      putLeaf(0, top + 1, 0);
      for (let y = top; y >= bottom; y--) {
        const k = top - y; // 0 at the trunk top
        let r;
        if (k === 0) r = 1;
        else {
          const large = Math.min(rmax, 1 + (k >> 1));
          r = k & 1 ? Math.max(1, large - 1) : large;
        }
        for (let dz = -r; dz <= r; dz++) {
          for (let dx = -r; dx <= r; dx++) {
            const m = Math.abs(dx) + Math.abs(dz);
            if (r === 1 ? m > 1 : m > r + 1) continue;
            if (r >= 2 && m === r + 1 && !chance(dx, y, dz, 0.6)) continue;
            putLeaf(dx, y, dz);
          }
        }
      }
    }

    // Trunk last: it overrides leaves (from this or any other tree).
    if (lx >= 0 && lx < CS && lz >= 0 && lz < CS) {
      const col = lx + lz * CS;
      data[col + base * CA] = DIRT;
      for (let y = base + 1; y <= top; y++) {
        const i = col + y * CA;
        const b = data[i];
        if (b === AIR || b === LEAVES || b === BIRCH_LEAVES || b === SPRUCE_LEAVES || b === TALL_GRASS) data[i] = log;
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // Whole chunk

  generate(cx, cz) {
    const data = new Uint8Array(CHUNK_VOLUME);
    this.prepareWindow(cx, cz);
    const x0 = cx * CS;
    const z0 = cz * CS;
    const colH = new Int32Array(CA);
    const colTop = new Uint8Array(CA); // surface block id per column (for the post-cave regrow pass)
    const wH = this.wH;

    // 1. Terrain columns.
    for (let lz = 0; lz < CS; lz++) {
      for (let lx = 0; lx < CS; lx++) {
        const k = lx + 1 + (lz + 1) * WIN;
        const h = wH[k];
        const x = x0 + lx;
        const z = z0 + lz;
        const slope = Math.max(
          Math.abs(wH[k + 1] - h), Math.abs(wH[k - 1] - h),
          Math.abs(wH[k + WIN] - h), Math.abs(wH[k - WIN] - h));
        const s = this.surfaceFor(x, z, h, this.wBiome[k], this.wT[k], this.wHu[k], this.wMh[k], this.wC[k], slope);
        const ci = lx + lz * CS;
        colH[ci] = h;
        colTop[ci] = s.top;
        // Bedrock: solid floor plus a ragged layer at y 1..3.
        data[ci] = BEDROCK;
        const fillerBottom = h - s.depth;
        const deepBottom = fillerBottom - s.deepDepth;
        for (let y = 1; y < h; y++) {
          let b;
          if (y <= 3 && rand3(this.sBedrock, x, y, z) < (y === 1 ? 0.62 : y === 2 ? 0.36 : 0.14)) b = BEDROCK;
          else if (y >= fillerBottom) b = s.filler;
          else if (y >= deepBottom) b = s.deep;
          else b = STONE;
          data[ci + y * CA] = b;
        }
        data[ci + h * CA] = s.top;
      }
    }

    // 2. Caves and ravines.
    this.carveChunk(data, cx, cz, colH);

    // 3. Underground blobs and ores.
    this.placeVeins(data, cx, cz);

    // 4. Water (only above the heightmap, so it never fills caves) and ice on cold water.
    for (let lz = 0; lz < CS; lz++) {
      for (let lx = 0; lx < CS; lx++) {
        const ci = lx + lz * CS;
        const h = colH[ci];
        if (h >= SEA_LEVEL) continue;
        for (let y = h + 1; y <= SEA_LEVEL; y++) data[ci + y * CA] = WATER;
        const k = lx + 1 + (lz + 1) * WIN;
        const T = this.wT[k] + this.nJit(x0 + lx + 0.5, z0 + lz + 0.5) * 0.02;
        if (T < T_SNOWY + 0.02) data[ci + SEA_LEVEL * CA] = ICE;
      }
    }

    // 5. Where a cave entrance removed the surface, let grass regrow on the newly exposed dirt.
    for (let ci = 0; ci < CA; ci++) {
      const h = colH[ci];
      if (h < SEA_LEVEL || data[ci + h * CA] !== AIR) continue;
      const topBlock = colTop[ci];
      if (topBlock !== GRASS && topBlock !== SNOWY_GRASS) continue;
      let y = h - 1;
      while (y > 0 && data[ci + y * CA] === AIR) y--;
      if (data[ci + y * CA] === DIRT) data[ci + y * CA] = topBlock;
    }

    // 6. Trees (may come from neighbouring chunks).
    this.placeTrees(data, cx, cz);

    // 7. Ground plants, cacti, pumpkins and melons (column-local).
    this.placePlants(data, cx, cz, colH);

    return data;
  }

  placePlants(data, cx, cz, colH) {
    const x0 = cx * CS;
    const z0 = cz * CS;

    // Cacti on a coarse lattice (keeps them spaced apart).
    const cx0 = floorDiv(x0, CACTUS_CELL), cx1 = floorDiv(x0 + CS - 1, CACTUS_CELL);
    const cz0 = floorDiv(z0, CACTUS_CELL), cz1 = floorDiv(z0 + CS - 1, CACTUS_CELL);
    for (let ccz = cz0; ccz <= cz1; ccz++) {
      for (let ccx = cx0; ccx <= cx1; ccx++) {
        const r = hash2(this.sCactus, ccx, ccz);
        if ((r & 0xff) >= 80) continue; // ~31% of cells
        const x = ccx * CACTUS_CELL + ((r >>> 8) & 7) % 4;
        const z = ccz * CACTUS_CELL + ((r >>> 11) & 7) % 4;
        const lx = x - x0, lz = z - z0;
        if (lx < 0 || lx >= CS || lz < 0 || lz >= CS) continue;
        const k = lx + 1 + (lz + 1) * WIN;
        if (this.wBiome[k] !== DESERT) continue;
        const ci = lx + lz * CS;
        const h = colH[ci];
        if (data[ci + h * CA] !== SAND) continue;
        const height = 1 + ((r >>> 16) % 3);
        for (let y = h + 1; y <= h + height && y <= MAX_Y; y++) {
          if (data[ci + y * CA] !== AIR) break;
          data[ci + y * CA] = CACTUS;
        }
      }
    }

    // Pumpkin / melon patches near this chunk.
    const patches = [];
    const px0 = floorDiv(x0 - PATCH_RADIUS, PATCH_CELL), px1 = floorDiv(x0 + CS - 1 + PATCH_RADIUS, PATCH_CELL);
    const pz0 = floorDiv(z0 - PATCH_RADIUS, PATCH_CELL), pz1 = floorDiv(z0 + CS - 1 + PATCH_RADIUS, PATCH_CELL);
    for (let pcz = pz0; pcz <= pz1; pcz++) {
      for (let pcx = px0; pcx <= px1; pcx++) {
        const r = hash2(this.sPatch, pcx, pcz);
        if ((r & 0xff) >= 64) continue; // 25% of cells have a patch
        const px = pcx * PATCH_CELL + PATCH_RADIUS + ((r >>> 8) & 63) % (PATCH_CELL - 2 * PATCH_RADIUS);
        const pz = pcz * PATCH_CELL + PATCH_RADIUS + ((r >>> 14) & 63) % (PATCH_CELL - 2 * PATCH_RADIUS);
        patches.push(px, pz, (r >>> 20) & 0xff);
      }
    }

    for (let lz = 0; lz < CS; lz++) {
      for (let lx = 0; lx < CS; lx++) {
        const ci = lx + lz * CS;
        const k = lx + 1 + (lz + 1) * WIN;
        const biome = this.wBiome[k];
        const x = x0 + lx;
        const z = z0 + lz;
        // Find the actual top (caves may have moved it).
        let y = colH[ci];
        if (y >= MAX_Y) continue;
        let ground = data[ci + y * CA];
        if (ground === AIR) {
          while (y > 0 && data[ci + y * CA] === AIR) y--;
          ground = data[ci + y * CA];
        }
        if (y >= MAX_Y || y < SEA_LEVEL) continue;
        const above = ci + (y + 1) * CA;
        if (data[above] !== AIR) continue;
        const r = rand2(this.sPlant, x, z);

        if (biome === DESERT || biome === BEACH) {
          if (ground === SAND && biome === DESERT && r < 0.012) data[above] = DEAD_BUSH;
          continue;
        }
        if (ground !== GRASS) continue;

        // Pumpkins and melons.
        if (patches.length && (biome === PLAINS || biome === FOREST || biome === TAIGA || biome === BIRCH_FOREST)) {
          let placed = false;
          for (let p = 0; p < patches.length; p += 3) {
            const dx = x - patches[p], dz = z - patches[p + 1];
            if (dx * dx + dz * dz > PATCH_RADIUS * PATCH_RADIUS) continue;
            if (r < 0.3) {
              const warm = this.wT[k] > 0.05 && biome !== TAIGA;
              data[above] = warm && patches[p + 2] < 100 ? MELON : PUMPKIN;
              placed = true;
            }
            break;
          }
          if (placed) continue;
        }

        let pFlower = 0, pGrass = 0;
        const fpatch = this.nFlower(x * (1 / 22), z * (1 / 22));
        switch (biome) {
          case PLAINS:
            pFlower = fpatch > 0.3 ? 0.1 : 0.006;
            pGrass = 0.12 + 0.2 * smoothstep(-0.5, 0.5, this.nPatch(x * (1 / 11) + 40, z * (1 / 11)));
            break;
          case FOREST:
            pFlower = fpatch > 0.45 ? 0.05 : 0.004;
            pGrass = 0.1;
            break;
          case BIRCH_FOREST:
            pFlower = fpatch > 0.25 ? 0.07 : 0.01;
            pGrass = 0.09;
            break;
          case TAIGA:
            pGrass = 0.13;
            break;
          case MOUNTAINS:
            pFlower = 0.004;
            pGrass = 0.06;
            break;
          default:
            break;
        }
        if (r < pFlower) {
          // Patches are mostly one colour.
          const red = this.nFlower(x * (1 / 40) + 90, z * (1 / 40)) + (rand2(this.sPlant + 1, x, z) - 0.5) * 0.6 > 0;
          data[above] = red ? FLOWER_RED : FLOWER_YELLOW;
        } else if (r < pFlower + pGrass) {
          data[above] = TALL_GRASS;
        }
      }
    }
  }
}

// Vein/blob table: count per chunk (fractional = probabilistic), y range [minY, maxY), size range.
const VEIN_TYPES = [
  { block: DIRT, count: 5, minY: 5, maxY: 100, minSize: 14, maxSize: 26 },
  { block: GRAVEL, count: 4, minY: 5, maxY: 100, minSize: 14, maxSize: 26 },
  { block: COAL_ORE, count: 18, minY: 5, maxY: 100, minSize: 6, maxSize: 14 },
  { block: IRON_ORE, count: 11, minY: 4, maxY: 64, minSize: 4, maxSize: 9 },
  { block: GOLD_ORE, count: 2.2, minY: 4, maxY: 32, minSize: 4, maxSize: 8 },
  { block: DIAMOND_ORE, count: 1.1, minY: 4, maxY: 16, minSize: 3, maxSize: 7 },
];

function classifyBiome(h, T, Hu, mh, c, valley) {
  if (h < SEA_LEVEL) return OCEAN;
  if (mh > 12 && h > 70) return MOUNTAINS;
  if (h <= SEA_LEVEL + 2 && mh < 6 && (c < 0.1 || valley > 0.35)) return BEACH;
  if (T < T_SNOWY) return SNOWY;
  if (T < T_TAIGA) return TAIGA;
  if (T > T_DESERT && Hu < HU_DESERT) return DESERT;
  if (Hu > HU_FOREST) return T < T_BIRCH ? BIRCH_FOREST : FOREST;
  return PLAINS;
}

// ---------------------------------------------------------------------------------------------
// Per-seed caches

const generators = new Map();
function normSeed(seed) {
  return typeof seed === 'number' && Number.isInteger(seed) ? seed | 0 : hashSeed(seed);
}
function getGenerator(seed) {
  const s = normSeed(seed);
  let g = generators.get(s);
  if (!g) {
    if (generators.size >= 4) generators.delete(generators.keys().next().value);
    g = new Generator(s);
    generators.set(s, g);
  }
  return g;
}

// ---------------------------------------------------------------------------------------------
// Public API

/** Generate the blocks of chunk (cx, cz). Returns a fresh Uint8Array(CHUNK_VOLUME). */
export function generateChunk(cx, cz, seed) {
  return getGenerator(seed).generate(cx | 0, cz | 0);
}

/** Biome name at world column (x, z). */
export function biomeAt(x, z, seed) {
  const g = getGenerator(seed);
  return BIOME_NAMES[g.computeColumn(Math.floor(x), Math.floor(z), g.col).biome];
}

/** Terrain surface height (before caves/trees) at world column (x, z). Not part of the core contract. */
export function terrainHeightAt(x, z, seed) {
  const g = getGenerator(seed);
  return g.computeColumn(Math.floor(x), Math.floor(z), g.col).h;
}

/**
 * Spawn point: feet position {x, y, z} (block centre) on dry, solid ground near the origin with two air
 * blocks above. Prefers grassy biomes, searching outward in rings; falls back to any dry land.
 */
export function findSpawn(seed) {
  const g = getGenerator(seed);
  const chunks = new Map();
  const getChunk = (cx, cz) => {
    const key = cx + ',' + cz;
    let c = chunks.get(key);
    if (!c) {
      if (chunks.size > 64) chunks.clear();
      c = g.generate(cx, cz);
      chunks.set(key, c);
    }
    return c;
  };
  const col = { h: 0, biome: 0, T: 0, Hu: 0, mh: 0, c: 0, valley: 0 };
  const GOOD = new Set([PLAINS, FOREST, BIRCH_FOREST, TAIGA, SNOWY]);
  const OK = new Set([PLAINS, FOREST, BIRCH_FOREST, TAIGA, SNOWY, DESERT, BEACH, MOUNTAINS]);
  const STANDABLE = new Set([GRASS, SNOWY_GRASS, DIRT, SAND, STONE, GRAVEL, SNOW, SANDSTONE, CLAY]);

  const tryColumn = (x, z, accept) => {
    g.computeColumn(x, z, col);
    if (col.h <= SEA_LEVEL || !accept.has(col.biome)) return null;
    const data = getChunk(Math.floor(x / CS), Math.floor(z / CS));
    const lx = ((x % CS) + CS) % CS;
    const lz = ((z % CS) + CS) % CS;
    // Topmost non-air block of the column.
    let y = MAX_Y - 2;
    while (y > 0 && data[lx + lz * CS + y * CA] === AIR) y--;
    const b = data[lx + lz * CS + y * CA];
    if (!STANDABLE.has(b) || y <= SEA_LEVEL) return null;
    if (data[lx + lz * CS + (y + 1) * CA] !== AIR || data[lx + lz * CS + (y + 2) * CA] !== AIR) return null;
    return { x: x + 0.5, y: y + 1, z: z + 0.5 };
  };

  // Square rings outward from the origin, sampling every 4 blocks.
  for (const accept of [GOOD, OK]) {
    for (let r = 0; r <= 1024; r += 4) {
      if (r === 0) {
        const p = tryColumn(0, 0, accept);
        if (p) return p;
        continue;
      }
      for (let i = -r; i < r; i += 4) {
        const cands = [[i, -r], [r, i], [-i, r], [-r, -i]];
        for (const [x, z] of cands) {
          const p = tryColumn(x, z, accept);
          if (p) return p;
        }
      }
    }
  }
  // Practically unreachable: no dry land within 1 km. Stand on top of the origin column anyway.
  const data = getChunk(0, 0);
  let y = MAX_Y - 2;
  while (y > 0 && data[y * CA] === AIR) y--;
  return { x: 0.5, y: y + 1, z: 0.5 };
}
