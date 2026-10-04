// Terrablock block interaction: voxel raycast targeting, the selection outline, mining (survival timing
// with tool speed / tier rules and a crack overlay, instant creative breaking with repeat), placing,
// eating, pick-block, melee hits on mobs, drops into the inventory, debris particles and sounds.
//
// Mouse buttons are read from document mousedown/mouseup while the pointer is locked (and the system
// is enabled). Tests can call setButton(button, down) directly, or set requirePointerLock = false.

import * as THREE from '../vendor/three.module.min.js';
import { REACH_SURVIVAL, REACH_CREATIVE, WORLD_HEIGHT, HOTBAR_SIZE, INVENTORY_SIZE, tileUV } from './config.js';
import { B, BLOCKS, LIQUID, getBlock } from './blocks.js';
import { getItem } from './items.js';
import * as Textures from './textures.js'; // CRACK_TILES, createAtlas, getAtlasPixels (optional)

const { CRACK_TILES } = Textures;

const CREATIVE_BREAK_REPEAT = 0.25; // s between creative breaks while the button is held
const PLACE_REPEAT = 0.25; // s between placements while the button is held
const BREAK_COOLDOWN = 0.25; // s pause after a survival break before the next block starts
const DIG_SOUND_INTERVAL = 0.25;
const EAT_TIME = 1.2; // s of holding right-click to finish eating
const EAT_SOUND_INTERVAL = 0.22;
const MAX_HUNGER = 20;
const MAX_PARTICLES = 160;
const PARTICLE_GRAVITY = 18;

// Blocks a flower / grass / bush may be planted on. Dead bushes also take sand (where they grow).
const PLANT_SOIL = new Set([B.GRASS, B.DIRT, B.SNOWY_GRASS]);
const DESERT_SOIL = new Set([B.SAND]);

// Cell-local selection boxes [minX, minY, minZ, maxX, maxY, maxZ] for blocks that aren't full cubes.
const SELECTION = new Array(256).fill(null);
for (const def of BLOCKS) {
  if (def && def.shape === 'cross') SELECTION[def.id] = [0.2, 0, 0.2, 0.8, 0.8, 0.8];
}
SELECTION[B.CACTUS] = [1 / 16, 0, 1 / 16, 15 / 16, 1, 15 / 16];
const FULL_BOX = [0, 0, 0, 1, 1, 1];

const rand = (a, b) => a + Math.random() * (b - a);

// ---------------------------------------------------------------------------------------------
// Mining rules.

// Tool stats of a held item id (null for an empty hand or a non-tool).
function toolOfItem(heldId) {
  if (!heldId) return null;
  const item = getItem(heldId);
  return item && item.tool ? item.tool : null;
}

// How long breaking `blockId` takes with `heldId` (0 / null = empty hand), and whether it drops.
//   time = hardness x 1.5 / toolSpeed with the block's preferred tool, hardness x 1.5 otherwise,
//   and hardness x 5 (no drop) when the block needs a pickaxe tier (minTier) that isn't met.
export function breakInfo(blockId, heldId) {
  const def = getBlock(blockId);
  if (!(def.hardness >= 0) || blockId === B.AIR || def.liquid) return { breakable: false, time: Infinity, harvest: false };
  const tool = toolOfItem(heldId);
  const harvest = def.minTier == null || (tool !== null && tool.type === 'pickaxe' && tool.tier >= def.minTier);
  let time;
  if (!harvest) time = def.hardness * 5;
  else if (tool !== null && def.tool && tool.type === def.tool) time = (def.hardness * 1.5) / Math.max(1, tool.speed || 1);
  else time = def.hardness * 1.5;
  return { breakable: true, time, harvest };
}

// Item dropped by breaking a block with the right tier (null when nothing drops this time).
function rollDrop(def) {
  if (def.drop == null) return null;
  const chance = def.dropChance ?? 1;
  if (chance < 1 && Math.random() >= chance) return null;
  return def.drop;
}

// ---------------------------------------------------------------------------------------------
// Raycasting.

// Ray vs a cell-local box (origin already relative to the cell). -> { t, normal } | null
function rayBox(ox, oy, oz, dx, dy, dz, b, maxDist) {
  const o = [ox, oy, oz];
  const d = [dx, dy, dz];
  let tmin = -Infinity;
  let tmax = Infinity;
  let axis = -1;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-12) {
      if (o[i] < b[i] || o[i] > b[i + 3]) return null;
      continue;
    }
    let t1 = (b[i] - o[i]) / d[i];
    let t2 = (b[i + 3] - o[i]) / d[i];
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    if (t1 > tmin) {
      tmin = t1;
      axis = i;
    }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  if (tmax < 0) return null;
  const t = Math.max(0, tmin);
  if (t > maxDist) return null;
  const normal = [0, 0, 0];
  if (axis >= 0 && tmin >= 0) normal[axis] = d[axis] > 0 ? -1 : 1;
  else dominantNormal(dx, dy, dz, normal);
  return { t, normal };
}

// Face facing back along the ray's dominant axis (used when the ray starts inside a block).
function dominantNormal(dx, dy, dz, out) {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  const az = Math.abs(dz);
  out[0] = out[1] = out[2] = 0;
  if (ax >= ay && ax >= az) out[0] = dx > 0 ? -1 : 1;
  else if (ay >= az) out[1] = dy > 0 ? -1 : 1;
  else out[2] = dz > 0 ? -1 : 1;
  return out;
}

// Voxel DDA (Amanatides & Woo) from (ox,oy,oz) along the unit vector (dx,dy,dz). Skips air and water,
// tests plants against their smaller selection box, and stops at unloaded chunks.
// -> { x, y, z, id, normal: [nx, ny, nz], dist } | null
export function raycastBlocks(world, ox, oy, oz, dx, dy, dz, maxDist) {
  let x = Math.floor(ox);
  let y = Math.floor(oy);
  let z = Math.floor(oz);
  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
  const tdx = stepX ? Math.abs(1 / dx) : Infinity;
  const tdy = stepY ? Math.abs(1 / dy) : Infinity;
  const tdz = stepZ ? Math.abs(1 / dz) : Infinity;
  let tmx = stepX > 0 ? (x + 1 - ox) * tdx : stepX < 0 ? (ox - x) * tdx : Infinity;
  let tmy = stepY > 0 ? (y + 1 - oy) * tdy : stepY < 0 ? (oy - y) * tdy : Infinity;
  let tmz = stepZ > 0 ? (z + 1 - oz) * tdz : stepZ < 0 ? (oz - z) * tdz : Infinity;
  const n = dominantNormal(dx, dy, dz, [0, 0, 0]);
  let t = 0;
  for (let guard = 0; guard < 1024; guard++) {
    const id = world.getBlock(x, y, z);
    if (id < 0) return null;
    if (id > 0 && !LIQUID[id]) {
      const sel = SELECTION[id];
      if (!sel) return { x, y, z, id, normal: [n[0], n[1], n[2]], dist: t };
      const hit = rayBox(ox - x, oy - y, oz - z, dx, dy, dz, sel, maxDist);
      if (hit) return { x, y, z, id, normal: hit.normal, dist: hit.t };
    }
    if (tmx < tmy && tmx < tmz) {
      if (tmx > maxDist) break;
      t = tmx;
      x += stepX;
      tmx += tdx;
      n[0] = -stepX;
      n[1] = 0;
      n[2] = 0;
    } else if (tmy < tmz) {
      if (tmy > maxDist) break;
      t = tmy;
      y += stepY;
      tmy += tdy;
      n[0] = 0;
      n[1] = -stepY;
      n[2] = 0;
    } else {
      if (tmz > maxDist) break;
      t = tmz;
      z += stepZ;
      tmz += tdz;
      n[0] = 0;
      n[1] = 0;
      n[2] = -stepZ;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------

export class Interaction {
  constructor({ world, player, renderer = null, inventory = null, survival = null, mobs = null, sounds = null, getMode = null,
    callbacks = {} } = {}) {
    this.world = world;
    this.player = player;
    this.renderer = renderer;
    this.inventory = inventory;
    this.survival = survival;
    this.mobs = mobs;
    this.sounds = sounds;
    this.getMode = getMode;
    this.callbacks = callbacks || {};

    this.target = null; // { x, y, z, id, normal: [nx, ny, nz], dist } | null
    this.breaking = null; // survival mining state { x, y, z, id, held, time, harvest, progress }
    this.eating = null; // { id, slot, time }
    this.requirePointerLock = true;

    this._enabled = true;
    this._down = [false, false, false];
    this._pressed = [false, false, false];
    this._leftConsumed = false;
    this._leftRepeat = 0;
    this._rightRepeat = 0;
    this._rightMode = null; // 'used' (opened a block UI) | 'auto' (place / eat, repeats while held)
    this._cooldown = 0;
    this._origin = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._color = new THREE.Color();
    this._matrix = new THREE.Matrix4();
    this._parts = [];
    this._atlasPixels = undefined; // lazily fetched RGBA atlas buffer for particle colours

    this._buildMeshes();

    // Let hunger gate sprinting and count jumps, unless main.js wired these hooks itself.
    if (player && player.canSprint == null) {
      player.canSprint = () => {
        const s = this.survival;
        if (!s || this._isCreative()) return true;
        if (typeof s.canSprint === 'function') return s.canSprint() !== false;
        if (typeof s.canSprint === 'boolean') return s.canSprint;
        return !(s.hunger <= 6);
      };
    }
    if (player && player.onJump == null) {
      player.onJump = () => {
        const s = this.survival;
        if (s && typeof s.jumped === 'function' && !this._isCreative()) s.jumped();
      };
    }

    this._onMouseDown = (e) => {
      if (!this._enabled || e.button > 2) return;
      if (this.requirePointerLock && !document.pointerLockElement) return;
      if (e.button === 1) e.preventDefault(); // no autoscroll
      this.setButton(e.button, true);
    };
    this._onMouseUp = (e) => {
      if (e.button <= 2) this.setButton(e.button, false);
    };
    this._onBlur = () => this.releaseButtons();
    this._onLockChange = () => {
      if (!document.pointerLockElement) this.releaseButtons();
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('mousedown', this._onMouseDown);
      document.addEventListener('mouseup', this._onMouseUp);
      document.addEventListener('pointerlockchange', this._onLockChange);
      window.addEventListener('blur', this._onBlur);
    }
  }

  get enabled() {
    return this._enabled;
  }

  set enabled(v) {
    v = !!v;
    if (v === this._enabled) return;
    this._enabled = v;
    if (!v) this.releaseButtons();
  }

  // 0..1 while eating (for a HUD hint), else 0.
  get eatProgress() {
    return this.eating ? Math.min(1, this.eating.time / EAT_TIME) : 0;
  }

  // 0..1 survival mining progress of the targeted block, else 0.
  get breakProgress() {
    return this.breaking ? Math.min(1, this.breaking.progress) : 0;
  }

  // Press / release a mouse button (0 left, 1 middle, 2 right). Presses are latched until the next
  // update() so a click shorter than a frame still registers.
  setButton(button, down) {
    if (button < 0 || button > 2) return;
    if (down) {
      if (!this._enabled) return;
      if (!this._down[button]) this._pressed[button] = true;
      this._down[button] = true;
    } else {
      this._down[button] = false;
    }
  }

  releaseButtons() {
    this._down[0] = this._down[1] = this._down[2] = false;
    this._pressed[0] = this._pressed[1] = this._pressed[2] = false;
    this.breaking = null;
    this.eating = null;
  }

  update(dt) {
    dt = dt > 0 ? Math.min(dt, 0.1) : 0;
    const creative = this._isCreative();
    const reach = creative ? REACH_CREATIVE : REACH_SURVIVAL;
    const o = this.player.getEyePosition(this._origin);
    const d = this.player.getLookDirection(this._dir);
    this.target = raycastBlocks(this.world, o.x, o.y, o.z, d.x, d.y, d.z, reach);
    if (this._cooldown > 0) this._cooldown = Math.max(0, this._cooldown - dt);

    if (this._enabled) this._handleInput(dt, creative);
    else this.releaseButtons();

    this._updateHighlight();
    this._updateCrack();
    this._updateParticles(dt);
  }

  dispose() {
    if (typeof document !== 'undefined') {
      document.removeEventListener('mousedown', this._onMouseDown);
      document.removeEventListener('mouseup', this._onMouseUp);
      document.removeEventListener('pointerlockchange', this._onLockChange);
      window.removeEventListener('blur', this._onBlur);
    }
    for (const obj of [this.highlight, this.crack, this.particles]) {
      if (obj.parent) obj.parent.remove(obj);
      obj.geometry.dispose();
      obj.material.dispose();
    }
    if (this._ownTexture) this._ownTexture.dispose();
  }

  // ---- input handling --------------------------------------------------------------------------

  _handleInput(dt, creative) {
    // Left: hit a mob first, otherwise mine.
    const pressedL = this._pressed[0];
    this._pressed[0] = false;
    if (pressedL) {
      this.breaking = null;
      this._leftConsumed = this._tryAttack(creative);
      if (!this._leftConsumed && creative) {
        this._creativeBreak();
        this._leftRepeat = CREATIVE_BREAK_REPEAT;
      }
    }
    if (!this._leftConsumed && (this._down[0] || pressedL)) {
      if (creative) {
        if (!pressedL) {
          this._leftRepeat -= dt;
          if (this._leftRepeat <= 1e-6) {
            // Carry the remainder so the cadence stays at exactly one break per interval.
            this._leftRepeat = Math.max(0, this._leftRepeat + CREATIVE_BREAK_REPEAT);
            if (!this._tryAttack(true)) this._creativeBreak();
          }
        }
      } else {
        this._survivalBreak(this._down[0] ? dt : 0);
      }
    } else {
      this.breaking = null;
    }

    // Right: use a block (crafting table, furnace), else eat / place; placing repeats while held.
    const pressedR = this._pressed[2];
    this._pressed[2] = false;
    if (pressedR) {
      this.eating = null;
      this._rightRepeat = PLACE_REPEAT;
      this._rightMode = this._tryUse() ? 'used' : 'auto';
      if (this._rightMode === 'auto') this._secondary(creative);
    } else if (this._down[2] && this._rightMode === 'auto') {
      if (this.eating) {
        this._updateEating(dt, creative);
      } else {
        this._rightRepeat -= dt;
        if (this._rightRepeat <= 1e-6) {
          this._rightRepeat = Math.max(0, this._rightRepeat + PLACE_REPEAT);
          this._secondary(creative);
        }
      }
    }
    if (!this._down[2]) this.eating = null;

    // Middle: pick block.
    if (this._pressed[1]) {
      this._pressed[1] = false;
      this._pickBlock(creative);
    }
  }

  _isCreative() {
    const mode = this.getMode ? this.getMode() : this.player && this.player.mode;
    return mode === 'creative';
  }

  _heldId() {
    const s = this.inventory && this.inventory.getSelected();
    return s && s.count > 0 ? s.id : 0;
  }

  _play(name, opts) {
    if (this.sounds && this.sounds.play) this.sounds.play(name, opts);
  }

  // Melee: ask the mob manager for a hit along the view ray, no further than the targeted block.
  _tryAttack(creative) {
    const mobs = this.mobs;
    if (!mobs || typeof mobs.attack !== 'function') return false;
    const reach = creative ? REACH_CREATIVE : REACH_SURVIVAL;
    const limit = this.target ? Math.min(reach, this.target.dist) : reach;
    const tool = toolOfItem(this._heldId());
    const damage = tool && tool.damage ? tool.damage : 1;
    return !!mobs.attack(this._origin.clone(), this._dir.clone(), limit, damage);
  }

  _tryUse() {
    const t = this.target;
    const cb = this.callbacks.onUseBlock;
    if (!t || typeof cb !== 'function') return false;
    // Sneaking with a block in hand places against the block instead of opening it.
    if (this.player.sneaking && isPlaceable(this._heldId())) return false;
    return !!cb(t.x, t.y, t.z, t.id);
  }

  // Right-click action that isn't "use": start eating, or place the held block.
  _secondary(creative) {
    const held = this._heldId();
    if (!held) return false;
    const item = getItem(held);
    if (item && item.food) {
      if (creative || !this._canEat(held)) return false;
      this.eating = { id: held, slot: this.inventory.selected, time: 0, soundTimer: 0 };
      return true;
    }
    if (isPlaceable(held)) return this._place(held, creative);
    return false;
  }

  _canEat(id) {
    const s = this.survival;
    if (!s) return false;
    if (typeof s.canEat === 'function') return !!s.canEat(id);
    const item = getItem(id);
    return !!(item && item.food) && s.hunger < MAX_HUNGER;
  }

  _updateEating(dt, creative) {
    const e = this.eating;
    const inv = this.inventory;
    const sel = inv && inv.getSelected();
    if (creative || !sel || sel.id !== e.id || inv.selected !== e.slot || !this._canEat(e.id)) {
      this.eating = null;
      return;
    }
    e.time += dt;
    e.soundTimer -= dt;
    if (e.soundTimer <= 0) {
      e.soundTimer = EAT_SOUND_INTERVAL;
      this._play('eat', { volume: 0.55 });
    }
    if (e.time >= EAT_TIME) {
      this.eating = null;
      this._rightRepeat = PLACE_REPEAT; // a short pause before the next bite if still held
      if (this.survival.eat(e.id)) {
        inv.removeFromSelected(1);
        this._play('eat', { volume: 0.9, pitch: 0.8 });
      }
    }
  }

  // ---- breaking --------------------------------------------------------------------------------

  _creativeBreak() {
    const t = this.target;
    if (t) this._breakBlock(t.x, t.y, t.z, t.id, false);
  }

  _survivalBreak(dt) {
    if (this._cooldown > 0) {
      this.breaking = null;
      return;
    }
    const t = this.target;
    if (!t) {
      this.breaking = null;
      return;
    }
    const held = this._heldId();
    let br = this.breaking;
    if (!br || br.x !== t.x || br.y !== t.y || br.z !== t.z || br.id !== t.id || br.held !== held) {
      const info = breakInfo(t.id, held);
      if (!info.breakable) {
        this.breaking = null;
        return;
      }
      br = this.breaking = { x: t.x, y: t.y, z: t.z, id: t.id, held, time: info.time, harvest: info.harvest, progress: 0, soundTimer: 0 };
    }
    br.progress = br.time > 0 ? br.progress + dt / br.time : 1;
    br.soundTimer -= dt;
    if (br.progress < 1 - 1e-9 && br.soundTimer <= 0) {
      br.soundTimer = DIG_SOUND_INTERVAL;
      this._play('dig', { material: getBlock(br.id).sound, volume: 0.7 });
      this._spawnParticles(br.x, br.y, br.z, br.id, 4, t.normal);
    }
    if (br.progress >= 1 - 1e-9) {
      this.breaking = null;
      if (this._breakBlock(br.x, br.y, br.z, br.id, br.harvest)) this._cooldown = BREAK_COOLDOWN;
    }
  }

  // Removes the block; in survival (harvest = true) its drop goes straight into the inventory.
  _breakBlock(x, y, z, id, harvest) {
    if (this.world.getBlock(x, y, z) !== id) return false;
    if (!this.world.setBlock(x, y, z, B.AIR)) return false;
    const def = getBlock(id);
    this._play('break', { material: def.sound });
    this._spawnParticles(x, y, z, id, 24, null);
    if (harvest && this.inventory) {
      const drop = rollDrop(def);
      if (drop != null && this.inventory.add(drop, 1) === 0) this._play('pop', { volume: 0.3, pitch: rand(1.1, 1.5) });
    }
    const cb = this.callbacks.onBlockBroken;
    if (typeof cb === 'function') cb(x, y, z, id);
    return true;
  }

  // ---- placing ---------------------------------------------------------------------------------

  _place(id, creative) {
    const t = this.target;
    if (!t) return false;
    const world = this.world;
    const def = getBlock(id);
    // Replaceable targets (tall grass, dead bush) are overwritten in place; otherwise use the face.
    let px = t.x;
    let py = t.y;
    let pz = t.z;
    if (!getBlock(t.id).replaceable) {
      px += t.normal[0];
      py += t.normal[1];
      pz += t.normal[2];
    }
    if (py < 0 || py >= WORLD_HEIGHT) return false;
    const cur = world.getBlock(px, py, pz);
    if (cur < 0 || cur === id) return false;
    if (cur !== B.AIR && !getBlock(cur).replaceable) return false;
    if (def.shape === 'cross') {
      const below = world.getBlock(px, py - 1, pz);
      if (!PLANT_SOIL.has(below) && !(id === B.DEAD_BUSH && DESERT_SOIL.has(below))) return false;
    }
    // Sand and gravel drop straight to where they would land.
    if (def.gravity) {
      while (py > 0 && world.getBlock(px, py - 1, pz) === B.AIR) py--;
    }
    if (def.solid) {
      if (this._intersectsPlayer(px, py, pz)) return false;
      const mobs = this.mobs;
      if (mobs && typeof mobs.intersectsBlock === 'function' && mobs.intersectsBlock(px, py, pz)) return false;
    }
    if (!world.setBlock(px, py, pz, id)) return false;
    if (!creative && this.inventory) this.inventory.removeFromSelected(1);
    this._play('place', { material: def.sound });
    return true;
  }

  _intersectsPlayer(x, y, z) {
    const a = this.player.getAABB();
    const e = 1e-4;
    return a.minX < x + 1 - e && a.maxX > x + e && a.minY < y + 1 - e && a.maxY > y + e && a.minZ < z + 1 - e && a.maxZ > z + e;
  }

  // ---- pick block ------------------------------------------------------------------------------

  _pickBlock(creative) {
    const t = this.target;
    const inv = this.inventory;
    if (!t || !inv || !getItem(t.id)) return;
    const id = t.id;
    const slots = inv.slots;
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      if (slots[i] && slots[i].id === id) {
        inv.setSelected(i);
        return;
      }
    }
    if (creative) {
      if (typeof inv.pickBlock === 'function') {
        inv.pickBlock(id);
      } else {
        // Fallback for a minimal inventory: put a stack in the held slot or the first empty hotbar slot.
        let slot = slots[inv.selected] ? -1 : inv.selected;
        for (let i = 0; i < HOTBAR_SIZE && slot < 0; i++) if (!slots[i]) slot = i;
        if (slot < 0) slot = inv.selected;
        const stack = { id, count: (getItem(id) && getItem(id).maxStack) || 64 };
        if (typeof inv.setSlot === 'function') inv.setSlot(slot, stack);
        else slots[slot] = stack;
        inv.setSelected(slot);
        if (typeof inv.changed === 'function') inv.changed();
      }
      return;
    }
    // Survival: swap a stack of the block from storage into the held hotbar slot.
    for (let i = HOTBAR_SIZE; i < Math.min(INVENTORY_SIZE, slots.length); i++) {
      if (slots[i] && slots[i].id === id) {
        const held = slots[inv.selected];
        const found = slots[i];
        if (typeof inv.setSlot === 'function') {
          inv.setSlot(inv.selected, found);
          inv.setSlot(i, held);
        } else {
          slots[inv.selected] = found;
          slots[i] = held;
          if (typeof inv.changed === 'function') inv.changed();
        }
        return;
      }
    }
  }

  // ---- visuals ---------------------------------------------------------------------------------

  _buildMeshes() {
    const scene = this.renderer && this.renderer.scene;

    // Selection outline.
    const box = new THREE.BoxGeometry(1, 1, 1);
    const edges = new THREE.EdgesGeometry(box);
    box.dispose();
    this.highlight = new THREE.LineSegments(
      edges,
      new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.55, depthWrite: false }),
    );
    this.highlight.visible = false;
    this.highlight.renderOrder = 3;

    // Crack overlay: a box just larger than the block, textured with the current crack stage tile.
    let tex = this.renderer && this.renderer.atlasTexture;
    if (!tex) {
      tex = new THREE.CanvasTexture(Textures.createAtlas());
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.NearestFilter;
      tex.generateMipmaps = false;
      tex.colorSpace = THREE.SRGBColorSpace;
      this._ownTexture = tex;
    }
    const crackGeo = new THREE.BoxGeometry(1, 1, 1);
    this._crackBaseUV = Float32Array.from(crackGeo.attributes.uv.array);
    this.crack = new THREE.Mesh(
      crackGeo,
      new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        depthWrite: false,
        alphaTest: 0.02,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -4,
      }),
    );
    this.crack.visible = false;
    this.crack.renderOrder = 2;
    this._crackStage = -1;

    // Debris particles: one instanced mesh of tiny cubes tinted with the block colour.
    this._particleMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.particles = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), this._particleMat, MAX_PARTICLES);
    this.particles.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.particles.setColorAt(0, this._color.setRGB(1, 1, 1)); // allocates instanceColor
    this.particles.count = 0;
    this.particles.frustumCulled = false;

    if (scene) scene.add(this.highlight, this.crack, this.particles);
  }

  _updateHighlight() {
    const t = this.target;
    if (!t) {
      this.highlight.visible = false;
      return;
    }
    const s = SELECTION[t.id] || FULL_BOX;
    const pad = 0.004;
    this.highlight.position.set(t.x + (s[0] + s[3]) / 2, t.y + (s[1] + s[4]) / 2, t.z + (s[2] + s[5]) / 2);
    this.highlight.scale.set(s[3] - s[0] + pad, s[4] - s[1] + pad, s[5] - s[2] + pad);
    this.highlight.visible = true;
  }

  _updateCrack() {
    const br = this.breaking;
    if (!br || br.progress <= 0) {
      this.crack.visible = false;
      return;
    }
    const stage = Math.min(CRACK_TILES.length - 1, Math.floor(br.progress * CRACK_TILES.length));
    if (stage !== this._crackStage) this._setCrackStage(stage);
    const s = SELECTION[br.id] || FULL_BOX;
    const pad = 0.003;
    this.crack.position.set(br.x + (s[0] + s[3]) / 2, br.y + (s[1] + s[4]) / 2, br.z + (s[2] + s[5]) / 2);
    this.crack.scale.set(s[3] - s[0] + pad, s[4] - s[1] + pad, s[5] - s[2] + pad);
    this.crack.visible = true;
  }

  _setCrackStage(stage) {
    this._crackStage = stage;
    const uv = tileUV(CRACK_TILES[stage]);
    const attr = this.crack.geometry.attributes.uv;
    const base = this._crackBaseUV;
    const du = uv.u1 - uv.u0;
    const dv = uv.v1 - uv.v0;
    for (let i = 0; i < base.length; i += 2) {
      attr.array[i] = uv.u0 + base[i] * du;
      attr.array[i + 1] = uv.v0 + base[i + 1] * dv;
    }
    attr.needsUpdate = true;
  }

  // Particle colour: a random opaque texel of the block's face tile, so debris matches the texture.
  // Falls back to the block's average colour. Writes linear RGB into `out`.
  _particleColor(def, tile, out) {
    const px = this._atlasPixels;
    if (px && tile >= 0) {
      const col = tile % 16;
      const row = Math.floor(tile / 16);
      for (let tries = 0; tries < 8; tries++) {
        const tx = col * 16 + Math.floor(Math.random() * 16);
        const ty = row * 16 + Math.floor(Math.random() * 16);
        const i = (ty * 256 + tx) * 4;
        if (px[i + 3] > 128) return out.setRGB(px[i] / 255, px[i + 1] / 255, px[i + 2] / 255, THREE.SRGBColorSpace);
      }
    }
    try {
      out.setStyle(def.color || '#888888');
    } catch {
      out.set(0x888888);
    }
    return out;
  }

  // Burst of debris: from the hit face while digging (normal given), or from the whole cell on break.
  _spawnParticles(x, y, z, id, count, normal) {
    const def = getBlock(id);
    if (this._atlasPixels === undefined) {
      try {
        this._atlasPixels = typeof Textures.getAtlasPixels === 'function' ? Textures.getAtlasPixels() : null;
      } catch {
        this._atlasPixels = null;
      }
    }
    const tiles = def.textures || {};
    const base = this._color;
    for (let i = 0; i < count; i++) {
      const tile = normal && normal[1] > 0 ? tiles.top : normal && normal[1] < 0 ? tiles.bottom : tiles.side;
      this._particleColor(def, tile ?? -1, base);
      let px;
      let py;
      let pz;
      let vx;
      let vy;
      let vz;
      if (normal) {
        px = x + 0.5 + (normal[0] ? normal[0] * 0.53 : rand(-0.42, 0.42));
        py = y + 0.5 + (normal[1] ? normal[1] * 0.53 : rand(-0.42, 0.42));
        pz = z + 0.5 + (normal[2] ? normal[2] * 0.53 : rand(-0.42, 0.42));
        vx = normal[0] * rand(0.4, 1.2) + rand(-0.7, 0.7);
        vy = normal[1] * rand(0.3, 0.9) + rand(0.4, 1.4);
        vz = normal[2] * rand(0.4, 1.2) + rand(-0.7, 0.7);
      } else {
        px = x + rand(0.15, 0.85);
        py = y + rand(0.15, 0.85);
        pz = z + rand(0.15, 0.85);
        vx = (px - x - 0.5) * rand(2.5, 5);
        vy = rand(1.2, 3.5);
        vz = (pz - z - 0.5) * rand(2.5, 5);
      }
      const shade = rand(0.85, 1.05);
      const p = {
        x: px, y: py, z: pz, vx, vy, vz,
        life: rand(0.35, 0.9),
        size: rand(0.04, 0.085),
        r: Math.min(1, base.r * shade),
        g: Math.min(1, base.g * shade),
        b: Math.min(1, base.b * shade),
      };
      if (this._parts.length >= MAX_PARTICLES) this._parts.shift();
      this._parts.push(p);
    }
  }

  _updateParticles(dt) {
    const parts = this._parts;
    const mesh = this.particles;
    if (parts.length === 0) {
      mesh.count = 0;
      return;
    }
    const world = this.world;
    const solidAt = (x, y, z) => {
      const id = world.getBlock(Math.floor(x), Math.floor(y), Math.floor(z));
      return id !== 0 && !(id > 0 && (getBlock(id).solid === false));
    };
    let n = 0;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      p.life -= dt;
      if (p.life <= 0) continue;
      p.vy -= PARTICLE_GRAVITY * dt;
      const half = p.size / 2;
      const ny = p.y + p.vy * dt;
      if (solidAt(p.x, ny - half, p.z)) {
        p.vy = 0;
        p.vx *= 0.8;
        p.vz *= 0.8;
      } else p.y = ny;
      const nx = p.x + p.vx * dt;
      if (solidAt(nx, p.y - half + 0.01, p.z)) p.vx = 0;
      else p.x = nx;
      const nz = p.z + p.vz * dt;
      if (solidAt(p.x, p.y - half + 0.01, nz)) p.vz = 0;
      else p.z = nz;
      parts[n++] = p;
    }
    parts.length = n;
    const m = this._matrix;
    for (let i = 0; i < n; i++) {
      const p = parts[i];
      const s = p.size * Math.min(1, p.life / 0.15);
      m.makeScale(s, s, s);
      m.setPosition(p.x, p.y, p.z);
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, this._color.setRGB(p.r, p.g, p.b));
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    // Match the world's day/night tint (the renderer only dims its own materials).
    const daylight = this.renderer && Number.isFinite(this.renderer.daylight) ? this.renderer.daylight : 1;
    this._particleMat.color.setScalar(Math.max(0.18, Math.min(1, daylight)));
  }
}

function isPlaceable(id) {
  if (!(id > 0 && id < 256) || !BLOCKS[id]) return false;
  const item = getItem(id);
  return !item || item.isBlock !== false;
}
