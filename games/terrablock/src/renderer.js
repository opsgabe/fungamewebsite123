// Terrablock renderer: WebGL setup, block materials, sky (gradient dome, sun, moon, stars), drifting
// clouds, distance fog and the day/night lighting model. Browser only.
//
// Lighting model: blocks use unlit MeshBasicMaterial; the mesher bakes face shade, AO and skylight into
// vertex colours, and the whole world is scaled by a global light level that follows the time of day.
// Colour values given here (and the world's vertex colours) are treated as perceptual sRGB multipliers and
// converted to three.js' linear working space, so "0.5" really looks half as bright on screen.

import * as THREE from '../vendor/three.module.min.js';
import { DEFAULT_RENDER_DISTANCE, CHUNK_SIZE } from './config.js';
import { createAtlas } from './textures.js';

const TAU = Math.PI * 2;
const MIN_LIGHT = 0.18; // light level at the darkest point of the night

// Sky palette (sRGB). Original colours: a clear cyan-blue day, an inky indigo night, amber twilight.
const DAY_ZENITH = new THREE.Color('#4d86dc');
const DAY_HORIZON = new THREE.Color('#a9cdf1');
const NIGHT_ZENITH = new THREE.Color('#04060f');
const NIGHT_HORIZON = new THREE.Color('#0d1428');
const TWILIGHT_GLOW = new THREE.Color('#f2843f');
const TWILIGHT_HORIZON = new THREE.Color('#e7a477');
const WATER_FOG = new THREE.Color('#163a7c');

const SKY_RADIUS = 500;
const STAR_RADIUS = 450;
const SUN_DISTANCE = 400;

// Clouds: a tileable pattern of 12x12-block cells, 4 blocks thick, bottom at y = 110, drifting along +x.
export const CLOUD_Y = 110;
const CLOUD_CELL = 12;
const CLOUD_GRID = 48; // cells per tile side
const CLOUD_TILE = CLOUD_CELL * CLOUD_GRID; // 576 blocks
const CLOUD_THICKNESS = 4;
const CLOUD_SPEED = 1.1; // blocks per second

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// Small deterministic PRNG so the sky looks the same on every load.
function mulberry32(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------------------------
// Procedural sprites

function makeCanvas(size) {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  return c;
}

// Pixel-art sun: a bright square-cornered disc with a stepped (banded) halo.
function drawSun() {
  const S = 32;
  const c = makeCanvas(S);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(S, S);
  const mid = (S - 1) / 2;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = Math.abs(x - mid);
      const dy = Math.abs(y - mid);
      // Blend of Chebyshev and Euclidean distance gives a chunky, slightly squared-off disc.
      const d = 0.55 * Math.max(dx, dy) + 0.45 * Math.hypot(dx, dy);
      let r = 0, g = 0, b = 0, a = 0;
      if (d < 5.2) {
        [r, g, b, a] = [255, 252, 232, 255];
      } else if (d < 7.2) {
        [r, g, b, a] = [255, 236, 150, 255];
      } else {
        // Stepped halo bands fading out.
        const band = Math.floor((d - 7.2) / 2.2);
        const alpha = Math.max(0, 0.5 - band * 0.13);
        [r, g, b, a] = [255, 214, 120, Math.round(alpha * 255)];
      }
      const i = (y * S + x) * 4;
      img.data[i] = r;
      img.data[i + 1] = g;
      img.data[i + 2] = b;
      img.data[i + 3] = a;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// Pixel-art moon: pale disc with a few darker maria and a faint cool halo.
function drawMoon() {
  const S = 32;
  const c = makeCanvas(S);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(S, S);
  const mid = (S - 1) / 2;
  const rnd = mulberry32(0x5eed1);
  const craters = [];
  for (let i = 0; i < 7; i++) {
    const ang = rnd() * TAU;
    const dist = rnd() * 4.5;
    craters.push({ x: mid + Math.cos(ang) * dist, y: mid + Math.sin(ang) * dist, r: 0.9 + rnd() * 1.6 });
  }
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const d = Math.hypot(x - mid, y - mid);
      let r = 0, g = 0, b = 0, a = 0;
      if (d < 7.5) {
        let shade = 1 - 0.18 * smoothstep(3, 7.5, d); // limb darkening
        for (const k of craters) if (Math.hypot(x - k.x, y - k.y) < k.r) shade *= 0.82;
        // Quantise to a few tones for a pixel-art look.
        shade = Math.round(shade * 6) / 6;
        r = 224 * shade;
        g = 229 * shade;
        b = 238 * shade;
        a = 255;
      } else if (d < 12) {
        [r, g, b] = [170, 190, 230];
        a = Math.round(255 * 0.16 * (1 - Math.floor((d - 7.5) / 1.5) / 3));
      }
      const i = (y * S + x) * 4;
      img.data[i] = r;
      img.data[i + 1] = g;
      img.data[i + 2] = b;
      img.data[i + 3] = Math.max(0, a);
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function pixelTexture(canvas) {
  const t = new THREE.CanvasTexture(canvas);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---------------------------------------------------------------------------------------------
// Sky dome

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const SKY_FRAG = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGlow;
uniform vec3 uSunDir;
uniform float uGlowAmt;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 col = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.55));
  // Below the horizon: stay at the horizon colour (it is also the fog colour), darkening slightly far down.
  col = mix(col, uHorizon * 0.82, smoothstep(0.0, -0.45, h));
  // Twilight glow hugging the horizon around the sun.
  float s = max(dot(d, uSunDir), 0.0);
  float glow = uGlowAmt * (pow(s, 5.0) * 0.85 + pow(s, 32.0) * 0.4) * (1.0 - smoothstep(0.0, 0.55, abs(h - 0.04)));
  col = mix(col, uGlow, clamp(glow, 0.0, 1.0));
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

// ---------------------------------------------------------------------------------------------
// Stars: points with per-star size and twinkle, faded out below the horizon.

const STAR_VERT = /* glsl */ `
attribute float aSize;
attribute float aPhase;
uniform float uTime;
uniform float uOpacity;
uniform float uPixelRatio;
varying float vAlpha;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec3 dir = normalize(wp.xyz - cameraPosition);
  float twinkle = 0.72 + 0.28 * sin(uTime * (1.3 + aPhase * 1.7) + aPhase * 40.0);
  vAlpha = uOpacity * twinkle * smoothstep(-0.02, 0.18, dir.y);
  gl_Position = projectionMatrix * viewMatrix * wp;
  gl_PointSize = aSize * uPixelRatio;
}`;

const STAR_FRAG = /* glsl */ `
varying float vAlpha;
void main() {
  if (vAlpha <= 0.003) discard;
  gl_FragColor = vec4(1.0, 0.97, 0.9, vAlpha);
  #include <colorspace_fragment>
}`;

// ---------------------------------------------------------------------------------------------
// Clouds: unlit boxes with per-face shade, faded out by horizontal distance.

const CLOUD_VERT = /* glsl */ `
attribute float aShade;
varying float vShade;
varying float vDist;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vDist = length(wp.xz - cameraPosition.xz);
  vShade = aShade;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const CLOUD_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uFogColor;
uniform float uOpacity;
uniform float uFadeNear;
uniform float uFadeFar;
varying float vShade;
varying float vDist;
void main() {
  float fade = 1.0 - smoothstep(uFadeNear, uFadeFar, vDist);
  if (fade <= 0.004) discard;
  vec3 col = mix(uColor * vShade, uFogColor, smoothstep(uFadeNear * 0.4, uFadeFar, vDist) * 0.55);
  gl_FragColor = vec4(col, uOpacity * fade);
  #include <colorspace_fragment>
}`;

// Tileable cloud coverage from two octaves of periodic value noise.
function cloudPattern(grid, seed) {
  const rnd = mulberry32(seed);
  const octave = (period) => {
    const lat = new Float32Array(period * period);
    for (let i = 0; i < lat.length; i++) lat[i] = rnd();
    return (x, z) => {
      // x, z in lattice units, wrapped.
      const x0 = Math.floor(x), z0 = Math.floor(z);
      const fx = x - x0, fz = z - z0;
      const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
      const at = (i, k) => lat[(((i % period) + period) % period) + (((k % period) + period) % period) * period];
      const a = at(x0, z0) + (at(x0 + 1, z0) - at(x0, z0)) * sx;
      const b = at(x0, z0 + 1) + (at(x0 + 1, z0 + 1) - at(x0, z0 + 1)) * sx;
      return a + (b - a) * sz;
    };
  };
  const o1 = octave(8), o2 = octave(16), o3 = octave(24);
  const cells = new Uint8Array(grid * grid);
  for (let z = 0; z < grid; z++) {
    for (let x = 0; x < grid; x++) {
      const u = x / grid, v = z / grid;
      const n = o1(u * 8, v * 8) * 0.55 + o2(u * 16, v * 16) * 0.3 + o3(u * 24, v * 24) * 0.15;
      cells[x + z * grid] = n > 0.56 ? 1 : 0;
    }
  }
  return cells;
}

// Geometry for a 3x3 block of cloud tiles (so the camera always sits in the middle one).
function buildCloudGeometry() {
  const cells = cloudPattern(CLOUD_GRID, 0xc10d5);
  const N = CLOUD_GRID * 3;
  const filled = (i, k) => cells[(((i % CLOUD_GRID) + CLOUD_GRID) % CLOUD_GRID) + (((k % CLOUD_GRID) + CLOUD_GRID) % CLOUD_GRID) * CLOUD_GRID] === 1;
  const pos = [];
  const shade = [];
  const idx = [];
  const C = CLOUD_CELL, H = CLOUD_THICKNESS;
  const quad = (verts, s) => {
    const base = pos.length / 3;
    for (const v of verts) {
      pos.push(v[0], v[1], v[2]);
      shade.push(s);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  for (let k = 0; k < N; k++) {
    for (let i = 0; i < N; i++) {
      if (!filled(i, k)) continue;
      const x0 = i * C, x1 = x0 + C, z0 = k * C, z1 = z0 + C;
      // Winding is counter-clockwise seen from outside (front faces).
      quad([[x0, H, z0], [x0, H, z1], [x1, H, z1], [x1, H, z0]], 1.0); // top
      quad([[x0, 0, z0], [x1, 0, z0], [x1, 0, z1], [x0, 0, z1]], 0.72); // bottom
      if (!filled(i + 1, k)) quad([[x1, 0, z0], [x1, H, z0], [x1, H, z1], [x1, 0, z1]], 0.88);
      if (!filled(i - 1, k)) quad([[x0, 0, z1], [x0, H, z1], [x0, H, z0], [x0, 0, z0]], 0.88);
      if (!filled(i, k + 1)) quad([[x1, 0, z1], [x1, H, z1], [x0, H, z1], [x0, 0, z1]], 0.8);
      if (!filled(i, k - 1)) quad([[x0, 0, z0], [x0, H, z0], [x1, H, z0], [x1, 0, z0]], 0.8);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aShade', new THREE.Float32BufferAttribute(shade, 1));
  g.setIndex(pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(N * C * 0.5, H * 0.5, N * C * 0.5), N * C);
  return g;
}

// ---------------------------------------------------------------------------------------------

const _tmpColor = new THREE.Color();
const _fwd = new THREE.Vector3();

export class Renderer {
  constructor({ canvas, atlasCanvas } = {}) {
    this.canvas = canvas;
    this.webgl = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      stencil: false,
      powerPreference: 'high-performance',
    });
    this.renderer = this.webgl; // alias for code that expects `renderer.renderer`
    this.webgl.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.webgl.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.1, 1000);
    this.camera.rotation.order = 'YXZ'; // yaw then pitch, the natural order for a first-person camera
    this.scene.add(this.camera); // lets other modules parent view-model objects to the camera

    // Block atlas.
    const atlas = atlasCanvas || createAtlas();
    this.atlasTexture = new THREE.CanvasTexture(atlas);
    this.atlasTexture.magFilter = THREE.NearestFilter;
    this.atlasTexture.minFilter = THREE.NearestFilter;
    this.atlasTexture.generateMipmaps = false;
    this.atlasTexture.colorSpace = THREE.SRGBColorSpace;
    this.atlasTexture.needsUpdate = true;

    this.materials = {
      opaque: new THREE.MeshBasicMaterial({ map: this.atlasTexture, vertexColors: true }),
      cutout: new THREE.MeshBasicMaterial({
        map: this.atlasTexture,
        vertexColors: true,
        alphaTest: 0.5,
        side: THREE.DoubleSide,
      }),
      water: new THREE.MeshBasicMaterial({
        map: this.atlasTexture,
        vertexColors: true,
        transparent: true,
        opacity: 0.92,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    };

    // Fog: linear, tied to render distance.
    this.renderDistance = DEFAULT_RENDER_DISTANCE;
    this.fog = new THREE.Fog(0xa9cdf1, 50, 90);
    this.scene.fog = this.fog;
    this.scene.background = new THREE.Color();

    this._time = 0.25;
    this._daylight = 1;
    this._light = 1;
    this._glow = 0;
    this._underwater = false;
    this.sunDirection = new THREE.Vector3(0, 1, 0);
    this._horizon = new THREE.Color();
    this._zenith = new THREE.Color();
    this._fogColor = new THREE.Color();
    this._clock0 = performance.now();

    this._buildSky();
    this._buildClouds();

    this.setRenderDistance(DEFAULT_RENDER_DISTANCE);
    this.setTimeOfDay(0.25);
    this.resize();

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    this._contextRestoredHandlers = [];
    this._onContextRestored = () => {
      for (const fn of this._contextRestoredHandlers) {
        try {
          fn();
        } catch (err) {
          console.error(err);
        }
      }
    };
    canvas.addEventListener('webglcontextrestored', this._onContextRestored);
  }

  // --- construction helpers ------------------------------------------------------------------

  _buildSky() {
    this.skyGroup = new THREE.Group();
    this.skyGroup.name = 'sky';
    this.scene.add(this.skyGroup);

    this._skyUniforms = {
      uZenith: { value: new THREE.Color() },
      uHorizon: { value: new THREE.Color() },
      uGlow: { value: new THREE.Color() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uGlowAmt: { value: 0 },
    };
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(SKY_RADIUS, 32, 16),
      new THREE.ShaderMaterial({
        uniforms: this._skyUniforms,
        vertexShader: SKY_VERT,
        fragmentShader: SKY_FRAG,
        side: THREE.BackSide,
        depthWrite: false,
        depthTest: false,
        fog: false,
      }),
    );
    dome.renderOrder = -100;
    dome.frustumCulled = false;
    this.skyDome = dome;
    this.skyGroup.add(dome);

    // Stars rotate with the sky around the axis of the sun's path.
    const rnd = mulberry32(0x57a25);
    const COUNT = 1100;
    const pos = new Float32Array(COUNT * 3);
    const size = new Float32Array(COUNT);
    const phase = new Float32Array(COUNT);
    for (let i = 0; i < COUNT; i++) {
      // Uniform direction on the sphere.
      const u = rnd() * 2 - 1;
      const th = rnd() * TAU;
      const r = Math.sqrt(1 - u * u);
      pos[i * 3] = r * Math.cos(th) * STAR_RADIUS;
      pos[i * 3 + 1] = u * STAR_RADIUS;
      pos[i * 3 + 2] = r * Math.sin(th) * STAR_RADIUS;
      const s = rnd();
      size[i] = s < 0.8 ? 1.5 : s < 0.97 ? 2.2 : 3.2;
      phase[i] = rnd();
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    starGeo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    starGeo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    this._starUniforms = {
      uTime: { value: 0 },
      uOpacity: { value: 0 },
      uPixelRatio: { value: this.webgl.getPixelRatio() },
    };
    this.stars = new THREE.Points(
      starGeo,
      new THREE.ShaderMaterial({
        uniforms: this._starUniforms,
        vertexShader: STAR_VERT,
        fragmentShader: STAR_FRAG,
        transparent: true,
        depthWrite: false,
        fog: false,
      }),
    );
    this.stars.renderOrder = -90;
    this.stars.frustumCulled = false;
    this.starPivot = new THREE.Group();
    this.starPivot.add(this.stars);
    this.skyGroup.add(this.starPivot);

    const spriteMat = (tex, additive) =>
      new THREE.SpriteMaterial({
        map: tex,
        transparent: true,
        depthWrite: false,
        fog: false,
        blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      });
    this.sun = new THREE.Sprite(spriteMat(pixelTexture(drawSun()), true));
    this.sun.scale.setScalar(78);
    this.sun.renderOrder = -80;
    this.sun.frustumCulled = false;
    this.moon = new THREE.Sprite(spriteMat(pixelTexture(drawMoon()), false));
    this.moon.scale.setScalar(46);
    this.moon.renderOrder = -80;
    this.moon.frustumCulled = false;
    this.skyGroup.add(this.sun, this.moon);
  }

  _buildClouds() {
    const geo = buildCloudGeometry();
    this._cloudUniforms = {
      uColor: { value: new THREE.Color(1, 1, 1) },
      uFogColor: { value: new THREE.Color() },
      uOpacity: { value: 0.82 },
      uFadeNear: { value: 120 },
      uFadeFar: { value: 260 },
    };
    // Two passes: depth only, then colour with LessEqual, so overlapping translucent faces never stack.
    const depthMat = new THREE.ShaderMaterial({
      uniforms: this._cloudUniforms,
      vertexShader: CLOUD_VERT,
      fragmentShader: CLOUD_FRAG,
      transparent: true,
      colorWrite: false,
      depthWrite: true,
      fog: false,
    });
    const colorMat = new THREE.ShaderMaterial({
      uniforms: this._cloudUniforms,
      vertexShader: CLOUD_VERT,
      fragmentShader: CLOUD_FRAG,
      transparent: true,
      depthWrite: false,
      depthFunc: THREE.LessEqualDepth,
      fog: false,
    });
    const depthMesh = new THREE.Mesh(geo, depthMat);
    const colorMesh = new THREE.Mesh(geo, colorMat);
    depthMesh.renderOrder = 50;
    colorMesh.renderOrder = 51;
    depthMesh.frustumCulled = false;
    colorMesh.frustumCulled = false;
    this.clouds = new THREE.Group();
    this.clouds.name = 'clouds';
    this.clouds.add(depthMesh, colorMesh);
    this.scene.add(this.clouds);
  }

  // --- public API ----------------------------------------------------------------------------

  /** Time of day t in [0,1): 0 sunrise, 0.25 noon, 0.5 sunset, 0.75 midnight. */
  setTimeOfDay(t) {
    t = Number.isFinite(t) ? ((t % 1) + 1) % 1 : 0.25;
    this._time = t;
    const a = t * TAU;
    // The sun rises in the east (+x), culminates slightly to the south (+z tilt) and sets in the west.
    this.sunDirection.set(Math.cos(a), Math.sin(a), 0.22).normalize();
    const e = this.sunDirection.y; // sine of the sun's elevation

    const day = smoothstep(-0.25, 0.3, e);
    this._daylight = day;
    this._light = MIN_LIGHT + (1 - MIN_LIGHT) * day;
    // Twilight glow peaks while the sun crosses the horizon and lingers a little after sunset.
    this._glow = Math.exp(-((e + 0.02) / 0.2) ** 2);

    this._zenith.copy(NIGHT_ZENITH).lerp(DAY_ZENITH, day);
    this._horizon.copy(NIGHT_HORIZON).lerp(DAY_HORIZON, day).lerp(TWILIGHT_HORIZON, this._glow * 0.35 * Math.max(0.25, day));

    const u = this._skyUniforms;
    u.uZenith.value.copy(this._zenith);
    u.uHorizon.value.copy(this._horizon);
    u.uGlow.value.copy(TWILIGHT_GLOW);
    u.uGlowAmt.value = this._glow * 0.9;
    u.uSunDir.value.copy(this.sunDirection);

    this._starUniforms.uOpacity.value = 1 - smoothstep(0.02, 0.4, day);
    this.starPivot.rotation.set(0, 0, a); // rotate with the sun around the z axis (sun path normal)

    // Sun colour warms near the horizon; both bodies fade out just below it.
    this.sun.material.color.setRGB(1, 1 - 0.25 * this._glow, 1 - 0.5 * this._glow, THREE.SRGBColorSpace);
    this.sun.material.opacity = smoothstep(-0.14, 0.02, e);
    this.moon.material.opacity = smoothstep(-0.14, 0.02, -e) * (0.55 + 0.45 * (1 - day));

    // Cloud colour: white by day, dim blue-grey at night, warm at twilight.
    const cl = 0.17 + 0.83 * day;
    const warm = this._glow * 0.6 * Math.max(0.3, day);
    _tmpColor.setRGB(
      cl * (0.92 + 0.08 * day),
      cl * (0.94 + 0.06 * day) * (1 - 0.25 * warm),
      cl * (1 - 0.4 * warm),
      THREE.SRGBColorSpace,
    );
    this._cloudUniforms.uColor.value.copy(_tmpColor);

    this._applyMaterialLight();
    this._applyFogColor(null);
  }

  /** Fog distance follows the render distance (in chunks). */
  setRenderDistance(chunks) {
    const n = Math.max(1, Number(chunks) || DEFAULT_RENDER_DISTANCE);
    this.renderDistance = n;
    this._fogFar = Math.max(20, n * CHUNK_SIZE - 4);
    this._fogNear = this._fogFar * 0.62;
    const far = Math.min(400, Math.max(150, n * CHUNK_SIZE * 2));
    this._cloudUniforms.uFadeFar.value = far;
    this._cloudUniforms.uFadeNear.value = far * 0.45;
    this._applyFogDistance();
  }

  /** Dense blue fog and no sky while the camera is under water. */
  setUnderwater(on) {
    on = !!on;
    if (on === this._underwater) return;
    this._underwater = on;
    this.skyGroup.visible = !on;
    this.clouds.visible = !on;
    this._applyFogDistance();
    this._applyMaterialLight();
    this._applyFogColor(null);
  }

  setFov(deg) {
    const f = Number(deg);
    if (!Number.isFinite(f)) return;
    this.camera.fov = Math.min(150, Math.max(20, f));
    this.camera.updateProjectionMatrix();
  }

  resize() {
    const c = this.canvas;
    let w = c.clientWidth;
    let h = c.clientHeight;
    if (!w || !h) {
      w = window.innerWidth;
      h = window.innerHeight;
    }
    w = Math.max(1, Math.floor(w));
    h = Math.max(1, Math.floor(h));
    const pr = Math.min(window.devicePixelRatio || 1, 2);
    if (pr !== this.webgl.getPixelRatio()) this.webgl.setPixelRatio(pr);
    this.webgl.setSize(w, h, false);
    this._starUniforms.uPixelRatio.value = pr;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  render() {
    const cam = this.camera;
    cam.updateMatrixWorld();
    const p = cam.position;
    const elapsed = (performance.now() - this._clock0) / 1000;

    // Sky objects are centred on the camera so they appear infinitely far away.
    this.skyGroup.position.copy(p);
    this.sun.position.copy(this.sunDirection).multiplyScalar(SUN_DISTANCE);
    this.moon.position.copy(this.sunDirection).multiplyScalar(-SUN_DISTANCE);
    this._starUniforms.uTime.value = elapsed;

    // Clouds drift along +x; the 3x3 tile block is re-centred on the camera's tile.
    const drift = (elapsed * CLOUD_SPEED) % CLOUD_TILE;
    const tx = Math.floor((p.x - drift) / CLOUD_TILE);
    const tz = Math.floor(p.z / CLOUD_TILE);
    this.clouds.position.set((tx - 1) * CLOUD_TILE + drift, CLOUD_Y, (tz - 1) * CLOUD_TILE);

    // Fog takes on the twilight glow when looking towards the sun, matching the sky behind the terrain.
    cam.getWorldDirection(_fwd);
    this._applyFogColor(_fwd);

    this.webgl.render(this.scene, cam);
  }

  /** 0 (night) .. 1 (full day). */
  get daylight() {
    return this._daylight;
  }

  /** Light multiplier applied to world materials: MIN_LIGHT .. 1. */
  get light() {
    return this._light;
  }

  get timeOfDay() {
    return this._time;
  }

  get underwater() {
    return this._underwater;
  }

  get info() {
    return this.webgl.info;
  }

  get domElement() {
    return this.webgl.domElement;
  }

  /** Register a callback for WebGL context restoration (world.js rebuilds its chunk meshes). */
  onContextRestored(fn) {
    this._contextRestoredHandlers.push(fn);
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    this.canvas.removeEventListener('webglcontextrestored', this._onContextRestored);
    this.scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          if (m.map && m.map !== this.atlasTexture) m.map.dispose();
          m.dispose();
        }
      }
    });
    for (const m of Object.values(this.materials)) m.dispose();
    this.atlasTexture.dispose();
    this.webgl.dispose();
  }

  // --- internals -----------------------------------------------------------------------------

  _applyFogDistance() {
    if (this._underwater) {
      this.fog.near = 0.5;
      this.fog.far = 14;
    } else {
      this.fog.near = this._fogNear;
      this.fog.far = this._fogFar;
    }
  }

  // Scale the world materials by the light level (perceptual), with a faint blue cast at night and a
  // stronger one under water.
  _applyMaterialLight() {
    const l = this._light;
    const night = 1 - this._daylight;
    let r = l * (1 - 0.12 * night);
    let g = l * (1 - 0.06 * night);
    let b = l;
    if (this._underwater) {
      r *= 0.62;
      g *= 0.8;
    }
    for (const m of Object.values(this.materials)) m.color.setRGB(r, g, b, THREE.SRGBColorSpace);
  }

  _applyFogColor(forward) {
    const fc = this._fogColor;
    if (this._underwater) {
      fc.copy(WATER_FOG).multiplyScalar(0.25 + 0.75 * this._light);
    } else {
      fc.copy(this._horizon);
      if (forward && this._glow > 0.01) {
        // Same falloff as the sky shader's glow at the horizon, sampled in the view direction.
        const fx = forward.x, fz = forward.z;
        const len = Math.hypot(fx, fz) || 1;
        const sx = this.sunDirection.x, sz = this.sunDirection.z;
        const slen = Math.hypot(sx, sz) || 1;
        const s = Math.max(0, (fx * sx + fz * sz) / (len * slen));
        const k = this._glow * 0.9 * (Math.pow(s, 5) * 0.85) * 0.75;
        fc.lerp(TWILIGHT_GLOW, Math.min(1, k));
      }
    }
    this.fog.color.copy(fc);
    this.scene.background.copy(fc);
    this._cloudUniforms.uFogColor.value.copy(this._horizon);
  }
}
