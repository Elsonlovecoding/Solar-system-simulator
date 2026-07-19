// ============================================================================
//  render2d.js — the 2D canvas renderer.
//
//  Draws one frame of the top-down solar system view: deep-space background
//  (pre-rendered nebula + starfield layers), comet trails, true-scale bodies
//  with smart minimum sizes, Saturn's rings, hover/selection rings, name
//  labels, and adaptive distance rulers along the top and left edges.
//
//  Owned by main.js: it constructs Renderer2D(canvas, system, camera), calls
//  resize(w, h, dpr) on window resize, render(frame_state) every frame while
//  the 2D view is active, pick(sx, sy) for hover/click hit-testing, and
//  regenerate_stars(density) when the star-density slider moves.
//
//  Performance notes: everything static is pre-rendered to offscreen canvases
//  (nebula, starfield, glow sprites) and blitted; trails are stroked in ~24
//  alpha buckets instead of per-segment; off-screen work is culled. The only
//  per-frame allocations are a handful of gradients for the few shaded discs
//  actually on screen and the ruler label strings.
// ============================================================================

import { format_distance } from './config.js';

// -- palette (shared design language) ---------------------------------------

const BG_COLOR = '#04060c';
const NEBULA_COLORS = ['#1b2350', '#2a1b46', '#0d2b33'];  // indigo / violet / teal
const ACCENT = '#8ab4ff';

const STAR_COLOR_MAIN = '#dbe4ff';
const STAR_COLOR_WARM = '#ffd9a0';
const STAR_COLOR_BLUE = '#a9c4ff';

// -- tuning constants -------------------------------------------------------

const TAU = Math.PI * 2;
const DIAG = Math.SQRT1_2;             // unit diagonal component (cos 45°)

const STAR_BASE_COUNT = 700;           // × settings.star_density
const TWINKLE_COUNT = 10;              // bright stars redrawn live each frame

const TRAIL_BUCKETS = 24;              // alpha buckets per trail polyline
const TRAIL_MAX_ALPHA = 0.85;          // newest end of a trail
const TRAIL_MIN_WIDTH = 0.8;           // oldest end [px]
const TRAIL_MAX_WIDTH = 1.8;           // newest end [px]

const SUN_MIN_PX = 8;                  // the Sun never vanishes
const PLANET_MIN_DOT_PX = 2.6;         // minimum planet dot ...
const PLANET_ORBIT_MIN_PX = 26;        // ... only while its orbit reads on screen
const MOON_ORBIT_MIN_PX = 8;           // moons appear once their orbit is this big
const MOON_MIN_DOT_PX = 1.8;
const SHADED_MIN_PX = 4;               // below this, bodies are flat glowing dots
const RIM_MIN_PX = 10;                 // planet atmosphere rim threshold
const DISC_CAP_FACTOR = 1.2;           // max drawn radius = 1.2 × max(w, h)

// Saturn's rings, as multiples of the planet's drawn radius (top-down annulus).
const RING_BANDS = [
  { inner: 1.24, outer: 1.50, alpha: 0.16 },   // C ring — faint inner veil
  { inner: 1.50, outer: 1.94, alpha: 0.32 },   // B ring — the bright bulk
  { inner: 1.94, outer: 2.02, alpha: 0.05 },   // Cassini division — near-empty gap
  { inner: 2.02, outer: 2.27, alpha: 0.24 },   // A ring — outer band
];
const RING_COLOR = '#e8dcc0';
const RING_MIN_OUTER_PX = 6;           // draw rings only when they'd be legible

const LABEL_FONT = "500 11px 'Inter', system-ui, sans-serif";
const MOON_LABEL_FONT = "500 10px 'Inter', system-ui, sans-serif";
const RULER_FONT = "10px 'Space Grotesk', system-ui, sans-serif";
const LABEL_MIN_GAP_PX = 14;           // moon-label overlap rejection distance

// ---------------------------------------------------------------------------
//  Small utilities
// ---------------------------------------------------------------------------

/** Deterministic 32-bit PRNG so the sky looks identical on every visit. */
function mulberry32(seed) {
  let a = seed | 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** '#rgb' or '#rrggbb' -> {r, g, b}. Results are memoized. */
const rgb_cache = new Map();
function hex_to_rgb(hex) {
  let rgb = rgb_cache.get(hex);
  if (rgb) return rgb;
  let h = hex.replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  rgb = { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  rgb_cache.set(hex, rgb);
  return rgb;
}

/** 'rgba(...)' string for a hex color + alpha. Memoized — alphas are few. */
const rgba_cache = new Map();
function rgba(hex, alpha) {
  const key = hex + '|' + alpha;
  let s = rgba_cache.get(key);
  if (s) return s;
  const { r, g, b } = hex_to_rgb(hex);
  s = `rgba(${r},${g},${b},${alpha})`;
  rgba_cache.set(key, s);
  return s;
}

/** Mix a hex color toward another hex color by t (0..1) -> 'rgb(...)'. */
function mix_hex(hex, toward, t) {
  const a = hex_to_rgb(hex);
  const b = hex_to_rgb(toward);
  const r = Math.round(a.r + (b.r - a.r) * t);
  const g = Math.round(a.g + (b.g - a.g) * t);
  const bl = Math.round(a.b + (b.b - a.b) * t);
  return `rgb(${r},${g},${bl})`;
}

// ---------------------------------------------------------------------------
//  Renderer2D
// ---------------------------------------------------------------------------

export class Renderer2D {
  /**
   * @param {HTMLCanvasElement} canvas  the #canvas-2d element
   * @param {object} system             { bodies, by_name, sun, planets, moons }
   * @param {Camera2D} camera           the shared 2D camera
   */
  constructor(canvas, system, camera) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.system = system;
    this.camera = camera;

    this.width = 0;                    // CSS pixels
    this.height = 0;
    this.dpr = 1;

    this.saturn = system.by_name.get('saturn') ?? null;

    // Offscreen layers, rebuilt on resize (nebula) / resize+slider (stars).
    this.nebula_layer = document.createElement('canvas');
    this.star_layer = document.createElement('canvas');
    this.star_density = 1;
    this.twinkle_stars = [];           // live-drawn bright stars {x,y,r,...}

    // Sprite / color caches (bounded: one entry per distinct body color).
    this.sun_glow_sprite = this.build_sun_glow_sprite();
    this.dot_glow_cache = new Map();   // color -> tiny soft-glow sprite
    this.star_glow_cache = new Map();  // color -> star halo sprite
    this.shade_cache = new Map();      // color -> {lit, dark, deep, rim, rim0}

    // Uppercased names, computed once (labels are drawn uppercase every frame).
    this.upper_names = new Map(system.bodies.map((b) => [b, b.name.toUpperCase()]));

    // Per-frame pick list — parallel arrays, reused across frames.
    const max_bodies = Math.max(system.bodies.length, 8);
    this.pick_bodies = new Array(max_bodies).fill(null);
    this.pick_x = new Float64Array(max_bodies);
    this.pick_y = new Float64Array(max_bodies);
    this.pick_r = new Float64Array(max_bodies);
    this.pick_orbit = new Float64Array(max_bodies);
    this.pick_count = 0;

    // Trail scratch buffers sized to the largest trail in the system.
    let trail_cap = 16;
    for (const planet of system.planets) {
      if (planet.trail) trail_cap = Math.max(trail_cap, planet.trail.capacity);
    }
    // +1 slot: the live body position is appended so trails always reach
    // their planet instead of ending one sample behind it.
    this._tx = new Float64Array(trail_cap + 1);
    this._ty = new Float64Array(trail_cap + 1);
    this._tn = 0;
    this._tminx = 0; this._tmaxx = 0; this._tminy = 0; this._tmaxy = 0;

    // Persistent visitor closure so Trail.for_each never allocates per frame.
    // Signature matches Trail.for_each's visit(x, y, age01); age is implied
    // by index (i / (n-1)), so we only need to store screen positions.
    this._trail_visit = (x, y) => {
      const cam = this.camera;
      const sx = (x - cam.cx) * cam.zoom + this.width * 0.5;
      const sy = this.height * 0.5 - (y - cam.cy) * cam.zoom;
      const i = this._tn;
      if (i >= this._tx.length) return;         // safety: never overflow scratch
      this._tx[i] = sx;
      this._ty[i] = sy;
      this._tn = i + 1;
      if (sx < this._tminx) this._tminx = sx;
      if (sx > this._tmaxx) this._tmaxx = sx;
      if (sy < this._tminy) this._tminy = sy;
      if (sy > this._tmaxy) this._tmaxy = sy;
    };

    // Label positions drawn this frame (for the moon overlap check).
    this.label_x = new Float64Array(max_bodies);
    this.label_y = new Float64Array(max_bodies);
    this.label_count = 0;

    // Scratch point for camera transforms (avoids per-call object literals).
    this._pt = { x: 0, y: 0 };

    // Sun screen position this frame — every shaded body lights toward it.
    this.sun_sx = 0;
    this.sun_sy = 0;

    // canvas2d letter-spacing is widely available but still feature-detect it.
    this.supports_letter_spacing = 'letterSpacing' in this.ctx;
  }

  // =========================================================================
  //  Sizing & offscreen layers
  // =========================================================================

  /**
   * Match the canvas buffer to the viewport at the given device-pixel ratio
   * and scale the context so all drawing code works in CSS pixels.
   */
  resize(width, height, dpr) {
    this.width = width;
    this.height = height;
    this.dpr = dpr || 1;
    this.canvas.width = Math.max(1, Math.round(width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(height * this.dpr));
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.build_nebula_layer();
    this.build_star_layer();
  }

  /** Rebuild the starfield for a new density (side-panel slider). */
  regenerate_stars(density) {
    this.star_density = density;
    if (this.width > 0) this.build_star_layer();
  }

  /**
   * The nebula layer: the deep-space base fill plus a few enormous, very
   * soft radial gradients. A hint of color, not a painting. Seeded so the
   * sky is the same on every load; rebuilt only on resize.
   */
  build_nebula_layer() {
    const layer = this.nebula_layer;
    layer.width = this.canvas.width;
    layer.height = this.canvas.height;
    const c = layer.getContext('2d');
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    const w = this.width;
    const h = this.height;
    c.fillStyle = BG_COLOR;
    c.fillRect(0, 0, w, h);

    const rng = mulberry32(0x5eed);
    const blob_count = 3 + (rng() < 0.5 ? 1 : 0);      // 3–4 blobs
    for (let i = 0; i < blob_count; i++) {
      const color = NEBULA_COLORS[i % NEBULA_COLORS.length];
      const cx = (0.12 + rng() * 0.76) * w;
      const cy = (0.10 + rng() * 0.80) * h;
      const radius = (0.45 + rng() * 0.45) * Math.max(w, h);
      const alpha = 0.04 + rng() * 0.03;               // 4–7%
      const g = c.createRadialGradient(cx, cy, 0, cx, cy, radius);
      g.addColorStop(0, rgba(color, alpha));
      g.addColorStop(0.55, rgba(color, alpha * 0.5));
      g.addColorStop(1, rgba(color, 0));
      c.fillStyle = g;
      c.fillRect(0, 0, w, h);
    }
  }

  /**
   * The starfield layer: ~700 × density screen-fixed stars in three tiers.
   * Bright stars get soft halos, and the very brightest get subtle 4-point
   * diffraction glints. A handful are held out of the layer and redrawn
   * live each frame with a slow twinkle. Rebuilt on resize / density change.
   */
  build_star_layer() {
    const layer = this.star_layer;
    layer.width = this.canvas.width;
    layer.height = this.canvas.height;
    const c = layer.getContext('2d');
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    const w = this.width;
    const h = this.height;
    const rng = mulberry32(0x57a7f1e1);
    const count = Math.round(STAR_BASE_COUNT * this.star_density);
    this.twinkle_stars.length = 0;

    for (let i = 0; i < count; i++) {
      const x = rng() * w;
      const y = rng() * h;

      // Color: mostly cool white, with rare warm and blue tints.
      const color_roll = rng();
      const color =
        color_roll < 0.85 ? STAR_COLOR_MAIN :
        color_roll < 0.92 ? STAR_COLOR_WARM : STAR_COLOR_BLUE;

      const tier = rng();
      if (tier < 0.70) {
        // Tiny dim points — the dust of the sky.
        const r = 0.4 + rng() * 0.35;
        c.globalAlpha = 0.22 + rng() * 0.28;
        c.fillStyle = color;
        c.beginPath();
        c.arc(x, y, r, 0, TAU);
        c.fill();
      } else if (tier < 0.95) {
        // Mid stars — visible but quiet.
        const r = 0.7 + rng() * 0.6;
        c.globalAlpha = 0.45 + rng() * 0.35;
        c.fillStyle = color;
        c.beginPath();
        c.arc(x, y, r, 0, TAU);
        c.fill();
      } else {
        // Bright stars — halo, occasional glint, occasional live twinkle.
        const r = 1.2 + rng();
        const alpha = 0.8 + rng() * 0.2;
        const phase = rng() * TAU;
        const speed = 0.8 + rng() * 1.4;
        const glint = rng() < 0.35;

        if (this.twinkle_stars.length < TWINKLE_COUNT) {
          // Held out of the static layer; drawn each frame with varying alpha.
          this.twinkle_stars.push({ x, y, r, color, base: alpha, phase, speed });
          continue;
        }

        const halo = this.star_glow_for(color);
        const g = r * 5;
        c.globalAlpha = alpha * 0.8;
        c.drawImage(halo, x - g, y - g, g * 2, g * 2);

        c.globalAlpha = alpha;
        c.fillStyle = color;
        c.beginPath();
        c.arc(x, y, r, 0, TAU);
        c.fill();

        if (glint) {
          // Subtle 4-point diffraction spikes on the brightest few.
          const len = r * 5.5;
          c.globalAlpha = alpha * 0.32;
          c.strokeStyle = color;
          c.lineWidth = 0.7;
          c.beginPath();
          c.moveTo(x - len, y);
          c.lineTo(x + len, y);
          c.moveTo(x, y - len);
          c.lineTo(x, y + len);
          c.stroke();
        }
      }
    }
    c.globalAlpha = 1;
  }

  // =========================================================================
  //  Sprites & color caches
  // =========================================================================

  /** Warm layered glow sprite for the Sun (drawn beneath the crisp disc). */
  build_sun_glow_sprite() {
    const size = 256;
    const sprite = document.createElement('canvas');
    sprite.width = sprite.height = size;
    const c = sprite.getContext('2d');
    const half = size / 2;
    const g = c.createRadialGradient(half, half, 0, half, half, half);
    g.addColorStop(0.00, 'rgba(255,247,224,0.95)');   // warm core #fff7e0
    g.addColorStop(0.10, 'rgba(255,228,170,0.70)');
    g.addColorStop(0.24, 'rgba(255,206,115,0.30)');   // #ffce73
    g.addColorStop(0.50, 'rgba(255,190,96,0.10)');
    g.addColorStop(1.00, 'rgba(255,180,80,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, size, size);
    return sprite;
  }

  /** Soft glow sprite for sub-4px body dots, cached per color. */
  glow_sprite_for(color) {
    let sprite = this.dot_glow_cache.get(color);
    if (sprite) return sprite;
    const size = 48;
    sprite = document.createElement('canvas');
    sprite.width = sprite.height = size;
    const c = sprite.getContext('2d');
    const half = size / 2;
    const g = c.createRadialGradient(half, half, 0, half, half, half);
    g.addColorStop(0, rgba(color, 0.5));
    g.addColorStop(0.4, rgba(color, 0.16));
    g.addColorStop(1, rgba(color, 0));
    c.fillStyle = g;
    c.fillRect(0, 0, size, size);
    this.dot_glow_cache.set(color, sprite);
    return sprite;
  }

  /** Halo sprite for bright background stars, cached per tint. */
  star_glow_for(color) {
    let sprite = this.star_glow_cache.get(color);
    if (sprite) return sprite;
    const size = 32;
    sprite = document.createElement('canvas');
    sprite.width = sprite.height = size;
    const c = sprite.getContext('2d');
    const half = size / 2;
    const g = c.createRadialGradient(half, half, 0, half, half, half);
    g.addColorStop(0, rgba(color, 0.65));
    g.addColorStop(0.3, rgba(color, 0.2));
    g.addColorStop(1, rgba(color, 0));
    c.fillStyle = g;
    c.fillRect(0, 0, size, size);
    this.star_glow_cache.set(color, sprite);
    return sprite;
  }

  /** Pre-mixed shading tones for a body color (lit side / shadow / rim). */
  shade_palette_for(color) {
    let pal = this.shade_cache.get(color);
    if (pal) return pal;
    pal = {
      lit: mix_hex(color, '#ffffff', 0.5),     // highlight toward the Sun
      dark: mix_hex(color, '#070a14', 0.6),    // limb darkening
      deep: mix_hex(color, '#04060c', 0.85),   // far-side shadow
      rim: rgba(color, 0.3),                   // atmosphere rim peak
      rim0: rgba(color, 0),
    };
    this.shade_cache.set(color, pal);
    return pal;
  }

  // =========================================================================
  //  Frame rendering
  // =========================================================================

  /** Draw one complete frame. Called by main.js while the 2D view is active. */
  render(frame_state) {
    if (this.width <= 0 || this.height <= 0) return;
    const ctx = this.ctx;
    const t = performance.now() * 0.001;      // real seconds, for slow motion FX

    this.draw_background(ctx, t);
    this.draw_origin_crosshair(ctx);

    if (frame_state.settings.show_trails) this.draw_trails(ctx);

    this.pick_count = 0;
    this.draw_bodies(ctx, t);

    this.draw_focus_rings(ctx, frame_state, t);
    this.draw_labels(ctx, frame_state);
    this.draw_rulers(ctx);
  }

  // -- background -----------------------------------------------------------

  draw_background(ctx, t) {
    const w = this.width;
    const h = this.height;
    // Two blits: nebula (includes the base fill) + starfield.
    ctx.drawImage(this.nebula_layer, 0, 0, w, h);
    ctx.drawImage(this.star_layer, 0, 0, w, h);

    // A handful of bright stars twinkle live — cheap, and it makes the
    // sky feel alive without touching the pre-rendered layer.
    const twinkles = this.twinkle_stars;
    if (twinkles.length > 0) {
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < twinkles.length; i++) {
        const tw = twinkles[i];
        const a = tw.base * (0.55 + 0.45 * Math.sin(t * tw.speed + tw.phase));
        const halo = this.star_glow_for(tw.color);
        const g = tw.r * 4.5;
        ctx.globalAlpha = a * 0.8;
        ctx.drawImage(halo, tw.x - g, tw.y - g, g * 2, g * 2);
        ctx.globalAlpha = a;
        ctx.fillStyle = tw.color;
        ctx.beginPath();
        ctx.arc(tw.x, tw.y, tw.r, 0, TAU);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  /** Subtle full-viewport crosshair through the world origin (Sun's rest). */
  draw_origin_crosshair(ctx) {
    const origin = this.camera.world_to_screen(0, 0, this._pt);
    const sx = origin.x;
    const sy = origin.y;
    const w = this.width;
    const h = this.height;
    const margin = 40;
    if (sx < -margin || sx > w + margin || sy < -margin || sy > h + margin) return;

    ctx.strokeStyle = 'rgba(138,180,255,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx, h);
    ctx.moveTo(0, sy);
    ctx.lineTo(w, sy);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(138,180,255,0.25)';
    ctx.beginPath();
    ctx.arc(sx, sy, 3.5, 0, TAU);
    ctx.stroke();
  }

  // -- comet trails ---------------------------------------------------------

  /**
   * Planet trails as connected polylines, alpha ramping oldest → newest.
   * Segments are grouped into TRAIL_BUCKETS alpha/width buckets so each
   * trail costs at most ~24 stroke() calls instead of ~360.
   */
  draw_trails(ctx) {
    const cam = this.camera;
    const w = this.width;
    const h = this.height;
    const margin = 40;

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const planets = this.system.planets;
    for (let p = 0; p < planets.length; p++) {
      const planet = planets[p];
      const trail = planet.trail;
      if (!trail || trail.length < 2) continue;

      // Same visibility rule as the planet dot: when the whole orbit is
      // tiny on screen, the trail would just smear the center — skip it.
      if (planet.dist_to_sun * cam.zoom < PLANET_ORBIT_MIN_PX) continue;

      // Close-up fade: a trail slicing through a large planet disc reads as
      // an artifact, so it dissolves as the planet grows past ~28px.
      const radius_px = planet.radius * cam.zoom;
      const closeup_fade = Math.min(1, Math.max(0, 1 - (radius_px - 28) / 50));
      if (closeup_fade <= 0.02) continue;

      // Project every point to screen space, tracking the bounding box.
      this._tn = 0;
      this._tminx = Infinity;
      this._tmaxx = -Infinity;
      this._tminy = Infinity;
      this._tmaxy = -Infinity;
      trail.for_each(this._trail_visit);
      // Append the live position so the trail meets the planet exactly.
      this._trail_visit(planet.x, planet.y);
      const n = this._tn;
      if (n < 2) continue;

      // Whole trail off-screen? One rejection, zero strokes.
      if (
        this._tmaxx < -margin || this._tminx > w + margin ||
        this._tmaxy < -margin || this._tminy > h + margin
      ) {
        continue;
      }

      ctx.strokeStyle = planet.color;
      const xs = this._tx;
      const ys = this._ty;
      const inv = 1 / (n - 1);
      let bucket = -1;

      for (let i = 1; i < n; i++) {
        const b = Math.min(TRAIL_BUCKETS - 1, ((i * inv) * TRAIL_BUCKETS) | 0);
        if (b !== bucket) {
          if (bucket >= 0) ctx.stroke();
          const k = (b + 0.5) / TRAIL_BUCKETS;   // bucket midpoint age 0..1
          ctx.globalAlpha = k * TRAIL_MAX_ALPHA * closeup_fade;
          ctx.lineWidth = TRAIL_MIN_WIDTH + k * (TRAIL_MAX_WIDTH - TRAIL_MIN_WIDTH);
          ctx.beginPath();
          ctx.moveTo(xs[i - 1], ys[i - 1]);      // reconnect to previous point
          bucket = b;
        }
        ctx.lineTo(xs[i], ys[i]);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // -- bodies ---------------------------------------------------------------

  draw_bodies(ctx, t) {
    const cam = this.camera;
    const cap = DISC_CAP_FACTOR * Math.max(this.width, this.height);

    // Sun screen position first: every shaded body lights toward it, and it
    // must be known even if the Sun itself is culled off-screen.
    const sun = this.system.sun;
    const sp = cam.world_to_screen(sun.x, sun.y, this._pt);
    this.sun_sx = sp.x;
    this.sun_sy = sp.y;

    this.draw_sun(ctx, sun, cap, t);

    const planets = this.system.planets;
    for (let i = 0; i < planets.length; i++) {
      this.draw_planet(ctx, planets[i], cap);
    }

    const moons = this.system.moons;
    for (let i = 0; i < moons.length; i++) {
      this.draw_moon(ctx, moons[i], cap);
    }
  }

  draw_sun(ctx, sun, cap, t) {
    const cam = this.camera;
    const w = this.width;
    const h = this.height;
    const pos = cam.world_to_screen(sun.x, sun.y, this._pt);
    const sx = pos.x;
    const sy = pos.y;

    const r_px = Math.min(Math.max(sun.radius * cam.zoom, SUN_MIN_PX), cap);

    // Zoomed all the way in: the disc swallows the viewport — flat fill.
    if (this.covers_viewport(sx, sy, r_px)) {
      ctx.fillStyle = sun.color;
      ctx.fillRect(0, 0, w, h);
      this.push_pick(sun, sx, sy, r_px, Infinity);
      return;
    }

    // Glow radius: ~5× the disc, clamped so deep zooms stay reasonable,
    // with a slow gentle pulse (scale 1.00–1.03).
    const pulse = 1.015 + 0.015 * Math.sin(t * 0.9);
    const glow_px = Math.min(r_px * 5, r_px + 600) * pulse;

    // Cull with the glow margin — a culled Sun is not drawn, not pickable,
    // and not labeled, exactly like any other off-screen body.
    if (sx + glow_px < 0 || sx - glow_px > w || sy + glow_px < 0 || sy - glow_px > h) {
      return;
    }

    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(this.sun_glow_sprite, sx - glow_px, sy - glow_px, glow_px * 2, glow_px * 2);
    ctx.globalCompositeOperation = 'source-over';

    // Crisp disc: warm white core easing to the conf color at the limb.
    const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, r_px);
    g.addColorStop(0, '#fff7e0');
    g.addColorStop(0.55, '#ffe9b8');
    g.addColorStop(1, sun.color);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(sx, sy, r_px, 0, TAU);
    ctx.fill();

    this.push_pick(sun, sx, sy, r_px, Infinity);
  }

  draw_planet(ctx, planet, cap) {
    const cam = this.camera;
    const r_true = planet.radius * cam.zoom;
    const orbit_px = planet.dist_to_sun * cam.zoom;

    // True scale, with a minimum dot ONLY while the orbit reads on screen.
    // Fully zoomed out, planets vanish rather than piling into a center blob.
    let r_px;
    if (r_true >= PLANET_MIN_DOT_PX) r_px = Math.min(r_true, cap);
    else if (orbit_px >= PLANET_ORBIT_MIN_PX) r_px = PLANET_MIN_DOT_PX;
    else return;

    const pos = cam.world_to_screen(planet.x, planet.y, this._pt);
    const sx = pos.x;
    const sy = pos.y;

    // Rings only at true scale (never around the clamped min-dot).
    const has_rings =
      planet === this.saturn &&
      r_true >= PLANET_MIN_DOT_PX &&
      r_px * RING_BANDS[RING_BANDS.length - 1].outer >= RING_MIN_OUTER_PX;

    // Cull with a margin generous enough for rings / rim glow / dot glow.
    const reach = has_rings
      ? r_px * RING_BANDS[RING_BANDS.length - 1].outer + 8
      : r_px * 1.35 + 14;
    if (
      sx + reach < 0 || sx - reach > this.width ||
      sy + reach < 0 || sy - reach > this.height
    ) {
      return;
    }

    if (this.covers_viewport(sx, sy, r_px)) {
      ctx.fillStyle = planet.color;
      ctx.fillRect(0, 0, this.width, this.height);
      this.push_pick(planet, sx, sy, r_px, orbit_px);
      return;
    }

    if (has_rings) this.draw_saturn_rings(ctx, sx, sy, r_px);
    this.draw_body_disc(ctx, planet, sx, sy, r_px);
    this.push_pick(planet, sx, sy, r_px, orbit_px);
  }

  draw_moon(ctx, moon, cap) {
    const cam = this.camera;
    const orbit_px = moon.orbit_radius * cam.zoom;
    if (orbit_px < MOON_ORBIT_MIN_PX) return;   // orbit unreadably small — skip

    const r_px = Math.min(Math.max(moon.radius * cam.zoom, MOON_MIN_DOT_PX), cap);
    const pos = cam.world_to_screen(moon.x, moon.y, this._pt);
    const sx = pos.x;
    const sy = pos.y;

    const reach = r_px + 12;
    if (
      sx + reach < 0 || sx - reach > this.width ||
      sy + reach < 0 || sy - reach > this.height
    ) {
      return;
    }

    if (this.covers_viewport(sx, sy, r_px)) {
      ctx.fillStyle = moon.color;
      ctx.fillRect(0, 0, this.width, this.height);
      this.push_pick(moon, sx, sy, r_px, orbit_px);
      return;
    }

    this.draw_body_disc(ctx, moon, sx, sy, r_px);
    this.push_pick(moon, sx, sy, r_px, orbit_px);
  }

  /**
   * A planet/moon disc. At >= 4px: radial-gradient shading lit from the
   * Sun's screen direction, with limb darkening into a deep far-side shadow;
   * planets >= 10px also get a faint atmosphere rim in their own color.
   * Below 4px: a flat dot over a tiny pre-rendered per-color glow.
   */
  draw_body_disc(ctx, body, sx, sy, r_px) {
    if (r_px < SHADED_MIN_PX) {
      const sprite = this.glow_sprite_for(body.color);
      const g = Math.min(Math.max(r_px * 4.5, 6), 20);
      ctx.globalCompositeOperation = 'lighter';
      ctx.drawImage(sprite, sx - g, sy - g, g * 2, g * 2);
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = body.color;
      ctx.beginPath();
      ctx.arc(sx, sy, r_px, 0, TAU);
      ctx.fill();
      return;
    }

    // Unit direction toward the Sun in screen space.
    let dx = this.sun_sx - sx;
    let dy = this.sun_sy - sy;
    const len = Math.hypot(dx, dy);
    if (len > 1e-6) {
      dx /= len;
      dy /= len;
    } else {
      dx = -DIAG;                     // degenerate overlap: light from top-left
      dy = -DIAG;
    }

    const pal = this.shade_palette_for(body.color);
    const ox = dx * r_px * 0.42;      // highlight center, offset sunward
    const oy = dy * r_px * 0.42;
    const g = ctx.createRadialGradient(
      sx + ox, sy + oy, r_px * 0.05,
      sx + ox, sy + oy, r_px * 2.0
    );
    g.addColorStop(0, pal.lit);
    g.addColorStop(0.3, body.color);
    g.addColorStop(0.62, pal.dark);
    g.addColorStop(1, pal.deep);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(sx, sy, r_px, 0, TAU);
    ctx.fill();

    // Faint atmosphere rim, planets only, once the disc is big enough.
    if (body.type === 'planet' && r_px >= RIM_MIN_PX) {
      const rim = ctx.createRadialGradient(sx, sy, r_px * 0.9, sx, sy, r_px * 1.3);
      rim.addColorStop(0, pal.rim0);
      rim.addColorStop(0.25, pal.rim);     // peak sits right at the limb
      rim.addColorStop(1, pal.rim0);
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = rim;
      ctx.beginPath();
      ctx.arc(sx, sy, r_px * 1.3, 0, TAU);
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  /**
   * Saturn's rings as a top-down annulus behind the disc: C / B / A bands
   * in pale gold with the darker Cassini division between B and A. Each
   * band is one stroked circle whose line width spans the band.
   */
  draw_saturn_rings(ctx, sx, sy, r_px) {
    for (let i = 0; i < RING_BANDS.length; i++) {
      const band = RING_BANDS[i];
      const mid = ((band.inner + band.outer) / 2) * r_px;
      ctx.strokeStyle = RING_COLOR;
      ctx.globalAlpha = band.alpha;
      ctx.lineWidth = (band.outer - band.inner) * r_px;
      ctx.beginPath();
      ctx.arc(sx, sy, mid, 0, TAU);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /** True when a disc at (sx, sy) with radius r covers the whole viewport. */
  covers_viewport(sx, sy, r) {
    if (r < Math.min(this.width, this.height) * 0.5) return false;
    const dx = Math.max(Math.abs(sx), Math.abs(sx - this.width));
    const dy = Math.max(Math.abs(sy), Math.abs(sy - this.height));
    return dx * dx + dy * dy <= r * r;
  }

  /** Record a drawn body for pick() and the ring/label passes. */
  push_pick(body, sx, sy, r_px, orbit_px) {
    const i = this.pick_count;
    if (i >= this.pick_bodies.length) return;
    this.pick_bodies[i] = body;
    this.pick_x[i] = sx;
    this.pick_y[i] = sy;
    this.pick_r[i] = r_px;
    this.pick_orbit[i] = orbit_px === Infinity ? Number.MAX_VALUE : orbit_px;
    this.pick_count = i + 1;
  }

  // -- hover & selection rings ----------------------------------------------

  draw_focus_rings(ctx, frame_state, t) {
    const hovered = frame_state.hovered;
    const selected = frame_state.selected;
    if (!hovered && !selected) return;

    for (let i = 0; i < this.pick_count; i++) {
      const body = this.pick_bodies[i];
      const sx = this.pick_x[i];
      const sy = this.pick_y[i];
      const r = this.pick_r[i];

      // Hover: a quiet ring in the body's own color. Skipped when the body
      // is also selected — the animated selection ring already marks it.
      if (body === hovered && body !== selected) {
        const ring_r = Math.max(r + 5, 10);
        ctx.strokeStyle = rgba(body.color, 0.6);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(sx, sy, ring_r, 0, TAU);
        ctx.stroke();
      }

      // Selection: two thin accent arcs slowly orbiting, plus a faint halo.
      if (body === selected) {
        const ring_r = Math.max(r + 7, 11);
        const a0 = t * 0.7;

        ctx.strokeStyle = rgba(ACCENT, 0.12);
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.arc(sx, sy, ring_r + 1, 0, TAU);
        ctx.stroke();

        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(sx, sy, ring_r, a0, a0 + 2.1);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(sx, sy, ring_r, a0 + Math.PI, a0 + Math.PI + 2.1);
        ctx.stroke();
      }
    }
  }

  // -- name labels ----------------------------------------------------------

  draw_labels(ctx, frame_state) {
    const settings = frame_state.settings;
    if (!settings.show_labels) return;
    const density = settings.label_density;   // live value — re-read each frame
    if (density <= 0) return;

    // Higher density shows moon labels sooner (smaller orbit threshold).
    const moon_gate_px = lerp(90, 18, density);

    this.label_count = 0;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    if (this.supports_letter_spacing) ctx.letterSpacing = '0.9px';

    for (let i = 0; i < this.pick_count; i++) {
      const body = this.pick_bodies[i];
      const sx = this.pick_x[i];
      const sy = this.pick_y[i];
      const r = this.pick_r[i];
      const orbit = this.pick_orbit[i];
      const is_moon = body.type === 'moon';

      if (is_moon) {
        if (orbit < moon_gate_px) continue;
      } else if (orbit < 40 && r < 3) {
        continue;   // planet too small AND orbit too tight to be worth naming
      }

      // Right-below the body, along the screen diagonal, past the disc edge.
      const d = r + 8;
      const tx = sx + d * DIAG;
      const ty = sy + d * DIAG;

      // Cheap overlap rejection for moon labels in crowded systems.
      if (is_moon && this.label_too_close(tx, ty)) continue;

      const focused = body === frame_state.hovered || body === frame_state.selected;

      // Thin tick from the disc edge out to the text anchor.
      ctx.strokeStyle = focused ? 'rgba(233,237,246,0.45)' : 'rgba(233,237,246,0.20)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(sx + r * DIAG, sy + r * DIAG);
      ctx.lineTo(tx, ty);
      ctx.stroke();

      ctx.font = is_moon ? MOON_LABEL_FONT : LABEL_FONT;
      ctx.fillStyle = focused
        ? 'rgba(233,237,246,1)'
        : is_moon ? 'rgba(233,237,246,0.6)' : 'rgba(233,237,246,0.78)';
      ctx.fillText(this.upper_names.get(body) ?? body.name, tx + 3, ty + 2);

      const li = this.label_count;
      if (li < this.label_x.length) {
        this.label_x[li] = tx;
        this.label_y[li] = ty;
        this.label_count = li + 1;
      }
    }

    if (this.supports_letter_spacing) ctx.letterSpacing = '0px';
  }

  label_too_close(x, y) {
    const min2 = LABEL_MIN_GAP_PX * LABEL_MIN_GAP_PX;
    for (let i = 0; i < this.label_count; i++) {
      const dx = x - this.label_x[i];
      const dy = y - this.label_y[i];
      if (dx * dx + dy * dy < min2) return true;
    }
    return false;
  }

  // -- adaptive edge rulers -------------------------------------------------

  /**
   * Distance rulers along the top and left edges. Tick spacing is a power of
   * ten chosen so majors land 90–900 px apart; ticks are generated from the
   * visible world range only, so the rulers work at any pan distance.
   */
  draw_rulers(ctx) {
    const cam = this.camera;
    const zoom = cam.zoom;
    const w = this.width;
    const h = this.height;

    // Power of ten so major tick spacing lands in [90, 900) px.
    const p = Math.ceil(Math.log10(90 / zoom));
    const spacing_m = Math.pow(10, p);
    const minor_m = spacing_m / 10;
    const minor_px = minor_m * zoom;

    // Visible world range, straight from the screen edges (never from origin).
    const wx0 = -w * 0.5 / zoom + cam.cx;      // world x at screen left
    const wx1 = w * 0.5 / zoom + cam.cx;       // world x at screen right
    const wy_bot = -h * 0.5 / zoom + cam.cy;   // world y at screen bottom
    const wy_top = h * 0.5 / zoom + cam.cy;    // world y at screen top

    // Hairline ruler baselines, inset ~0 from the edges.
    ctx.strokeStyle = 'rgba(138,180,255,0.10)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, 0.5);
    ctx.lineTo(w, 0.5);
    ctx.moveTo(0.5, 0);
    ctx.lineTo(0.5, h);
    ctx.stroke();

    // Minor ticks (1/10 spacing), only when they'd be at least 9px apart.
    if (minor_px >= 9) {
      ctx.strokeStyle = 'rgba(138,180,255,0.16)';
      ctx.beginPath();
      for (let k = Math.ceil(wx0 / minor_m), k1 = Math.floor(wx1 / minor_m); k <= k1; k++) {
        if (k % 10 === 0) continue;            // majors drawn separately
        const sx = (k * minor_m - cam.cx) * zoom + w * 0.5;
        ctx.moveTo(sx, 0);
        ctx.lineTo(sx, 3.5);
      }
      for (let k = Math.ceil(wy_bot / minor_m), k1 = Math.floor(wy_top / minor_m); k <= k1; k++) {
        if (k % 10 === 0) continue;
        const sy = h * 0.5 - (k * minor_m - cam.cy) * zoom;
        ctx.moveTo(0, sy);
        ctx.lineTo(3.5, sy);
      }
      ctx.stroke();
    }

    // Major ticks + labels (distance-from-origin, m/km/Mm/Bm/Tm/Qm/Em ladder).
    // Label precision adapts to how far the view has panned: when ticks are
    // 1 Bm apart but 1.1 Tm from the origin, three significant digits would
    // print the same "1.1 Tm" on every tick — grow digits until they differ.
    const label_digits = (value) => {
      const abs = Math.abs(value);
      if (abs === 0) return 3;
      return Math.max(3, Math.ceil(Math.log10(abs / spacing_m)) + 1);
    };
    ctx.strokeStyle = 'rgba(138,180,255,0.32)';
    ctx.fillStyle = 'rgba(149,156,176,0.9)';
    ctx.font = RULER_FONT;
    ctx.textAlign = 'left';
    ctx.beginPath();

    ctx.textBaseline = 'alphabetic';
    for (let k = Math.ceil(wx0 / spacing_m), k1 = Math.floor(wx1 / spacing_m); k <= k1; k++) {
      const sx = (k * spacing_m - cam.cx) * zoom + w * 0.5;
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, 7);
      // Skip the top-left corner so top labels never collide with left ones.
      if (sx > 34 && sx < w - 8) {
        const value = Math.abs(k * spacing_m);
        ctx.fillText(format_distance(value, label_digits(value)), sx + 4, 17);
      }
    }

    ctx.textBaseline = 'middle';
    for (let k = Math.ceil(wy_bot / spacing_m), k1 = Math.floor(wy_top / spacing_m); k <= k1; k++) {
      const sy = h * 0.5 - (k * spacing_m - cam.cy) * zoom;
      ctx.moveTo(0, sy);
      ctx.lineTo(7, sy);
      if (sy > 26 && sy < h - 8) {
        const value = Math.abs(k * spacing_m);
        ctx.fillText(format_distance(value, label_digits(value)), 10, sy);
      }
    }
    ctx.stroke();
  }

  // =========================================================================
  //  Picking
  // =========================================================================

  /**
   * The body under a screen point, or null. Tests only bodies drawn this
   * frame; the smallest hit body wins, so moons beat their planet and
   * planets beat the Sun's big disc/glow.
   */
  pick(sx, sy) {
    let best = null;
    let best_r = Infinity;
    for (let i = 0; i < this.pick_count; i++) {
      const r = this.pick_r[i];
      if (r >= best_r) continue;
      const hit_r = Math.max(r + 4, 11);
      const dx = sx - this.pick_x[i];
      const dy = sy - this.pick_y[i];
      if (dx * dx + dy * dy <= hit_r * hit_r) {
        best = this.pick_bodies[i];
        best_r = r;
      }
    }
    return best;
  }
}
