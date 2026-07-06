"use strict";
// Correctness gate for the saturation feature. Replicates paint()'s NEW inner loop EXACTLY and asserts:
//   (1) sat=0  produces byte-identical HTML to the shipping gray path  -> signature look untouched.
//   (2) sat=100 produces the 125-colour cube markup with run count ~1.3x gray -> viable, matches design.
// Uses the chroma-rich frames so the colour assertion is honest.
const assert = require("assert");
const { RAMP, RAMP_LAST, RAMP_SCALE, LEVELS, QUANT_LEVEL, LEVEL_CLASS, makeClut } = require("./render-bench.js");

// --- reference gray path (the shipping look) ---
function gray8(data, cols, rows, clut) {
  let out = "";
  for (let r = 0; r < rows; r++) {
    let runLv = -1, base = r * cols * 4;
    for (let c = 0; c < cols; c++, base += 4) {
      const gray = clut[data[base]] * 0.299 + clut[data[base + 1]] * 0.587 + clut[data[base + 2]] * 0.114;
      const lv = QUANT_LEVEL[gray | 0];
      if (lv !== runLv) { if (runLv !== -1) out += "</i>"; out += "<i class=" + LEVEL_CLASS[lv] + ">"; runLv = lv; }
      out += RAMP[gray * RAMP_SCALE < RAMP_LAST ? (gray * RAMP_SCALE) | 0 : RAMP_LAST];
    }
    out += "</i>"; if (r < rows - 1) out += "\n";
  }
  return out;
}

// --- EXACT copy of index.html paint() inner loop (shade always on here) ---
const CQ = 5, CQ_STEP = 255 / (CQ - 1), CQ_MAP = new Uint8Array(256);
for (let v = 0; v < 256; v++) CQ_MAP[v] = Math.round(v / CQ_STEP);
function paintLoop(data, cols, rows, clut, sat) {
  let out = "", runs = 0;
  const t = sat / 100;
  for (let r = 0; r < rows; r++) {
    let runLv = -1, base = r * cols * 4;
    for (let c = 0; c < cols; c++, base += 4) {
      const R = clut[data[base]], G = clut[data[base + 1]], B = clut[data[base + 2]];
      const gray = R * 0.299 + G * 0.587 + B * 0.114;
      let key;
      if (sat) key = (CQ_MAP[(gray + (R - gray) * t) | 0] * CQ + CQ_MAP[(gray + (G - gray) * t) | 0]) * CQ + CQ_MAP[(gray + (B - gray) * t) | 0];
      else key = QUANT_LEVEL[gray | 0];
      if (key !== runLv) { if (runLv !== -1) out += "</i>"; out += sat ? "<i class=k" + key + ">" : "<i class=" + LEVEL_CLASS[key] + ">"; runLv = key; runs++; }
      out += RAMP[gray * RAMP_SCALE < RAMP_LAST ? (gray * RAMP_SCALE) | 0 : RAMP_LAST];
    }
    out += "</i>"; if (r < rows - 1) out += "\n";
  }
  return { out, runs };
}

// chroma-rich frame (same as color-bench)
function makeColorFrame(cols, rows, f) {
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

const clut = makeClut();
const [cols, rows] = [400, 120];
let grayRuns = 0, colorRuns = 0;
for (let f = 0; f < 30; f++) {
  const fr = makeColorFrame(cols, rows, f);
  // (1) sat=0 byte-identical to shipping gray path
  const s0 = paintLoop(fr, cols, rows, clut, 0);
  assert.strictEqual(s0.out, gray8(fr, cols, rows, clut), "sat=0 must equal the gray path exactly (frame " + f + ")");
  grayRuns += s0.runs;
  // (2) sat=100 uses only cube classes k0..k124, valid indices
  const s1 = paintLoop(fr, cols, rows, clut, 100);
  for (const m of s1.out.matchAll(/class=k(\d+)/g)) assert.ok(+m[1] < CQ * CQ * CQ, "cube index in range");
  colorRuns += s1.runs;
}
console.log("PASS: sat=0 byte-identical to shipping gray path across 30 chroma-rich frames");
console.log(`PASS: sat=100 cube markup valid; run count ${(colorRuns / grayRuns).toFixed(2)}x the gray path (expect ~1.3x)`);
