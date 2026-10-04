// Terrablock block registry. Pure data + tiny lookups: no DOM, safe to import from workers and Node.
//
// Every block id from ARCHITECTURE.md is defined here with its physics, rendering, mining and sound
// properties. Atlas tile indices live in `TILE` and are shared with textures.js, which draws them.

// ---------------------------------------------------------------------------------------------
// Block ids (fixed by the architecture contract).
export const B = Object.freeze({
  AIR: 0,
  STONE: 1,
  GRASS: 2,
  DIRT: 3,
  COBBLESTONE: 4,
  PLANKS: 5,
  BEDROCK: 6,
  WATER: 7,
  SAND: 8,
  GRAVEL: 9,
  GOLD_ORE: 10,
  IRON_ORE: 11,
  COAL_ORE: 12,
  LOG: 13,
  LEAVES: 14,
  GLASS: 15,
  SANDSTONE: 16,
  SNOWY_GRASS: 17,
  SNOW: 18,
  ICE: 19,
  CACTUS: 20,
  CLAY: 21,
  DIAMOND_ORE: 22,
  CRAFTING_TABLE: 23,
  FURNACE: 24,
  BRICKS: 25,
  TALL_GRASS: 26,
  FLOWER_RED: 27,
  FLOWER_YELLOW: 28,
  BIRCH_LOG: 29,
  BIRCH_LEAVES: 30,
  SPRUCE_LOG: 31,
  SPRUCE_LEAVES: 32,
  DEAD_BUSH: 33,
  MOSSY_COBBLESTONE: 34,
  STONE_BRICKS: 35,
  BOOKSHELF: 36,
  WOOL_WHITE: 37,
  WOOL_RED: 38,
  WOOL_BLUE: 39,
  WOOL_YELLOW: 40,
  WOOL_GREEN: 41,
  WOOL_BLACK: 42,
  COAL_BLOCK: 43,
  IRON_BLOCK: 44,
  GOLD_BLOCK: 45,
  DIAMOND_BLOCK: 46,
  OBSIDIAN: 47,
  PUMPKIN: 48,
  MELON: 49,
});

export const BLOCK_COUNT = 50; // ids 0..49 are defined

// Item ids referenced by drops (the full item table lives in items.js).
const ITEM_STICK = 256;
const ITEM_COAL = 257;
const ITEM_DIAMOND = 260;
const ITEM_APPLE = 277;

// ---------------------------------------------------------------------------------------------
// Atlas tile indices for block faces (0..175). textures.js paints exactly these tiles.
export const TILE = Object.freeze({
  STONE: 0,
  GRASS_TOP: 1,
  GRASS_SIDE: 2,
  DIRT: 3,
  COBBLESTONE: 4,
  PLANKS: 5,
  BEDROCK: 6,
  WATER: 7,
  SAND: 8,
  GRAVEL: 9,
  GOLD_ORE: 10,
  IRON_ORE: 11,
  COAL_ORE: 12,
  LOG_SIDE: 13,
  LOG_TOP: 14,
  LEAVES: 15,
  GLASS: 16,
  SANDSTONE_TOP: 17,
  SANDSTONE_SIDE: 18,
  SANDSTONE_BOTTOM: 19,
  SNOWY_GRASS_SIDE: 20,
  SNOW: 21,
  ICE: 22,
  CACTUS_TOP: 23,
  CACTUS_SIDE: 24,
  CACTUS_BOTTOM: 25,
  CLAY: 26,
  DIAMOND_ORE: 27,
  CRAFTING_TABLE_TOP: 28,
  CRAFTING_TABLE_SIDE: 29,
  CRAFTING_TABLE_FRONT: 30,
  FURNACE_FRONT: 31,
  FURNACE_SIDE: 32,
  FURNACE_TOP: 33,
  BRICKS: 34,
  TALL_GRASS: 35,
  FLOWER_RED: 36,
  FLOWER_YELLOW: 37,
  BIRCH_LOG_SIDE: 38,
  BIRCH_LOG_TOP: 39,
  BIRCH_LEAVES: 40,
  SPRUCE_LOG_SIDE: 41,
  SPRUCE_LOG_TOP: 42,
  SPRUCE_LEAVES: 43,
  DEAD_BUSH: 44,
  MOSSY_COBBLESTONE: 45,
  STONE_BRICKS: 46,
  BOOKSHELF: 47,
  WOOL_WHITE: 48,
  WOOL_RED: 49,
  WOOL_BLUE: 50,
  WOOL_YELLOW: 51,
  WOOL_GREEN: 52,
  WOOL_BLACK: 53,
  COAL_BLOCK: 54,
  IRON_BLOCK: 55,
  GOLD_BLOCK: 56,
  DIAMOND_BLOCK: 57,
  OBSIDIAN: 58,
  PUMPKIN_TOP: 59,
  PUMPKIN_SIDE: 60,
  PUMPKIN_FRONT: 61,
  MELON_SIDE: 62,
  MELON_TOP: 63,
  PUMPKIN_BOTTOM: 64,
});

// ---------------------------------------------------------------------------------------------
// Registry.
export const BLOCKS = [];

// Fast per-id lookups (index with a block id 0..255).
export const SOLID = new Uint8Array(256);
export const OPAQUE = new Uint8Array(256);
export const LIQUID = new Uint8Array(256);
export const CROSS = new Uint8Array(256);

function tex(top, side = top, bottom = top, front = side) {
  return { top, bottom, side, front };
}

// Defaults describe an ordinary opaque, solid, full cube that drops itself.
function define(id, name, o) {
  const def = {
    id,
    name,
    solid: o.solid ?? true,
    opaque: o.opaque ?? true,
    renderLayer: o.renderLayer ?? 'opaque',
    shape: o.shape ?? 'cube',
    textures: o.textures,
    hardness: o.hardness ?? 1,
    tool: o.tool ?? null,
    minTier: o.minTier ?? null,
    drop: o.drop === undefined ? id : o.drop,
    dropChance: o.dropChance ?? 1,
    sound: o.sound ?? 'stone',
    liquid: o.liquid ?? false,
    gravity: o.gravity ?? false,
    // Extra (non-contract) convenience flag: placing a block into this cell overwrites it.
    replaceable: o.replaceable ?? false,
    color: o.color,
  };
  BLOCKS[id] = def;
  SOLID[id] = def.solid ? 1 : 0;
  OPAQUE[id] = def.opaque ? 1 : 0;
  LIQUID[id] = def.liquid ? 1 : 0;
  CROSS[id] = def.shape === 'cross' ? 1 : 0;
  return def;
}

// Shorthands for the common block families.
const PLANT = { solid: false, opaque: false, renderLayer: 'cutout', shape: 'cross', hardness: 0, sound: 'grass', replaceable: false };
const LEAF = { opaque: false, renderLayer: 'cutout', hardness: 0.2, sound: 'leaves', drop: ITEM_APPLE, dropChance: 0.05 };
const ORE = { hardness: 3, tool: 'pickaxe', sound: 'stone' };
const WOOL = { hardness: 0.8, sound: 'wool' };
const METAL = { hardness: 5, tool: 'pickaxe', sound: 'stone' };

// `color` is the average colour of each block's side texture (top for flat-topped ground blocks),
// measured from the generated atlas; used for particles and debug views.
define(B.AIR, 'Air', {
  solid: false, opaque: false, renderLayer: 'none', shape: 'none', textures: tex(TILE.STONE),
  hardness: 0, drop: null, sound: 'stone', replaceable: true, color: 'rgba(0,0,0,0)',
});
define(B.STONE, 'Stone', { textures: tex(TILE.STONE), hardness: 1.5, tool: 'pickaxe', minTier: 0, drop: B.COBBLESTONE, color: '#7f7f83' });
define(B.GRASS, 'Grass Block', {
  textures: tex(TILE.GRASS_TOP, TILE.GRASS_SIDE, TILE.DIRT), hardness: 0.6, tool: 'shovel', drop: B.DIRT, sound: 'grass', color: '#5a9a35',
});
define(B.DIRT, 'Dirt', { textures: tex(TILE.DIRT), hardness: 0.5, tool: 'shovel', sound: 'dirt', color: '#7a5638' });
define(B.COBBLESTONE, 'Cobblestone', { textures: tex(TILE.COBBLESTONE), hardness: 2, tool: 'pickaxe', minTier: 0, color: '#77777a' });
define(B.PLANKS, 'Wooden Planks', { textures: tex(TILE.PLANKS), hardness: 2, tool: 'axe', sound: 'wood', color: '#a5804c' });
define(B.BEDROCK, 'Bedrock', { textures: tex(TILE.BEDROCK), hardness: -1, drop: null, color: '#48484b' });
define(B.WATER, 'Water', {
  solid: false, opaque: false, renderLayer: 'water', textures: tex(TILE.WATER), hardness: -1, drop: null,
  sound: 'grass', liquid: true, replaceable: true, color: '#2f63be',
});
define(B.SAND, 'Sand', { textures: tex(TILE.SAND), hardness: 0.5, tool: 'shovel', sound: 'sand', gravity: true, color: '#dccb95' });
define(B.GRAVEL, 'Gravel', { textures: tex(TILE.GRAVEL), hardness: 0.6, tool: 'shovel', sound: 'gravel', gravity: true, color: '#827c76' });
define(B.GOLD_ORE, 'Gold Ore', { ...ORE, textures: tex(TILE.GOLD_ORE), minTier: 2, color: '#8b8571' });
define(B.IRON_ORE, 'Iron Ore', { ...ORE, textures: tex(TILE.IRON_ORE), minTier: 1, color: '#8b827c' });
define(B.COAL_ORE, 'Coal Ore', { ...ORE, textures: tex(TILE.COAL_ORE), minTier: 0, drop: ITEM_COAL, color: '#6b6b6e' });
define(B.LOG, 'Oak Log', { textures: tex(TILE.LOG_TOP, TILE.LOG_SIDE), hardness: 2, tool: 'axe', sound: 'wood', color: '#5c4228' });
define(B.LEAVES, 'Oak Leaves', { ...LEAF, textures: tex(TILE.LEAVES), color: '#38812a' });
define(B.GLASS, 'Glass', {
  opaque: false, renderLayer: 'cutout', textures: tex(TILE.GLASS), hardness: 0.3, drop: null, sound: 'glass', color: '#c9e6ec',
});
define(B.SANDSTONE, 'Sandstone', {
  textures: tex(TILE.SANDSTONE_TOP, TILE.SANDSTONE_SIDE, TILE.SANDSTONE_BOTTOM), hardness: 0.8, tool: 'pickaxe', minTier: 0,
  color: '#d6c28b',
});
define(B.SNOWY_GRASS, 'Snowy Grass', {
  textures: tex(TILE.SNOW, TILE.SNOWY_GRASS_SIDE, TILE.DIRT), hardness: 0.6, tool: 'shovel', drop: B.DIRT, sound: 'snow',
  color: '#eef3f8',
});
define(B.SNOW, 'Snow', { textures: tex(TILE.SNOW), hardness: 0.2, tool: 'shovel', sound: 'snow', color: '#eef3f8' });
define(B.ICE, 'Ice', { textures: tex(TILE.ICE), hardness: 0.5, tool: 'pickaxe', drop: null, sound: 'glass', color: '#9cc6f3' });
define(B.CACTUS, 'Cactus', {
  opaque: false, renderLayer: 'cutout', textures: tex(TILE.CACTUS_TOP, TILE.CACTUS_SIDE, TILE.CACTUS_BOTTOM),
  hardness: 0.4, sound: 'wool', color: '#2f7a35',
});
define(B.CLAY, 'Clay', { textures: tex(TILE.CLAY), hardness: 0.6, tool: 'shovel', sound: 'dirt', color: '#9ca3b3' });
define(B.DIAMOND_ORE, 'Diamond Ore', { ...ORE, textures: tex(TILE.DIAMOND_ORE), minTier: 2, drop: ITEM_DIAMOND, color: '#76898b' });
define(B.CRAFTING_TABLE, 'Crafting Table', {
  textures: tex(TILE.CRAFTING_TABLE_TOP, TILE.CRAFTING_TABLE_SIDE, TILE.PLANKS, TILE.CRAFTING_TABLE_FRONT),
  hardness: 2.5, tool: 'axe', sound: 'wood', color: '#8a6539',
});
define(B.FURNACE, 'Furnace', {
  textures: tex(TILE.FURNACE_TOP, TILE.FURNACE_SIDE, TILE.FURNACE_TOP, TILE.FURNACE_FRONT),
  hardness: 3.5, tool: 'pickaxe', minTier: 0, color: '#77777a',
});
define(B.BRICKS, 'Bricks', { textures: tex(TILE.BRICKS), hardness: 2, tool: 'pickaxe', minTier: 0, color: '#9c4c3c' });
define(B.TALL_GRASS, 'Tall Grass', { ...PLANT, textures: tex(TILE.TALL_GRASS), drop: null, replaceable: true, color: '#56973a' });
define(B.FLOWER_RED, 'Red Flower', { ...PLANT, textures: tex(TILE.FLOWER_RED), color: '#c4362c' });
define(B.FLOWER_YELLOW, 'Yellow Flower', { ...PLANT, textures: tex(TILE.FLOWER_YELLOW), color: '#e6c534' });
define(B.BIRCH_LOG, 'Birch Log', {
  textures: tex(TILE.BIRCH_LOG_TOP, TILE.BIRCH_LOG_SIDE), hardness: 2, tool: 'axe', sound: 'wood', color: '#d9d4c8',
});
define(B.BIRCH_LEAVES, 'Birch Leaves', { ...LEAF, textures: tex(TILE.BIRCH_LEAVES), color: '#6f9c3e' });
define(B.SPRUCE_LOG, 'Spruce Log', {
  textures: tex(TILE.SPRUCE_LOG_TOP, TILE.SPRUCE_LOG_SIDE), hardness: 2, tool: 'axe', sound: 'wood', color: '#3d2a1c',
});
define(B.SPRUCE_LEAVES, 'Spruce Leaves', { ...LEAF, textures: tex(TILE.SPRUCE_LEAVES), color: '#2b5a3d' });
// Dead bushes snap into a stick when broken.
define(B.DEAD_BUSH, 'Dead Bush', { ...PLANT, textures: tex(TILE.DEAD_BUSH), drop: ITEM_STICK, replaceable: true, color: '#8a6233' });
define(B.MOSSY_COBBLESTONE, 'Mossy Cobblestone', {
  textures: tex(TILE.MOSSY_COBBLESTONE), hardness: 2, tool: 'pickaxe', minTier: 0, color: '#6c7b5e',
});
define(B.STONE_BRICKS, 'Stone Bricks', { textures: tex(TILE.STONE_BRICKS), hardness: 1.5, tool: 'pickaxe', minTier: 0, color: '#7b7a7c' });
define(B.BOOKSHELF, 'Bookshelf', { textures: tex(TILE.PLANKS, TILE.BOOKSHELF), hardness: 1.5, tool: 'axe', sound: 'wood', color: '#6e5136' });
define(B.WOOL_WHITE, 'White Wool', { ...WOOL, textures: tex(TILE.WOOL_WHITE), color: '#e4e6e6' });
define(B.WOOL_RED, 'Red Wool', { ...WOOL, textures: tex(TILE.WOOL_RED), color: '#ae3b33' });
define(B.WOOL_BLUE, 'Blue Wool', { ...WOOL, textures: tex(TILE.WOOL_BLUE), color: '#3a4ea2' });
define(B.WOOL_YELLOW, 'Yellow Wool', { ...WOOL, textures: tex(TILE.WOOL_YELLOW), color: '#e2c140' });
define(B.WOOL_GREEN, 'Green Wool', { ...WOOL, textures: tex(TILE.WOOL_GREEN), color: '#58892e' });
define(B.WOOL_BLACK, 'Black Wool', { ...WOOL, textures: tex(TILE.WOOL_BLACK), color: '#29292e' });
define(B.COAL_BLOCK, 'Coal Block', { ...METAL, textures: tex(TILE.COAL_BLOCK), minTier: 0, color: '#252527' });
define(B.IRON_BLOCK, 'Iron Block', { ...METAL, textures: tex(TILE.IRON_BLOCK), minTier: 1, color: '#cbcbcd' });
define(B.GOLD_BLOCK, 'Gold Block', { ...METAL, textures: tex(TILE.GOLD_BLOCK), hardness: 3, minTier: 2, color: '#e8c03c' });
define(B.DIAMOND_BLOCK, 'Diamond Block', { ...METAL, textures: tex(TILE.DIAMOND_BLOCK), minTier: 2, color: '#62ddd4' });
define(B.OBSIDIAN, 'Obsidian', { textures: tex(TILE.OBSIDIAN), hardness: 50, tool: 'pickaxe', minTier: 3, color: '#1f152c' });
define(B.PUMPKIN, 'Pumpkin', {
  textures: tex(TILE.PUMPKIN_TOP, TILE.PUMPKIN_SIDE, TILE.PUMPKIN_BOTTOM, TILE.PUMPKIN_FRONT),
  hardness: 1, tool: 'axe', sound: 'wood', color: '#d27a1e',
});
define(B.MELON, 'Melon', { textures: tex(TILE.MELON_TOP, TILE.MELON_SIDE), hardness: 1, tool: 'axe', sound: 'wood', color: '#5f962a' });

// ---------------------------------------------------------------------------------------------
// Lookups.

export function getBlock(id) {
  return BLOCKS[id] || BLOCKS[0];
}

export function isSolid(id) {
  return SOLID[id] === 1;
}

export function isOpaque(id) {
  return OPAQUE[id] === 1;
}

export function isLiquid(id) {
  return LIQUID[id] === 1;
}

export function isCross(id) {
  return CROSS[id] === 1;
}

// Atlas tile for a block face. dir: 0 = +x, 1 = -x, 2 = +y (top), 3 = -y (bottom), 4 = +z (front), 5 = -z.
export function faceTile(id, dir) {
  const t = getBlock(id).textures;
  if (dir === 2) return t.top;
  if (dir === 3) return t.bottom;
  if (dir === 4) return t.front;
  return t.side;
}
