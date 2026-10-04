// Survival stats: health, hunger, saturation, exhaustion and air, plus regeneration, starvation and
// drowning. Pure logic (no DOM); main.js feeds it update(dt, flags) every frame.
//
// Units: health and hunger are half-icons (0..20), like the HUD. Air is seconds of breath (0..MAX_AIR).

import { getItem } from './items.js';

export const MAX_HEALTH = 20;
export const MAX_HUNGER = 20;
export const MAX_AIR = 15; // seconds of breath; the HUD shows 10 bubbles
export const START_SATURATION = 5;
export const SPRINT_MIN_HUNGER = 7; // sprinting needs more than three hunger icons

// Exhaustion: every 4 points costs one saturation point, or one hunger point once saturation is gone.
const EXHAUSTION_LIMIT = 4;
const EXHAUST_IDLE = 0.01; // per second, just for being alive
const EXHAUST_MOVE = 0.06; // per second while walking or swimming
const EXHAUST_SPRINT = 0.5; // per second while sprinting (about 0.09 per block)
const EXHAUST_HEAL = 3; // per half-heart regenerated
const EXHAUST_DAMAGE = 0.1; // per hit taken
const EXHAUST_JUMP = 0.05; // per jump, if the caller reports jumps

const FAST_REGEN_INTERVAL = 1; // s per half-heart at full hunger with saturation left
const SLOW_REGEN_INTERVAL = 4; // s per half-heart at hunger >= 18
const STARVE_INTERVAL = 4; // s per half-heart lost at zero hunger (stops at half a heart)
const DROWN_INTERVAL = 1; // s between drowning hits
const DROWN_DAMAGE = 2;
const AIR_REFILL_RATE = 4; // seconds of air regained per second above water
const INVULNERABLE_TIME = 0.5; // s of protection after a hit

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export class Survival {
  constructor(mode = 'survival') {
    this.mode = mode;
    this._deathFns = new Set();
    this._changeFns = new Set();
    this.reset();
  }

  reset() {
    this.health = MAX_HEALTH;
    this.hunger = MAX_HUNGER;
    this.saturation = START_SATURATION;
    this.exhaustion = 0;
    this.air = MAX_AIR;
    this.dead = false;
    this.lastDamageCause = null;
    this.deathCause = null;
    this.hurtTime = 0; // counts down after a hit (HUD flash, invulnerability)
    this._regenTimer = 0;
    this._starveTimer = 0;
    this._drownTimer = 0;
    this.headInWater = false;
    this._emit();
  }

  get isCreative() {
    return this.mode === 'creative';
  }

  get maxHealth() {
    return MAX_HEALTH;
  }

  get maxAir() {
    return MAX_AIR;
  }

  // Sprinting is only allowed with enough food (always in creative).
  get canSprint() {
    return this.isCreative || this.hunger >= SPRINT_MIN_HUNGER;
  }

  // Air bubbles for the HUD: 0..10.
  get airBubbles() {
    return clamp(Math.ceil((this.air / MAX_AIR) * 10 - 1e-6), 0, 10);
  }

  // Should the HUD show the air row?
  get showAir() {
    return !this.isCreative && (this.headInWater || this.air < MAX_AIR - 1e-6);
  }

  setMode(mode) {
    this.mode = mode;
    if (this.isCreative) {
      this.health = MAX_HEALTH;
      this.air = MAX_AIR;
    }
    this._emit();
  }

  // Apply damage in half-hearts. Returns true when it landed.
  damage(amount, cause = 'generic') {
    if (this.dead || this.isCreative) return false;
    amount = num(amount, 0);
    if (amount <= 0) return false;
    if (this.hurtTime > 0 && cause !== 'void') return false;
    this.health = Math.max(0, this.health - amount);
    this.lastDamageCause = cause;
    this.hurtTime = INVULNERABLE_TIME;
    this._exhaust(EXHAUST_DAMAGE);
    if (this.health <= 0) this._die(cause);
    this._emit();
    return true;
  }

  heal(n) {
    if (this.dead) return;
    n = num(n, 0);
    if (n <= 0 || this.health >= MAX_HEALTH) return;
    this.health = Math.min(MAX_HEALTH, this.health + n);
    this._emit();
  }

  // Eat a food item. Only works in survival while not full; returns true when eaten.
  eat(itemId) {
    if (this.dead || this.isCreative) return false;
    const item = getItem(itemId);
    if (!item || !item.food || this.hunger >= MAX_HUNGER) return false;
    this.hunger = Math.min(MAX_HUNGER, this.hunger + item.food.hunger);
    this.saturation = Math.min(this.hunger, this.saturation + item.food.saturation);
    this._emit();
    return true;
  }

  canEat(itemId) {
    const item = getItem(itemId);
    return !this.dead && !this.isCreative && !!item && !!item.food && this.hunger < MAX_HUNGER;
  }

  // Optional: report a jump for its small exhaustion cost.
  jumped() {
    if (!this.isCreative && !this.dead) this._exhaust(EXHAUST_JUMP);
  }

  update(dt, { sprinting = false, moving = false, headInWater = false, swimming = false } = {}) {
    if (this.dead) return;
    dt = clamp(num(dt, 0), 0, 1);
    if (dt === 0) return;
    const before = this._snapshot();
    this.headInWater = !!headInWater;
    if (this.hurtTime > 0) this.hurtTime = Math.max(0, this.hurtTime - dt);

    if (this.isCreative) {
      this.health = MAX_HEALTH;
      this.air = MAX_AIR;
      if (before !== this._snapshot()) this._emit();
      return;
    }

    // Food use.
    let rate = EXHAUST_IDLE;
    if (sprinting && moving) rate += EXHAUST_SPRINT;
    else if (moving || swimming) rate += EXHAUST_MOVE;
    this._exhaust(rate * dt);

    // Breath.
    if (headInWater) {
      if (this.air > 0) {
        this.air = Math.max(0, this.air - dt);
        this._drownTimer = 0;
      } else {
        this._drownTimer += dt;
        if (this._drownTimer >= DROWN_INTERVAL) {
          this._drownTimer -= DROWN_INTERVAL;
          this.hurtTime = 0; // drowning hits are already spaced out
          this.damage(DROWN_DAMAGE, 'drown');
          if (this.dead) return;
        }
      }
    } else {
      this._drownTimer = 0;
      if (this.air < MAX_AIR) this.air = Math.min(MAX_AIR, this.air + AIR_REFILL_RATE * dt);
    }

    // Regeneration / starvation.
    if (this.health < MAX_HEALTH && this.hunger >= 18) {
      const interval = this.hunger >= MAX_HUNGER && this.saturation > 0 ? FAST_REGEN_INTERVAL : SLOW_REGEN_INTERVAL;
      this._regenTimer += dt;
      if (this._regenTimer >= interval) {
        this._regenTimer = 0;
        this.health = Math.min(MAX_HEALTH, this.health + 1);
        this._exhaust(EXHAUST_HEAL);
      }
    } else {
      this._regenTimer = 0;
    }
    if (this.hunger <= 0) {
      this._starveTimer += dt;
      if (this._starveTimer >= STARVE_INTERVAL) {
        this._starveTimer = 0;
        if (this.health > 1) {
          this.hurtTime = 0;
          this.damage(1, 'starve');
        }
      }
    } else {
      this._starveTimer = 0;
    }

    if (before !== this._snapshot()) this._emit();
  }

  onDeath(fn) {
    this._deathFns.add(fn);
    return () => this._deathFns.delete(fn);
  }

  onChange(fn) {
    this._changeFns.add(fn);
    return () => this._changeFns.delete(fn);
  }

  toJSON() {
    return {
      health: this.health,
      hunger: this.hunger,
      saturation: Math.round(this.saturation * 100) / 100,
      exhaustion: Math.round(this.exhaustion * 1000) / 1000,
      air: Math.round(this.air * 100) / 100,
    };
  }

  static fromJSON(obj, mode = 'survival') {
    const s = new Survival(mode);
    if (obj && typeof obj === 'object') {
      s.health = clamp(num(obj.health, MAX_HEALTH), 0, MAX_HEALTH);
      s.hunger = clamp(Math.round(num(obj.hunger, MAX_HUNGER)), 0, MAX_HUNGER);
      s.saturation = clamp(num(obj.saturation, START_SATURATION), 0, s.hunger);
      s.exhaustion = clamp(num(obj.exhaustion, 0), 0, EXHAUSTION_LIMIT);
      s.air = clamp(num(obj.air, MAX_AIR), 0, MAX_AIR);
      // A save made at the moment of death would trap the player in a dead body; come back healthy.
      if (s.health <= 0) s.health = MAX_HEALTH;
    }
    if (s.isCreative) {
      s.health = MAX_HEALTH;
      s.air = MAX_AIR;
    }
    return s;
  }

  // ---- internals -------------------------------------------------------------------------

  _exhaust(x) {
    this.exhaustion += x;
    while (this.exhaustion >= EXHAUSTION_LIMIT) {
      this.exhaustion -= EXHAUSTION_LIMIT;
      if (this.saturation > 0) this.saturation = Math.max(0, this.saturation - 1);
      else if (this.hunger > 0) this.hunger -= 1;
    }
  }

  _die(cause) {
    if (this.dead) return;
    this.dead = true;
    this.deathCause = cause;
    this.health = 0;
    for (const fn of this._deathFns) {
      try {
        fn(cause);
      } catch (e) {
        console.error('Survival death listener failed', e);
      }
    }
  }

  // Cheap fingerprint of what the HUD shows, to fire onChange only on visible changes.
  _snapshot() {
    return this.health * 1e6 + this.hunger * 1e4 + this.airBubbles * 100 + (this.showAir ? 1 : 0) + (this.dead ? 2 : 0);
  }

  _emit() {
    for (const fn of this._changeFns) {
      try {
        fn(this);
      } catch (e) {
        console.error('Survival listener failed', e);
      }
    }
  }
}
