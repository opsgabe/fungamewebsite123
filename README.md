# Fun Game Zone

A small static website with four quick browser games:

- 🐍 **Snake**: arrow keys / WASD, swipe, or on-screen buttons
- ❌⭕ **Tic-Tac-Toe**: play the computer or a friend
- 🃏 **Memory Match**: find all 8 pairs in as few moves as possible
- 🔨 **Whack-a-Mole**: 30-second score attack

There's no build step and nothing to install. Best scores are saved in the browser's localStorage.

## Run locally

Open `index.html` in a browser, or serve the folder:

```sh
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Publish with GitHub Pages

Repo **Settings → Pages → Build and deployment**: choose *Deploy from a branch*, pick the branch and `/ (root)`, then save.
