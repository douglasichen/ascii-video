"use strict";
// Unit tests for js/pure.js — the REAL module the browser runs (imported here via dynamic import so a
// refactor regression is actually caught, unlike the older benches which replicate the logic). Node, no
// deps, plain assert, matches the bench/ style. Covers: palette ramp, contrast-LUT ORDER, grid math,
// the 125-colour saturation cube, the music colour helpers, normalizeYouTube, embedSig determinism.
const assert = require("assert");
const ASCIIV = require("../asciiv-codec.js");

let passes = 0;
const ok = (c, m) => { assert.ok(c, m); passes++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); passes++; };

(async () => {
  const P = await import("../js/pure.js");

  // ── buildPaletteCSS: black -> base ramp, ≤ LEVELS colours, byte-identical to the embed codec ──────────
  for (const color of ["#ffffff", "#32cd32", "#ff00ff", "#000000", "#123456"]) {
    const css = P.buildPaletteCSS(color);
    eq(css, ASCIIV.buildPaletteCSS(color), "buildPaletteCSS must match the codec exactly for " + color);
    const colours = [...css.matchAll(/color:#([0-9a-f]{6})/g)].map(m => m[1]);
    ok(colours.length === P.LEVELS, "palette emits one rule per level (" + color + ")");
    ok(new Set(colours).size <= P.LEVELS, "≤ LEVELS distinct colours (" + color + ")");
    eq(colours[0], "000000", "level 0 is black (" + color + ")");
    eq("#" + colours[P.LEVELS - 1], color === "#000000" ? "#000000" : color, "top level is the base colour (" + color + ")");
  }

  // ── buildContrastLUT: ORDER is contrast -> invert -> brightness (see CLAUDE.md) ───────────────────────
  {
    const lut = new Uint8ClampedArray(256);
    // neutral contrast, no invert, no brightness -> identity
    P.buildContrastLUT(lut, 50, 50, false);
    eq(lut[0], 0, "identity lut[0]"); eq(lut[128], 128, "identity lut[128]"); eq(lut[255], 255, "identity lut[255]");
    // neutral contrast, brightness only -> additive positive shift (0 -> ~127.5)
    P.buildContrastLUT(lut, 50, 100, false);
    ok(lut[10] > 130 && lut[10] < 145, "brightness adds ~+127 to each level");
    // invert + high brightness: brightness must be applied AFTER invert. clut[v] = (255 - v) + 127.5.
    // If brightness were folded BEFORE invert, clut[0] would be 255-(0+127.5)=~128, NOT 255.
    P.buildContrastLUT(lut, 50, 100, true);
    eq(lut[0], 255, "invert-then-brightness: darkest source -> 255 (clamped up)");
    ok(lut[255] >= 126 && lut[255] <= 128, "invert-then-brightness: brightest source -> ~127");
  }

  // ── gridDims: aspect-fit maths (both branches) ───────────────────────────────────────────────────────
  {
    const a = P.gridDims(10, 800, 600, 1920, 1080); // width-bound
    eq(a.cols, 133, "gridDims cols (width-bound)");
    eq(a.rows, Math.round(133 * (1080 / 1920) * P.CHAR_ASPECT), "gridDims rows (width-bound)");
    const b = P.gridDims(10, 4000, 100, 1080, 1920); // tall video, height-bound -> rows clamped
    ok(b.rows <= Math.floor(100 / 10), "gridDims clamps to maxRows in the tall branch");
    ok(b.cols >= 1 && b.rows >= 1, "gridDims never returns 0");
  }
  eq(P.fontPxFor(6), 10, "fontPxFor default"); eq(P.fontPxFor(1), 20, "fontPxFor chunky"); eq(P.fontPxFor(9), 4, "fontPxFor fine");

  // ── colour cube: exactly CQ^3 = 125 fixed classes k0..k124 ───────────────────────────────────────────
  {
    const css = P.buildColorCubeCSS();
    const idx = [...css.matchAll(/\.k(\d+)\{/g)].map(m => +m[1]);
    eq(idx.length, P.CQ ** 3, "cube has CQ^3 rules");
    eq(P.CQ ** 3, 125, "CQ=5 -> 125 colours");
    eq(Math.max(...idx), 124, "highest cube index is 124");
    eq(new Set(idx).size, 125, "cube indices are unique 0..124");
  }

  // ── music colour helpers ─────────────────────────────────────────────────────────────────────────────
  eq(P.hslHex(0, 100, 50), "#ff0000", "hslHex red");
  eq(P.hslHex(120, 100, 50), "#00ff00", "hslHex green");
  eq(P.hslHex(240, 100, 50), "#0000ff", "hslHex blue");
  eq(P.mixHex("#000000", "#ffffff", 0.5), "#808080", "mixHex midpoint");
  eq(P.mixHex("#112233", "#112233", 0.7), "#112233", "mixHex identity endpoints");
  eq(P.hexHue("#ff0000"), 0, "hexHue red = 0");
  eq(P.hexHue("#808080"), 210, "hexHue gray falls back to 210");
  eq(P.clamp(5, 0, 3), 3, "clamp hi"); eq(P.clamp(-1, 0, 3), 0, "clamp lo"); eq(P.clamp(2, 0, 3), 2, "clamp mid");
  eq(P.bandAvg(new Uint8Array([255, 255, 255, 255]), 0, 4), 1, "bandAvg full = 1");
  eq(P.bandAvg(new Uint8Array([0, 0, 0, 0]), 0, 4), 0, "bandAvg zero = 0");

  // ── normalizeYouTube: every accepted form -> canonical watch URL; junk -> raw ────────────────────────
  const CANON = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
  eq(P.normalizeYouTube("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), CANON, "watch?v=");
  eq(P.normalizeYouTube("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123&index=4"), CANON, "watch?v= strips playlist");
  eq(P.normalizeYouTube("https://youtu.be/dQw4w9WgXcQ?t=42"), CANON, "youtu.be short link");
  eq(P.normalizeYouTube("https://www.youtube.com/shorts/dQw4w9WgXcQ"), CANON, "shorts/");
  eq(P.normalizeYouTube("https://www.youtube.com/embed/dQw4w9WgXcQ"), CANON, "embed/");
  eq(P.normalizeYouTube("https://www.youtube.com/live/dQw4w9WgXcQ"), CANON, "live/");
  eq(P.normalizeYouTube("not a url"), "not a url", "junk falls through to raw");
  eq(P.normalizeYouTube("https://example.com/video.mp4"), "https://example.com/video.mp4", "non-youtube url untouched");

  // ── embedSig: deterministic, and sensitive to EVERY keyed field ─────────────────────────────────────
  {
    const s = { color: "#ffffff", shading: true, detail: 6, saturation: 0, contrast: 50, brightness: 50, invert: false, fade: true, maxfps: 30 };
    const baseSig = P.embedSig("vid123", s, 200, 60);
    eq(baseSig, P.embedSig("vid123", { ...s }, 200, 60), "embedSig is deterministic for identical inputs");
    const flips = [
      ["source", () => P.embedSig("other", s, 200, 60)],
      ["cols", () => P.embedSig("vid123", s, 201, 60)],
      ["rows", () => P.embedSig("vid123", s, 200, 61)],
      ...["color", "shading", "detail", "saturation", "contrast", "brightness", "invert", "fade", "maxfps"].map(k =>
        [k, () => P.embedSig("vid123", { ...s, [k]: typeof s[k] === "boolean" ? !s[k] : typeof s[k] === "number" ? s[k] + 1 : "#000000" }, 200, 60)]),
    ];
    for (const [name, f] of flips) ok(f() !== baseSig, "embedSig changes when " + name + " changes");
  }

  console.log(`PASS: js/pure.js — ${passes} assertions (palette, contrast-LUT order, grid, 125-cube, colour helpers, normalizeYouTube, embedSig)`);
})().catch(e => { console.error(e); process.exit(1); });
