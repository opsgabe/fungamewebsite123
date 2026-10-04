(function () {
  const HOLES = 9;
  const DURATION = 30;
  const boardEl = document.getElementById('whack-board');
  const scoreEl = document.getElementById('whack-score');
  const timeEl = document.getElementById('whack-time');
  const bestEl = document.getElementById('whack-best');
  const statusEl = document.getElementById('whack-status');
  const startBtn = document.getElementById('whack-start');

  let score, timeLeft, running, clock, popTimer;
  const holes = [];

  for (let i = 0; i < HOLES; i++) {
    const h = document.createElement('button');
    h.className = 'hole';
    h.setAttribute('aria-label', `Hole ${i + 1}`);
    h.innerHTML = '<span>🐹</span>';
    h.addEventListener('pointerdown', () => whack(h));
    boardEl.appendChild(h);
    holes.push(h);
  }

  function whack(h) {
    if (!running || !h.classList.contains('up')) return;
    h.classList.remove('up');
    h.classList.add('hit');
    setTimeout(() => h.classList.remove('hit'), 200);
    score++;
    scoreEl.textContent = score;
  }

  function pop() {
    if (!running) return;
    const idle = holes.filter((h) => !h.classList.contains('up') && !h.classList.contains('hit'));
    if (idle.length) {
      const h = idle[Math.floor(Math.random() * idle.length)];
      h.classList.add('up');
      // Moles stay up for less time as the clock runs down.
      const stay = 500 + (timeLeft / DURATION) * 600;
      setTimeout(() => h.classList.remove('up'), stay);
    }
    popTimer = setTimeout(pop, 350 + Math.random() * 450);
  }

  function start() {
    stop();
    score = 0;
    timeLeft = DURATION;
    scoreEl.textContent = 0;
    timeEl.textContent = DURATION;
    statusEl.textContent = 'Go go go!';
    startBtn.disabled = true;
    running = true;
    pop();
    clock = setInterval(() => {
      timeLeft--;
      timeEl.textContent = timeLeft;
      if (timeLeft <= 0) end();
    }, 1000);
  }

  function stop() {
    running = false;
    clearInterval(clock);
    clearTimeout(popTimer);
    holes.forEach((h) => h.classList.remove('up', 'hit'));
    startBtn.disabled = false;
  }

  function end() {
    stop();
    const best = Store.get('whack', 0);
    if (score > best) {
      Store.set('whack', score);
      bestEl.textContent = score;
      statusEl.textContent = `Time's up! ${score} moles — new best! 🎉`;
    } else {
      statusEl.textContent = `Time's up! You whacked ${score} moles.`;
    }
    startBtn.textContent = 'Play again';
  }

  startBtn.addEventListener('click', start);

  Games.whack = {
    enter() {
      bestEl.textContent = Store.get('whack', 0);
    },
    leave() {
      if (running) {
        stop();
        statusEl.textContent = 'Hit Start, then tap the moles!';
      }
    },
  };
})();
