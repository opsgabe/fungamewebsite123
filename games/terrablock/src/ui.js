// Terrablock DOM UI: title screen, loading screen, HUD, inventory windows (player / crafting table /
// furnace / creative palette), pause + settings, death screen, tooltips and the held-stack cursor.
//
// Everything lives inside the `root` element (#ui-root) and is styled by ui.css. main.js drives it
// through the methods documented in ARCHITECTURE.md; the UI owns the hotbar keys (1-9, wheel), E, Esc
// for its own screens, F3 (debug panel visibility) and F1 (hide HUD).

import { drawItemIcon, createAtlas } from './textures.js';
import { B, getBlock } from './blocks.js';
import { getItem, maxStackOf, CREATIVE_ITEMS } from './items.js';
import { findRecipe, RECIPES, SMELTING, FUELS } from './crafting.js';
import { COOK_TIME } from './furnace.js';
import { HOTBAR_SIZE, INVENTORY_SIZE, DEFAULT_RENDER_DISTANCE, MAX_RENDER_DISTANCE } from './config.js';

// ---------------------------------------------------------------------------------------------
// Constants.

const DEFAULT_SETTINGS = Object.freeze({
  renderDistance: DEFAULT_RENDER_DISTANCE,
  fov: 70,
  sensitivity: 1,
  invertY: false,
  volume: 0.8,
});

const BOOK_PREF_KEY = 'terrablock.ui.recipeBook';

const CREATIVE_TABS = [
  { id: 'all', label: 'All', cats: null },
  { id: 'building', label: 'Building', cats: ['building'] },
  { id: 'nature', label: 'Nature', cats: ['nature'] },
  { id: 'decor', label: 'Decor', cats: ['decor'] },
  { id: 'tools', label: 'Tools', cats: ['tools'] },
  { id: 'items', label: 'Items', cats: ['materials', 'food'] },
];

const TIPS = [
  'Break a tree trunk to collect logs, then turn them into planks in your inventory (E).',
  'Shift-click moves a whole stack between your hotbar and storage.',
  'Right-click a stack to split it in half, or to place items one at a time.',
  'Smelt sand in a furnace to make glass, and clay to make bricks.',
  'Monsters roam at night. Build a shelter before the sun goes down!',
  'Cooked meat fills you up far more than raw meat.',
  'The recipe book next to your inventory lists every recipe. Click one to fill the grid.',
  'Press F3 to see your coordinates and other debug info.',
  'Dye white wool by crafting it with a flower, cactus, clay or coal.',
  'Iron ore needs a stone pickaxe, and gold and diamonds need iron.',
  'In Creative mode, double-tap Space to fly.',
  'Running out of air? Swim up! Your breath refills quickly above water.',
  'A full hunger bar slowly heals you. An empty one hurts.',
];

const DEATH_TEXT = {
  fall: 'You hit the ground too hard.',
  drown: 'You ran out of air underwater.',
  starve: 'You starved.',
  mob: 'A night creature got the better of you.',
  monster: 'A night creature got the better of you.',
  attack: 'A night creature got the better of you.',
  cactus: 'You hugged a cactus a little too long.',
  void: 'You fell out of the world.',
  suffocate: 'You got stuck inside a block.',
};

const CONTROLS = [
  ['W A S D', 'Move'],
  ['Mouse', 'Look around'],
  ['Space', 'Jump / swim up / fly up'],
  ['Shift', 'Sneak / fly down'],
  ['Ctrl or W W', 'Sprint'],
  ['Space Space', 'Toggle flying (Creative)'],
  ['Left click', 'Break blocks / attack'],
  ['Right click', 'Place / use / eat'],
  ['Middle click', 'Pick block (Creative)'],
  ['1-9 / Wheel', 'Choose hotbar slot'],
  ['E', 'Inventory'],
  ['F3', 'Debug info'],
  ['F1', 'Hide the HUD'],
  ['Esc', 'Pause / close'],
];

// ---------------------------------------------------------------------------------------------
// Pixel sprites for the HUD and furnace (our own designs). Letters map to palette colours.

const SPR_HEART = [
  '.kkk.kkk.',
  'kwwrkrrrk',
  'kwrrrrrrk',
  'krrrrrrdk',
  '.krrrrdk.',
  '..krrdk..',
  '...kdk...',
  '....k....',
];
// A crusty bread bun (hunger).
const SPR_FOOD = [
  '..kkkkk..',
  '.kywyyyk.',
  'kywyymyok',
  'kyyymyyok',
  'kymyyyook',
  'koooooook',
  '.kcccccck',
  '..kkkkkk.',
];
const SPR_BUBBLE = [
  '..kkkkk..',
  '.kbbbbbk.',
  'kbwwbbbbk',
  'kbwbbbbbk',
  'kbbbbbbbk',
  'kbbbbbbdk',
  '.kbbbbdk.',
  '..kkkkk..',
];
const SPR_FLAME = [
  '.....k.....',
  '....kfk....',
  '....kfk..k.',
  '...kffk.kfk',
  '..kfyfk.kfk',
  '..kfyyfkffk',
  '.kfyyyyfffk',
  '.kfyywyyffk',
  'kfyywwyyyfk',
  'kfyywwwyyfk',
  '.kfyyyyyfk.',
  '..kkkkkkk..',
];
// Stepped arrow, generated: shaft rows 4..7, head columns 9..14.
const SPR_ARROW = (() => {
  const W = 15;
  const H = 12;
  const inside = (x, y) =>
    x >= 0 && x < W && y >= 0 && y < H && ((x < 9 && y >= 4 && y < 8) || (x >= 9 && Math.abs(y - 5.5) <= 5.5 - (x - 9)));
  const rows = [];
  for (let y = 0; y < H; y++) {
    let r = '';
    for (let x = 0; x < W; x++) {
      if (!inside(x, y)) r += '.';
      else r += inside(x - 1, y) && inside(x + 1, y) && inside(x, y - 1) && inside(x, y + 1) ? 'f' : 'k';
    }
    rows.push(r);
  }
  return rows;
})();

const PAL_HEART = { k: '#1d0a10', w: '#ffd3d9', r: '#ea3a4f', d: '#a4192f' };
const PAL_HEART_EMPTY = { k: '#1d0a10', w: '#4a2630', r: '#3a1d25', d: '#2d151c' };
const PAL_HEART_FLASH = { k: '#ffffff', w: '#ffffff', r: '#ff9aa6', d: '#ff6b7c' };
const PAL_FOOD = { k: '#2a1408', y: '#e9a548', w: '#ffe2a6', m: '#9a5419', o: '#b8691f', c: '#f4d7a1' };
const PAL_FOOD_EMPTY = { k: '#2a1408', y: '#3d2a1d', w: '#4a3526', m: '#2e1f15', o: '#33231a', c: '#3d2a1d' };
const PAL_BUBBLE = { k: '#0f2f52', b: 'rgba(122,200,255,0.75)', w: '#ffffff', d: '#3b8fd6' };
const PAL_FLAME = { k: '#3a1405', f: '#ff6a1a', y: '#ffc23d', w: '#fff3b0' };
const PAL_FLAME_EMPTY = { k: '#151a24', f: '#2a3141', y: '#2a3141', w: '#2a3141' };
const PAL_ARROW = { k: '#2b1b00', f: '#ffc23d' };
const PAL_ARROW_EMPTY = { k: '#0a0d14', f: '#3a4864' };

const spriteCache = new Map();
function spriteCanvas(name, rows, pal) {
  const key = name + JSON.stringify(pal);
  let c = spriteCache.get(key);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = rows[0].length;
  c.height = rows.length;
  const ctx = c.getContext('2d');
  for (let y = 0; y < rows.length; y++) {
    for (let x = 0; x < rows[y].length; x++) {
      const col = pal[rows[y][x]];
      if (!col) continue;
      ctx.fillStyle = col;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  spriteCache.set(key, c);
  return c;
}

// ---------------------------------------------------------------------------------------------
// Small helpers.

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function dprOf() {
  return Math.min(3, Math.max(1, window.devicePixelRatio || 1));
}

// Tiny element builder: h('div', { class: 'x', onclick: fn, text: 'hi' }, ...children)
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}

// Draw an item icon into a canvas at `size` CSS pixels (crisp on high-DPI screens).
function paintIcon(canvas, id, size) {
  const px = Math.max(1, Math.round(size * dprOf()));
  if (canvas.width !== px || canvas.height !== px) {
    canvas.width = px;
    canvas.height = px;
  }
  canvas.style.width = size + 'px';
  canvas.style.height = size + 'px';
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, px, px);
  if (id > 0) drawItemIcon(ctx, id, 0, 0, px);
}

// Size a canvas for a sprite drawing of w x h art pixels at k CSS px per art pixel and return a
// context scaled so that 1 unit = 1 art pixel.
function spriteContext(canvas, w, h, k) {
  const d = dprOf();
  const pw = Math.round(w * k * d);
  const ph = Math.round(h * k * d);
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }
  canvas.style.width = w * k + 'px';
  canvas.style.height = h * k + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, pw, ph);
  ctx.setTransform(k * d, 0, 0, k * d, 0, 0);
  ctx.imageSmoothingEnabled = false;
  return ctx;
}

function itemName(id) {
  const it = getItem(id);
  return it ? it.name : 'Unknown';
}

function isTextField(el) {
  if (!el || !el.tagName) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === 'TEXTAREA') return true;
  if (el.tagName !== 'INPUT') return false;
  return !['range', 'checkbox', 'radio', 'button', 'submit'].includes(el.type);
}

function relTime(ts) {
  if (!ts) return 'never played';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 172800) return 'yesterday';
  if (s < 604800) return `${Math.floor(s / 86400)} days ago`;
  try {
    return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return 'a while ago';
  }
}

function readPref(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writePref(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: preference just isn't remembered */
  }
}

// The scrolling terrain cross-section behind the title and loading screens, painted from the atlas.
const BANNER_W = 96; // tiles; the strip tiles seamlessly
const BANNER_H = 16;
let bannerURL = null;
function terrainBannerURL() {
  if (bannerURL) return bannerURL;
  const atlas = createAtlas();
  const T = 16;
  const c = document.createElement('canvas');
  c.width = BANNER_W * T;
  c.height = BANNER_H * T;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  let seed = 0x5eed1234;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const put = (tile, x, y, alpha = 1) => {
    const wx = ((x % BANNER_W) + BANNER_W) % BANNER_W;
    ctx.globalAlpha = alpha;
    ctx.drawImage(atlas, (tile % 16) * T, Math.floor(tile / 16) * T, T, T, wx * T, y * T, T, T);
    ctx.globalAlpha = 1;
  };
  const side = (id) => getBlock(id).textures.side;
  const TAU = Math.PI * 2;
  const SEA = 11;
  const surf = [];
  for (let x = 0; x < BANNER_W; x++) {
    const u = x / BANNER_W;
    const v = 2.4 * Math.sin(TAU * u * 2 + 0.4) + 1.5 * Math.sin(TAU * u * 5 + 2.1) + 0.7 * Math.sin(TAU * u * 9 + 4.2);
    surf.push(clamp(Math.round(8.5 - v), 5, 13));
  }
  const kind = []; // 'grass' | 'sand' | 'snow'
  for (let x = 0; x < BANNER_W; x++) {
    const s = surf[x];
    const nearWater = s >= SEA - 1 || surf[(x + 1) % BANNER_W] >= SEA || surf[(x + BANNER_W - 1) % BANNER_W] >= SEA;
    kind.push(nearWater ? 'sand' : s <= 5 ? 'snow' : 'grass');
    for (let y = 0; y < BANNER_H; y++) {
      if (y < s) {
        if (y >= SEA) put(side(B.WATER), x, y, 0.82);
        continue;
      }
      let id;
      const depth = y - s;
      if (y === BANNER_H - 1) id = B.BEDROCK;
      else if (depth === 0) id = kind[x] === 'sand' ? B.SAND : kind[x] === 'snow' ? B.SNOWY_GRASS : B.GRASS;
      else if (depth <= 3) id = kind[x] === 'sand' ? (depth === 3 ? B.SANDSTONE : B.SAND) : B.DIRT;
      else {
        const r = rnd();
        const deep = y >= BANNER_H - 4;
        if (r < 0.07) id = B.COAL_ORE;
        else if (r < 0.1) id = B.IRON_ORE;
        else if (r < 0.115 && deep) id = B.GOLD_ORE;
        else if (r < 0.125 && deep) id = B.DIAMOND_ORE;
        else if (r < 0.145) id = B.GRAVEL;
        else id = B.STONE;
      }
      put(side(id), x, y);
    }
  }
  // Trees and plants on dry grass.
  let lastTree = -10;
  for (let x = 2; x < BANNER_W - 2; x++) {
    if (kind[x] !== 'grass' && kind[x] !== 'snow') continue;
    const s = surf[x];
    const r = rnd();
    if (x - lastTree > 5 && r < 0.16 && surf[x - 1] === s && surf[x + 1] === s) {
      lastTree = x;
      const spruce = kind[x] === 'snow';
      const birch = !spruce && rnd() < 0.35;
      const logId = spruce ? B.SPRUCE_LOG : birch ? B.BIRCH_LOG : B.LOG;
      const leafId = spruce ? B.SPRUCE_LEAVES : birch ? B.BIRCH_LEAVES : B.LEAVES;
      const height = 3 + Math.floor(rnd() * 2);
      const top = s - height;
      for (let y = s - 1; y >= top; y--) put(side(logId), x, y);
      const canopy = spruce
        ? [[top - 2, 0], [top - 1, 1], [top, 1], [top + 1, 2]]
        : [[top - 2, 1], [top - 1, 2], [top, 2]];
      for (const [y, rad] of canopy) {
        for (let dx = -rad; dx <= rad; dx++) {
          if (dx === 0 && y >= top) continue; // trunk shows through the lower canopy
          if (y < 0) continue;
          put(side(leafId), x + dx, y);
        }
      }
    } else if (kind[x] === 'grass' && r < 0.42) {
      const plant = r < 0.24 ? B.TALL_GRASS : r < 0.33 ? B.FLOWER_YELLOW : B.FLOWER_RED;
      put(side(plant), x, s - 1);
    }
  }
  bannerURL = c.toDataURL('image/png');
  return bannerURL;
}

// ---------------------------------------------------------------------------------------------

export class UI {
  constructor({ root, inventory = null, survival = null, furnaces = null, settings = null, sounds = null, callbacks = {} } = {}) {
    this.root = root || document.getElementById('ui-root');
    this.inventory = null;
    this.survival = null;
    this.furnaces = null;
    this.sounds = sounds;
    this.cb = callbacks || {};
    this.settings = settings || {};
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) if (this.settings[k] === undefined) this.settings[k] = v;

    this.mode = 'survival';
    this.state = 'none'; // 'none' | 'title' | 'loading' | 'playing' | 'paused' | 'dead'
    this.screen = null; // open inventory window, see openInventory()
    this.cursor = null; // stack held by the mouse
    this.grids = { 2: new Array(4).fill(null), 3: new Array(9).fill(null) }; // crafting grids keep leftovers
    this.craftRecipe = null;
    this.drag = null;
    this.hoverView = null;
    this.focusView = null;
    this.keyboardNav = false;
    this.debugVisible = false;
    this.debugLines = null;
    this.hudHidden = false;
    this.mouse = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    this._hud = {};
    this._hurtUntil = 0;
    this._wheel = { acc: 0, t: 0 };
    this._menuView = null;
    this._timers = { toast: 0, tip: 0, book: 0, raf: 0, hurt: 0 };
    this._worlds = [];

    this._build();
    this._bind();
    this._layout();
    this.setInventory(inventory);
    this.setSurvival(survival);
    this.setFurnaces(furnaces);
  }

  // =============================================================================================
  // Public API
  // =============================================================================================

  showTitle(worlds = []) {
    this.hideAll();
    this._worlds = Array.isArray(worlds) ? worlds.slice() : [];
    this._renderWorlds();
    this._setCreateBusy(false);
    this.el.title.classList.remove('tb-hidden');
    this.state = 'title';
    this._applyTerrain();
    if (document.activeElement && this.root.contains(document.activeElement)) document.activeElement.blur();
  }

  showLoading(progress = 0, text = '') {
    if (this.state !== 'loading') {
      this._closeScreen(false);
      this._hideMenu();
      this.el.title.classList.add('tb-hidden');
      this.el.hud.classList.add('tb-hidden');
      this.el.loading.classList.remove('tb-hidden');
      this.state = 'loading';
      this._applyTerrain();
      this._nextTip();
      clearInterval(this._timers.tip);
      this._timers.tip = setInterval(() => this._nextTip(), 5000);
    }
    let p = Number(progress) || 0;
    if (p > 1) p /= 100; // tolerate percentages
    p = clamp(p, 0, 1);
    this.el.loadFill.style.width = `calc((100% - var(--px) * 4) * ${p.toFixed(4)})`;
    this.el.loadBar.setAttribute('aria-valuenow', String(Math.round(p * 100)));
    if (text) this.el.loadText.textContent = text;
  }

  hideLoading() {
    this.el.loading.classList.add('tb-hidden');
    clearInterval(this._timers.tip);
    if (this.state === 'loading') this.state = 'none';
  }

  showHUD(mode) {
    if (mode) this.setMode(mode);
    this._hideMenu();
    this.el.title.classList.add('tb-hidden');
    this.el.loading.classList.add('tb-hidden');
    clearInterval(this._timers.tip);
    this.el.hud.classList.remove('tb-hidden');
    this.state = 'playing';
    this._hud = {};
    this.updateHUD();
  }

  // Cheap enough to call every frame: only redraws what changed.
  updateHUD() {
    const hud = this._hud;
    const inv = this.inventory;
    if (inv) {
      for (const v of this.hotViews) this._paintView(v);
      const sel = inv.selected;
      const held = inv.slots[sel] ? inv.slots[sel].id : 0;
      if (sel !== hud.selected) {
        hud.selected = sel;
        this.el.hotSel.style.transform = `translateX(${sel * (this.slotPx + this.gapPx)}px)`;
      }
      if (held !== hud.held || sel !== hud.toastSel) {
        if (hud.held !== undefined && held) this._toast(itemName(held));
        else if (!held) this.el.toast.classList.remove('is-on');
        hud.held = held;
        hud.toastSel = sel;
      }
    }
    const s = this.survival;
    const survival = !!s && this.mode !== 'creative';
    if (survival !== hud.survival) {
      hud.survival = survival;
      this.el.stats.classList.toggle('is-off', !survival);
      hud.health = hud.hunger = hud.air = undefined;
    }
    if (survival) {
      if (hud.health !== undefined && s.health < hud.health) this._hurtFlash();
      const flash = performance.now() < this._hurtUntil;
      if (s.health !== hud.health || flash !== hud.flash) {
        hud.health = s.health;
        hud.flash = flash;
        this._drawHearts(s.health, flash);
        this.el.hearts.classList.toggle('is-low', s.health > 0 && s.health <= 4);
      }
      if (s.hunger !== hud.hunger) {
        hud.hunger = s.hunger;
        this._drawFood(s.hunger);
      }
      const bubbles = s.showAir ? s.airBubbles : -1;
      if (bubbles !== hud.air) {
        hud.air = bubbles;
        this._drawAir(bubbles);
      }
    }
    this._updateLockHint();
  }

  // lines: string[] | string | null. Shown while debug mode (F3) is on.
  setDebug(lines) {
    this.debugLines = lines;
    const show = this.debugVisible && !!lines && (this.state === 'playing' || this.state === 'paused');
    this.el.debug.classList.toggle('tb-hidden', !show);
    if (!show) return;
    const text = Array.isArray(lines) ? lines.join('\n') : String(lines);
    if (text !== this._debugText) {
      this._debugText = text;
      this.el.debug.textContent = text;
    }
  }

  showMessage(text) {
    if (!text) return;
    const box = this.el.messages;
    while (box.children.length >= 4) box.firstChild.remove();
    const m = h('div', { class: 'tb-msg', text: String(text) });
    box.append(m);
    setTimeout(() => m.classList.add('is-out'), 3600);
    setTimeout(() => m.remove(), 4200);
  }

  // kind: 'player' | 'crafting_table' | 'furnace'. context for furnaces: "x,y,z" | { key } | { x, y, z }.
  openInventory(kind = 'player', context = null) {
    if (this.state !== 'playing' || !this.inventory) return false;
    if (this.screen) this._closeScreen(false);
    let furnace = null;
    let key = null;
    if (kind === 'furnace') {
      key = typeof context === 'string' ? context : context && context.key ? String(context.key) : context && 'x' in context ? `${context.x},${context.y},${context.z}` : null;
      if (!key || !this.furnaces) return false;
      furnace = this.furnaces.get(key);
    } else if (kind !== 'crafting_table') {
      kind = 'player';
    }
    const creative = kind === 'player' && this.mode === 'creative';
    const sc = {
      kind: creative ? 'creative' : kind,
      key,
      furnace,
      gridSize: kind === 'crafting_table' ? 3 : kind === 'player' && !creative ? 2 : 0,
      views: [],
      invRefs: [],
      refs: {},
    };
    sc.grid = sc.gridSize ? this.grids[sc.gridSize] : null;
    this.screen = sc;
    this._buildScreen(sc);
    this.el.overlay.classList.remove('tb-hidden');
    this.el.hint.classList.add('tb-hidden');
    this._updateCraft();
    this._renderScreen(true);
    sc.win.focus({ preventScroll: true });
    if (document.pointerLockElement && document.exitPointerLock) document.exitPointerLock();
    this._sound('click', { volume: 0.4 });
    this._startScreenLoop();
    if (this.cb.onScreenOpen) this.cb.onScreenOpen(sc.kind);
    return true;
  }

  closeScreens() {
    this._closeScreen(true);
  }

  isScreenOpen() {
    return !!this.screen;
  }

  showPause() {
    if (this.state === 'dead' || this.state === 'title' || this.state === 'loading') return;
    if (this.screen) this._closeScreen(false);
    this.state = 'paused';
    this._showMenu('pause');
    this._updateLockHint();
  }

  hidePause() {
    if (this.state !== 'paused') return;
    this._hideMenu();
    this.state = 'playing';
    this._hud.lock = undefined;
    this._updateLockHint();
  }

  showDeath() {
    this._closeScreen(false);
    this.state = 'dead';
    this._showMenu('death');
    this._updateLockHint();
  }

  hideAll() {
    this._closeScreen(false);
    this._hideMenu();
    this.el.title.classList.add('tb-hidden');
    this.el.loading.classList.add('tb-hidden');
    this.el.hud.classList.add('tb-hidden');
    this.el.hint.classList.add('tb-hidden');
    this.el.debug.classList.add('tb-hidden');
    this.el.vignette.classList.remove('is-on');
    clearInterval(this._timers.tip);
    this.state = 'none';
  }

  setInventory(inventory) {
    if (this.screen) this._closeScreen(false);
    this.inventory = inventory || null;
    this._hud = {};
    if (this.state === 'playing' || this.state === 'paused') this.updateHUD();
  }

  setSurvival(survival) {
    this.survival = survival || null;
    this._hud.health = this._hud.hunger = this._hud.air = this._hud.survival = undefined;
  }

  setFurnaces(furnaces) {
    if (this.screen && this.screen.furnace) this._closeScreen(false);
    this.furnaces = furnaces || null;
  }

  setMode(mode) {
    const m = mode === 'creative' ? 'creative' : 'survival';
    if (m === this.mode) return;
    this.mode = m;
    this._hud.survival = undefined;
    if (this.state === 'playing' || this.state === 'paused') this.updateHUD();
    // Swap between the creative palette and the survival inventory if it is open.
    if (this.screen && (this.screen.kind === 'player' || this.screen.kind === 'creative')) {
      this._closeScreen(false);
      this.openInventory('player');
    }
  }

  // =============================================================================================
  // DOM construction
  // =============================================================================================

  _build() {
    const r = this.root;
    r.querySelectorAll('[data-boot]').forEach((n) => n.remove());
    const el = (this.el = {});

    // ---- HUD
    el.hud = h('div', { class: 'tb-hud tb-hidden' });
    el.crosshair = h('div', { class: 'tb-crosshair', 'aria-hidden': 'true' });
    el.debug = h('pre', { class: 'tb-debug tb-hidden', 'aria-hidden': 'true' });
    el.hint = h('div', { class: 'tb-hint tb-hidden', text: 'Click to play' });
    el.toast = h('div', { class: 'tb-toast', 'aria-live': 'polite' });
    el.hearts = h('canvas', { class: 'tb-hearts', 'aria-hidden': 'true' });
    el.food = h('canvas', { class: 'tb-food', 'aria-hidden': 'true' });
    el.air = h('canvas', { class: 'tb-air', 'aria-hidden': 'true' });
    el.stats = h(
      'div',
      { class: 'tb-stats' },
      h('div', { class: 'tb-stat-left' }, el.hearts),
      h('div', { class: 'tb-stat-right' }, el.air, el.food),
    );
    el.hotbar = h('div', { class: 'tb-hotbar', 'aria-label': 'Hotbar' });
    el.hotSel = h('div', { class: 'tb-hotbar-sel', 'aria-hidden': 'true' });
    this.hotViews = [];
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const v = this._makeView({ type: 'hud', get: () => (this.inventory && this.inventory.slots[i]) || null });
      v.el.removeAttribute('tabindex');
      v.el.removeAttribute('role');
      v.el.append(h('span', { class: 'tb-hotkey', text: String(i + 1) }));
      this.hotViews.push(v);
      el.hotbar.append(v.el);
    }
    el.hotbar.append(el.hotSel);
    el.hudBottom = h('div', { class: 'tb-hud-bottom' }, el.toast, el.stats, el.hotbar);
    el.hud.append(el.crosshair, el.debug, el.hint, el.hudBottom);
    el.vignette = h('div', { class: 'tb-vignette', 'aria-hidden': 'true' });

    // ---- Layers
    el.overlay = h('div', { class: 'tb-layer tb-overlay tb-hidden' });
    el.menu = h('div', { class: 'tb-layer tb-menu-layer tb-hidden', role: 'dialog', 'aria-modal': 'true' });
    el.title = this._buildTitle();
    el.loading = this._buildLoading();
    el.messages = h('div', { class: 'tb-messages', role: 'status', 'aria-live': 'polite', style: 'z-index:45' });
    el.tooltip = h('div', { class: 'tb-tooltip tb-hidden', role: 'tooltip' });
    el.cursorIcon = h('canvas');
    el.cursorCount = h('span', { class: 'tb-count' });
    el.cursor = h('div', { class: 'tb-cursor tb-hidden', 'aria-hidden': 'true' }, el.cursorIcon, el.cursorCount);

    r.append(el.hud, el.vignette, el.overlay, el.menu, el.title, el.loading, el.messages, el.tooltip, el.cursor);
  }

  _scenery() {
    const wrap = h('div', { class: 'tb-scenery', 'aria-hidden': 'true' });
    wrap.append(h('div', { class: 'tb-scenery-sun' }));
    const clouds = [
      [10, 18, 70, -5],
      [18, 26, 95, -40],
      [6, 14, 120, -80],
      [24, 20, 85, -20],
    ];
    for (const [top, w, dur, delay] of clouds) {
      wrap.append(
        h('div', {
          class: 'tb-cloud',
          style: `top:${top}%;width:calc(var(--px) * ${w});animation-duration:${dur}s;animation-delay:${delay}s`,
        }),
      );
    }
    const terrain = h('div', { class: 'tb-terrain' });
    (this._terrainEls || (this._terrainEls = [])).push(terrain);
    wrap.append(terrain, h('div', { class: 'tb-scenery-shade' }));
    return wrap;
  }

  _applyTerrain() {
    if (!this._terrainEls) return;
    let url;
    try {
      url = terrainBannerURL();
    } catch (e) {
      console.warn('Terrablock: title scenery unavailable', e);
      return;
    }
    // Half-step pixel scales keep the art crisp-ish while filling ~40% of the screen height.
    const scale = clamp(Math.round(((window.innerHeight * 0.42) / (BANNER_H * 16)) * 2) / 2, 1, 5);
    const w = BANNER_W * 16 * scale;
    const hgt = BANNER_H * 16 * scale;
    for (const t of this._terrainEls) {
      t.style.backgroundImage = `url(${url})`;
      t.style.backgroundSize = `${w}px ${hgt}px`;
      t.style.height = `${hgt}px`;
      t.style.setProperty('--tw', `${w}px`);
      t.style.animationDuration = `${Math.round(w / 14)}s`;
    }
  }

  _buildTitle() {
    const el = this.el;
    el.worldList = h('div', { class: 'tb-worlds', role: 'list', 'aria-label': 'Saved worlds' });
    el.newName = h('input', {
      class: 'tb-input',
      id: 'tb-new-name',
      type: 'text',
      maxlength: 32,
      placeholder: 'New World',
      autocomplete: 'off',
      spellcheck: 'false',
    });
    el.newSeed = h('input', {
      class: 'tb-input',
      id: 'tb-new-seed',
      type: 'text',
      maxlength: 32,
      placeholder: 'Leave blank for a random world',
      autocomplete: 'off',
      spellcheck: 'false',
    });
    const radio = (value, label, checked) =>
      h('label', null, h('input', { type: 'radio', name: 'tb-mode', value, checked }), h('span', { text: label }));
    el.modeSeg = h('div', { class: 'tb-seg', role: 'radiogroup', 'aria-label': 'Game mode' }, radio('survival', 'Survival', true), radio('creative', 'Creative', false));
    el.modeHint = h('div', { class: 'tb-seg-hint' });
    const updateHint = () => {
      const m = this._newMode();
      el.modeHint.textContent =
        m === 'creative'
          ? 'Unlimited blocks, instant mining and flight. No hunger, no danger.'
          : 'Gather, craft and stay fed. Creatures roam at night.';
    };
    el.modeSeg.addEventListener('change', updateHint);
    updateHint();
    el.createBtn = h('button', { class: 'tb-btn tb-btn-primary tb-btn-block', type: 'submit', text: 'Create World' });
    const form = h(
      'form',
      { class: 'tb-card tb-panel', novalidate: true, 'aria-label': 'Create a new world' },
      h('h2', { class: 'tb-h', text: 'New World' }),
      h('div', { class: 'tb-field' }, h('label', { for: 'tb-new-name', text: 'World name' }), el.newName),
      h('div', { class: 'tb-field' }, h('label', { for: 'tb-new-seed', text: 'Seed (optional)' }), el.newSeed),
      h('div', { class: 'tb-field' }, h('span', { class: 'tb-field-label', text: 'Game mode' }), el.modeSeg, el.modeHint),
      el.createBtn,
    );
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      this._createWorld();
    });

    const worldsCard = h('section', { class: 'tb-card tb-panel', 'aria-label': 'Your worlds' }, h('h2', { class: 'tb-h', text: 'Your Worlds' }), el.worldList);

    const touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches && !matchMedia('(pointer: fine)').matches;
    const foot = h(
      'footer',
      { class: 'tb-title-foot' },
      h('a', { href: '../../index.html', text: '← Fun Game Zone' }),
      h('button', { class: 'tb-btn tb-btn-small', type: 'button', text: 'Settings', onclick: () => this._showMenu('settings', 'title') }),
      h('button', { class: 'tb-btn tb-btn-small', type: 'button', text: 'Controls', onclick: () => this._showMenu('controls', 'title') }),
      h('span', { text: 'Every block, sound and creature is generated in code.' }),
    );
    const inner = h(
      'div',
      { class: 'tb-title-inner' },
      h(
        'header',
        { class: 'tb-logo-wrap' },
        h('h1', { class: 'tb-logo', text: 'Terrablock' }),
        h('p', { class: 'tb-tagline' }, 'Explore. ', h('b', { text: 'Build.' }), ' Survive the night.'),
        touch ? h('p', { class: 'tb-note', text: 'Terrablock is played with a keyboard and mouse.' }) : null,
      ),
      h('div', { class: 'tb-title-cards' }, worldsCard, form),
      foot,
    );
    return h('div', { class: 'tb-layer tb-title tb-hidden' }, this._scenery(), inner);
  }

  _newMode() {
    const checked = this.el.modeSeg.querySelector('input:checked');
    return checked ? checked.value : 'survival';
  }

  _createWorld() {
    if (this._creating) return;
    const name = (this.el.newName.value || '').trim().slice(0, 32) || `World ${this._worlds.length + 1}`;
    let seed = (this.el.newSeed.value || '').trim().slice(0, 32);
    if (!seed) seed = String(Math.floor(Math.random() * 2147483647));
    const mode = this._newMode();
    this._sound('click');
    this._unlockAudio();
    this._setCreateBusy(true);
    if (this.cb.onCreateWorld) this.cb.onCreateWorld({ name, seed, mode });
  }

  _setCreateBusy(busy) {
    this._creating = busy;
    this.el.createBtn.disabled = busy;
    this.el.createBtn.textContent = busy ? 'Creating…' : 'Create World';
    if (!busy) {
      this.el.newName.value = '';
      this.el.newSeed.value = '';
      this.el.newName.placeholder = `World ${this._worlds.length + 1}`;
    }
  }

  _renderWorlds() {
    const list = this.el.worldList;
    list.textContent = '';
    if (!this._worlds.length) {
      const icon = h('canvas', { 'aria-hidden': 'true' });
      paintIcon(icon, B.GRASS, Math.round(this.slotPx * 1.5));
      list.append(h('div', { class: 'tb-empty' }, icon, h('div', null, 'No worlds yet.', h('br'), 'Create one to start exploring!')));
      return;
    }
    const icons = [B.GRASS, B.SAND, B.SNOWY_GRASS, B.LOG, B.STONE_BRICKS, B.PUMPKIN, B.BOOKSHELF, B.MOSSY_COBBLESTONE];
    for (const w of this._worlds) {
      let hsh = 0;
      for (const ch of String(w.id ?? w.name ?? '')) hsh = (Math.imul(hsh, 31) + ch.charCodeAt(0)) | 0;
      const icon = h('canvas', { class: 'tb-world-icon' });
      paintIcon(icon, w.mode === 'creative' ? B.DIAMOND_BLOCK : icons[Math.abs(hsh) % icons.length], Math.round(this.fsPx * 2.5));
      const creative = w.mode === 'creative';
      const play = h(
        'button',
        { class: 'tb-world-play', type: 'button', title: `Play ${w.name}` },
        icon,
        h('span', { class: 'tb-world-name', text: w.name || 'Untitled' }),
        h(
          'span',
          { class: 'tb-world-meta' },
          h('span', { class: 'tb-badge' + (creative ? ' is-creative' : ''), text: creative ? 'Creative' : 'Survival' }),
          `${relTime(w.lastPlayed)} · seed ${w.seed}`,
        ),
      );
      play.addEventListener('click', () => {
        this._sound('click');
        this._unlockAudio();
        if (this.cb.onPlayWorld) this.cb.onPlayWorld(w.id);
      });
      const del = h('button', { class: 'tb-btn tb-btn-danger tb-btn-icon tb-world-del', type: 'button', title: `Delete ${w.name}`, 'aria-label': `Delete ${w.name}`, text: '×' });
      let armTimer = 0;
      del.addEventListener('click', () => {
        if (!del.classList.contains('is-armed')) {
          del.classList.add('is-armed');
          del.textContent = 'Delete?';
          clearTimeout(armTimer);
          armTimer = setTimeout(() => {
            del.classList.remove('is-armed');
            del.textContent = '×';
          }, 3000);
          return;
        }
        clearTimeout(armTimer);
        this._sound('click');
        this._worlds = this._worlds.filter((x) => x !== w);
        if (this.cb.onDeleteWorld) this.cb.onDeleteWorld(w.id);
        this._renderWorlds();
        this._setCreateBusy(false);
        const next = this.el.worldList.querySelector('.tb-world-play');
        (next || this.el.newName).focus({ preventScroll: true });
      });
      list.append(h('div', { class: 'tb-world', role: 'listitem' }, play, del));
    }
  }

  _buildLoading() {
    const el = this.el;
    el.loadFill = h('div', { class: 'tb-bar-fill' });
    el.loadBar = h('div', { class: 'tb-bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': 0, 'aria-label': 'Loading' }, el.loadFill);
    el.loadText = h('div', { class: 'tb-loading-text', text: 'Generating terrain…' });
    el.tip = h('div', { class: 'tb-tip' });
    const box = h('div', { class: 'tb-loading-box tb-panel' }, h('h2', { class: 'tb-h', text: 'Building World' }), el.loadBar, el.loadText, el.tip);
    return h('div', { class: 'tb-layer tb-loading tb-hidden', 'aria-busy': 'true' }, this._scenery(), box);
  }

  _nextTip() {
    this._tipIndex = ((this._tipIndex ?? Math.floor(Math.random() * TIPS.length)) + 1) % TIPS.length;
    this.el.tip.textContent = 'Tip: ' + TIPS[this._tipIndex];
  }

  // ---- Menus (pause, settings, controls, death) ----------------------------------------------

  _showMenu(view, from = null) {
    const layer = this.el.menu;
    layer.textContent = '';
    layer.classList.remove('tb-hidden', 'tb-death');
    this._menuView = view;
    this._menuFrom = from || (view === 'settings' || view === 'controls' ? this._menuFrom : null);
    layer.classList.toggle('is-top', this._menuFrom === 'title');
    const back = () => {
      this._sound('click');
      if (this._menuFrom === 'title') {
        this._hideMenu();
        const first = this.el.worldList.querySelector('.tb-world-play');
        (first || this.el.newName).focus({ preventScroll: true });
      } else this._showMenu('pause');
    };
    let panel;
    if (view === 'pause') {
      this._menuFrom = null;
      panel = h(
        'div',
        { class: 'tb-menu tb-panel' },
        h('h2', { class: 'tb-h', text: 'Paused' }),
        h(
          'div',
          { class: 'tb-menu-buttons' },
          this._menuBtn('Back to Game', () => this._resume(), true),
          this._menuBtn('Settings', () => this._showMenu('settings', 'pause')),
          this._menuBtn('Controls', () => this._showMenu('controls', 'pause')),
          this._menuBtn('Save & Quit to Title', () => this._saveQuit()),
        ),
      );
    } else if (view === 'settings') {
      panel = h('div', { class: 'tb-menu tb-menu-wide tb-panel is-wide' }, h('h2', { class: 'tb-h', text: 'Settings' }), this._buildSettings(), this._menuBtn('Done', back, true));
    } else if (view === 'controls') {
      const dl = h('dl', { class: 'tb-keys' });
      for (const [k, d] of CONTROLS) dl.append(h('dt', { text: k }), h('dd', { text: d }));
      panel = h('div', { class: 'tb-menu tb-panel is-wide' }, h('h2', { class: 'tb-h', text: 'Controls' }), dl, this._menuBtn('Done', back, true));
    } else if (view === 'death') {
      layer.classList.add('tb-death');
      const cause = (this.survival && (this.survival.deathCause || this.survival.lastDamageCause)) || null;
      const respawn = this._menuBtn('Respawn', () => this._respawn(), true);
      const quit = this._menuBtn('Save & Quit to Title', () => this._saveQuit());
      // Short delay so a click that was meant for the game doesn't skip the screen.
      respawn.disabled = quit.disabled = true;
      setTimeout(() => {
        respawn.disabled = quit.disabled = false;
        if (this._menuView === 'death') respawn.focus({ preventScroll: true });
      }, 900);
      panel = h(
        'div',
        { class: 'tb-menu tb-panel' },
        h('h2', { class: 'tb-h', text: 'Knocked Out' }),
        h('p', { class: 'tb-death-cause', text: DEATH_TEXT[cause] || 'Your adventure was cut short.' }),
        h('div', { class: 'tb-menu-buttons' }, respawn, quit),
      );
    }
    layer.setAttribute('aria-label', { pause: 'Paused', settings: 'Settings', controls: 'Controls', death: 'Knocked out' }[view] || view);
    layer.append(panel);
    const first = panel.querySelector('button:not(:disabled), input');
    if (first) first.focus({ preventScroll: true });
  }

  _hideMenu() {
    this.el.menu.classList.add('tb-hidden');
    this.el.menu.textContent = '';
    this._menuView = null;
  }

  _menuBtn(label, fn, primary = false) {
    return h('button', {
      class: 'tb-btn tb-btn-block' + (primary ? ' tb-btn-primary' : ''),
      type: 'button',
      text: label,
      onclick: () => {
        this._sound('click');
        fn();
      },
    });
  }

  _resume() {
    this.hidePause();
    if (this.cb.onResume) this.cb.onResume();
  }

  _respawn() {
    this._hideMenu();
    this.state = 'playing';
    this._hud = {};
    if (this.cb.onRespawn) this.cb.onRespawn();
    this.updateHUD();
  }

  _saveQuit() {
    this.hideAll();
    if (this.cb.onSaveQuit) this.cb.onSaveQuit();
  }

  _buildSettings() {
    const s = this.settings;
    const wrap = h('div', { class: 'tb-settings' });
    const emit = () => {
      if (this.cb.onSettingsChange) this.cb.onSettingsChange(s);
    };
    const range = (key, label, min, max, step, fmt) => {
      const id = 'tb-set-' + key;
      const out = h('output', { for: id });
      const input = h('input', { class: 'tb-range', id, type: 'range', min, max, step, value: clamp(Number(s[key]) || 0, min, max) });
      const show = () => (out.textContent = fmt(Number(input.value)));
      input.addEventListener('input', () => {
        s[key] = Number(input.value);
        show();
        emit();
      });
      show();
      wrap.append(h('div', { class: 'tb-setting' }, h('label', { for: id, text: label }), out, input));
    };
    range('renderDistance', 'Render distance', 2, MAX_RENDER_DISTANCE, 1, (v) => `${v} chunks`);
    range('fov', 'Field of view', 30, 110, 1, (v) => `${v}°`);
    range('sensitivity', 'Mouse sensitivity', 0.1, 3, 0.05, (v) => `${Math.round(v * 100)}%`);
    range('volume', 'Volume', 0, 1, 0.05, (v) => (v === 0 ? 'Off' : `${Math.round(v * 100)}%`));
    const inv = h('input', { class: 'tb-switch', id: 'tb-set-invert', type: 'checkbox', checked: !!s.invertY });
    inv.addEventListener('change', () => {
      s.invertY = inv.checked;
      emit();
    });
    wrap.append(h('div', { class: 'tb-setting' }, h('label', { for: 'tb-set-invert', text: 'Invert mouse Y' }), inv));
    return wrap;
  }

  // =============================================================================================
  // Event wiring
  // =============================================================================================

  _bind() {
    window.addEventListener('keydown', (e) => this._onKey(e));
    window.addEventListener('wheel', (e) => this._onWheel(e), { passive: true });
    window.addEventListener('mousemove', (e) => this._onMouseMove(e), { passive: true });
    window.addEventListener('mouseup', (e) => this._onMouseUp(e));
    window.addEventListener('resize', () => this._layout());
    window.addEventListener('blur', () => this._endDrag(false));
    // Put a held stack / crafting grid back into the inventory before the page is saved and hidden.
    window.addEventListener('pagehide', () => this._closeScreen(false));
    document.addEventListener('pointerlockchange', () => {
      this._hud.lock = undefined;
      this._updateLockHint();
    });
    const ov = this.el.overlay;
    ov.addEventListener('mousedown', (e) => this._onOverlayDown(e));
    ov.addEventListener('mouseover', (e) => this._onOverlayOver(e));
    ov.addEventListener('mouseout', (e) => {
      const slot = e.target.closest && e.target.closest('.tb-slot');
      if (slot && this.hoverView === slot._view && !(e.relatedTarget && slot.contains(e.relatedTarget))) {
        this.hoverView = null;
        this._updateTooltip();
      }
    });
    ov.addEventListener('contextmenu', (e) => e.preventDefault());
    this.el.menu.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  _onKey(e) {
    const code = e.code;
    const typing = isTextField(e.target);

    // ---- an inventory window is open
    if (this.screen) {
      if (code === 'Escape' || (code === 'KeyE' && !typing && !e.repeat && !e.ctrlKey && !e.metaKey)) {
        e.preventDefault();
        this._closeScreen(true);
        return;
      }
      if (typing) return;
      const n = /^Digit([1-9])$/.exec(code);
      if (n) {
        const v = this.keyboardNav ? this.focusView : this.hoverView;
        if (v && this._hotkeySwap(v, +n[1] - 1)) this._commitAction();
        e.preventDefault();
        return;
      }
      const dirs = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      if (dirs[code]) {
        e.preventDefault();
        this._moveFocus(...dirs[code]);
        return;
      }
      if ((code === 'Enter' || code === 'NumpadEnter' || code === 'Space') && this.focusView && document.activeElement === this.focusView.el) {
        e.preventDefault();
        this.keyboardNav = true;
        this._activate(this.focusView, code === 'Space' ? 2 : 0, e.shiftKey);
        return;
      }
      return;
    }

    // ---- menus
    if (code === 'Escape') {
      if (this.state === 'paused') {
        e.preventDefault();
        if (this._menuView === 'settings' || this._menuView === 'controls') this._showMenu('pause');
        else this._resume();
        return;
      }
      if (this.state === 'title' && this._menuView) {
        e.preventDefault();
        this._hideMenu();
        return;
      }
      if (this.state === 'playing' && !document.pointerLockElement) {
        // Pointer already free (e.g. re-lock was refused): Esc still pauses.
        this.showPause();
        return;
      }
      return;
    }

    if (this.state !== 'playing' || typing) return;

    // ---- gameplay keys owned by the UI
    if (code === 'KeyE' && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      this.openInventory('player');
      return;
    }
    const n = /^(?:Digit|Numpad)([1-9])$/.exec(code);
    if (n && this.inventory && !e.ctrlKey && !e.metaKey && !e.altKey) {
      this.inventory.setSelected(+n[1] - 1);
      this.updateHUD();
      return;
    }
    if (code === 'F3') {
      e.preventDefault();
      if (!e.repeat) {
        this.debugVisible = !this.debugVisible;
        this.setDebug(this.debugLines);
      }
      return;
    }
    if (code === 'F1') {
      e.preventDefault();
      if (!e.repeat) {
        this.hudHidden = !this.hudHidden;
        this.el.hud.classList.toggle('is-hidden-f1', this.hudHidden);
      }
    }
  }

  _onWheel(e) {
    if (this.state !== 'playing' || this.screen || !this.inventory) return;
    if (e.target && e.target.closest && e.target.closest('.tb-layer')) return;
    const now = performance.now();
    const w = this._wheel;
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 33;
    else if (e.deltaMode === 2) dy *= 300;
    if (now - w.t > 250 || Math.sign(dy) !== Math.sign(w.acc)) w.acc = 0;
    w.t = now;
    w.acc += dy;
    // One notch of a mouse wheel is ~100; trackpads send many small deltas.
    let steps = 0;
    while (Math.abs(w.acc) >= 50) {
      steps += Math.sign(w.acc);
      w.acc -= Math.sign(w.acc) * 100;
      if (Math.abs(w.acc) < 50) w.acc = 0;
    }
    if (steps) {
      this.inventory.setSelected(this.inventory.selected + steps);
      this.updateHUD();
    }
  }

  _onMouseMove(e) {
    this.mouse.x = e.clientX;
    this.mouse.y = e.clientY;
    if (!this.screen) return;
    if (this.keyboardNav && (Math.abs(e.movementX) + Math.abs(e.movementY) > 0)) this.keyboardNav = false;
    this._positionFloaters();
  }

  _onMouseUp(e) {
    if (this._ignoreUp) {
      this._ignoreUp = false;
      return;
    }
    if (this.drag && e.button === this.drag.button) this._endDrag(true);
  }

  _onOverlayDown(e) {
    if (!this.screen) return;
    const slot = e.target.closest && e.target.closest('.tb-slot');
    if (!slot || !slot._view) return;
    e.preventDefault();
    this.keyboardNav = false;
    this._slotDown(slot._view, e);
  }

  _onOverlayOver(e) {
    if (!this.screen) return;
    const slot = e.target.closest && e.target.closest('.tb-slot');
    if (!slot || !slot._view) return;
    const view = slot._view;
    if (this.hoverView !== view) {
      this.hoverView = view;
      this._dragOver(view);
      this._updateTooltip();
    }
  }

  // =============================================================================================
  // HUD drawing
  // =============================================================================================

  _layout() {
    const W = window.innerWidth;
    const H = window.innerHeight;
    let slot = Math.floor(Math.min(H * 0.062, W * 0.042));
    slot = clamp(slot, 30, 64);
    slot -= slot % 2;
    const px = Math.max(2, Math.round(slot / 22));
    const fs = clamp(Math.round(slot * 0.36), 13, 24);
    const gap = Math.max(2, Math.round(slot / 11));
    this.slotPx = slot;
    this.gapPx = gap;
    this.px = px;
    this.fsPx = fs;
    this.iconPx = Math.round(slot * 0.72);
    this.hudK = px; // CSS px per sprite pixel for hearts / food / air
    const st = this.root.style;
    st.setProperty('--slot', slot + 'px');
    st.setProperty('--px', px + 'px');
    st.setProperty('--fs', fs + 'px');
    st.setProperty('--gap', gap + 'px');
    // Force redraws at the new size.
    for (const v of this.hotViews) v.id = -1;
    this._hud = {};
    if (this.state === 'playing' || this.state === 'paused' || this.state === 'dead') this.updateHUD();
    if (this.screen) {
      for (const v of this.screen.views) v.id = -1;
      this._renderScreen(true);
      this._repaintBook();
    }
    this.el.cursor.dataset.size = '';
    this._renderCursor();
    if (this.state === 'title' || this.state === 'loading') this._applyTerrain();
  }

  _drawHearts(health, flash) {
    const ctx = spriteContext(this.el.hearts, 99, 8, this.hudK);
    const full = spriteCanvas('heart', SPR_HEART, flash ? PAL_HEART_FLASH : PAL_HEART);
    const empty = spriteCanvas('heart', SPR_HEART, PAL_HEART_EMPTY);
    for (let i = 0; i < 10; i++) {
      const x = i * 10;
      const v = health - i * 2;
      ctx.drawImage(empty, x, 0);
      if (v >= 2) ctx.drawImage(full, x, 0);
      else if (v === 1 || (v > 0 && v < 2)) ctx.drawImage(full, 0, 0, 5, 8, x, 0, 5, 8);
    }
  }

  _drawFood(hunger) {
    const ctx = spriteContext(this.el.food, 99, 8, this.hudK);
    const full = spriteCanvas('food', SPR_FOOD, PAL_FOOD);
    const empty = spriteCanvas('food', SPR_FOOD, PAL_FOOD_EMPTY);
    // Drawn right-to-left so it drains from the left like a mirror of the hearts.
    for (let i = 0; i < 10; i++) {
      const x = (9 - i) * 10;
      const v = hunger - i * 2;
      ctx.drawImage(empty, x, 0);
      if (v >= 2) ctx.drawImage(full, x, 0);
      else if (v === 1) ctx.drawImage(full, 4, 0, 5, 8, x + 4, 0, 5, 8);
    }
  }

  _drawAir(bubbles) {
    const c = this.el.air;
    if (bubbles < 0) {
      c.style.visibility = 'hidden';
      return;
    }
    c.style.visibility = 'visible';
    const ctx = spriteContext(c, 99, 8, this.hudK);
    const b = spriteCanvas('bubble', SPR_BUBBLE, PAL_BUBBLE);
    for (let i = 0; i < bubbles; i++) ctx.drawImage(b, (9 - i) * 10, 0);
  }

  _hurtFlash() {
    this._hurtUntil = performance.now() + 260;
    this.el.vignette.classList.add('is-on');
    clearTimeout(this._timers.hurt);
    this._timers.hurt = setTimeout(() => {
      this.el.vignette.classList.remove('is-on');
      this._hud.flash = undefined;
      if (this.state === 'playing' || this.state === 'dead') this.updateHUD();
    }, 280);
  }

  _toast(text) {
    const t = this.el.toast;
    t.textContent = text;
    t.classList.add('is-on');
    clearTimeout(this._timers.toast);
    this._timers.toast = setTimeout(() => t.classList.remove('is-on'), 1800);
  }

  _updateLockHint() {
    const show = this.state === 'playing' && !this.screen && !document.pointerLockElement;
    if (show !== this._hud.lock) {
      this._hud.lock = show;
      this.el.hint.classList.toggle('tb-hidden', !show);
    }
  }

  // =============================================================================================
  // Slot views
  // =============================================================================================

  // ref: { type: 'inv'|'grid'|'furnace'|'output'|'palette'|'trash'|'hud', get(), set?(stack), accepts?(id),
  //        takeOnly?, index?, id? }
  _makeView(ref, cls = '') {
    const canvas = h('canvas');
    const count = h('span', { class: 'tb-count' });
    const tag = ref.index ?? ref.field ?? ref.id;
    const el = h('div', { class: 'tb-slot' + (cls ? ' ' + cls : ''), tabindex: '-1', role: 'button', 'data-slot': ref.type + (tag !== undefined ? '-' + tag : '') }, canvas, count);
    const view = { el, canvas, countEl: count, ref, id: -1, n: -1, size: 0 };
    el._view = view;
    return view;
  }

  _paintView(view, force = false) {
    const s = view.ref.get();
    const id = s ? s.id : 0;
    const n = s ? s.count : 0;
    const size = view.ref.type === 'output' ? Math.round(this.iconPx * 1.15) : this.iconPx;
    if (!force && id === view.id && n === view.n && size === view.size) return;
    if (force || id !== view.id || size !== view.size) paintIcon(view.canvas, id, size);
    view.countEl.textContent = n > 1 && view.ref.type !== 'palette' ? String(n) : '';
    if (view.ref.type !== 'hud') {
      view.el.classList.toggle('has-item', !!id);
      view.el.setAttribute('aria-label', id ? `${itemName(id)}${n > 1 && view.ref.type !== 'palette' ? ', ' + n : ''}` : view.ref.type === 'trash' ? 'Destroy item' : 'Empty slot');
    }
    view.id = id;
    view.n = n;
    view.size = size;
  }

  // =============================================================================================
  // Inventory windows
  // =============================================================================================

  _invRef(i) {
    return {
      type: 'inv',
      index: i,
      get: () => this.inventory.slots[i] || null,
      set: (s) => {
        this.inventory.slots[i] = s && s.count > 0 ? s : null;
      },
    };
  }

  _buildScreen(sc) {
    const ov = this.el.overlay;
    ov.textContent = '';
    const titles = { player: 'Inventory', creative: 'Creative', crafting_table: 'Crafting Table', furnace: 'Furnace' };
    const win = h('div', { class: 'tb-window tb-panel', role: 'dialog', 'aria-label': titles[sc.kind], tabindex: '-1' });
    const head = h('div', { class: 'tb-win-head' }, h('h2', { class: 'tb-h', text: titles[sc.kind] }));
    const body = h('div', { class: 'tb-win-body' });
    sc.win = win;

    // Inventory refs (shared by every window).
    for (let i = 0; i < INVENTORY_SIZE; i++) sc.invRefs.push(this._invRef(i));

    let bookBtn = null;
    if (sc.kind !== 'creative') {
      bookBtn = h('button', { class: 'tb-btn tb-btn-small', type: 'button', text: sc.kind === 'furnace' ? 'Guide' : 'Recipes', 'aria-pressed': 'false' });
      bookBtn.addEventListener('click', () => {
        this._sound('click', { volume: 0.4 });
        this._toggleBook(sc, !sc.bookOpen);
      });
      head.append(bookBtn);
    }
    const close = h('button', { class: 'tb-btn tb-btn-icon tb-btn-small', type: 'button', title: 'Close (E)', 'aria-label': 'Close', text: '×' });
    close.addEventListener('click', () => this._closeScreen(true));
    head.append(close);
    win.append(head, body);

    if (sc.kind === 'player' || sc.kind === 'crafting_table') body.append(this._buildCraftArea(sc));
    else if (sc.kind === 'furnace') body.append(this._buildFurnaceArea(sc));
    else body.append(this._buildPaletteArea(sc));

    // Storage + hotbar.
    const storage = h('div', { class: 'tb-grid', style: '--cols:9' });
    for (let i = HOTBAR_SIZE; i < INVENTORY_SIZE; i++) storage.append(this._addView(sc, sc.invRefs[i]).el);
    const hot = h('div', { class: 'tb-grid', style: '--cols:9' });
    for (let i = 0; i < HOTBAR_SIZE; i++) hot.append(this._addView(sc, sc.invRefs[i]).el);
    body.append(h('div', { class: 'tb-section' }, h('p', { class: 'tb-label', text: 'Storage' }), storage));
    if (sc.kind === 'creative') {
      const trash = this._addView(sc, { type: 'trash', get: () => null }, 'is-trash');
      trash.el.title = 'Drop a stack here to destroy it';
      body.append(
        h(
          'div',
          { class: 'tb-hotbar-row' },
          h('div', { class: 'tb-section' }, h('p', { class: 'tb-label', text: 'Hotbar' }), hot),
          h('div', { class: 'tb-trash-wrap' }, h('p', { class: 'tb-label', text: 'Bin' }), trash.el),
        ),
      );
    } else {
      body.append(h('div', { class: 'tb-section' }, h('p', { class: 'tb-label', text: 'Hotbar' }), hot));
    }

    const wrap = h('div', { class: 'tb-screen' });
    sc.wrap = wrap;
    wrap.append(win);
    ov.append(wrap);

    if (bookBtn) {
      sc.bookBtn = bookBtn;
      const pref = readPref(BOOK_PREF_KEY);
      const open = pref === null ? window.innerWidth >= 1000 : pref === '1';
      this._toggleBook(sc, open, false);
    }
  }

  _addView(sc, ref, cls = '') {
    const v = this._makeView(ref, cls);
    sc.views.push(v);
    return v;
  }

  _buildCraftArea(sc) {
    const size = sc.gridSize;
    const grid = h('div', { class: 'tb-grid', style: `--cols:${size}` });
    sc.gridViews = [];
    for (let j = 0; j < size * size; j++) {
      const ref = {
        type: 'grid',
        index: j,
        get: () => sc.grid[j] || null,
        set: (s) => {
          sc.grid[j] = s && s.count > 0 ? s : null;
        },
      };
      const v = this._addView(sc, ref);
      sc.gridViews.push(v);
      grid.append(v.el);
    }
    sc.arrow = h('canvas', { class: 'tb-arrow', 'aria-hidden': 'true' });
    const out = this._addView(sc, { type: 'output', takeOnly: true, get: () => (this.craftRecipe ? this.craftRecipe.result : null) }, 'is-output');
    out.el.title = 'Click to craft · Shift-click to craft as many as possible';
    sc.outView = out;
    const craft = h('div', { class: 'tb-craft' }, grid, sc.arrow, out.el);
    const section = h('div', { class: 'tb-section' }, h('p', { class: 'tb-label', text: size === 3 ? 'Crafting (3×3)' : 'Crafting' }), craft);
    const help = h(
      'div',
      { class: 'tb-help' },
      h('div', null, h('kbd', { text: 'Shift' }), '-click: quick move'),
      h('div', null, h('kbd', { text: 'Right' }), '-click: split / one'),
      h('div', null, h('kbd', { text: '1-9' }), ': swap with hotbar'),
    );
    return h('div', { class: 'tb-top' }, section, help);
  }

  _buildFurnaceArea(sc) {
    const f = sc.furnace;
    const mk = (field, accepts, takeOnly, cls) => {
      const ref = {
        type: 'furnace',
        field,
        takeOnly,
        accepts,
        get: () => f[field] || null,
        set: (s) => {
          f[field] = s && s.count > 0 ? s : null;
        },
      };
      sc.refs[field] = ref;
      return this._addView(sc, ref, cls);
    };
    const input = mk('input', null, false, 'tb-f-in');
    const fuel = mk('fuel', (id) => (FUELS[id] || 0) > 0, false, 'tb-f-fuel');
    const out = mk('output', () => false, true, 'is-output tb-f-out');
    input.el.title = 'Item to smelt';
    fuel.el.title = 'Fuel: planks, logs, sticks, coal…';
    sc.flame = h('canvas', { class: 'tb-f-flame', 'aria-hidden': 'true' });
    sc.arrow = h('canvas', { class: 'tb-arrow tb-f-arrow', role: 'progressbar', 'aria-label': 'Smelting progress', 'aria-valuemin': 0, 'aria-valuemax': 100 });
    const box = h('div', { class: 'tb-furnace' }, input.el, sc.flame, fuel.el, sc.arrow, out.el);
    const section = h('div', { class: 'tb-section' }, h('p', { class: 'tb-label', text: 'Smelting' }), box);
    const help = h(
      'div',
      { class: 'tb-help' },
      h('div', null, 'Top: item to smelt'),
      h('div', null, 'Bottom: fuel'),
      h('div', null, h('kbd', { text: 'Shift' }), '-click sorts items in'),
    );
    return h('div', { class: 'tb-top' }, section, help);
  }

  _buildPaletteArea(sc) {
    sc.tab = this._creativeTab || 'all';
    sc.query = '';
    const tabs = h('div', { class: 'tb-ctabs', role: 'tablist', 'aria-label': 'Item categories' });
    for (const t of CREATIVE_TABS) {
      const b = h('button', { class: 'tb-tab' + (t.id === sc.tab ? ' is-on' : ''), type: 'button', role: 'tab', 'aria-selected': String(t.id === sc.tab), text: t.label });
      b.addEventListener('click', () => {
        sc.tab = this._creativeTab = t.id;
        for (const x of tabs.children) {
          const on = x === b;
          x.classList.toggle('is-on', on);
          x.setAttribute('aria-selected', String(on));
        }
        this._sound('click', { volume: 0.35 });
        this._fillPalette(sc);
      });
      tabs.append(b);
    }
    const search = h('input', { class: 'tb-input', type: 'search', placeholder: 'Search items', 'aria-label': 'Search items', autocomplete: 'off', spellcheck: 'false' });
    search.addEventListener('input', () => {
      sc.query = search.value.trim().toLowerCase();
      this._fillPalette(sc);
    });
    search.addEventListener('keydown', (e) => {
      // Enter in the search box grabs the first result.
      if (e.code === 'Enter' && sc.paletteViews && sc.paletteViews[0]) {
        e.preventDefault();
        this._paletteClick(sc.paletteViews[0].ref.id, 0, true);
        this._commitAction();
      }
    });
    sc.search = search;
    sc.palette = h('div', { class: 'tb-grid tb-palette', style: '--cols:9', role: 'listbox', 'aria-label': 'Creative items' });
    this._fillPalette(sc);
    return h('div', { class: 'tb-section' }, h('div', { class: 'tb-palette-tools' }, tabs, search), h('div', { style: 'height:calc(var(--px) * 5)' }), sc.palette);
  }

  _fillPalette(sc) {
    const tab = CREATIVE_TABS.find((t) => t.id === sc.tab) || CREATIVE_TABS[0];
    const q = sc.query;
    const ids = CREATIVE_ITEMS.filter((id) => {
      const it = getItem(id);
      if (!it) return false;
      if (q) return it.name.toLowerCase().includes(q);
      return !tab.cats || tab.cats.includes(it.category);
    });
    // Drop the old palette views.
    if (sc.paletteViews) {
      const old = new Set(sc.paletteViews);
      sc.views = sc.views.filter((v) => !old.has(v));
      if (old.has(this.hoverView)) this.hoverView = null;
      if (old.has(this.focusView)) this.focusView = null;
    }
    sc.palette.textContent = '';
    sc.paletteViews = [];
    for (const id of ids) {
      const v = this._addView(sc, { type: 'palette', id, get: () => ({ id, count: 1 }) });
      v.el.setAttribute('role', 'option');
      sc.paletteViews.push(v);
      sc.palette.append(v.el);
      this._paintView(v, true);
    }
    if (!ids.length) sc.palette.append(h('div', { class: 'tb-palette-empty', text: 'Nothing matches that search.' }));
    sc.palette.scrollTop = 0;
    this._updateTooltip();
  }

  // ---- recipe book / smelting guide -----------------------------------------------------------

  _toggleBook(sc, open, remember = true) {
    sc.bookOpen = open;
    if (sc.bookBtn) {
      sc.bookBtn.classList.toggle('is-on', open);
      sc.bookBtn.setAttribute('aria-pressed', String(open));
    }
    if (remember) writePref(BOOK_PREF_KEY, open ? '1' : '0');
    if (open && !sc.book) {
      sc.book = sc.kind === 'furnace' ? this._buildSmeltGuide(sc) : this._buildRecipeBook(sc);
      sc.wrap.prepend(sc.book);
      this._refreshBook(sc, true);
    } else if (!open && sc.book) {
      sc.book.remove();
      sc.book = null;
      sc.cards = null;
      clearInterval(this._timers.book);
    }
  }

  _bookShell(title) {
    const body = h('div', { class: 'tb-book-body' });
    const book = h('aside', { class: 'tb-book tb-panel', 'aria-label': title }, h('div', { class: 'tb-win-head' }, h('h2', { class: 'tb-h', text: title })), body);
    return { book, body };
  }

  _buildRecipeBook(sc) {
    const { book, body } = this._bookShell('Recipes');
    const search = h('input', { class: 'tb-input', type: 'search', placeholder: 'Find a recipe', 'aria-label': 'Find a recipe', autocomplete: 'off', spellcheck: 'false' });
    const list = h('div', { class: 'tb-book-list' });
    body.append(search, list);
    sc.cards = [];
    const mini = Math.round(this.slotPx * 0.5 * 0.78);
    for (const r of RECIPES) {
      if (r.size > sc.gridSize) continue;
      const cols = r.type === 'shaped' ? r.width : Math.min(3, r.ingredients.length);
      const specs = r.type === 'shaped' ? r.cells : r.ingredients;
      const grid = h('div', { class: 'tb-mini', style: `--cols:${cols}` });
      const cells = [];
      for (const spec of specs) {
        const c = h('canvas');
        const alts = spec === null ? null : Array.isArray(spec) ? spec : [spec];
        cells.push({ canvas: c, alts });
        grid.append(h('div', { class: 'tb-mini-cell' }, c));
      }
      const outCanvas = h('canvas');
      const out = h('div', { class: 'tb-recipe-out' }, outCanvas, r.result.count > 1 ? h('span', { class: 'tb-count', text: String(r.result.count) }) : null);
      const arrow = h('canvas', { class: 'tb-recipe-arrow' });
      const name = itemName(r.result.id);
      const card = h('button', { class: 'tb-recipe', type: 'button', title: `${name}: click to fill the grid, Shift-click to fill as many as you can` }, grid, arrow, out, h('span', { class: 'tb-recipe-name', text: name }));
      card.addEventListener('click', (e) => {
        if (card.classList.contains('is-locked')) {
          this._sound('click', { volume: 0.2, pitch: 0.6 });
          return;
        }
        if (this._fillRecipe(sc, r, e.shiftKey)) {
          this._sound('click', { volume: 0.5 });
          this._commitAction();
        }
      });
      sc.cards.push({ r, card, cells, outCanvas, arrow, name: name.toLowerCase(), mini });
      list.append(card);
    }
    search.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase();
      for (const c of sc.cards) c.card.classList.toggle('tb-hidden', !!q && !c.name.includes(q));
    });
    sc.bookList = list;
    this._paintCards(sc);
    // Cycle "any of" ingredients (e.g. the three kinds of log).
    clearInterval(this._timers.book);
    let tick = 0;
    this._timers.book = setInterval(() => {
      if (!sc.cards || this.screen !== sc) return;
      tick++;
      for (const c of sc.cards) for (const cell of c.cells) if (cell.alts && cell.alts.length > 1) paintIcon(cell.canvas, cell.alts[tick % cell.alts.length], c.mini);
    }, 1100);
    return book;
  }

  _paintCards(sc) {
    if (!sc.cards) return;
    const mini = Math.round(this.slotPx * 0.5 * 0.78);
    const k = Math.max(1, Math.round(this.px / 2));
    for (const c of sc.cards) {
      c.mini = mini;
      for (const cell of c.cells) paintIcon(cell.canvas, cell.alts ? cell.alts[0] : 0, mini);
      paintIcon(c.outCanvas, c.r.result.id, Math.round(this.slotPx * 0.62));
      const ctx = spriteContext(c.arrow, 15, 12, k);
      ctx.drawImage(spriteCanvas('arrow', SPR_ARROW, PAL_ARROW_EMPTY), 0, 0);
    }
  }

  _buildSmeltGuide(sc) {
    const { book, body } = this._bookShell('Furnace Guide');
    const list = h('div', { class: 'tb-book-list' });
    body.append(list);
    const icon = (id, size) => {
      const c = h('canvas');
      paintIcon(c, id, size);
      return c;
    };
    const s = Math.round(this.slotPx * 0.5);
    list.append(h('div', { class: 'tb-book-section', text: 'Smelting' }));
    for (const [inp, out] of Object.entries(SMELTING)) {
      list.append(
        h('div', { class: 'tb-fuel-row', title: `${itemName(+inp)} » ${itemName(out)}` }, icon(+inp, s), h('span', { class: 'tb-recipe-arrow', text: '»' }), icon(out, s), h('span', { text: itemName(out) })),
      );
    }
    list.append(h('div', { class: 'tb-book-section', text: 'Fuel' }));
    const fuels = Object.entries(FUELS).sort((a, b) => b[1] - a[1]);
    for (const [id, secs] of fuels) {
      const items = secs / COOK_TIME;
      const label = items >= 1 ? `smelts ${Number.isInteger(items) ? items : items.toFixed(1)}` : `${secs}s`;
      list.append(h('div', { class: 'tb-fuel-row' }, icon(+id, s), h('span', { text: itemName(+id) }), h('span', { class: 'tb-fuel-time', text: label })));
    }
    return book;
  }

  _repaintBook() {
    const sc = this.screen;
    if (!sc || !sc.book) return;
    // Rebuild at the new size.
    sc.book.remove();
    sc.book = null;
    sc.cards = null;
    this._toggleBook(sc, true, false);
  }

  // Mark recipes the player can make from inventory + grid contents; craftable ones float to the top.
  _refreshBook(sc, resort = false) {
    if (!sc.cards) return;
    const have = this._availableCounts(sc);
    for (const c of sc.cards) {
      c.ok = this._canMake(c.r, new Map(have));
      c.card.classList.toggle('is-locked', !c.ok);
      c.card.setAttribute('aria-disabled', String(!c.ok));
    }
    if (resort && sc.bookList) {
      const sorted = [...sc.cards].sort((a, b) => (b.ok ? 1 : 0) - (a.ok ? 1 : 0));
      for (const c of sorted) sc.bookList.append(c.card);
    }
  }

  _availableCounts(sc) {
    const have = new Map();
    const addStack = (s) => {
      if (s) have.set(s.id, (have.get(s.id) || 0) + s.count);
    };
    for (const s of this.inventory.slots) addStack(s);
    if (sc.grid) for (const s of sc.grid) addStack(s);
    return have;
  }

  // Greedy check / allocation of ingredients; returns chosen ids per spec or null.
  _allocate(specs, have) {
    const chosen = [];
    for (const spec of specs) {
      if (spec === null) {
        chosen.push(null);
        continue;
      }
      const alts = Array.isArray(spec) ? spec : [spec];
      let best = 0;
      let bestN = 0;
      for (const id of alts) {
        const n = have.get(id) || 0;
        if (n > bestN) {
          best = id;
          bestN = n;
        }
      }
      if (!best) return null;
      have.set(best, bestN - 1);
      chosen.push(best);
    }
    return chosen;
  }

  _canMake(r, have) {
    return this._allocate(r.type === 'shaped' ? r.cells : r.ingredients, have) !== null;
  }

  // Move ingredients for recipe r from the inventory into the crafting grid (max: as many sets as fit).
  _fillRecipe(sc, r, max) {
    if (!sc.grid) return false;
    const size = sc.gridSize;
    // Put back whatever is in the grid first.
    for (let j = 0; j < sc.grid.length; j++) {
      const s = sc.grid[j];
      if (!s) continue;
      const left = this.inventory.add(s.id, s.count);
      sc.grid[j] = left > 0 ? { id: s.id, count: left } : null;
      if (left > 0) {
        this.showMessage('Not enough room to clear the crafting grid.');
        return true;
      }
    }
    const layout = new Array(size * size).fill(null);
    if (r.type === 'shaped') {
      for (let y = 0; y < r.height; y++) for (let x = 0; x < r.width; x++) layout[y * size + x] = r.cells[y * r.width + x];
    } else {
      r.ingredients.forEach((spec, i) => (layout[i] = spec));
    }
    const have = new Map();
    for (const s of this.inventory.slots) if (s) have.set(s.id, (have.get(s.id) || 0) + s.count);
    const chosen = this._allocate(layout, new Map(have));
    if (!chosen) return false;
    let sets = 1;
    if (max) {
      const need = new Map();
      for (const id of chosen) if (id) need.set(id, (need.get(id) || 0) + 1);
      sets = 64;
      for (const [id, n] of need) sets = Math.min(sets, Math.floor((have.get(id) || 0) / n), maxStackOf(id));
      sets = Math.max(1, sets);
    }
    chosen.forEach((id, j) => {
      if (!id) return;
      const got = this.inventory.remove(id, sets);
      if (got > 0) sc.grid[j] = { id, count: got };
    });
    return true;
  }

  // ---- screen rendering ---------------------------------------------------------------------

  _renderScreen(force = false) {
    const sc = this.screen;
    if (!sc) return;
    for (const v of sc.views) this._paintView(v, force);
    if (sc.outView) sc.outView.el.classList.toggle('has-item', !!this.craftRecipe);
    if (sc.kind === 'player' || sc.kind === 'crafting_table') {
      const ready = !!this.craftRecipe;
      if (force || ready !== sc.arrowReady) {
        sc.arrowReady = ready;
        const k = Math.max(2, Math.round(this.slotPx / 15));
        const ctx = spriteContext(sc.arrow, 15, 12, k);
        ctx.drawImage(spriteCanvas('arrow', SPR_ARROW, ready ? PAL_ARROW : PAL_ARROW_EMPTY), 0, 0);
      }
    } else if (sc.kind === 'furnace') {
      const f = sc.furnace;
      const k = Math.max(2, Math.round(this.slotPx / 15));
      const flameRows = f.burnTime > 0 && f.burnMax > 0 ? Math.max(1, Math.ceil((f.burnTime / f.burnMax) * 12)) : 0;
      const arrowCols = Math.floor((f.progress / COOK_TIME) * 15);
      if (force || flameRows !== sc.flameRows || k !== sc.k) {
        sc.flameRows = flameRows;
        const ctx = spriteContext(sc.flame, 11, 12, k);
        ctx.drawImage(spriteCanvas('flame', SPR_FLAME, PAL_FLAME_EMPTY), 0, 0);
        if (flameRows) {
          const y = 12 - flameRows;
          ctx.drawImage(spriteCanvas('flame', SPR_FLAME, PAL_FLAME), 0, y, 11, flameRows, 0, y, 11, flameRows);
        }
      }
      if (force || arrowCols !== sc.arrowCols || k !== sc.k) {
        sc.arrowCols = arrowCols;
        const ctx = spriteContext(sc.arrow, 15, 12, k);
        ctx.drawImage(spriteCanvas('arrow', SPR_ARROW, PAL_ARROW_EMPTY), 0, 0);
        if (arrowCols > 0) ctx.drawImage(spriteCanvas('arrow', SPR_ARROW, PAL_ARROW), 0, 0, arrowCols, 12, 0, 0, arrowCols, 12);
        sc.arrow.setAttribute('aria-valuenow', String(Math.round((f.progress / COOK_TIME) * 100)));
      }
      sc.k = k;
    }
  }

  _startScreenLoop() {
    cancelAnimationFrame(this._timers.raf);
    const loop = () => {
      if (!this.screen) return;
      // Inventory can change underneath us (furnace output, pickups): diffed repaint is cheap.
      this._renderScreen(false);
      this._timers.raf = requestAnimationFrame(loop);
    };
    this._timers.raf = requestAnimationFrame(loop);
  }

  _updateCraft() {
    const sc = this.screen;
    this.craftRecipe = sc && sc.grid ? findRecipe(sc.grid, sc.gridSize) : null;
  }

  // After any slot action: notify owners, recompute the recipe and repaint.
  _commitAction() {
    const sc = this.screen;
    if (!sc) return;
    if (this.inventory) this.inventory.changed();
    if (sc.furnace && this.furnaces) this.furnaces.changed(sc.key);
    this._updateCraft();
    this._renderScreen(false);
    this._refreshBook(sc);
    this._renderCursor();
    this._updateTooltip();
  }

  _closeScreen(notify) {
    const sc = this.screen;
    if (!sc) return;
    this._endDrag(false);
    cancelAnimationFrame(this._timers.raf);
    clearInterval(this._timers.book);
    const inv = this.inventory;
    // Crafting grid items go back to the inventory (anything that doesn't fit stays in the grid).
    if (sc.grid && inv) {
      for (let j = 0; j < sc.grid.length; j++) {
        const s = sc.grid[j];
        if (!s) continue;
        const left = inv.add(s.id, s.count);
        sc.grid[j] = left > 0 ? { id: s.id, count: left } : null;
      }
    }
    if (this.cursor) {
      const c = this.cursor;
      let left = inv ? inv.add(c.id, c.count) : c.count;
      if (left > 0 && sc.grid) {
        const j = sc.grid.findIndex((s) => !s);
        if (j >= 0) {
          sc.grid[j] = { id: c.id, count: left };
          left = 0;
        }
      }
      if (left > 0 && sc.furnace && !sc.furnace.input) {
        sc.furnace.input = { id: c.id, count: left };
        left = 0;
      }
      if (left > 0) this.showMessage(`Inventory full: ${left} × ${itemName(c.id)} lost`);
      this.cursor = null;
    }
    if (inv) inv.changed();
    if (sc.furnace && this.furnaces) this.furnaces.changed(sc.key);
    this.screen = null;
    this.craftRecipe = null;
    this.hoverView = null;
    this.focusView = null;
    this.keyboardNav = false;
    this.el.overlay.classList.add('tb-hidden');
    this.el.overlay.textContent = '';
    this.el.tooltip.classList.add('tb-hidden');
    this._renderCursor();
    this._hud.lock = undefined;
    if (notify) {
      this._sound('click', { volume: 0.3 });
      if (this.cb.onScreenClose) this.cb.onScreenClose();
    }
    this._updateLockHint();
  }

  // =============================================================================================
  // Stack interactions
  // =============================================================================================

  _sound(name, opts) {
    try {
      if (this.sounds && this.sounds.play) this.sounds.play(name, opts);
    } catch {
      /* audio is optional */
    }
  }

  _unlockAudio() {
    try {
      if (this.sounds && this.sounds.unlock) this.sounds.unlock();
    } catch {
      /* ignore */
    }
  }

  _accepts(ref, id) {
    if (ref.type === 'output' || ref.type === 'palette' || ref.type === 'trash' || ref.takeOnly) return false;
    return ref.accepts ? !!ref.accepts(id) : true;
  }

  _slotDown(view, e) {
    const ref = view.ref;
    const btn = e.button;
    let changed = false;
    if (btn === 1) {
      // Middle click: creative clone of a full stack.
      const s = ref.get();
      if (this.mode === 'creative' && !this.cursor && s) {
        this.cursor = { id: s.id, count: maxStackOf(s.id) };
        changed = true;
      }
    } else if (ref.type === 'palette') {
      changed = this._paletteClick(ref.id, btn, e.shiftKey);
    } else if (ref.type === 'trash') {
      if (this.cursor) {
        this.cursor = null;
        changed = true;
      }
    } else if (ref.type === 'output') {
      changed = this._outputClick(e.shiftKey);
    } else if (e.shiftKey) {
      changed = this._quickMove(view);
    } else if (btn === 0) {
      if (e.detail >= 2 && this.cursor && this._lastDown === view) {
        changed = this._collect();
        this._ignoreUp = true;
      } else if (this.cursor && !ref.takeOnly && this._accepts(ref, this.cursor.id)) {
        // Begin a possible drag-to-spread; a plain click resolves on mouseup.
        this.drag = { button: 0, views: [view], count: this.cursor.count };
        view.el.classList.add('is-drag');
      } else {
        changed = this._leftClick(ref);
      }
    } else if (btn === 2) {
      const had = !!this.cursor;
      changed = this._rightClick(ref);
      if (had && this.cursor) this.drag = { button: 2, views: [view] };
    }
    this._lastDown = view;
    if (changed) {
      this._sound('click', { volume: 0.25, pitch: 1.3 });
      this._commitAction();
    }
  }

  // Keyboard equivalent of clicking a slot (no drag gestures).
  _activate(view, button, shift) {
    const ref = view.ref;
    let changed;
    if (ref.type === 'palette') changed = this._paletteClick(ref.id, button, shift);
    else if (ref.type === 'trash') {
      changed = !!this.cursor;
      this.cursor = null;
    } else if (ref.type === 'output') changed = this._outputClick(shift);
    else if (shift) changed = this._quickMove(view);
    else changed = button === 2 ? this._rightClick(ref) : this._leftClick(ref);
    if (changed) {
      this._sound('click', { volume: 0.25, pitch: 1.3 });
      this._commitAction();
    }
  }

  _leftClick(ref) {
    const s = ref.get();
    const c = this.cursor;
    if (ref.takeOnly) return this._takeFrom(ref, s ? s.count : 0);
    if (!c) {
      if (!s) return false;
      this.cursor = { id: s.id, count: s.count };
      ref.set(null);
      return true;
    }
    if (!this._accepts(ref, c.id)) return false;
    const max = maxStackOf(c.id);
    if (!s) {
      const n = Math.min(c.count, max);
      ref.set({ id: c.id, count: n });
      this._cursorTake(n);
      return true;
    }
    if (s.id === c.id) {
      const n = Math.min(max - s.count, c.count);
      if (n <= 0) return false;
      s.count += n;
      this._cursorTake(n);
      return true;
    }
    if (c.count > max) return false;
    ref.set({ id: c.id, count: c.count });
    this.cursor = { id: s.id, count: s.count };
    return true;
  }

  _rightClick(ref) {
    const s = ref.get();
    const c = this.cursor;
    if (ref.takeOnly) return this._takeFrom(ref, s ? Math.ceil(s.count / 2) : 0);
    if (!c) {
      if (!s) return false;
      const half = Math.ceil(s.count / 2);
      this.cursor = { id: s.id, count: half };
      s.count -= half;
      if (s.count <= 0) ref.set(null);
      return true;
    }
    if (!this._accepts(ref, c.id)) return false;
    if (!s) {
      ref.set({ id: c.id, count: 1 });
      this._cursorTake(1);
      return true;
    }
    if (s.id === c.id) {
      if (s.count >= maxStackOf(s.id)) return false;
      s.count += 1;
      this._cursorTake(1);
      return true;
    }
    return this._leftClick(ref); // different item: swap
  }

  _cursorTake(n) {
    this.cursor.count -= n;
    if (this.cursor.count <= 0) this.cursor = null;
  }

  // Take up to n items from a take-only slot (furnace output) onto the cursor.
  _takeFrom(ref, n) {
    const s = ref.get();
    if (!s || n <= 0) return false;
    const c = this.cursor;
    if (c && c.id !== s.id) return false;
    const k = Math.min(n, s.count, maxStackOf(s.id) - (c ? c.count : 0));
    if (k <= 0) return false;
    this.cursor = { id: s.id, count: (c ? c.count : 0) + k };
    s.count -= k;
    if (s.count <= 0) ref.set(null);
    return true;
  }

  _outputClick(shift) {
    const sc = this.screen;
    if (!sc || !sc.grid) return false;
    if (shift) {
      // Craft as many as fit into the inventory.
      let crafted = 0;
      for (let i = 0; i < 64; i++) {
        const r = this.craftRecipe;
        if (!r || !this.inventory.canAdd(r.result.id, r.result.count)) break;
        this.inventory.add(r.result.id, r.result.count);
        this._consumeGrid(sc);
        this._updateCraft();
        crafted++;
      }
      if (crafted === 0 && this.craftRecipe) this.showMessage('Your inventory is full.');
      return crafted > 0;
    }
    const r = this.craftRecipe;
    if (!r) return false;
    const res = r.result;
    const c = this.cursor;
    if (c && (c.id !== res.id || c.count + res.count > maxStackOf(res.id))) return false;
    this.cursor = { id: res.id, count: (c ? c.count : 0) + res.count };
    this._consumeGrid(sc);
    return true;
  }

  _consumeGrid(sc) {
    for (let j = 0; j < sc.grid.length; j++) {
      const s = sc.grid[j];
      if (!s) continue;
      s.count -= 1;
      if (s.count <= 0) sc.grid[j] = null;
    }
  }

  _paletteClick(id, button, shift) {
    const max = maxStackOf(id);
    const c = this.cursor;
    if (shift && !c) {
      this.inventory.add(id, max);
      return true;
    }
    if (c) {
      if (c.id === id) {
        const next = button === 2 ? Math.min(max, c.count + 1) : max;
        if (next === c.count) return false;
        c.count = next;
      } else {
        this.cursor = null; // clicking the palette with a different stack puts it away
      }
      return true;
    }
    this.cursor = { id, count: button === 2 ? 1 : max };
    return true;
  }

  // Merge `ref`'s stack into the target refs (existing stacks first, then empty slots).
  _moveTo(ref, targets) {
    const s = ref.get();
    if (!s) return false;
    const max = maxStackOf(s.id);
    let left = s.count;
    for (const t of targets) {
      if (left <= 0) break;
      if (t === ref || !this._accepts(t, s.id)) continue;
      const d = t.get();
      if (d && d.id === s.id && d.count < max) {
        const n = Math.min(max - d.count, left);
        d.count += n;
        left -= n;
      }
    }
    for (const t of targets) {
      if (left <= 0) break;
      if (t === ref || !this._accepts(t, s.id) || t.get()) continue;
      const n = Math.min(max, left);
      t.set({ id: s.id, count: n });
      left -= n;
    }
    if (left === s.count) return false;
    s.count = left;
    if (left <= 0) ref.set(null);
    return true;
  }

  _quickMove(view) {
    const sc = this.screen;
    const ref = view.ref;
    const s = ref.get();
    if (!s) return false;
    const inv = sc.invRefs;
    const hotbar = inv.slice(0, HOTBAR_SIZE);
    const storage = inv.slice(HOTBAR_SIZE);
    if (ref.type === 'inv') {
      if (sc.kind === 'furnace') {
        if (SMELTING[s.id] !== undefined && this._moveTo(ref, [sc.refs.input])) return true;
        if ((FUELS[s.id] || 0) > 0 && this._moveTo(ref, [sc.refs.fuel])) return true;
      }
      return this._moveTo(ref, ref.index < HOTBAR_SIZE ? storage : hotbar);
    }
    // Grid / furnace slots empty into the inventory, hotbar first.
    return this._moveTo(ref, inv);
  }

  // Double-click: gather matching items into the held stack.
  _collect() {
    const c = this.cursor;
    if (!c) return false;
    const max = maxStackOf(c.id);
    const sources = this.screen.views
      .filter((v) => (v.ref.type === 'inv' || v.ref.type === 'grid') && v.ref.get() && v.ref.get().id === c.id)
      .sort((a, b) => a.ref.get().count - b.ref.get().count);
    let changed = false;
    for (const v of sources) {
      if (c.count >= max) break;
      const s = v.ref.get();
      const n = Math.min(max - c.count, s.count);
      c.count += n;
      s.count -= n;
      if (s.count <= 0) v.ref.set(null);
      changed = true;
    }
    return changed;
  }

  // Number key over a slot: swap it with that hotbar slot.
  _hotkeySwap(view, n) {
    const sc = this.screen;
    const ref = view.ref;
    const hot = sc.invRefs[n];
    if (ref.type === 'palette') {
      hot.set({ id: ref.id, count: maxStackOf(ref.id) });
      return true;
    }
    if (ref.type === 'output' || ref.type === 'trash' || ref.type === 'hud' || ref === hot) return false;
    const a = ref.get();
    const b = hot.get();
    if (!a && !b) return false;
    if (b && !this._accepts(ref, b.id)) return false;
    ref.set(b ? { id: b.id, count: b.count } : null);
    hot.set(a ? { id: a.id, count: a.count } : null);
    return true;
  }

  _canDrop(ref, id) {
    if (!(ref.type === 'inv' || ref.type === 'grid' || ref.type === 'furnace') || !this._accepts(ref, id)) return false;
    const s = ref.get();
    return !s || (s.id === id && s.count < maxStackOf(id));
  }

  _dragOver(view) {
    const d = this.drag;
    if (!d || !this.cursor || d.views.includes(view)) return;
    if (!this._canDrop(view.ref, this.cursor.id)) return;
    if (d.button === 0) {
      if (d.views.length >= d.count) return;
      d.views.push(view);
      view.el.classList.add('is-drag');
    } else if (d.button === 2) {
      d.views.push(view);
      if (this._rightClick(view.ref)) this._commitAction();
    }
  }

  _endDrag(apply) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    for (const v of d.views) v.el.classList.remove('is-drag');
    if (!apply || d.button !== 0 || !this.cursor || !this.screen) return;
    let changed = false;
    if (d.views.length === 1) {
      changed = this._leftClick(d.views[0].ref);
    } else {
      // Spread the held stack evenly across the dragged-over slots.
      const id = this.cursor.id;
      const max = maxStackOf(id);
      const per = Math.floor(d.count / d.views.length);
      for (const v of d.views) {
        if (!this.cursor || per <= 0) break;
        const s = v.ref.get();
        if (s && s.id !== id) continue;
        const k = Math.min(per, s ? max - s.count : max, this.cursor.count);
        if (k <= 0) continue;
        if (s) s.count += k;
        else v.ref.set({ id, count: k });
        this._cursorTake(k);
        changed = true;
      }
    }
    if (changed) {
      this._sound('click', { volume: 0.25, pitch: 1.3 });
      this._commitAction();
    }
  }

  // ---- keyboard focus ---------------------------------------------------------------------

  _moveFocus(dx, dy) {
    const sc = this.screen;
    if (!sc) return;
    this.keyboardNav = true;
    const views = sc.views.filter((v) => v.el.isConnected && v.el.offsetParent !== null);
    if (!views.length) return;
    let cur = this.focusView && views.includes(this.focusView) ? this.focusView : null;
    if (!cur) {
      cur = views.find((v) => v.ref.type === 'inv' && v.ref.index === (this.inventory ? this.inventory.selected : 0)) || views[0];
      this._focus(cur);
      return;
    }
    const a = cur.el.getBoundingClientRect();
    const ax = a.left + a.width / 2;
    const ay = a.top + a.height / 2;
    let best = null;
    let bestScore = Infinity;
    for (const v of views) {
      if (v === cur) continue;
      const b = v.el.getBoundingClientRect();
      const bx = b.left + b.width / 2;
      const by = b.top + b.height / 2;
      const along = (bx - ax) * dx + (by - ay) * dy;
      if (along <= 2) continue;
      const across = Math.abs((bx - ax) * dy) + Math.abs((by - ay) * dx);
      const score = along + across * 2.5;
      if (score < bestScore) {
        bestScore = score;
        best = v;
      }
    }
    if (best) this._focus(best);
  }

  _focus(view) {
    if (this.focusView && this.focusView.el) {
      this.focusView.el.classList.remove('is-focus');
      this.focusView.el.setAttribute('tabindex', '-1');
    }
    this.focusView = view;
    view.el.classList.add('is-focus');
    view.el.setAttribute('tabindex', '0');
    view.el.focus({ preventScroll: false });
    view.el.scrollIntoView({ block: 'nearest' });
    this._positionFloaters();
    this._updateTooltip();
  }

  // ---- cursor stack + tooltip -------------------------------------------------------------

  _renderCursor() {
    const c = this.cursor;
    const el = this.el.cursor;
    if (!c || !this.screen) {
      el.classList.add('tb-hidden');
      return;
    }
    el.classList.remove('tb-hidden');
    const key = `${c.id}:${this.iconPx}`;
    if (el.dataset.size !== key) {
      el.dataset.size = key;
      paintIcon(this.el.cursorIcon, c.id, this.iconPx);
    }
    this.el.cursorCount.textContent = c.count > 1 ? String(c.count) : '';
    this._positionFloaters();
  }

  _positionFloaters() {
    let x = this.mouse.x;
    let y = this.mouse.y;
    if (this.keyboardNav && this.focusView && this.focusView.el.isConnected) {
      const r = this.focusView.el.getBoundingClientRect();
      x = r.left + r.width * 0.75;
      y = r.top + r.height * 0.75;
    }
    if (this.cursor) this.el.cursor.style.transform = `translate(${Math.round(x - this.slotPx / 2)}px, ${Math.round(y - this.slotPx / 2)}px)`;
    const tip = this.el.tooltip;
    if (!tip.classList.contains('tb-hidden')) {
      const tw = tip.offsetWidth;
      const th = tip.offsetHeight;
      let tx = x + 16;
      let ty = y - th - 8;
      if (tx + tw > window.innerWidth - 4) tx = x - tw - 16;
      if (ty < 4) ty = y + 20;
      tip.style.transform = `translate(${Math.round(Math.max(4, tx))}px, ${Math.round(ty)}px)`;
    }
  }

  _updateTooltip() {
    const tip = this.el.tooltip;
    const view = this.keyboardNav ? this.focusView : this.hoverView;
    const s = view && !this.cursor && this.screen ? view.ref.get() : null;
    if (!s) {
      if (view && view.ref.type === 'trash' && this.screen && !this.cursor) {
        this._setTooltip('Bin', ['Drop a stack here to destroy it']);
        return;
      }
      tip.classList.add('tb-hidden');
      this._tipId = 0;
      return;
    }
    const it = getItem(s.id);
    if (!it) {
      tip.classList.add('tb-hidden');
      return;
    }
    const lines = [];
    if (it.tool) {
      const t = it.tool;
      lines.push(t.type === 'sword' ? `Attack ${t.damage / 2} ♥ · speed ${t.speed}` : `Mining speed ${t.speed} · attack ${t.damage / 2}`);
    }
    if (it.food) lines.push(`Restores ${it.food.hunger / 2} food`);
    if (this.screen && this.screen.kind === 'furnace') {
      if (SMELTING[s.id] !== undefined) lines.push(`Smelts into ${itemName(SMELTING[s.id])}`);
      if (FUELS[s.id]) lines.push(`Fuel: burns ${FUELS[s.id]}s`);
    }
    if (view.ref.type === 'output' && this.screen.grid) lines.push('Shift-click to craft all');
    if (view.ref.type === 'palette') lines.push('Click: stack · Right: one · Shift: to inventory');
    this._setTooltip(it.name, lines);
  }

  _setTooltip(title, lines) {
    const tip = this.el.tooltip;
    const html = [h('b', { text: title }), ...lines.map((l, i) => h('small', { class: i === 0 ? 'is-accent' : '', text: l }))];
    tip.textContent = '';
    tip.append(...html);
    tip.classList.remove('tb-hidden');
    this._positionFloaters();
  }
}
