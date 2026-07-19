// ============================================================================
//  physics.js — the simulation loop core.
//
//  * The Sun wobbles on a small prescribed circle near the origin
//    (a nod to the barycentric dance Jupiter forces on it).
//  * Planets feel real Newtonian gravity toward the Sun's *live* position:
//    a = G·M / r², integrated with semi-implicit (symplectic) Euler.
//  * Moons ride Kepler circles around their parent's live position.
//
//  Large frame steps are internally sub-divided so orbits stay clean even
//  at high time scales (Mercury's 88-day year needs small steps).
// ============================================================================

import { G, SUN_MASS } from './bodies.js';

// Largest integrator step [sim seconds]. Mercury's period is ~7.6e6 s, so
// 40 000 s gives ~190 steps per orbit — visually indistinguishable from exact.
const MAX_STEP = 40000;

// Safety valve: never grind through more sub-steps than this in one frame.
const MAX_SUBSTEPS = 20000;

/** Fresh mutable simulation state. */
export function create_sim_state(settings) {
  return {
    time: 0,                              // elapsed simulated seconds
    time_scale: settings.time_scale,      // multiplier on dt_base
    dt_base: settings.dt_base,            // sim seconds per frame at x1
    paused: false,
  };
}

/**
 * Gravitational acceleration on `body` from a point mass at (sx, sy).
 * Returns { ax, ay }. Softens at tiny r to avoid numeric blow-ups.
 */
export function gravity_pull(body, sx, sy, central_mass = SUN_MASS) {
  const dx = sx - body.x;
  const dy = sy - body.y;
  const r2 = dx * dx + dy * dy;
  const r = Math.sqrt(r2);
  if (r < 1) return { ax: 0, ay: 0 };
  const a = (G * central_mass) / r2;      // magnitude: a = G·M / r²
  return { ax: (a * dx) / r, ay: (a * dy) / r };
}

/** Place the Sun on its prescribed wobble circle for time t. */
function position_sun(sun, t) {
  const omega = (2 * Math.PI) / sun.wobble_period;
  const angle = omega * t;
  sun.x = sun.wobble_radius * Math.cos(angle);
  sun.y = sun.wobble_radius * Math.sin(angle);
  // Tangential velocity of the wobble (shown in the info card).
  sun.vx = -sun.wobble_radius * omega * Math.sin(angle);
  sun.vy = sun.wobble_radius * omega * Math.cos(angle);
  sun.speed = sun.wobble_radius * omega;
  sun.dist_to_sun = 0;
}

/** One semi-implicit Euler step for every planet: v += a·dt, then x += v·dt. */
function step_planets(planets, sun, dt) {
  for (const planet of planets) {
    const { ax, ay } = gravity_pull(planet, sun.x, sun.y);
    planet.vx += ax * dt;
    planet.vy += ay * dt;
    planet.x += planet.vx * dt;
    planet.y += planet.vy * dt;
  }
}

/** Park each moon on its Kepler circle around the parent's live position. */
function position_moons(moons, t) {
  for (const moon of moons) {
    const parent = moon.parent;
    if (!parent) continue;
    const angle =
      moon.orbit_phase +
      moon.direction * ((2 * Math.PI * t) / moon.orbit_period);
    moon.x = parent.x + moon.orbit_radius * Math.cos(angle);
    moon.y = parent.y + moon.orbit_radius * Math.sin(angle);

    // Moon velocity = parent velocity + circular orbital velocity.
    const angular = moon.direction * ((2 * Math.PI) / moon.orbit_period);
    const ovx = -moon.orbit_radius * angular * Math.sin(angle);
    const ovy = moon.orbit_radius * angular * Math.cos(angle);
    moon.vx = parent.vx + ovx;
    moon.vy = parent.vy + ovy;
    moon.speed = Math.hypot(moon.vx, moon.vy);
    moon.dist_to_sun = Math.hypot(moon.x, moon.y);
  }
}

/**
 * Advance the whole system by one rendered frame.
 * `frame_dt` = dt_base × time_scale [sim seconds]; sub-divided internally.
 */
export function step_simulation(system, sim, frame_dt) {
  if (sim.paused || frame_dt <= 0) return;

  const substeps = Math.min(
    MAX_SUBSTEPS,
    Math.max(1, Math.ceil(frame_dt / MAX_STEP))
  );
  const dt = frame_dt / substeps;

  for (let i = 0; i < substeps; i++) {
    sim.time += dt;
    position_sun(system.sun, sim.time);
    step_planets(system.planets, system.sun, dt);
    // Sample trails inside the sub-step loop so they stay smooth arcs even
    // when one rendered frame covers a large slice of an orbit.
    for (const planet of system.planets) {
      planet.trail.sample(planet.x, planet.y, sim.time);
    }
  }

  // Derived per-frame quantities (not needed inside sub-steps).
  for (const planet of system.planets) {
    planet.speed = Math.hypot(planet.vx, planet.vy);
    planet.dist_to_sun = Math.hypot(
      planet.x - system.sun.x,
      planet.y - system.sun.y
    );
  }

  position_moons(system.moons, sim.time);
}
