(function () {
  const EMOJI = ['🐶', '🐱', '🦊', '🐸', '🐼', '🦄', '🐙', '🐝'];
  const boardEl = document.getElementById('mem-board');
  const movesEl = document.getElementById('mem-moves');
  const pairsEl = document.getElementById('mem-pairs');
  const bestEl = document.getElementById('mem-best');
  const statusEl = document.getElementById('mem-status');

  let open, moves, pairs, locked;

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function showBest() {
    const best = Store.get('memory', null);
    bestEl.textContent = best === null ? '–' : best;
  }

  function reset() {
    open = [];
    moves = 0;
    pairs = 0;
    locked = false;
    movesEl.textContent = 0;
    pairsEl.textContent = 0;
    statusEl.textContent = '';
    boardEl.innerHTML = '';
    shuffle([...EMOJI, ...EMOJI]).forEach((emoji) => {
      const card = document.createElement('button');
      card.className = 'mem-card';
      card.dataset.emoji = emoji;
      card.setAttribute('aria-label', 'Hidden card');
      card.innerHTML =
        '<div class="mem-inner"><div class="mem-face mem-front">?</div>' +
        `<div class="mem-face mem-back">${emoji}</div></div>`;
      card.addEventListener('click', () => flip(card));
      boardEl.appendChild(card);
    });
  }

  function flip(card) {
    if (locked || card.classList.contains('flipped') || card.classList.contains('matched')) return;
    card.classList.add('flipped');
    card.setAttribute('aria-label', card.dataset.emoji);
    open.push(card);
    if (open.length < 2) return;

    moves++;
    movesEl.textContent = moves;
    const [a, b] = open;
    if (a.dataset.emoji === b.dataset.emoji) {
      a.classList.add('matched');
      b.classList.add('matched');
      open = [];
      pairs++;
      pairsEl.textContent = pairs;
      if (pairs === EMOJI.length) win();
    } else {
      locked = true;
      setTimeout(() => {
        a.classList.remove('flipped');
        b.classList.remove('flipped');
        a.setAttribute('aria-label', 'Hidden card');
        b.setAttribute('aria-label', 'Hidden card');
        open = [];
        locked = false;
      }, 800);
    }
  }

  function win() {
    const best = Store.get('memory', null);
    if (best === null || moves < best) {
      Store.set('memory', moves);
      statusEl.textContent = `All pairs in ${moves} moves — new best! 🎉`;
    } else {
      statusEl.textContent = `All pairs in ${moves} moves! 🎉`;
    }
    showBest();
  }

  document.getElementById('mem-reset').addEventListener('click', reset);
  reset();

  Games.memory = {
    enter: showBest,
    leave() {},
  };
})();
