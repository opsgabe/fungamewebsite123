// Terrablock chunk worker: generates chunk block data and builds chunk meshes off the main thread.
//
// Protocol (every request carries a numeric `id` chosen by world.js, echoed back in the reply):
//   -> { type: 'generate', id, cx, cz, seed }
//   <- { type: 'generated', id, cx, cz, data }                       (data: Uint8Array, transferred)
//   -> { type: 'mesh', id, cx, cz, chunks }                          (chunks: 9 x (Uint8Array|null), index (dz+1)*3+(dx+1))
//   <- { type: 'meshed', id, cx, cz, geo: { opaque, cutout, water }, minY, maxY }   (typed arrays transferred)
//   <- { type: 'error', id, cx, cz, message }                        (job failed; world.js retries on the main thread)
//
// Edits from the save are applied on the main thread when the data arrives (it always holds the latest edits).
//
// This file is also imported by world.js (main thread) for `prepareGeometry`, so the message handler is only
// installed when actually running inside a worker.

import { generateChunk } from './worldgen.js';
import { buildChunkMesh } from './mesher.js';

// sRGB -> linear lookup (1024 steps + lerp). The mesher's vertex colours are perceptual multipliers
// (face shade x AO x skylight); three.js multiplies vertex colours in linear space and then encodes to sRGB,
// which would wash the shading out (0.5 would display as ~0.73). Converting once here makes the on-screen
// brightness equal the intended multiplier.
const LUT_SIZE = 1024;
const SRGB_TO_LINEAR = new Float32Array(LUT_SIZE + 2);
for (let i = 0; i <= LUT_SIZE + 1; i++) {
  const c = Math.min(1, i / LUT_SIZE);
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linearizeColors(colors) {
  for (let i = 0, n = colors.length; i < n; i++) {
    let c = colors[i];
    if (!(c > 0)) {
      colors[i] = 0;
      continue;
    }
    if (c >= 1) continue; // full brightness (or an unusual >1 boost) maps to itself
    c *= LUT_SIZE;
    const k = c | 0;
    const f = c - k;
    colors[i] = SRGB_TO_LINEAR[k] + (SRGB_TO_LINEAR[k + 1] - SRGB_TO_LINEAR[k]) * f;
  }
}

// A typed array that is a view into a larger (possibly reused) buffer must be copied before it is
// transferred or handed to three.js.
function own(arr) {
  return arr.byteOffset === 0 && arr.byteLength === arr.buffer.byteLength ? arr : arr.slice();
}

const LAYERS = ['opaque', 'cutout', 'water'];

/**
 * Normalise a mesher result for upload: drop empty layers, make every array own its buffer, convert vertex
 * colours to linear space and compute the vertical extent (chunk-local y) for frustum culling.
 * -> { geo: { opaque, cutout, water } (each Geo or null), minY, maxY, transfer: ArrayBuffer[] }
 */
export function prepareGeometry(result) {
  const geo = { opaque: null, cutout: null, water: null };
  const transfer = [];
  let minY = Infinity;
  let maxY = -Infinity;
  for (const layer of LAYERS) {
    const g = result && result[layer];
    if (!g || !g.indices || g.indices.length === 0 || !g.positions || g.positions.length === 0) continue;
    const positions = own(g.positions);
    const uvs = own(g.uvs);
    const colors = own(g.colors);
    const indices = own(g.indices);
    linearizeColors(colors);
    for (let i = 1, n = positions.length; i < n; i += 3) {
      const y = positions[i];
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    geo[layer] = { positions, uvs, colors, indices };
    transfer.push(positions.buffer, uvs.buffer, colors.buffer, indices.buffer);
  }
  if (minY > maxY) {
    minY = 0;
    maxY = 0;
  }
  return { geo, minY, maxY, transfer };
}

const inWorker = typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && self instanceof WorkerGlobalScope;

if (inWorker) {
  self.onmessage = (e) => {
    const msg = e.data;
    try {
      if (msg.type === 'generate') {
        const data = own(generateChunk(msg.cx, msg.cz, msg.seed));
        self.postMessage({ type: 'generated', id: msg.id, cx: msg.cx, cz: msg.cz, data }, [data.buffer]);
      } else if (msg.type === 'mesh') {
        const chunks = msg.chunks;
        const result = buildChunkMesh(msg.cx, msg.cz, (dx, dz) => chunks[(dz + 1) * 3 + (dx + 1)] || null);
        const out = prepareGeometry(result);
        self.postMessage(
          { type: 'meshed', id: msg.id, cx: msg.cx, cz: msg.cz, geo: out.geo, minY: out.minY, maxY: out.maxY },
          out.transfer,
        );
      }
    } catch (err) {
      self.postMessage({
        type: 'error',
        id: msg && msg.id,
        cx: msg && msg.cx,
        cz: msg && msg.cz,
        message: String((err && err.stack) || err),
      });
    }
  };
  // Tell the pool the module (and its imports) loaded, so it knows the worker path is usable.
  self.postMessage({ type: 'ready' });
}
