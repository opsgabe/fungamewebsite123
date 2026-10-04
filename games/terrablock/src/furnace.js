// Furnace simulation. Each placed furnace is keyed by "x,y,z" and holds three stacks (input, fuel,
// output) plus its burn and cook timers. Pure logic (no DOM); main.js calls update(dt) every frame
// and the UI edits the stacks of the open furnace directly.

import { SMELTING, FUELS } from './crafting.js';
import { getItem, maxStackOf } from './items.js';

export const COOK_TIME = 8; // seconds to smelt one item
const COOL_RATE = 2; // unlit furnaces lose cooking progress twice as fast as they gained it

function cleanStack(s) {
  if (!s || typeof s !== 'object') return null;
  const id = s.id | 0;
  const count = Math.floor(s.count);
  if (!(count > 0) || getItem(id) === null) return null;
  return { id, count: Math.min(count, maxStackOf(id)) };
}

function newState() {
  return { input: null, fuel: null, output: null, burnTime: 0, burnMax: 0, progress: 0 };
}

// Output id the furnace would currently produce, or null when it can't smelt.
export function smeltTarget(f) {
  if (!f.input) return null;
  const out = SMELTING[f.input.id];
  if (out === undefined) return null;
  if (f.output && (f.output.id !== out || f.output.count >= maxStackOf(out))) return null;
  return out;
}

export class Furnaces {
  constructor() {
    this.map = new Map();
    this._listeners = new Set();
  }

  // State for the furnace at key "x,y,z" (created empty on first access).
  get(key) {
    key = String(key);
    let f = this.map.get(key);
    if (!f) {
      f = newState();
      this.map.set(key, f);
    }
    return f;
  }

  has(key) {
    return this.map.has(String(key));
  }

  isLit(key) {
    const f = this.map.get(String(key));
    return !!f && f.burnTime > 0;
  }

  get size() {
    return this.map.size;
  }

  // Advance every furnace. Large dt values (e.g. catching up) are handled exactly.
  update(dt) {
    if (!(dt > 0)) return;
    for (const [key, f] of this.map) {
      if (f.burnTime <= 0 && f.progress <= 0 && !(f.input && f.fuel)) continue; // idle
      if (this._step(f, dt)) this._emit(key, f);
    }
  }

  // Returns true when stacks changed (fuel consumed or an item smelted).
  _step(f, dt) {
    let t = dt;
    let changed = false;
    for (let guard = 0; t > 1e-9 && guard < 10000; guard++) {
      const target = smeltTarget(f);
      if (f.burnTime <= 0) {
        f.burnTime = 0;
        const burn = f.fuel ? FUELS[f.fuel.id] || 0 : 0;
        if (target !== null && burn > 0) {
          // Light up with one fuel item.
          f.fuel.count -= 1;
          if (f.fuel.count <= 0) f.fuel = null;
          f.burnTime = f.burnMax = burn;
          changed = true;
        } else {
          f.progress = Math.max(0, f.progress - COOL_RATE * t);
          break;
        }
      }
      if (target === null) {
        // Burning with nothing to cook: the flame just runs down.
        const s = Math.min(t, f.burnTime);
        f.burnTime -= s;
        f.progress = 0;
        t -= s;
        continue;
      }
      const s = Math.min(t, f.burnTime, COOK_TIME - f.progress);
      f.burnTime -= s;
      f.progress += s;
      t -= s;
      if (f.progress >= COOK_TIME - 1e-9) {
        f.progress = 0;
        if (f.output) f.output.count += 1;
        else f.output = { id: target, count: 1 };
        f.input.count -= 1;
        if (f.input.count <= 0) f.input = null;
        changed = true;
      }
    }
    if (f.burnTime < 1e-9) f.burnTime = 0;
    return changed;
  }

  // Forget the furnace at key and return its contents (non-empty stacks) so they can be given back.
  remove(key) {
    key = String(key);
    const f = this.map.get(key);
    if (!f) return [];
    this.map.delete(key);
    const items = [f.input, f.fuel, f.output].filter((s) => s && s.count > 0).map((s) => ({ id: s.id, count: s.count }));
    this._emit(key, null);
    return items;
  }

  clear() {
    this.map.clear();
  }

  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  // Notify listeners after editing a furnace's stacks directly (the UI does this).
  changed(key) {
    this._emit(String(key), this.map.get(String(key)) || null);
  }

  _emit(key, f) {
    for (const fn of this._listeners) {
      try {
        fn(key, f);
      } catch (e) {
        console.error('Furnace listener failed', e);
      }
    }
  }

  toJSON() {
    const out = {};
    for (const [key, f] of this.map) {
      if (!f.input && !f.fuel && !f.output && f.burnTime <= 0) continue; // empty furnaces need no save
      out[key] = {
        input: f.input && { id: f.input.id, count: f.input.count },
        fuel: f.fuel && { id: f.fuel.id, count: f.fuel.count },
        output: f.output && { id: f.output.id, count: f.output.count },
        burnTime: Math.round(f.burnTime * 100) / 100,
        burnMax: Math.round(f.burnMax * 100) / 100,
        progress: Math.round(f.progress * 100) / 100,
      };
    }
    return out;
  }

  static fromJSON(obj) {
    const fs = new Furnaces();
    if (!obj || typeof obj !== 'object') return fs;
    for (const [key, s] of Object.entries(obj)) {
      if (!s || typeof s !== 'object') continue;
      const f = newState();
      f.input = cleanStack(s.input);
      f.fuel = cleanStack(s.fuel);
      f.output = cleanStack(s.output);
      f.burnTime = Math.max(0, +s.burnTime || 0);
      f.burnMax = Math.max(f.burnTime, +s.burnMax || 0);
      f.progress = Math.min(COOK_TIME, Math.max(0, +s.progress || 0));
      fs.map.set(key, f);
    }
    return fs;
  }
}
