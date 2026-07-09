// state.ts — the app's configuration + shared mutable runtime state. A leaf module (imports nothing) so
// every other module can import it without cycles.
//
// SHARED-MUTABLE-STATE PATTERN: ES-module `import`s are read-only live bindings — an importer cannot do
// `cols = 5` on an imported `let`. The player reassigns shared primitives constantly (cols, recording,
// recStart, recFrames = [] …), so ALL of it lives on the exported `rt` object and is mutated in place
// (`rt.cols = …`, `rt.recording = true`). Any module can read AND write `rt.<field>` freely. `state`/`base`
// are already mutated-in-place objects, so they're exported directly.

// A CONTROLS entry: a range slider by default, or a colour/checkbox. `section` groups it in the panel.
export interface ControlDef {
  label: string;
  section: "basic" | "advanced" | "music";
  type?: "color" | "checkbox";
  min?: number;
  max?: number;
  step?: number;
  default: number | boolean | string;
  unit?: string;
}

// Precise per-key value types so `state.detail` is a number, `state.color` a string, etc. (a plain
// Record<string, number|boolean|string> would union every field and break the hot-path arithmetic).
export interface State {
  detail: number;
  contrast: number;
  brightness: number;
  color: string;
  invert: boolean;
  shading: boolean;
  saturation: number;
  maxfps: number;
  fade: boolean;
  react: boolean;
  sensitivity: number;
  punch: number;
  contrastReact: number;
  colorReact: number;
  resReact: number;
}

// Every tunable lives here; `section` groups it in the panel (basic / advanced / music). Order matters —
// entries are rendered top-to-bottom and a section header is emitted whenever `section` changes.
export const CONTROLS: Record<keyof State, ControlDef> = {
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
export const state = {} as State, base = {} as State;
// Populated from the CONTROLS defaults; the per-key value types are enforced by the State interface above,
// so the loop writes through an untyped view (a plain string-keyed assignment of a union default).
for (const key in CONTROLS) (state as unknown as Record<string, unknown>)[key] = (base as unknown as Record<string, unknown>)[key] = CONTROLS[key as keyof State].default;
export const DRIVEN: (keyof State)[] = ["brightness", "contrast", "color", "detail"]; // keys the audio overrides while music is on

// All shared mutable runtime state (see the pattern note at the top of this file). Reassigned in place by
// whichever module owns each concern:
//   cols/rows            — the current grid (render.computeGrid writes; paint + embedHash read)
//   DEBUG                — the 'd'-key profiler/bounds toggle (main writes; render reads)
//   computing            — a load is in flight, CTAs disabled (sources)
//   firstPaintPending    — hold the reveal until the first ascii frame paints (sources sets; render clears)
//   recording/recFrames/recTimes/recStart/baking/recPausedMs — baked-embed capture state (embed writes;
//                          paint pushes into recFrames/recTimes; computeGrid reads `recording` to freeze)
//   currentFile/currentSourceId — what's playing, for the deterministic embed key (sources writes; embed reads)
export interface Rt {
  cols: number;
  rows: number;
  DEBUG: boolean;
  computing: boolean;
  firstPaintPending: boolean;
  recording: boolean;
  recFrames: Uint8Array[];
  recTimes: number[];
  recStart: number;
  baking: boolean;
  recPausedMs: number;
  currentFile: File | null;
  currentSourceId: string;
}
export const rt: Rt = {
  cols: 0, rows: 0,
  DEBUG: false,
  computing: false,
  firstPaintPending: false,
  recording: false, recFrames: [], recTimes: [], recStart: 0, baking: false, recPausedMs: 0,
  currentFile: null, currentSourceId: "",
};
