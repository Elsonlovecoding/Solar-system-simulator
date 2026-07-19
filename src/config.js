// ============================================================================
//  config.js — solar.conf loader/parser, app defaults, shared format helpers
// ============================================================================

// Runtime-tweakable settings (side panel writes into a copy of this).
export const DEFAULTS = {
  dt_base: 200000,      // simulated seconds per frame at 60 fps and time scale x1
  time_scale: 1,        // multiplier on dt_base, adjustable at runtime
  trail_length: 0.5,    // fraction of one orbit covered by a trail (0..1)
  label_density: 0.55,  // 0 = none, ~0.5 = planets + nearby moons, 1 = everything
  star_density: 1.0,    // background star count multiplier
  show_labels: true,
  show_trails: true,
};

// Time-scale ladder stepped through by the − / + controls (multiplies dt_base).
export const TIME_STEPS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 25, 50, 100];

/**
 * Parse the text of solar.conf into an array of plain body definitions.
 *
 * Format: INI-like. Each `[astral]` header starts a new body; `key = value`
 * lines fill it. `#` or `;` start a comment line. Numbers are parsed as
 * floats, `true`/`false` as booleans, everything else stays a string.
 */
export function parse_conf(text) {
  const defs = [];
  let current = null;

  for (const raw_line of text.split('\n')) {
    const line = raw_line.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;

    if (line.startsWith('[')) {
      const section = line.slice(1, line.indexOf(']')).trim().toLowerCase();
      current = section === 'astral' ? {} : null;
      if (current) defs.push(current);
      continue;
    }

    if (!current) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;

    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim();
    current[key] = coerce_value(value);
  }

  // A body without a name can't be referenced by anything — drop it.
  return defs.filter((d) => typeof d.name === 'string' && d.name.length > 0);
}

function coerce_value(value) {
  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === 'true';
  // Only treat it as a number if the *whole* value is numeric
  // (colors like "#b3a597" and sentences must stay strings).
  if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(value)) return parseFloat(value);
  return value;
}

/** Fetch and parse solar.conf. Throws with a readable message on failure. */
export async function load_config(url = 'solar.conf') {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not load ${url} (HTTP ${response.status})`);
  }
  return parse_conf(await response.text());
}

// ---------------------------------------------------------------------------
//  Shared formatting helpers
// ---------------------------------------------------------------------------

// Unit ladder used everywhere distances are shown (rulers, scale bar, HUD).
const DISTANCE_UNITS = [
  { symbol: 'm',  factor: 1 },
  { symbol: 'km', factor: 1e3 },
  { symbol: 'Mm', factor: 1e6 },
  { symbol: 'Bm', factor: 1e9 },
  { symbol: 'Tm', factor: 1e12 },
  { symbol: 'Qm', factor: 1e15 },
  { symbol: 'Em', factor: 1e18 },
];

/** Pick the unit for a given magnitude so the mantissa lands in [1, 1000). */
export function distance_unit_for(meters) {
  const abs = Math.abs(meters);
  let unit = DISTANCE_UNITS[0];
  for (const candidate of DISTANCE_UNITS) {
    if (abs >= candidate.factor) unit = candidate;
    else break;
  }
  return unit;
}

/** "1.47e11 m" -> "147 Bm". `digits` limits decimals on the mantissa. */
export function format_distance(meters, digits = 3) {
  if (meters === 0) return '0 m';
  const unit = distance_unit_for(meters);
  const mantissa = meters / unit.factor;
  const rounded = Number(mantissa.toPrecision(digits));
  return `${rounded} ${unit.symbol}`;
}

/** Simulated elapsed seconds -> "Year 3 · Day 214" style clock text. */
export function format_sim_clock(seconds) {
  const total_days = seconds / 86400;
  const years = Math.floor(total_days / 365.25);
  const days = Math.floor(total_days - years * 365.25);
  return years > 0 ? `Year ${years + 1} · Day ${days}` : `Day ${days}`;
}

/** Simulated seconds -> compact human duration ("88 days", "11.9 years"). */
export function format_duration(seconds) {
  const days = seconds / 86400;
  if (days < 1) return `${(days * 24).toFixed(1)} hours`;
  if (days < 400) return `${days.toFixed(1)} days`;
  return `${(days / 365.25).toFixed(1)} years`;
}

/** Speed of the simulation as human text, e.g. "139 days / sec". */
export function format_sim_rate(dt_base, time_scale, fps = 60) {
  const sim_seconds_per_real_second = dt_base * time_scale * fps;
  const days = sim_seconds_per_real_second / 86400;
  if (days < 1) return `${(days * 24).toFixed(1)} hrs / sec`;
  if (days < 365.25) return `${days < 10 ? days.toFixed(1) : Math.round(days)} days / sec`;
  return `${(days / 365.25).toFixed(1)} yrs / sec`;
}
