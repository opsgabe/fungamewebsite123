// Terrablock first-person player: keyboard + pointer-lock mouse input, AABB-vs-voxel physics,
// jumping, sprinting, sneaking (with edge protection), creative flight, swimming, fall tracking,
// footstep sounds and the camera.
//
// `position` is the centre of the feet. The collision box is PLAYER_WIDTH x PLAYER_HEIGHT x PLAYER_WIDTH
// and is moved with a swept test per axis (Y, then X, then Z) against full voxel cells, so it can never
// tunnel through blocks or slip between two diagonally touching blocks. There is no automatic step-up:
// a 1-block ledge needs a jump. Cells in chunks that are not loaded yet count as solid.
//
// Test hooks (also handy for touch controls): applyLook(dx, dy) applies a mouse delta in pixels, and
// setKey(code, down) presses / releases a KeyboardEvent.code without a real key event.

import * as THREE from '../vendor/three.module.min.js';
import {
  PLAYER_WIDTH,
  PLAYER_HEIGHT,
  PLAYER_EYE,
  PLAYER_SNEAK_EYE,
  GRAVITY,
  JUMP_VELOCITY,
  WALK_SPEED,
  SPRINT_SPEED,
  SNEAK_SPEED,
  FLY_SPEED,
  WORLD_HEIGHT,
} from './config.js';
import { B, SOLID, LIQUID, getBlock } from './blocks.js';

const HALF_W = PLAYER_WIDTH / 2;
const EPS = 1e-6; // face-contact tolerance for the swept tests
const MAX_SUBSTEP = 1 / 90; // s; physics substep so results don't depend on frame rate
const TERMINAL_VELOCITY = 60; // blocks/s
const DOUBLE_TAP_MS = 300;
const LOOK_RADIANS_PER_PIXEL = 0.0024; // at sensitivity 1
const MAX_LOOK_DELTA = 400; // px; Chrome occasionally reports huge spurious movementX/Y jumps
const PITCH_LIMIT = Math.PI / 2 - 0.001;

const FLY_SPRINT_MULT = 1.75;
const FLY_VERTICAL_SPEED = 8;
const SWIM_SPEED = WALK_SPEED * 0.5;
const SWIM_UP_SPEED = 3.4;
const SWIM_SINK_SPEED = -1.6;
const SWIM_DIVE_SPEED = -4;
const WATER_CLIMB_SPEED = 5.6; // boost when pushing against a wall while swimming up (climb out of water)
// Climbing out onto a bank one block above the water's top block needs a full jump: leaving the water at the
// top of that block, JUMP_VELOCITY rises a further ~1.27 blocks, enough to clear the bank's edge.
const WATER_EXIT_SPEED = JUMP_VELOCITY;
const WATER_EXIT_PROBE = 0.25; // how far into the bank the clearance test looks
const SPRINT_JUMP_BOOST = 1.4; // extra forward speed on a sprint jump
const ACCEL_GROUND = 16; // 1/s, how quickly velocity reaches the target on ground
const ACCEL_ICE = 1.6;
const ACCEL_AIR = 3.2;
const DRAG_AIR = 0.9; // no input in the air: keep most momentum
const ACCEL_WATER = 6;
const ACCEL_FLY = 6;
const STRIDE = 1.85; // blocks walked per footstep sound
const SWIM_STROKE = 2.4; // blocks swum per swim sound
const SPRINT_FOV_MULT = 1.12;
const BOB_AMPLITUDE = 0.045;

// Body slice used for the "in water" test: water must overlap [feet + 0.4, head - 0.4], which floats the
// player with the eyes above the surface and treats 1-deep water as swimmable (like the original).
const WATER_BODY_BOTTOM = 0.4;
const WATER_BODY_TOP = PLAYER_HEIGHT - 0.4;

const MOVE_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Space', 'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight',
]);

function isTypingTarget(el) {
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class Player {
  constructor({ world, camera, domElement = null, settings = null, sounds = null } = {}) {
    this.world = world;
    this.camera = camera || null;
    this.domElement = domElement;
    this.settings = settings || {};
    this.sounds = sounds;

    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.yaw = 0; // radians; 0 looks towards -z, positive turns left
    this.pitch = 0; // radians; positive looks up
    this.mode = 'survival';
    this.flying = false;
    this.sneaking = false;
    this.sprinting = false;
    this.onGround = false;
    this.fallDistance = 0;
    this.eyeHeight = PLAYER_EYE; // smoothed between standing and sneaking eye heights

    // Hooks set by main.js (all optional).
    this.onFall = null; // (distance) => {}  called on landing (not in creative / water / flight)
    this.onJump = null; // () => {}          called when a jump starts (hunger exhaustion)
    this.canSprint = null; // () => bool      e.g. () => survival.canSprint

    this.keys = new Set();
    this._enabled = true;
    this._in = { forward: false, back: false, left: false, right: false, jump: false, sneak: false, sprint: false };
    this._sprintTap = false;
    this._lastWTap = -1e9;
    this._lastSpaceTap = -1e9;
    this._inWater = false;
    this._collidedH = false;
    this._hitX = 0; // sign of the last horizontal move blocked along x / z (0 = not blocked)
    this._hitZ = 0;
    this._frozen = false;
    this._stepDist = STRIDE * 0.6;
    this._swimDist = 0;
    this._bobPhase = 0;
    this._bobAmp = 0;
    this._fovMult = 1;
    this._lastFovSet = NaN;
    this._fovBase = null;
    this._lastSettingsFov = undefined;

    // Scratch state for the collision code (no per-frame allocations).
    this._box = new Float64Array(6); // minX, minY, minZ, maxX, maxY, maxZ
    this._cell = new Int32Array(3);
    this._edgeDx = 0;
    this._edgeDz = 0;

    if (this.camera) this.camera.rotation.order = 'YXZ';

    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._onBlur = () => this._releaseAll();
    this._onMouseMove = this._onMouseMove.bind(this);
    this._onContextMenu = (e) => e.preventDefault();
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', this._onKeyDown);
      window.addEventListener('keyup', this._onKeyUp);
      window.addEventListener('blur', this._onBlur);
      document.addEventListener('mousemove', this._onMouseMove);
      if (this.domElement) this.domElement.addEventListener('contextmenu', this._onContextMenu);
    }
  }

  // ---- public API ------------------------------------------------------------------------------

  get enabled() {
    return this._enabled;
  }

  // Disabling stops movement (see _readInput) but keeps tracking which keys are physically held, so a key
  // still held when input comes back (Shift while sneaking at a ledge, W) applies again at once. Modifier
  // keys don't auto-repeat on every platform, so they would otherwise stay lost until pressed again.
  set enabled(v) {
    v = !!v;
    if (v === this._enabled) return;
    this._enabled = v;
    if (!v) {
      this._sprintTap = false;
      this.sprinting = false;
    }
  }

  setMode(mode) {
    this.mode = mode === 'creative' ? 'creative' : 'survival';
    if (this.mode !== 'creative') this.flying = false;
  }

  setSettings(settings) {
    this.settings = settings || {};
  }

  teleport(x, y, z) {
    this.position.set(x, y, z);
    this.velocity.set(0, 0, 0);
    this.fallDistance = 0;
    this.onGround = false;
    this._inWater = false;
    this._stepDist = STRIDE * 0.6;
    this._updateCamera(0);
  }

  // Requests pointer lock on domElement (call from a click or key handler). Safe if unsupported / rejected.
  // Returns a Promise<boolean> (lock granted or not) in browsers whose requestPointerLock returns a promise,
  // otherwise null (the caller then relies on pointerlockchange / pointerlockerror events).
  requestPointerLock() {
    const el = this.domElement;
    if (!el || !el.requestPointerLock) return null;
    const plain = () => {
      try {
        const q = el.requestPointerLock();
        return q && typeof q.then === 'function' ? q.then(() => true, () => false) : null;
      } catch {
        return Promise.resolve(false);
      }
    };
    if (rawMouseSupported === false) return plain();
    let p;
    try {
      p = el.requestPointerLock({ unadjustedMovement: true });
    } catch {
      rawMouseSupported = false;
      return plain();
    }
    if (!p || typeof p.then !== 'function') return null;
    return p.then(
      () => {
        rawMouseSupported = true;
        return true;
      },
      (err) => {
        // unadjustedMovement is not supported everywhere: remember that and retry plainly.
        if (err && err.name === 'NotSupportedError') {
          rawMouseSupported = false;
          return plain() || false;
        }
        return false;
      },
    );
  }

  // Applies a mouse movement in pixels (pointer-lock movementX/Y). Public so tests and touch controls
  // can drive the camera without pointer lock.
  applyLook(dx, dy) {
    dx = clampNum(dx, -MAX_LOOK_DELTA, MAX_LOOK_DELTA);
    dy = clampNum(dy, -MAX_LOOK_DELTA, MAX_LOOK_DELTA);
    const s = LOOK_RADIANS_PER_PIXEL * this._sensitivity();
    this.yaw -= dx * s;
    this.pitch -= (this.settings.invertY ? -dy : dy) * s;
    if (this.pitch > PITCH_LIMIT) this.pitch = PITCH_LIMIT;
    if (this.pitch < -PITCH_LIMIT) this.pitch = -PITCH_LIMIT;
    // Keep yaw in (-PI, PI] so saved values stay small.
    if (this.yaw > Math.PI || this.yaw <= -Math.PI) this.yaw -= Math.round(this.yaw / (2 * Math.PI)) * 2 * Math.PI;
  }

  // Press / release a key by KeyboardEvent.code (test hook; behaves like a real key event: the key is
  // tracked while input is disabled, but only acts once input is enabled).
  setKey(code, down) {
    if (down) {
      if (this._enabled && !this.keys.has(code)) this._keyPressed(code);
      this.keys.add(code);
    } else {
      this.keys.delete(code);
    }
  }

  update(dt) {
    if (!(dt > 0)) {
      this._updateCamera(0);
      return;
    }
    dt = Math.min(dt, 0.1);
    this._readInput();

    // Hold still while the chunk around the player has not streamed in yet (prevents drifting into
    // the void or getting stuck after a teleport).
    const fy = Math.min(WORLD_HEIGHT - 1, Math.max(0, Math.floor(this.position.y)));
    this._frozen = this.world.getBlock(Math.floor(this.position.x), fy, Math.floor(this.position.z)) < 0;
    if (this._frozen) {
      this.velocity.set(0, 0, 0);
      this.fallDistance = 0;
    } else {
      this._unstuck();
      const n = Math.max(1, Math.ceil(dt / MAX_SUBSTEP - 1e-9));
      const h = dt / n;
      for (let i = 0; i < n; i++) this._step(h);
    }
    this._afterStep();
    this._updateCamera(dt);
  }

  getEyePosition(target = new THREE.Vector3()) {
    return target.set(this.position.x, this.position.y + this.eyeHeight, this.position.z);
  }

  getLookDirection(target = new THREE.Vector3()) {
    const cp = Math.cos(this.pitch);
    return target.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
  }

  // True when water overlaps the middle of the body (swimming physics apply).
  isInWater() {
    this._syncBox();
    return this._computeInWater();
  }

  // True when the eyes are below the water surface (underwater fog, drowning).
  isHeadInWater() {
    const ex = this.position.x;
    const ey = this.position.y + this.eyeHeight;
    const ez = this.position.z;
    const bx = Math.floor(ex);
    const by = Math.floor(ey);
    const bz = Math.floor(ez);
    const id = this.world.getBlock(bx, by, bz);
    if (id < 0 || !LIQUID[id]) return false;
    // The water surface is drawn at 7/8 of the block when nothing but air is above it.
    const above = this.world.getBlock(bx, by + 1, bz);
    if (above >= 0 && LIQUID[above]) return true;
    return ey - by < 0.875;
  }

  getAABB() {
    const p = this.position;
    return {
      minX: p.x - HALF_W,
      minY: p.y,
      minZ: p.z - HALF_W,
      maxX: p.x + HALF_W,
      maxY: p.y + PLAYER_HEIGHT,
      maxZ: p.z + HALF_W,
    };
  }

  // Convenience for mobs: push the player (blocks/s) and pop them slightly into the air.
  knockback(dirX, dirZ, strength = 6, lift = 5) {
    const len = Math.hypot(dirX, dirZ) || 1;
    this.velocity.x += (dirX / len) * strength;
    this.velocity.z += (dirZ / len) * strength;
    if (!this.flying) {
      this.velocity.y = Math.max(this.velocity.y, lift);
      this.onGround = false;
    }
  }

  toJSON() {
    const r = (v) => Math.round(v * 1000) / 1000;
    return {
      x: r(this.position.x),
      y: r(this.position.y),
      z: r(this.position.z),
      yaw: r(this.yaw),
      pitch: r(this.pitch),
      flying: this.flying,
    };
  }

  fromJSON(obj) {
    if (!obj || typeof obj !== 'object') return;
    const src = Array.isArray(obj.position) ? { x: obj.position[0], y: obj.position[1], z: obj.position[2] } : obj.position || obj;
    const x = Number(src.x);
    const y = Number(src.y);
    const z = Number(src.z);
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) this.teleport(x, y, z);
    if (Number.isFinite(obj.yaw)) this.yaw = obj.yaw;
    if (Number.isFinite(obj.pitch)) this.pitch = clampNum(obj.pitch, -PITCH_LIMIT, PITCH_LIMIT);
    // Kept regardless of the current mode so setMode('creative') may come before or after this call;
    // update() clears it again in survival.
    this.flying = !!obj.flying;
    this._updateCamera(0);
  }

  dispose() {
    if (typeof window === 'undefined') return;
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
    document.removeEventListener('mousemove', this._onMouseMove);
    if (this.domElement) this.domElement.removeEventListener('contextmenu', this._onContextMenu);
  }

  // ---- input -----------------------------------------------------------------------------------

  _onKeyDown(e) {
    if (!MOVE_KEYS.has(e.code) || isTypingTarget(e.target)) return;
    // While disabled (a UI screen or menu is open) the key is only tracked: the UI owns the event.
    if (this._enabled) {
      // Stop the page from scrolling, and block browser shortcuts while Ctrl-sprinting where possible.
      if (e.code === 'Space' || e.code.startsWith('Arrow') || (e.ctrlKey && e.code.startsWith('Key'))) e.preventDefault();
      // e.timeStamp is when the key actually went down, so a slow frame between two taps doesn't stretch
      // the measured interval past the double-tap window.
      if (!e.repeat && !this.keys.has(e.code)) this._keyPressed(e.code, e.timeStamp > 0 ? e.timeStamp : nowMs());
    }
    this.keys.add(e.code);
  }

  _onKeyUp(e) {
    this.keys.delete(e.code);
  }

  // Edge-triggered key actions: double-tap W sprints, double-tap Space toggles flight in creative.
  _keyPressed(code, t = nowMs()) {
    if (code === 'KeyW' || code === 'ArrowUp') {
      if (t - this._lastWTap < DOUBLE_TAP_MS) this._sprintTap = true;
      this._lastWTap = t;
    } else if (code === 'Space') {
      if (this.mode === 'creative' && t - this._lastSpaceTap < DOUBLE_TAP_MS) {
        this.flying = !this.flying;
        if (this.flying) this.velocity.y = Math.max(this.velocity.y, 0);
        this._lastSpaceTap = -1e9;
      } else {
        this._lastSpaceTap = t;
      }
    }
  }

  _onMouseMove(e) {
    if (!this._enabled || !document.pointerLockElement) return;
    this.applyLook(e.movementX || 0, e.movementY || 0);
  }

  _releaseAll() {
    this.keys.clear();
    this._sprintTap = false;
    this.sprinting = false;
  }

  _readInput() {
    const k = this.keys;
    const on = this._enabled;
    const inp = this._in;
    inp.forward = on && (k.has('KeyW') || k.has('ArrowUp'));
    inp.back = on && (k.has('KeyS') || k.has('ArrowDown'));
    inp.left = on && (k.has('KeyA') || k.has('ArrowLeft'));
    inp.right = on && (k.has('KeyD') || k.has('ArrowRight'));
    inp.jump = on && k.has('Space');
    inp.sneak = on && (k.has('ShiftLeft') || k.has('ShiftRight'));
    inp.sprint = on && (k.has('ControlLeft') || k.has('ControlRight'));

    if (this.mode !== 'creative') this.flying = false;
    this.sneaking = inp.sneak && !this.flying;

    // Sprint: Ctrl or double-tap W while moving forward; stops when forward is released, when sneaking,
    // when swimming, or when hunger (canSprint hook) forbids it.
    const forward = inp.forward && !inp.back;
    const allowed = !this.canSprint || this.canSprint() !== false;
    if (!forward || this.sneaking || (this._inWater && !this.flying) || !allowed) {
      this.sprinting = false;
      if (!forward) this._sprintTap = false;
    } else if (inp.sprint || this._sprintTap) {
      this.sprinting = true;
    }
  }

  _sensitivity() {
    let s = Number(this.settings.sensitivity);
    if (!Number.isFinite(s) || s <= 0) return 1;
    if (s > 10) s /= 100; // a percentage slider (e.g. 100 = default)
    return s;
  }

  // ---- physics ---------------------------------------------------------------------------------

  _syncBox() {
    const p = this.position;
    const b = this._box;
    b[0] = p.x - HALF_W;
    b[1] = p.y;
    b[2] = p.z - HALF_W;
    b[3] = p.x + HALF_W;
    b[4] = p.y + PLAYER_HEIGHT;
    b[5] = p.z + HALF_W;
  }

  // Does this cell stop the player? Unloaded chunks (id < 0) are solid; open sky above the world isn't.
  _blocks(x, y, z) {
    if (y >= WORLD_HEIGHT) return false;
    const id = this.world.getBlock(x, y, z);
    return id < 0 || SOLID[id] === 1;
  }

  // Any blocking cell in the layer `c[axis]` across the box's footprint on the two other axes?
  _layerBlocked(axis, i, a1, s1, e1, a2, s2, e2) {
    const c = this._cell;
    c[axis] = i;
    for (let u = s1; u <= e1; u++) {
      c[a1] = u;
      for (let v = s2; v <= e2; v++) {
        c[a2] = v;
        if (this._blocks(c[0], c[1], c[2])) return true;
      }
    }
    return false;
  }

  // Swept move of the box along one axis (0 x, 1 y, 2 z) by d. Walks the cell layers the leading face
  // passes through and stops at the first blocking one. Cells the box already overlaps are ignored, so
  // a player stuck inside a block can always walk out. Returns the allowed displacement.
  _sweep(axis, d) {
    if (d === 0) return 0;
    const b = this._box;
    const a1 = (axis + 1) % 3;
    const a2 = (axis + 2) % 3;
    const s1 = Math.floor(b[a1] + EPS);
    const e1 = Math.floor(b[a1 + 3] - EPS);
    const s2 = Math.floor(b[a2] + EPS);
    const e2 = Math.floor(b[a2 + 3] - EPS);
    if (d > 0) {
      const face = b[axis + 3];
      const last = Math.floor(face + d - EPS);
      for (let i = Math.floor(face - EPS) + 1; i <= last; i++) {
        if (this._layerBlocked(axis, i, a1, s1, e1, a2, s2, e2)) return Math.min(d, i - face);
      }
    } else {
      const face = b[axis];
      const last = Math.floor(face + d + EPS);
      for (let i = Math.floor(face + EPS) - 1; i >= last; i--) {
        if (this._layerBlocked(axis, i, a1, s1, e1, a2, s2, e2)) return Math.max(d, i + 1 - face);
      }
    }
    return d;
  }

  _moveBox(axis, d) {
    this._box[axis] += d;
    this._box[axis + 3] += d;
  }

  // Is there a solid block directly under the box when shifted horizontally by (ox, oz)?
  _hasSupport(ox, oz) {
    const b = this._box;
    const y = Math.floor(b[1] - 0.05);
    const x0 = Math.floor(b[0] + ox + EPS);
    const x1 = Math.floor(b[3] + ox - EPS);
    const z0 = Math.floor(b[2] + oz + EPS);
    const z1 = Math.floor(b[5] + oz - EPS);
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) if (this._blocks(x, y, z)) return true;
    return false;
  }

  // Sneak edge protection (as in the original): shrink the horizontal move in 0.05 steps until the
  // box would still have a block under it.
  _edgeClamp(dx, dz) {
    const STEP = 0.05;
    const shrink = (v) => (Math.abs(v) <= STEP ? 0 : v - Math.sign(v) * STEP);
    while (dx !== 0 && !this._hasSupport(dx, 0)) dx = shrink(dx);
    while (dz !== 0 && !this._hasSupport(0, dz)) dz = shrink(dz);
    while (dx !== 0 && dz !== 0 && !this._hasSupport(dx, dz)) {
      dx = shrink(dx);
      dz = shrink(dz);
    }
    this._edgeDx = dx;
    this._edgeDz = dz;
  }

  // Does the box (as currently synced) overlap a solid, loaded cell?
  _overlapsSolid() {
    const b = this._box;
    const x0 = Math.floor(b[0] + EPS);
    const x1 = Math.floor(b[3] - EPS);
    const z0 = Math.floor(b[2] + EPS);
    const z1 = Math.floor(b[5] - EPS);
    const y0 = Math.floor(b[1] + EPS);
    const y1 = Math.min(WORLD_HEIGHT - 1, Math.floor(b[4] - EPS));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        for (let z = z0; z <= z1; z++) {
          const id = this.world.getBlock(x, y, z);
          if (id > 0 && SOLID[id] === 1) return true;
        }
      }
    }
    return false;
  }

  // If a block ended up inside the player (falling sand, a bad spawn), lift them onto the nearest free
  // spot up to 3 blocks higher. Without this the swept test would let them sink through that block.
  _unstuck() {
    this._syncBox();
    if (!this._overlapsSolid()) return;
    const y = this.position.y;
    for (let k = 1; k <= 3; k++) {
      this.position.y = Math.floor(y + EPS) + k;
      this._syncBox();
      if (!this._overlapsSolid()) {
        this.velocity.y = Math.max(0, this.velocity.y);
        this.fallDistance = 0;
        return;
      }
    }
    this.position.y = y; // buried: stay put (survival suffocation is not modelled)
  }

  _computeInWater() {
    const b = this._box;
    const x0 = Math.floor(b[0] + EPS);
    const x1 = Math.floor(b[3] - EPS);
    const z0 = Math.floor(b[2] + EPS);
    const z1 = Math.floor(b[5] - EPS);
    const y0 = Math.floor(b[1] + WATER_BODY_BOTTOM);
    const y1 = Math.floor(b[1] + WATER_BODY_TOP - EPS);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        for (let z = z0; z <= z1; z++) {
          const id = this.world.getBlock(x, y, z);
          if (id > 0 && LIQUID[id]) return true;
        }
      }
    }
    return false;
  }

  // Is any cell of the box's footprint at height y water?
  _footprintHasWater(y) {
    const b = this._box;
    const x0 = Math.floor(b[0] + EPS);
    const x1 = Math.floor(b[3] - EPS);
    const z0 = Math.floor(b[2] + EPS);
    const z1 = Math.floor(b[5] - EPS);
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        const id = this.world.getBlock(x, y, z);
        if (id > 0 && LIQUID[id]) return true;
      }
    }
    return false;
  }

  // Would the box, with its feet at y and shifted horizontally by (ox, oz), overlap a blocking cell?
  _boxBlockedAt(ox, y, oz) {
    const b = this._box;
    const x0 = Math.floor(b[0] + ox + EPS);
    const x1 = Math.floor(b[3] + ox - EPS);
    const z0 = Math.floor(b[2] + oz + EPS);
    const z1 = Math.floor(b[5] + oz - EPS);
    const y0 = Math.floor(y + EPS);
    const y1 = Math.floor(y + PLAYER_HEIGHT - EPS);
    for (let yy = y0; yy <= y1; yy++) {
      for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) if (this._blocks(x, yy, z)) return true;
    }
    return false;
  }

  // Climbing out of water: the player floats with the feet in the top layer of water while pushing against a
  // bank (the last horizontal move was blocked). Returns the upward speed that carries them onto the bank
  // (level with the water's top block, or one block above it), or 0 when there is no bank to climb onto: a
  // taller wall, a ceiling overhead, or the feet deeper than the top layer of water.
  _waterExitSpeed() {
    const sx = this._hitX;
    const sz = this._hitZ;
    if (!sx && !sz) return 0;
    const fy = Math.floor(this._box[1] + EPS);
    if (!this._footprintHasWater(fy) || this._footprintHasWater(fy + 1)) return 0;
    const ox = sx * WATER_EXIT_PROBE;
    const oz = sz * WATER_EXIT_PROBE;
    for (let k = 1; k <= 2; k++) {
      const y = fy + k;
      if (this._boxBlockedAt(0, y, 0)) return 0; // no headroom to rise
      if (!this._boxBlockedAt(ox, y, oz)) return k === 1 ? WATER_CLIMB_SPEED : WATER_EXIT_SPEED;
    }
    return 0;
  }

  // Block id the player stands on (centre first, then the footprint corners), or -1.
  _groundBlock() {
    const p = this.position;
    const y = Math.floor(p.y - 0.05);
    let id = this.world.getBlock(Math.floor(p.x), y, Math.floor(p.z));
    if (id > 0 && SOLID[id]) return id;
    for (const [ox, oz] of CORNERS) {
      id = this.world.getBlock(Math.floor(p.x + ox), y, Math.floor(p.z + oz));
      if (id > 0 && SOLID[id]) return id;
    }
    return -1;
  }

  _step(h) {
    const v = this.velocity;
    const inp = this._in;
    this._syncBox();
    const inWater = this._computeInWater();
    if (inWater && !this._inWater && !this.flying && v.y < -2) {
      this._sound('splash', { volume: Math.min(1, 0.25 - v.y / 16) });
    }
    this._inWater = inWater;

    // Desired horizontal direction from WASD relative to the view yaw.
    const fwd = (inp.forward ? 1 : 0) - (inp.back ? 1 : 0);
    const strafe = (inp.right ? 1 : 0) - (inp.left ? 1 : 0);
    const sinY = Math.sin(this.yaw);
    const cosY = Math.cos(this.yaw);
    let wx = -sinY * fwd + cosY * strafe;
    let wz = -cosY * fwd - sinY * strafe;
    const wl = Math.hypot(wx, wz);
    const hasWish = wl > 0;
    if (hasWish) {
      wx /= wl;
      wz /= wl;
    }

    let speed;
    let accel;
    if (this.flying) {
      speed = FLY_SPEED * (this.sprinting ? FLY_SPRINT_MULT : 1);
      accel = ACCEL_FLY;
    } else if (inWater) {
      speed = SWIM_SPEED;
      accel = ACCEL_WATER;
    } else {
      speed = this.sneaking ? SNEAK_SPEED : this.sprinting ? SPRINT_SPEED : WALK_SPEED;
      if (this.onGround) accel = this._groundBlock() === B.ICE ? ACCEL_ICE : ACCEL_GROUND;
      else accel = hasWish ? ACCEL_AIR : DRAG_AIR;
    }
    const a = 1 - Math.exp(-accel * h);
    v.x += (wx * speed - v.x) * a;
    v.z += (wz * speed - v.z) * a;

    // Vertical motion.
    if (this.flying) {
      const target = ((inp.jump ? 1 : 0) - (inp.sneak ? 1 : 0)) * FLY_VERTICAL_SPEED * (this.sprinting ? 1.25 : 1);
      v.y += (target - v.y) * (1 - Math.exp(-10 * h));
    } else if (inWater) {
      const target = inp.jump ? SWIM_UP_SPEED : inp.sneak ? SWIM_DIVE_SPEED : SWIM_SINK_SPEED;
      v.y += (target - v.y) * (1 - Math.exp(-5 * h));
      if (inp.jump && this._collidedH) v.y = Math.max(v.y, WATER_CLIMB_SPEED, this._waterExitSpeed());
    } else if (inp.jump && !this.onGround && this._collidedH) {
      // Floating at the surface (the body is above the swim slice, the feet still in water) against a bank:
      // climb out onto it.
      const boost = this._waterExitSpeed();
      if (boost > v.y) v.y = boost;
    } else if (inp.jump && this.onGround) {
      v.y = JUMP_VELOCITY;
      this.onGround = false;
      if (this.sprinting) {
        v.x -= sinY * SPRINT_JUMP_BOOST;
        v.z -= cosY * SPRINT_JUMP_BOOST;
      }
      if (this.onJump) this.onJump();
    }
    const vy0 = v.y;
    if (!this.flying && !inWater) {
      v.y = Math.max(-TERMINAL_VELOCITY, v.y - GRAVITY * h);
    }

    // Displacement (average velocity integrates constant gravity exactly).
    let dx = v.x * h;
    const dy = (vy0 + v.y) * 0.5 * h;
    let dz = v.z * h;
    if (this.sneaking && this.onGround && !this.flying && !inWater) {
      this._edgeClamp(dx, dz);
      if (this._edgeDx !== dx) v.x = 0;
      if (this._edgeDz !== dz) v.z = 0;
      dx = this._edgeDx;
      dz = this._edgeDz;
    }

    const wasOnGround = this.onGround;
    const ry = this._sweep(1, dy);
    this._moveBox(1, ry);
    if (ry !== dy) {
      if (dy < 0) this.onGround = true;
      v.y = 0;
    } else if (dy !== 0) {
      this.onGround = false;
    }
    const rx = this._sweep(0, dx);
    this._moveBox(0, rx);
    if (rx !== dx) v.x = 0;
    const rz = this._sweep(2, dz);
    this._moveBox(2, rz);
    if (rz !== dz) v.z = 0;
    this._collidedH = rx !== dx || rz !== dz;
    this._hitX = rx !== dx ? Math.sign(dx) : 0;
    this._hitZ = rz !== dz ? Math.sign(dz) : 0;

    this.position.x += rx;
    this.position.y += ry;
    this.position.z += rz;

    // Landing ends creative flight, like the original.
    if (this.flying && this.onGround && dy < 0 && ry !== dy) this.flying = false;

    // Fall distance: accumulate downward travel; water and flight cancel it.
    if (this.flying || inWater) this.fallDistance = 0;
    else if (ry < 0) this.fallDistance -= ry;
    if (this.onGround && !wasOnGround) this._land(inWater);
    if (this.onGround) this.fallDistance = 0;

    // Footsteps and swim strokes.
    const moved = Math.hypot(rx, rz);
    if (this.onGround && !inWater && !this.flying) {
      this._stepDist += moved;
      if (this._stepDist >= STRIDE) {
        this._stepDist = 0;
        this._playStep(this.sneaking ? 0.2 : 0.45);
      }
    } else if (inWater && !this.flying) {
      this._swimDist += moved + Math.abs(ry) * 0.5;
      if (this._swimDist >= SWIM_STROKE) {
        this._swimDist = 0;
        this._sound('swim', { volume: 0.3 });
      }
    }
  }

  _land(inWater) {
    // The distance is a sum of many substep moves; round off the float noise so a drop of exactly N blocks
    // reports N (otherwise ceil(distance - 3) turns 3.0000000000000386 into a whole half-heart of damage).
    const d = Math.round(this.fallDistance * 1e4) / 1e4;
    this.fallDistance = 0;
    this._stepDist = 0;
    if (d <= 0 || inWater) return;
    if (d > 0.7) this._playStep(Math.min(0.9, 0.25 + d * 0.08));
    if (!this.flying && this.mode !== 'creative' && this.onFall) this.onFall(d);
  }

  _afterStep() {
    // Running into a wall ends a sprint.
    if (this.sprinting && this._collidedH && this.onGround && Math.hypot(this.velocity.x, this.velocity.z) < 0.5) {
      this.sprinting = false;
      this._sprintTap = false;
    }
  }

  _playStep(volume) {
    const id = this._groundBlock();
    if (id <= 0) return;
    this._sound('step', { material: getBlock(id).sound, volume });
  }

  _sound(name, opts) {
    if (this.sounds && this.sounds.play) this.sounds.play(name, opts);
  }

  // ---- camera ----------------------------------------------------------------------------------

  _updateCamera(dt) {
    const k = dt > 0 ? 1 - Math.exp(-14 * dt) : 1;
    const targetEye = this.sneaking ? PLAYER_SNEAK_EYE : PLAYER_EYE;
    this.eyeHeight += (targetEye - this.eyeHeight) * k;

    // Gentle view bobbing while walking on the ground (camera only; never affects aiming).
    const hs = Math.hypot(this.velocity.x, this.velocity.z);
    const walking = this.onGround && !this.flying && !this._inWater && hs > 0.3;
    const bobTarget = walking ? Math.min(1, hs / WALK_SPEED) : 0;
    if (dt > 0) {
      this._bobAmp += (bobTarget - this._bobAmp) * (1 - Math.exp(-8 * dt));
      if (walking) this._bobPhase += (hs * dt * Math.PI) / STRIDE;
    }

    const cam = this.camera;
    if (!cam) return;
    const amp = this._bobAmp * BOB_AMPLITUDE;
    const bobY = (Math.abs(Math.cos(this._bobPhase)) - 1) * amp;
    const bobSide = Math.sin(this._bobPhase) * amp * 0.6;
    cam.position.set(
      this.position.x + Math.cos(this.yaw) * bobSide,
      this.position.y + this.eyeHeight + bobY,
      this.position.z - Math.sin(this.yaw) * bobSide,
    );
    cam.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    this._updateFov(dt);
  }

  // Sprinting widens the FOV slightly. The base FOV follows settings.fov, or the camera's own FOV if
  // something else (renderer.setFov) changed it since our last write.
  _updateFov(dt) {
    const cam = this.camera;
    if (!cam || !cam.isPerspectiveCamera) return;
    const sf = Number(this.settings.fov);
    if (Number.isFinite(sf) && sf > 0 && sf !== this._lastSettingsFov) {
      this._lastSettingsFov = sf;
      this._fovBase = sf;
    } else if (this._fovBase === null || (Number.isFinite(this._lastFovSet) && Math.abs(cam.fov - this._lastFovSet) > 1e-6)) {
      this._fovBase = cam.fov;
    }
    const fast = this.sprinting && Math.hypot(this.velocity.x, this.velocity.z) > WALK_SPEED * 0.8;
    const target = fast ? SPRINT_FOV_MULT : 1;
    const k = dt > 0 ? 1 - Math.exp(-10 * dt) : 1;
    this._fovMult += (target - this._fovMult) * k;
    if (Math.abs(this._fovMult - target) < 1e-4) this._fovMult = target;
    const fov = this._fovBase * this._fovMult;
    if (Math.abs(cam.fov - fov) > 1e-6) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
    this._lastFovSet = cam.fov;
  }
}

const CORNERS = [
  [-HALF_W, -HALF_W],
  [HALF_W - 1e-4, -HALF_W],
  [-HALF_W, HALF_W - 1e-4],
  [HALF_W - 1e-4, HALF_W - 1e-4],
];

// Whether the browser accepts { unadjustedMovement } (raw mouse input) for pointer lock; null = unknown.
let rawMouseSupported = null;

function clampNum(v, lo, hi) {
  v = Number(v) || 0;
  return v < lo ? lo : v > hi ? hi : v;
}
