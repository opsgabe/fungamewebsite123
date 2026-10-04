(function () {
  const boardEl = document.getElementById('ttt-board');
  const statusEl = document.getElementById('ttt-status');
  const resetBtn = document.getElementById('ttt-reset');
  const tally = { X: 0, O: 0, D: 0 };
  const LINES = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6],
  ];

  let board, turn, over, cpuTimer;
  const cells = [];

  for (let i = 0; i < 9; i++) {
    const b = document.createElement('button');
    b.setAttribute('aria-label', `Cell ${i + 1}`);
    b.addEventListener('click', () => humanMove(i));
    boardEl.appendChild(b);
    cells.push(b);
  }

  function mode() {
    return document.querySelector('input[name=ttt-mode]:checked').value;
  }

  function winner(b) {
    for (const line of LINES) {
      const [a, c, d] = line;
      if (b[a] && b[a] === b[c] && b[a] === b[d]) return { player: b[a], line };
    }
    return b.every(Boolean) ? { player: 'D' } : null;
  }

  function reset() {
    clearTimeout(cpuTimer);
    board = Array(9).fill(null);
    turn = 'X';
    over = false;
    render();
    statusEl.textContent = mode() === 'cpu' ? 'Your turn (X)' : "X's turn";
  }

  function render(winLine) {
    cells.forEach((c, i) => {
      c.textContent = board[i] || '';
      c.className = board[i] ? board[i].toLowerCase() : '';
      if (winLine && winLine.includes(i)) c.classList.add('win');
      c.disabled = over || !!board[i];
    });
  }

  function place(i) {
    board[i] = turn;
    const result = winner(board);
    if (result) {
      over = true;
      tally[result.player]++;
      document.getElementById('ttt-x').textContent = tally.X;
      document.getElementById('ttt-o').textContent = tally.O;
      document.getElementById('ttt-d').textContent = tally.D;
      if (result.player === 'D') statusEl.textContent = "It's a draw!";
      else if (mode() === 'cpu') statusEl.textContent = result.player === 'X' ? 'You win! 🎉' : 'Computer wins 🤖';
      else statusEl.textContent = `${result.player} wins! 🎉`;
      render(result.line);
      return;
    }
    turn = turn === 'X' ? 'O' : 'X';
    render();
    statusEl.textContent = mode() === 'cpu'
      ? (turn === 'X' ? 'Your turn (X)' : 'Computer is thinking…')
      : `${turn}'s turn`;
  }

  function humanMove(i) {
    if (over || board[i]) return;
    if (mode() === 'cpu' && turn !== 'X') return;
    place(i);
    if (!over && mode() === 'cpu') {
      cells.forEach((c) => (c.disabled = true));
      cpuTimer = setTimeout(() => place(bestMove()), 350);
    }
  }

  // Minimax with a little randomness so it's beatable ~20% of the time.
  function bestMove() {
    const empty = board.map((v, i) => (v ? null : i)).filter((v) => v !== null);
    if (Math.random() < 0.2) return empty[Math.floor(Math.random() * empty.length)];
    let best = -Infinity, move = empty[0];
    for (const i of empty) {
      board[i] = 'O';
      const score = minimax(false, 0);
      board[i] = null;
      if (score > best) { best = score; move = i; }
    }
    return move;
  }

  function minimax(isMax, depth) {
    const r = winner(board);
    if (r) return r.player === 'O' ? 10 - depth : r.player === 'X' ? depth - 10 : 0;
    let best = isMax ? -Infinity : Infinity;
    for (let i = 0; i < 9; i++) {
      if (board[i]) continue;
      board[i] = isMax ? 'O' : 'X';
      const s = minimax(!isMax, depth + 1);
      board[i] = null;
      best = isMax ? Math.max(best, s) : Math.min(best, s);
    }
    return best;
  }

  resetBtn.addEventListener('click', reset);
  document.querySelectorAll('input[name=ttt-mode]').forEach((r) => r.addEventListener('change', reset));

  reset();

  Games.tictactoe = {
    enter() {},
    leave() {},
  };
})();
