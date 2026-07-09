// pure.ts — the DOM-free core of the renderer. Every function here is a pure computation (no document,
// no window, no module-global mutable state), so it can be imported and unit-tested under Node exactly as
// the browser runs it (see tests/pure.test.ts, tests/golden-render.test.ts). render.ts / reactive.ts /
// sources.ts / embed.ts import from here and add only the thin DOM glue. Keeping the byte-exact hot loop,
// the quantization tables, the palette/LUT math and the parsers in ONE testable place is the regression
// guard for "behaviour-preserving refactor": the app and the tests call the SAME code.

// Minimal render settings buildFrameHTML reads (a structural subset of State — the tests pass partial
// literals, so keep this narrow). embedSig reads the full keyed set below.
export interface FrameSettings {
  shading: boolean;
  saturation: number;
  color: string;
}
export interface EmbedSettings {
  color: string;
  shading: boolean;
  detail: number;
  saturation: number;
  contrast: number;
  brightness: number;
  invert: boolean;
  fade: boolean;
  maxfps: number;
}

export const RAMP = " .:-=+*#%@";
export const RAMP_LAST = RAMP.length - 1;
export const RAMP_SCALE = RAMP.length / 255;
export const CHAR_ASPECT = 0.55; // monospace cell width:height compensation

// Quantized to LEVELS levels. Each level is a CSS class (one rule each in one <style>), and cells emit
// `<i class=h>` (~11B) instead of `<span style="color:#rrggbb">` (~28B): the shortest element tag +
// shared class styles mean far less markup AND the browser resolves a handful of class styles instead of
// tens of thousands of inline ones. Fewer levels -> adjacent cells share a level more often -> runs merge
// -> fewer spans -> less markup + less per-frame allocation, which is what tames the GC pauses that show
// up as huge random FPS drops. 8 is the sweet spot: dropping from 16 roughly halves the span count with
// banding still hidden by the char ramp. (turbo mode skips spans entirely; <i> is forced upright below.
// Per-cell RGB from the video was removed — 16^3 colours shatter run-merging, git history — but ONE base
// colour is cheap: the levels just ramp black -> that colour, so it stays <= LEVELS distinct colours.)
export const LEVELS = 8;
export const QUANT_LEVEL = new Uint8Array(256); // luminance -> level index 0..LEVELS-1 (compare key + class index)
export const LEVEL_CLASS = new Array<string>(LEVELS);   // level index -> interned class-name string ("a".."h")
for (let i = 0; i < LEVELS; i++) LEVEL_CLASS[i] = String.fromCharCode(97 + i);
for (let v = 0; v < 256; v++) QUANT_LEVEL[v] = Math.round(v / 255 * (LEVELS - 1));

// Per-cell colour cube. Each channel is quantized to CQ levels, so the whole palette is CQ^3 fixed
// colours. That small palette is the ENTIRE reason per-cell colour is affordable here: adjacent cells
// keep landing in the same bucket, so runs still merge (~1.3x the gray span count at CQ=5, measured;
// the old full-8-bit-RGB path was ~4.3x and tanked FPS — see bench/color-bench.js). Like the gray
// levels, each palette colour is ONE static CSS class (`.k123{color:#rrggbb}`), so a cell emits
// `<i class=k123>` (short markup, browser resolves ~125 shared rules, not tens of thousands of inline
// styles). The cube is FIXED (frame- and base-colour-independent), so its <style> is built exactly once.
export const CQ = 5;                              // levels per channel -> 125-colour palette
export const CQ_STEP = 255 / (CQ - 1);
export const CQ_MAP = new Uint8Array(256);        // channel value 0..255 -> cube level 0..CQ-1
for (let v = 0; v < 256; v++) CQ_MAP[v] = Math.round(v / CQ_STEP);

// #screen <style>: level i ramps from black (i=0) to the base colour (i=LEVELS-1), so luminance depth is
// kept but tinted. Base white reproduces the classic black->white gray ramp exactly. Byte-identical to
// codec.ts's buildPaletteCSS (the embed player), so the live look and the baked look never drift.
export function buildPaletteCSS(color: string): string {
  const r = parseInt(color.slice(1, 3), 16), g = parseInt(color.slice(3, 5), 16), b = parseInt(color.slice(5, 7), 16);
  let css = "#screen i{font-style:normal}"; // <i> defaults to italic; keep the glyphs upright
  for (let i = 0; i < LEVELS; i++) {
    const f = i / (LEVELS - 1);
    const hex = [r, g, b].map(x => Math.round(x * f).toString(16).padStart(2, "0")).join("");
    css += `#screen .${LEVEL_CLASS[i]}{color:#${hex}}`;
  }
  return css;
}

// The fixed CQ^3=125-colour cube's <style>, built once. key = (r*CQ+g)*CQ+b (must match buildFrameHTML).
export function buildColorCubeCSS(): string {
  let css = "";
  for (let i = 0; i < CQ * CQ * CQ; i++) {
    const b = i % CQ, g = (i / CQ | 0) % CQ, r = (i / (CQ * CQ)) | 0; // key = (r*CQ+g)*CQ+b (matches paint)
    const hex = [r, g, b].map(x => Math.round(x * CQ_STEP).toString(16).padStart(2, "0")).join("");
    css += `#screen .k${i}{color:#${hex}}`;
  }
  return css;
}

// Contrast, invert and brightness all fold into the same 256-entry LUT (Uint8Clamped clamps for us), so
// they cost nothing per pixel — applied before quantization, they shift the whole luminance -> which gray
// level / char each cell lands on. ORDER MATTERS: contrast (scale around 128), THEN invert (255 - value, a
// photo negative, dark<->light), THEN brightness (additive). Brightness is added last so it still
// brightens the *displayed* image whether or not invert is on — folding it in before the invert would
// reverse the slider. (Clamp the contrast result before inverting so brightness lands correctly.)
export function buildContrastLUT(clut: Uint8ClampedArray, contrast: number, brightness: number, invert: boolean): void {
  const contrastFactor = contrast / 50;          // 50% = neutral (factor 1)
  const brightOffset = (brightness - 50) * 2.55; // 50% = neutral (0); ±50 steps -> ~±128 offset
  for (let v = 0; v < 256; v++) {
    let x = (v - 128) * contrastFactor + 128;
    if (invert) x = 255 - (x < 0 ? 0 : x > 255 ? 255 : x);
    clut[v] = x + brightOffset;
  }
}

export const fontPxFor = (detail: number): number => 22 - detail * 2; // detail 1 (chunky, 20px) .. 9 (fine, 4px)

// Grid math split out of computeGrid so it can be tested without a DOM. Fits cols*rows to the available
// space at the given font size, preserving the video aspect (corrected for the monospace cell ratio).
export function gridDims(fontPx: number, availW: number, availH: number, videoW: number, videoH: number): { cols: number; rows: number } {
  const maxCols = Math.floor(availW / (fontPx * 0.6));
  const maxRows = Math.floor(availH / fontPx);
  const videoRatio = (videoH / videoW) * CHAR_ASPECT;
  let cols = maxCols;
  let rows = Math.round(cols * videoRatio);
  if (rows > maxRows) {
    rows = maxRows;
    cols = Math.round(rows / videoRatio);
  }
  cols = Math.max(1, cols);
  rows = Math.max(1, rows);
  return { cols, rows };
}

// THE HOT PATH. Sampled RGBA `data` (cols*rows*4) + the live render settings `s` + the per-frame contrast
// LUT `clut` -> the exact ASCII markup #screen renders. Assemble the whole frame into ONE string via +=,
// not an array-of-parts + join(): V8 grows it as a cons-string (rope) and flattens once at assignment, so
// this skips both the per-cell array.push AND the join — measured ~68% less build time AND ~4x lower
// worst-frame (the array+join path GC-spiked to 7-10ms; this holds ~2ms), on byte-identical output. See
// bench/render-bench.js. When `rec` (a Uint8Array cols*rows) is passed it's filled with each cell's char
// index (embed capture). Byte-for-byte identical to the pre-refactor paint() inner loop.
export function buildFrameHTML(
  data: Uint8ClampedArray | Uint8Array,
  cols: number,
  rows: number,
  s: FrameSettings,
  clut: Uint8ClampedArray,
  rec: Uint8Array | null,
): string {
  let out = "";
  const shade = s.shading; // per-cell tinted spans vs plain one-colour text
  const sat = s.saturation; // 0 = gray levels (signature look); >0 = quantized per-cell video colour
  const t = sat / 100;      // mix amount toward the source colour
  // Base colour AND saturation combine (not mutually exclusive): saturation mixes from the base-tinted
  // gray toward the video's own colour, so the chosen colour still tints the low end at any saturation.
  const bc = s.color;
  const baseR = parseInt(bc.slice(1, 3), 16), baseG = parseInt(bc.slice(3, 5), 16), baseB = parseInt(bc.slice(5, 7), 16);
  for (let r = 0; r < rows; r++) {
    let runLv = -1; // current run key (gray level 0..7, OR colour-cube index 0..124); -1 = none open (per row)
    let base = r * cols * 4;
    for (let c = 0; c < cols; c++, base += 4) {
      const R = clut[data[base]], G = clut[data[base + 1]], B = clut[data[base + 2]];
      const gray = R * 0.299 + G * 0.587 + B * 0.114;
      if (shade) {
        // sat=0: quantize luminance to a gray level (unchanged signature path). sat>0: mix each channel
        // toward the source colour by t, then snap to the CQ^3 colour cube -> a small, run-mergeable palette.
        let key;
        if (sat) {
          const gf = gray / 255, bR = baseR * gf, bG = baseG * gf, bB = baseB * gf; // base colour tinted by this cell's luminance
          key = (CQ_MAP[(bR + (R - bR) * t) | 0] * CQ + CQ_MAP[(bG + (G - bG) * t) | 0]) * CQ + CQ_MAP[(bB + (B - bB) * t) | 0];
        } else key = QUANT_LEVEL[gray | 0];
        if (key !== runLv) {
          if (runLv !== -1) out += "</i>";
          out += sat ? "<i class=k" + key + ">" : "<i class=" + LEVEL_CLASS[key] + ">";
          runLv = key;
        }
      }
      const ci = gray * RAMP_SCALE < RAMP_LAST ? (gray * RAMP_SCALE) | 0 : RAMP_LAST;
      out += RAMP[ci];
      if (rec) rec[r * cols + c] = ci;
    }
    if (shade) out += "</i>";
    if (r < rows - 1) out += "\n";
  }
  return out;
}

// ── music-reactive colour helpers (pure maths) ─────────────────────────────────────────────────────────
export const clamp = (v: number, lo: number, hi: number): number => v < lo ? lo : v > hi ? hi : v;
export const bandAvg = (a: Uint8Array, lo: number, hi: number): number => { let s = 0; for (let i = lo; i < hi; i++) s += a[i]; return s / (hi - lo) / 255; };

// HSL→hex so a beat can push hue/lightness while staying one base colour (≤8/frame)
export function hslHex(h: number, s: number, l: number): string {
  h = ((h % 360) + 360) % 360; s /= 100; l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), mm = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0]; else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x]; else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c]; else [r, g, b] = [c, 0, x];
  return "#" + [r, g, b].map(v => Math.round((v + mm) * 255).toString(16).padStart(2, "0")).join("");
}
// starting hue for the drift = the hue of the user's chosen base colour
export function hexHue(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (!d) return 210;
  let hh; if (mx === r) hh = ((g - b) / d) % 6; else if (mx === g) hh = (b - r) / d + 2; else hh = (r - g) / d + 4;
  return hh * 60;
}
// linear RGB interpolation a→b by t (colour-react blends base → audio colour)
export function mixHex(a: string, b: string, t: number): string {
  const pa = [1, 3, 5].map(i => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map(i => parseInt(b.slice(i, i + 2), 16));
  return "#" + pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, "0")).join("");
}

// Strip playlist / index / timestamp cruft down to a clean watch URL so we resolve the single video the
// user pasted, not the playlist it lives in. Handles watch?v=, youtu.be/, shorts/, embed/, live/.
// Falls back to the raw string if no 11-char id is found (let the resolver try).
export function normalizeYouTube(raw: string): string {
  try {
    const u = new URL(raw.includes("://") ? raw : "https://" + raw);
    let id = u.searchParams.get("v") || "";
    if (!id && u.hostname.includes("youtu.be")) id = u.pathname.slice(1);
    if (!id) { const m = u.pathname.match(/\/(?:shorts|embed|live|v)\/([^/?#]+)/); if (m) id = m[1]; }
    id = id.split(/[/?#&]/)[0];
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? "https://www.youtube.com/watch?v=" + id : raw;
  } catch { return raw; }
}

// Canonical signature that keys a baked embed. It's the source id (or file-content hash, added in embed.ts)
// PLUS the exact render settings, so an identical source+look always hashes to the same S3 key (instant
// snippet + dedup). Every field that changes the baked artifact MUST be here: colour/shading/detail/
// saturation/contrast/brightness/invert and the grid, plus fade (rides the header) and maxfps (sets the
// captured frame count/fps) — else changing only those re-hits the cache and serves a stale bake.
export function embedSig(sourceId: string, s: EmbedSettings, cols: number, rows: number): string {
  return JSON.stringify([sourceId, s.color, s.shading, s.detail,
    s.saturation, s.contrast, s.brightness, s.invert, cols, rows,
    s.fade, s.maxfps]);
}
