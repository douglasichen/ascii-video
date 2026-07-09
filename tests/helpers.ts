// helpers.ts — the TRUSTED baseline + synthetic frame generators, ported verbatim from the old
// bench/render-bench.js and bench/color-check.js. These are INDEPENDENT reimplementations of the hot loop
// (constants mirrored by hand from pure.ts) so the golden-render test can assert the REAL buildFrameHTML is
// byte-identical to a reference the perf benches already trusted. Kept DOM-free so it runs headless.

// ---- constants mirrored EXACTLY from src/pure.ts ----
export const RAMP = " .:-=+*#%@";
export const RAMP_LAST = RAMP.length - 1;
export const RAMP_SCALE = RAMP.length / 255;
export const LEVELS = 8;
export const QUANT_LEVEL = new Uint8Array(256);
export const LEVEL_CLASS = new Array<string>(LEVELS);
for (let i = 0; i < LEVELS; i++) LEVEL_CLASS[i] = String.fromCharCode(97 + i);
for (let v = 0; v < 256; v++) QUANT_LEVEL[v] = Math.round((v / 255) * (LEVELS - 1));

// ---- realistic synthetic frame: RGBA Uint8ClampedArray, cols*rows*4 ----
// Smooth diagonal gradient (large flat-ish regions -> runs merge) + a moving bright disc (moving shape ->
// frame-to-frame change) + mild per-pixel noise. Channels differ a little so the colour path sees real chroma.
export function makeFrame(cols: number, rows: number, f: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(cols * rows * 4);
  const cx = cols * (0.5 + 0.35 * Math.sin(f * 0.11));
  const cy = rows * (0.5 + 0.35 * Math.cos(f * 0.13));
  const rad = Math.min(cols, rows) * 0.28;
  const rad2 = rad * rad;
  let seed = (f * 2654435761) >>> 0; // deterministic per-frame PRNG (xorshift)
  const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
  let i = 0;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      let base = 40 + 170 * ((x / cols) * 0.6 + (y / rows) * 0.4); // smooth gradient 40..210
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy < rad2) base += 70; // bright disc
      const v = base + (rnd() - 0.5) * 24;      // mild noise
      data[i++] = v * 1.02; // R
      data[i++] = v;        // G
      data[i++] = v * 0.95; // B
      data[i++] = 255;      // A
    }
  }
  return data;
}

export function makeClut(contrast = 50, brightness = 50, invert = false): Uint8ClampedArray {
  const clut = new Uint8ClampedArray(256);
  const cf = contrast / 50, bo = (brightness - 50) * 2.55;
  for (let v = 0; v < 256; v++) {
    let x = (v - 128) * cf + 128;
    if (invert) x = 255 - (x < 0 ? 0 : x > 255 ? 255 : x);
    clut[v] = x + bo;
  }
  return clut;
}

// BASELINE — exact copy of the pre-refactor paint() build phase (shaded + turbo). buildFrameHTML must
// stay byte-identical to this for the sat=0 gray path.
export function buildBaseline(data: Uint8ClampedArray, cols: number, rows: number, clut: Uint8ClampedArray, shade: boolean): { html: string; runs: number } {
  const parts: string[] = [];
  let runs = 0;
  for (let r = 0; r < rows; r++) {
    let runLv = -1;
    let base = r * cols * 4;
    for (let c = 0; c < cols; c++, base += 4) {
      const gray = clut[data[base]] * 0.299 + clut[data[base + 1]] * 0.587 + clut[data[base + 2]] * 0.114;
      if (shade) {
        const lv = QUANT_LEVEL[gray | 0];
        if (lv !== runLv) {
          if (runLv !== -1) parts.push("</i>");
          parts.push("<i class=", LEVEL_CLASS[lv], ">");
          runLv = lv;
          runs++;
        }
      }
      const ci = gray * RAMP_SCALE < RAMP_LAST ? (gray * RAMP_SCALE) | 0 : RAMP_LAST;
      parts.push(RAMP[ci]);
    }
    if (shade) parts.push("</i>");
    if (r < rows - 1) parts.push("\n");
  }
  return { html: parts.join(""), runs };
}

// chroma-rich frame (from color-bench/color-check): three coloured gradient bands + a moving saturated disc
// + noise — the honest worst case for the colour/saturation run-merge assertions.
export function makeColorFrame(cols: number, rows: number, f: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(cols * rows * 4);
  const cx = cols * (0.5 + 0.32 * Math.sin(f * 0.11)), cy = rows * (0.5 + 0.32 * Math.cos(f * 0.13));
  const rad2 = (Math.min(cols, rows) * 0.26) ** 2;
  let seed = (f * 2654435761 + 12345) >>> 0;
  const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
  let i = 0;
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    const u = x / cols, v = y / rows; let R, G, B; const band = (u + v * 0.3) % 1, lum = 60 + 130 * v;
    if (band < 0.33) { R = lum * 1.3; G = lum * 0.6; B = lum * 0.5; }
    else if (band < 0.66) { R = lum * 0.5; G = lum * 1.2; B = lum * 0.7; }
    else { R = lum * 0.5; G = lum * 0.7; B = lum * 1.35; }
    const dx = x - cx, dy = y - cy; if (dx * dx + dy * dy < rad2) { R += 90; G += 30; B -= 20; }
    const n = (rnd() - 0.5) * 22; data[i++] = R + n; data[i++] = G + n; data[i++] = B + n; data[i++] = 255;
  }
  return data;
}
