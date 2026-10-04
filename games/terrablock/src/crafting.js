// Crafting recipes, smelting table and furnace fuels. Pure (no DOM).
//
// matchRecipe(grid, size): grid is a row-major array of size*size cells holding an item id, a
// { id, count } stack, or null/0 for empty. Shaped recipes match anywhere in the grid (the pattern's
// bounding box is compared, so 2x2 recipes work inside a 3x3 table) and also when mirrored left-right.
// Shapeless recipes match any arrangement of exactly their ingredients.

import { B } from './blocks.js';
import { I } from './items.js';

// Ingredient groups ("any of these").
export const LOGS = Object.freeze([B.LOG, B.BIRCH_LOG, B.SPRUCE_LOG]);
export const LEAVES = Object.freeze([B.LEAVES, B.BIRCH_LEAVES, B.SPRUCE_LEAVES]);
const COBBLES = Object.freeze([B.COBBLESTONE, B.MOSSY_COBBLESTONE]);

function result(id, count = 1) {
  return Object.freeze({ id, count });
}

// Ingredient spec -> Set of accepted ids.
function toSet(spec) {
  return new Set(Array.isArray(spec) ? spec : [spec]);
}

const recipes = [];

// rows: array of equal-length strings; ' ' is an empty cell; keys maps characters to ingredient specs.
function shaped(rows, keys, id, count = 1) {
  const h = rows.length;
  const w = rows[0].length;
  const cells = [];
  for (const row of rows) {
    if (row.length !== w) throw new Error('ragged recipe ' + rows.join('/'));
    for (const ch of row) {
      if (ch === ' ') cells.push(null);
      else if (keys[ch] === undefined) throw new Error('unknown recipe key ' + ch);
      else cells.push(keys[ch]);
    }
  }
  recipes.push({
    type: 'shaped',
    width: w,
    height: h,
    cells, // ingredient specs (id or id[]) or null, row-major w*h — handy for showing recipes
    sets: cells.map((c) => (c === null ? null : toSet(c))),
    result: result(id, count),
    size: w <= 2 && h <= 2 ? 2 : 3, // smallest crafting grid that fits it
  });
}

function shapeless(ingredients, id, count = 1) {
  recipes.push({
    type: 'shapeless',
    ingredients,
    sets: ingredients.map(toSet),
    result: result(id, count),
    size: ingredients.length <= 4 ? 2 : 3,
  });
}

// ---- wood basics -----------------------------------------------------------------------------
shapeless([LOGS], B.PLANKS, 4);
shaped(['#', '#'], { '#': B.PLANKS }, I.STICK, 4);
shaped(['##', '##'], { '#': B.PLANKS }, B.CRAFTING_TABLE);
shaped(['###', '# #', '###'], { '#': COBBLES }, B.FURNACE);

// ---- tools: four shapes x four materials -----------------------------------------------------
const TOOL_MATERIALS = [B.PLANKS, COBBLES, I.IRON_INGOT, I.DIAMOND];
for (let tier = 0; tier < 4; tier++) {
  const keys = { '#': TOOL_MATERIALS[tier], '|': I.STICK };
  const base = 261 + tier * 4;
  shaped(['###', ' | ', ' | '], keys, base + 0); // pickaxe
  shaped(['##', '#|', ' |'], keys, base + 1); // axe (mirrored works too)
  shaped(['#', '|', '|'], keys, base + 2); // shovel
  shaped(['#', '#', '|'], keys, base + 3); // sword
}

// ---- building blocks -------------------------------------------------------------------------
shaped(['##', '##'], { '#': B.SAND }, B.SANDSTONE);
shaped(['##', '##'], { '#': B.STONE }, B.STONE_BRICKS, 4);
shapeless([B.COBBLESTONE, LEAVES], B.MOSSY_COBBLESTONE);
shaped(['###', '|||', '###'], { '#': B.PLANKS, '|': I.STICK }, B.BOOKSHELF);

// ---- wool dyeing: white wool + a natural colourant ------------------------------------------
shapeless([B.WOOL_WHITE, B.FLOWER_RED], B.WOOL_RED);
shapeless([B.WOOL_WHITE, B.FLOWER_YELLOW], B.WOOL_YELLOW);
shapeless([B.WOOL_WHITE, B.CACTUS], B.WOOL_GREEN);
shapeless([B.WOOL_WHITE, B.CLAY], B.WOOL_BLUE);
shapeless([B.WOOL_WHITE, I.COAL], B.WOOL_BLACK);

// ---- storage blocks <-> 9 items --------------------------------------------------------------
for (const [block, item] of [
  [B.COAL_BLOCK, I.COAL],
  [B.IRON_BLOCK, I.IRON_INGOT],
  [B.GOLD_BLOCK, I.GOLD_INGOT],
  [B.DIAMOND_BLOCK, I.DIAMOND],
]) {
  shaped(['###', '###', '###'], { '#': item }, block);
  shapeless([block], item, 9);
}

export const RECIPES = Object.freeze(recipes);

// Furnace: input id -> output id (one for one).
export const SMELTING = Object.freeze({
  [B.IRON_ORE]: I.IRON_INGOT,
  [B.GOLD_ORE]: I.GOLD_INGOT,
  [B.DIAMOND_ORE]: I.DIAMOND,
  [B.COAL_ORE]: I.COAL,
  [B.SAND]: B.GLASS,
  [B.COBBLESTONE]: B.STONE,
  [B.CLAY]: B.BRICKS,
  [B.LOG]: I.COAL,
  [B.BIRCH_LOG]: I.COAL,
  [B.SPRUCE_LOG]: I.COAL,
  [I.RAW_MEAT]: I.COOKED_MEAT,
});

// Fuel id -> burn time in seconds.
export const FUELS = Object.freeze({
  [B.PLANKS]: 15,
  [B.LOG]: 15,
  [B.BIRCH_LOG]: 15,
  [B.SPRUCE_LOG]: 15,
  [B.CRAFTING_TABLE]: 15,
  [B.BOOKSHELF]: 15,
  [B.DEAD_BUSH]: 5,
  [I.STICK]: 5,
  [I.COAL]: 80,
  [B.COAL_BLOCK]: 800,
  [I.WOODEN_PICKAXE]: 10,
  [I.WOODEN_AXE]: 10,
  [I.WOODEN_SHOVEL]: 10,
  [I.WOODEN_SWORD]: 10,
});

export function smeltResult(id) {
  return SMELTING[id] ?? null;
}

export function fuelTime(id) {
  return FUELS[id] || 0;
}

// ---- matching --------------------------------------------------------------------------------

function cellId(c) {
  if (c === null || c === undefined) return 0;
  if (typeof c === 'object') return c.count > 0 || c.count === undefined ? c.id | 0 : 0;
  return c | 0;
}

function matchShaped(r, ids, size, r0, c0, w, h) {
  if (r.width !== w || r.height !== h) return false;
  let direct = true;
  let mirror = true;
  for (let y = 0; y < h && (direct || mirror); y++) {
    for (let x = 0; x < w; x++) {
      const id = ids[(r0 + y) * size + c0 + x];
      const a = r.sets[y * w + x];
      const b = r.sets[y * w + (w - 1 - x)];
      if (direct && (a === null ? id !== 0 : !a.has(id))) direct = false;
      if (mirror && (b === null ? id !== 0 : !b.has(id))) mirror = false;
    }
  }
  return direct || mirror;
}

// Perfect matching of items to ingredient sets (tiny n, plain backtracking).
function matchShapeless(r, items) {
  if (r.sets.length !== items.length) return false;
  const used = new Array(items.length).fill(false);
  const assign = (k) => {
    if (k === r.sets.length) return true;
    const set = r.sets[k];
    for (let i = 0; i < items.length; i++) {
      if (!used[i] && set.has(items[i])) {
        used[i] = true;
        if (assign(k + 1)) return true;
        used[i] = false;
      }
    }
    return false;
  };
  return assign(0);
}

// The recipe object matching the grid, or null.
export function findRecipe(grid, size) {
  if (!grid || !(size === 2 || size === 3)) return null;
  const n = size * size;
  const ids = new Array(n);
  let minR = size;
  let minC = size;
  let maxR = -1;
  let maxC = -1;
  const items = [];
  for (let i = 0; i < n; i++) {
    const id = cellId(grid[i]);
    ids[i] = id;
    if (id) {
      const r = Math.floor(i / size);
      const c = i % size;
      if (r < minR) minR = r;
      if (r > maxR) maxR = r;
      if (c < minC) minC = c;
      if (c > maxC) maxC = c;
      items.push(id);
    }
  }
  if (!items.length) return null;
  const w = maxC - minC + 1;
  const h = maxR - minR + 1;
  for (const r of RECIPES) {
    if (r.type === 'shaped' && matchShaped(r, ids, size, minR, minC, w, h)) return r;
  }
  for (const r of RECIPES) {
    if (r.type === 'shapeless' && matchShapeless(r, items)) return r;
  }
  return null;
}

// -> { id, count } | null
export function matchRecipe(grid, size) {
  const r = findRecipe(grid, size);
  return r ? { id: r.result.id, count: r.result.count } : null;
}

// Does the ingredient spec accept this id?
export function ingredientAccepts(spec, id) {
  return Array.isArray(spec) ? spec.includes(id) : spec === id;
}
