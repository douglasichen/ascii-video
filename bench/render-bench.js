"use strict";
// Headless bench for index.html's paint() BUILD phase. Node, no deps.
// The renderer is bottlenecked by span/run count (HTML build + innerHTML parse +
// layout + paint all scale with it), NOT per-pixel math — see CLAUDE.md. innerHTML
// can't run in node, so we measure the two things we CAN: build time (parts assembly
// + join, the CPU half of the frame) and run count (the documented proxy for the
// DOM/layout/paint half). Frames are synthetic but realistic (smooth gradient +
// moving disc + mild noise) so run-merging behaves like video, not flat colour.

// ---- constants mirrored EXACTLY from index.html ----
const RAMP = " .:-=+*#%@";
const RAMP_LAST = RAMP.length - 1;
const RAMP_SCALE = RAMP.length / 255;
const LEVELS = 8;
const QUANT_LEVEL = new Uint8Array(256);
const LEVEL_CLASS = new Array(LEVELS);
for (let i = 0; i < LEVELS; i++) LEVEL_CLASS[i] = String.fromCharCode(97 + i);
for (let v = 0; v < 256; v++) QUANT_LEVEL[v] = Math.round((v / 255) * (LEVELS - 1));

// ---- realistic synthetic frame: RGBA Uint8ClampedArray, cols*rows*4 ----
// Smooth diagonal gradient (large flat-ish regions -> runs merge) + a moving bright
// disc (moving shape -> frame-to-frame change) + mild per-pixel noise (breaks up
// perfect flats the way real video sensor noise / texture does). Channels differ a
// little so the colour path sees real chroma, not gray.
function makeFrame(cols, rows, f) {
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

function makeClut(contrast = 50, brightness = 50, invert = false) {
  const clut = new Uint8ClampedArray(256);
  const cf = contrast / 50, bo = (brightness - 50) * 2.55;
  for (let v = 0; v < 256; v++) {
    let x = (v - 128) * cf + 128;
    if (invert) x = 255 - (x < 0 ? 0 : x > 255 ? 255 : x);
    clut[v] = x + bo;
  }
  return clut;
}

// ---- BUILD VARIANTS ----
// Each returns { html, runs }. html must stay byte-identical across pure-speed
// variants (asserted vs baseline for every frame).

// A: BASELINE — exact copy of index.html paint() build phase (shaded + turbo).
function buildBaseline(data, cols, rows, clut, shade) {
  const parts = [];
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

module.exports = {
  RAMP, RAMP_LAST, RAMP_SCALE, LEVELS, QUANT_LEVEL, LEVEL_CLASS,
  makeFrame, makeClut, buildBaseline,
};

// assert a variant produces byte-identical html to baseline across ALL frames
function sameAll(buildFn, frames, cols, rows, clut, shade) {
  for (const fr of frames) {
    if (buildFn(fr, cols, rows, clut, shade).html !== buildBaseline(fr, cols, rows, clut, shade).html) return false;
  }
  return true;
}
module.exports.sameAll = sameAll;

function bench(buildFn, frames, cols, rows, clut, shade, iters) {
  for (let w = 0; w < 20; w++) buildFn(frames[w % frames.length], cols, rows, clut, shade); // warm JIT
  let totalMs = 0, maxMs = 0, runs = 0, htmlLen = 0;
  for (let it = 0; it < iters; it++) {
    const fr = frames[it % frames.length];
    const s = process.hrtime.bigint();
    const out = buildFn(fr, cols, rows, clut, shade);
    const e = process.hrtime.bigint();
    const ms = Number(e - s) / 1e6;
    totalMs += ms; if (ms > maxMs) maxMs = ms;
    runs = out.runs; htmlLen = out.html.length;
  }
  return { ms: totalMs / iters, maxMs, runs, htmlLen };
}

if (require.main === module) {
  const grids = [[200, 60], [300, 90], [400, 120]];
  const clut = makeClut();
  const NFRAMES = 40, ITERS = 400;
  let extra = {};
  try { extra = require("./variants.js"); } catch { /* none yet */ }

  console.log("build-phase bench — ms/frame (avg over " + ITERS + "), runs = <i> span count\n");
  for (const [cols, rows] of grids) {
    const frames = [];
    for (let f = 0; f < NFRAMES; f++) frames.push(makeFrame(cols, rows, f));
    console.log(`grid ${cols}x${rows}  (${cols * rows} cells)`);
    for (const shade of [true, false]) {
      const tag = shade ? "shading ON " : "shading OFF";
      const base = bench(buildBaseline, frames, cols, rows, clut, shade, ITERS);
      console.log(`  [${tag}] baseline         ${base.ms.toFixed(3)} ms (max ${base.maxMs.toFixed(2)})  runs=${base.runs}  html=${base.htmlLen}B`);
      for (const key of Object.keys(extra)) {
        const v = bench(extra[key], frames, cols, rows, clut, shade, ITERS);
        const same = sameAll(extra[key], frames, cols, rows, clut, shade);
        const spd = (base.ms - v.ms) / base.ms * 100;
        console.log(`  [${tag}] ${key.padEnd(16)}${v.ms.toFixed(3)} ms (max ${v.maxMs.toFixed(2)})  runs=${v.runs}  html=${v.htmlLen}B  ${spd >= 0 ? "-" : "+"}${Math.abs(spd).toFixed(1)}%  ${same ? "IDENTICAL" : "*** DIFFERS ***"}`);
      }
    }
    console.log("");
  }
}
