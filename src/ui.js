// ============================================================================
//  ui.js — all DOM chrome: buttons, sliders, keyboard, tooltips, body list,
//  info card, HUD readouts, help modal, and the welcome overlay.
//
//  The UI never touches the simulation directly — every interaction routes
//  through the `app` facade (main.js), and every frame main.js hands us a
//  frame_state to mirror into the HUD. Per-frame writes are string-cached so
//  a steady sim costs zero DOM mutations.
// ============================================================================

import { format_distance, format_sim_clock, format_sim_rate } from './config.js';
import { AU } from './bodies.js';

// -- tunables ----------------------------------------------------------------

const TOOLTIP_DELAY_MS = 350;    // hover dwell before a tooltip appears
const TOOLTIP_FADE_MS = 180;     // matches the CSS fade so display:none lands after it
const STAR_DEBOUNCE_MS = 150;    // star slider rebuilds whole starfields — settle first
const WELCOME_HOLD_MS = 3200;    // how long the title card lingers untouched
const WELCOME_FADE_MS = 950;     // a hair past the 900ms CSS fade
const HOVER_OFFSET_PX = 14;      // hover tag offset from the cursor
const SCALE_BAR_MAX_PX = 120;    // scale bar never grows wider than this

// -- small formatting helpers ------------------------------------------------

const SUPERSCRIPTS = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
  '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '-': '⁻',
};

function to_superscript(n) {
  let out = '';
  for (const ch of String(n)) out += SUPERSCRIPTS[ch] ?? ch;
  return out;
}

/** 5.972e24 -> "5.97 × 10²⁴ kg" — proper scientific notation for the card. */
function format_mass(kg) {
  if (!Number.isFinite(kg) || kg <= 0) return '—';
  let exponent = Math.floor(Math.log10(kg));
  let mantissa = Number((kg / 10 ** exponent).toPrecision(3));
  if (mantissa >= 10) {         // rounding can push 9.99… over the edge
    mantissa /= 10;
    exponent += 1;
  }
  return `${mantissa} × 10${to_superscript(exponent)} kg`;
}

/** Orbital speeds read best in km/s; the Sun's slow wobble stays in m/s. */
function format_speed(mps) {
  if (!Number.isFinite(mps)) return '—';
  if (mps >= 1000) return `${(mps / 1000).toFixed(1)} km/s`;
  return `${mps.toFixed(1)} m/s`;
}

/** 0.05 -> "0.05", 1 -> "1", 100 -> "100" — no trailing zero noise. */
function trim_scale(scale) {
  return Number.isInteger(scale) ? String(scale) : String(Number(scale.toFixed(2)));
}

/** Zoom ratio with precision that adapts across ~9 orders of magnitude, so
 *  deep zoom-out reads "×0.0001" (or "×2.1e-6"), never a meaningless "×0.00". */
function format_zoom(ratio) {
  if (ratio >= 100) return String(Math.round(ratio));
  if (ratio >= 0.1) return ratio.toFixed(2);
  if (ratio >= 0.0001) return String(Number(ratio.toPrecision(2)));
  return ratio.toExponential(1).replace('e-', 'e‑');  // non-breaking hyphen
}

/** Largest 1/2/5 × 10ⁿ length not exceeding `max_meters` (scale bar). */
function nice_scale_length(max_meters) {
  const power = 10 ** Math.floor(Math.log10(max_meters));
  for (const m of [5, 2, 1]) {
    if (power * m <= max_meters) return power * m;
  }
  return power;
}

// -- help modal content ------------------------------------------------------

// Simple 24×24 stroke icons, drawn inline so the app stays fully offline.
const S = 'stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" fill="none"';
const ICONS = {
  drag: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" ${S}/><path d="M9.5 7.5L12 5l2.5 2.5M9.5 16.5L12 19l2.5-2.5M7.5 9.5L5 12l2.5 2.5M16.5 9.5L19 12l-2.5 2.5" ${S}/></svg>`,
  scroll: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="3" width="8" height="18" rx="4" ${S}/><path d="M12 7v4" ${S}/></svg>`,
  cursor: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5l12.6 7.8-5.4 1.2 2.9 6-2.7 1.2-2.8-6.2L6 16.8z" ${S}/></svg>`,
  target: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" fill="currentColor"/><circle cx="12" cy="12" r="8" ${S}/></svg>`,
  crosshair: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="2.6" fill="currentColor"/><path d="M12 3v4M12 17v4M3 12h4M17 12h4" ${S}/></svg>`,
  reset: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10a8 8 0 1 1 2 6.9M4 10V4m0 6h6" ${S}/></svg>`,
  pause: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 5v14M15.5 5v14" ${S}/></svg>`,
  clock: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" ${S}/><path d="M12 8v4.2l2.8 1.8" ${S}/></svg>`,
  tag: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h13v7H7z M7 10.5H4V7" ${S}/><circle cx="4" cy="15.5" r="2.2" fill="currentColor"/></svg>`,
  cube: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3zm0 0v9m8-4.5L12 12m-8-4.5L12 12" ${S}/></svg>`,
  help: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.1 9a3 3 0 1 1 4.6 2.5c-.9.6-1.7 1.2-1.7 2.5m0 3.5h.01" ${S}/></svg>`,
  close: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" ${S}/><path d="M9.5 9.5l5 5M14.5 9.5l-5 5" ${S}/></svg>`,
};

// Everything the app can do, one row each — mouse gestures first, then keys.
const HELP_CONTROLS = [
  { icon: ICONS.drag, name: 'Drag', desc: 'Pan the map in 2D · orbit the camera in 3D', keys: [] },
  { icon: ICONS.scroll, name: 'Scroll', desc: 'Zoom toward the cursor', keys: [] },
  { icon: ICONS.cursor, name: 'Hover', desc: 'Reveal a body’s name tag', keys: [] },
  { icon: ICONS.target, name: 'Click a body', desc: 'Open its info card', keys: [] },
  { icon: ICONS.crosshair, name: 'Recenter', desc: 'Return to the Sun at the current zoom', keys: ['Space'] },
  { icon: ICONS.reset, name: 'Reset view', desc: 'Back to the home view, selection cleared', keys: ['R'] },
  { icon: ICONS.pause, name: 'Pause / resume', desc: 'Freeze or restart simulated time', keys: ['P'] },
  { icon: ICONS.clock, name: 'Time scale', desc: 'Slow down or speed up the clock', keys: [',', '.'] },
  { icon: ICONS.tag, name: 'Labels', desc: 'Toggle body name labels', keys: ['L'] },
  { icon: ICONS.cube, name: '2D / 3D', desc: 'Jump straight to either view', keys: ['2', '3'] },
  { icon: ICONS.help, name: 'Help', desc: 'Toggle this panel', keys: ['H', '?'] },
  { icon: ICONS.close, name: 'Close', desc: 'Dismiss the help panel or info card', keys: ['Esc'] },
];

// ============================================================================
//  UI
// ============================================================================

export class UI {
  constructor(app) {
    this.app = app;

    const $ = (id) => document.getElementById(id);
    this.el = {
      // HUD
      clock: $('clock-readout'),
      rate: $('rate-readout'),
      zoom: $('zoom-readout'),
      scale_readout: $('scale-readout'),
      scale_line: document.querySelector('#scale-bar .scale-bar-line'),
      // side panel
      side_panel: $('side-panel'),
      panel_toggle: $('panel-toggle'),
      body_list: $('body-list'),
      // info card
      info_card: $('info-card'),
      info_swatch: $('info-swatch'),
      info_name: $('info-name'),
      info_mass: $('info-mass'),
      info_radius: $('info-radius'),
      info_speed: $('info-speed'),
      info_distance: $('info-distance'),
      info_fact: $('info-fact'),
      info_follow: $('info-follow'),
      info_follow_label: $('info-follow-label'),
      // bottom bar
      icon_pause: $('icon-pause'),
      icon_play: $('icon-play'),
      pause_label: $('pause-label'),
      icon_3d: $('icon-3d'),
      icon_2d: $('icon-2d'),
      mode_label: $('mode-label'),
      btn_labels: $('btn-labels'),
      timescale: $('timescale-readout'),
      // overlays
      help_modal: $('help-modal'),
      help_grid: $('help-grid'),
      tooltip: $('tooltip'),
      hover_tag: $('hover-tag'),
      welcome: $('welcome-overlay'),
    };

    // Selection / hover mirrors of app state (what the DOM currently shows).
    this.selected = null;
    this.hover_body = null;
    this.body_rows = new Map();      // Body -> its list-row <button>

    // Per-frame write throttling: element -> last written string.
    this._text_cache = new Map();
    this._scale_width = -1;          // last scale-bar line width [px]
    this._follow_shown = null;       // follow-button state the DOM shows

    // Timers
    this._star_timer = 0;
    this._tooltip_timer = 0;
    this._tooltip_hide_timer = 0;
    this._tooltip_target = null;
    this._welcome_dismissed = false;

    this._build_hover_tag();
    this._build_body_list();
    this._build_help_grid();
    this._wire_buttons();
    this._wire_sliders();
    this._wire_keyboard();
    this._wire_tooltips();

    // Normalize every piece of chrome to the boot state.
    this.update_pause_button(app.sim.paused);
    this.update_mode_button(app.mode);
    this.update_labels_button(app.settings.show_labels);
    this.update_time_readouts(app.sim);
  }

  // -------------------------------------------------------------------------
  //  Wiring
  // -------------------------------------------------------------------------

  _wire_buttons() {
    const app = this.app;
    const $ = (id) => document.getElementById(id);

    $('btn-help').addEventListener('click', () => this.toggle_help());
    $('btn-pause').addEventListener('click', () => app.toggle_pause());
    $('btn-time-slower').addEventListener('click', () => app.time_slower());
    $('btn-time-faster').addEventListener('click', () => app.time_faster());
    $('btn-mode').addEventListener('click', () => app.toggle_mode());
    this.el.btn_labels.addEventListener('click', () => app.toggle_labels());
    $('btn-recenter').addEventListener('click', () => app.recenter());
    $('btn-reset').addEventListener('click', () => app.reset_view());

    this.el.panel_toggle.addEventListener('click', () => {
      const collapsed = this.el.side_panel.classList.toggle('collapsed');
      this.el.panel_toggle.setAttribute('aria-expanded', String(!collapsed));
      // The HUD slides right while the panel is open (see styles.css).
      document.body.classList.toggle('panel-open', !collapsed);
    });

    $('info-close').addEventListener('click', () => app.select_body(null));
    this.el.info_follow.addEventListener('click', () => {
      if (this.selected) app.toggle_follow(this.selected);
    });

    $('help-close').addEventListener('click', () => this.close_help());
    // Clicking the dimmed backdrop (not the card itself) also closes.
    this.el.help_modal.addEventListener('click', (e) => {
      if (e.target === this.el.help_modal) this.close_help();
    });
  }

  _wire_sliders() {
    const app = this.app;
    const $ = (id) => document.getElementById(id);

    $('setting-trails').addEventListener('input', (e) => {
      app.set_trail_length(+e.target.value);
    });
    $('setting-labels').addEventListener('input', (e) => {
      app.set_label_density(+e.target.value);
    });
    // Star density rebuilds entire starfields — wait for the drag to settle.
    $('setting-stars').addEventListener('input', (e) => {
      const value = +e.target.value;
      clearTimeout(this._star_timer);
      this._star_timer = setTimeout(
        () => app.set_star_density(value),
        STAR_DEBOUNCE_MS
      );
    });
  }

  _wire_keyboard() {
    const app = this.app;
    window.addEventListener('keydown', (e) => {
      // Leave typing contexts and browser shortcuts alone. Plain Shift stays
      // allowed — '?' needs it.
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      switch (e.key) {
        case 'h': case 'H': case '?':
          this.toggle_help();
          break;
        case 'Escape':
          if (this.is_help_open()) this.close_help();
          else if (this.selected) app.select_body(null);
          break;
        case 'p': case 'P':
          app.toggle_pause();
          break;
        case ',':
          app.time_slower();
          break;
        case '.':
          app.time_faster();
          break;
        case 'l': case 'L':
          app.toggle_labels();
          break;
        case '2':
          app.set_mode('2d');
          break;
        case '3':
          app.set_mode('3d');
          break;
        case ' ':
          e.preventDefault();   // never page-scroll
          app.recenter();
          break;
        case 'r': case 'R':
          app.reset_view();
          break;
      }
    });
  }

  // -------------------------------------------------------------------------
  //  Body list — Sun, then planets with their moons nested beneath
  // -------------------------------------------------------------------------

  _build_body_list() {
    const { sun, planets } = this.app.system;
    const list = this.el.body_list;

    list.appendChild(this._make_row(sun));
    for (const planet of planets) {
      const li = this._make_row(planet);
      if (planet.moons.length > 0) {
        const moon_list = document.createElement('ul');
        moon_list.className = 'moon-list';
        for (const moon of planet.moons) {
          moon_list.appendChild(this._make_row(moon, true));
        }
        li.appendChild(moon_list);
      }
      list.appendChild(li);
    }
  }

  _make_row(body, is_moon = false) {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = is_moon ? 'body-row body-row--moon' : 'body-row';

    const swatch = document.createElement('span');
    swatch.className = 'body-swatch';
    swatch.style.setProperty('--swatch', body.color);

    const name = document.createElement('span');
    name.className = 'body-name';
    name.textContent = body.name;

    button.append(swatch, name);

    // Planets carry a dim "how far out" tag; positions were set at build time.
    if (body.type === 'planet') {
      const dist = document.createElement('span');
      dist.className = 'body-dist';
      dist.textContent = `${(body.dist_to_sun / AU).toFixed(1)} AU`;
      button.appendChild(dist);
    }

    button.addEventListener('click', () => this.app.fly_to_body(body));
    this.body_rows.set(body, button);
    li.appendChild(button);
    return li;
  }

  // -------------------------------------------------------------------------
  //  Help modal
  // -------------------------------------------------------------------------

  _build_help_grid() {
    const grid = this.el.help_grid;
    for (const control of HELP_CONTROLS) {
      const row = document.createElement('div');
      row.className = 'help-row';

      const icon = document.createElement('span');
      icon.className = 'help-icon';
      icon.innerHTML = control.icon;   // static, trusted markup from this file

      const text = document.createElement('span');
      text.className = 'help-text';
      const name = document.createElement('span');
      name.className = 'help-name';
      name.textContent = control.name;
      const desc = document.createElement('span');
      desc.className = 'help-desc';
      desc.textContent = control.desc;
      text.append(name, desc);

      row.append(icon, text);

      if (control.keys.length > 0) {
        const keys = document.createElement('span');
        keys.className = 'help-keys';
        for (const key of control.keys) {
          const kbd = document.createElement('kbd');
          kbd.textContent = key;
          keys.appendChild(kbd);
        }
        row.appendChild(keys);
      }
      grid.appendChild(row);
    }
  }

  toggle_help() {
    if (this.is_help_open()) this.close_help();
    else this.open_help();
  }

  open_help() {
    this.el.help_modal.classList.remove('hidden');
  }

  close_help() {
    this.el.help_modal.classList.add('hidden');
  }

  is_help_open() {
    return !this.el.help_modal.classList.contains('hidden');
  }

  // -------------------------------------------------------------------------
  //  Tooltips — one shared chip, delegated over every [data-tooltip] element
  // -------------------------------------------------------------------------

  _wire_tooltips() {
    document.addEventListener('pointerover', (e) => {
      const target = e.target.closest ? e.target.closest('[data-tooltip]') : null;
      if (target === this._tooltip_target) return;   // still inside the same one
      this._cancel_tooltip();
      if (target) {
        this._tooltip_target = target;
        this._tooltip_timer = setTimeout(
          () => this._show_tooltip(target),
          TOOLTIP_DELAY_MS
        );
      }
    });

    document.addEventListener('pointerout', (e) => {
      const target = this._tooltip_target;
      if (target && !target.contains(e.relatedTarget)) this._cancel_tooltip();
    });

    // Any press dismisses immediately — the user is acting, not reading.
    document.addEventListener('pointerdown', () => this._cancel_tooltip(), true);
  }

  _show_tooltip(target) {
    const tip = this.el.tooltip;
    tip.textContent = target.getAttribute('data-tooltip');

    // "H", ", " or "2 / 3" become one keycap chip per key.
    const key = target.getAttribute('data-key');
    if (key) {
      for (const part of key.split('/')) {
        const chip = document.createElement('kbd');
        chip.textContent = part.trim();
        tip.appendChild(chip);
      }
    }

    clearTimeout(this._tooltip_hide_timer);
    tip.classList.remove('hidden');

    // Centered above the element; below it when the element hugs the top
    // half of the screen (HUD, panel toggle). Clamped to the viewport.
    const rect = target.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    const below = rect.top < window.innerHeight / 2;
    let x = rect.left + rect.width / 2 - tw / 2;
    let y = below ? rect.bottom + 10 : rect.top - th - 10;
    x = Math.max(8, Math.min(window.innerWidth - tw - 8, x));
    y = Math.max(8, Math.min(window.innerHeight - th - 8, y));
    tip.style.left = `${Math.round(x)}px`;
    tip.style.top = `${Math.round(y)}px`;

    // Next frame so the fade/slide transition runs from the resting state.
    requestAnimationFrame(() => tip.classList.add('visible'));
  }

  _cancel_tooltip() {
    clearTimeout(this._tooltip_timer);
    this._tooltip_target = null;
    const tip = this.el.tooltip;
    if (!tip.classList.contains('hidden')) {
      tip.classList.remove('visible');
      clearTimeout(this._tooltip_hide_timer);
      this._tooltip_hide_timer = setTimeout(
        () => tip.classList.add('hidden'),
        TOOLTIP_FADE_MS
      );
    }
  }

  // -------------------------------------------------------------------------
  //  Hover tag — follows the cursor over bodies in either view
  // -------------------------------------------------------------------------

  _build_hover_tag() {
    const tag = this.el.hover_tag;
    this._hover_dot = document.createElement('span');
    this._hover_dot.className = 'hover-dot';
    this._hover_name = document.createElement('span');
    this._hover_name.className = 'hover-name';
    tag.append(this._hover_dot, this._hover_name);
  }

  /** Called by main.js on every pointer move. `body` may be null. */
  set_hovered(body, sx, sy) {
    const tag = this.el.hover_tag;

    if (!body) {
      if (this.hover_body) {
        this.hover_body = null;
        tag.classList.remove('visible');
        tag.classList.add('hidden');
      }
      return;
    }

    if (body !== this.hover_body) {
      this.hover_body = body;
      this._hover_name.textContent = body.name;
      this._hover_dot.style.background = body.color;
      this._hover_dot.style.boxShadow = `0 0 8px ${body.color}`;
      tag.classList.remove('hidden');
      requestAnimationFrame(() => tag.classList.add('visible'));
    }

    // Sit just right/below the cursor; flip to the other side at the edges.
    let x = sx + HOVER_OFFSET_PX;
    let y = sy + HOVER_OFFSET_PX;
    const w = tag.offsetWidth;
    const h = tag.offsetHeight;
    if (x + w > window.innerWidth - 8) x = sx - w - HOVER_OFFSET_PX;
    if (y + h > window.innerHeight - 8) y = sy - h - HOVER_OFFSET_PX;
    tag.style.left = `${Math.round(x)}px`;
    tag.style.top = `${Math.round(y)}px`;
  }

  // -------------------------------------------------------------------------
  //  Info card
  // -------------------------------------------------------------------------

  /** Populate + show the info card, or hide it when body is null. */
  set_selected(body) {
    // Move the .active highlight in the body list.
    const prev_row = this.selected && this.body_rows.get(this.selected);
    if (prev_row) prev_row.classList.remove('active');

    this.selected = body;
    this._follow_shown = null;
    const card = this.el.info_card;

    if (!body) {
      card.classList.add('hidden');
      return;
    }

    this.body_rows.get(body)?.classList.add('active');

    this.el.info_name.textContent = body.name;
    this.el.info_swatch.style.background = body.color;
    this.el.info_swatch.style.boxShadow = `0 0 10px ${body.color}`;
    this.el.info_mass.textContent = format_mass(body.mass);
    this.el.info_radius.textContent = format_distance(body.radius);
    this.el.info_fact.textContent = body.fact || '';
    this._set_text(this.el.info_speed, format_speed(body.speed));
    this._set_text(this.el.info_distance, format_distance(body.dist_to_sun));
    this.update_follow_button(this.app.is_following(body));

    // Replay the entrance animation even when swapping between bodies.
    card.classList.remove('hidden');
    card.style.animation = 'none';
    void card.offsetWidth;         // reflow flushes the removal
    card.style.animation = '';
  }

  update_follow_button(is_following) {
    this.el.info_follow.classList.toggle('active', is_following);
    this.el.info_follow_label.textContent = is_following ? 'Following ✓' : 'Follow';
    this._follow_shown = is_following;
  }

  // -------------------------------------------------------------------------
  //  Bottom-bar button states
  // -------------------------------------------------------------------------

  update_pause_button(paused) {
    this.el.icon_pause.classList.toggle('hidden', paused);
    this.el.icon_play.classList.toggle('hidden', !paused);
    this.el.pause_label.textContent = paused ? 'Play' : 'Pause';
    document.body.classList.toggle('is-paused', paused);
  }

  update_mode_button(mode) {
    // The button advertises the view you'd switch TO.
    const in_3d = mode === '3d';
    this.el.icon_3d.classList.toggle('hidden', in_3d);
    this.el.icon_2d.classList.toggle('hidden', !in_3d);
    this.el.mode_label.textContent = in_3d ? '2D view' : '3D view';
    // The scale bar only means something on the flat map — CSS hides it.
    document.body.classList.toggle('mode-3d', in_3d);
  }

  update_labels_button(on) {
    this.el.btn_labels.classList.toggle('active', on);
  }

  /** Refresh the timescale + rate readouts (called on time-scale changes). */
  update_time_readouts(sim) {
    this._set_text(this.el.timescale, `×${trim_scale(sim.time_scale)}`);
    this._set_text(this.el.rate, format_sim_rate(sim.dt_base, sim.time_scale));
  }

  // -------------------------------------------------------------------------
  //  Per-frame HUD mirror
  // -------------------------------------------------------------------------

  /** Called every frame by main.js. All writes are cached — steady state is
   *  free. */
  update(frame_state) {
    const sim = frame_state.sim;

    this._set_text(this.el.clock, format_sim_clock(sim.time));
    this.update_time_readouts(sim);

    if (frame_state.mode === '2d') {
      const cam = this.app.camera2d;
      this._set_text(this.el.zoom, `×${format_zoom(cam.zoom / cam.default_zoom)}`);
      this._update_scale_bar(cam.zoom);
    } else {
      // 3D has no single map scale — show the camera's distance to its
      // orbit target instead (display units are 1e9 m each).
      const cam3 = this.app.renderer3d?.camera3d;
      if (cam3) {
        const units = cam3.camera.position.distanceTo(cam3.controls.target);
        this._set_text(this.el.zoom, format_distance(units * 1e9));
      }
    }

    if (this.selected) {
      // Live stats tick along with the simulation.
      this._set_text(this.el.info_speed, format_speed(this.selected.speed));
      this._set_text(this.el.info_distance, format_distance(this.selected.dist_to_sun));

      // Panning silently breaks camera follow — keep the button honest.
      const following = this.app.is_following(this.selected);
      if (following !== this._follow_shown) this.update_follow_button(following);
    }
  }

  /** Round-number scale bar: the widest 1/2/5×10ⁿ length under the px cap. */
  _update_scale_bar(zoom) {
    const meters = nice_scale_length(SCALE_BAR_MAX_PX / zoom);
    const px = Math.round(meters * zoom * 2) / 2;
    if (px !== this._scale_width) {
      this._scale_width = px;
      this.el.scale_line.style.width = `${px}px`;
      this._set_text(this.el.scale_readout, format_distance(meters));
    }
  }

  /** Write textContent only when the string actually changed. */
  _set_text(element, text) {
    if (this._text_cache.get(element) !== text) {
      this._text_cache.set(element, text);
      element.textContent = text;
    }
  }

  // -------------------------------------------------------------------------
  //  Welcome overlay
  // -------------------------------------------------------------------------

  /** Title card: lingers ~3.2s, fades out, and any first input skips it. */
  flash_welcome() {
    const overlay = this.el.welcome;

    const dismiss = () => {
      if (this._welcome_dismissed) return;
      this._welcome_dismissed = true;
      clearTimeout(hold);
      window.removeEventListener('pointerdown', dismiss, true);
      window.removeEventListener('keydown', dismiss, true);
      window.removeEventListener('wheel', dismiss, true);
      overlay.classList.add('fade-out');
      setTimeout(() => overlay.classList.add('hidden'), WELCOME_FADE_MS);
    };

    const hold = setTimeout(dismiss, WELCOME_HOLD_MS);
    window.addEventListener('pointerdown', dismiss, true);
    window.addEventListener('keydown', dismiss, true);
    window.addEventListener('wheel', dismiss, true);
  }
}
