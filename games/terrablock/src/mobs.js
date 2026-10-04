// Terrablock mobs: two grazing animals and two night/underground monsters, all original designs.
//
//   Burrowbuck  - stubby, long-eared grazer with a dark dorsal stripe and a pale rump flag. Drops raw meat.
//   Puffwick    - round cloud of wool on stubby charcoal legs with a wool fringe cap. Drops white wool.
//   Cairnwalker - hunched night walker made of stacked stone, ember eyes under a heavy brow and a little cairn of
//                 stones piled on its back. Slow, telegraphed two-armed slam.
//   Skitterjaw  - low, eight-legged indigo crawler with amber bands, snapping mandibles and big folded hind legs
//                 it uses to leap at its prey.
//
// Every model is built from boxes measured in "model pixels" (1/16 block). Each species gets one procedurally
// painted canvas texture (auto-packed box unwraps) and one geometry per part, shared by every mob of that
// species; each mob owns only its materials (so hurt flashes / lighting / fades are per mob).

import * as THREE from '../vendor/three.module.min.js';
import { GRAVITY, JUMP_VELOCITY, WORLD_HEIGHT, PLAYER_WIDTH, PLAYER_HEIGHT, PLAYER_EYE } from './config.js';
import { B, isOpaque, isSolid as idIsSolid } from './blocks.js';
import { I } from './items.js';

const PX = 1 / 16;
const TAU = Math.PI * 2;
const PASSIVE_CAP = 10;
const HOSTILE_CAP = 8;
const UNDERGROUND_CAP_OUTDOORS = 3; // cave monsters allowed while the player is under the open sky
const DESPAWN_DISTANCE = 64;
const CAVE_LIGHT = 0.3; // matches the mesher's skylight value below a column's top
const E = 1e-3; // collision epsilon (blocks)

// ---------------------------------------------------------------------------------------------
// Small helpers.

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const smooth = (t) => t * t * (3 - 2 * t);

function wrapAngle(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}
function approach(cur, target, step) {
  return cur < target ? Math.min(target, cur + step) : Math.max(target, cur - step);
}
function approachAngle(cur, target, step) {
  const d = wrapAngle(target - cur);
  return Math.abs(d) <= step ? target : cur + Math.sign(d) * step;
}

// Deterministic integer hash -> [0, 1). Used for texture noise so every texture is identical each run.
function hash3(x, y, s) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// Colours are [r, g, b] in 0..255.
const hex = (n) => [(n >> 16) & 255, (n >> 8) & 255, n & 255];
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const shade = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
// Brightness jitter from the per-pixel (n) and 2x2-cell (n2) noise of the paint context.
const vary = (c, p, amt = 0.12) => shade(c, 1 + (p.n - 0.5) * amt + (p.n2 - 0.5) * amt * 0.7);

// ---------------------------------------------------------------------------------------------
// Box model building blocks.
//
// A part is { id, parent?, pivot:[x,y,z], size:[w,h,d], offset?:[x,y,z], rot?:[x,y,z], paint?, glow? } in model
// pixels. `pivot` is relative to the parent's pivot (or the model origin = centre of the feet), the box centre sits
// at pivot + offset, and +z is the creature's forward direction.
//
// Each box face is painted upright as seen from outside. Unwrap layout of a part (w x h x d):
//          [ top w*d ][ bottom w*d ]
//   [ -x d*h ][ front w*h ][ +x d*h ][ back w*h ]

const FACES = [
  // corners: bottom-left, bottom-right, top-right, top-left as seen from outside the face
  { id: 'px', shade: 0.8, c: [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]] },
  { id: 'nx', shade: 0.8, c: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]] },
  { id: 'py', shade: 1.0, c: [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]] },
  { id: 'ny', shade: 0.55, c: [[1, -1, 1], [-1, -1, 1], [-1, -1, -1], [1, -1, -1]] },
  { id: 'pz', shade: 0.92, c: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
  { id: 'nz', shade: 0.72, c: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]] },
];

function faceRect(face, rx, ry, w, h, d) {
  switch (face) {
    case 'py': return [rx + d, ry, w, d];
    case 'ny': return [rx + d + w, ry, w, d];
    case 'nx': return [rx, ry + d, d, h];
    case 'pz': return [rx + d, ry + d, w, h];
    case 'px': return [rx + d + w, ry + d, d, h];
    default: return [rx + 2 * d + w, ry + d, w, h]; // nz
  }
}

// Builds the shared texture + per-part geometries (+ a glow material when the species has glowing parts).
function buildSpeciesAssets(spec) {
  const items = spec.parts.map((p) => ({ p, w: 2 * (p.size[0] + p.size[2]), h: p.size[2] + p.size[1], x: 0, y: 0 }));
  let texW = 64;
  while (items.some((it) => it.w + 1 > texW)) texW *= 2;
  // Shelf packing, tallest first, 1 px gutter.
  const sorted = items.slice().sort((a, b) => b.h - a.h || b.w - a.w);
  let cx = 0;
  let cy = 0;
  let rowH = 0;
  for (const it of sorted) {
    if (cx + it.w > texW) {
      cx = 0;
      cy += rowH + 1;
      rowH = 0;
    }
    it.x = cx;
    it.y = cy;
    cx += it.w + 1;
    rowH = Math.max(rowH, it.h);
  }
  let texH = 16;
  while (texH < cy + rowH) texH *= 2;

  const canvas = document.createElement('canvas');
  canvas.width = texW;
  canvas.height = texH;
  const g = canvas.getContext('2d');
  const img = g.createImageData(texW, texH);
  const data = img.data;
  const seed = spec.seed;
  const pc = { face: '', x: 0, y: 0, w: 0, h: 0, gx: 0, gy: 0, n: 0, n2: 0, n4: 0, part: '' };

  for (const it of items) {
    const { p } = it;
    const [w, h, d] = p.size;
    const paint = p.paint || spec.paint;
    for (const f of FACES) {
      const [fx, fy, fw, fh] = faceRect(f.id, it.x, it.y, w, h, d);
      for (let y = 0; y < fh; y++) {
        for (let x = 0; x < fw; x++) {
          const gx = fx + x;
          const gy = fy + y;
          pc.face = f.id; pc.x = x; pc.y = y; pc.w = fw; pc.h = fh; pc.gx = gx; pc.gy = gy; pc.part = p.id;
          pc.n = hash3(gx, gy, seed);
          pc.n2 = hash3(gx >> 1, gy >> 1, seed + 7);
          pc.n4 = hash3(gx >> 2, gy >> 2, seed + 13);
          const col = paint(pc);
          const o = (gy * texW + gx) * 4;
          data[o] = clamp(Math.round(col[0]), 0, 255);
          data[o + 1] = clamp(Math.round(col[1]), 0, 255);
          data[o + 2] = clamp(Math.round(col[2]), 0, 255);
          data[o + 3] = 255;
        }
      }
    }
  }
  g.putImageData(img, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.name = spec.key;

  const geometries = {};
  for (const it of items) geometries[it.p.id] = buildBoxGeometry(it.p, it.x, it.y, texW, texH);

  const glowMaterial = spec.parts.some((p) => p.glow)
    ? new THREE.MeshBasicMaterial({ map: texture, vertexColors: true, toneMapped: false })
    : null;
  return { texture, geometries, glowMaterial, canvas };
}

function buildBoxGeometry(part, rx, ry, texW, texH) {
  const [w, h, d] = part.size;
  const [ox, oy, oz] = part.offset || [0, 0, 0];
  const pos = new Float32Array(24 * 3);
  const uv = new Float32Array(24 * 2);
  const col = new Float32Array(24 * 3);
  const idx = new Uint16Array(36);
  const inset = 0.02; // texels; keeps nearest sampling inside each face rect
  let v = 0;
  let i = 0;
  for (const f of FACES) {
    const [fx, fy, fw, fh] = faceRect(f.id, rx, ry, w, h, d);
    const u0 = (fx + inset) / texW;
    const u1 = (fx + fw - inset) / texW;
    const vTop = 1 - (fy + inset) / texH;
    const vBot = 1 - (fy + fh - inset) / texH;
    const uvs = [[u0, vBot], [u1, vBot], [u1, vTop], [u0, vTop]];
    for (let k = 0; k < 4; k++) {
      const s = f.c[k];
      pos[(v + k) * 3] = (ox + (s[0] * w) / 2) * PX;
      pos[(v + k) * 3 + 1] = (oy + (s[1] * h) / 2) * PX;
      pos[(v + k) * 3 + 2] = (oz + (s[2] * d) / 2) * PX;
      uv[(v + k) * 2] = uvs[k][0];
      uv[(v + k) * 2 + 1] = uvs[k][1];
      col[(v + k) * 3] = col[(v + k) * 3 + 1] = col[(v + k) * 3 + 2] = f.shade;
    }
    idx[i++] = v; idx[i++] = v + 1; idx[i++] = v + 2;
    idx[i++] = v; idx[i++] = v + 2; idx[i++] = v + 3;
    v += 4;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeBoundingSphere();
  return geo;
}

// Sets a part's rotation to its rest pose plus a delta.
function R(m, id, x = 0, y = 0, z = 0) {
  const p = m.parts[id];
  if (p) p.pivot.rotation.set(p.rest.x + x, p.rest.y + y, p.rest.z + z);
}

// ---------------------------------------------------------------------------------------------
// Species 1: Burrowbuck (passive, drops raw meat).

const BB = {
  fur: hex(0xb07f52), dark: hex(0x654228), cream: hex(0xe8d8b6), sock: hex(0x4a3424), pink: hex(0xd9988c),
  eye: hex(0x1a120e), eyeHi: hex(0xf4efe4), nose: hex(0x5e3934),
};
const bbFur = (c) => vary(c.n4 > 0.82 ? mix(BB.fur, BB.dark, 0.18) : BB.fur, c, 0.16);

const BURROWBUCK = {
  key: 'burrowbuck', name: 'Burrowbuck', hostile: false, seed: 1101,
  width: 0.7, height: 1.0, maxHealth: 8, walkSpeed: 1.3, runSpeed: 4.6, stride: 5.5, turnRate: 7,
  drops: [{ id: I.RAW_MEAT, min: 1, max: 2 }], voice: 1.25, step: 'grass', stepDist: 1.1,
  colors: [BB.fur, BB.cream, BB.dark],
  paint: bbFur,
  parts: [
    {
      id: 'body', pivot: [0, 8, 0], size: [10, 8, 12],
      paint(c) {
        const { face, x, y, w, h } = c;
        if (face === 'ny') return vary(BB.cream, c, 0.08);
        if (face === 'py') {
          if (Math.abs(x - (w - 1) / 2) <= 1 && c.n4 > 0.12) return vary(BB.dark, c, 0.15); // dorsal stripe
          return bbFur(c);
        }
        if (face === 'px' || face === 'nx') {
          if (y >= h - 2) return vary(BB.cream, c, 0.08);
          if (y === h - 3) return vary(mix(BB.fur, BB.cream, 0.5), c, 0.1);
          if (y === 0) return vary(mix(BB.fur, BB.dark, 0.35), c, 0.12);
          if (c.n2 > 0.88) return vary(mix(BB.fur, BB.cream, 0.4), c, 0.1); // faint dapples
          return bbFur(c);
        }
        if (face === 'nz') {
          // pale rump flag around the tail
          const dx = (x - (w - 1) / 2) / (w / 2);
          const dy = (y - h * 0.55) / (h / 2);
          if (dx * dx + dy * dy < 0.5) return vary(BB.cream, c, 0.08);
          return bbFur(c);
        }
        if (y >= h - 3) return vary(BB.cream, c, 0.08);
        return bbFur(c);
      },
    },
    {
      id: 'head', pivot: [0, 11, 5], size: [8, 7, 6], offset: [0, 1, 3],
      paint(c) {
        const { face, x, y, w, h } = c;
        if (face === 'ny') return vary(BB.cream, c, 0.08);
        if (face === 'py') return Math.abs(x - (w - 1) / 2) <= 0.5 ? vary(BB.dark, c, 0.1) : bbFur(c);
        if (face === 'pz') {
          const ex = x <= 2 ? x - 1 : x - 5; // eye-local x for the two 2x2 eyes at x 1..2 and 5..6
          if (y >= 2 && y <= 3 && ex >= 0 && ex <= 1) {
            if (y === 2 && ((x <= 2 && ex === 1) || (x > 2 && ex === 0))) return BB.eyeHi; // inner-top glint
            return BB.eye;
          }
          if (y === 1 && ((x >= 1 && x <= 2) || (x >= 5 && x <= 6))) return vary(mix(BB.fur, BB.dark, 0.4), c, 0.08);
          if ((x === 3 || x === 4) && y <= 3) return vary(mix(BB.fur, BB.cream, 0.55), c, 0.08); // blaze
          if (y >= 4) return vary(BB.cream, c, 0.08);
          return bbFur(c);
        }
        if (face === 'px' || face === 'nx') {
          if (y >= h - 2) return vary(BB.cream, c, 0.08);
          return bbFur(c);
        }
        return bbFur(c);
      },
    },
    {
      id: 'muzzle', parent: 'head', pivot: [0, -1, 6], size: [4, 3, 2], offset: [0, 0, 0.5],
      paint(c) {
        const { face, x, y } = c;
        if (face === 'pz') {
          if (y === 0 && (x === 1 || x === 2)) return BB.nose;
          if (y === 2 && (x === 1 || x === 2)) return vary(mix(BB.cream, BB.nose, 0.45), c, 0.05);
          return vary(BB.cream, c, 0.06);
        }
        if (face === 'py') return vary(mix(BB.fur, BB.cream, 0.5), c, 0.08);
        return vary(BB.cream, c, 0.08);
      },
    },
    { id: 'earL', parent: 'head', pivot: [2.5, 4.5, 2], size: [2, 9, 3], offset: [0, 4.5, 0], rot: [-0.25, 0, -0.18], paint: bbEar },
    { id: 'earR', parent: 'head', pivot: [-2.5, 4.5, 2], size: [2, 9, 3], offset: [0, 4.5, 0], rot: [-0.25, 0, 0.18], paint: bbEar },
    { id: 'legFL', pivot: [3, 5, 4], size: [3, 5, 3], offset: [0, -2.5, 0], paint: bbLeg },
    { id: 'legFR', pivot: [-3, 5, 4], size: [3, 5, 3], offset: [0, -2.5, 0], paint: bbLeg },
    { id: 'legBL', pivot: [3, 5, -4], size: [3, 5, 3], offset: [0, -2.5, 0], paint: bbLeg },
    { id: 'legBR', pivot: [-3, 5, -4], size: [3, 5, 3], offset: [0, -2.5, 0], paint: bbLeg },
    {
      id: 'tail', pivot: [0, 10, -6], size: [4, 4, 3], offset: [0, 0, -1],
      paint: (c) => vary(c.n > 0.7 ? mix(BB.cream, [255, 255, 255], 0.4) : BB.cream, c, 0.12),
    },
  ],
  animate(m, dt, t) {
    const a = m.walkAmt;
    const ph = m.walkPhase;
    const s = Math.sin(ph);
    const fleeing = m.state === 'flee';
    if (fleeing) {
      // bounding gait: front pair and hind pair move together
      R(m, 'legFL', -0.85 * s * a); R(m, 'legFR', -0.85 * s * a);
      R(m, 'legBL', 0.95 * s * a); R(m, 'legBR', 0.95 * s * a);
      R(m, 'body', 0.12 * Math.cos(ph) * a);
    } else {
      R(m, 'legFL', 0.6 * s * a); R(m, 'legBR', 0.6 * s * a);
      R(m, 'legFR', -0.6 * s * a); R(m, 'legBL', -0.6 * s * a);
      R(m, 'body');
    }
    m.anim.earBack = approach(m.anim.earBack || 0, fleeing ? 1 : 0, dt * 4);
    const eb = m.anim.earBack;
    const flick = Math.max(0, Math.sin(t * 0.9 + m.seed * 3) - 0.92) * 6; // occasional ear flick
    R(m, 'earL', -0.8 * eb + Math.sin(t * 2.1 + m.seed) * 0.05 + a * 0.12 * Math.sin(ph * 2), 0, -0.06 * Math.sin(t * 1.7 + m.seed) - flick * 0.25);
    R(m, 'earR', -0.8 * eb + Math.sin(t * 2.4 + m.seed) * 0.05 + a * 0.12 * Math.sin(ph * 2), 0, 0.06 * Math.sin(t * 1.5 + m.seed));
    const nibble = m.grazeAmt > 0.5 ? Math.sin(t * 13) * 0.06 : 0;
    R(m, 'head', m.headPitch + m.grazeAmt * 0.85 + nibble, m.headYaw, 0);
    R(m, 'muzzle', 0, 0, 0);
    R(m, 'tail', 0, Math.sin(t * 11) * 0.35 * (1 - a) * (m.grazeAmt > 0.5 ? 1 : 0.2), 0);
    m.bob = fleeing ? Math.abs(s) * 0.07 * a : Math.abs(s) * 0.015 * a;
  },
};
function bbEar(c) {
  const { face, x, y, w } = c;
  if (face === 'py' || y <= 1) return vary(BB.dark, c, 0.1); // dark tips
  if (face === 'pz') return y >= 8 ? bbFur(c) : vary(x === 0 || x === w - 1 ? mix(BB.pink, BB.fur, 0.3) : BB.pink, c, 0.08);
  return bbFur(c);
}
function bbLeg(c) {
  if (c.face === 'ny' || c.y >= 3) return vary(BB.sock, c, 0.12);
  return bbFur(c);
}

// ---------------------------------------------------------------------------------------------
// Species 2: Puffwick (passive, drops white wool).

const PW = {
  wool: hex(0xece6d8), shade: hex(0xcfc6b4), hi: hex(0xfbf8f0), face: hex(0x3a3734), faceHi: hex(0x55504b),
  eye: hex(0xe7cf72), pupil: hex(0x1a1816), earIn: hex(0xb98f88), hoof: hex(0x221f1c),
};
// Staggered 3x3 wool curls: bright centre, mid ring, shaded corners.
function pwWool(c, dim = 1) {
  const row = Math.floor(c.gy / 3);
  const lx = (c.gx + (row & 1) * 2) % 3;
  const ly = c.gy % 3;
  const r = Math.abs(lx - 1) + Math.abs(ly - 1);
  const base = r === 0 ? PW.hi : r === 1 ? PW.wool : PW.shade;
  return shade(vary(base, c, 0.07), dim);
}
const pwFace = (c) => vary(PW.face, c, 0.14);

const PUFFWICK = {
  key: 'puffwick', name: 'Puffwick', hostile: false, seed: 2203,
  width: 0.9, height: 1.3, maxHealth: 10, walkSpeed: 1.0, runSpeed: 3.4, stride: 4.2, turnRate: 5,
  drops: [{ id: B.WOOL_WHITE, min: 1, max: 3 }], voice: 0.7, step: 'grass', stepDist: 1.3,
  colors: [PW.wool, PW.hi, PW.shade],
  paint: (c) => pwWool(c),
  parts: [
    { id: 'body', pivot: [0, 13, 0], size: [12, 12, 16], paint: (c) => pwWool(c, c.face === 'ny' ? 0.85 : 1) },
    { id: 'puffTop', parent: 'body', pivot: [0, 6, -1], size: [10, 3, 12], offset: [0, 1.5, 0] },
    { id: 'puffL', parent: 'body', pivot: [6, -0.5, -0.5], size: [2, 9, 13], offset: [1, 0, 0] },
    { id: 'puffR', parent: 'body', pivot: [-6, -0.5, -0.5], size: [2, 9, 13], offset: [-1, 0, 0] },
    { id: 'rump', parent: 'body', pivot: [0, -0.5, -8], size: [10, 9, 2], offset: [0, 0, -1] },
    {
      id: 'head', pivot: [0, 15, 8], size: [8, 8, 7], offset: [0, -1, 3],
      paint(c) {
        const { face, x, y } = c;
        if (face === 'py') return pwWool(c);
        if (face !== 'pz') return pwFace(c);
        if (y <= 1) return pwWool(c);
        const left = x >= 1 && x <= 2;
        const right = x >= 5 && x <= 6;
        if ((left || right) && (y === 3 || y === 4)) {
          const inner = (left && x === 2) || (right && x === 5);
          if (y === 4 && inner) return PW.pupil;
          return vary(y === 3 ? PW.eye : mix(PW.eye, PW.pupil, 0.25), c, 0.05);
        }
        if (y === 2 && (left || right)) return vary(mix(PW.face, PW.faceHi, 0.8), c, 0.08); // soft brow
        if (y === 6 && (x === 3 || x === 4)) return vary(PW.pupil, c, 0.1); // nostrils
        if (y === 7 && x >= 3 && x <= 4) return vary(mix(PW.face, PW.pupil, 0.5), c, 0.1);
        if (y >= 5 && x >= 2 && x <= 5) return vary(PW.faceHi, c, 0.1); // lighter muzzle
        return pwFace(c);
      },
    },
    { id: 'fringe', parent: 'head', pivot: [0, 3, 2.5], size: [10, 4, 6], offset: [0, 0.5, 0] },
    {
      id: 'earL', parent: 'head', pivot: [4, 0.5, 3], size: [4, 2, 3], offset: [2, 0, 0], rot: [0, 0, -0.5],
      paint: (c) => (c.face === 'ny' ? vary(PW.earIn, c, 0.08) : pwFace(c)),
    },
    {
      id: 'earR', parent: 'head', pivot: [-4, 0.5, 3], size: [4, 2, 3], offset: [-2, 0, 0], rot: [0, 0, 0.5],
      paint: (c) => (c.face === 'ny' ? vary(PW.earIn, c, 0.08) : pwFace(c)),
    },
    { id: 'legFL', pivot: [4, 7, 5], size: [4, 7, 4], offset: [0, -3.5, 0], paint: pwLeg },
    { id: 'legFR', pivot: [-4, 7, 5], size: [4, 7, 4], offset: [0, -3.5, 0], paint: pwLeg },
    { id: 'legBL', pivot: [4, 7, -5], size: [4, 7, 4], offset: [0, -3.5, 0], paint: pwLeg },
    { id: 'legBR', pivot: [-4, 7, -5], size: [4, 7, 4], offset: [0, -3.5, 0], paint: pwLeg },
  ],
  animate(m, dt, t) {
    const a = m.walkAmt;
    const ph = m.walkPhase;
    const s = Math.sin(ph);
    const swing = m.state === 'flee' ? 0.75 : 0.5;
    R(m, 'legFL', swing * s * a); R(m, 'legBR', swing * s * a);
    R(m, 'legFR', -swing * s * a); R(m, 'legBL', -swing * s * a);
    // the whole fleece wobbles as it waddles
    R(m, 'body', 0, 0, 0.05 * Math.sin(ph) * a + 0.015 * Math.sin(t * 1.3 + m.seed));
    R(m, 'puffTop', 0, 0, 0.04 * Math.sin(ph + 0.6) * a);
    const nibble = m.grazeAmt > 0.5 ? Math.sin(t * 10) * 0.05 : 0;
    R(m, 'head', m.headPitch + m.grazeAmt * 0.75 + nibble, m.headYaw, 0);
    R(m, 'fringe', 0, 0, 0.04 * Math.sin(ph * 2) * a);
    const flop = 0.12 * Math.sin(t * 2.2 + m.seed) + 0.15 * Math.sin(ph * 2) * a;
    R(m, 'earL', 0, 0, -flop);
    R(m, 'earR', 0, 0, flop);
    m.bob = Math.abs(Math.cos(ph)) * 0.025 * a;
  },
};
function pwLeg(c) {
  if (c.face === 'py' || c.y <= 1) return pwWool(c); // wool cuff
  if (c.face === 'ny' || c.y >= c.h - 1) return vary(PW.hoof, c, 0.1);
  return pwFace(c);
}

// ---------------------------------------------------------------------------------------------
// Species 3: Cairnwalker (hostile melee walker).

const CW = {
  torso: hex(0x8a8b84), head: hex(0x9d9b91), limb: hex(0x75776f), leg: hex(0x6c6e68), dark: hex(0x5a5c57),
  light: hex(0xaeaca1), moss: hex(0x5a7a38), mossHi: hex(0x7c9c48), lichen: hex(0xc2b24e), vein: hex(0xd07a2c),
  eye: hex(0xffb340), eyeCore: hex(0xfff1c2), mouth: hex(0x1d1e1c), mud: hex(0x4f463a),
};
// Stacked-stone skin: courses of irregular stones 3 px tall with soft dark seams. Every stone gets its own
// shade and a chiselled lighter top-left edge; moss creeps over upward faces and lichen dots the rest.
function cwStone(c, base = CW.torso, mossy = 0) {
  const row = Math.floor(c.gy / 3);
  const w = 4 + (row % 2);
  const sx = c.gx + Math.floor(hash3(row, 0, 99) * w);
  const stone = Math.floor(sx / w);
  const lx = sx % w;
  const ly = c.gy % 3;
  if (ly === 2 || lx === w - 1) return vary(shade(base, 0.62), c, 0.06); // seam
  let col = vary(shade(base, 0.86 + hash3(stone, row, 5) * 0.26), c, 0.06);
  if (ly === 0 || lx === 0) col = shade(col, 1.07);
  const mossChance = mossy * (c.face === 'py' ? 1 : c.y < 2 && c.face !== 'ny' ? 0.5 : 0);
  if (mossChance > 0 && c.n4 * 0.65 + c.n * 0.35 > 1 - mossChance * 0.5) return vary(c.n > 0.55 ? CW.mossHi : CW.moss, c, 0.1);
  if (c.n > 0.985) return CW.lichen;
  return col;
}

const CAIRNWALKER = {
  key: 'cairnwalker', name: 'Cairnwalker', hostile: true, seed: 3307,
  width: 0.75, height: 1.85, maxHealth: 22, walkSpeed: 0.9, runSpeed: 2.7, stride: 3.2, turnRate: 4,
  damage: 3, attackRange: 0.6, attackCooldown: 1.3, attackTime: 0.6, sense: 24, knock: 6, knockResist: 0.55,
  drops: [
    { id: B.COBBLESTONE, min: 0, max: 2 },
    { id: I.COAL, min: 1, max: 1, chance: 0.5 },
    { id: I.IRON_INGOT, min: 1, max: 1, chance: 0.05 },
  ],
  voice: 0.7, step: 'stone', stepDist: 1.5, glowColor: [1.0, 0.82, 0.55],
  colors: [CW.torso, CW.dark, CW.light, CW.moss],
  paint: (c) => cwStone(c),
  parts: [
    { id: 'legL', pivot: [3, 12, 0], size: [5, 12, 5], offset: [0, -6, 0], paint: cwLeg },
    { id: 'legR', pivot: [-3, 12, 0], size: [5, 12, 5], offset: [0, -6, 0], paint: cwLeg },
    { id: 'hips', pivot: [0, 12, 0], size: [10, 3, 6], offset: [0, 1.5, 0], paint: (c) => cwStone(c, CW.dark) },
    {
      id: 'torso', parent: 'hips', pivot: [0, 3, 0], size: [12, 11, 8], offset: [0, 5.5, 1], rot: [0.38, 0, 0],
      paint(c) {
        if (c.face === 'pz') {
          // a dim ember fissure running down the chest
          const vx = Math.floor(c.w / 2) - 1 + (Math.floor(c.y / 2) % 2);
          if (c.y >= 2 && c.y <= c.h - 3 && c.x === vx) return vary(CW.vein, c, 0.15);
        }
        return cwStone(c, CW.torso, 0.6);
      },
    },
    {
      id: 'head', parent: 'torso', pivot: [0, 11, 2.5], size: [8, 7, 7], offset: [0, 1.5, 2], rot: [-0.3, 0, 0],
      paint(c) {
        if (c.face === 'pz') {
          const { x, y } = c;
          if (y === 5 && x >= 2 && x <= 5) return CW.mouth; // jagged mouth slit
          if (y === 4 && (x === 3 || x === 5)) return CW.mouth;
          if (y === 6 && x === 4) return CW.mouth;
          if (y === 3 && (x === 0 || x === 7)) return vary(CW.light, c, 0.05); // cheekbones
          if (y >= 2 && y <= 6) return vary(shade(CW.head, y === 2 ? 0.7 : 0.92), c, 0.06); // flat face under the brow
        }
        return cwStone(c, CW.head, 0.8);
      },
    },
    { id: 'brow', parent: 'head', pivot: [0, 3, 5.5], size: [9, 2, 3], paint: (c) => cwStone(c, CW.dark, 1) },
    {
      id: 'eyes', parent: 'head', pivot: [0, 1.5, 5.5], size: [6, 1, 1], offset: [0, 0, 0.1], glow: true,
      paint(c) {
        if (c.face !== 'pz') return CW.mouth;
        if (c.x === 0 || c.x === 5) return CW.eye;
        if (c.x === 1 || c.x === 4) return CW.eyeCore;
        return CW.mouth;
      },
    },
    { id: 'armL', parent: 'torso', pivot: [7.5, 9.5, 1], size: [4, 15, 4], offset: [0, -6.5, 0], rot: [-0.3, 0, -0.08], paint: (c) => cwStone(c, CW.limb, 0.3) },
    { id: 'armR', parent: 'torso', pivot: [-7.5, 9.5, 1], size: [4, 15, 4], offset: [0, -6.5, 0], rot: [-0.3, 0, 0.08], paint: (c) => cwStone(c, CW.limb, 0.3) },
    { id: 'fistL', parent: 'armL', pivot: [0, -13, 0], size: [5, 4, 5], offset: [0, -1.5, 0.5], paint: cwFist },
    { id: 'fistR', parent: 'armR', pivot: [0, -13, 0], size: [5, 4, 5], offset: [0, -1.5, 0.5], paint: cwFist },
    { id: 'stone1', parent: 'torso', pivot: [0, 7, -3], size: [9, 5, 4], offset: [0, 0, -2], rot: [0.1, 0.12, 0], paint: (c) => cwStone(c, CW.light, 0.9) },
    { id: 'stone2', parent: 'stone1', pivot: [1, 3.5, -1.5], size: [6, 3, 5], rot: [0, -0.35, 0.08], paint: (c) => cwStone(c, CW.dark, 0.7) },
    { id: 'stone3', parent: 'stone2', pivot: [-1, 2.5, 0], size: [4, 3, 3], rot: [0, 0.6, -0.12], paint: (c) => cwStone(c, mix(CW.light, CW.lichen, 0.25), 0.5) },
  ],
  animate(m, dt, t) {
    const a = m.walkAmt;
    const ph = m.walkPhase;
    const s = Math.sin(ph);
    R(m, 'legL', 0.55 * s * a);
    R(m, 'legR', -0.55 * s * a);
    m.anim.reach = approach(m.anim.reach || 0, m.state === 'chase' ? 1 : 0, dt * 2.5);
    const reach = smooth(m.anim.reach);
    // hunting: claws lifted toward the prey (kept short of the player's face)
    let armL = lerp(-0.4 * s * a, -0.75 + 0.1 * Math.sin(t * 3.1), reach);
    let armR = lerp(0.4 * s * a, -0.75 + 0.1 * Math.sin(t * 3.1 + 1.3), reach);
    if (m.attackT >= 0) {
      // raise both arms high, then slam them down
      const p = m.attackT;
      const up = -2.5;
      const v = p < 0.45 ? lerp(armL, up, smooth(p / 0.45)) : p < 0.62 ? lerp(up, -0.15, smooth((p - 0.45) / 0.17)) : lerp(-0.15, armL, smooth((p - 0.62) / 0.38));
      armL = v;
      armR = v;
    }
    R(m, 'armL', armL, 0, -0.05 * Math.sin(t * 1.2 + m.seed));
    R(m, 'armR', armR, 0, 0.05 * Math.sin(t * 1.4 + m.seed));
    const breathe = 0.035 * Math.sin(t * 1.6 + m.seed);
    const lunge = m.attackT >= 0 && m.attackT > 0.4 && m.attackT < 0.75 ? 0.2 : 0;
    R(m, 'torso', breathe + a * 0.06 + lunge, 0.05 * s * a, 0.05 * s * a);
    R(m, 'head', m.headPitch - lunge * 0.6, m.headYaw, 0);
    R(m, 'stone2', 0, 0, 0.04 * Math.sin(ph) * a);
    R(m, 'stone3', 0, 0, 0.07 * Math.sin(ph + 0.8) * a);
    m.bob = Math.abs(Math.cos(ph)) * 0.035 * a;
  },
};
function cwLeg(c) {
  if (c.face === 'ny' || c.y >= c.h - 2) return vary(mix(CW.dark, CW.mud, 0.5), c, 0.12); // muddy feet
  return cwStone(c, CW.leg, 0.15);
}
function cwFist(c) {
  if (c.face === 'pz' && c.y === 1 && c.x % 2 === 1) return CW.mouth; // knuckle gaps
  return cwStone(c, CW.dark, 0.2);
}

// ---------------------------------------------------------------------------------------------
// Species 4: Skitterjaw (hostile leaping crawler).

const SJ = {
  shell: hex(0x2f2a52), shellHi: hex(0x4a4482), sheen: hex(0x3d8a8a), band: hex(0xe08a2e), bandDark: hex(0x9a5117),
  under: hex(0x1b1930), joint: hex(0x5b558c), bone: hex(0xd8cfae), tip: hex(0x5b2e1a), eye: hex(0xbaff5c),
  eyeDim: hex(0x24401a),
};
function sjShell(c, base = SJ.shell) {
  if (c.face === 'ny') return vary(SJ.under, c, 0.1);
  let col = vary(base, c, 0.1);
  const s = c.n4 * 0.6 + c.n2 * 0.4; // iridescent streaks
  if (s > 0.68) col = mix(col, SJ.sheen, Math.min(1, (s - 0.68) * 2.4));
  if (c.n > 0.965) col = SJ.shellHi;
  return col;
}

// Segmented body: thorax, head, a banded abdomen and a smaller tail segment.
function sjBanded(c) {
  const { face, x, y, h } = c;
  if (face === 'ny') return vary(SJ.under, c, 0.1);
  // amber bands across the back, wrapping down the flanks
  const along = face === 'py' ? y : face === 'px' || face === 'nx' ? x : -1; // position along z in this face
  if (along >= 0 && along % 3 === 1 && (face === 'py' || y < h - 2)) return vary(c.n > 0.5 ? SJ.band : SJ.bandDark, c, 0.08);
  return sjShell(c);
}
const SKITTERJAW_PARTS = [
  { id: 'thorax', pivot: [0, 6, 1.5], size: [8, 4, 6], paint(c) {
    if (c.face === 'py' && (c.x === 3 || c.x === 4)) return vary(SJ.shellHi, c, 0.1); // dorsal ridge
    return sjShell(c);
  } },
  { id: 'head', parent: 'thorax', pivot: [0, 0.5, 3], size: [6, 5, 5], offset: [0, 0, 2.5], paint(c) {
    if (c.face === 'pz' && c.y >= 3 && c.x >= 2 && c.x <= 3) return vary(SJ.under, c, 0.1); // mouth
    return sjShell(c);
  } },
  { id: 'eyes', parent: 'head', pivot: [0, 1, 5], size: [6, 2, 1], offset: [0, 0, 0.2], glow: true, paint(c) {
    if (c.face !== 'pz') return SJ.eyeDim;
    if ((c.y === 0 && (c.x === 0 || c.x === 5)) || (c.y === 1 && (c.x === 1 || c.x === 4))) return SJ.eye;
    return SJ.eyeDim;
  } },
  { id: 'mandL', parent: 'head', pivot: [2, -1.5, 4.5], size: [1, 1, 4], offset: [0, 0, 2], rot: [0.15, -0.45, 0], paint: sjMandible },
  { id: 'mandR', parent: 'head', pivot: [-2, -1.5, 4.5], size: [1, 1, 4], offset: [0, 0, 2], rot: [0.15, 0.45, 0], paint: sjMandible },
  { id: 'antL', parent: 'head', pivot: [2, 2.5, 4], size: [1, 1, 9], offset: [0, 0, 4.5], rot: [-0.7, 0.45, 0], paint: sjAntenna },
  { id: 'antR', parent: 'head', pivot: [-2, 2.5, 4], size: [1, 1, 9], offset: [0, 0, 4.5], rot: [-0.7, -0.45, 0], paint: sjAntenna },
  { id: 'abdomen', parent: 'thorax', pivot: [0, 0.5, -2.5], size: [9, 6, 7], offset: [0, 0.5, -3.5], rot: [0.12, 0, 0], paint: sjBanded },
  { id: 'tail', parent: 'abdomen', pivot: [0, 0.5, -7], size: [6, 4, 5], offset: [0, 0, -2.5], rot: [0.18, 0, 0], paint(c) {
    if (c.face === 'nz' && c.y === 1 && (c.x === 1 || c.x === c.w - 2)) return vary(SJ.band, c, 0.08); // warning dots
    return sjBanded(c);
  } },
];
// Three pairs of walking legs: a femur angled up and out to a high knee, then a long shin down to the ground ...
const SJ_LEG_Z = [2.5, 0.5, -1.5];
const SJ_LEG_YAW = [-0.6, 0, 0.5];
for (let i = 0; i < 3; i++) {
  for (const s of [1, -1]) {
    const tag = (s > 0 ? 'L' : 'R') + i;
    SKITTERJAW_PARTS.push(
      { id: 'leg' + tag, parent: 'thorax', pivot: [s * 3.5, -0.5, SJ_LEG_Z[i]], size: [7, 2, 2], offset: [s * 3.5, 0, 0], rot: [0, s * SJ_LEG_YAW[i], s * 0.8], paint: (c) => {
        const outer = (c.face === 'pz' || c.face === 'nz' || c.face === 'py' || c.face === 'ny') && (s > 0 ? c.x >= c.w - 1 : c.x === 0);
        return outer ? vary(SJ.joint, c, 0.1) : sjShell(c);
      } },
      { id: 'shin' + tag, parent: 'leg' + tag, pivot: [s * 7, 0, 0], size: [2, 11, 2], offset: [0, -5.5, 0], rot: [0, 0, -s * 0.45], paint: (c) => {
        if (c.face === 'ny' || c.y >= c.h - 2) return vary(SJ.bone, c, 0.1);
        if (c.y === 0) return vary(SJ.joint, c, 0.1);
        return sjShell(c);
      } },
    );
  }
}
// ... plus a pair of big folded hind legs beside the abdomen, used for leaping.
for (const s of [1, -1]) {
  const tag = s > 0 ? 'L' : 'R';
  SKITTERJAW_PARTS.push(
    { id: 'hind' + tag, parent: 'thorax', pivot: [s * 4.5, 0.5, -1], size: [2, 3, 9], offset: [0, 0, -4.5], rot: [0.95, -s * 0.4, 0], paint: (c) => {
      // amber stripe along the outer side of the thigh
      if ((c.face === 'px' && s > 0) || (c.face === 'nx' && s < 0)) return c.y === 1 ? vary(SJ.band, c, 0.08) : sjShell(c);
      return sjShell(c);
    } },
    { id: 'hindShin' + tag, parent: 'hind' + tag, pivot: [0, 0, -9], size: [2, 13, 2], offset: [0, -6.5, 0], rot: [-1.1, 0, s * 0.4], paint: (c) => {
      if (c.face === 'ny' || c.y >= c.h - 2) return vary(SJ.bone, c, 0.1);
      if (c.y % 4 === 2 && c.face !== 'py') return vary(SJ.joint, c, 0.1); // little spines
      return sjShell(c);
    } },
  );
}
function sjMandible(c) {
  const front = c.face === 'pz' || (c.face === 'py' && c.y === c.h - 1) || (c.face === 'ny' && c.y === 0) ||
    (c.face === 'px' && c.x === 0) || (c.face === 'nx' && c.x === c.w - 1);
  return front ? vary(SJ.tip, c, 0.1) : vary(SJ.bone, c, 0.08);
}
function sjAntenna(c) {
  const tip = c.face === 'pz' || (c.face === 'px' && c.x <= 1) || (c.face === 'nx' && c.x >= c.w - 2) ||
    (c.face === 'py' && c.y >= c.h - 2) || (c.face === 'ny' && c.y <= 1);
  return tip ? vary(SJ.band, c, 0.1) : vary(SJ.joint, c, 0.12);
}

const SKITTERJAW = {
  key: 'skitterjaw', name: 'Skitterjaw', hostile: true, seed: 4409,
  width: 0.9, height: 0.6, maxHealth: 14, walkSpeed: 1.6, runSpeed: 3.9, stride: 7.5, turnRate: 9,
  damage: 2, leapDamage: 3, attackRange: 0.35, attackCooldown: 1.0, sense: 20, knock: 4.5, knockResist: 1,
  leap: true, drops: [{ id: I.STICK, min: 0, max: 2 }], voice: 1.9, step: 'gravel', stepDist: 0.9,
  glowColor: [0.85, 1.0, 0.7], colors: [SJ.shell, SJ.band, SJ.sheen],
  paint: (c) => sjShell(c),
  parts: SKITTERJAW_PARTS,
  animate(m, dt, t) {
    const a = m.walkAmt;
    const ph = m.walkPhase;
    const airborne = !m.onGround && !m.inWater;
    m.anim.air = approach(m.anim.air || 0, airborne ? 1 : 0, dt * 8);
    m.anim.crouch = approach(m.anim.crouch || 0, m.windup > 0 ? 1 : 0, dt * 6);
    const air = m.anim.air;
    const crouch = m.anim.crouch;
    for (let i = 0; i < 3; i++) {
      for (const s of [1, -1]) {
        const tag = (s > 0 ? 'L' : 'R') + i;
        // alternating tripod gait: L0, R1, L2 move together, then R0, L1, R2
        const p = ph + (((i + (s > 0 ? 0 : 1)) & 1) === 0 ? 0 : Math.PI);
        const lift = Math.max(0, Math.cos(p)) * 0.35 * a;
        R(m, 'leg' + tag, 0, -s * Math.sin(p) * 0.42 * a, s * (lift + air * 0.35 - crouch * 0.2));
        R(m, 'shin' + tag, 0, 0, -s * (lift * 0.6 - air * 0.5 - crouch * 0.15));
      }
    }
    // hind legs: fold for the crouch, kick straight on launch, trail behind while airborne
    m.anim.kick = Math.max(0, (m.anim.kick || 0) - dt * 3);
    const kick = m.anim.kick;
    const hs = Math.sin(ph) * 0.12 * a;
    R(m, 'hindL', crouch * 0.25 - kick * 0.55 - air * 0.15 + hs, 0, 0);
    R(m, 'hindR', crouch * 0.25 - kick * 0.55 - air * 0.15 - hs, 0, 0);
    R(m, 'hindShinL', -crouch * 0.3 + kick * 1.3 + air * 0.6, 0, 0);
    R(m, 'hindShinR', -crouch * 0.3 + kick * 1.3 + air * 0.6, 0, 0);
    // snapping mandibles (fast when hunting) and twitchy antennae
    m.anim.bite = Math.max(0, (m.anim.bite || 0) - dt * 4);
    const hunting = m.state === 'chase' ? 1 : 0;
    const open = 0.12 + hunting * (0.18 + 0.15 * Math.sin(t * 16)) + 0.06 * Math.sin(t * 2 + m.seed) + m.anim.bite * 0.5;
    R(m, 'mandL', 0, open, 0);
    R(m, 'mandR', 0, -open, 0);
    R(m, 'antL', 0.12 * Math.sin(t * 6.5 + m.seed), 0.15 * Math.sin(t * 4.3 + m.seed), 0);
    R(m, 'antR', 0.12 * Math.sin(t * 5.9 + m.seed + 1), -0.15 * Math.sin(t * 3.7 + m.seed), 0);
    R(m, 'abdomen', 0.06 * Math.sin(t * 2.6 + m.seed) - air * 0.2, 0.1 * Math.sin(ph) * a, 0);
    R(m, 'tail', 0.08 * Math.sin(t * 2.6 + m.seed - 0.8) - air * 0.15, 0.14 * Math.sin(ph - 0.7) * a, 0);
    R(m, 'head', m.headPitch * 0.5 - m.anim.bite * 0.25, m.headYaw * 0.6, 0);
    R(m, 'thorax', -air * 0.25 + crouch * 0.12, 0, 0.04 * Math.sin(ph * 2) * a);
    m.bob = -crouch * 0.08 + Math.abs(Math.sin(ph * 2)) * 0.012 * a;
  },
};

const voiceOf = (m) => (m.hostile ? 'monster' : 'animal');

const SPECIES = [BURROWBUCK, PUFFWICK, CAIRNWALKER, SKITTERJAW];
const SPECIES_BY_KEY = Object.fromEntries(SPECIES.map((s) => [s.key, s]));
export const MOB_TYPES = Object.freeze(SPECIES.map((s) => Object.freeze({ key: s.key, name: s.name, hostile: s.hostile })));

// ---------------------------------------------------------------------------------------------
// Particle puffs (hits, deaths, crumbling at sunrise): one InstancedMesh of tiny cubes.

class Particles {
  constructor(parent, cap = 220) {
    this.cap = cap;
    this.list = [];
    this.geometry = new THREE.BoxGeometry(1, 1, 1);
    this.material = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, new THREE.Color(1, 1, 1)); // allocates instanceColor
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'mob-particles';
    parent.add(this.mesh);
    this._m = new THREE.Matrix4();
    this._c = new THREE.Color();
  }

  // colors: array of [r,g,b] 0..255; brightness scales them to match the scene lighting.
  emit(x, y, z, colors, count, { speed = 2, up = 2.5, size = 0.09, life = 0.7, spread = 0.3, brightness = 1 } = {}) {
    for (let i = 0; i < count; i++) {
      if (this.list.length >= this.cap) this.list.shift();
      const c = colors[(Math.random() * colors.length) | 0];
      this._c.setRGB(c[0] / 255, c[1] / 255, c[2] / 255, THREE.SRGBColorSpace); // palette is sRGB; instance colours are linear
      const k = brightness * (0.8 + Math.random() * 0.3);
      const ang = Math.random() * TAU;
      const sp = speed * (0.4 + Math.random() * 0.6);
      this.list.push({
        x: x + (Math.random() - 0.5) * spread * 2, y: y + Math.random() * spread, z: z + (Math.random() - 0.5) * spread * 2,
        vx: Math.cos(ang) * sp, vy: up * (0.5 + Math.random() * 0.7), vz: Math.sin(ang) * sp,
        life: life * (0.7 + Math.random() * 0.5), age: 0, size: size * (0.7 + Math.random() * 0.6),
        r: this._c.r * k, g: this._c.g * k, b: this._c.b * k,
      });
    }
  }

  update(dt, solidAt) {
    const list = this.list;
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      p.age += dt;
      if (p.age >= p.life) continue;
      p.vy -= 16 * dt;
      const nx = p.x + p.vx * dt;
      const ny = p.y + p.vy * dt;
      const nz = p.z + p.vz * dt;
      if (solidAt(nx, ny, nz)) {
        // settle on whatever we hit
        p.vy = Math.abs(p.vy) > 1 ? -p.vy * 0.25 : 0;
        p.vx *= 0.5;
        p.vz *= 0.5;
      } else {
        p.x = nx; p.y = ny; p.z = nz;
      }
      const fade = p.age > p.life * 0.6 ? 1 - (p.age - p.life * 0.6) / (p.life * 0.4) : 1;
      const s = p.size * fade;
      this._m.makeScale(s, s, s).setPosition(p.x, p.y, p.z);
      this.mesh.setMatrixAt(n, this._m);
      this._c.setRGB(p.r, p.g, p.b);
      this.mesh.setColorAt(n, this._c);
      list[n++] = p;
    }
    list.length = n;
    this.mesh.count = n;
    if (n > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.mesh.instanceColor.needsUpdate = true;
    }
  }

  clear() {
    this.list.length = 0;
    this.mesh.count = 0;
  }

  dispose() {
    this.clear();
    this.mesh.removeFromParent();
    this.mesh.dispose?.();
    this.geometry.dispose();
    this.material.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// A single mob instance.

let nextMobId = 1;

class Mob {
  constructor(species, assets, x, y, z) {
    this.id = nextMobId++;
    this.species = species;
    this.hostile = species.hostile;
    this.pos = new THREE.Vector3(x, y, z);
    this.vel = new THREE.Vector3();
    this.yaw = Math.random() * TAU;
    this.seed = Math.random() * 100;
    this.health = species.maxHealth;

    // AI
    this.state = 'idle';
    this.stateTimer = rand(0.5, 3);
    this.dirX = 0;
    this.dirZ = 1;
    this.speed = 0;
    this.grazing = false;
    this.grazeAmt = 0;
    this.headYaw = 0;
    this.headPitch = 0;
    this.fleeX = 0;
    this.fleeZ = 0;
    this.fleeTurn = 0;
    this.senseTimer = Math.random() * 0.3;
    this.seesPlayer = false;
    this.lastSeen = -100;
    this.aggro = 0;
    this.sideTimer = 0;
    this.sideSign = 1;
    this.blockedTime = 0;
    this.attackCooldown = 0;
    this.attackT = -1;
    this.attackHit = false;
    this.leapCooldown = rand(0.2, 0.8);
    this.windup = 0;
    this.leaping = false;
    this.leapAir = 0;
    this.leapHit = false;

    // physics
    this.onGround = false;
    this.inWater = false;
    this.collidedH = false;
    this.knockTimer = 0;
    this.waterClimb = 0;
    this.peakY = y;
    this.pushX = 0;
    this.pushZ = 0;

    // presentation
    this.walkPhase = Math.random() * TAU;
    this.walkAmt = 0;
    this.bob = 0;
    this.anim = {};
    this.hurtTimer = 0;
    this.invuln = 0;
    this.dead = false;
    this.deathKind = 'death';
    this.deathTimer = 0;
    this.deathSide = 1;
    this.burnDelay = -1;
    this.fade = 0;
    this.light = 1;
    this.lightTimer = 0;
    this.skyExposed = true;
    this.stepAcc = 0;
    this.voiceTimer = rand(4, 14);
    this.remove = false;

    this.material = new THREE.MeshBasicMaterial({ map: assets.texture, vertexColors: true });
    this.glowMaterial = assets.glowMaterial ? assets.glowMaterial.clone() : null;
    this.group = new THREE.Group();
    this.group.name = species.key;
    this.model = new THREE.Group();
    this.group.add(this.model);
    this.parts = {};
    this.glowMeshes = [];
    for (const p of species.parts) {
      const pivot = new THREE.Group();
      pivot.position.set(p.pivot[0] * PX, p.pivot[1] * PX, p.pivot[2] * PX);
      if (p.rot) pivot.rotation.set(p.rot[0], p.rot[1], p.rot[2]);
      const mesh = new THREE.Mesh(assets.geometries[p.id], p.glow ? this.glowMaterial : this.material);
      if (p.glow) this.glowMeshes.push(mesh);
      pivot.add(mesh);
      (p.parent ? this.parts[p.parent].pivot : this.model).add(pivot);
      this.parts[p.id] = { pivot, mesh, rest: pivot.rotation.clone() };
    }
    this._setOpacity(0);
  }

  _setOpacity(o) {
    const transparent = o < 1;
    for (const mat of [this.material, this.glowMaterial]) {
      if (!mat) continue;
      if (mat.transparent !== transparent) {
        mat.transparent = transparent;
        mat.needsUpdate = true;
      }
      mat.opacity = o;
    }
  }

  dispose() {
    this.group.removeFromParent();
    this.material.dispose();
    this.glowMaterial?.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// The manager.

export class MobManager {
  // onDropLost (optional): (itemId, count) => {} when a kill's drop doesn't fit in the inventory.
  constructor({ world, renderer, player, survival, inventory, sounds, getMode, onDropLost = null } = {}) {
    this.world = world;
    this.onDropLost = typeof onDropLost === 'function' ? onDropLost : null;
    this.renderer = renderer;
    this.player = player;
    this.survival = survival;
    this.inventory = inventory;
    this.sounds = sounds;
    this.getMode = typeof getMode === 'function' ? getMode : () => 'survival';

    this.mobs = [];
    this.time = 0;
    this.isNight = false;
    this.daylight = 1;
    this.spawnTimer = 1.5;
    this.enabled = true;

    this.root = new THREE.Group();
    this.root.name = 'mobs';
    renderer?.scene?.add(this.root);
    this.assets = new Map();
    this.particles = new Particles(this.root);

    // Soft round blob shadow shared by every mob.
    const sc = document.createElement('canvas');
    sc.width = sc.height = 32;
    const g = sc.getContext('2d');
    const grad = g.createRadialGradient(16, 16, 2, 16, 16, 16);
    grad.addColorStop(0, 'rgba(0,0,0,0.9)');
    grad.addColorStop(0.6, 'rgba(0,0,0,0.45)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 32, 32);
    this.shadowTexture = new THREE.CanvasTexture(sc);
    this.shadowGeometry = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.shadowMaterial = new THREE.MeshBasicMaterial({
      map: this.shadowTexture, transparent: true, depthWrite: false, opacity: 0.35,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });

    this._lightColor = new THREE.Color(1, 1, 1);
    this._lightLin = 1;
    this._pbox = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
    this._ctx = { px: 0, py: 0, pz: 0, ex: 0, ey: 0, ez: 0, canAttack: false, box: this._pbox };
    this._solidAt = (x, y, z) => this._solid(Math.floor(x), Math.floor(y), Math.floor(z));
  }

  // Number of living mobs.
  get count() {
    let n = 0;
    for (const m of this.mobs) if (!m.dead) n++;
    return n;
  }

  // Counts by category, handy for debug overlays.
  stats() {
    let passive = 0;
    let hostile = 0;
    let underground = 0;
    for (const m of this.mobs) {
      if (m.dead) continue;
      if (m.hostile) {
        hostile++;
        if (!m.skyExposed) underground++;
      } else passive++;
    }
    return { passive, hostile, underground };
  }

  // ------------------------------------------------------------------------------------------
  // Public API

  update(dt, env = {}) {
    if (!(dt > 0) || !this.player || !this.world) return;
    dt = Math.min(dt, 0.1);
    this.time += dt;
    const t = env.timeOfDay;
    this.isNight = env.isNight ?? (typeof t === 'number' ? t >= 0.52 && t < 0.98 : false);
    const dl = this.renderer ? this.renderer.daylight : undefined;
    this.daylight = typeof dl === 'number' && Number.isFinite(dl) ? clamp(dl, 0, 1) : this.isNight ? 0 : 1;
    // Mirror the renderer's world-material light: an sRGB grey (MIN 0.18) with a faint blue cast at night.
    const rl = this.renderer ? this.renderer.light : undefined;
    const l = typeof rl === 'number' && Number.isFinite(rl) ? clamp(rl, 0, 1) : 0.18 + 0.82 * this.daylight;
    const night = 1 - this.daylight;
    this._lightColor.setRGB(l * (1 - 0.12 * night), l * (1 - 0.06 * night), l, THREE.SRGBColorSpace);
    this._lightLin = (this._lightColor.r + this._lightColor.g + this._lightColor.b) / 3;

    const c = this._refreshContext();
    if (this.enabled) this._spawnTick(dt, c);
    this._computePushes(c);
    for (const m of this.mobs) this._updateMob(m, dt, c);

    // sweep removed mobs
    let w = 0;
    for (let i = 0; i < this.mobs.length; i++) {
      const m = this.mobs[i];
      if (m.remove) m.dispose();
      else this.mobs[w++] = m;
    }
    this.mobs.length = w;

    this.particles.update(dt, this._solidAt);
    this.shadowMaterial.opacity = 0.12 + 0.26 * this.daylight;
  }

  // Ray (origin, normalized dir) vs mob hitboxes. Returns true when a mob absorbed the swing.
  attack(origin, dir, reach, damage) {
    if (!origin || !dir) return false;
    let dx = dir.x;
    let dy = dir.y;
    let dz = dir.z;
    const len = Math.hypot(dx, dy, dz);
    if (!(len > 0)) return false;
    dx /= len; dy /= len; dz /= len;
    const ox = origin.x;
    const oy = origin.y;
    const oz = origin.z;
    let best = null;
    let bestT = Number.isFinite(reach) && reach > 0 ? reach : 4.5;
    for (const m of this.mobs) {
      if (m.dead) continue;
      const sp = m.species;
      const pad = 0.1;
      const hw = sp.width / 2 + pad;
      const tHit = rayBox(ox, oy, oz, dx, dy, dz,
        m.pos.x - hw, m.pos.y - 0.05, m.pos.z - hw, m.pos.x + hw, m.pos.y + sp.height + pad, m.pos.z + hw);
      if (tHit !== null && tHit <= bestT) {
        bestT = tHit;
        best = m;
      }
    }
    if (!best) return false;
    if (this.player) this._refreshContext();
    // A solid block in front of the mob takes the hit instead.
    if (this._rayBlockDistance(ox, oy, oz, dx, dy, dz, bestT) < bestT) return false;
    const m = best;
    if (m.invuln > 0) return true; // still recovering from the previous hit: swallow the click
    const hx = ox + dx * bestT;
    const hy = oy + dy * bestT;
    const hz = oz + dz * bestT;
    const hlen = Math.hypot(dx, dz) || 1;
    this._hurt(m, Math.max(0, Number(damage) || 1), { kx: dx / hlen, kz: dz / hlen, byPlayer: true, hx, hy, hz });
    return true;
  }

  // True when a living mob's box overlaps block cell (x, y, z); Interaction uses it to refuse placing blocks
  // inside mobs.
  intersectsBlock(x, y, z) {
    const e = 1e-4;
    for (const m of this.mobs) {
      if (m.dead) continue;
      const hw = m.species.width / 2;
      if (m.pos.x - hw < x + 1 - e && m.pos.x + hw > x + e && m.pos.z - hw < z + 1 - e && m.pos.z + hw > z + e &&
          m.pos.y < y + 1 - e && m.pos.y + m.species.height > y + e) return true;
    }
    return false;
  }

  // Debug / test helper: spawn a mob by species key at a feet position. Returns the mob or null.
  spawn(key, x, y, z) {
    const sp = SPECIES_BY_KEY[key];
    if (!sp) return null;
    return this._spawn(sp, x, y, z);
  }

  clear() {
    for (const m of this.mobs) m.dispose();
    this.mobs.length = 0;
    this.particles.clear();
  }

  dispose() {
    this.clear();
    this.particles.dispose();
    for (const a of this.assets.values()) {
      for (const g of Object.values(a.geometries)) g.dispose();
      a.texture.dispose();
      a.glowMaterial?.dispose();
    }
    this.assets.clear();
    this.shadowGeometry.dispose();
    this.shadowMaterial.dispose();
    this.shadowTexture.dispose();
    this.root.removeFromParent();
  }

  // ------------------------------------------------------------------------------------------
  // World queries

  _block(x, y, z) {
    const id = this.world.getBlock(x, y, z);
    return id === undefined || id === null ? -1 : id;
  }

  _solid(x, y, z) {
    return !!this.world.isSolid(x, y, z);
  }

  _isWaterAt(x, y, z) {
    return this._block(Math.floor(x), Math.floor(y), Math.floor(z)) === B.WATER;
  }

  // Two (or `n`) free, dry cells stacked from (x, y, z).
  _roomAt(x, y, z, n) {
    for (let k = 0; k < n; k++) {
      const id = this._block(x, y + k, z);
      if (id < 0 || idIsSolid(id) || id === B.WATER) return false;
    }
    return true;
  }

  // Only natural darkness breeds monsters. There are no light sources to make a shelter safe, so a spot the
  // player dug out, or one under anything the player placed (a house's roof, upper floor or wall), doesn't
  // count as a cave. Checks the two body cells at (x, y, z) and the column above them up to `top`.
  _playerMade(x, y, z, top) {
    const w = this.world;
    if (typeof w.isEdited !== 'function') return false;
    if (w.isEdited(x, y, z) || w.isEdited(x, y + 1, z)) return true;
    for (let yy = y + 2; yy <= top; yy++) {
      if (w.isEdited(x, yy, z) && this._block(x, yy, z) > 0) return true;
    }
    return false;
  }

  // True when no opaque block hangs over (x, z) at or above y.
  _skyExposed(x, y, z) {
    const ix = Math.floor(x);
    const iz = Math.floor(z);
    const iy = Math.max(0, Math.floor(y));
    const top = this.world.highestBlockAt(ix, iz);
    if (top < iy) return true;
    for (let yy = iy; yy <= top && yy < WORLD_HEIGHT; yy++) {
      if (isOpaque(this._block(ix, yy, iz))) return false;
    }
    return true;
  }

  // Distance along a ray to the first solid block (Infinity when none within maxDist). Amanatides-Woo DDA.
  _rayBlockDistance(ox, oy, oz, dx, dy, dz, maxDist) {
    let x = Math.floor(ox);
    let y = Math.floor(oy);
    let z = Math.floor(oz);
    const stepX = dx > 0 ? 1 : -1;
    const stepY = dy > 0 ? 1 : -1;
    const stepZ = dz > 0 ? 1 : -1;
    const tdx = dx !== 0 ? Math.abs(1 / dx) : Infinity;
    const tdy = dy !== 0 ? Math.abs(1 / dy) : Infinity;
    const tdz = dz !== 0 ? Math.abs(1 / dz) : Infinity;
    let tmx = dx !== 0 ? (dx > 0 ? x + 1 - ox : ox - x) * tdx : Infinity;
    let tmy = dy !== 0 ? (dy > 0 ? y + 1 - oy : oy - y) * tdy : Infinity;
    let tmz = dz !== 0 ? (dz > 0 ? z + 1 - oz : oz - z) * tdz : Infinity;
    for (let guard = 0; guard < 256; guard++) {
      let t;
      if (tmx < tmy && tmx < tmz) { x += stepX; t = tmx; tmx += tdx; }
      else if (tmy < tmz) { y += stepY; t = tmy; tmy += tdy; }
      else { z += stepZ; t = tmz; tmz += tdz; }
      if (t > maxDist) return Infinity;
      if (this._solid(x, y, z)) return t;
    }
    return Infinity;
  }

  _lineOfSight(ax, ay, az, bx, by, bz) {
    const dx = bx - ax;
    const dy = by - ay;
    const dz = bz - az;
    const d = Math.hypot(dx, dy, dz);
    if (d < 1e-6) return true;
    return this._rayBlockDistance(ax, ay, az, dx / d, dy / d, dz / d, d) >= d;
  }

  // ------------------------------------------------------------------------------------------
  // Player helpers (tolerant of the different AABB shapes a Player might return)

  // Snapshot of the player / game mode shared by everything in one update (or one attack).
  _refreshContext() {
    const c = this._ctx;
    const pp = this.player.position;
    c.px = pp.x; c.py = pp.y; c.pz = pp.z;
    const eye = this._playerEye();
    c.ex = eye.x; c.ey = eye.y; c.ez = eye.z;
    this._playerBox();
    let mode = 'survival';
    try { mode = this.getMode(); } catch { /* keep default */ }
    c.survival = mode === 'survival';
    c.canAttack = c.survival && (!this.survival || !(this.survival.health <= 0));
    c.playerOutdoors = this._skyExposed(c.px, c.py + PLAYER_HEIGHT, c.pz);
    return c;
  }

  _playerEye() {
    const p = this.player;
    try {
      if (typeof p.getEyePosition === 'function') {
        const e = p.getEyePosition();
        if (e && Number.isFinite(e.x)) return e;
      }
    } catch { /* fall through */ }
    return { x: p.position.x, y: p.position.y + PLAYER_EYE, z: p.position.z };
  }

  _playerBox() {
    const out = this._pbox;
    const p = this.player;
    let b = null;
    try {
      b = typeof p.getAABB === 'function' ? p.getAABB() : null;
    } catch {
      b = null;
    }
    if (b && b.min && b.max) {
      out.minX = b.min.x; out.minY = b.min.y; out.minZ = b.min.z;
      out.maxX = b.max.x; out.maxY = b.max.y; out.maxZ = b.max.z;
    } else if (b && Number.isFinite(b.minX)) {
      out.minX = b.minX; out.minY = b.minY; out.minZ = b.minZ;
      out.maxX = b.maxX; out.maxY = b.maxY; out.maxZ = b.maxZ;
    } else if (Array.isArray(b) && b.length >= 6) {
      [out.minX, out.minY, out.minZ, out.maxX, out.maxY, out.maxZ] = b;
    } else {
      const hw = PLAYER_WIDTH / 2;
      out.minX = p.position.x - hw; out.maxX = p.position.x + hw;
      out.minZ = p.position.z - hw; out.maxZ = p.position.z + hw;
      out.minY = p.position.y; out.maxY = p.position.y + PLAYER_HEIGHT;
    }
    return out;
  }

  // Horizontal gap between a mob's box and the player's box, or Infinity if they don't overlap vertically.
  _gapToPlayer(m, c, vpad = 0.2) {
    const b = c.box;
    const hw = m.species.width / 2;
    if (m.pos.y > b.maxY + vpad || m.pos.y + m.species.height < b.minY - vpad) return Infinity;
    const gx = Math.max(0, b.minX - (m.pos.x + hw), (m.pos.x - hw) - b.maxX);
    const gz = Math.max(0, b.minZ - (m.pos.z + hw), (m.pos.z - hw) - b.maxZ);
    return Math.hypot(gx, gz);
  }

  _knockPlayer(dx, dz, strength) {
    const p = this.player;
    if (p.flying) return;
    if (typeof p.knockback === 'function') {
      p.knockback(dx, dz, strength, 4.2);
      return;
    }
    const v = p.velocity;
    if (!v) return;
    v.x += dx * strength;
    v.z += dz * strength;
    v.y = Math.max(v.y, 4.2);
  }

  _hitPlayer(m, amount, c) {
    if (!c.canAttack) return;
    let landed = true;
    try {
      if (this.survival && typeof this.survival.damage === 'function') landed = this.survival.damage(amount, 'mob') !== false;
    } catch (err) {
      console.warn('mobs: survival.damage failed', err);
    }
    if (!landed) return; // player is still in their post-hit grace period
    const dx = c.px - m.pos.x;
    const dz = c.pz - m.pos.z;
    const d = Math.hypot(dx, dz) || 1;
    this._knockPlayer(dx / d, dz / d, m.species.knock || 5);
  }

  _sound(name, x, y, z, { volume = 1, pitch = 1, material, range = 20 } = {}) {
    if (!this.sounds || typeof this.sounds.play !== 'function') return;
    const c = this._ctx;
    const d = Math.hypot(x - c.px, y - c.py, z - c.pz);
    if (d > range) return;
    const att = 1 - d / range;
    const vol = volume * att * att;
    if (vol < 0.02) return;
    try {
      this.sounds.play(name, { volume: vol, pitch, material });
    } catch { /* audio is best-effort */ }
  }

  // ------------------------------------------------------------------------------------------
  // Spawning

  _assetsFor(sp) {
    let a = this.assets.get(sp.key);
    if (!a) {
      a = buildSpeciesAssets(sp);
      this.assets.set(sp.key, a);
    }
    return a;
  }

  _spawn(sp, x, y, z) {
    const m = new Mob(sp, this._assetsFor(sp), x, y, z);
    m.shadow = new THREE.Mesh(this.shadowGeometry, this.shadowMaterial);
    m.shadow.renderOrder = 1;
    m.group.add(m.shadow);
    m.group.position.copy(m.pos);
    m.group.rotation.y = m.yaw;
    m.skyExposed = this._skyExposed(x, y + sp.height, z);
    m.light = m.skyExposed ? 1 : CAVE_LIGHT;
    m.lightTimer = rand(0.3, 0.5);
    this.root.add(m.group);
    this.mobs.push(m);
    return m;
  }

  _spawnTick(dt, c) {
    this.spawnTimer -= dt;
    if (this.spawnTimer > 0) return;
    this.spawnTimer = rand(0.7, 1.3);
    const { passive, hostile, underground } = this.stats();
    if (!this.isNight && passive < PASSIVE_CAP && Math.random() < (passive < 4 ? 0.7 : 0.25)) {
      this._trySpawnPassive(c, PASSIVE_CAP - passive);
    }
    if (c.survival && hostile < HOSTILE_CAP) {
      if (this.isNight && Math.random() < 0.5) this._trySpawnHostileSurface(c, HOSTILE_CAP - hostile);
      // While the player is out in the open, keep most of the cap free for the surface.
      else if (Math.random() < 0.3 && (!c.playerOutdoors || underground < UNDERGROUND_CAP_OUTDOORS)) this._trySpawnUnderground(c);
    }
  }

  _farEnough(x, y, z, c, min) {
    return Math.hypot(x - c.px, y - c.py, z - c.pz) >= min;
  }

  _trySpawnPassive(c, room) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const ang = Math.random() * TAU;
      const dist = rand(20, 40);
      const x = Math.floor(c.px + Math.sin(ang) * dist);
      const z = Math.floor(c.pz + Math.cos(ang) * dist);
      const top = this.world.highestBlockAt(x, z);
      if (!(top >= 1) || top >= WORLD_HEIGHT - 3) continue;
      const ground = this._block(x, top, z);
      if (ground !== B.GRASS && ground !== B.SNOWY_GRASS) continue;
      if (!this._roomAt(x, top + 1, z, 2)) continue;
      if (!this._farEnough(x + 0.5, top + 1, z + 0.5, c, 18)) continue;
      // Snowy ground grows only Puffwicks; elsewhere favour whichever animal is scarcer nearby for variety.
      let pw = 0;
      let bb = 0;
      for (const o of this.mobs) {
        if (o.dead) continue;
        if (o.species === PUFFWICK) pw++;
        else if (o.species === BURROWBUCK) bb++;
      }
      const sp = ground === B.SNOWY_GRASS || Math.random() < clamp(0.45 + (bb - pw) * 0.15, 0.15, 0.85) ? PUFFWICK : BURROWBUCK;
      const herd = Math.min(room, randInt(2, 4));
      this._spawn(sp, x + 0.5, top + 1, z + 0.5);
      // herd mates on nearby grass at a similar height
      let placed = 1;
      for (let k = 0; k < 10 && placed < herd; k++) {
        const hx = x + randInt(-3, 3);
        const hz = z + randInt(-3, 3);
        const ht = this.world.highestBlockAt(hx, hz);
        if (!(ht >= 1) || Math.abs(ht - top) > 2) continue;
        const hg = this._block(hx, ht, hz);
        if (hg !== B.GRASS && hg !== B.SNOWY_GRASS) continue;
        if (!this._roomAt(hx, ht + 1, hz, 2)) continue;
        if (this.mobs.some((o) => !o.dead && Math.abs(o.pos.x - (hx + 0.5)) < 0.9 && Math.abs(o.pos.z - (hz + 0.5)) < 0.9)) continue;
        this._spawn(sp, hx + 0.5, ht + 1, hz + 0.5);
        placed++;
      }
      return true;
    }
    return false;
  }

  _pickHostile() {
    return Math.random() < 0.6 ? CAIRNWALKER : SKITTERJAW;
  }

  _trySpawnHostileSurface(c, room) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const ang = Math.random() * TAU;
      const dist = rand(24, 42);
      const x = Math.floor(c.px + Math.sin(ang) * dist);
      const z = Math.floor(c.pz + Math.cos(ang) * dist);
      const top = this.world.highestBlockAt(x, z);
      if (!(top >= 1) || top >= WORLD_HEIGHT - 3) continue;
      const ground = this._block(x, top, z);
      if (!isOpaque(ground) || ground === B.BEDROCK) continue;
      if (!this._roomAt(x, top + 1, z, 2)) continue;
      if (!this._farEnough(x + 0.5, top + 1, z + 0.5, c, 20)) continue;
      const n = Math.min(room, Math.random() < 0.3 ? 2 : 1);
      this._spawn(this._pickHostile(), x + 0.5, top + 1, z + 0.5);
      if (n > 1) {
        for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const t2 = this.world.highestBlockAt(x + ox, z + oz);
          if (t2 === top && isOpaque(this._block(x + ox, t2, z + oz)) && this._roomAt(x + ox, t2 + 1, z + oz, 2)) {
            this._spawn(this._pickHostile(), x + ox + 0.5, t2 + 1, z + oz + 0.5);
            break;
          }
        }
      }
      return true;
    }
    return false;
  }

  _trySpawnUnderground(c) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const ang = Math.random() * TAU;
      const dist = rand(12, 30);
      const x = Math.floor(c.px + Math.sin(ang) * dist);
      const z = Math.floor(c.pz + Math.cos(ang) * dist);
      const top = this.world.highestBlockAt(x, z);
      if (!(top >= 6)) continue;
      let y = clamp(Math.floor(c.py) + randInt(-10, 10), 2, top - 4);
      let found = -1;
      for (let k = 0; k < 16 && y > 1; k++, y--) {
        const below = this._block(x, y - 1, z);
        if (below < 0) break;
        if (isOpaque(below) && below !== B.BEDROCK && this._roomAt(x, y, z, 2)) {
          found = y;
          break;
        }
      }
      if (found < 0 || found + 2 > top - 1) continue;
      if (this._skyExposed(x + 0.5, found + 2, z + 0.5)) continue; // must be roofed by opaque blocks
      if (this._playerMade(x, found, z, top)) continue;
      if (!this._farEnough(x + 0.5, found, z + 0.5, c, 12)) continue;
      this._spawn(this._pickHostile(), x + 0.5, found, z + 0.5);
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------------------------------------
  // Per-frame mob update

  // Soft separation between mobs, and mobs shoved aside by the player.
  _computePushes(c) {
    const mobs = this.mobs;
    for (const m of mobs) { m.pushX = 0; m.pushZ = 0; }
    for (let i = 0; i < mobs.length; i++) {
      const a = mobs[i];
      if (a.dead) continue;
      for (let j = i + 1; j < mobs.length; j++) {
        const b = mobs[j];
        if (b.dead) continue;
        const min = (a.species.width + b.species.width) * 0.5;
        const dx = b.pos.x - a.pos.x;
        const dz = b.pos.z - a.pos.z;
        if (Math.abs(dx) >= min || Math.abs(dz) >= min) continue;
        if (a.pos.y > b.pos.y + b.species.height || b.pos.y > a.pos.y + a.species.height) continue;
        let d = Math.hypot(dx, dz);
        let nx = dx;
        let nz = dz;
        if (d < 1e-4) { nx = Math.random() - 0.5; nz = Math.random() - 0.5; d = Math.hypot(nx, nz); }
        if (d >= min) continue;
        const f = ((min - d) / min) * 5;
        nx /= d; nz /= d;
        a.pushX -= nx * f; a.pushZ -= nz * f;
        b.pushX += nx * f; b.pushZ += nz * f;
      }
      // the player shoves mobs out of their personal space (but never the other way round)
      const gap = this._gapToPlayer(a, c, 0);
      if (gap < 0.05) {
        let dx = a.pos.x - c.px;
        let dz = a.pos.z - c.pz;
        const d = Math.hypot(dx, dz) || 1;
        dx /= d; dz /= d;
        const min = (a.species.width + PLAYER_WIDTH) * 0.5 + 0.05;
        const f = clamp((min - d) / min, 0.2, 1) * 7;
        a.pushX += dx * f;
        a.pushZ += dz * f;
      }
    }
  }

  _updateMob(m, dt, c) {
    const sp = m.species;
    // Despawn: too far away, or its chunk has been unloaded.
    const hd = Math.hypot(m.pos.x - c.px, m.pos.z - c.pz);
    if (hd > DESPAWN_DISTANCE ||
        this._block(Math.floor(m.pos.x), clamp(Math.floor(m.pos.y), 0, WORLD_HEIGHT - 1), Math.floor(m.pos.z)) < 0) {
      m.remove = true;
      return;
    }

    m.hurtTimer = Math.max(0, m.hurtTimer - dt);
    m.invuln = Math.max(0, m.invuln - dt);
    m.attackCooldown = Math.max(0, m.attackCooldown - dt);
    m.leapCooldown = Math.max(0, m.leapCooldown - dt);
    m.aggro = Math.max(0, m.aggro - dt);
    m.fade = Math.min(1, m.fade + dt * 2);

    if (m.dead) {
      m.speed = 0;
      this._physics(m, dt);
      this._animateDeath(m, dt);
      this._updateVisual(m, dt);
      return;
    }

    if (m.hostile) {
      // Monsters out under the open sky crumble away once the sun is up.
      if (!this.isNight && m.skyExposed) {
        if (m.burnDelay < 0) m.burnDelay = rand(0.5, 6);
        m.burnDelay -= dt;
        if (m.burnDelay <= 0) {
          this._die(m, false, 'crumble');
          this._updateVisual(m, dt);
          return;
        }
      } else {
        m.burnDelay = -1;
      }
      // Stragglers far from the player thin out over time; so do idle cave dwellers while the player is
      // outdoors at night, making room for surface spawns.
      if ((hd > 40 && Math.random() < dt / 30) ||
          (this.isNight && c.playerOutdoors && !m.skyExposed && m.state !== 'chase' && hd > 24 && Math.random() < dt / 20)) {
        m.remove = true;
        return;
      }
    }

    if (m.hostile) this._thinkHostile(m, dt, c);
    else this._thinkPassive(m, dt, c);

    this._physics(m, dt);

    // Turn the body toward where it's going.
    const hs = Math.hypot(m.vel.x, m.vel.z);
    if (m.speed > 0.05 && m.knockTimer <= 0) {
      m.yaw = approachAngle(m.yaw, Math.atan2(m.dirX, m.dirZ), sp.turnRate * dt);
    } else if (m.faceYaw !== undefined) {
      m.yaw = approachAngle(m.yaw, m.faceYaw, sp.turnRate * dt);
    }
    m.faceYaw = undefined;

    // Gait.
    const target = clamp(hs / Math.max(0.6, sp.walkSpeed * 1.1), 0, 1);
    m.walkAmt = approach(m.walkAmt, m.onGround || m.inWater ? target : m.walkAmt * 0.9, dt * 5);
    if (m.onGround || m.inWater) m.walkPhase += hs * dt * sp.stride;
    m.grazeAmt = approach(m.grazeAmt, m.grazing ? 1 : 0, dt * 2.5);

    // Footsteps and voices.
    if (m.onGround && hs > 0.3) {
      m.stepAcc += hs * dt;
      if (m.stepAcc >= sp.stepDist) {
        m.stepAcc = 0;
        this._sound('step', m.pos.x, m.pos.y, m.pos.z, {
          volume: m.hostile && sp === CAIRNWALKER ? 0.55 : 0.28, pitch: sp === CAIRNWALKER ? 0.6 : sp === SKITTERJAW ? 1.5 : 1.15,
          material: sp.step, range: 16,
        });
      }
    }
    m.voiceTimer -= dt;
    if (m.voiceTimer <= 0) {
      m.voiceTimer = m.hostile ? rand(5, 12) : rand(8, 20);
      // An occasional ambient call (grunt, bleat, rasp) pitched per species.
      this._sound('mobIdle', m.pos.x, m.pos.y + sp.height * 0.7, m.pos.z, { volume: m.hostile ? 0.5 : 0.4, pitch: sp.voice * rand(0.92, 1.08), material: voiceOf(m), range: 18 });
    }

    sp.animate(m, dt, this.time);
    this._updateVisual(m, dt);
  }

  // ------------------------------------------------------------------------------------------
  // AI

  _setDir(m, ang) {
    m.dirX = Math.sin(ang);
    m.dirZ = Math.cos(ang);
  }

  // How many blocks the ground drops one step ahead (0 = level or a step up, 6 = cliff/void) and whether the
  // next footing is water.
  _probeAhead(m, dirX, dirZ) {
    const hw = m.species.width / 2;
    const ax = Math.floor(m.pos.x + dirX * (hw + 0.45));
    const az = Math.floor(m.pos.z + dirZ * (hw + 0.45));
    const fy = Math.floor(m.pos.y + 0.01);
    let water = false;
    let drop = 6;
    for (let k = 0; k <= 6; k++) {
      const id = this._block(ax, fy - k, az);
      if (id === B.WATER) { water = true; drop = Math.max(0, k - 1); break; }
      if (id < 0 || idIsSolid(id)) { drop = Math.max(0, k - 1); break; }
    }
    return { drop, water };
  }

  // Heading toward the nearest dry bank within 8 blocks (null if none is found).
  _findShore(m) {
    const fy = Math.floor(m.pos.y + 0.01);
    let best = null;
    let bestD = Infinity;
    for (let i = 0; i < 12; i++) {
      const ang = (i / 12) * TAU;
      const sx = Math.sin(ang);
      const sz = Math.cos(ang);
      for (let d = 1; d <= 8 && d < bestD; d++) {
        const x = Math.floor(m.pos.x + sx * d);
        const z = Math.floor(m.pos.z + sz * d);
        const top = this.world.highestBlockAt(x, z);
        if (top < 0) break;
        const id = this._block(x, top, z);
        if (id === B.WATER) continue;
        if (top >= fy - 2 && top <= fy + 1) {
          best = ang;
          bestD = d;
        }
        break;
      }
    }
    return best;
  }

  // Swimming: head for the shore. Returns true when it took over steering.
  _swimToShore(m, dt) {
    if (!m.inWater) return false;
    m.shoreTimer = (m.shoreTimer || 0) - dt;
    if (m.shoreTimer <= 0) {
      m.shoreTimer = 1.5;
      const ang = this._findShore(m);
      this._setDir(m, ang ?? Math.random() * TAU);
    }
    m.grazing = false;
    m.speed = m.species.walkSpeed * 1.2;
    return true;
  }

  _lookAtPlayer(m, c, maxYaw = 0.9) {
    const dx = c.ex - m.pos.x;
    const dz = c.ez - m.pos.z;
    const dy = c.ey - (m.pos.y + m.species.height * 0.8);
    const yawTo = Math.atan2(dx, dz);
    return { yaw: clamp(wrapAngle(yawTo - m.yaw), -maxYaw, maxYaw), pitch: clamp(-Math.atan2(dy, Math.hypot(dx, dz)), -0.6, 0.5) };
  }

  _thinkPassive(m, dt, c) {
    const sp = m.species;
    m.stateTimer -= dt;
    let lookYaw = 0;
    let lookPitch = 0;

    if (m.state === 'flee') {
      m.grazing = false;
      if (m.stateTimer <= 0) {
        this._setIdle(m);
      } else {
        m.fleeTurn -= dt;
        if (m.fleeTurn <= 0 || m.blockedTime > 0.3) {
          const away = Math.atan2(m.pos.x - m.fleeX, m.pos.z - m.fleeZ);
          this._setDir(m, away + rand(-0.9, 0.9) + (m.blockedTime > 0.3 ? rand(-1.5, 1.5) : 0));
          m.fleeTurn = rand(0.5, 1.2);
          m.blockedTime = 0;
        }
        const ahead = this._probeAhead(m, m.dirX, m.dirZ);
        if (ahead.drop >= 4 && !ahead.water) this._setDir(m, Math.atan2(m.dirX, m.dirZ) + rand(1.6, 3.1) * (Math.random() < 0.5 ? -1 : 1));
        m.speed = sp.runSpeed;
        // Burrowbucks bound away in hops
        if (sp === BURROWBUCK && m.onGround && !m.inWater && m.knockTimer <= 0) m.vel.y = 5.2;
      }
    } else if (this._swimToShore(m, dt)) {
      m.state = 'wander';
      m.stateTimer = Math.max(m.stateTimer, 1);
    } else if (m.state === 'wander') {
      m.speed = sp.walkSpeed;
      const ahead = this._probeAhead(m, m.dirX, m.dirZ);
      if (m.stateTimer <= 0) {
        this._setIdle(m);
      } else if (ahead.drop >= 3 || ahead.water || m.blockedTime > 0.4) {
        m.blockedTime = 0;
        if (Math.random() < 0.4) this._setIdle(m);
        else this._setDir(m, Math.atan2(m.dirX, m.dirZ) + rand(1.2, 3.1) * (Math.random() < 0.5 ? -1 : 1));
      }
    } else {
      // idle: stand around, graze, watch the player
      m.speed = 0;
      if (m.stateTimer <= 0) {
        m.state = 'wander';
        m.grazing = false;
        m.stateTimer = rand(2, 6);
        this._setDir(m, Math.random() * TAU);
      } else if (!m.grazing && Math.hypot(c.px - m.pos.x, c.pz - m.pos.z) < 8) {
        const l = this._lookAtPlayer(m, c);
        lookYaw = l.yaw;
        lookPitch = l.pitch;
      }
    }
    m.headYaw = approach(m.headYaw, lookYaw, dt * 3);
    m.headPitch = approach(m.headPitch, lookPitch, dt * 3);
  }

  _setIdle(m) {
    m.state = 'idle';
    m.stateTimer = rand(2, 7);
    m.speed = 0;
    m.grazing = !m.hostile && Math.random() < 0.55;
  }

  _thinkHostile(m, dt, c) {
    const sp = m.species;
    m.stateTimer -= dt;
    const dx = c.px - m.pos.x;
    const dz = c.pz - m.pos.z;
    const hd = Math.hypot(dx, dz);
    const d3 = Math.hypot(dx, c.py - m.pos.y, dz);
    const eyeY = m.pos.y + sp.height * 0.85;

    m.senseTimer -= dt;
    if (m.senseTimer <= 0) {
      m.senseTimer = rand(0.2, 0.35);
      if (c.canAttack && d3 < sp.sense * (m.aggro > 0 ? 1.6 : 1)) {
        m.seesPlayer = this._lineOfSight(m.pos.x, eyeY, m.pos.z, c.ex, c.ey, c.ez);
        // out in the open, monsters also track an outdoor player by sound at closer range
        const heard = m.skyExposed && c.playerOutdoors && d3 < sp.sense * 0.6;
        if (m.seesPlayer || heard || d3 < 2.5 || m.aggro > 0) {
          if (m.state !== 'chase') {
            m.state = 'chase';
            m.grazing = false;
            this._sound('mobIdle', m.pos.x, eyeY, m.pos.z, { volume: 0.6, pitch: sp.voice * 1.1, material: 'monster', range: 22 });
          }
          if (m.seesPlayer || heard) m.lastSeen = this.time;
        }
      } else {
        m.seesPlayer = false;
      }
    }

    if (m.state === 'chase') {
      const lost = !c.canAttack || d3 > sp.sense * 1.7 || (this.time - m.lastSeen > 6 && m.aggro <= 0);
      if (lost) {
        m.windup = 0;
        m.attackT = -1;
        this._setIdle(m);
        return;
      }
      const ang = Math.atan2(dx, dz);
      // When stuck against a wall, slide along it for a moment.
      if (m.blockedTime > 0.35 && !m.leaping) {
        m.blockedTime = 0;
        m.sideTimer = rand(0.6, 1.2);
        m.sideSign = Math.random() < 0.5 ? -1 : 1;
      }
      m.sideTimer -= dt;
      this._setDir(m, m.sideTimer > 0 ? ang + m.sideSign * 1.25 : ang);
      m.faceYaw = ang;
      m.speed = sp.runSpeed;

      // Don't stride off big drops unless the player is down there too.
      const ahead = this._probeAhead(m, m.dirX, m.dirZ);
      if (ahead.drop >= 5 && c.py > m.pos.y - 3 && !ahead.water) m.speed = 0;

      const gap = this._gapToPlayer(m, c);
      const look = this._lookAtPlayer(m, c, 0.8);
      m.headYaw = approach(m.headYaw, look.yaw, dt * 4);
      m.headPitch = approach(m.headPitch, look.pitch, dt * 4);

      if (sp.leap) this._crawlerCombat(m, dt, c, gap, hd);
      else this._walkerCombat(m, dt, c, gap);
      return;
    }

    // wander / idle like the animals, but never graze
    if (this._swimToShore(m, dt)) {
      m.state = 'wander';
      m.stateTimer = Math.max(m.stateTimer, 1);
    } else if (m.state === 'wander') {
      m.speed = sp.walkSpeed;
      const ahead = this._probeAhead(m, m.dirX, m.dirZ);
      if (m.stateTimer <= 0) this._setIdle(m);
      else if (ahead.drop >= 3 || ahead.water || m.blockedTime > 0.4) {
        m.blockedTime = 0;
        this._setDir(m, Math.atan2(m.dirX, m.dirZ) + rand(1.2, 3.1) * (Math.random() < 0.5 ? -1 : 1));
      }
    } else {
      m.state = 'idle';
      m.speed = 0;
      if (m.stateTimer <= 0) {
        m.state = 'wander';
        m.stateTimer = rand(3, 7);
        // prowl: at night, roaming drifts toward the player
        if (c.canAttack && hd < 48 && Math.random() < 0.65) this._setDir(m, Math.atan2(dx, dz) + rand(-0.6, 0.6));
        else this._setDir(m, Math.random() * TAU);
      }
    }
    m.headYaw = approach(m.headYaw, Math.sin(this.time * 0.7 + m.seed) * 0.4, dt * 1.5);
    m.headPitch = approach(m.headPitch, 0, dt * 2);
  }

  _walkerCombat(m, dt, c, gap) {
    const sp = m.species;
    if (gap < sp.attackRange * 0.75) m.speed = 0; // close enough: plant feet and swing
    if (m.attackT < 0) {
      if (gap < sp.attackRange && m.attackCooldown <= 0 && m.seesPlayer) {
        m.attackT = 0;
        m.attackHit = false;
      }
      return;
    }
    // telegraphed overhead slam: damage lands mid-swing if the player is still in reach
    m.attackT += dt / sp.attackTime;
    m.speed *= 0.3;
    if (!m.attackHit && m.attackT >= 0.5) {
      m.attackHit = true;
      if (gap < sp.attackRange + 0.45 && this._lineOfSight(m.pos.x, m.pos.y + sp.height * 0.8, m.pos.z, c.ex, c.ey, c.ez)) {
        this._hitPlayer(m, sp.damage, c);
      }
      this._sound('step', m.pos.x, m.pos.y, m.pos.z, { volume: 0.8, pitch: 0.45, material: 'stone', range: 18 });
    }
    if (m.attackT >= 1) {
      m.attackT = -1;
      m.attackCooldown = sp.attackCooldown;
    }
  }

  _crawlerCombat(m, dt, c, gap, hd) {
    const sp = m.species;
    if (m.leaping) {
      m.leapAir += dt;
      // a leap that connects bites once
      if (!m.leapHit && gap < 0.25) {
        m.leapHit = true;
        m.anim.bite = 1;
        this._hitPlayer(m, sp.leapDamage, c);
        m.attackCooldown = sp.attackCooldown;
      }
      if (m.onGround && m.leapAir > 0.12) m.leaping = false;
      return;
    }
    if (m.windup > 0) {
      m.speed = 0;
      m.windup -= dt;
      if (m.windup <= 0) {
        // launch so the arc lands just in front of the player
        const vy = 7.6;
        const air = (2 * vy) / GRAVITY;
        const dx = c.px - m.pos.x;
        const dz = c.pz - m.pos.z;
        const d = Math.hypot(dx, dz) || 1;
        const hsp = clamp((d - (sp.width / 2 + PLAYER_WIDTH / 2 + 0.1)) / air, 4, 10);
        m.vel.x = (dx / d) * hsp;
        m.vel.z = (dz / d) * hsp;
        m.vel.y = vy;
        m.leaping = true;
        m.leapAir = 0;
        m.leapHit = false;
        m.onGround = false;
        m.leapCooldown = rand(2.2, 3.6);
        m.anim.kick = 1;
        this._sound('mobHurt', m.pos.x, m.pos.y, m.pos.z, { volume: 0.4, pitch: sp.voice * 1.2, material: 'monster', range: 18 });
      }
      return;
    }
    if (gap < sp.attackRange) {
      m.speed = 0;
      if (m.attackCooldown <= 0 && m.seesPlayer) {
        m.attackCooldown = sp.attackCooldown;
        m.anim.bite = 1;
        this._hitPlayer(m, sp.damage, c);
        this._sound('dig', m.pos.x, m.pos.y, m.pos.z, { volume: 0.6, pitch: 1.7, material: 'gravel', range: 16 });
      }
      return;
    }
    if (m.onGround && !m.inWater && m.leapCooldown <= 0 && m.seesPlayer && hd > 2 && hd < 7 &&
        Math.abs(c.py - m.pos.y) < 2.5) {
      m.windup = 0.32;
    }
  }

  // ------------------------------------------------------------------------------------------
  // Damage / death

  _hurt(m, amount, { kx = 0, kz = 0, byPlayer = false, hx, hy, hz } = {}) {
    if (m.dead) return;
    const sp = m.species;
    m.health -= amount;
    m.hurtTimer = 0.32;
    m.invuln = 0.45;
    if (kx || kz) {
      const k = (m.hostile ? 6 : 7) * (sp.knockResist ?? 1);
      m.vel.x = kx * k;
      m.vel.z = kz * k;
      m.vel.y = m.onGround || m.inWater ? 5.2 * Math.max(0.6, sp.knockResist ?? 1) : Math.max(m.vel.y, 2);
      m.knockTimer = 0.35;
      m.windup = 0;
      m.leaping = false;
      m.attackT = -1;
      m.deathSide = Math.random() < 0.5 ? -1 : 1;
    }
    const b = this._brightness(m);
    if (hx !== undefined) this.particles.emit(hx, hy, hz, sp.colors, 4, { speed: 1.5, up: 2, size: 0.07, life: 0.45, spread: 0.1, brightness: b });
    if (byPlayer) {
      if (m.hostile) {
        m.aggro = 10;
        m.state = 'chase';
        m.lastSeen = this.time;
      } else {
        m.state = 'flee';
        m.stateTimer = rand(4.5, 6.5);
        m.fleeX = this._ctx.px;
        m.fleeZ = this._ctx.pz;
        m.fleeTurn = 0;
        m.grazing = false;
      }
    }
    if (m.health <= 0) {
      this._die(m, byPlayer, 'death');
    } else {
      this._sound('mobHurt', m.pos.x, m.pos.y + sp.height * 0.6, m.pos.z, { volume: 0.8, pitch: sp.voice * rand(0.95, 1.08), material: voiceOf(m), range: 24 });
    }
  }

  _die(m, byPlayer, kind) {
    if (m.dead) return;
    const sp = m.species;
    m.dead = true;
    m.deathKind = kind;
    m.deathTimer = 0;
    m.speed = 0;
    m.health = 0;
    if (kind === 'death') {
      m.hurtTimer = 10;
      this._sound('mobDeath', m.pos.x, m.pos.y + sp.height * 0.5, m.pos.z, { volume: 0.9, pitch: sp.voice, material: voiceOf(m), range: 26 });
    } else {
      this._sound('dig', m.pos.x, m.pos.y, m.pos.z, { volume: 0.6, pitch: 0.8, material: sp === CAIRNWALKER ? 'stone' : 'gravel', range: 18 });
    }
    // eyes go dark
    for (const mesh of m.glowMeshes) mesh.material = m.material;
    if (byPlayer && kind === 'death' && this._ctx.survival && this.inventory && typeof this.inventory.add === 'function') {
      let gotAny = false;
      for (const d of sp.drops) {
        if (d.chance !== undefined && Math.random() >= d.chance) continue;
        const n = randInt(d.min, d.max);
        if (n <= 0) continue;
        try {
          const left = this.inventory.add(d.id, n);
          if (!(left >= n)) gotAny = true; // anything accepted
          if (left > 0 && this.onDropLost) this.onDropLost(d.id, left); // no room: the rest is lost
        } catch (err) {
          console.warn('mobs: inventory.add failed', err);
        }
      }
      if (gotAny) this._sound('pop', m.pos.x, m.pos.y, m.pos.z, { volume: 0.6, pitch: rand(0.9, 1.3), range: 20 });
    }
  }

  _animateDeath(m, dt) {
    const sp = m.species;
    m.deathTimer += dt;
    const t = m.deathTimer;
    const b = this._brightness(m);
    if (m.deathKind === 'crumble') {
      // shiver, then sink into the ground in a cloud of grit
      const dur = 1.6;
      const p = Math.min(1, t / dur);
      m.model.position.set(Math.sin(t * 47) * 0.025 * (1 - p), -sp.height * smooth(p) * 0.9, Math.cos(t * 39) * 0.02 * (1 - p));
      m.model.rotation.z = Math.sin(t * 9) * 0.05;
      m.fade = Math.min(m.fade, 1 - smooth(Math.max(0, (p - 0.5) / 0.5)));
      m.dustTimer = (m.dustTimer || 0) - dt;
      if (m.dustTimer <= 0) {
        m.dustTimer = 0.08;
        this.particles.emit(m.pos.x, m.pos.y + 0.05, m.pos.z, sp.colors, 2, { speed: 1.2, up: 2.2, size: 0.08, life: 0.6, spread: sp.width * 0.4, brightness: b });
      }
      if (t >= dur) m.remove = true;
      return;
    }
    // topple onto one side, then puff away
    const p = Math.min(1, t / 0.45);
    m.model.rotation.z = m.deathSide * (Math.PI / 2) * p * p;
    m.model.position.y = Math.sin(p * Math.PI) * 0.12;
    if (t > 0.6) {
      const q = Math.min(1, (t - 0.6) / 0.35);
      m.model.scale.setScalar(1 - q * 0.5);
      m.fade = Math.min(m.fade, 1 - q);
    }
    if (t >= 0.95) {
      this.particles.emit(m.pos.x, m.pos.y + sp.height * 0.3, m.pos.z, sp.colors, 14, {
        speed: 2.2, up: 3, size: 0.1, life: 0.8, spread: sp.width * 0.4, brightness: b,
      });
      m.remove = true;
    }
  }

  // ------------------------------------------------------------------------------------------
  // Physics: AABB vs voxels, swept one axis at a time in sub-steps, with a jump to climb 1-block steps.

  _physics(m, dt) {
    const sp = m.species;
    const h = sp.height;
    m.inWater = this._isWaterAt(m.pos.x, m.pos.y + 0.15, m.pos.z) || this._isWaterAt(m.pos.x, m.pos.y + h * 0.5, m.pos.z);
    const submerged = this._isWaterAt(m.pos.x, m.pos.y + h * 0.55, m.pos.z);

    // Horizontal steering toward the desired velocity (plus soft pushes).
    m.knockTimer = Math.max(0, m.knockTimer - dt);
    const speedMul = m.inWater ? 0.55 : 1;
    const tvx = m.dirX * m.speed * speedMul + m.pushX;
    const tvz = m.dirZ * m.speed * speedMul + m.pushZ;
    if (m.leaping) {
      // keep the leap's momentum
    } else if (m.knockTimer > 0) {
      if (m.onGround) {
        const f = Math.max(0, 1 - 5 * dt);
        m.vel.x *= f;
        m.vel.z *= f;
      }
    } else {
      const k = Math.min(1, (m.onGround ? 14 : m.inWater ? 5 : 2.5) * dt);
      m.vel.x += (tvx - m.vel.x) * k;
      m.vel.z += (tvz - m.vel.z) * k;
    }

    // Vertical: gravity, or buoyancy that floats mobs with their back above the surface.
    if (m.inWater) {
      if (m.waterClimb > 0) {
        // scrambling up a bank: plain ballistic motion so the boost carries it over the edge
        m.waterClimb -= dt;
        m.vel.y -= GRAVITY * dt;
      } else {
        m.vel.y += (submerged ? GRAVITY * 0.32 : -GRAVITY * 0.25) * dt;
        m.vel.y *= Math.max(0, 1 - 2.5 * dt);
        m.vel.y = clamp(m.vel.y, -4, 3);
      }
      m.peakY = m.pos.y;
    } else {
      m.vel.y = Math.max(m.vel.y - GRAVITY * dt, -45);
    }

    const wasOnGround = m.onGround;
    const maxD = Math.max(Math.abs(m.vel.x), Math.abs(m.vel.y), Math.abs(m.vel.z)) * dt;
    const steps = Math.max(1, Math.ceil(maxD / 0.35));
    const sdt = dt / steps;
    m.onGround = false;
    m.collidedH = false;
    for (let i = 0; i < steps; i++) {
      if (this._moveAxis(m, 1, m.vel.y * sdt)) {
        if (m.vel.y < 0) m.onGround = true;
        m.vel.y = 0;
      }
      if (this._moveAxis(m, 0, m.vel.x * sdt)) { m.vel.x = 0; m.collidedH = true; }
      if (this._moveAxis(m, 2, m.vel.z * sdt)) { m.vel.z = 0; m.collidedH = true; }
    }

    // Fall damage, like the player's: ceil(distance - 3).
    if (!m.onGround) {
      m.peakY = Math.max(m.peakY, m.pos.y);
    } else {
      if (!wasOnGround && !m.dead) {
        const fall = m.peakY - m.pos.y;
        if (fall > 3.5 && !m.inWater) this._hurt(m, Math.ceil(fall - 3), {});
      }
      m.peakY = m.pos.y;
    }

    // Blocked while trying to walk: hop up a 1-block step if there's headroom, otherwise report being stuck.
    const wantsMove = m.speed > 0.05 && !m.dead;
    if (m.collidedH && wantsMove && m.knockTimer <= 0) {
      if (m.inWater) {
        // swimming into a bank: kick upward so it can clamber out (up to ~1 block above the surface)
        m.vel.y = Math.max(m.vel.y, JUMP_VELOCITY);
        m.waterClimb = 0.25;
        m.blockedTime += dt * 0.5;
      } else if (m.onGround && this._canStepUp(m)) {
        m.vel.y = JUMP_VELOCITY;
        m.onGround = false;
        m.blockedTime = 0;
      } else if (m.onGround) {
        m.blockedTime += dt;
      }
    } else if (wantsMove && Math.hypot(m.vel.x, m.vel.z) > m.speed * 0.4) {
      m.blockedTime = 0;
    }

    // Embedded in a block (e.g. one was placed on it): nudge upward out of it.
    if (this._solid(Math.floor(m.pos.x), Math.floor(m.pos.y + 0.5), Math.floor(m.pos.z)) &&
        !this._solid(Math.floor(m.pos.x), Math.floor(m.pos.y + 1.5), Math.floor(m.pos.z))) {
      m.pos.y = Math.floor(m.pos.y + 0.5) + 1;
      m.vel.y = 0;
    }
  }

  // Moves one axis (0 = x, 1 = y, 2 = z) by d (|d| < 1) and resolves against the newly entered voxel slab.
  _moveAxis(m, axis, d) {
    if (d === 0) return false;
    const p = m.pos;
    const hw = m.species.width / 2;
    const h = m.species.height;
    if (axis === 1) {
      const oldY = p.y;
      p.y += d;
      const x0 = Math.floor(p.x - hw + E);
      const x1 = Math.floor(p.x + hw - E);
      const z0 = Math.floor(p.z - hw + E);
      const z1 = Math.floor(p.z + hw - E);
      if (d < 0) {
        const row = Math.floor(p.y);
        if (row >= Math.floor(oldY)) return false;
        for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
          if (this._solid(x, row, z)) { p.y = row + 1; return true; }
        }
      } else {
        const row = Math.floor(p.y + h - E);
        if (row <= Math.floor(oldY + h - E)) return false;
        for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
          if (this._solid(x, row, z)) { p.y = row - h; return true; }
        }
      }
      return false;
    }
    const y0 = Math.floor(p.y + E);
    const y1 = Math.floor(p.y + h - E);
    if (axis === 0) {
      const old = p.x;
      p.x += d;
      const z0 = Math.floor(p.z - hw + E);
      const z1 = Math.floor(p.z + hw - E);
      if (d > 0) {
        const col = Math.floor(p.x + hw - E);
        if (col <= Math.floor(old + hw - E)) return false;
        for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
          if (this._solid(col, y, z)) { p.x = col - hw; return true; }
        }
      } else {
        const col = Math.floor(p.x - hw + E);
        if (col >= Math.floor(old - hw + E)) return false;
        for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
          if (this._solid(col, y, z)) { p.x = col + 1 + hw; return true; }
        }
      }
      return false;
    }
    const old = p.z;
    p.z += d;
    const x0 = Math.floor(p.x - hw + E);
    const x1 = Math.floor(p.x + hw - E);
    if (d > 0) {
      const col = Math.floor(p.z + hw - E);
      if (col <= Math.floor(old + hw - E)) return false;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        if (this._solid(x, y, col)) { p.z = col - hw; return true; }
      }
    } else {
      const col = Math.floor(p.z - hw + E);
      if (col >= Math.floor(old - hw + E)) return false;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        if (this._solid(x, y, col)) { p.z = col + 1 + hw; return true; }
      }
    }
    return false;
  }

  // Is the obstacle ahead exactly one block tall with room for the mob on top of it?
  _canStepUp(m) {
    const sp = m.species;
    const hw = sp.width / 2;
    const fy = Math.floor(m.pos.y + 0.01);
    const cells = Math.max(1, Math.ceil(sp.height - 1e-3));
    const cx = Math.floor(m.pos.x);
    const cz = Math.floor(m.pos.z);
    // headroom above the mob for the jump itself
    if (this._solid(cx, Math.floor(m.pos.y + sp.height + 0.6), cz)) return false;
    // probe straight ahead, and the two axis-aligned neighbours for diagonal movement
    const probes = [[m.dirX, m.dirZ], [Math.sign(m.dirX), 0], [0, Math.sign(m.dirZ)]];
    for (const [px, pz] of probes) {
      if (!px && !pz) continue;
      const ax = Math.floor(m.pos.x + px * (hw + 0.3));
      const az = Math.floor(m.pos.z + pz * (hw + 0.3));
      if (ax === cx && az === cz) continue;
      if (!this._solid(ax, fy, az)) continue;
      let clear = true;
      for (let k = 1; k <= cells; k++) if (this._solid(ax, fy + k, az)) { clear = false; break; }
      if (clear) return true;
    }
    return false;
  }

  // ------------------------------------------------------------------------------------------
  // Visuals: lighting, hurt flash, fades, shadow, transform.

  // Linear light factor at a mob (for particles); the materials use the full tinted colour.
  _brightness(m) {
    return Math.max(0.01, this._lightLin * m.light);
  }

  _updateVisual(m, dt) {
    const sp = m.species;
    m.lightTimer -= dt;
    if (m.lightTimer <= 0) {
      m.lightTimer = rand(0.3, 0.5);
      m.skyExposed = this._skyExposed(m.pos.x, m.pos.y + sp.height, m.pos.z);
    }
    m.light = approach(m.light, m.skyExposed ? 1 : CAVE_LIGHT, dt * 2);
    const col = m.material.color;
    if (m.hurtTimer > 0) {
      // red flash, kept visible even in the dark
      const r = Math.max(this._lightLin * m.light, 0.3);
      col.setRGB(r, r * 0.3, r * 0.3);
    } else {
      col.copy(this._lightColor).multiplyScalar(m.light);
    }
    if (m.glowMaterial && !m.dead) {
      const g = sp.glowColor || [1, 1, 1];
      const pulse = 0.85 + 0.15 * Math.sin(this.time * 2.7 + m.seed);
      m.glowMaterial.color.setRGB(g[0] * pulse, g[1] * pulse, g[2] * pulse);
    }
    m._setOpacity(m.fade);

    m.group.position.copy(m.pos);
    m.group.rotation.y = m.yaw;
    if (!m.dead) m.model.position.y = m.bob;

    // Blob shadow on the ground below (up to 4 blocks down).
    const gx = Math.floor(m.pos.x);
    const gz = Math.floor(m.pos.z);
    const fy = Math.floor(m.pos.y + 0.01);
    let ground = -1;
    for (let k = 0; k < 5; k++) {
      if (this._solid(gx, fy - 1 - k, gz)) { ground = fy - k; break; }
    }
    if (ground < 0 || m.inWater || m.deathKind === 'crumble') {
      m.shadow.visible = false;
    } else {
      const above = m.pos.y - ground;
      const s = sp.width * 1.35 * clamp(1 - above / 5, 0.2, 1) * (m.dead ? clamp(1 - m.deathTimer, 0, 1) : 1) * m.fade;
      m.shadow.visible = s > 0.02;
      m.shadow.position.y = ground - m.pos.y + 0.02;
      m.shadow.scale.set(s, 1, s * (sp === CAIRNWALKER ? 1 : 1.25));
    }
  }
}

// Slab test: distance along the ray to the box, or null.
function rayBox(ox, oy, oz, dx, dy, dz, x0, y0, z0, x1, y1, z1) {
  let tmin = 0;
  let tmax = Infinity;
  const o = [ox, oy, oz];
  const d = [dx, dy, dz];
  const lo = [x0, y0, z0];
  const hi = [x1, y1, z1];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) {
      if (o[i] < lo[i] || o[i] > hi[i]) return null;
      continue;
    }
    let t1 = (lo[i] - o[i]) / d[i];
    let t2 = (hi[i] - o[i]) / d[i];
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  return tmin;
}
