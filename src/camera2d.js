// ============================================================================
//  camera2d.js — the 2D view: a window center in world coordinates + a zoom
//  (pixels per meter). The world never moves; only this window does.
//
//  Also owns smooth "fly to" animations and body following, both used by
//  click-to-focus and the side-panel body list.
// ============================================================================

// Default view frames the inner system: Mars's orbit (±2.1e11 m) fills a
// comfortable fraction of the viewport.
const INNER_SYSTEM_RADIUS = 2.45e11;   // [m] a little beyond Mars

export const MIN_ZOOM = 4e-13;         // pixels per meter (whole system tiny)
export const MAX_ZOOM = 5e-4;          // deep close-up on small moons

const FLY_DURATION = 1.1;              // seconds for a camera flight

/** Smoothstep-ish ease for camera flights. */
function ease_in_out(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export class Camera2D {
  constructor(viewport_width, viewport_height) {
    this.width = viewport_width;
    this.height = viewport_height;

    this.cx = 0;              // world x at screen center [m]
    this.cy = 0;              // world y at screen center [m]
    this.zoom = 1e-9;         // pixels per meter
    this.default_zoom = 1e-9; // zoom that reads as "x1.00" in the HUD

    this.follow_target = null;   // Body being tracked, or null

    // In-progress flight (null when idle)
    this.flight = null;

    this.reset();
  }

  resize(viewport_width, viewport_height) {
    this.width = viewport_width;
    this.height = viewport_height;
    this.default_zoom = this.compute_default_zoom();
  }

  compute_default_zoom() {
    const min_dim = Math.min(this.width, this.height);
    return (0.42 * min_dim) / INNER_SYSTEM_RADIUS;
  }

  /** Frame the inner system, centered on the origin. Cancels follow/flight. */
  reset() {
    this.default_zoom = this.compute_default_zoom();
    this.follow_target = null;
    this.flight = null;
    this.cx = 0;
    this.cy = 0;
    this.zoom = this.default_zoom;
  }

  /** Recenter on the origin at the current zoom (Space key). */
  recenter() {
    this.fly_to(0, 0, this.zoom);
    this.follow_target = null;
  }

  // -- coordinate transforms ------------------------------------------------

  /** World meters -> screen pixels. +y world is up, so screen y flips. */
  world_to_screen(wx, wy, out = { x: 0, y: 0 }) {
    out.x = (wx - this.cx) * this.zoom + this.width / 2;
    out.y = this.height / 2 - (wy - this.cy) * this.zoom;
    return out;
  }

  /** Screen pixels -> world meters. */
  screen_to_world(sx, sy, out = { x: 0, y: 0 }) {
    out.x = (sx - this.width / 2) / this.zoom + this.cx;
    out.y = (this.height / 2 - sy) / this.zoom + this.cy;
    return out;
  }

  /** Half-extents of the visible world rectangle [m]. */
  visible_half_extents() {
    return {
      hx: this.width / (2 * this.zoom),
      hy: this.height / (2 * this.zoom),
    };
  }

  // -- interaction ----------------------------------------------------------

  /** Drag pan by a screen-pixel delta. Breaks following. */
  pan_by_pixels(dx_px, dy_px) {
    this.cx -= dx_px / this.zoom;
    this.cy += dy_px / this.zoom;   // screen y is flipped vs world y
    this.follow_target = null;
    this.flight = null;
  }

  /** Wheel zoom anchored at a screen point (the world spot under the cursor
   *  stays under the cursor). */
  zoom_at(sx, sy, factor) {
    const anchor = this.screen_to_world(sx, sy);
    this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.zoom * factor));
    // Re-solve the center so `anchor` maps back to (sx, sy).
    this.cx = anchor.x - (sx - this.width / 2) / this.zoom;
    this.cy = anchor.y - (this.height / 2 - sy) / this.zoom;
    this.flight = null;
    // Note: following survives zoom (you can zoom while tracking a planet);
    // the follow logic recenters on the next update.
  }

  // -- flights & following --------------------------------------------------

  /** Animate smoothly to a world center + zoom. */
  fly_to(target_cx, target_cy, target_zoom, duration = FLY_DURATION) {
    this.flight = {
      from_cx: this.cx,
      from_cy: this.cy,
      from_zoom: this.zoom,
      to_cx: target_cx,
      to_cy: target_cy,
      to_zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, target_zoom)),
      t: 0,
      duration,
    };
  }

  /** Fly to a body and start following it at a flattering zoom. */
  fly_to_body(body) {
    this.follow_target = body;
    const zoom = this.flattering_zoom(body);
    this.fly_to(body.x, body.y, zoom);
  }

  /** A zoom that makes `body` and its neighborhood look good. */
  flattering_zoom(body) {
    const min_dim = Math.min(this.width, this.height);
    if (body.type === 'star') {
      // Show the Sun with Mercury's orbit around it.
      return (0.35 * min_dim) / 6e10;
    }
    if (body.type === 'moon') {
      // Frame the moon's orbit around its parent.
      return (0.3 * min_dim) / Math.max(body.orbit_radius, body.radius * 8);
    }
    // Planet: frame its moon system if it has one, else ~40 planet radii.
    // A single far-flung outlier (Iapetus orbits ~3× beyond Titan) would
    // shrink the whole family to dots, so when the outermost orbit dwarfs
    // the next one, frame the second-outermost instead.
    const orbits = body.moons
      .map((moon) => moon.orbit_radius)
      .sort((a, b) => b - a);
    let frame_orbit = 0;
    if (orbits.length === 1) {
      frame_orbit = orbits[0] * 1.25;
    } else if (orbits.length > 1) {
      frame_orbit =
        orbits[0] > orbits[1] * 2.2 ? orbits[1] * 1.35 : orbits[0] * 1.25;
    }
    const frame_radius = Math.max(frame_orbit, body.radius * 26);
    return (0.35 * min_dim) / frame_radius;
  }

  follow(body) {
    this.follow_target = body;
  }

  clear_follow() {
    this.follow_target = null;
  }

  /** Advance flight animation + follow tracking. `dt_real` = real seconds. */
  update(dt_real) {
    if (this.flight) {
      const flight = this.flight;
      flight.t = Math.min(1, flight.t + dt_real / flight.duration);
      const k = ease_in_out(flight.t);

      // If flying toward a followed body, chase its live position.
      if (this.follow_target) {
        flight.to_cx = this.follow_target.x;
        flight.to_cy = this.follow_target.y;
      }

      this.cx = flight.from_cx + (flight.to_cx - flight.from_cx) * k;
      this.cy = flight.from_cy + (flight.to_cy - flight.from_cy) * k;
      // Zoom interpolates in log space so the flight feels uniform.
      this.zoom = Math.exp(
        Math.log(flight.from_zoom) +
          (Math.log(flight.to_zoom) - Math.log(flight.from_zoom)) * k
      );

      if (flight.t >= 1) this.flight = null;
    } else if (this.follow_target) {
      // Hard-lock onto the target: the world moves, the target doesn't.
      this.cx = this.follow_target.x;
      this.cy = this.follow_target.y;
    }
  }
}
