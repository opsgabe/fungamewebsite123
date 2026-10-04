// Terrablock item registry. Pure data: no DOM, safe for workers and Node tests.
//
// Block items reuse their block id (1..49); everything else lives at 256+ (ids fixed by ARCHITECTURE.md).
// getItem(id) returns a frozen definition:
//   { id, name, maxStack, isBlock, tile, category, tool?: { type, tier, speed, damage }, food?: { hunger, saturation } }

import { B, BLOCKS } from './blocks.js';

export const I = Object.freeze({
  STICK: 256,
  COAL: 257,
  IRON_INGOT: 258,
  GOLD_INGOT: 259,
  DIAMOND: 260,
  WOODEN_PICKAXE: 261,
  WOODEN_AXE: 262,
  WOODEN_SHOVEL: 263,
  WOODEN_SWORD: 264,
  STONE_PICKAXE: 265,
  STONE_AXE: 266,
  STONE_SHOVEL: 267,
  STONE_SWORD: 268,
  IRON_PICKAXE: 269,
  IRON_AXE: 270,
  IRON_SHOVEL: 271,
  IRON_SWORD: 272,
  DIAMOND_PICKAXE: 273,
  DIAMOND_AXE: 274,
  DIAMOND_SHOVEL: 275,
  DIAMOND_SWORD: 276,
  APPLE: 277,
  RAW_MEAT: 278,
  COOKED_MEAT: 279,
});

// Tool tiers / speeds from the contract. Index = tier.
export const TOOL_TIERS = Object.freeze(['Wooden', 'Stone', 'Iron', 'Diamond']);
export const TOOL_SPEEDS = Object.freeze([2, 4, 6, 8]);
export const HAND = Object.freeze({ type: null, tier: -1, speed: 1, damage: 1 });

// Damage in half-hearts. Swords per the contract; the other tools land in the 2..4 band.
const TOOL_DAMAGE = Object.freeze({
  sword: [4, 5, 6, 7],
  axe: [3, 3, 4, 4],
  pickaxe: [2, 3, 3, 4],
  shovel: [2, 2, 3, 3],
});
const TOOL_ORDER = ['pickaxe', 'axe', 'shovel', 'sword'];
const TOOL_LABEL = { pickaxe: 'Pickaxe', axe: 'Axe', shovel: 'Shovel', sword: 'Sword' };

// Saturation follows the classic "hunger x modifier x 2" rule.
const FOOD = Object.freeze({
  [I.APPLE]: { hunger: 4, saturation: 2.4 },
  [I.RAW_MEAT]: { hunger: 3, saturation: 1.8 },
  [I.COOKED_MEAT]: { hunger: 8, saturation: 12.8 },
});

const ITEM_TILE_BASE = 192; // itemTile(id) = 192 + (id - 256), mirrored from textures.js (which is browser-only)

// Creative palette categories.
const BLOCK_CATEGORY = {
  building: [
    B.STONE, B.COBBLESTONE, B.MOSSY_COBBLESTONE, B.STONE_BRICKS, B.BRICKS, B.SANDSTONE, B.PLANKS,
    B.OBSIDIAN, B.BEDROCK, B.GLASS,
  ],
  nature: [
    B.GRASS, B.SNOWY_GRASS, B.DIRT, B.SAND, B.GRAVEL, B.CLAY, B.SNOW, B.ICE, B.LOG, B.BIRCH_LOG, B.SPRUCE_LOG,
    B.LEAVES, B.BIRCH_LEAVES, B.SPRUCE_LEAVES, B.CACTUS, B.TALL_GRASS, B.FLOWER_RED, B.FLOWER_YELLOW, B.DEAD_BUSH,
    B.PUMPKIN, B.MELON, B.COAL_ORE, B.IRON_ORE, B.GOLD_ORE, B.DIAMOND_ORE,
  ],
  decor: [
    B.CRAFTING_TABLE, B.FURNACE, B.BOOKSHELF, B.WOOL_WHITE, B.WOOL_RED, B.WOOL_YELLOW, B.WOOL_GREEN, B.WOOL_BLUE,
    B.WOOL_BLACK, B.COAL_BLOCK, B.IRON_BLOCK, B.GOLD_BLOCK, B.DIAMOND_BLOCK,
  ],
};

export const CATEGORIES = Object.freeze(['building', 'nature', 'decor', 'tools', 'materials', 'food']);

const ITEMS = new Map();

function register(def) {
  ITEMS.set(def.id, Object.freeze(def));
}

// Block items. Air is not an item; water exists as an item (for completeness) but is kept out of the palette.
const blockCategory = new Map();
for (const [cat, ids] of Object.entries(BLOCK_CATEGORY)) for (const id of ids) blockCategory.set(id, cat);
for (const def of BLOCKS) {
  if (!def || def.id === B.AIR) continue;
  register({
    id: def.id,
    name: def.name,
    maxStack: 64,
    isBlock: true,
    tile: def.textures.side,
    category: blockCategory.get(def.id) || 'nature',
  });
}

function plainItem(id, name, category, extra = {}) {
  register({ id, name, maxStack: 64, isBlock: false, tile: ITEM_TILE_BASE + (id - 256), category, ...extra });
}

plainItem(I.STICK, 'Stick', 'materials');
plainItem(I.COAL, 'Coal', 'materials');
plainItem(I.IRON_INGOT, 'Iron Ingot', 'materials');
plainItem(I.GOLD_INGOT, 'Gold Ingot', 'materials');
plainItem(I.DIAMOND, 'Diamond', 'materials');

for (let tier = 0; tier < 4; tier++) {
  for (let k = 0; k < 4; k++) {
    const type = TOOL_ORDER[k];
    const id = 261 + tier * 4 + k;
    register({
      id,
      name: `${TOOL_TIERS[tier]} ${TOOL_LABEL[type]}`,
      maxStack: 1,
      isBlock: false,
      tile: ITEM_TILE_BASE + (id - 256),
      category: 'tools',
      tool: Object.freeze({ type, tier, speed: TOOL_SPEEDS[tier], damage: TOOL_DAMAGE[type][tier] }),
    });
  }
}

plainItem(I.APPLE, 'Apple', 'food', { food: Object.freeze(FOOD[I.APPLE]) });
plainItem(I.RAW_MEAT, 'Raw Meat', 'food', { food: Object.freeze(FOOD[I.RAW_MEAT]) });
plainItem(I.COOKED_MEAT, 'Cooked Meat', 'food', { food: Object.freeze(FOOD[I.COOKED_MEAT]) });

// Definition for an item id, or null for air / unknown ids.
export function getItem(id) {
  return ITEMS.get(id) || null;
}

export function isValidItem(id) {
  return ITEMS.has(id);
}

export function maxStackOf(id) {
  const it = ITEMS.get(id);
  return it ? it.maxStack : 64;
}

export function itemName(id) {
  const it = ITEMS.get(id);
  return it ? it.name : 'Unknown';
}

// Tool stats for a held item id (bare hand for non-tools / empty hand).
export function toolOf(id) {
  const it = id ? ITEMS.get(id) : null;
  return it && it.tool ? it.tool : HAND;
}

export function isFood(id) {
  const it = ITEMS.get(id);
  return !!(it && it.food);
}

// All registered ids (blocks first, then items) in id order.
export const ALL_ITEMS = Object.freeze([...ITEMS.keys()].sort((a, b) => a - b));

// Ordered creative palette: building blocks, natural blocks, decoration, then tools, materials, food.
export const CREATIVE_ITEMS = Object.freeze([
  ...BLOCK_CATEGORY.building,
  ...BLOCK_CATEGORY.nature,
  ...BLOCK_CATEGORY.decor,
  ...[0, 1, 2, 3].flatMap((tier) => [0, 1, 2, 3].map((k) => 261 + tier * 4 + k)),
  I.STICK, I.COAL, I.IRON_INGOT, I.GOLD_INGOT, I.DIAMOND,
  I.APPLE, I.RAW_MEAT, I.COOKED_MEAT,
]);
