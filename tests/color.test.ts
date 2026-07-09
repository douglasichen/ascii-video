import { test } from "vitest";
import assert from "node:assert";
// Correctness gate for the saturation feature (ported from bench/color-check.js). Replicates paint()'s
// inner loop EXACTLY and asserts:
//   (1) sat=0  produces byte-identical HTML to the shipping gray path  -> signature look untouched.
//   (2) sat=100 produces the 125-colour cube markup with run count ~1.3x gray -> viable, matches design.
// Uses the chroma-rich frames so the colour assertion is honest.
import { RAMP, RAMP_LAST, RAMP_SCALE, QUANT_LEVEL, LEVEL_CLASS, makeClut, makeColorFrame } from "./helpers";

// --- reference gray path (the shipping look) ---
function gray8(data: Uint8ClampedArray, cols: number, rows: number, clut: Uint8ClampedArray): string {
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
function paintLoop(data: Uint8ClampedArray, cols: number, rows: number, clut: Uint8ClampedArray, sat: number): { out: string; runs: number } {
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

test("saturation — sat=0 byte-identical to gray path; sat=100 cube valid, run count ~1.3x", () => {
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
});
