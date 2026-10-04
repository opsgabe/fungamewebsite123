// Player inventory: 36 slots of { id, count } | null. Slots 0..8 are the hotbar, 9..35 the storage grid.
// Pure logic (no DOM). Every mutation goes through emit() so listeners (HUD, autosave) hear about it;
// code that edits `slots` directly should call changed() afterwards.

import { HOTBAR_SIZE, INVENTORY_SIZE } from './config.js';
import { getItem, maxStackOf } from './items.js';

// Order used when adding items: merge into hotbar, then storage; fill empty hotbar slots before storage.
const ADD_ORDER = Array.from({ length: INVENTORY_SIZE }, (_, i) => i);
// Order used when removing by id: storage from the end first, then the hotbar from the right, so the
// stacks the player is holding are the last to go.
const REMOVE_ORDER = [
  ...Array.from({ length: INVENTORY_SIZE - HOTBAR_SIZE }, (_, i) => INVENTORY_SIZE - 1 - i),
  ...Array.from({ length: HOTBAR_SIZE }, (_, i) => HOTBAR_SIZE - 1 - i),
];

function validStack(s) {
  return !!s && Number.isInteger(s.id) && s.count > 0 && getItem(s.id) !== null;
}

export class Inventory {
  constructor() {
    this.slots = new Array(INVENTORY_SIZE).fill(null);
    this.selected = 0;
    this._listeners = new Set();
  }

  // ---- selection -------------------------------------------------------------------------

  getSelected() {
    return this.slots[this.selected] || null;
  }

  // Id of the held item, or 0 for an empty hand.
  getSelectedId() {
    const s = this.slots[this.selected];
    return s ? s.id : 0;
  }

  setSelected(i) {
    const n = ((Math.trunc(i) % HOTBAR_SIZE) + HOTBAR_SIZE) % HOTBAR_SIZE;
    if (n === this.selected) return;
    this.selected = n;
    this.emit();
  }

  // ---- slot access -----------------------------------------------------------------------

  getSlot(i) {
    return this.slots[i] || null;
  }

  // Replace a slot (null / count <= 0 clears it). The stack object is copied.
  setSlot(i, stack) {
    if (i < 0 || i >= INVENTORY_SIZE) return;
    this.slots[i] = stack && stack.count > 0 ? { id: stack.id, count: Math.min(stack.count, maxStackOf(stack.id)) } : null;
    this.emit();
  }

  // ---- adding / removing -----------------------------------------------------------------

  // Room for `id` across all slots (existing stacks + empty slots).
  spaceFor(id) {
    const max = maxStackOf(id);
    let space = 0;
    for (const s of this.slots) {
      if (!s) space += max;
      else if (s.id === id) space += Math.max(0, max - s.count);
    }
    return space;
  }

  canAdd(id, count = 1) {
    return this.spaceFor(id) >= count;
  }

  // Add items; returns the number that did not fit (0 when everything went in).
  add(id, count = 1) {
    count = Math.floor(count);
    if (!(count > 0) || getItem(id) === null) return Math.max(0, count | 0);
    const max = maxStackOf(id);
    let left = count;
    // 1) top up existing stacks.
    for (const i of ADD_ORDER) {
      const s = this.slots[i];
      if (s && s.id === id && s.count < max) {
        const n = Math.min(max - s.count, left);
        s.count += n;
        left -= n;
        if (left === 0) break;
      }
    }
    // 2) open new stacks in empty slots.
    if (left > 0) {
      for (const i of ADD_ORDER) {
        if (!this.slots[i]) {
          const n = Math.min(max, left);
          this.slots[i] = { id, count: n };
          left -= n;
          if (left === 0) break;
        }
      }
    }
    if (left !== count) this.emit();
    return left;
  }

  // Remove up to n items from the held stack; returns how many were removed.
  removeFromSelected(n = 1) {
    const s = this.slots[this.selected];
    if (!s || n <= 0) return 0;
    const k = Math.min(s.count, Math.floor(n));
    s.count -= k;
    if (s.count <= 0) this.slots[this.selected] = null;
    if (k > 0) this.emit();
    return k;
  }

  count(id) {
    let c = 0;
    for (const s of this.slots) if (s && s.id === id) c += s.count;
    return c;
  }

  // Remove up to n of `id` (storage first, held hotbar stacks last); returns how many were removed.
  remove(id, n = 1) {
    let left = Math.floor(n);
    if (!(left > 0)) return 0;
    for (const i of REMOVE_ORDER) {
      const s = this.slots[i];
      if (s && s.id === id) {
        const k = Math.min(s.count, left);
        s.count -= k;
        left -= k;
        if (s.count <= 0) this.slots[i] = null;
        if (left === 0) break;
      }
    }
    const removed = Math.floor(n) - left;
    if (removed > 0) this.emit();
    return removed;
  }

  // Creative pick-block: select the hotbar slot holding `id`, or put a full stack of it in the held slot
  // (moving whatever was there into storage if possible).
  pickBlock(id) {
    if (getItem(id) === null) return false;
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const s = this.slots[i];
      if (s && s.id === id) {
        this.setSelected(i);
        return true;
      }
    }
    // Prefer an empty hotbar slot so nothing is displaced.
    let target = this.slots[this.selected] ? -1 : this.selected;
    for (let i = 0; i < HOTBAR_SIZE && target < 0; i++) if (!this.slots[i]) target = i;
    if (target < 0) {
      target = this.selected;
      const old = this.slots[target];
      // Park the displaced stack in an empty storage slot if there is one.
      for (let i = HOTBAR_SIZE; i < INVENTORY_SIZE; i++) {
        if (!this.slots[i]) {
          this.slots[i] = old;
          break;
        }
      }
    }
    this.slots[target] = { id, count: maxStackOf(id) };
    this.selected = target;
    this.emit();
    return true;
  }

  isEmpty() {
    return this.slots.every((s) => !s);
  }

  clear() {
    this.slots.fill(null);
    this.emit();
  }

  // ---- events / persistence --------------------------------------------------------------

  // Subscribe to changes; returns an unsubscribe function.
  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  // Call after mutating `slots` directly.
  changed() {
    // Drop emptied stacks so callers can simply decrement counts.
    for (let i = 0; i < INVENTORY_SIZE; i++) {
      const s = this.slots[i];
      if (s && !(s.count > 0)) this.slots[i] = null;
    }
    this.emit();
  }

  emit() {
    for (const fn of this._listeners) {
      try {
        fn(this);
      } catch (e) {
        console.error('Inventory listener failed', e);
      }
    }
  }

  toJSON() {
    return {
      selected: this.selected,
      slots: this.slots.map((s) => (s ? { id: s.id, count: s.count } : null)),
    };
  }

  static fromJSON(obj) {
    const inv = new Inventory();
    if (!obj) return inv;
    const slots = Array.isArray(obj) ? obj : obj.slots;
    if (Array.isArray(slots)) {
      for (let i = 0; i < INVENTORY_SIZE && i < slots.length; i++) {
        let s = slots[i];
        if (Array.isArray(s)) s = { id: s[0], count: s[1] }; // tolerate compact [id, count] pairs
        if (validStack(s)) inv.slots[i] = { id: s.id, count: Math.min(Math.floor(s.count), maxStackOf(s.id)) };
      }
    }
    if (Number.isInteger(obj.selected) && obj.selected >= 0 && obj.selected < HOTBAR_SIZE) inv.selected = obj.selected;
    return inv;
  }
}
