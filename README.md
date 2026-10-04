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

## Terrablock

A blocky 3D sandbox that runs in the browser (`games/terrablock/`, opens as its own full page). Explore an endless generated world with plains, forests, deserts, snowy taiga, mountains, oceans and caves. Mine blocks, craft tools at a crafting table, smelt in a furnace and survive the night in **Survival**, or fly and build with every block in **Creative**. Worlds, settings and progress are saved in the browser's localStorage (autosave every 30 seconds and when you leave the page).

**Controls:** click the game to capture the mouse · **WASD** move · **mouse** look · **Space** jump / swim up (double-tap to fly in Creative) · **Shift** sneak / fly down · double-tap **W** sprint (Ctrl works too, but Ctrl+W closes the tab in most browsers) · **left click** break / attack · **right click** place, use a crafting table or furnace, eat · **middle click** pick block (Creative) · **1-9** or **wheel** hotbar · **E** inventory and crafting · **F3** debug info · **F1** hide the HUD · **Esc** pause and settings.

All art is original and generated in code: block textures, item icons, the creatures, the sky and every sound effect are drawn or synthesised procedurally at runtime, so there are no image or audio files. The game is plain ES modules with no build step; the only third-party code is [three.js](https://threejs.org/) (MIT license, see `games/terrablock/vendor/three-LICENSE.txt`). The two pixel fonts embedded in `games/terrablock/ui.css` (Pixelify Sans and Silkscreen) are under the SIL Open Font License 1.1. `games/terrablock/ARCHITECTURE.md` describes how the modules fit together.

## Quick games

- 🐍 **Snake**: arrow keys / WASD, swipe, or on-screen buttons
- ❌⭕ **Tic-Tac-Toe**: play the computer or a friend
- 🃏 **Memory Match**: find all 8 pairs in as few moves as possible
- 🔨 **Whack-a-Mole**: 30-second score attack

There's no build step and nothing to install. Best scores are saved in the browser's localStorage.

## Run locally

Open `index.html` in a browser, or serve the folder (Terrablock needs to be served over HTTP, because browsers don't load JavaScript modules and workers from `file://` pages):

```sh
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Publish with GitHub Pages

Repo **Settings → Pages → Build and deployment**: choose *Deploy from a branch*, pick the branch and `/ (root)`, then save.
