// Pyramid Raid: one run across two games.
// Stage 1 is Room for Change (escape with 3 artifacts), stage 2 is BananaBread
// (reach FRAG_TARGET frags). Each game runs in an iframe and reports progress
// with postMessage({ source, event }).
(function () {
  const FRAG_TARGET = 10;
  const ARENA_LOAD_TIMEOUT = 120000; // ms before a stalled arena load offers a retry
  const STAGE1_URL = 'games/roomforchange/index.html?v=4';
  const STAGE2_URL = 'games/bananabread/arena.html?v=4';
  const STAGE2_FILES = ['bb.wasm', 'bb.js', 'base.data', 'character.data', 'low.data'];

  const wrap = document.getElementById('raid-frame');
  const overlay = document.getElementById('raid-overlay');
  const ovTitle = document.getElementById('raid-ov-title');
  const ovText = document.getElementById('raid-ov-text');
  const ovBtn = document.getElementById('raid-ov-btn');
  const artifactsEl = document.getElementById('raid-artifacts');
  const fragsEl = document.getElementById('raid-frags');
  const timeEl = document.getElementById('raid-time');
  const bestEl = document.getElementById('raid-best');
  const controlsEl = document.getElementById('raid-controls');
  const focusVeil = document.getElementById('raid-focus');
  const steps = document.querySelectorAll('#raid-steps li');
  document.getElementById('raid-target').textContent = FRAG_TARGET;

  // stage: 'intro' | 'pyramid' | 'cleared' | 'arena' | 'done'
  let stage = 'intro';
  let frame = null;
  let active = false;
  let prefetched = false;
  let elapsed = 0;
  let runningSince = null;
  let clock = null;
  let onOverlayClick = null;
  let arenaWatchdog = null;

  function fmt(ms) {
    const total = Math.floor(ms / 1000);
    return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
  }

  function now() {
    return elapsed + (runningSince ? Date.now() - runningSince : 0);
  }

  function resumeClock() {
    if (runningSince) return;
    runningSince = Date.now();
    clock = setInterval(() => (timeEl.textContent = fmt(now())), 250);
  }

  function pauseClock() {
    if (!runningSince) return;
    elapsed = now();
    runningSince = null;
    clearInterval(clock);
    timeEl.textContent = fmt(elapsed);
  }

  function resetRun() {
    pauseClock();
    elapsed = 0;
    timeEl.textContent = '0:00';
    artifactsEl.textContent = 0;
    fragsEl.textContent = 0;
  }

  function showBest() {
    const best = Store.get('raid', null);
    bestEl.textContent = best === null ? '–' : fmt(best);
  }

  function setStage(next) {
    stage = next;
    const current = next === 'arena' || next === 'cleared' ? 2 : next === 'pyramid' ? 1 : 0;
    steps.forEach((li) => {
      const n = Number(li.dataset.step);
      li.classList.toggle('current', n === current && next !== 'cleared');
      li.classList.toggle('done', n < current || next === 'done' || (next === 'cleared' && n === 1));
    });
    wrap.dataset.stage = next === 'arena' || next === 'done' ? '2' : '1';
  }

  function showOverlay(title, text, label, onClick) {
    ovTitle.textContent = title;
    ovText.textContent = text;
    ovBtn.textContent = label;
    onOverlayClick = onClick;
    overlay.hidden = false;
  }

  ovBtn.addEventListener('click', () => onOverlayClick && onOverlayClick());

  function focusFrame() {
    if (!frame) return;
    frame.focus();
    try {
      frame.contentWindow.focus();
    } catch (e) {
      /* ignore */
    }
  }

  // The games only get keys while their iframe has focus. Whenever focus is
  // back on this page during play, cover the game with a "Click to play" veil;
  // clicking it (a real user gesture) hands focus back to the game.
  function syncFocusVeil() {
    const playing = (stage === 'pyramid' || stage === 'arena') && frame && overlay.hidden;
    focusVeil.hidden = !playing || document.activeElement === frame;
  }

  focusVeil.addEventListener('click', () => {
    focusFrame();
    syncFocusVeil();
  });

  setInterval(() => active && syncFocusVeil(), 250);

  function loadFrame(url, title) {
    removeFrame();
    frame = document.createElement('iframe');
    frame.src = url;
    frame.title = title;
    frame.allow = 'fullscreen; autoplay';
    frame.setAttribute('allowfullscreen', '');
    frame.addEventListener('load', () => {
      focusFrame();
      syncFocusVeil();
    });
    wrap.insertBefore(frame, focusVeil);
  }

  function removeFrame() {
    clearTimeout(arenaWatchdog);
    focusVeil.hidden = true;
    if (!frame) return;
    frame.src = 'about:blank';
    frame.remove();
    frame = null;
  }

  // Warm the browser cache with the arena while the player is in the pyramid.
  function prefetchArena() {
    if (prefetched) return;
    prefetched = true;
    STAGE2_FILES.forEach((f) => {
      const link = document.createElement('link');
      link.rel = 'prefetch';
      link.href = 'games/bananabread/' + f;
      document.head.appendChild(link);
    });
  }

  function intro() {
    removeFrame();
    resetRun();
    setStage('intro');
    showOverlay(
      'Pyramid Raid',
      `Stage 1: find the gem, the scroll and the talisman, then reach the exit. ` +
        `Stage 2: the pyramid's guardians chase you into the arena. Get ${FRAG_TARGET} frags to finish the run.`,
      'Start run',
      startPyramid
    );
    controlsEl.textContent = 'Needs a keyboard, plus a mouse for stage 2.';
  }

  function startPyramid() {
    resetRun();
    setStage('pyramid');
    overlay.hidden = true;
    loadFrame(STAGE1_URL, 'Stage 1: Room for Change');
    controlsEl.textContent =
      'Stage 1 controls: Space starts · Arrow keys move · Z attacks, or pulls a lever (then tap an arrow to slide your row or column of rooms) · X drops a bomb · Avoid pits, they kill instantly.';
    prefetchArena();
  }

  function pyramidCleared() {
    if (stage !== 'pyramid') return;
    pauseClock();
    setStage('cleared');
    // Let the game's own victory screen play for a moment.
    setTimeout(() => {
      if (stage !== 'cleared' || !active) return;
      removeFrame();
      showOverlay(
        'Stage 1 cleared!',
        `You escaped with all three artifacts at ${fmt(elapsed)}. The guardians followed you out. ` +
          `Get ${FRAG_TARGET} frags in the arena to win. The clock restarts once the arena has loaded.`,
        'Enter the arena',
        startArena
      );
    }, 2500);
  }

  function startArena() {
    setStage('arena');
    overlay.hidden = true;
    fragsEl.textContent = 0;
    loadFrame(STAGE2_URL, 'Stage 2: BananaBread arena');
    controlsEl.textContent =
      'Stage 2 controls: click the arena to aim · WASD move · Left click shoots · Space or right click jumps · 1–5 switch weapons · Rockets and grenades up close cost you a frag · Esc frees the mouse.';
    clearTimeout(arenaWatchdog);
    arenaWatchdog = setTimeout(arenaFailed, ARENA_LOAD_TIMEOUT);
  }

  // The arena couldn't start (no WebGL/WebAssembly, a failed download, a lost graphics
  // context) or is stuck loading. Keep the stage 1 time and offer another try.
  function arenaFailed() {
    if (stage !== 'arena') return;
    pauseClock();
    removeFrame();
    showOverlay(
      "The arena didn't load",
      'Stage 2 needs a browser with WebGL and WebAssembly, and a ~25 MB download. Your stage 1 time is kept.',
      'Retry arena',
      startArena
    );
  }

  function finishRun() {
    if (stage !== 'arena') return;
    pauseClock();
    setStage('done');
    if (frame) frame.contentWindow.postMessage({ target: 'bananabread', release: true }, '*');
    const best = Store.get('raid', null);
    const isBest = best === null || elapsed < best;
    if (isBest) Store.set('raid', elapsed);
    showBest();
    showOverlay(
      'Raid complete! 🏆',
      `Final time: ${fmt(elapsed)}. ` + (isBest ? 'That is your new best time!' : `Your best is ${fmt(best)}.`),
      'Play again',
      () => {
        removeFrame();
        startPyramid();
      }
    );
  }

  // GWT runs Room for Change inside a hidden child iframe, so its messages come
  // from a window nested inside our frame rather than the frame itself.
  function fromCurrentFrame(source) {
    for (let w = source; w; w = w.parent === w ? null : w.parent) {
      if (w === frame.contentWindow) return true;
      if (w === window) return false;
    }
    return false;
  }

  window.addEventListener('message', (e) => {
    if (!active || !frame || !fromCurrentFrame(e.source)) return;
    const data = e.data;
    if (!data || typeof data.event !== 'string') return;
    const [event, arg] = data.event.split(':');

    if (data.source === 'roomforchange' && stage === 'pyramid') {
      if (event === 'start') {
        artifactsEl.textContent = 0;
        resumeClock();
      } else if (event === 'artifacts') {
        artifactsEl.textContent = Math.min(3, Number(arg) || 0);
      } else if (event === 'gameover') {
        artifactsEl.textContent = 0;
      } else if (event === 'win') {
        artifactsEl.textContent = 3;
        pyramidCleared();
      }
    } else if (data.source === 'bananabread' && stage === 'arena') {
      if (event === 'ready') {
        clearTimeout(arenaWatchdog);
        resumeClock();
        focusFrame();
        frame.contentWindow.postMessage(
          { target: 'bananabread', echo: `Pyramid Raid: get ${FRAG_TARGET} frags to win!` },
          '*'
        );
      } else if (event === 'frags') {
        const frags = Number(arg) || 0;
        fragsEl.textContent = frags;
        if (frags >= FRAG_TARGET) finishRun();
      } else if (event === 'reloaded') {
        frame.contentWindow.postMessage(
          { target: 'bananabread', echo: 'New match! Your frags carry over.' },
          '*'
        );
      } else if (event === 'error') {
        arenaFailed();
      }
    }
  });

  document.getElementById('raid-restart').addEventListener('click', startPyramid);

  document.getElementById('raid-fullscreen').addEventListener('click', () => {
    const p = wrap.requestFullscreen && wrap.requestFullscreen();
    if (p && p.then) p.then(focusFrame).catch(() => {});
  });

  Games.raid = {
    enter() {
      active = true;
      showBest();
      intro();
    },
    leave() {
      active = false;
      removeFrame();
      resetRun();
      setStage('intro');
    },
  };
})();
