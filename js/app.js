// Hash router: #snake, #tictactoe, #memory, #whack, or empty for the home page.
(function () {
  const views = document.querySelectorAll('.view');
  const navLinks = document.querySelectorAll('.site-header nav a');
  let current = null;

  function refreshBestBadges() {
    const labels = {
      snake: (v) => `Best: ${v}`,
      memory: (v) => `Best: ${v} moves`,
      whack: (v) => `Best: ${v} moles`,
      raid: (v) => {
        const t = Math.floor(v / 1000);
        return `Best run: ${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
      },
    };
    document.querySelectorAll('[data-best]').forEach((el) => {
      const key = el.dataset.best;
      const v = Store.get(key, null);
      el.textContent = v === null || v === 0 ? '' : labels[key](v);
    });
  }

  function route() {
    const name = location.hash.slice(1);
    const target = Games[name] ? name : 'home';
    if (current && Games[current]) Games[current].leave();
    views.forEach((v) => (v.hidden = v.id !== target));
    navLinks.forEach((a) => a.classList.toggle('active', a.getAttribute('href') === '#' + target));
    current = target;
    if (Games[target]) Games[target].enter();
    else refreshBestBadges();
    window.scrollTo(0, 0);
  }

  window.addEventListener('hashchange', route);
  route();
})();
