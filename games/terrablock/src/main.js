// Terrablock entry point: boot, title flow, world create/play/delete, loading, the game loop, pointer lock
// and pause, UI callbacks (crafting table / furnace screens), survival death and respawn, autosave and the
// F3 debug panel. Every other module is driven only through its ARCHITECTURE.md interface.
//
// Life cycle
//   boot()              settings, Renderer, Sounds, UI -> title screen
//   startWorld(id)      load save -> World.init (loading screen) -> Player/Interaction/Mobs -> HUD -> play
//   quitToTitle()       save -> dispose the session's objects -> title screen
// One `session` object holds everything that belongs to the world being played; the Renderer, Sounds
// and UI live for the whole page.

import { Renderer } from './renderer.js';
import { World } from './world.js';
import { Player } from './player.js';
import { Interaction } from './interaction.js';
import { Sounds } from './audio.js';
import { UI } from './ui.js';
import { MobManager } from './mobs.js';
import { Inventory } from './inventory.js';
import { Survival } from './survival.js';
import { Furnaces } from './furnace.js';
import { createAtlas } from './textures.js';
import { B, SOLID } from './blocks.js';
import { getItem } from './items.js';
import { hashSeed, findSpawn, biomeAt } from './worldgen.js';
import {
  listWorlds,
  createWorld,
  loadWorld,
  saveWorld,
  deleteWorld,
  loadSettings,
  saveSettings,
  encodeEdits,
  isPersistent,
} from './save.js';
import { DAY_LENGTH_SECONDS, CHUNK_SIZE, WORLD_HEIGHT, PLAYER_WIDTH, PLAYER_HEIGHT } from './config.js';

const MAX_DT = 0.05; // s; longer frames are simulated as slow motion instead of tunnelling
const AUTOSAVE_MS = 30000; // real time, so slow machines don't stretch the interval
const NEW_WORLD_TIME = 0.04; // early morning, so a new world starts with a whole day ahead
const NIGHT_START = 0.52;
const NIGHT_END = 0.98;
const DEBUG_REFRESH_MS = 250;
const RESUME_GUARD_MS = 300; // ignore a "resume" fired by the same Esc press that just paused the game
const LOCK_PENDING_MS = 1500; // a pointer-lock request that neither succeeds nor fails by then is given up
const DROP_LOST_MESSAGE_MS = 2500; // minimum gap between repeated "inventory full" messages

// Hotbar a brand-new creative world starts with (the palette in the inventory screen has everything).
const CREATIVE_STARTER = [
  B.GRASS,
  B.DIRT,
  B.STONE,
  B.COBBLESTONE,
  B.PLANKS,
  B.LOG,
  B.GLASS,
  B.BRICKS,
  B.STONE_BRICKS,
];

// ---------------------------------------------------------------------------------------------
// Page-wide state

const canvas = document.getElementById('game');
const uiRoot = document.getElementById('ui-root');

let settings = null;
let renderer = null;
let sounds = null;
let ui = null;
let session = null; // the world being played, see startWorld()
let loadingWorld = false;
let lastFrame = 0;
let pausedAt = 0;
let loopErrors = 0;

// Pointer lock bookkeeping. `document.pointerLockElement` changes synchronously while pointerlockchange
// events arrive a frame or two later, so the pause decision is based on these flags instead:
//   held          we hold the lock (set by the lock event, cleared by the unlock event)
//   pendingAt     time of a request still in flight (0 = none); further requests wait for it
//   ignoreUnlock  the next unlock event is one we caused ourselves (a screen opened, death, quit)
const lock = { held: false, pendingAt: 0, token: 0, ignoreUnlock: false, promised: false };

// ---------------------------------------------------------------------------------------------
// Boot

function boot() {
  settings = loadSettings();

  try {
    renderer = new Renderer({ canvas, atlasCanvas: createAtlas() });
  } catch (err) {
    console.error(err);
    showFatal('Terrablock needs WebGL, which is not available in this browser. Try another browser or enable hardware acceleration.');
    return;
  }
  renderer.setFov(settings.fov);
  renderer.setRenderDistance(settings.renderDistance);

  sounds = new Sounds();
  sounds.setVolume(settings.volume);

  ui = new UI({
    root: uiRoot,
    settings,
    sounds,
    callbacks: {
      onCreateWorld,
      onPlayWorld: (id) => startWorld(id),
      onDeleteWorld: (id) => deleteWorld(id),
      onResume,
      onSaveQuit: () => quitToTitle(),
      onSettingsChange,
      onRespawn: respawn,
      onScreenOpen,
      onScreenClose,
    },
  });
  ui.showTitle(listWorlds());
  if (!isPersistent()) {
    ui.showMessage('Browser storage is blocked, so worlds will be lost when this page closes. Allow site data to keep them.');
  }

  // Pointer lock: click the game view to capture the mouse; losing it while playing pauses the game.
  canvas.addEventListener('mousedown', (e) => {
    if (e.button === 0 || e.button === 2) lockPointer();
  });
  document.addEventListener('pointerlockchange', onPointerLockChange);
  document.addEventListener('pointerlockerror', () => {
    // Browsers without promise-returning requestPointerLock only report failure this way.
    if (!lock.promised) lock.pendingAt = 0;
  });

  // Save when the page goes away or into the background (mobile tab switches never fire pagehide).
  window.addEventListener('pagehide', () => saveSession());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveSession();
  });

  installTestHook();
  requestAnimationFrame(frame);
}

function showFatal(text) {
  if (typeof window.__tbBootFail === 'function') window.__tbBootFail(text);
  else uiRoot.textContent = text;
}

// ---------------------------------------------------------------------------------------------
// Title-screen callbacks

function onCreateWorld({ name, seed, mode }) {
  if (loadingWorld || session) return;
  const meta = createWorld({ name, seed, mode });
  if (!meta) {
    ui.showTitle(listWorlds());
    ui.showMessage('Browser storage is full, so the world could not be created. Delete a world you no longer need and try again.');
    return;
  }
  startWorld(meta.id, true);
}

function onSettingsChange(s) {
  saveSettings(s);
  renderer.setFov(s.fov);
  renderer.setRenderDistance(s.renderDistance);
  sounds.setVolume(s.volume);
  if (session) {
    session.world.setRenderDistance(s.renderDistance);
    session.player.setSettings(s);
  }
}

// ---------------------------------------------------------------------------------------------
// Starting and leaving a world

async function startWorld(id, isNew = false) {
  if (loadingWorld || session) return;
  loadingWorld = true;
  const built = []; // disposables created so far, released again if starting fails
  try {
    const data = loadWorld(id);
    if (!data) {
      ui.showTitle(listWorlds());
      ui.showMessage('That world could not be found.');
      return;
    }
    const meta = data.meta;
    const mode = meta.mode === 'creative' ? 'creative' : 'survival';
    const seed = hashSeed(meta.seed);

    ui.showLoading(0, isNew ? 'Finding a place to land…' : 'Loading world…');
    await nextFrame(); // let the loading screen paint before the synchronous spawn search

    const spawn = validPoint(data.spawn) ? data.spawn : findSpawn(seed);
    const start = data.player && validPoint(data.player) ? data.player : spawn;

    const world = new World({ seed, renderer, renderDistance: settings.renderDistance, edits: data.edits || {} });
    built.push(world);
    // Edit revision as loaded: chunks whose edits change from here on (including redundant edits dropped
    // while the terrain loads) are re-encoded by the first save; the rest reuse their stored strings.
    const editRev = world.editRevision;
    await world.init(start.x, start.z, (p) => ui.showLoading(p, 'Generating terrain…'));

    const inventory = data.inventory ? Inventory.fromJSON(data.inventory) : new Inventory();
    if (!data.inventory && mode === 'creative') {
      CREATIVE_STARTER.forEach((blockId, i) => inventory.setSlot(i, { id: blockId, count: 64 }));
      inventory.setSelected(0);
    }
    const survival = Survival.fromJSON(data.survival, mode);
    const furnaces = Furnaces.fromJSON(data.furnaces);

    const player = new Player({ world, camera: renderer.camera, domElement: canvas, settings, sounds });
    built.push(player);
    player.setMode(mode);
    if (data.player) player.fromJSON(data.player);
    else player.teleport(spawn.x, spawn.y, spawn.z);

    // Seed the incremental edit encoding with the stored strings of chunks the world still holds as loaded,
    // so the first autosave doesn't re-encode a big build either.
    const editCache = {};
    const unencoded = {};
    for (const [key, enc] of Object.entries(data.editsEncoded || {})) {
      if (typeof enc === 'string' && enc && world.edits[key]) editCache[key] = enc;
    }
    for (const key of Object.keys(world.edits)) if (!editCache[key]) unencoded[key] = world.edits[key]; // older object form
    Object.assign(editCache, encodeEdits(unencoded));

    const s = {
      id,
      meta,
      mode,
      seed,
      spawn: { x: spawn.x, y: spawn.y, z: spawn.z },
      world,
      player,
      inventory,
      survival,
      furnaces,
      mobs: null,
      interaction: null,
      time: Number.isFinite(data.time) ? ((data.time % 1) + 1) % 1 : NEW_WORLD_TIME,
      day: Number.isInteger(data.day) && data.day >= 0 ? data.day : 0,
      nextSave: performance.now() + AUTOSAVE_MS,
      unsubscribe: [],
      fps: 0,
      frameMs: 0,
      debugAt: 0,
      settle: true, // make sure the player isn't standing inside blocks once their chunk is loaded
      editCache, // "cx,cz" -> encoded edits, refreshed incrementally (see editsForSave)
      editRev,
      dropLostAt: 0,
      dropLostText: '',
    };
    const getMode = () => s.mode;
    const onDropLost = (itemId, count) => reportDropLost(s, itemId, count);

    s.mobs = new MobManager({ world, renderer, player, survival, inventory, sounds, getMode, onDropLost });
    built.push(s.mobs);
    s.interaction = new Interaction({
      world,
      player,
      renderer,
      inventory,
      survival,
      mobs: s.mobs,
      sounds,
      getMode,
      callbacks: { onUseBlock, onBlockBroken, onDropLost },
    });
    built.push(s.interaction);

    // Survival hooks: fall damage, hurt sound on any health loss, death screen.
    player.onFall = (distance) => {
      // The epsilon keeps float noise in the distance (3.0000000001) from adding a half-heart.
      const dmg = Math.max(0, Math.ceil(distance - 3 - 1e-6));
      if (dmg > 0) survival.damage(dmg, 'fall');
    };
    let lastHealth = survival.health;
    s.unsubscribe.push(
      survival.onChange((sv) => {
        if (sv.health < lastHealth) sounds.play('hurt');
        lastHealth = sv.health;
      }),
      survival.onDeath(() => onDeath()),
    );

    session = s;
    lock.held = false;
    lock.pendingAt = 0;
    lock.ignoreUnlock = false;
    ui.setInventory(inventory);
    ui.setSurvival(survival);
    ui.setFurnaces(furnaces);
    ui.setMode(mode);
    // Stacks this world left in the crafting grids (the previous world's are dropped).
    const gridItems = ui.setCraftingState(data.crafting || null);
    ui.hideLoading();
    ui.showHUD(mode);
    renderer.setTimeOfDay(s.time);
    lastFrame = performance.now();
    if (isNew) {
      saveSession(); // record the spawn point straight away
      ui.showMessage(
        mode === 'creative'
          ? 'Creative mode: double-tap Space to fly, press E for every block.'
          : 'Punch a tree for logs, then press E to craft. Find shelter before nightfall!',
      );
    } else if (gridItems) {
      ui.showMessage('Some items are waiting in a crafting grid.');
    }
    if (!isPersistent()) ui.showMessage('Browser storage is blocked: this world will be lost when the page closes.');
  } catch (err) {
    console.error('Terrablock: could not start the world', err);
    if (session) for (const off of session.unsubscribe) off();
    session = null;
    for (const obj of built.reverse()) {
      try {
        obj.dispose();
      } catch (e) {
        console.error(e);
      }
    }
    renderer.setUnderwater(false);
    ui.showTitle(listWorlds());
    ui.showMessage('Something went wrong while loading that world.');
  } finally {
    loadingWorld = false;
  }
}

function quitToTitle() {
  const s = session;
  if (!s) {
    ui.showTitle(listWorlds());
    return;
  }
  saveSession();
  session = null;
  releasePointer();
  for (const off of s.unsubscribe) off();
  s.interaction.dispose();
  s.mobs.dispose();
  s.player.dispose();
  s.world.dispose();
  renderer.setUnderwater(false);
  ui.setInventory(null);
  ui.setSurvival(null);
  ui.setFurnaces(null);
  ui.showTitle(listWorlds());
}

// Snapshot of everything that persists. A player who is dead right now is saved as already respawned,
// so loading never lands them in a dead body (startWorld lifts them out of anything built over the spawn).
function saveData(s) {
  const dead = s.survival.dead;
  const player = s.player.toJSON();
  if (dead) Object.assign(player, { x: s.spawn.x, y: s.spawn.y, z: s.spawn.z, flying: false });
  return {
    // The seed lets save.js re-register the world if another tab deleted it meanwhile.
    meta: { name: s.meta.name, mode: s.mode, seed: s.meta.seed },
    spawn: s.spawn,
    player,
    inventory: dead ? new Inventory().toJSON() : s.inventory.toJSON(),
    survival: dead ? new Survival(s.mode).toJSON() : s.survival.toJSON(),
    furnaces: s.furnaces.toJSON(),
    crafting: dead ? null : ui.getCraftingState(),
    time: Math.round(s.time * 1e5) / 1e5,
    day: s.day,
    edits: editsForSave(s),
  };
}

// Edits in save.js's encoded form. Only chunks edited since the previous save are re-encoded, so autosaving
// a large build doesn't copy and encode every edit every 30 s (save.js passes encoded strings through).
function editsForSave(s) {
  const { rev, changed } = s.world.getEditsDelta(s.editRev);
  const encoded = encodeEdits(changed);
  for (const key of Object.keys(changed)) {
    if (encoded[key]) s.editCache[key] = encoded[key];
    else delete s.editCache[key];
  }
  s.editRev = rev;
  return s.editCache;
}

function saveSession() {
  const s = session;
  if (!s) return true;
  let ok = false;
  try {
    ok = saveWorld(s.id, saveData(s));
  } catch (err) {
    console.error('Terrablock: save failed', err);
  }
  s.nextSave = performance.now() + AUTOSAVE_MS;
  if (!ok) ui.showMessage('Could not save the world: browser storage is full or blocked.');
  return ok;
}

// ---------------------------------------------------------------------------------------------
// In-game callbacks

function onUseBlock(x, y, z, id) {
  if (!session || ui.state !== 'playing') return false;
  if (id === B.CRAFTING_TABLE) return ui.openInventory('crafting_table');
  if (id === B.FURNACE) return ui.openInventory('furnace', `${x},${y},${z}`);
  return false;
}

function onBlockBroken(x, y, z, id) {
  const s = session;
  if (!s || id !== B.FURNACE) return;
  // A broken furnace hands its contents back.
  const items = s.furnaces.remove(`${x},${y},${z}`);
  let lost = 0;
  for (const it of items) lost += s.inventory.add(it.id, it.count);
  if (lost > 0) ui.showMessage(`Inventory full: ${lost} item${lost === 1 ? '' : 's'} from the furnace were lost.`);
}

function onScreenOpen() {
  if (!session) return;
  session.player.enabled = false;
  session.interaction.enabled = false;
  // ui.openInventory has just released the pointer itself; its unlock event is not a reason to pause.
  if (lock.held) lock.ignoreUnlock = true;
}

function onScreenClose() {
  // Closing a screen with E (a key press counts as a user gesture) can recapture the mouse at once.
  lockPointer();
}

function onResume() {
  if (performance.now() - pausedAt < RESUME_GUARD_MS) {
    ui.showPause();
    return;
  }
  lockPointer();
}

function onDeath() {
  if (!session) return;
  ui.showDeath();
  releasePointer();
}

// Survival respawn: back to the world spawn with full stats and an empty inventory.
function respawn() {
  const s = session;
  if (!s) return;
  s.survival.reset();
  s.inventory.clear();
  ui.setCraftingState(null); // death takes everything, the crafting grids included
  s.player.teleport(s.spawn.x, s.spawn.y, s.spawn.z);
  s.player.flying = false;
  s.settle = true; // lifted out of anything built over the spawn once its chunk is loaded
  settlePlayer(s);
  s.interaction.releaseButtons();
  lockPointer();
}

// If the player's body overlaps solid blocks (the spawn was built over, or a save made while dead put them
// back at the spawn), move them up to the first spot in the column with room for their whole body. Leaves
// a free spot alone, so a roof or tower over the spawn doesn't move the respawn on top of it. Waits while
// the chunk isn't loaded yet (the player is frozen until then anyway).
function settlePlayer(s) {
  const p = s.player.position;
  const fit = bodyFits(s.world, p.x, p.y, p.z);
  if (fit === null) return; // not loaded yet: try again next frame
  s.settle = false;
  if (fit) return;
  for (let y = Math.floor(p.y) + 1; y <= WORLD_HEIGHT - 2; y++) {
    const f = bodyFits(s.world, p.x, y, p.z);
    if (f === null) {
      s.settle = true;
      return;
    }
    if (f) {
      s.player.teleport(p.x, y, p.z);
      return;
    }
  }
}

// Does the player's box with the feet at (x, y, z) overlap no solid block? null if a cell isn't loaded.
function bodyFits(world, x, y, z) {
  const hw = PLAYER_WIDTH / 2;
  const e = 1e-6;
  const y1 = Math.min(WORLD_HEIGHT - 1, Math.floor(y + PLAYER_HEIGHT - e));
  for (let by = Math.floor(y + e); by <= y1; by++) {
    for (let bx = Math.floor(x - hw + e); bx <= Math.floor(x + hw - e); bx++) {
      for (let bz = Math.floor(z - hw + e); bz <= Math.floor(z + hw - e); bz++) {
        const id = world.getBlock(bx, by, bz);
        if (id < 0) return null;
        if (SOLID[id] === 1) return false;
      }
    }
  }
  return true;
}

// "Inventory full" feedback for drops that didn't fit, without repeating itself while mining a vein.
function reportDropLost(s, itemId, count) {
  const item = getItem(itemId);
  const text = `Inventory full: ${count} × ${item ? item.name : 'item'} lost`;
  const now = performance.now();
  if (text === s.dropLostText && now - s.dropLostAt < DROP_LOST_MESSAGE_MS) return;
  s.dropLostText = text;
  s.dropLostAt = now;
  ui.showMessage(text);
}

// ---------------------------------------------------------------------------------------------
// Pointer lock and pause

function lockPointer() {
  if (!session || ui.state !== 'playing' || ui.isScreenOpen() || document.pointerLockElement) return;
  const now = performance.now();
  // One request at a time: a second, overlapping request (double-click, E then a click) is refused by the
  // browser, which must not be mistaken for losing the lock.
  if (lock.pendingAt && now - lock.pendingAt < LOCK_PENDING_MS) return;
  const token = ++lock.token;
  lock.pendingAt = now;
  const p = session.player.requestPointerLock();
  lock.promised = !!p;
  if (p) {
    p.then((ok) => {
      if (!ok && lock.token === token) lock.pendingAt = 0;
    });
  }
}

// Release the pointer on our own initiative (death, quit); the resulting unlock event is not a pause.
function releasePointer() {
  if (document.pointerLockElement && document.exitPointerLock) {
    lock.ignoreUnlock = true;
    document.exitPointerLock();
  }
}

function onPointerLockChange() {
  if (document.pointerLockElement) {
    lock.held = true;
    lock.pendingAt = 0;
    lock.ignoreUnlock = false;
    // A lock granted after the game moved on (paused, a screen opened, died, quit): give it straight back,
    // otherwise the menu would sit there with the cursor captured.
    if (!session || ui.state !== 'playing' || ui.isScreenOpen()) releasePointer();
    return;
  }
  const wasHeld = lock.held;
  lock.held = false;
  if (lock.ignoreUnlock) {
    lock.ignoreUnlock = false;
    return;
  }
  // Only a lock we actually held can be lost (Esc, alt-tab); a refused request is not a reason to pause.
  if (!wasHeld) return;
  if (session && ui.state === 'playing' && !ui.isScreenOpen()) {
    pausedAt = performance.now();
    ui.showPause();
  }
}

// ---------------------------------------------------------------------------------------------
// Game loop

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(MAX_DT, Math.max(0, (now - lastFrame) / 1000));
  const frameMs = now - lastFrame;
  lastFrame = now;
  const s = session;
  if (!s) return; // the title / loading screens cover the canvas
  try {
    tick(s, dt, now, frameMs);
  } catch (err) {
    // Keep the game alive; report the first few failures only.
    if (loopErrors++ < 5) console.error('Terrablock frame error', err);
  }
}

function tick(s, dt, now, frameMs) {
  const state = ui.state;
  const running = state === 'playing' || state === 'dead'; // pause freezes the simulation
  const controllable = state === 'playing' && !ui.isScreenOpen();
  s.player.enabled = controllable;
  s.interaction.enabled = controllable;

  if (s.settle) settlePlayer(s);
  if (running) {
    s.player.update(dt);
    s.interaction.update(dt);
    const t = s.time;
    s.mobs.update(dt, { timeOfDay: t, isNight: t >= NIGHT_START && t < NIGHT_END });
    s.furnaces.update(dt);
    const v = s.player.velocity;
    const moving = Math.hypot(v.x, v.z) > 0.5;
    const swimming = s.player.isInWater();
    s.survival.update(dt, {
      sprinting: s.player.sprinting,
      moving,
      swimming,
      headInWater: s.player.isHeadInWater(),
    });
    advanceTime(s, dt);
  } else {
    s.player.update(0); // keep the camera in sync without moving
  }

  s.world.update(s.player.position, running ? dt : 0); // falling sand freezes while paused
  renderer.setTimeOfDay(s.time);
  renderer.setUnderwater(s.player.isHeadInWater());
  renderer.render();
  ui.updateHUD();

  // Smoothed frame statistics for F3.
  if (frameMs > 0 && frameMs < 1000) {
    s.frameMs = s.frameMs ? s.frameMs * 0.95 + frameMs * 0.05 : frameMs;
    s.fps = 1000 / s.frameMs;
  }
  if (ui.debugVisible && now - s.debugAt > DEBUG_REFRESH_MS) {
    s.debugAt = now;
    ui.setDebug(debugLines(s));
  }

  if ((state === 'playing' || state === 'paused') && now >= s.nextSave) saveSession();
}

function advanceTime(s, dt) {
  s.time += dt / DAY_LENGTH_SECONDS;
  if (s.time >= 1) {
    s.time -= 1;
    s.day++;
  }
}

// ---------------------------------------------------------------------------------------------
// F3 debug panel

const FACINGS = [
  ['north', '-z'],
  ['east', '+x'],
  ['south', '+z'],
  ['west', '-x'],
];

function debugLines(s) {
  const p = s.player.position;
  const bx = Math.floor(p.x);
  const by = Math.floor(p.y);
  const bz = Math.floor(p.z);
  const cx = Math.floor(bx / CHUNK_SIZE);
  const cz = Math.floor(bz / CHUNK_SIZE);
  // yaw 0 looks towards -z (north); positive yaw turns left (west).
  const yawDeg = ((((-s.player.yaw * 180) / Math.PI) % 360) + 360) % 360;
  const [facing, axis] = FACINGS[Math.round(yawDeg / 90) % 4];
  const pitchDeg = (s.player.pitch * 180) / Math.PI;
  const st = s.world.stats();
  const hours = (6 + s.time * 24) % 24;
  const clock = `${String(Math.floor(hours)).padStart(2, '0')}:${String(Math.floor((hours % 1) * 60)).padStart(2, '0')}`;
  const night = s.time >= NIGHT_START && s.time < NIGHT_END;
  const info = renderer.info.render;
  const target = s.interaction.target;
  const mobStats = s.mobs.stats();
  return [
    `Terrablock  ${s.fps.toFixed(0)} fps (${s.frameMs.toFixed(1)} ms)`,
    `XYZ: ${p.x.toFixed(2)} / ${p.y.toFixed(2)} / ${p.z.toFixed(2)}`,
    `Block: ${bx} ${by} ${bz}  Chunk: ${cx} ${cz} (in ${bx - cx * CHUNK_SIZE} ${bz - cz * CHUNK_SIZE})`,
    `Biome: ${biomeAt(bx, bz, s.seed)}`,
    `Facing: ${facing} (${axis})  yaw ${yawDeg.toFixed(1)}°  pitch ${pitchDeg.toFixed(1)}°`,
    `Chunks: ${st.loaded} loaded, ${st.meshed} meshed, ${st.pending} pending`,
    `Time: day ${s.day + 1}, ${clock} (t=${s.time.toFixed(3)}${night ? ', night' : ''})`,
    `Mode: ${s.mode}${s.player.flying ? ' (flying)' : ''}  Mobs: ${mobStats.passive} passive, ${mobStats.hostile} hostile`,
    `Draw calls: ${info.calls}  Triangles: ${info.triangles}`,
    target ? `Looking at: ${target.x} ${target.y} ${target.z}` : 'Looking at: nothing',
  ];
}

// ---------------------------------------------------------------------------------------------
// Helpers

function validPoint(p) {
  return !!p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

// Automated tests (headless browsers often refuse pointer lock) drive the game through this object.
function installTestHook() {
  const hook = {
    get session() {
      return session;
    },
    get player() {
      return session && session.player;
    },
    get world() {
      return session && session.world;
    },
    get inventory() {
      return session && session.inventory;
    },
    get survival() {
      return session && session.survival;
    },
    get mobs() {
      return session && session.mobs;
    },
    get interaction() {
      return session && session.interaction;
    },
    get furnaces() {
      return session && session.furnaces;
    },
    get ui() {
      return ui;
    },
    get renderer() {
      return renderer;
    },
    get sounds() {
      return sounds;
    },
    get settings() {
      return settings;
    },
    setTime(t) {
      if (!session || !Number.isFinite(t)) return;
      session.time = ((t % 1) + 1) % 1;
      renderer.setTimeOfDay(session.time);
    },
    getTime() {
      return session ? session.time : null;
    },
    save: () => saveSession(),
    quit: () => quitToTitle(),
    debugLines: () => (session ? debugLines(session) : null),
  };
  Object.defineProperty(window, '__terrablock', { value: hook, configurable: true });
}

boot();
