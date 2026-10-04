// Tiny localStorage wrapper that never throws (private mode, blocked storage, etc.)
const Store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem('fgz:' + key);
      return v === null ? fallback : JSON.parse(v);
    } catch (e) {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem('fgz:' + key, JSON.stringify(value));
    } catch (e) {
      /* ignore */
    }
  },
};

// Each game registers { enter(), leave() } here; app.js routes between them.
const Games = {};
