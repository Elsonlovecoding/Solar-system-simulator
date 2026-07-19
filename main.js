// ============================================================================
//  main.js — application entry point.
//
//  Boots the simulation from solar.conf, owns the app state (mode, selection,
//  settings), routes pointer input to the active renderer, and runs the
//  frame loop. All DOM chrome (buttons, panels, keyboard) lives in ui.js;
//  all drawing lives in render2d.js / render3d.js.
// ============================================================================

import { DEFAULTS, TIME_STEPS, load_config } from './src/config.js';
import { build_system, set_trail_fraction } from './src/bodies.js';
import { create_sim_state, step_simulation } from './src/physics.js';
import { Camera2D } from './src/camera2d.js';
import { Renderer2D } from './src/render2d.js';
import { UI } from './src/ui.js';

const app = {
  system: null,
  sim: null,
  settings: { ...DEFAULTS },

  mode: '2d',              // '2d' | '3d'
  hovered: null,           // Body under the cursor
  selected: null,          // Body with the info card open

  camera2d: null,
  renderer2d: null,
  renderer3d: null,        // created lazily on first switch to 3D
  ui: null,

  // ---- actions (called by ui.js buttons/keys and by input handlers) ------

  toggle_pause() {
    app.sim.paused = !app.sim.paused;
    app.ui.update_pause_button(app.sim.paused);
  },

  time_slower() { adjust_time_scale(-1); },
  time_faster() { adjust_time_scale(+1); },

  toggle_mode() {
    app.set_mode(app.mode === '2d' ? '3d' : '2d');
  },

  async set_mode(mode) {
    if (mode === app.mode) return;

    if (mode === '3d' && !app.renderer3d) {
      // Lazy-load the Three.js stack the first time 3D is opened.
      const { Renderer3D } = await import('./src/render3d.js');
      app.renderer3d = new Renderer3D(
        document.getElementById('container-3d'),
        document.getElementById('labels-3d'),
        app.system,
        app.settings
      );
      app.renderer3d.resize(window.innerWidth, window.innerHeight);
    }

    app.mode = mode;
    const canvas_2d = document.getElementById('canvas-2d');
    const container_3d = document.getElementById('container-3d');
    canvas_2d.classList.toggle('hidden', mode === '3d');
    container_3d.classList.toggle('hidden', mode === '2d');
    if (app.renderer3d) app.renderer3d.set_active(mode === '3d');

    // Carry the current focus across modes so the switch feels seamless.
    if (mode === '3d') {
      const focus = app.camera2d.follow_target;
      if (focus) app.renderer3d.camera3d.focus_body(focus);
    } else {
      const focus = app.renderer3d?.camera3d.follow_target;
      if (focus) app.camera2d.fly_to_body(focus);
    }

    app.ui.update_mode_button(mode);
  },

  toggle_labels() {
    app.settings.show_labels = !app.settings.show_labels;
    app.ui.update_labels_button(app.settings.show_labels);
  },

  reset_view() {
    app.select_body(null);
    if (app.mode === '2d') app.camera2d.reset();
    else app.renderer3d.camera3d.reset();
  },

  recenter() {
    if (app.mode === '2d') app.camera2d.recenter();
    else app.renderer3d.camera3d.recenter();
  },

  /** Open (or close, with null) the info card for a body. */
  select_body(body) {
    app.selected = body;
    app.ui.set_selected(body);
  },

  /** Follow/unfollow the given body with the active camera. */
  toggle_follow(body) {
    const cam = app.mode === '2d' ? app.camera2d : app.renderer3d.camera3d;
    if (cam.follow_target === body) {
      cam.clear_follow();
    } else if (app.mode === '2d') {
      app.camera2d.fly_to_body(body);
    } else {
      app.renderer3d.camera3d.focus_body(body);
    }
    app.ui.update_follow_button(app.is_following(body));
  },

  /** Side-panel click: select AND fly to the body. */
  fly_to_body(body) {
    app.select_body(body);
    if (app.mode === '2d') app.camera2d.fly_to_body(body);
    else app.renderer3d.camera3d.focus_body(body);
    app.ui.update_follow_button(true);
  },

  is_following(body) {
    const cam = app.mode === '2d' ? app.camera2d : app.renderer3d?.camera3d;
    return cam ? cam.follow_target === body : false;
  },

  set_trail_length(value) {
    app.settings.trail_length = value;
    app.settings.show_trails = value > 0.001;
    set_trail_fraction(app.system, value);
  },

  set_label_density(value) {
    app.settings.label_density = value;
  },

  set_star_density(value) {
    app.settings.star_density = value;
    app.renderer2d.regenerate_stars(value);
    app.renderer3d?.regenerate_stars(value);
  },
};

function adjust_time_scale(direction) {
  const idx = nearest_time_step_index(app.sim.time_scale);
  const next = Math.min(TIME_STEPS.length - 1, Math.max(0, idx + direction));
  app.sim.time_scale = TIME_STEPS[next];
  app.ui.update_time_readouts(app.sim);
}

function nearest_time_step_index(scale) {
  let best = 0;
  for (let i = 0; i < TIME_STEPS.length; i++) {
    if (
      Math.abs(Math.log(TIME_STEPS[i] / scale)) <
      Math.abs(Math.log(TIME_STEPS[best] / scale))
    ) {
      best = i;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
//  Pointer input — pan / zoom / hover / click on whichever view is active.
// ---------------------------------------------------------------------------

function attach_pointer_input() {
  const surface_2d = document.getElementById('canvas-2d');

  let dragging = false;
  let drag_moved = 0;
  let last_x = 0;
  let last_y = 0;

  surface_2d.addEventListener('pointerdown', (e) => {
    dragging = true;
    drag_moved = 0;
    last_x = e.clientX;
    last_y = e.clientY;
    surface_2d.setPointerCapture(e.pointerId);
  });

  surface_2d.addEventListener('pointermove', (e) => {
    if (dragging) {
      const dx = e.clientX - last_x;
      const dy = e.clientY - last_y;
      drag_moved += Math.abs(dx) + Math.abs(dy);
      app.camera2d.pan_by_pixels(dx, dy);
      last_x = e.clientX;
      last_y = e.clientY;
    } else {
      update_hover(e.clientX, e.clientY);
    }
  });

  surface_2d.addEventListener('pointerup', (e) => {
    dragging = false;
    surface_2d.releasePointerCapture(e.pointerId);
    // A click (not a drag) selects the body under the cursor.
    if (drag_moved < 5) {
      const hit = app.renderer2d.pick(e.clientX, e.clientY);
      app.select_body(hit);
    }
  });

  surface_2d.addEventListener('pointerleave', () => set_hovered(null, 0, 0));

  surface_2d.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.0015);
      app.camera2d.zoom_at(e.clientX, e.clientY, factor);
    },
    { passive: false }
  );

  // 3D: OrbitControls handles pan/zoom; we add hover + click picking here.
  const container_3d = document.getElementById('container-3d');
  let down_x = 0;
  let down_y = 0;

  container_3d.addEventListener('pointerdown', (e) => {
    down_x = e.clientX;
    down_y = e.clientY;
  });
  container_3d.addEventListener('pointermove', (e) => {
    if (e.buttons === 0) update_hover(e.clientX, e.clientY);
  });
  container_3d.addEventListener('pointerup', (e) => {
    const moved = Math.abs(e.clientX - down_x) + Math.abs(e.clientY - down_y);
    if (moved < 5) {
      const hit = app.renderer3d.pick(e.clientX, e.clientY);
      app.select_body(hit);
    }
  });
  container_3d.addEventListener('pointerleave', () => set_hovered(null, 0, 0));
}

function update_hover(sx, sy) {
  const renderer = app.mode === '2d' ? app.renderer2d : app.renderer3d;
  if (!renderer) return;
  set_hovered(renderer.pick(sx, sy), sx, sy);
}

function set_hovered(body, sx, sy) {
  app.hovered = body;
  app.ui.set_hovered(body, sx, sy);
  document.body.classList.toggle('picking', !!body);
}

// ---------------------------------------------------------------------------
//  Boot + frame loop
// ---------------------------------------------------------------------------

function resize_all() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  app.camera2d.resize(w, h);
  app.renderer2d.resize(w, h, dpr);
  app.renderer3d?.resize(w, h);
}

let last_frame_time = performance.now();

function frame(now) {
  // Real elapsed seconds, clamped so tab-switches don't cause a time jump.
  const dt_real = Math.min((now - last_frame_time) / 1000, 0.1);
  last_frame_time = now;

  // Normalize physics to a 60 fps baseline so sim speed is display-rate
  // independent: dt_base is "per frame at 60 fps".
  const frame_dt = app.sim.dt_base * app.sim.time_scale * (dt_real * 60);
  step_simulation(app.system, app.sim, frame_dt);

  const frame_state = {
    sim: app.sim,
    settings: app.settings,
    hovered: app.hovered,
    selected: app.selected,
    mode: app.mode,
  };

  if (app.mode === '2d') {
    app.camera2d.update(dt_real);
    app.renderer2d.render(frame_state);
  } else {
    app.renderer3d.render(frame_state, dt_real);
  }

  app.ui.update(frame_state);
  requestAnimationFrame(frame);
}

async function boot() {
  try {
    const defs = await load_config('solar.conf');
    app.system = build_system(defs, app.settings.trail_length);
    app.sim = create_sim_state(app.settings);

    app.camera2d = new Camera2D(window.innerWidth, window.innerHeight);
    app.renderer2d = new Renderer2D(
      document.getElementById('canvas-2d'),
      app.system,
      app.camera2d
    );

    app.ui = new UI(app);
    attach_pointer_input();
    window.addEventListener('resize', resize_all);
    resize_all();

    app.ui.flash_welcome();
    requestAnimationFrame((t) => {
      last_frame_time = t;
      requestAnimationFrame(frame);
    });
  } catch (error) {
    console.error(error);
    const panel = document.getElementById('boot-error');
    panel.classList.remove('hidden');
    document.getElementById('boot-error-message').textContent =
      error.message ?? String(error);
  }
}

boot();
