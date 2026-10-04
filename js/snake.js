(function () {
  const GRID = 20;
  const canvas = document.getElementById('snake-canvas');
  const ctx = canvas.getContext('2d');
  const cell = canvas.width / GRID;
  const scoreEl = document.getElementById('snake-score');
  const bestEl = document.getElementById('snake-best');
  const overlay = document.getElementById('snake-overlay');
  const msg = document.getElementById('snake-msg');
  const startBtn = document.getElementById('snake-start');

  const DIRS = {
    up: { x: 0, y: -1 },
    down: { x: 0, y: 1 },
    left: { x: -1, y: 0 },
    right: { x: 1, y: 0 },
  };

  let snake, dir, queue, food, score, timer, running, active;

  function reset() {
    snake = [{ x: 9, y: 10 }, { x: 8, y: 10 }, { x: 7, y: 10 }];
    dir = DIRS.right;
    queue = [];
    score = 0;
    scoreEl.textContent = 0;
    placeFood();
    draw();
  }

  function placeFood() {
    do {
      food = { x: Math.floor(Math.random() * GRID), y: Math.floor(Math.random() * GRID) };
    } while (snake.some((s) => s.x === food.x && s.y === food.y));
  }

  function speed() {
    return Math.max(60, 130 - score * 3);
  }

  function start() {
    reset();
    running = true;
    overlay.hidden = true;
    loop();
  }

  function loop() {
    clearTimeout(timer);
    if (!running) return;
    step();
    if (running) timer = setTimeout(loop, speed());
  }

  function step() {
    const next = queue.shift();
    if (next) dir = next;
    const head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };
    const willEat = head.x === food.x && head.y === food.y;
    const body = willEat ? snake : snake.slice(0, -1);
    if (
      head.x < 0 || head.y < 0 || head.x >= GRID || head.y >= GRID ||
      body.some((s) => s.x === head.x && s.y === head.y)
    ) {
      return gameOver();
    }
    snake.unshift(head);
    if (willEat) {
      score++;
      scoreEl.textContent = score;
      placeFood();
    } else {
      snake.pop();
    }
    draw();
  }

  function gameOver() {
    running = false;
    const best = Store.get('snake', 0);
    if (score > best) {
      Store.set('snake', score);
      bestEl.textContent = score;
      msg.textContent = `New best: ${score}! 🎉`;
    } else {
      msg.textContent = `Game over — score ${score}`;
    }
    startBtn.textContent = 'Play again';
    overlay.hidden = false;
  }

  function draw() {
    const css = getComputedStyle(document.documentElement);
    ctx.fillStyle = css.getPropertyValue('--surface');
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = css.getPropertyValue('--border');
    for (let x = 0; x < GRID; x++) {
      for (let y = 0; y < GRID; y++) {
        if ((x + y) % 2) ctx.fillRect(x * cell, y * cell, cell, cell);
      }
    }

    ctx.fillStyle = '#e5484d';
    ctx.beginPath();
    ctx.arc(food.x * cell + cell / 2, food.y * cell + cell / 2, cell * 0.4, 0, Math.PI * 2);
    ctx.fill();

    snake.forEach((s, i) => {
      ctx.fillStyle = i === 0 ? '#178a4b' : '#22a45d';
      ctx.fillRect(s.x * cell + 1, s.y * cell + 1, cell - 2, cell - 2);
    });
  }

  function turn(name) {
    const d = DIRS[name];
    if (!d) return;
    const last = queue.length ? queue[queue.length - 1] : dir;
    if (d.x === -last.x && d.y === -last.y) return; // no reversing
    if (d === last) return;
    if (queue.length < 3) queue.push(d);
  }

  const KEYS = {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    w: 'up', s: 'down', a: 'left', d: 'right',
    W: 'up', S: 'down', A: 'left', D: 'right',
  };

  document.addEventListener('keydown', (e) => {
    if (!active) return;
    if (e.key === ' ' && !running) {
      e.preventDefault();
      start();
      return;
    }
    if (KEYS[e.key]) {
      e.preventDefault();
      if (running) turn(KEYS[e.key]);
    }
  });

  document.querySelectorAll('.dpad button').forEach((b) =>
    b.addEventListener('click', () => turn(b.dataset.dir))
  );

  let touchStart = null;
  canvas.addEventListener('touchstart', (e) => {
    touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  }, { passive: true });
  canvas.addEventListener('touchend', (e) => {
    if (!touchStart) return;
    const dx = e.changedTouches[0].clientX - touchStart.x;
    const dy = e.changedTouches[0].clientY - touchStart.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) > 20) {
      turn(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'));
    }
    touchStart = null;
  });

  startBtn.addEventListener('click', start);

  Games.snake = {
    enter() {
      active = true;
      bestEl.textContent = Store.get('snake', 0);
      if (!running) {
        reset();
        msg.textContent = 'Press Start or Space';
        startBtn.textContent = 'Start';
        overlay.hidden = false;
      }
    },
    leave() {
      active = false;
      running = false;
      clearTimeout(timer);
    },
  };
})();
