"use strict";
// Golden render guard — the strongest regression lock for the "behaviour-preserving refactor". Imports the
// REAL hot loop (js/pure.js buildFrameHTML — the exact code index.html's paint() calls) and asserts, across
// a matrix of settings + synthetic frames, that:
//   (1) the sat=0 gray path is BYTE-IDENTICAL to buildBaseline() — the pre-refactor paint() build that the
//       existing render-bench.js already trusts. Locks the shipped look (shading on AND off).
//   (2) output is STABLE (deterministic: same input -> same bytes).
//   (3) sat>0 emits only valid cube classes k0..k124, and its VISIBLE characters match the gray path
//       (saturation only recolours; it must never change which glyph a cell gets).
//   (4) the captured char-indices feed asciiv-codec.buildRows to the SAME characters (embed<->live agree on
//       glyphs; the colour level is re-derived in the embed and may differ, which is by design).
// Node, no deps, plain assert.
const assert = require("assert");
const ASCIIV = require("../asciiv-codec.js");
const { makeFrame, makeClut, buildBaseline } = require("./render-bench.js");

let passes = 0;
const ok = (c, m) => { assert.ok(c, m); passes++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); passes++; };
const stripTags = (html) => html.replace(/<\/?i[^>]*>/g, ""); // leave just the glyph + newline stream

(async () => {
  const P = await import("../js/pure.js");

  const GRIDS = [[120, 40], [200, 60]];
  const CLUTS = [
    makeClut(50, 50, false),  // neutral
    makeClut(0, 50, false),   // min contrast
    makeClut(100, 50, false), // max contrast
    makeClut(50, 0, false),   // dark
    makeClut(50, 100, false), // bright
    makeClut(50, 50, true),   // invert
    makeClut(0, 100, true),   // invert + bright + flat
    makeClut(100, 0, true),   // invert + dark + punchy
  ];
  const COLORS = ["#ffffff", "#32cd32", "#ff00ff", "#0088ff"];
  const NFRAMES = 8;

  for (const [cols, rows] of GRIDS) {
    const frames = [];
    for (let f = 0; f < NFRAMES; f++) frames.push(makeFrame(cols, rows, f));

    for (const clut of CLUTS) {
      for (const fr of frames) {
        // (1) sat=0, shading on/off -> byte-identical to the trusted baseline. Base colour is irrelevant to
        //     the sat=0 markup (levels are class letters a..h; colour only drives the CSS palette), so any
        //     colour must reproduce the baseline exactly.
        for (const shading of [true, false]) {
          const s = { shading, saturation: 0, color: "#ffffff" };
          const got = P.buildFrameHTML(fr, cols, rows, s, clut, null);
          const want = buildBaseline(fr, cols, rows, clut, shading).html;
          eq(got, want, `sat=0 shading=${shading} must byte-match baseline (${cols}x${rows})`);
          // (2) stability
          eq(P.buildFrameHTML(fr, cols, rows, s, clut, null), got, "buildFrameHTML is deterministic");
          // colour choice doesn't move the sat=0 markup
          eq(P.buildFrameHTML(fr, cols, rows, { shading, saturation: 0, color: "#32cd32" }, clut, null), got, "sat=0 markup is colour-independent");
        }

        // (4) captured char-indices -> codec buildRows produces the SAME glyphs as the live gray path
        const rec = new Uint8Array(cols * rows);
        const grayHtml = P.buildFrameHTML(fr, cols, rows, { shading: true, saturation: 0, color: "#ffffff" }, clut, rec);
        eq(stripTags(ASCIIV.buildRows(rec, cols, rows, true)), stripTags(grayHtml), "codec buildRows glyphs match the live gray path");
        eq(stripTags(ASCIIV.buildRows(rec, cols, rows, false)), stripTags(grayHtml), "codec buildRows (turbo) glyphs match too");

        // (3) saturation path: valid cube classes only, glyphs unchanged vs gray
        for (const color of COLORS) {
          for (const saturation of [40, 100]) {
            const satHtml = P.buildFrameHTML(fr, cols, rows, { shading: true, saturation, color }, clut, null);
            eq(P.buildFrameHTML(fr, cols, rows, { shading: true, saturation, color }, clut, null), satHtml, "sat>0 deterministic");
            for (const m of satHtml.matchAll(/class=k(\d+)/g)) ok(+m[1] < 125, "cube class in range 0..124");
            eq(stripTags(satHtml), stripTags(grayHtml), "saturation recolours only — glyph stream is unchanged");
          }
        }
      }
    }
  }

  console.log(`PASS: golden render — ${passes} assertions (byte-identical baseline, stability, cube validity, codec glyph agreement)`);
})().catch(e => { console.error(e); process.exit(1); });
