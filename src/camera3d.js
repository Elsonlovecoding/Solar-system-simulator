// ============================================================================
//  camera3d.js — the 3D camera brain: a PerspectiveCamera + OrbitControls
//  pair owned by Renderer3D, wrapped with the same flight/follow vocabulary
//  the 2D camera speaks (reset / recenter / focus_body / clear_follow).
//
//  All positions here are *display-space* Three.js units (1 unit = 1e9 m);
//  the renderer hands us accessor functions so we never touch the physics
//  state or the display-mapping math directly.
// ============================================================================

import * as THREE from 'three';

// Home pose: a 3/4 aerial view that frames the Sun plus the four inner
// orbits comfortably at 16:9 (Mars sits ~207 units out; this pose sees
// ~283 units of half-height at the origin plane).
const HOME_POSITION = new THREE.Vector3(90, 300, 520);
const HOME_TARGET = new THREE.Vector3(0, 0, 0);

const FLY_DURATION = 1.1;      // seconds — reset / recenter flights
const FOCUS_DURATION = 1.4;    // seconds — flying to a body
const FOCUS_ELEVATION = (18 * Math.PI) / 180;  // look-down angle when focused
const MIN_FOCUS_DISTANCE = 3.5;                // units — even for tiny moons

/** Cubic in-out ease, matching the feel of the 2D camera's flights. */
function ease_in_out(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export class Camera3D {
  /**
   * @param {THREE.PerspectiveCamera} three_camera  the camera to drive
   * @param {OrbitControls} controls                controls bound to it
   * @param {(body) => THREE.Vector3} get_display_position  live display pos
   * @param {(body) => number} get_visual_radius    display-space radius
   */
  constructor(three_camera, controls, get_display_position, get_visual_radius) {
    this.camera = three_camera;
    this.controls = controls;
    this.get_display_position = get_display_position;
    this.get_visual_radius = get_visual_radius;

    this.follow_target = null;   // Body being tracked, or null (read by main.js)
    this.flight = null;          // in-progress animated move, or null

    // Reusable temporaries — update() runs every frame, so no allocations.
    this._last_follow_pos = new THREE.Vector3();
    this._delta = new THREE.Vector3();
    this._offset = new THREE.Vector3();

    // Start at the home pose instantly (no flight on boot).
    this.camera.position.copy(HOME_POSITION);
    this.controls.target.copy(HOME_TARGET);
    this.camera.lookAt(HOME_TARGET);
    this.controls.update();
  }

  // -- public verbs (called by main.js) -------------------------------------

  /** Fly back to the home aerial view of the inner system. Clears follow. */
  reset() {
    this.follow_target = null;
    this._begin_flight(
      HOME_POSITION.clone(),
      HOME_TARGET.clone(),
      FLY_DURATION
    );
  }

  /**
   * Keep the current viewing offset (direction + distance) but fly the
   * orbit target back to the origin. Clears follow.
   */
  recenter() {
    this.follow_target = null;
    const offset = this.camera.position.clone().sub(this.controls.target);
    this._begin_flight(offset, new THREE.Vector3(0, 0, 0), FLY_DURATION);
  }

  /**
   * Smoothly fly to `body` and start following it. The destination keeps
   * the user's current azimuth around the target so the flight never spins
   * the world unexpectedly; elevation settles at a gentle look-down angle.
   */
  focus_body(body) {
    this.follow_target = body;

    const body_pos = this.get_display_position(body);
    const distance = Math.max(
      this.get_visual_radius(body) * 5.5,
      MIN_FOCUS_DISTANCE
    );

    // Preserve the current camera azimuth (heading in the ecliptic plane).
    this._offset.copy(this.camera.position).sub(this.controls.target);
    let azimuth = Math.atan2(this._offset.x, this._offset.z);
    if (!Number.isFinite(azimuth)) azimuth = 0;

    const horizontal = distance * Math.cos(FOCUS_ELEVATION);
    const chase_offset = new THREE.Vector3(
      horizontal * Math.sin(azimuth),
      distance * Math.sin(FOCUS_ELEVATION),
      horizontal * Math.cos(azimuth)
    );

    this._begin_flight(
      body_pos.clone().add(chase_offset),
      body_pos.clone(),
      FOCUS_DURATION,
      body,
      chase_offset
    );
  }

  /** Stop following. The camera stays exactly where it is — no snap. */
  clear_follow() {
    this.follow_target = null;
    if (this.flight && this.flight.chase_body) {
      // Let an in-progress focus flight glide to where the body is right
      // now instead of chasing it further.
      this.flight.chase_body = null;
    }
  }

  /**
   * Advance flight animation or apply the follow delta, then let
   * OrbitControls apply damping / user input. Called by Renderer3D.render.
   */
  update(dt_real) {
    if (this.flight) {
      const flight = this.flight;
      flight.t = Math.min(1, flight.t + dt_real / flight.duration);
      const k = ease_in_out(flight.t);

      // A focus flight chases the body's live position so fast movers
      // (inner planets, moons) are still centered when we arrive.
      if (flight.chase_body) {
        const live = this.get_display_position(flight.chase_body);
        flight.to_target.copy(live);
        flight.to_pos.copy(live).add(flight.chase_offset);
      }

      this.camera.position.lerpVectors(flight.from_pos, flight.to_pos, k);
      this.controls.target.lerpVectors(flight.from_target, flight.to_target, k);

      if (flight.t >= 1) {
        // Seed follow tracking from the body's position at arrival so the
        // first follow frame applies a zero delta (no visible hitch).
        if (flight.chase_body && this.follow_target === flight.chase_body) {
          this._last_follow_pos.copy(
            this.get_display_position(flight.chase_body)
          );
        }
        this.flight = null;
      }
    } else if (this.follow_target) {
      // FOLLOW: translate both camera and target by the body's motion since
      // last frame. The body stays put on screen while the user remains
      // free to orbit / zoom around it with the mouse.
      const live = this.get_display_position(this.follow_target);
      this._delta.copy(live).sub(this._last_follow_pos);
      this.camera.position.add(this._delta);
      this.controls.target.add(this._delta);
      this._last_follow_pos.copy(live);
    }

    this.controls.update();
  }

  // -- internals ------------------------------------------------------------

  _begin_flight(to_pos, to_target, duration, chase_body = null, chase_offset = null) {
    this.flight = {
      from_pos: this.camera.position.clone(),
      from_target: this.controls.target.clone(),
      to_pos,
      to_target,
      chase_body,
      chase_offset,
      t: 0,
      duration,
    };
  }
}
