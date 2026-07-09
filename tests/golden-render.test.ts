import { test } from "vitest";
import assert from "node:assert";
// Golden render guard — the strongest regression lock for the "behaviour-preserving refactor". Imports the
// REAL hot loop (src/pure.ts buildFrameHTML — the exact code index.html's paint() calls) and asserts, across
// a matrix of settings + synthetic frames, that:
//   (1) the sat=0 gray path is BYTE-IDENTICAL to buildBaseline() — the pre-refactor paint() build that the
//       original render-bench already trusted. Locks the shipped look (shading on AND off).
//   (2) output is STABLE (deterministic: same input -> same bytes).
//   (3) sat>0 emits only valid cube classes k0..k124, and its VISIBLE characters match the gray path
//       (saturation only recolours; it must never change which glyph a cell gets).
//   (4) the captured packed cells feed codec.buildRows2 to BYTE-IDENTICAL markup (embed playback is
//       WYSIWYG vs the live render — glyphs AND colour, gray and cube paths both).
import * as P from "../src/pure";
import { buildRows2 } from "../src/codec";
import { makeFrame, makeColorFrame, makeClut, buildBaseline } from "./helpers";

const stripTags = (html: string) => html.replace(/<\/?i[^>]*>/g, ""); // leave just the glyph + newline stream
const countRuns = (html: string) => (html.match(/<i/g) || []).length; // one <i per span run ("</i>" won't match)

test("golden render — buildFrameHTML byte-identical to baseline, stable, cube-valid, codec glyphs agree", () => {
  let passes = 0;
  const ok = (c: boolean, m: string) => { assert.ok(c, m); passes++; };
  const eq = (a: unknown, b: unknown, m: string) => { assert.strictEqual(a, b, m); passes++; };

  const GRIDS: [number, number][] = [[120, 40], [200, 60]];
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
    const frames: Uint8ClampedArray[] = [];
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

        // (4) captured packed cells -> codec buildRows2 reproduces the live markup BYTE-FOR-BYTE
        //     (the .asciiv v:2 WYSIWYG lock: what the embed plays back is exactly what was on screen)
        const rec = new Uint16Array(cols * rows);
        const grayHtml = P.buildFrameHTML(fr, cols, rows, { shading: true, saturation: 0, color: "#ffffff" }, clut, rec);
        eq(buildRows2(rec, cols, rows, true, false), grayHtml, "codec buildRows2 byte-matches the live gray markup");
        eq(buildRows2(rec, cols, rows, false, false), stripTags(grayHtml), "codec buildRows2 (turbo) matches the plain-text render");

        // (3) saturation path: valid cube classes only, glyphs unchanged vs gray, and buildRows2 (cube)
        //     reproduces the saturated markup byte-for-byte from the capture
        for (const color of COLORS) {
          for (const saturation of [40, 100]) {
            const recSat = new Uint16Array(cols * rows);
            const satHtml = P.buildFrameHTML(fr, cols, rows, { shading: true, saturation, color }, clut, recSat);
            eq(P.buildFrameHTML(fr, cols, rows, { shading: true, saturation, color }, clut, null), satHtml, "sat>0 deterministic");
            for (const m of satHtml.matchAll(/class=k(\d+)/g)) ok(+m[1] < 125, "cube class in range 0..124");
            eq(stripTags(satHtml), stripTags(grayHtml), "saturation recolours only — glyph stream is unchanged");
            eq(buildRows2(recSat, cols, rows, true, true), satHtml, "codec buildRows2 (cube) byte-matches the live saturated markup");
          }
        }
      }
    }
  }

  console.log(`PASS: golden render — ${passes} assertions (byte-identical baseline, stability, cube validity, codec glyph agreement)`);
});

// The perf claim from CLAUDE.md: the saturation (125-colour cube) path keeps runs mergeable, costing only
// ~1.3x the gray span count — NOT the ~4.3x span explosion of raw per-cell RGB. Computed here from the REAL
// P.buildFrameHTML span count (count "<i" runs) on chroma-rich frames — the honest worst case. (Folded in from
// the deleted color.test.ts, which hand-reimplemented the loop; base "#ffffff" makes the tinted mix reduce to
// the same gray + (R-gray)*t the old copy asserted, so no coverage is lost.)
test("saturation run-count ratio — cube markup stays within ~1.3x the gray span count (perf claim)", () => {
  const clut = makeClut();
  const [cols, rows] = [400, 120];
  let grayRuns = 0, colorRuns = 0;
  for (let f = 0; f < 30; f++) {
    const fr = makeColorFrame(cols, rows, f);
    grayRuns += countRuns(P.buildFrameHTML(fr, cols, rows, { shading: true, saturation: 0, color: "#ffffff" }, clut, null));
    colorRuns += countRuns(P.buildFrameHTML(fr, cols, rows, { shading: true, saturation: 100, color: "#ffffff" }, clut, null));
  }
  const ratio = colorRuns / grayRuns;
  assert.ok(ratio > 1 && ratio <= 1.5, `sat=100 run count ${ratio.toFixed(2)}x gray — expected ~1.3x, must stay <=1.5x (else the merge broke)`);
  console.log(`PASS: saturation run-count ratio ${ratio.toFixed(2)}x the gray path (perf claim ~1.3x holds)`);
});
