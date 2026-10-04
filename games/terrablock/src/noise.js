// Seeded noise and hashing utilities for Terrablock world generation.
// Pure and dependency-free: safe to import from module Workers and from Node tests.
//
// Exports:
//   hashSeed(str)                    string/number -> 32-bit signed int seed
//   mixSeed(seed, salt)              derive an independent sub-seed
//   mulberry32(seed)                 small fast PRNG -> () => [0, 1)
//   hash2(seed, x, z) / hash3(...)   integer coordinate hashes -> uint32
//   rand2(seed, x, z) / rand3(...)   the same mapped to [0, 1)
//   createNoise2D(seed)              simplex noise (x, y) -> [-1, 1]
//   createNoise3D(seed)              simplex noise (x, y, z) -> [-1, 1]
//   fbm2 / fbm3 / ridged2            fractal sums of the above, normalised to about [-1, 1] ([0, 1] for ridged)

// ---------------------------------------------------------------------------------------------
// Integer hashing

// Murmur3 32-bit finaliser: good avalanche, cheap.
function fmix32(h) {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Turn a user-entered seed into a 32-bit signed integer.
 * Integer strings ("12345", "-7") parse as numbers (wrapped to 32 bits); anything else is hashed.
 */
export function hashSeed(str) {
  if (typeof str === 'number') {
    if (Number.isInteger(str)) return Number(BigInt.asIntN(32, BigInt(str)));
    str = String(str);
  }
  if (typeof str === 'bigint') return Number(BigInt.asIntN(32, str));
  const s = String(str == null ? '' : str).trim();
  if (/^[+-]?\d+$/.test(s)) return Number(BigInt.asIntN(32, BigInt(s)));
  // FNV-1a over UTF-16 code units, then a finaliser so short strings spread across all bits.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return fmix32(h ^ s.length) | 0;
}

/** Derive a sub-seed from a seed and a small integer/string salt. */
export function mixSeed(seed, salt) {
  if (typeof salt === 'string') salt = hashSeed('salt:' + salt);
  return fmix32((seed | 0) ^ fmix32(Math.imul((salt | 0) + 0x632be5ab, 0x9e3779b1))) | 0;
}

/** Mulberry32 PRNG. Returns a function producing floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed | 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hash of an integer 2D coordinate -> uint32. */
export function hash2(seed, x, z) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(z | 0, 0x165667b1) ^ (seed | 0);
  return fmix32(h);
}

/** Hash of an integer 3D coordinate -> uint32. */
export function hash3(seed, x, y, z) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x61c88647) ^ Math.imul(z | 0, 0x165667b1);
  return fmix32(h ^ (seed | 0));
}

const INV_2_32 = 1 / 4294967296;
export function rand2(seed, x, z) {
  return hash2(seed, x, z) * INV_2_32;
}
export function rand3(seed, x, y, z) {
  return hash3(seed, x, y, z) * INV_2_32;
}

// ---------------------------------------------------------------------------------------------
// Simplex noise (after Stefan Gustavson's public-domain reference implementation), with a
// permutation table shuffled by a seeded PRNG.

// 3D gradients: 64 unit vectors spread evenly over the sphere (Fibonacci lattice). The classic 12
// cube-edge gradients make the zero set of 3D simplex noise contain long straight 45-degree segments,
// which show up as unnaturally straight cave tunnels; well-spread directions avoid that.
const GRAD3 = new Float64Array(64 * 3);
for (let i = 0; i < 64; i++) {
  const y = 1 - ((i + 0.5) / 64) * 2;
  const r = Math.sqrt(1 - y * y);
  const phi = i * Math.PI * (3 - Math.sqrt(5)) + 0.3;
  GRAD3[i * 3] = Math.cos(phi) * r;
  GRAD3[i * 3 + 1] = y;
  GRAD3[i * 3 + 2] = Math.sin(phi) * r;
}

// 2D gradients: 16 directions evenly spread around the circle (less axis bias than the 12 3D ones).
const GRAD2 = new Float64Array(32);
for (let i = 0; i < 16; i++) {
  const a = (i / 16) * Math.PI * 2 + Math.PI / 16;
  GRAD2[i * 2] = Math.cos(a);
  GRAD2[i * 2 + 1] = Math.sin(a);
}

function buildPerm(seed) {
  const rnd = mulberry32(mixSeed(seed, 0x5eed));
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  return perm;
}

// Fast floor for values well inside the int32 range.
function ifloor(v) {
  const i = v | 0;
  return v < i ? i - 1 : i;
}

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;
const F3 = 1 / 3;
const G3 = 1 / 6;

/** Seeded 2D simplex noise. Returns (x, y) => value in [-1, 1]. */
export function createNoise2D(seed) {
  const perm = buildPerm(seed);
  const gIdx = new Uint8Array(512);
  for (let i = 0; i < 512; i++) gIdx[i] = (perm[i] & 15) * 2;

  return function noise2D(x, y) {
    const s = (x + y) * F2;
    const i = ifloor(x + s);
    const j = ifloor(y + s);
    const t = (i + j) * G2;
    const x0 = x - (i - t);
    const y0 = y - (j - t);
    let i1, j1;
    if (x0 > y0) {
      i1 = 1;
      j1 = 0;
    } else {
      i1 = 0;
      j1 = 1;
    }
    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;
    const ii = i & 255;
    const jj = j & 255;
    let n = 0;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) {
      const g = gIdx[ii + perm[jj]];
      t0 *= t0;
      n += t0 * t0 * (GRAD2[g] * x0 + GRAD2[g + 1] * y0);
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) {
      const g = gIdx[ii + i1 + perm[jj + j1]];
      t1 *= t1;
      n += t1 * t1 * (GRAD2[g] * x1 + GRAD2[g + 1] * y1);
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) {
      const g = gIdx[ii + 1 + perm[jj + 1]];
      t2 *= t2;
      n += t2 * t2 * (GRAD2[g] * x2 + GRAD2[g + 1] * y2);
    }
    // 99.2 scales unit-length gradients to roughly [-1, 1].
    return 99.2 * n;
  };
}

/** Seeded 3D simplex noise. Returns (x, y, z) => value in [-1, 1]. */
export function createNoise3D(seed) {
  const perm = buildPerm(mixSeed(seed, 3));
  const gIdx = new Uint8Array(512);
  for (let i = 0; i < 512; i++) gIdx[i] = (perm[i] & 63) * 3;

  return function noise3D(x, y, z) {
    const s = (x + y + z) * F3;
    const i = ifloor(x + s);
    const j = ifloor(y + s);
    const k = ifloor(z + s);
    const t = (i + j + k) * G3;
    const x0 = x - (i - t);
    const y0 = y - (j - t);
    const z0 = z - (k - t);
    let i1, j1, k1, i2, j2, k2;
    if (x0 >= y0) {
      if (y0 >= z0) {
        i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0;
      } else if (x0 >= z0) {
        i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1;
      } else {
        i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1;
      }
    } else if (y0 < z0) {
      i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1;
    } else if (x0 < z0) {
      i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1;
    } else {
      i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0;
    }
    const x1 = x0 - i1 + G3;
    const y1 = y0 - j1 + G3;
    const z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2 * G3;
    const y2 = y0 - j2 + 2 * G3;
    const z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 1 + 3 * G3;
    const y3 = y0 - 1 + 3 * G3;
    const z3 = z0 - 1 + 3 * G3;
    const ii = i & 255;
    const jj = j & 255;
    const kk = k & 255;
    let n = 0;
    let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
    if (t0 > 0) {
      const g = gIdx[ii + perm[jj + perm[kk]]];
      t0 *= t0;
      n += t0 * t0 * (GRAD3[g] * x0 + GRAD3[g + 1] * y0 + GRAD3[g + 2] * z0);
    }
    let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
    if (t1 > 0) {
      const g = gIdx[ii + i1 + perm[jj + j1 + perm[kk + k1]]];
      t1 *= t1;
      n += t1 * t1 * (GRAD3[g] * x1 + GRAD3[g + 1] * y1 + GRAD3[g + 2] * z1);
    }
    let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
    if (t2 > 0) {
      const g = gIdx[ii + i2 + perm[jj + j2 + perm[kk + k2]]];
      t2 *= t2;
      n += t2 * t2 * (GRAD3[g] * x2 + GRAD3[g + 1] * y2 + GRAD3[g + 2] * z2);
    }
    let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
    if (t3 > 0) {
      const g = gIdx[ii + 1 + perm[jj + 1 + perm[kk + 1]]];
      t3 *= t3;
      n += t3 * t3 * (GRAD3[g] * x3 + GRAD3[g + 1] * y3 + GRAD3[g + 2] * z3);
    }
    return 32 * n;
  };
}

// ---------------------------------------------------------------------------------------------
// Fractal helpers. Each octave is offset so octaves don't all share a lattice point at the origin.

/** Fractal Brownian motion of a 2D noise function, normalised to about [-1, 1]. */
export function fbm2(noise, x, y, octaves = 4, lacunarity = 2, gain = 0.5) {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise(x * f + o * 17.31, y * f - o * 29.17);
    norm += amp;
    amp *= gain;
    f *= lacunarity;
  }
  return sum / norm;
}

/** Fractal Brownian motion of a 3D noise function, normalised to about [-1, 1]. */
export function fbm3(noise, x, y, z, octaves = 3, lacunarity = 2, gain = 0.5) {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise(x * f + o * 17.31, y * f + o * 7.91, z * f - o * 29.17);
    norm += amp;
    amp *= gain;
    f *= lacunarity;
  }
  return sum / norm;
}

/**
 * Ridged multifractal: sharp crests where the underlying noise crosses zero. Returns about [0, 1].
 * Each octave is weighted by the previous one so detail concentrates on the ridges.
 */
export function ridged2(noise, x, y, octaves = 4, lacunarity = 2, gain = 0.5) {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = 1;
  let weight = 1;
  for (let o = 0; o < octaves; o++) {
    let v = 1 - Math.abs(noise(x * f + o * 17.31, y * f - o * 29.17));
    v *= v;
    v *= weight;
    weight = v * 1.5;
    if (weight > 1) weight = 1;
    sum += v * amp;
    norm += amp;
    amp *= gain;
    f *= lacunarity;
  }
  return sum / norm;
}
