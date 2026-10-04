// Terrablock procedural sound effects.
//
// There are no audio files: every sound is synthesised on the fly with WebAudio from oscillators and
// filtered noise buffers, so all of it is original. Browsers only allow audio after a user gesture, so
// the AudioContext is created lazily by unlock() (called automatically on the first key / pointer
// press, and safe to call again from main.js). play() before that is a silent no-op.
//
//   const sounds = new Sounds();
//   sounds.play('dig', { material: 'stone' });
//
// Names: 'dig', 'break', 'place', 'step' (per block material), 'hurt', 'splash', 'eat', 'pop', 'click',
// 'mobHurt', 'mobDeath' (+ extra 'mobIdle', 'swim'). Options: material (block `sound` category, or for
// mob sounds 'animal' | 'monster'), volume (multiplier, default 1), pitch (multiplier, default 1).

const MAX_VOICES = 48; // concurrently playing sounds; extra requests are dropped
const REPEAT_GUARD = 0.022; // s: identical name+material requests closer than this collapse into one
const GESTURES = ['pointerdown', 'mousedown', 'keydown', 'touchstart'];

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const rand = (a, b) => a + Math.random() * (b - a);

// Per-material recipe for impact sounds. A "grain" is one short filtered-noise burst; several grains
// spread in time give crunchy / rustly textures. `knock` adds a pitched body (wood thunk, stone tick).
const MATERIALS = {
  stone: { noise: 'white', filter: 'bandpass', freq: 2100, q: 1.3, dur: 0.07, grains: 1, spread: 0.02, gain: 0.85,
    knock: { type: 'triangle', freq: 170, end: 120, dur: 0.06, gain: 0.35 } },
  wood: { noise: 'white', filter: 'bandpass', freq: 820, q: 2.6, dur: 0.08, grains: 1, spread: 0.02, gain: 0.7,
    knock: { type: 'sine', freq: 230, end: 150, dur: 0.1, gain: 0.6 } },
  dirt: { noise: 'brown', filter: 'lowpass', freq: 1150, q: 0.8, dur: 0.1, grains: 2, spread: 0.03, gain: 1.5 },
  grass: { noise: 'white', filter: 'bandpass', freq: 2500, q: 0.8, dur: 0.075, grains: 3, spread: 0.035, gain: 0.55,
    body: { freq: 700, gain: 0.5 } },
  sand: { noise: 'white', filter: 'highpass', freq: 3000, q: 0.7, dur: 0.12, grains: 3, spread: 0.03, gain: 0.42 },
  gravel: { noise: 'white', filter: 'bandpass', freq: 1250, q: 0.9, dur: 0.05, grains: 4, spread: 0.022, gain: 0.95 },
  glass: { noise: 'white', filter: 'highpass', freq: 4200, q: 0.8, dur: 0.045, grains: 1, spread: 0.01, gain: 0.45,
    pings: [2950, 4050] },
  leaves: { noise: 'white', filter: 'highpass', freq: 2100, q: 0.6, dur: 0.12, grains: 3, spread: 0.045, gain: 0.42 },
  snow: { noise: 'brown', filter: 'bandpass', freq: 1500, q: 0.6, dur: 0.12, grains: 2, spread: 0.05, gain: 2.2 },
  wool: { noise: 'brown', filter: 'lowpass', freq: 620, q: 0.5, dur: 0.12, grains: 1, spread: 0.03, gain: 2.0 },
};

export class Sounds {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.volume = 1;
    this._white = null;
    this._brown = null;
    this._voices = 0;
    this._last = new Map();
    this._gestureHooked = false;
    this._onGesture = () => this.unlock();
    if (typeof window !== 'undefined') {
      for (const ev of GESTURES) window.addEventListener(ev, this._onGesture, true);
      this._gestureHooked = true;
    }
  }

  // Create / resume the AudioContext. Must run inside (or after) a user gesture to produce sound.
  unlock() {
    if (typeof window === 'undefined') return;
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try {
        this.ctx = new AC({ latencyHint: 'interactive' });
      } catch {
        this.ctx = null;
        return;
      }
      this._build();
    }
    if (this.ctx.state === 'suspended') {
      try {
        const p = this.ctx.resume();
        if (p && p.catch) p.then(() => this._checkRunning()).catch(() => {});
      } catch {
        /* ignore: will retry on the next gesture */
      }
    }
    this._checkRunning();
  }

  // Master volume 0..1 (values above 1 are read as percentages, e.g. 80 -> 0.8).
  setVolume(v) {
    v = Number(v);
    if (!Number.isFinite(v)) v = 1;
    if (v > 1) v /= 100;
    this.volume = clamp(v, 0, 1);
    if (this.master) this.master.gain.setTargetAtTime(this._masterLevel(), this.ctx.currentTime, 0.02);
  }

  play(name, { material = 'stone', volume = 1, pitch = 1 } = {}) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || this.volume <= 0 || !(volume > 0)) return;
    const synth = SYNTHS[name];
    if (!synth || this._voices >= MAX_VOICES) return;
    const now = ctx.currentTime;
    const key = name + '|' + material;
    const last = this._last.get(key);
    if (last !== undefined && now - last < REPEAT_GUARD) return;
    this._last.set(key, now);

    const out = ctx.createGain();
    out.gain.value = clamp(volume, 0, 2);
    out.connect(this.master);
    const p = clamp(Number(pitch) || 1, 0.25, 4) * rand(0.94, 1.06); // slight natural variation
    let dur = 0.3;
    try {
      dur = synth(this, out, now + 0.004, material, p) || dur;
    } catch (e) {
      console.warn('Sound failed', name, e);
    }
    // Free the voice's node graph once it has finished.
    this._voices++;
    setTimeout(() => {
      this._voices--;
      try {
        out.disconnect();
      } catch {
        /* already gone */
      }
    }, (dur + 0.25) * 1000);
  }

  dispose() {
    this._unhookGestures();
    if (this.ctx) {
      try {
        this.ctx.close();
      } catch {
        /* ignore */
      }
    }
    this.ctx = null;
    this.master = null;
  }

  // ---- internals -----------------------------------------------------------------------------

  _masterLevel() {
    // Perceptual-ish curve so the slider feels even.
    return this.volume * this.volume * 0.9;
  }

  _build() {
    const ctx = this.ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 12;
    comp.ratio.value = 4;
    comp.attack.value = 0.003;
    comp.release.value = 0.15;
    comp.connect(ctx.destination);
    this.master = ctx.createGain();
    this.master.gain.value = this._masterLevel();
    this.master.connect(comp);

    // Two seconds of white and brown noise, shared by every voice (random start offsets keep it fresh).
    const len = Math.floor(ctx.sampleRate * 2);
    this._white = ctx.createBuffer(1, len, ctx.sampleRate);
    this._brown = ctx.createBuffer(1, len, ctx.sampleRate);
    const w = this._white.getChannelData(0);
    const b = this._brown.getChannelData(0);
    let acc = 0;
    for (let i = 0; i < len; i++) {
      const r = Math.random() * 2 - 1;
      w[i] = r;
      acc = (acc + 0.02 * r) / 1.02; // leaky integrator = brown-ish noise
      b[i] = acc * 3.5;
    }
  }

  _checkRunning() {
    if (this.ctx && this.ctx.state === 'running') this._unhookGestures();
  }

  _unhookGestures() {
    if (!this._gestureHooked || typeof window === 'undefined') return;
    for (const ev of GESTURES) window.removeEventListener(ev, this._onGesture, true);
    this._gestureHooked = false;
  }
}

// ---------------------------------------------------------------------------------------------
// Synthesis building blocks. Each schedules nodes at time `t` into `out` and needs no cleanup beyond
// disconnecting `out` (done by Sounds.play).

// Attack/decay envelope on an AudioParam.
function envelope(param, t, attack, dur, peak) {
  param.setValueAtTime(0.0001, t);
  param.linearRampToValueAtTime(Math.max(0.0002, peak), t + attack);
  param.exponentialRampToValueAtTime(0.0001, t + Math.max(attack + 0.005, dur));
}

// Filtered noise burst.
function noise(s, out, t, o) {
  const ctx = s.ctx;
  const dur = o.dur;
  const src = ctx.createBufferSource();
  src.buffer = o.noise === 'brown' ? s._brown : s._white;
  src.playbackRate.value = o.rate || 1;
  const f = ctx.createBiquadFilter();
  f.type = o.filter || 'bandpass';
  f.frequency.setValueAtTime(clamp(o.freq, 20, 18000), t);
  if (o.freqEnd) f.frequency.exponentialRampToValueAtTime(clamp(o.freqEnd, 20, 18000), t + dur);
  f.Q.value = o.q ?? 1;
  const g = ctx.createGain();
  envelope(g.gain, t, o.attack ?? 0.003, dur, o.gain ?? 1);
  src.connect(f);
  f.connect(g);
  g.connect(out);
  const maxOffset = Math.max(0, src.buffer.duration - dur - 0.1);
  src.start(t, Math.random() * maxOffset);
  src.stop(t + dur + 0.05);
}

// Oscillator with optional pitch glide, vibrato and lowpass/bandpass colouring.
function tone(s, out, t, o) {
  const ctx = s.ctx;
  const dur = o.dur;
  const osc = ctx.createOscillator();
  osc.type = o.type || 'sine';
  osc.frequency.setValueAtTime(clamp(o.freq, 20, 18000), t);
  if (o.end) osc.frequency.exponentialRampToValueAtTime(clamp(o.end, 20, 18000), t + (o.glide ?? dur));
  let node = osc;
  if (o.filter) {
    const f = ctx.createBiquadFilter();
    f.type = o.filter;
    f.frequency.value = clamp(o.filterFreq || 1200, 20, 18000);
    f.Q.value = o.q ?? 0.8;
    node.connect(f);
    node = f;
  }
  const g = ctx.createGain();
  envelope(g.gain, t, o.attack ?? 0.005, dur, o.gain ?? 0.5);
  node.connect(g);
  g.connect(out);
  let lfo = null;
  if (o.vibrato) {
    lfo = ctx.createOscillator();
    lfo.frequency.value = o.vibrato.rate;
    const depth = ctx.createGain();
    depth.gain.value = o.vibrato.depth;
    lfo.connect(depth);
    depth.connect(osc.frequency);
    lfo.start(t);
    lfo.stop(t + dur + 0.05);
  }
  osc.start(t);
  osc.stop(t + dur + 0.05);
}

// Material impact: grains of filtered noise plus the material's pitched body. Returns duration.
function impact(s, out, t, material, p, { durMul = 1, gain = 1, extraGrains = 0, spreadMul = 1 }) {
  const m = MATERIALS[material] || MATERIALS.stone;
  const grains = Math.max(1, m.grains + extraGrains);
  const dur = m.dur * durMul;
  let end = 0;
  for (let i = 0; i < grains; i++) {
    const gt = t + (i === 0 ? 0 : rand(0.4, 1.2) * m.spread * spreadMul * i);
    noise(s, out, gt, {
      noise: m.noise,
      filter: m.filter,
      freq: m.freq * p * rand(0.85, 1.15),
      q: m.q,
      dur: dur * rand(0.8, 1.15),
      gain: m.gain * gain * (i === 0 ? 1 : rand(0.5, 0.85)),
    });
    end = Math.max(end, gt - t + dur * 1.15);
  }
  if (m.body) {
    noise(s, out, t, { noise: 'brown', filter: 'lowpass', freq: m.body.freq * p, q: 0.7, dur: dur * 1.2, gain: m.body.gain * gain });
  }
  if (m.knock) {
    const k = m.knock;
    tone(s, out, t, { type: k.type, freq: k.freq * p, end: k.end * p, dur: k.dur * durMul, gain: k.gain * gain,
      filter: 'lowpass', filterFreq: 1600 });
  }
  if (m.pings) {
    for (const f of m.pings) {
      tone(s, out, t + rand(0, 0.015), { type: 'sine', freq: f * p * rand(0.9, 1.1), dur: 0.09 * durMul, gain: 0.12 * gain, attack: 0.002 });
    }
  }
  return end;
}

// Bright tinkles for glass shattering.
function shatter(s, out, t, p) {
  noise(s, out, t, { noise: 'white', filter: 'highpass', freq: 3500 * p, q: 0.7, dur: 0.32, gain: 0.55 });
  for (let i = 0; i < 9; i++) {
    tone(s, out, t + rand(0, 0.22), { type: i % 2 ? 'triangle' : 'sine', freq: rand(2300, 6200) * p, dur: rand(0.05, 0.14),
      gain: rand(0.06, 0.14), attack: 0.001 });
  }
  return 0.42;
}

const SYNTHS = {
  dig(s, out, t, material, p) {
    return impact(s, out, t, material, p, { gain: 0.6 });
  },

  step(s, out, t, material, p) {
    return impact(s, out, t, material, p * 0.92, { durMul: 0.8, gain: 0.75, extraGrains: -1 });
  },

  place(s, out, t, material, p) {
    // A soft low thump under the material click sells the "set down" feel.
    tone(s, out, t, { type: 'sine', freq: 120 * p, end: 70 * p, dur: 0.09, gain: 0.45 });
    return Math.max(0.1, impact(s, out, t, material, p * 0.9, { durMul: 1.1, gain: 0.85 }));
  },

  break(s, out, t, material, p) {
    let d = impact(s, out, t, material, p * 0.85, { durMul: 1.8, gain: 1.0, extraGrains: 3, spreadMul: 1.6 });
    if (material === 'glass') d = Math.max(d, shatter(s, out, t, p));
    tone(s, out, t, { type: 'sine', freq: 95 * p, end: 55 * p, dur: 0.12, gain: 0.35 });
    return d;
  },

  hurt(s, out, t, _m, p) {
    // A short, breathy vocal "uff": falling triangle tone, a darker square undertone and a puff of noise.
    tone(s, out, t, { type: 'triangle', freq: 340 * p, end: 175 * p, dur: 0.22, gain: 0.55, filter: 'lowpass', filterFreq: 1500 });
    tone(s, out, t + 0.01, { type: 'square', freq: 170 * p, end: 95 * p, dur: 0.16, gain: 0.12, filter: 'lowpass', filterFreq: 700 });
    noise(s, out, t, { noise: 'brown', filter: 'lowpass', freq: 900, q: 0.7, dur: 0.1, gain: 0.5 });
    return 0.26;
  },

  splash(s, out, t, _m, p) {
    noise(s, out, t, { noise: 'white', filter: 'lowpass', freq: 3200 * p, freqEnd: 350, q: 0.6, dur: 0.5, gain: 0.55, attack: 0.01 });
    noise(s, out, t, { noise: 'brown', filter: 'lowpass', freq: 650, q: 0.7, dur: 0.35, gain: 0.7, attack: 0.008 });
    for (let i = 0; i < 6; i++) {
      const f = rand(450, 900) * p;
      tone(s, out, t + rand(0.03, 0.4), { type: 'sine', freq: f, end: f * rand(1.8, 2.6), dur: rand(0.03, 0.06), gain: rand(0.05, 0.12), attack: 0.002 });
    }
    return 0.55;
  },

  swim(s, out, t, _m, p) {
    noise(s, out, t, { noise: 'white', filter: 'bandpass', freq: 1200 * p, freqEnd: 500, q: 0.8, dur: 0.28, gain: 0.35, attack: 0.04 });
    const f = rand(500, 800) * p;
    tone(s, out, t + rand(0.05, 0.15), { type: 'sine', freq: f, end: f * 2.1, dur: 0.04, gain: 0.06, attack: 0.002 });
    return 0.32;
  },

  eat(s, out, t, _m, p) {
    // Three wet crunches.
    for (let i = 0; i < 3; i++) {
      const gt = t + i * rand(0.055, 0.075);
      noise(s, out, gt, { noise: 'white', filter: 'bandpass', freq: rand(1500, 2100) * p, q: 1.2, dur: 0.05, gain: 0.55 });
      noise(s, out, gt, { noise: 'brown', filter: 'lowpass', freq: 520 * p, q: 0.8, dur: 0.06, gain: 0.5 });
    }
    return 0.25;
  },

  pop(s, out, t, _m, p) {
    tone(s, out, t, { type: 'sine', freq: 380 * p, end: 1050 * p, glide: 0.06, dur: 0.09, gain: 0.4, attack: 0.002 });
    tone(s, out, t, { type: 'triangle', freq: 760 * p, end: 1700 * p, glide: 0.05, dur: 0.06, gain: 0.08, attack: 0.002 });
    return 0.12;
  },

  click(s, out, t, _m, p) {
    tone(s, out, t, { type: 'square', freq: 1500 * p, dur: 0.03, gain: 0.32, attack: 0.001, filter: 'highpass', filterFreq: 700 });
    noise(s, out, t, { noise: 'white', filter: 'highpass', freq: 4500, q: 0.7, dur: 0.018, gain: 0.8, attack: 0.001 });
    return 0.05;
  },

  mobHurt(s, out, t, material, p) {
    if (material === 'monster') {
      // Gravelly snarl: low buzzing saw through a vocal formant, plus breath noise.
      tone(s, out, t, { type: 'sawtooth', freq: 150 * p, end: 95 * p, dur: 0.3, gain: 1.0, filter: 'bandpass', filterFreq: 650, q: 3,
        vibrato: { rate: 28, depth: 14 * p } });
      noise(s, out, t, { noise: 'brown', filter: 'lowpass', freq: 800, q: 0.7, dur: 0.22, gain: 0.7 });
      return 0.34;
    }
    // Animal yelp: bright saw with a fast warble.
    tone(s, out, t, { type: 'sawtooth', freq: 540 * p, end: 370 * p, dur: 0.22, gain: 0.9, filter: 'bandpass', filterFreq: 1400, q: 2.5,
      vibrato: { rate: 11, depth: 22 * p } });
    tone(s, out, t, { type: 'triangle', freq: 1080 * p, end: 740 * p, dur: 0.16, gain: 0.18 });
    return 0.26;
  },

  mobDeath(s, out, t, material, p) {
    if (material === 'monster') {
      tone(s, out, t, { type: 'sawtooth', freq: 130 * p, end: 48 * p, dur: 0.75, gain: 0.45, filter: 'bandpass', filterFreq: 520, q: 2.5,
        vibrato: { rate: 18, depth: 10 * p } });
      noise(s, out, t + 0.05, { noise: 'brown', filter: 'lowpass', freq: 1200, freqEnd: 200, q: 0.6, dur: 0.6, gain: 0.5, attack: 0.03 });
      return 0.8;
    }
    tone(s, out, t, { type: 'sawtooth', freq: 480 * p, end: 150 * p, dur: 0.55, gain: 0.7, filter: 'bandpass', filterFreq: 1200, q: 2,
      vibrato: { rate: 9, depth: 25 * p } });
    noise(s, out, t + 0.12, { noise: 'white', filter: 'bandpass', freq: 900, freqEnd: 300, q: 0.8, dur: 0.4, gain: 0.25, attack: 0.04 });
    return 0.6;
  },

  mobIdle(s, out, t, material, p) {
    if (material === 'monster') {
      tone(s, out, t, { type: 'sawtooth', freq: 92 * p, end: 80 * p, dur: 0.65, gain: 0.32, filter: 'bandpass', filterFreq: 480, q: 2.5,
        attack: 0.08, vibrato: { rate: 6, depth: 6 * p } });
      noise(s, out, t, { noise: 'brown', filter: 'lowpass', freq: 500, q: 0.7, dur: 0.6, gain: 0.25, attack: 0.1 });
      return 0.7;
    }
    tone(s, out, t, { type: 'sawtooth', freq: 360 * p, end: 330 * p, dur: 0.38, gain: 0.5, filter: 'bandpass', filterFreq: 1100, q: 2.2,
      attack: 0.03, vibrato: { rate: 7, depth: 18 * p } });
    return 0.42;
  },
};
