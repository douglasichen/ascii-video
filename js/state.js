// state.js — the app's configuration + shared mutable runtime state. A leaf module (imports nothing) so
// every other module can import it without cycles.
//
// SHARED-MUTABLE-STATE PATTERN: ES-module `import`s are read-only live bindings — an importer cannot do
// `cols = 5` on an imported `let`. The player reassigns shared primitives constantly (cols, recording,
// recStart, recFrames = [] …), so ALL of it lives on the exported `rt` object and is mutated in place
// (`rt.cols = …`, `rt.recording = true`). Any module can read AND write `rt.<field>` freely. `state`/`base`
// are already mutated-in-place objects, so they're exported directly.

// Every tunable lives here; `section` groups it in the panel (basic / advanced / music). Order matters —
// entries are rendered top-to-bottom and a section header is emitted whenever `section` changes.
export const CONTROLS = {
  // ── basic ────────────────────────────────────────────────────────────────
  detail: { label: "resolution", section: "basic", min: 1, max: 9, step: 1, default: 6, unit: "" },
  contrast: { label: "contrast", section: "basic", min: 0, max: 100, step: 1, default: 50, unit: "%" },
  brightness: { label: "brightness", section: "basic", min: 0, max: 100, step: 1, default: 50, unit: "%" },
  // base display colour. Shade mode ramps each level black -> this colour (tinted depth); turbo mode uses
  // it flat. White (#ffffff) = the classic gray look. type:"color" -> a swatch + an editable hex field.
  color: { label: "colour", section: "basic", type: "color", default: "#ffffff" },
  // ── advanced ─────────────────────────────────────────────────────────────
  invert: { label: "invert", section: "advanced", type: "checkbox", default: false },
  // shading on = per-cell <i> gray/tinted spans (the default look). Off = plain one-colour text via
  // textContent, which skips the span machinery (~20x cheaper dom, measured). "shading off" is turbo.
  shading: { label: "shading", section: "advanced", type: "checkbox", default: true },
  // per-cell video colour, 0 = grayscale (signature look, default), 100 = full source colour. Only active
  // with shading on. Affordable because the mixed colour snaps to a fixed CQ^3=125 cube so runs still merge
  // (~1.3x gray span count). Combines with the base colour (mixes base-tinted gray -> the video's colour).
  saturation: { label: "saturation", section: "advanced", min: 0, max: 100, step: 1, default: 0, unit: "%" },
  // Cap the render framerate (max 30). The video keeps playing at its own rate; lower = fewer DOM rebuilds.
  maxfps: { label: "max fps", section: "advanced", min: 5, max: 30, step: 1, default: 30, unit: "" },
  // Fade the audio up/down at each loop's start/end — smooth seam. Carried into baked embeds (bake header).
  fade: { label: "fade audio", section: "advanced", type: "checkbox", default: true },
  // ── music reactive ───────────────────────────────────────────────────────
  // The audio drives resolution + colour + a brightness/contrast pulse each frame (Web Audio AnalyserNode +
  // an adaptive beat detector; see applyReactivity). OFF by default. It reacts to AUDIBLE audio — the muted
  // auto-load clip won't pulse until you tap the speaker (a user-loaded clip plays unmuted and reacts
  // immediately), since the analyser taps the element's captured, post-mute output. `base` holds the resting
  // slider values; the audio swings around them and turning music off restores `base` exactly.
  react: { label: "music reactive", section: "music", type: "checkbox", default: false },
  sensitivity: { label: "sensitivity", section: "music", min: 0, max: 100, step: 1, default: 55, unit: "%" },
  // per-target react amounts (how hard the beat drives each, 0 = that target doesn't react). Under the MUSIC
  // header so "brightness"/"contrast"/"colour"/"resolution" read as "how much music drives this target".
  punch: { label: "brightness", section: "music", min: 0, max: 100, step: 1, default: 60, unit: "%" },
  contrastReact: { label: "contrast", section: "music", min: 0, max: 100, step: 1, default: 45, unit: "%" },
  colorReact: { label: "colour", section: "music", min: 0, max: 100, step: 1, default: 70, unit: "%" },
  resReact: { label: "resolution", section: "music", min: 0, max: 100, step: 1, default: 50, unit: "%" },
};

// `state` = live values read each frame; `base` = the user's resting values (music mode modulates the
// DRIVEN keys in `state` around `base`). setControl writes both; applyReactivity overwrites state's DRIVEN.
export const state = {}, base = {};
for (const key in CONTROLS) state[key] = base[key] = CONTROLS[key].default;
export const DRIVEN = ["brightness", "contrast", "color", "detail"]; // keys the audio overrides while music is on

// All shared mutable runtime state (see the pattern note at the top of this file). Reassigned in place by
// whichever module owns each concern:
//   cols/rows            — the current grid (render.computeGrid writes; paint + embedHash read)
//   DEBUG                — the 'd'-key profiler/bounds toggle (main writes; render reads)
//   computing            — a load is in flight, CTAs disabled (sources)
//   firstPaintPending    — hold the reveal until the first ascii frame paints (sources sets; render clears)
//   recording/recFrames/recTimes/recStart/baking/recPausedMs — baked-embed capture state (embed writes;
//                          paint pushes into recFrames/recTimes; computeGrid reads `recording` to freeze)
//   currentFile/currentSourceId — what's playing, for the deterministic embed key (sources writes; embed reads)
export const rt = {
  cols: 0, rows: 0,
  DEBUG: false,
  computing: false,
  firstPaintPending: false,
  recording: false, recFrames: [], recTimes: [], recStart: 0, baking: false, recPausedMs: 0,
  currentFile: null, currentSourceId: "",
};
