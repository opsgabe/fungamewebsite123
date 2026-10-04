// Shared constants and tiny helpers used by every Terrablock module (main thread and workers).
// Keep this file dependency-free so it can be imported from a module Worker.

export const CHUNK_SIZE = 16; // blocks along x and z
export const WORLD_HEIGHT = 128; // blocks along y (0 = bedrock floor, 127 = build limit)
export const CHUNK_AREA = CHUNK_SIZE * CHUNK_SIZE;
export const CHUNK_VOLUME = CHUNK_AREA * WORLD_HEIGHT;
export const SEA_LEVEL = 48; // water fills air at y <= SEA_LEVEL in oceans/lakes

// Local block coordinates (lx, lz in 0..15, y in 0..127) -> index into a chunk's Uint8Array.
export function blockIndex(lx, y, lz) {
  return lx + lz * CHUNK_SIZE + y * CHUNK_AREA;
}

// World coordinate -> chunk coordinate / local coordinate (works for negatives).
export function toChunk(v) {
  return Math.floor(v / CHUNK_SIZE);
}
export function toLocal(v) {
  return ((Math.floor(v) % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
}
export function chunkKey(cx, cz) {
  return cx + ',' + cz;
}

// Texture atlas layout. Tiles are 16x16 px, ATLAS_COLS x ATLAS_ROWS tiles, tile 0 at the top-left of
// the canvas, increasing left-to-right then top-to-bottom. The atlas texture uses flipY = true
// (three.js default), so v = 0 is the BOTTOM of the canvas.
export const TILE_SIZE = 16;
export const ATLAS_COLS = 16;
export const ATLAS_ROWS = 16;

// UV rectangle for a tile, inset by a tiny epsilon so nearest-filtering never samples a neighbour.
export function tileUV(tile) {
  const col = tile % ATLAS_COLS;
  const row = Math.floor(tile / ATLAS_COLS);
  const eps = 0.001 / ATLAS_COLS;
  return {
    u0: col / ATLAS_COLS + eps,
    u1: (col + 1) / ATLAS_COLS - eps,
    v0: 1 - (row + 1) / ATLAS_ROWS + eps, // bottom edge of the tile
    v1: 1 - row / ATLAS_ROWS - eps, // top edge of the tile
  };
}

// Player / physics constants (blocks, seconds).
export const PLAYER_WIDTH = 0.6;
export const PLAYER_HEIGHT = 1.8;
export const PLAYER_EYE = 1.62;
export const PLAYER_SNEAK_EYE = 1.32;
export const GRAVITY = 32;
export const JUMP_VELOCITY = 9.0; // ~1.25 block jump
export const WALK_SPEED = 4.3;
export const SPRINT_SPEED = 5.6;
export const SNEAK_SPEED = 1.3;
export const FLY_SPEED = 11;
export const REACH_SURVIVAL = 4.5;
export const REACH_CREATIVE = 5.0;

export const DAY_LENGTH_SECONDS = 20 * 60; // one full day/night cycle, like the original's 20 minutes
export const DEFAULT_RENDER_DISTANCE = 6; // chunks (radius)
export const MAX_RENDER_DISTANCE = 12;

export const HOTBAR_SIZE = 9;
export const INVENTORY_SIZE = 36; // slots 0..8 are the hotbar
