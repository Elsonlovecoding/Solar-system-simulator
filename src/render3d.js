// ============================================================================
//  render3d.js — the Three.js 3D view.
//
//  Owns the WebGL renderer, scene graph, bloom pipeline, DOM labels and
//  picking for 3D mode. Physics stays untouched: this module maps the
//  simulation's 2D world state (SI meters, +x right / +y up) into a
//  display-space scene each frame.
//
//  DISPLAY MAPPING (all renderer-local; documented constants below):
//  * 1 three-unit = 1e9 m (1 Bm): world (x, y) -> (x·SCALE, 0, -y·SCALE),
//    so counter-clockwise 2D orbits read correctly seen from above (+Y).
//  * Orbital inclinations are exaggerated ×2.5 so the system has visible
//    depth — at true scale every orbit would look coplanar.
//  * Body radii are hugely exaggerated (×1000 on the mapped size) and
//    clamped; at true scale even Jupiter would be a sub-pixel dot.
//  * Moon orbits are pushed out beyond their parent's exaggerated ball
//    while keeping the real ordering/spacing feel.
// ============================================================================

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Camera3D } from './camera3d.js';

// -- display-space constants -------------------------------------------------

const SCALE = 1e-9;                    // meters -> three units (1 unit = 1 Bm)
const INCLINATION_EXAGGERATION = 2.5;  // ×2.5 so orbital tilt is visible
const BACKGROUND = '#04060c';          // shared app background (near-black blue)

// Visual size exaggeration — true scale would be invisible:
//   planet visual radius = clamp(radius · SCALE · 1000, 0.35, 15) units
//   sun visual radius    = 22 units
//   moon visual radius   = clamp(radius · SCALE · 1000, 0.5, 6) units
//   moon display orbit   = parent_vr · 2.4 + orbit_radius · SCALE · 55
const RADIUS_BOOST = 1000;
const PLANET_RADIUS_MIN = 0.35;
const PLANET_RADIUS_MAX = 15;
const SUN_VISUAL_RADIUS = 22;
const MOON_RADIUS_MIN = 0.5;
const MOON_RADIUS_MAX = 6;
const MOON_ORBIT_CLEARANCE = 2.4;      // × parent visual radius
const MOON_ORBIT_STRETCH = 55;         // × orbit_radius · SCALE

const TRAIL_CAPACITY = 360;            // matches the Trail buffer in bodies.js
const STARFIELD_RADIUS = 60000;        // well inside camera far (200000)
const BASE_STAR_COUNT = 9000;          // × star_density
const BRIGHT_STAR_COUNT = 140;         // × star_density
const SELF_SPIN_RATE = 0.03;           // rad/s real time, cosmetic rotation

const GAS_GIANTS = new Set(['Jupiter', 'Saturn', 'Uranus', 'Neptune']);

// ============================================================================
//  Deterministic procedural texture helpers
// ============================================================================

/** FNV-1a hash of a string -> uint32. Seeds every per-body PRNG. */
function hash_string(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 — tiny fast seeded PRNG returning floats in [0, 1). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Value noise on a lattice, periodic in u (so sphere textures have no seam)
 * and clamped in v. Returns a sampler(u, v) -> [0, 1].
 */
function make_noise(rand, cells_x, cells_y) {
  const values = new Float32Array(cells_x * (cells_y + 1));
  for (let i = 0; i < values.length; i++) values[i] = rand();

  return function sample(u, v) {
    const x = (((u % 1) + 1) % 1) * cells_x;
    const y = Math.min(Math.max(v, 0), 0.99999) * cells_y;
    let xi = Math.floor(x);
    const yi = Math.floor(y);
    if (xi >= cells_x) xi = cells_x - 1;
    const fx = x - xi;
    const fy = y - yi;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const x1 = (xi + 1) % cells_x;
    const row0 = yi * cells_x;
    const row1 = (yi + 1) * cells_x;
    const a = values[row0 + xi] + (values[row0 + x1] - values[row0 + xi]) * sx;
    const b = values[row1 + xi] + (values[row1 + x1] - values[row1 + xi]) * sx;
    return a + (b - a) * sy;
  };
}

function smoothstep_(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** '#rrggbb' -> { r, g, b } in 0..255. */
function hex_to_rgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** Lighten (amount > 0, toward white) or darken (amount < 0) one channel. */
function shade_channel(c, amount) {
  return amount >= 0 ? c + (255 - c) * amount : c * (1 + amount);
}

function make_canvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return [canvas, canvas.getContext('2d')];
}

function finish_texture(canvas, anisotropy) {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;   // filter across the u seam
  texture.anisotropy = anisotropy;
  return texture;
}

// -- painters ---------------------------------------------------------------

/** Gas giants: latitude bands with wobbly edges; Jupiter gets a storm oval. */
function paint_gas_giant(ctx, w, h, body, rand) {
  const base = hex_to_rgb(body.color);
  const n_bands = 8 + Math.floor(rand() * 7);   // 8..14 bands
  const band_shades = [];
  for (let i = 0; i < n_bands; i++) band_shades.push((rand() - 0.5) * 0.32);

  const wobble = make_noise(rand, 6, 5);        // bends band edges
  const grain = make_noise(rand, 64, 32);       // fine texture inside bands

  const has_storm = body.name === 'Jupiter';
  const storm = {
    u: 0.3 + rand() * 0.4,
    v: 0.58 + rand() * 0.1,
    ru: 0.075,
    rv: 0.045,
  };
  const storm_color = { r: 205, g: 96, b: 66 };

  const img = ctx.createImageData(w, h);
  const d = img.data;
  let i = 0;
  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w;

      // Low-frequency wobble warps latitude before banding, so band edges
      // undulate without breaking the horizontal-seam periodicity.
      const warped = v + (wobble(u, v) - 0.5) * 0.07;
      let band = Math.floor(warped * n_bands);
      band = Math.min(n_bands - 1, Math.max(0, band));

      let light = band_shades[band] + (grain(u, v) - 0.5) * 0.06;
      // Soften the transition into the next band.
      if (band < n_bands - 1) {
        const fpos = warped * n_bands - band;
        light +=
          (band_shades[band + 1] - band_shades[band]) *
          smoothstep_(0.82, 1, fpos);
      }

      let r = shade_channel(base.r, light);
      let g = shade_channel(base.g, light);
      let b = shade_channel(base.b, light);

      if (has_storm) {
        let du = Math.abs(u - storm.u);
        du = Math.min(du, 1 - du);
        const dv = v - storm.v;
        const dd =
          (du * du) / (storm.ru * storm.ru) + (dv * dv) / (storm.rv * storm.rv);
        if (dd < 1) {
          const k = (1 - dd) * (1 - dd) * 0.85;
          r += (storm_color.r - r) * k;
          g += (storm_color.g - g) * k;
          b += (storm_color.b - b) * k;
        }
      }

      d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
      i += 4;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** Rocky worlds: base color + fine speckle + darker splotch maria/craters. */
function paint_rocky(ctx, w, h, body, rand) {
  const base = hex_to_rgb(body.color);
  const fine = make_noise(rand, 96, 48);
  const coarse = make_noise(rand, 10, 5);

  const splotches = [];
  const splotch_count = 4 + Math.floor(rand() * 5);
  for (let s = 0; s < splotch_count; s++) {
    splotches.push({
      u: rand(),
      v: 0.15 + rand() * 0.7,
      r: 0.04 + rand() * 0.09,
      depth: 0.12 + rand() * 0.2,
    });
  }

  const img = ctx.createImageData(w, h);
  const d = img.data;
  let i = 0;
  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w;
      let light = (fine(u, v) - 0.5) * 0.2 + (coarse(u, v) - 0.5) * 0.14;

      for (const s of splotches) {
        let du = Math.abs(u - s.u);
        du = Math.min(du, 1 - du);
        const dv = v - s.v;
        const dd = (du * du + dv * dv * 1.4) / (s.r * s.r);
        if (dd < 1) light -= s.depth * (1 - dd) * (1 - dd);
      }

      d[i] = shade_channel(base.r, light);
      d[i + 1] = shade_channel(base.g, light);
      d[i + 2] = shade_channel(base.b, light);
      d[i + 3] = 255;
      i += 4;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** Venus: soft creamy swirl bands, no hard features under those clouds. */
function paint_venus(ctx, w, h, body, rand) {
  const base = hex_to_rgb(body.color);
  const swirl = make_noise(rand, 5, 3);
  const fine = make_noise(rand, 20, 10);

  const img = ctx.createImageData(w, h);
  const d = img.data;
  let i = 0;
  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w;
      const f = fine(u, v);
      // Sinusoidal latitude bands, bent hard by low-frequency noise so the
      // clouds read as slow V-shaped swirls rather than stripes.
      const phase = v * Math.PI * 6 + (swirl(u, v) - 0.5) * 6 + (f - 0.5) * 1.2;
      const light = Math.sin(phase) * 0.06 + (f - 0.5) * 0.05 + 0.16;
      d[i] = shade_channel(base.r, light);
      d[i + 1] = shade_channel(base.g, light);
      d[i + 2] = shade_channel(base.b, light);
      d[i + 3] = 255;
      i += 4;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** Earth: oceans, blobby continents, polar caps, faint cloud streaks. */
function paint_earth(ctx, w, h, rand) {
  const ocean_deep = { r: 16, g: 52, b: 105 };
  const ocean_shallow = { r: 38, g: 100, b: 168 };
  const land_low = { r: 74, g: 122, b: 64 };     // green lowlands
  const land_high = { r: 142, g: 118, b: 74 };   // brown highlands
  const ice = { r: 238, g: 243, b: 248 };

  const lo = make_noise(rand, 6, 3);      // continental shapes
  const mid = make_noise(rand, 14, 7);
  const hi = make_noise(rand, 32, 16);
  const streaks = make_noise(rand, 9, 26); // wide flat cells -> cloud streaks

  const img = ctx.createImageData(w, h);
  const d = img.data;
  let i = 0;
  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w;
      const e = lo(u, v) * 0.5 + mid(u, v) * 0.32 + hi(u, v) * 0.18;

      let r, g, b;
      if (e > 0.55) {
        // Land: green lowlands shading to brown highlands, plus relief.
        const t = Math.min(1, (e - 0.55) * 5);
        const relief = (hi(u, v) - 0.5) * 0.12;
        r = shade_channel(land_low.r + (land_high.r - land_low.r) * t, relief);
        g = shade_channel(land_low.g + (land_high.g - land_low.g) * t, relief);
        b = shade_channel(land_low.b + (land_high.b - land_low.b) * t, relief);
      } else {
        // Ocean: deep blue rising to shelf blue near the coasts.
        const t = Math.min(1, Math.max(0, (e - 0.2) / 0.35));
        r = ocean_deep.r + (ocean_shallow.r - ocean_deep.r) * t;
        g = ocean_deep.g + (ocean_shallow.g - ocean_deep.g) * t;
        b = ocean_deep.b + (ocean_shallow.b - ocean_deep.b) * t;
      }

      // Polar caps with a ragged noise edge.
      const cap = Math.abs(v - 0.5) * 2 + (mid(u, v) - 0.5) * 0.1;
      if (cap > 0.84) {
        const k = Math.min(1, (cap - 0.84) / 0.07);
        r += (ice.r - r) * k;
        g += (ice.g - g) * k;
        b += (ice.b - b) * k;
      }

      // Faint white cloud streaks (horizontally elongated noise cells).
      const cl = streaks(u, v);
      if (cl > 0.6) {
        const k = Math.min(0.5, (cl - 0.6) * 2.2);
        r += (255 - r) * k;
        g += (255 - g) * k;
        b += (255 - b) * k;
      }

      d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
      i += 4;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** Moons: small speckle texture tinted with the body color. */
function paint_moon(ctx, w, h, body, rand) {
  const base = hex_to_rgb(body.color);
  const fine = make_noise(rand, 40, 20);
  const coarse = make_noise(rand, 8, 4);

  const spots = [];
  const spot_count = 2 + Math.floor(rand() * 4);
  for (let s = 0; s < spot_count; s++) {
    spots.push({
      u: rand(),
      v: 0.2 + rand() * 0.6,
      r: 0.06 + rand() * 0.1,
      depth: 0.1 + rand() * 0.15,
    });
  }

  const img = ctx.createImageData(w, h);
  const d = img.data;
  let i = 0;
  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w;
      let light = (fine(u, v) - 0.5) * 0.24 + (coarse(u, v) - 0.5) * 0.12;
      for (const s of spots) {
        let du = Math.abs(u - s.u);
        du = Math.min(du, 1 - du);
        const dv = v - s.v;
        const dd = (du * du + dv * dv * 1.4) / (s.r * s.r);
        if (dd < 1) light -= s.depth * (1 - dd);
      }
      d[i] = shade_channel(base.r, light);
      d[i + 1] = shade_channel(base.g, light);
      d[i + 2] = shade_channel(base.b, light);
      d[i + 3] = 255;
      i += 4;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * Saturn's rings as a 1D radial gradient strip: C ring faint, B ring bright,
 * the dark Cassini division at ~1.95× the planet's visual radius, then the
 * A ring with a narrow Encke-like dip. Fine 1D noise keeps it from looking
 * synthetic. Mapped radially via the ring geometry's rewritten UVs.
 */
function build_saturn_ring_texture(rand) {
  const w = 512;
  const h = 8;
  const [canvas, ctx] = make_canvas(w, h);
  const base = hex_to_rgb('#e8dcc0');
  const grain = make_noise(rand, 96, 1);

  const inner = 1.24;
  const outer = 2.27;
  for (let x = 0; x < w; x++) {
    const t = x / (w - 1);
    const rr = inner + t * (outer - inner);   // radius in planet-radii

    let alpha;
    if (rr < 1.5) {
      alpha = 0.1 + ((rr - inner) / (1.5 - inner)) * 0.22;      // C ring
    } else if (rr < 1.91) {
      alpha = 0.85;                                             // B ring
    } else if (rr < 1.99) {
      alpha = 0.05;                                             // Cassini gap
    } else if (rr < 2.2) {
      alpha = 0.55;                                             // A ring
    } else if (rr < 2.222) {
      alpha = 0.12;                                             // Encke-like dip
    } else {
      alpha = 0.42 - ((rr - 2.222) / (outer - 2.222)) * 0.18;   // outer A
    }

    // Feather the extreme inner/outer edges and add ringlet grain.
    alpha *= smoothstep_(0, 0.02, t) * (1 - smoothstep_(0.98, 1, t));
    const n = grain(t, 0);
    alpha *= 0.85 + n * 0.3;
    const light = (n - 0.5) * 0.22 + (rr >= 1.5 && rr < 1.91 ? 0.08 : 0);

    const r = Math.round(shade_channel(base.r, light));
    const g = Math.round(shade_channel(base.g, light));
    const b = Math.round(shade_channel(base.b, light));
    ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`;
    ctx.fillRect(x, 0, 1, h);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Warm radial-gradient halo sprite for the Sun (additive-blended). */
function build_halo_texture() {
  const size = 256;
  const [canvas, ctx] = make_canvas(size, size);
  const g = ctx.createRadialGradient(
    size / 2, size / 2, 0,
    size / 2, size / 2, size / 2
  );
  g.addColorStop(0.0, 'rgba(255, 240, 205, 0.85)');
  g.addColorStop(0.2, 'rgba(255, 206, 115, 0.26)');
  g.addColorStop(0.5, 'rgba(255, 178, 96, 0.07)');
  g.addColorStop(1.0, 'rgba(255, 160, 80, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Small soft round dot used by the starfield Points (kills the default
 *  square-point look). Shared by both star layers; created once, lazily
 *  (Material.dispose() does not dispose textures, so sharing is safe). */
let star_sprite_texture = null;

function build_star_sprite_texture() {
  const size = 64;
  const [canvas, ctx] = make_canvas(size, size);
  const g = ctx.createRadialGradient(
    size / 2, size / 2, 0,
    size / 2, size / 2, size / 2
  );
  g.addColorStop(0.0, 'rgba(255, 255, 255, 1)');
  g.addColorStop(0.35, 'rgba(255, 255, 255, 0.9)');
  g.addColorStop(0.65, 'rgba(255, 255, 255, 0.25)');
  g.addColorStop(1.0, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

/**
 * RingGeometry whose uv.x is rewritten from the vertex radius, so a 1D
 * gradient strip maps radially (the standard ring-texture trick).
 */
function make_radial_ring_geometry(inner, outer) {
  const geometry = new THREE.RingGeometry(inner, outer, 128, 1);
  const pos = geometry.attributes.position;
  const uv = geometry.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const r = Math.sqrt(x * x + y * y);
    uv.setXY(i, (r - inner) / (outer - inner), 0.5);
  }
  return geometry;
}

function build_planet_texture(body) {
  const rand = mulberry32(hash_string(body.name));
  const [canvas, ctx] = make_canvas(512, 256);
  if (body.name === 'Earth') paint_earth(ctx, 512, 256, rand);
  else if (body.name === 'Venus') paint_venus(ctx, 512, 256, body, rand);
  else if (GAS_GIANTS.has(body.name)) paint_gas_giant(ctx, 512, 256, body, rand);
  else paint_rocky(ctx, 512, 256, body, rand);
  return finish_texture(canvas, 4);
}

function build_moon_texture(body) {
  const rand = mulberry32(hash_string(body.name));
  const [canvas, ctx] = make_canvas(128, 64);
  paint_moon(ctx, 128, 64, body, rand);
  return finish_texture(canvas, 2);
}

function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);

// ============================================================================
//  Renderer3D
// ============================================================================

export class Renderer3D {
  /**
   * @param {HTMLElement} container    #container-3d — the canvas goes here
   * @param {HTMLElement} labels_layer #labels-3d — DOM labels float here
   * @param {object} system            build_system() result
   * @param {object} settings          live app settings (shared reference)
   */
  constructor(container, labels_layer, system, settings) {
    this.container = container;
    this.labels_layer = labels_layer;
    this.system = system;
    this.settings = settings;
    this.active = true;

    this.width = container.clientWidth || window.innerWidth || 1;
    this.height = container.clientHeight || window.innerHeight || 1;

    // -- renderer + scene ---------------------------------------------------
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(this.width, this.height);
    // Insert the canvas *below* the labels layer in DOM order so labels
    // paint on top even before styles.css stacking applies.
    if (labels_layer && labels_layer.parentNode === container) {
      container.insertBefore(this.renderer.domElement, labels_layer);
    } else {
      container.appendChild(this.renderer.domElement);
    }

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(BACKGROUND);

    // -- camera + controls --------------------------------------------------
    this.camera = new THREE.PerspectiveCamera(
      50,
      this.width / this.height,
      0.5,
      200000
    );
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.enableRotate = true;
    this.controls.enableZoom = true;
    this.controls.enablePan = true;
    this.controls.minDistance = 2;
    this.controls.maxDistance = 30000;

    this.camera3d = new Camera3D(
      this.camera,
      this.controls,
      (body) => this.get_display_position(body),
      (body) => this.get_visual_radius(body)
    );

    // -- lights -------------------------------------------------------------
    // Warm point light rides the Sun's wobble; ambient keeps night sides
    // faintly readable.
    this.sun_light = new THREE.PointLight(0xfff2e2, 2.2, 0, 0);
    this.scene.add(this.sun_light);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.35));

    // -- bodies, trails, labels ---------------------------------------------
    this.records = new Map();       // Body -> display record
    this.record_list = [];
    this.planet_records = [];
    this.moon_records = [];
    this.sun_record = null;
    this.sun_halo = null;

    this.trail_material = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    });

    this._bg_color = new THREE.Color(BACKGROUND);
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._spin_q = new THREE.Quaternion();
    this._ndc = new THREE.Vector2();
    this._sphere = new THREE.Sphere();
    this.raycaster = new THREE.Raycaster();

    this.build_scene_bodies();

    // -- starfield ----------------------------------------------------------
    this.star_points = null;
    this.star_points_bright = null;
    this.regenerate_stars(settings.star_density);

    // -- post pipeline: render -> bloom -> output ---------------------------
    // Threshold sits just under the Sun's emissive luminance, so the Sun
    // blooms while lit planets stay crisp.
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom_pass = new UnrealBloomPass(
      new THREE.Vector2(this.width, this.height),
      0.85,   // strength
      0.55,   // radius
      0.85    // threshold
    );
    this.composer.addPass(this.bloom_pass);
    this.composer.addPass(new OutputPass());

    // Seed display positions so focus_body works before the first frame.
    this.update_display_positions();
  }

  // -- scene construction ---------------------------------------------------

  build_scene_bodies() {
    const anisotropy = Math.min(
      4,
      this.renderer.capabilities.getMaxAnisotropy()
    );

    // ---- Sun: emissive ball + additive halo sprite ----
    const sun = this.system.sun;
    const sun_mesh = new THREE.Mesh(
      new THREE.SphereGeometry(SUN_VISUAL_RADIUS, 48, 24),
      new THREE.MeshBasicMaterial({ color: '#fff3d0' })
    );
    this.scene.add(sun_mesh);

    this.sun_halo = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: build_halo_texture(),
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
      })
    );
    this.sun_halo.scale.set(SUN_VISUAL_RADIUS * 4.2, SUN_VISUAL_RADIUS * 4.2, 1);
    this.scene.add(this.sun_halo);

    this.sun_record = this.make_record(sun, sun_mesh, {
      visual_radius: SUN_VISUAL_RADIUS,
      collider_scale: 1.8,   // generous click target for the Sun
      orbit_q: new THREE.Quaternion(),
    });

    // ---- Planets ----
    for (const planet of this.system.planets) {
      const vr = clamp(
        planet.radius * SCALE * RADIUS_BOOST,
        PLANET_RADIUS_MIN,
        PLANET_RADIUS_MAX
      );

      // Inclination quaternion: tilt the whole orbit plane about a node
      // axis lying in the ecliptic (XZ). The node angle is a deterministic
      // hash of the name so each planet's plane leans a different way.
      const node_angle = (hash_string(planet.name) / 0xffffffff) * Math.PI * 2;
      const node_axis = new THREE.Vector3(
        Math.cos(node_angle),
        0,
        Math.sin(node_angle)
      );
      const orbit_q = new THREE.Quaternion().setFromAxisAngle(
        node_axis,
        planet.inclination * INCLINATION_EXAGGERATION
      );

      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(vr, 48, 24),
        new THREE.MeshStandardMaterial({
          map: build_planet_texture(planet),
          roughness: 0.9,
          metalness: 0,
        })
      );
      mesh.material.map.anisotropy = anisotropy;
      this.scene.add(mesh);

      if (planet.name === 'Saturn') this.add_saturn_rings(mesh, vr, planet);
      if (planet.name === 'Uranus') this.add_uranus_ring(mesh, vr);

      const record = this.make_record(planet, mesh, {
        visual_radius: vr,
        collider_scale: 1.5,
        orbit_q,
      });
      this.attach_trail(record);
      this.planet_records.push(record);
    }

    // ---- Moons ----
    for (const moon of this.system.moons) {
      const vr = clamp(
        moon.radius * SCALE * RADIUS_BOOST,
        MOON_RADIUS_MIN,
        MOON_RADIUS_MAX
      );

      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(vr, 32, 16),
        new THREE.MeshStandardMaterial({
          map: build_moon_texture(moon),
          roughness: 0.9,
          metalness: 0,
        })
      );
      this.scene.add(mesh);

      const parent_record = this.records.get(moon.parent) ?? null;
      const record = this.make_record(moon, mesh, {
        visual_radius: vr,
        collider_scale: 1.5,
        orbit_q: parent_record ? parent_record.orbit_q : new THREE.Quaternion(),
      });
      record.parent_record = parent_record;

      // Display orbit expansion: clear the parent's exaggerated ball, then
      // stretch by the real orbit radius so ordering/spacing survive.
      if (parent_record && moon.orbit_radius > 0) {
        const display_orbit =
          parent_record.visual_radius * MOON_ORBIT_CLEARANCE +
          moon.orbit_radius * SCALE * MOON_ORBIT_STRETCH;
        record.moon_offset_scale = display_orbit / (moon.orbit_radius * SCALE);
      } else {
        record.moon_offset_scale = 1;
      }

      this.moon_records.push(record);
    }
  }

  /** Shared per-body record: display state, label element, pick collider. */
  make_record(body, mesh, { visual_radius, collider_scale, orbit_q }) {
    const record = {
      body,
      mesh,
      is_moon: body.type === 'moon',
      visual_radius,
      collider_radius: visual_radius * collider_scale,
      orbit_q,
      tilt_q: new THREE.Quaternion().setFromAxisAngle(Z_AXIS, body.tilt || 0),
      spin_angle: 0,
      spin_sign: body.rotation_period < 0 ? -1 : 1,
      display_position: new THREE.Vector3(),
      color_linear: new THREE.Color(body.color),
      label_el: this.make_label(body),
      parent_record: null,
      moon_offset_scale: 1,
      // trail state (planets only, filled by attach_trail)
      line: null,
      trail_positions: null,
      trail_colors: null,
      trail_visit: null,
      trail_count: 0,
      pick_dist: Infinity,
    };
    this.records.set(body, record);
    this.record_list.push(record);
    return record;
  }

  add_saturn_rings(planet_mesh, vr, planet) {
    const rand = mulberry32(hash_string(planet.name + ':rings'));
    const ring = new THREE.Mesh(
      make_radial_ring_geometry(vr * 1.24, vr * 2.27),
      new THREE.MeshBasicMaterial({
        map: build_saturn_ring_texture(rand),
        transparent: true,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
    );
    // RingGeometry lies in XY; lay it into the planet's equatorial plane.
    // As a child of the planet mesh it inherits the axial tilt (the spin
    // is invisible on a radially symmetric texture).
    ring.rotation.x = -Math.PI / 2;
    planet_mesh.add(ring);
  }

  add_uranus_ring(planet_mesh, vr) {
    const ring = new THREE.Mesh(
      make_radial_ring_geometry(vr * 1.55, vr * 1.75),
      new THREE.MeshBasicMaterial({
        color: '#9ad5d8',
        transparent: true,
        opacity: 0.12,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
    );
    ring.rotation.x = -Math.PI / 2;
    planet_mesh.add(ring);
  }

  /** Preallocate a trail ribbon: fixed-capacity Line with vertex colors. */
  attach_trail(record) {
    const geometry = new THREE.BufferGeometry();
    // +1 vertex: the live body position is appended each frame so the trail
    // always reaches the planet instead of ending one sample behind it.
    record.trail_positions = new Float32Array((TRAIL_CAPACITY + 1) * 3);
    record.trail_colors = new Float32Array((TRAIL_CAPACITY + 1) * 3);
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(record.trail_positions, 3).setUsage(
        THREE.DynamicDrawUsage
      )
    );
    geometry.setAttribute(
      'color',
      new THREE.BufferAttribute(record.trail_colors, 3).setUsage(
        THREE.DynamicDrawUsage
      )
    );
    geometry.setDrawRange(0, 0);

    // Each planet gets its own material clone so close-up fades (opacity)
    // can be set per trail without touching the others.
    const line = new THREE.Line(geometry, this.trail_material.clone());
    line.frustumCulled = false;   // positions rewritten every frame
    this.scene.add(line);
    record.line = line;

    // One closure per planet, reused every frame — no per-frame allocation.
    // LineBasicMaterial has no per-vertex alpha, so the age fade lerps the
    // vertex color from the background toward the planet color instead.
    const bg = this._bg_color;
    const v = this._v;
    record.trail_visit = (x, y, age) => {
      const i = record.trail_count;
      if (i >= TRAIL_CAPACITY + 1) return;
      v.set(x * SCALE, 0, -y * SCALE).applyQuaternion(record.orbit_q);
      const p = record.trail_positions;
      p[i * 3] = v.x;
      p[i * 3 + 1] = v.y;
      p[i * 3 + 2] = v.z;
      const c = record.trail_colors;
      const pc = record.color_linear;
      c[i * 3] = bg.r + (pc.r - bg.r) * age;
      c[i * 3 + 1] = bg.g + (pc.g - bg.g) * age;
      c[i * 3 + 2] = bg.b + (pc.b - bg.b) * age;
      record.trail_count = i + 1;
    };
  }

  make_label(body) {
    const el = document.createElement('div');
    el.className =
      body.type === 'moon' ? 'label-3d label-3d--moon' : 'label-3d';
    el.textContent = body.name;
    // Functional positioning only — appearance belongs to styles.css.
    el.style.position = 'absolute';
    el.style.left = '0px';
    el.style.top = '0px';
    el.style.transform = 'translate(-50%, calc(-100% - 10px))';
    el.style.pointerEvents = 'none';
    el.style.display = 'none';
    this.labels_layer.appendChild(el);
    return el;
  }

  // -- starfield -------------------------------------------------------------

  /** (Re)build both star layers. Deterministic for a given density. */
  regenerate_stars(density) {
    const d = clamp(density || 1, 0.2, 2);

    if (this.star_points) {
      this.scene.remove(this.star_points);
      this.star_points.geometry.dispose();
      this.star_points.material.dispose();
      this.star_points = null;
    }
    if (this.star_points_bright) {
      this.scene.remove(this.star_points_bright);
      this.star_points_bright.geometry.dispose();
      this.star_points_bright.material.dispose();
      this.star_points_bright = null;
    }

    const rand = mulberry32(hash_string('orrery-starfield'));
    const cool = new THREE.Color('#dbe4ff');
    const warm = new THREE.Color('#ffd9a0');
    const blue = new THREE.Color('#a9c4ff');
    // The "milky way": a fraction of stars squashed toward one great circle.
    const band_normal = new THREE.Vector3(0.38, 0.9, 0.22).normalize();
    const v = new THREE.Vector3();

    const build = (count, size, min_brightness, max_brightness, band_share) => {
      const positions = new Float32Array(count * 3);
      const colors = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        // Uniform direction on the sphere.
        const z = rand() * 2 - 1;
        const phi = rand() * Math.PI * 2;
        const s = Math.sqrt(1 - z * z);
        v.set(s * Math.cos(phi), z, s * Math.sin(phi));
        if (rand() < band_share) {
          // Squash toward the band plane for a soft milky-way hint.
          const along = v.dot(band_normal);
          v.addScaledVector(band_normal, -along * (0.72 + rand() * 0.2));
          v.normalize();
        }
        positions[i * 3] = v.x * STARFIELD_RADIUS;
        positions[i * 3 + 1] = v.y * STARFIELD_RADIUS;
        positions[i * 3 + 2] = v.z * STARFIELD_RADIUS;

        const tint = rand();
        const color = tint < 0.08 ? warm : tint < 0.16 ? blue : cool;
        const brightness =
          min_brightness +
          (max_brightness - min_brightness) * Math.pow(rand(), 1.7);
        colors[i * 3] = color.r * brightness;
        colors[i * 3 + 1] = color.g * brightness;
        colors[i * 3 + 2] = color.b * brightness;
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      const material = new THREE.PointsMaterial({
        size,
        sizeAttenuation: false,
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        // Soft round sprite — without a map, points render as hard squares.
        map: (star_sprite_texture ??= build_star_sprite_texture()),
        alphaTest: 0.01,
      });
      return new THREE.Points(geometry, material);
    };

    this.star_points = build(Math.round(BASE_STAR_COUNT * d), 2.2, 0.3, 1.0, 0.38);
    this.star_points_bright = build(
      Math.round(BRIGHT_STAR_COUNT * d), 3.6, 0.7, 1.3, 0.25
    );
    this.scene.add(this.star_points);
    this.scene.add(this.star_points_bright);
  }

  // -- accessors handed to Camera3D -----------------------------------------

  get_display_position(body) {
    const record = this.records.get(body);
    return record ? record.display_position : this._v.set(0, 0, 0);
  }

  get_visual_radius(body) {
    const record = this.records.get(body);
    return record ? record.visual_radius : 1;
  }

  // -- per-frame updates -----------------------------------------------------

  /** Map every body's world (x, y) into display space. */
  update_display_positions() {
    const sun = this.system.sun;
    const srec = this.sun_record;
    srec.display_position.set(sun.x * SCALE, 0, -sun.y * SCALE);
    srec.mesh.position.copy(srec.display_position);
    this.sun_halo.position.copy(srec.display_position);
    this.sun_light.position.copy(srec.display_position);

    for (const rec of this.planet_records) {
      const b = rec.body;
      rec.display_position
        .set(b.x * SCALE, 0, -b.y * SCALE)
        .applyQuaternion(rec.orbit_q);
      rec.mesh.position.copy(rec.display_position);
    }

    // Moons: the offset from the parent is mapped like any world vector,
    // rotated into the parent's inclined plane, then expanded so the moon
    // clears the parent's exaggerated ball.
    for (const rec of this.moon_records) {
      const b = rec.body;
      const prec = rec.parent_record;
      if (prec) {
        this._v
          .set((b.x - prec.body.x) * SCALE, 0, -(b.y - prec.body.y) * SCALE)
          .applyQuaternion(prec.orbit_q)
          .multiplyScalar(rec.moon_offset_scale);
        rec.display_position.copy(prec.display_position).add(this._v);
      } else {
        rec.display_position.set(b.x * SCALE, 0, -b.y * SCALE);
      }
      rec.mesh.position.copy(rec.display_position);
    }
  }

  /** Cosmetic self-rotation about each body's tilted axis. */
  update_spins(dt_real) {
    for (const rec of this.record_list) {
      if (rec.body.type === 'star') continue;
      rec.spin_angle += SELF_SPIN_RATE * dt_real * rec.spin_sign;
      this._spin_q.setFromAxisAngle(Y_AXIS, rec.spin_angle);
      rec.mesh.quaternion.copy(rec.tilt_q).multiply(this._spin_q);
    }
  }

  /** Rewrite trail ribbon vertices from each planet's Trail buffer. */
  update_trails(show) {
    const cam_pos = this.camera.position;
    for (const rec of this.planet_records) {
      // Close-up fade: a trail slicing through a planet you're orbiting
      // reads as an artifact, so it dissolves as the camera closes in.
      const dist = cam_pos.distanceTo(rec.display_position);
      const fade = clamp((dist / rec.visual_radius - 6) / 8, 0, 1);

      const visible = show && rec.body.trail.length > 1 && fade > 0.02;
      rec.line.visible = visible;
      if (!visible) {
        rec.line.geometry.setDrawRange(0, 0);
        continue;
      }
      rec.line.material.opacity = 0.9 * fade;

      rec.trail_count = 0;
      rec.body.trail.for_each(rec.trail_visit);
      // Append the live position so the trail meets the planet exactly.
      rec.trail_visit(rec.body.x, rec.body.y, 1);
      const geometry = rec.line.geometry;
      geometry.setDrawRange(0, rec.trail_count);
      geometry.attributes.position.needsUpdate = true;
      geometry.attributes.color.needsUpdate = true;
    }
  }

  /** Project display positions to the screen and place the DOM labels. */
  update_labels(frame_state) {
    const settings = frame_state.settings;
    const show = settings.show_labels && settings.label_density > 0;
    const cam_pos = this.camera.position;
    this.camera.getWorldDirection(this._v2);
    // Vertical field of view → pixels-per-unit at a given distance, used to
    // lift each label above its body's limb instead of sitting mid-disc.
    const tan_half_fov = Math.tan((this.camera.fov * Math.PI) / 360);

    for (const rec of this.record_list) {
      const el = rec.label_el;
      let visible = show;

      // Moons only get labels when the camera is near their parent —
      // the reach grows with the label-density slider.
      if (visible && rec.is_moon) {
        const prec = rec.parent_record;
        if (prec) {
          const reach =
            prec.visual_radius * lerp(6, 60, settings.label_density);
          visible = cam_pos.distanceTo(prec.display_position) < reach;

          // Hide the label when the moon is hidden behind its parent:
          // farther than the parent and within the parent's silhouette.
          if (visible) {
            this._v.copy(prec.display_position).sub(cam_pos);
            this._v2b ??= new THREE.Vector3();
            this._v2b.copy(rec.display_position).sub(cam_pos);
            const parent_dist = this._v.length();
            const along = this._v2b.dot(this._v) / parent_dist;
            if (along > parent_dist) {
              // Perpendicular distance of the moon from the camera→parent line.
              this._v.multiplyScalar(along / parent_dist);
              const off_axis = this._v2b.distanceTo(this._v);
              const silhouette =
                (prec.visual_radius * this._v2b.length()) / parent_dist;
              if (off_axis < silhouette) visible = false;
            }
          }
        }
      }

      // Cull anything behind the camera (projection would wrap around).
      if (visible) {
        this.camera.getWorldDirection(this._v2);
        this._v.copy(rec.display_position).sub(cam_pos);
        if (this._v.dot(this._v2) <= 0) visible = false;
      }

      if (visible) {
        const dist = this._v.length();
        const p = this._v.copy(rec.display_position).project(this.camera);
        if (p.z > 1 || Math.abs(p.x) > 1.05 || Math.abs(p.y) > 1.05) {
          visible = false;
        } else {
          // Screen-projected body radius in px, capped so a filling-the-frame
          // planet doesn't push its label into the stratosphere.
          const radius_px = Math.min(
            (rec.visual_radius / (dist * tan_half_fov)) * (this.height / 2),
            this.height * 0.42
          );
          el.style.left = `${((p.x + 1) / 2) * this.width}px`;
          el.style.top = `${((1 - p.y) / 2) * this.height - radius_px}px`;
        }
      }

      el.style.display = visible ? '' : 'none';
      el.classList.toggle(
        'is-active',
        rec.body === frame_state.hovered || rec.body === frame_state.selected
      );
    }
  }

  // -- public API (called by main.js) ----------------------------------------

  resize(width, height) {
    if (!width || !height) return;
    this.width = width;
    this.height = height;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(width, height);
    this.composer.setPixelRatio(dpr);
    this.composer.setSize(width, height);
  }

  /** Draw one frame. `dt_real` = real elapsed seconds (for spins/flights). */
  render(frame_state, dt_real) {
    if (!this.active) return;
    this.update_display_positions();
    this.update_spins(dt_real);
    this.camera3d.update(dt_real);
    this.update_trails(frame_state.settings.show_trails);
    this.composer.render();
    this.update_labels(frame_state);
  }

  /**
   * Ray-pick the body under a client-space point. Prefers the smaller body
   * (a moon in front of its planet) when colliders overlap along the ray.
   */
  pick(sx, sy) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;

    this._ndc.set(
      ((sx - rect.left) / rect.width) * 2 - 1,
      -(((sy - rect.top) / rect.height) * 2 - 1)
    );
    this.raycaster.setFromCamera(this._ndc, this.camera);
    const ray = this.raycaster.ray;

    let best = null;
    for (const rec of this.record_list) {
      this._sphere.center.copy(rec.display_position);
      this._sphere.radius = rec.collider_radius;
      const hit = ray.intersectSphere(this._sphere, this._v);
      rec.pick_dist = hit ? this._v.distanceTo(ray.origin) : Infinity;
      if (hit && (!best || rec.pick_dist < best.pick_dist)) best = rec;
    }
    if (!best) return null;

    // Among hits bunched near the closest one, take the smallest body —
    // this lets a moon win against the huge planet ball behind it.
    let chosen = best;
    const window_end = best.pick_dist + best.collider_radius * 2;
    for (const rec of this.record_list) {
      if (rec.pick_dist <= window_end && rec.visual_radius < chosen.visual_radius) {
        chosen = rec;
      }
    }
    return chosen.body;
  }

  /** Enable/disable the whole 3D surface when the app switches modes. */
  set_active(active) {
    this.active = active;
    this.controls.enabled = active;
    if (active) {
      // Flush any residual damping momentum from before the mode switch.
      this.controls.update();
    }
  }
}
