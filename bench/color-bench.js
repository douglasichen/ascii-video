"use strict";
// Goal B measurement: is a per-cell COLOUR path viable? The renderer is bottlenecked by
// run/span count. Full 8-bit rgb() (the original, removed) gives ~16M possible colours ->
// adjacent cells almost never match -> runs never merge -> span count explodes -> DOM
// phase (innerHTML parse + layout + paint) tanks. Question: does aggressive per-channel
// quantization keep the palette small enough that runs still merge like the 8-gray path?
//
// We compare RUN COUNT (the documented proxy for the un-measurable DOM cost) of:
//   gray8         — current shipping path (8 levels, 1 channel) = the FPS-acceptable baseline
//   colorFull     — original 8-bit rgb(), full quality
//   colorQ{n}     — each channel quantized to n levels (palette n^3), class-per-colour markup
// on chroma-RICH frames (coloured bands + moving coloured disc + noise), which is the
// honest worst case (real video has real chroma; the gray bench frames were near-gray).

const { RAMP, RAMP_LAST, RAMP_SCALE, LEVELS, QUANT_LEVEL, LEVEL_CLASS, makeClut } = require("./render-bench.js");

// chroma-rich frame: three coloured gradient bands + a moving saturated disc + noise
function makeColorFrame(cols, rows, f) {
  const data = new Uint8ClampedArray(cols * rows * 4);
  const cx = cols * (0.5 + 0.32 * Math.sin(f * 0.11));
  const cy = rows * (0.5 + 0.32 * Math.cos(f * 0.13));
  const rad2 = (Math.min(cols, rows) * 0.26) ** 2;
  let seed = (f * 2654435761 + 12345) >>> 0;
  const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
  let i = 0;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const u = x / cols, v = y / rows;
      // three hue bands across the frame + brightness gradient -> real chroma variety
      let R, G, B;
      const band = (u + v * 0.3) % 1;
      const lum = 60 + 130 * v;
      if (band < 0.33) { R = lum * 1.3; G = lum * 0.6; B = lum * 0.5; }       // warm
      else if (band < 0.66) { R = lum * 0.5; G = lum * 1.2; B = lum * 0.7; }  // green
      else { R = lum * 0.5; G = lum * 0.7; B = lum * 1.35; }                  // blue
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy < rad2) { R += 90; G += 30; B -= 20; }            // hot disc
      const n = (rnd() - 0.5) * 22;
      data[i++] = R + n; data[i++] = G + n; data[i++] = B + n; data[i++] = 255;
    }
  }
  return data;
}

// current shipping gray path (reference), returns run count
function gray8(data, cols, rows, clut) {
  let out = "", runs = 0;
  for (let r = 0; r < rows; r++) {
    let runLv = -1, base = r * cols * 4;
    for (let c = 0; c < cols; c++, base += 4) {
      const gray = clut[data[base]] * 0.299 + clut[data[base + 1]] * 0.587 + clut[data[base + 2]] * 0.114;
      const lv = QUANT_LEVEL[gray | 0];
      if (lv !== runLv) { if (runLv !== -1) out += "</i>"; out += "<i class=" + LEVEL_CLASS[lv] + ">"; runLv = lv; runs++; }
      out += RAMP[gray * RAMP_SCALE < RAMP_LAST ? (gray * RAMP_SCALE) | 0 : RAMP_LAST];
    }
    out += "</i>"; if (r < rows - 1) out += "\n";
  }
  return { html: out, runs };
}

// original full 8-bit rgb() colour path
function colorFull(data, cols, rows, clut) {
  let out = "", runs = 0;
  for (let r = 0; r < rows; r++) {
    let runKey = -1, base = r * cols * 4;
    for (let c = 0; c < cols; c++, base += 4) {
      const cr = clut[data[base]], cg = clut[data[base + 1]], cb = clut[data[base + 2]];
      const gray = cr * 0.299 + cg * 0.587 + cb * 0.114;
      const key = (cr << 16) | (cg << 8) | cb;
      if (key !== runKey) { if (runKey !== -1) out += "</span>"; out += `<span style=color:#${key.toString(16).padStart(6, "0")}>`; runKey = key; runs++; }
      out += RAMP[gray * RAMP_SCALE < RAMP_LAST ? (gray * RAMP_SCALE) | 0 : RAMP_LAST];
    }
    out += "</span>"; if (r < rows - 1) out += "\n";
  }
  return { html: out, runs };
}

// quantized colour: each channel -> Q levels, palette index -> class (class-per-colour markup,
// mirrors the gray path's class approach so markup stays ~13B/run not ~24B inline).
function makeColorQ(Q) {
  const step = 255 / (Q - 1);
  const qmap = new Uint8Array(256);
  for (let v = 0; v < 256; v++) qmap[v] = Math.round(v / step); // 0..Q-1
  return function colorQ(data, cols, rows, clut) {
    let out = "", runs = 0;
    for (let r = 0; r < rows; r++) {
      let runKey = -1, base = r * cols * 4;
      for (let c = 0; c < cols; c++, base += 4) {
        const cr = clut[data[base]], cg = clut[data[base + 1]], cb = clut[data[base + 2]];
        const gray = cr * 0.299 + cg * 0.587 + cb * 0.114;
        const key = (qmap[cr] * Q + qmap[cg]) * Q + qmap[cb]; // palette index 0..Q^3-1
        if (key !== runKey) { if (runKey !== -1) out += "</i>"; out += "<i class=k" + key + ">"; runKey = key; runs++; }
        out += RAMP[gray * RAMP_SCALE < RAMP_LAST ? (gray * RAMP_SCALE) | 0 : RAMP_LAST];
      }
      out += "</i>"; if (r < rows - 1) out += "\n";
    }
    return { html: out, runs };
  };
}

function benchRuns(fn, frames, cols, rows, clut, iters) {
  for (let w = 0; w < 15; w++) fn(frames[w % frames.length], cols, rows, clut);
  let ms = 0, maxMs = 0, runs = 0, len = 0;
  for (let it = 0; it < iters; it++) {
    const fr = frames[it % frames.length];
    const s = process.hrtime.bigint();
    const o = fn(fr, cols, rows, clut);
    const e = process.hrtime.bigint();
    const d = Number(e - s) / 1e6; ms += d; if (d > maxMs) maxMs = d;
    runs = o.runs; len = o.html.length;
  }
  return { ms: ms / iters, maxMs, runs, len };
}

const grids = [[200, 60], [300, 90], [400, 120]];
const clut = makeClut();
const NF = 40, ITERS = 300;
console.log("colour viability — run count vs the FPS-acceptable gray8 baseline (chroma-rich frames)\n");
for (const [cols, rows] of grids) {
  const frames = [];
  for (let f = 0; f < NF; f++) frames.push(makeColorFrame(cols, rows, f));
  const g = benchRuns(gray8, frames, cols, rows, clut, ITERS);
  console.log(`grid ${cols}x${rows} (${cols * rows} cells)`);
  const ref = g.runs;
  const show = (name, r, palette) => console.log(
    `  ${name.padEnd(12)} runs=${String(r.runs).padStart(6)}  (${(r.runs / ref).toFixed(1)}x gray)  build=${r.ms.toFixed(2)}ms  html=${(r.len/1024|0)}KB  palette=${palette}`);
  show("gray8", g, LEVELS);
  show("colorFull", benchRuns(colorFull, frames, cols, rows, clut, ITERS), "~16M");
  for (const Q of [3, 4, 5, 6]) show("colorQ" + Q, benchRuns(makeColorQ(Q), frames, cols, rows, clut, ITERS), Q ** 3);
  console.log("");
}
