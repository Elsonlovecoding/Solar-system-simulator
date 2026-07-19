# Orrery — an interactive solar system simulator

Orrery is a real-gravity planetarium that runs entirely in your browser. All 29 bodies — the Sun, eight planets, and twenty moons — are defined in a plain-text config file (`solar.conf`) and simulated in SI units: planets fall toward the wobbling Sun under Newtonian gravity while moons ride Kepler circles around their parents' live positions. Explore the system top-down in a fast 2D canvas view or fly through it in a bloom-lit 3D view, click any body for its stats and a fact worth knowing, and bend time from a crawl to centuries per second.

## Quick start

The app uses ES modules and `fetch`es `solar.conf` at boot, so browsers refuse to run it from `file://` — serve the folder with any static HTTP server:

```sh
# Python (built in almost everywhere)
python3 -m http.server 8000

# or Node
npx serve -l 8000
```

Then open <http://localhost:8000>.

That's it — there is no build step, no install, and no network access after the page loads. Everything is vendored: Three.js r160 lives in `lib/`, and the Space Grotesk and Inter fonts live in `assets/fonts/`. The app works fully offline.

## Controls

Every control is a button on screen; keys are optional accelerators. Press **H** in the app for this same list.

| Action | Mouse / UI | Key |
| --- | --- | --- |
| Pan (2D) / orbit (3D) | Drag the view | — |
| Zoom | Scroll wheel | — |
| Show a body's name | Hover over it | — |
| Open info card (stats, fact, Follow) | Click a body | — |
| Follow / unfollow a body | **Follow** button on the info card | — |
| Recenter on the Sun | ⌖ **Recenter** button | `Space` |
| Reset view & camera | **Reset** button | `R` |
| Pause / resume | **Pause** button | `P` |
| Slow down time | **Slower** button | `,` |
| Speed up time | **Faster** button | `.` |
| Toggle name labels | **Labels** button | `L` |
| Switch 2D / 3D view | Mode toggle in the bottom dock | `2` / `3` |
| Help & shortcuts | **Help** button | `H` or `?` |
| Close card / dialog | × button | `Esc` |
| Bodies & settings panel | ☰ button (screen edge) | — |
| Trail length, label density, star density | Sliders in the side panel | — |

Clicking a body in the side panel's list selects it and flies the camera to it. Following survives zooming — you can track a planet while diving toward its moons — and the focused body carries across when you switch between 2D and 3D.

## Project structure

```
.
├── index.html          Full DOM: render surfaces, HUD, side panel, info card,
│                       bottom control bar, help modal, welcome overlay
├── styles.css          All chrome styling + @font-face declarations for the
│                       vendored fonts; glass panels, tooltips, HUD
├── main.js             Entry point: boots from solar.conf, owns app state
│                       (mode, selection, settings), routes pointer input,
│                       runs the requestAnimationFrame loop
├── solar.conf          The data — 29 [astral] sections defining every body
│                       (see format below)
├── src/
│   ├── config.js       solar.conf parser, runtime defaults, the time-scale
│   │                   ladder, and shared distance/time format helpers
│   ├── bodies.js       Body model, Trail circular buffer, constants (G, AU),
│   │                   and build_system() — turns parsed defs into live state
│   ├── physics.js      The integrator: Sun wobble, semi-implicit Euler for
│   │                   planets, Kepler positioning for moons, substepping
│   ├── camera2d.js     2D pan/zoom window in world meters, with smooth
│   │                   fly-to flights and body following
│   ├── render2d.js     2D canvas renderer: nebula + starfield, trails,
│   │                   true-scale bodies, Saturn's rings, labels, rulers
│   ├── camera3d.js     PerspectiveCamera + OrbitControls wrapper speaking the
│   │                   same reset/recenter/focus/follow vocabulary as 2D
│   ├── render3d.js     Three.js scene: lit spheres, orbit lines, bloom,
│   │                   9000-star sky, HTML label overlay (lazy-loaded)
│   └── ui.js           All DOM chrome: buttons, keyboard shortcuts, HUD
│                       readouts, side panel, info card, help modal, tooltips
├── lib/                Vendored Three.js r160 module + the addons used
│                       (OrbitControls, UnrealBloom postprocessing)
└── assets/fonts/       Vendored Space Grotesk & Inter (woff2)
```

## Simulation notes

- **Units are SI throughout** — meters, kilograms, seconds — with the Sun's rest position at the world origin and `G = 6.674e-11`.
- **Planets feel real gravity.** Each planet is accelerated toward the Sun's *live* (wobbling) position with `a = G·M/r²` and integrated with semi-implicit (symplectic) Euler, which keeps orbits from spiraling over long runs. Frame steps are internally subdivided into substeps of at most **40,000 sim-seconds**, so even Mercury's 88-day orbit stays clean at high time scales.
- **The Sun wobbles** on a prescribed circle of ~7.4×10⁸ m — a nod to the barycentric dance Jupiter forces on it — and the planets genuinely respond to it.
- **Time.** The default rate is 200,000 simulated seconds per frame at 60 fps — about **139 days per real second** at ×1. The `,` / `.` controls step a multiplier ladder from ×0.05 to ×100. Simulation speed is normalized against real frame time, so it is display-refresh-rate independent.
- **Moons ride Kepler circles** around their parent's live position at the period given in `solar.conf`; their world velocity is the parent's velocity plus the circular orbital term, so the info card readouts stay honest. Triton orbits Neptune retrograde, as it should.
- **Trails** are fixed-capacity circular buffers (360 points per planet) sampled at fixed *simulated-time* intervals, so a trail always covers the same fraction of an orbit regardless of the time scale. The side panel's trail slider sets that fraction.
- **The 3D view exaggerates for readability — the physics never changes.** Display mapping uses 1 scene unit = 10⁹ m; body radii are boosted ×1000 and clamped (planets to 0.35–15 units, moons to 0.5–6, the Sun drawn at 22 units), orbital inclinations are exaggerated ×2.5 so the system reads with depth, and moon orbits are displayed at `parent's visual radius × 2.4 + true orbit radius (in scene units) × 55` so they clear their inflated parent. Positions, speeds, and distances shown in the UI remain true-scale. The 2D view stays top-down true scale with a smart minimum pixel size so small bodies remain clickable.

## The `solar.conf` format

`solar.conf` is an INI-like file parsed at startup. Each `[astral]` section defines one body; `#` and `;` start comment lines. Numbers are parsed as floats (scientific notation welcome), `true`/`false` as booleans, everything else as strings.

| Key | Applies to | Meaning |
| --- | --- | --- |
| `name` | all | Display name (required; also used as `parent` references) |
| `type` | all | `star`, `planet`, or `moon` |
| `parent` | planet, moon | Name of the body it orbits |
| `mass` | all | Mass [kg] |
| `radius` | all | Physical radius [m] |
| `x`, `y` | planet, moon | Planet: initial position relative to the Sun [m]. Moon: initial offset from its parent — orbit radius and starting phase are derived from it. Ignored for the star. |
| `period` | moon | Orbital period [s] driving the Kepler motion |
| `retrograde` | moon | `true` to orbit backwards (Triton) |
| `inclination` | planet | Orbital inclination [degrees], shown in 3D |
| `tilt` | planet | Axial tilt [degrees] |
| `rotation_hours` | planet | Rotation period [hours]; negative spins backwards (Venus, Uranus) |
| `color` | all | Hex color used for the body, its trail, and its labels |
| `wobble_radius`, `wobble_period` | star | The Sun's barycentric wobble circle [m], [s] |
| `fact` | all | One-line fact shown on the info card |

Planets need no `period` — the simulator gives each one the circular-orbit speed `v = √(G·M/r)` for its starting distance, perpendicular to the Sun direction, counter-clockwise.

Adding a body is adding a section:

```ini
[astral]
name = Ceres
type = planet
parent = Sun
mass = 9.38e+20
radius = 4.73e+5
x = 4.14e+11
y = 0
inclination = 10.6
tilt = 4
rotation_hours = 9.07
color = #9e9689
fact = The largest object in the asteroid belt, and the only dwarf planet in the inner Solar System.
```

Reload the page and it's there — in the side panel, in both views, with a trail and an info card.

## Credits

- **Three.js** r160 (MIT license) — vendored in `lib/`, including the OrbitControls and UnrealBloom addons.
- **Space Grotesk** and **Inter** typefaces (SIL Open Font License) — vendored in `assets/fonts/`.
