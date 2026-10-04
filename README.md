# Fun Game Zone

A small static website with browser games.

## Pyramid Raid

Two open-source games joined into one run with a shared timer:

1. **Stage 1: [Room for Change](https://github.com/antionio/game-off-2013)** (2D action RPG, Java/libGDX compiled to JavaScript with GWT). Collect the gem, scroll and talisman and escape the pyramid.
2. **Stage 2: [BananaBread](https://github.com/kripken/BananaBread)** (3D shooter, Cube 2: Sauerbraten compiled to WebAssembly). Get 10 frags in the arena.

Each game runs in an iframe and reports progress to the page with `postMessage`; `js/raid.js` runs the stages, timer and best time.

- `games/roomforchange/` is a fresh GWT build of Room for Change with `host-events.patch` applied. The patch adds a `GameEvents` hook that reports game start, artifact pickups, game over and the win. To rebuild: apply the patch to the upstream repo, then run `com.google.gwt.dev.Compiler` from GWT 2.5.1 on Java 8 (with `validation-api-1.0.0.GA`) against `com.sturdyhelmetgames.roomforchange.GwtDefinition`.
- `games/bananabread/` is the prebuilt WebAssembly build from BananaBread's `gh-pages` branch (low-detail map pack only). `arena.html` is a trimmed embeddable page that reports frags using the engine's `getfrags` command. The original demo page is kept as `bb.html`.

Licenses: Room for Change is Apache 2.0 (`games/roomforchange/LICENSE.txt`); BananaBread code is zlib and its art is under the licenses in `games/bananabread/LICENSE-BananaBread.md`.

## Quick games

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
