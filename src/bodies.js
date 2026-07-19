// ============================================================================
//  bodies.js — physical constants, the Body model, and system construction
//  from parsed solar.conf definitions. Pure data + math, no DOM.
// ============================================================================

export const G = 6.674e-11;          // gravitational constant [m^3 kg^-1 s^-2]
export const SUN_MASS = 1.989e30;    // [kg]
export const AU = 1.496e11;          // one astronomical unit [m]

/**
 * Trail — fixed-capacity circular buffer of world-space positions.
 *
 * Points are appended at a fixed *simulated-time* interval so a trail always
 * spans roughly the same fraction of an orbit no matter the time scale.
 */
export class Trail {
  constructor(capacity, sample_interval) {
    this.capacity = capacity;
    this.sample_interval = sample_interval;  // sim seconds between samples
    this.xs = new Float64Array(capacity);
    this.ys = new Float64Array(capacity);
    this.length = 0;
    this.head = 0;                            // next write slot
    this.last_sample_time = -Infinity;
  }

  /** Record the position if enough simulated time has passed. */
  sample(x, y, sim_time) {
    if (sim_time - this.last_sample_time < this.sample_interval) return;
    this.last_sample_time = sim_time;
    this.xs[this.head] = x;
    this.ys[this.head] = y;
    this.head = (this.head + 1) % this.capacity;
    if (this.length < this.capacity) this.length++;
  }

  /**
   * Visit points oldest -> newest as (x, y, age) where age runs 0 (oldest)
   * to 1 (newest) — renderers use age directly as trail alpha.
   */
  for_each(visit) {
    const n = this.length;
    if (n === 0) return;
    const start = (this.head - n + this.capacity) % this.capacity;
    for (let i = 0; i < n; i++) {
      const idx = (start + i) % this.capacity;
      visit(this.xs[idx], this.ys[idx], n > 1 ? i / (n - 1) : 1);
    }
  }

  clear() {
    this.length = 0;
    this.head = 0;
    this.last_sample_time = -Infinity;
  }
}

/**
 * Body — one simulated object (star, planet, or moon).
 *
 * Positions are world-space SI meters with the Sun's rest position at the
 * origin, +x right, +y up (mathematical orientation; renderers flip as
 * needed). Stars and planets carry velocity state; moons are driven on
 * Kepler circles around their parent's live position.
 */
export class Body {
  constructor(def) {
    this.name = def.name;
    this.type = def.type;                    // 'star' | 'planet' | 'moon'
    this.mass = def.mass ?? 0;               // [kg]
    this.radius = def.radius ?? 1;           // physical radius [m]
    this.color = def.color ?? '#cccccc';
    this.fact = def.fact ?? '';
    this.parent = null;                      // Body, resolved by build_system
    this.moons = [];

    // Live state (world space, SI)
    this.x = def.x ?? 0;
    this.y = def.y ?? 0;
    this.vx = 0;
    this.vy = 0;
    this.speed = 0;                          // |v| [m/s], updated each step
    this.dist_to_sun = 0;                    // [m], updated each step

    // Planet extras
    this.inclination = ((def.inclination ?? 0) * Math.PI) / 180;  // [rad]
    this.tilt = ((def.tilt ?? 0) * Math.PI) / 180;                // axial [rad]
    this.rotation_period = (def.rotation_hours ?? 24) * 3600;     // [s], sign = direction

    // Moon extras (orbit radius/phase derived from the conf x,y offset)
    this.orbit_radius = 0;                   // [m]
    this.orbit_period = def.period ?? 0;     // [s]
    this.orbit_phase = 0;                    // initial angle [rad]
    this.direction = def.retrograde ? -1 : 1;

    // Star extras
    this.wobble_radius = def.wobble_radius ?? 0;
    this.wobble_period = def.wobble_period ?? 1;

    this.trail = null;                       // assigned by build_system
  }
}

/** Circular-orbit period around the Sun at distance r: T = 2π √(r³ / GM). */
export function orbital_period(r, central_mass = SUN_MASS) {
  return 2 * Math.PI * Math.sqrt((r * r * r) / (G * central_mass));
}

const TRAIL_POINTS = 360;  // samples per trail buffer

/**
 * Build the live system from parsed solar.conf definitions.
 *
 * - Planets get a circular-orbit velocity v = √(GM/r), perpendicular to the
 *   Sun direction, counter-clockwise.
 * - Moons store their orbit radius + phase (from the conf offset) and are
 *   positioned relative to their parent's live location.
 * - Trails cover `trail_fraction` of each body's own orbit.
 *
 * Returns { bodies, by_name, sun, planets, moons }.
 */
export function build_system(defs, trail_fraction = 0.5) {
  const bodies = defs.map((def) => new Body(def));
  const by_name = new Map(bodies.map((b) => [b.name.toLowerCase(), b]));

  const sun = bodies.find((b) => b.type === 'star') ?? bodies[0];
  const planets = bodies.filter((b) => b.type === 'planet');
  const moons = bodies.filter((b) => b.type === 'moon');

  // Resolve parents and back-links.
  for (const [body, def] of bodies.map((b, i) => [b, defs[i]])) {
    if (def.parent) {
      body.parent = by_name.get(String(def.parent).toLowerCase()) ?? null;
      if (body.parent) body.parent.moons.push(body);
    }
  }
  // Only moons belong in .moons lists; planets parented to the Sun don't.
  sun.moons = [];

  // Planets: start where the conf placed them, with circular-orbit speed.
  for (const planet of planets) {
    const r = Math.hypot(planet.x, planet.y);
    const v = Math.sqrt((G * SUN_MASS) / r);
    // Perpendicular (CCW): rotate the outward unit vector by +90°.
    planet.vx = (-planet.y / r) * v;
    planet.vy = (planet.x / r) * v;
    planet.speed = v;
    planet.dist_to_sun = r;

    const period = orbital_period(r);
    planet.trail = new Trail(
      TRAIL_POINTS,
      (period * trail_fraction) / TRAIL_POINTS
    );
  }

  // Moons: derive orbit geometry from the conf offset, then place them
  // relative to their (already-placed) parent.
  for (const moon of moons) {
    moon.orbit_radius = Math.hypot(moon.x, moon.y);
    moon.orbit_phase = Math.atan2(moon.y, moon.x);
    const parent = moon.parent;
    if (parent) {
      moon.x = parent.x + moon.orbit_radius * Math.cos(moon.orbit_phase);
      moon.y = parent.y + moon.orbit_radius * Math.sin(moon.orbit_phase);
      const angular = (2 * Math.PI) / moon.orbit_period;
      moon.speed = moon.orbit_radius * angular;
      moon.dist_to_sun = Math.hypot(moon.x, moon.y);
    }
  }

  return { bodies, by_name, sun, planets, moons };
}

/** Change how much of an orbit trails cover (side-panel setting). */
export function set_trail_fraction(system, trail_fraction) {
  const fraction = Math.max(0.02, Math.min(1, trail_fraction));
  for (const planet of system.planets) {
    const period = orbital_period(Math.max(planet.dist_to_sun, 1));
    planet.trail.sample_interval = (period * fraction) / planet.trail.capacity;
    // Existing points keep their spacing; new spacing phases in naturally.
  }
}
