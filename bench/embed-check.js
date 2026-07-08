"use strict";
// Correctness gate for baked-embed CREATION + PLAYBACK. Node, no deps, plain assert (matches the style of
// render-bench.js / color-check.js). Loads the REAL codec (asciiv-codec.js is UMD-ish -> module.exports in
// node) and hammers three things:
//   1. Codec round-trip across many randomized configs — frames byte-identical, header fields survive,
//      audio round-trips, validHeader/decode fail closed on corrupted or truncated input.
//   2. Capture-size invariant — the computeGrid `if (recording) return` guard. Proves a mixed-size capture
//      corrupts decode, and that a frozen grid (the guard) keeps every frame == cols*rows.
//   3. Playback phase mapping — the embed.html clipDur fix. Proves the new mapping sweeps [0,n) once and
//      wraps in lockstep, the OLD floor(t*fps) wraps early, and the clipDur/audio-loop fallbacks hold.

const assert = require("assert");
const ASCIIV = require("../asciiv-codec.js");
const { RAMP } = ASCIIV;
const RAMP_LAST = RAMP.length - 1;

let passes = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passes++; };
const eq = (a, b, msg) => { assert.strictEqual(a, b, msg); passes++; };
const deep = (a, b, msg) => { assert.deepStrictEqual(a, b, msg); passes++; };

// deterministic PRNG so any failure reproduces exactly
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hex2 = (n) => n.toString(16).padStart(2, "0");

// ---------------------------------------------------------------------------
// 1. CODEC ROUND-TRIP — many randomized configs
// ---------------------------------------------------------------------------
async function testRoundTrip() {
  const rnd = mulberry32(0xA5C11);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  // dims incl. 1x1, tiny, and large (200x120 = 24000 cells, well under MAX_CELLS = 1e6)
  const dimChoices = [1, 2, 3, 7, 16, 40, 80, 120, 160, 200];
  let configs = 0;

  for (let n = 0; n < 60; n++) {
    const cols = pick(dimChoices), rows = pick(dimChoices);
    const frameCount = 1 + Math.floor(rnd() * 300);       // 1 .. 300
    const fps = 1 + Math.floor(rnd() * 240);              // 1 .. 240 (MAX_FPS)
    const fade = rnd() < 0.5;
    const shading = rnd() < 0.5;
    const durationMs = Math.round((frameCount / fps) * 1000);
    const colour = "#" + hex2((rnd() * 256) | 0) + hex2((rnd() * 256) | 0) + hex2((rnd() * 256) | 0);
    const N = cols * rows;

    // frames: realistic ramp char-indices (0..RAMP_LAST), low-motion so delta-coding sees changed AND
    // unchanged cells (frame0 keyframe + per-frame deltas is what the container actually stores).
    const frames = [];
    const g = new Uint8Array(N);
    for (let i = 0; i < N; i++) g[i] = (rnd() * (RAMP_LAST + 1)) | 0;
    frames.push(g.slice());
    for (let k = 1; k < frameCount; k++) {
      const changes = Math.min(N, 1 + Math.floor(rnd() * Math.max(1, N / 4)));
      for (let c = 0; c < changes; c++) g[(rnd() * N) | 0] = (rnd() * (RAMP_LAST + 1)) | 0;
      frames.push(g.slice());
    }

    // audio present ~2/3 of the time, random bytes of random length
    let audio = null;
    if (rnd() < 0.66) {
      const alen = Math.floor(rnd() * 5000);
      audio = new Uint8Array(alen);
      for (let i = 0; i < alen; i++) audio[i] = (rnd() * 256) | 0;
    }
    const audioMime = audio ? pick(["audio/webm", "audio/mp4", "audio/webm;codecs=opus", ""]) : "";

    const header = { fps, cols, rows, colour, shading, fade, durationMs, audioMime };
    const bytes = await ASCIIV.encodeAsciiv(header, frames, audio);
    const dec = await ASCIIV.decodeAsciiv(bytes);

    // header fields survive
    eq(dec.header.frameCount, frameCount, `frameCount survives (cfg ${n})`);
    eq(dec.header.cols, cols, `cols survives (cfg ${n})`);
    eq(dec.header.rows, rows, `rows survives (cfg ${n})`);
    eq(dec.header.fps, fps, `fps survives (cfg ${n})`);
    eq(dec.header.durationMs, durationMs, `durationMs survives (cfg ${n})`);
    eq(dec.header.fade, fade, `fade survives (cfg ${n})`);
    eq(dec.header.colour, colour, `colour survives (cfg ${n})`);
    eq(dec.header.shading, shading, `shading survives (cfg ${n})`);

    // frames byte-identical
    eq(dec.frames.length, frameCount, `frame count matches (cfg ${n})`);
    for (let k = 0; k < frameCount; k++) {
      deep(Array.from(dec.frames[k]), Array.from(frames[k]), `frame ${k} byte-identical (cfg ${n})`);
    }

    // audio round-trips
    if (audio) deep(Array.from(dec.audio), Array.from(audio), `audio round-trips (cfg ${n})`);
    else eq(dec.audio, null, `no audio -> null (cfg ${n})`);

    configs++;
  }
  console.log(`PASS: codec round-trip byte-identical across ${configs} randomized configs`);
}

// ---------------------------------------------------------------------------
// 1b. validHeader / decode FAIL CLOSED on corrupted or truncated input
// ---------------------------------------------------------------------------
async function testFailClosed() {
  const good = { fps: 30, cols: 40, rows: 20, colour: "#aabbcc", shading: true, fade: false, durationMs: 1000, audioMime: "" };
  const frames = [new Uint8Array(40 * 20)];
  const bytes = await ASCIIV.encodeAsciiv(good, frames, null);

  await ASCIIV.decodeAsciiv(bytes); passes++; // sanity: the good one decodes

  // validHeader unit-level rejections (frameCount added since encode injects it)
  const bads = [
    { ...good, colour: "red" },          // not #rrggbb
    { ...good, colour: "#fff" },         // short hex
    { ...good, cols: 0 },                // dim < 1
    { ...good, rows: 5000 },             // dim > MAX_DIM (4096)
    { ...good, cols: 2000, rows: 2000 }, // cols*rows > MAX_CELLS (1e6)
    { ...good, fps: 0 },                 // fps < 1
    { ...good, fps: 999 },               // fps > MAX_FPS (240)
    { ...good, audioMime: "audio/wav" }, // disallowed mime
    { ...good, audioMime: "text/plain" },
  ];
  for (const b of bads) ok(ASCIIV.validHeader({ ...b, frameCount: 1 }) === false, `validHeader rejects ${JSON.stringify(b).slice(0, 44)}`);
  ok(ASCIIV.validHeader({ ...good, frameCount: 0 }) === false, "validHeader rejects frameCount < 1");
  ok(ASCIIV.validHeader({ ...good, frameCount: 1 }) === true, "validHeader accepts a good header");
  ok(ASCIIV.validHeader(null) === false, "validHeader rejects null");
  ok(ASCIIV.validHeader("nope") === false, "validHeader rejects non-object");

  // corrupted magic
  const badMagic = bytes.slice(); badMagic[0] = 0x00;
  await assert.rejects(() => ASCIIV.decodeAsciiv(badMagic), /not an .asciiv/); passes++;

  // corrupted header bytes -> JSON.parse throws (header JSON starts at byte 8: {"v":1...; byte 10 is 'v'.
  // A stray unbalanced quote there unbalances the object structure -> parse error).
  const badHeader = bytes.slice(); badHeader[10] = 0x22; // '"' mid-JSON -> {"""... -> invalid
  await assert.rejects(() => ASCIIV.decodeAsciiv(badHeader)); passes++;

  // truncated buffer (cut into the gzip frame stream -> gunzip throws)
  const truncated = bytes.slice(0, bytes.length - 5);
  await assert.rejects(() => ASCIIV.decodeAsciiv(truncated)); passes++;

  // valid container shape but a busted colour written straight into the header JSON -> fail closed
  const dv = new DataView(bytes.buffer);
  const hlen = dv.getUint32(4, true);
  const hjson = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + hlen)));
  hjson.colour = "#zzzzzz";
  const rebuilt = new TextEncoder().encode(JSON.stringify(hjson));
  const tail = bytes.subarray(8 + hlen);
  const out = new Uint8Array(8 + rebuilt.length + tail.length);
  out.set([65, 83, 67, 86], 0);
  new DataView(out.buffer).setUint32(4, rebuilt.length, true);
  out.set(rebuilt, 8); out.set(tail, 8 + rebuilt.length);
  await assert.rejects(() => ASCIIV.decodeAsciiv(out), /invalid .asciiv header/); passes++;

  console.log("PASS: validHeader + decode fail closed on corrupted/truncated input");
}

// ---------------------------------------------------------------------------
// 2. CAPTURE-SIZE INVARIANT — the computeGrid `if (recording) return` guard
// ---------------------------------------------------------------------------
// Emulate the bake: paint() pushes new Uint8Array(cols*rows) each frame. Something (music-reactivity
// res-punch, a resize) WANTS to change cols/rows mid-capture. computeGrid() early-returns while recording,
// freezing the grid. This models both paths and proves the guard is what keeps decode honest.
async function testCaptureInvariant() {
  const sizes = [[40, 20], [40, 20], [40, 20], [60, 30], [60, 30]]; // desired dims per frame; jumps on frame 3
  function capture(guardOn) {
    let [cols, rows] = sizes[0]; // recording starts at the first grid
    const rec = [];
    for (let f = 0; f < sizes.length; f++) {
      if (!guardOn) { [cols, rows] = sizes[f]; } // computeGrid applies new dims ONLY when the guard is absent
      const g = new Uint8Array(cols * rows);
      for (let i = 0; i < g.length; i++) g[i] = (i + f) % (RAMP_LAST + 1);
      rec.push(g);
    }
    return { rec, cols, rows };
  }

  // GUARD ON: every frame is the frozen size -> header's single cols*rows matches all frames -> faithful decode.
  const on = capture(true);
  const N = on.cols * on.rows;
  for (let f = 0; f < on.rec.length; f++) eq(on.rec[f].length, N, `guard on: frame ${f} == cols*rows`);
  const hdr = { fps: 30, cols: on.cols, rows: on.rows, colour: "#ffffff", shading: true, fade: false, durationMs: 200, audioMime: "" };
  const dec = await ASCIIV.decodeAsciiv(await ASCIIV.encodeAsciiv(hdr, on.rec, null));
  for (let f = 0; f < on.rec.length; f++) deep(Array.from(dec.frames[f]), Array.from(on.rec[f]), `guard on: frame ${f} decodes faithfully`);
  console.log("PASS: capture guard keeps every frame == cols*rows; decode is faithful");

  // GUARD OFF: the grid grows mid-capture, so recFrames hold mixed sizes while the header stores the
  // FINAL (larger) cols*rows — exactly what bakeInBackground would write (it reads the globals AFTER
  // recording). Give each frame DISTINCT per-size content so truncation can't accidentally look lossless.
  const off = capture(false);
  ok(new Set(off.rec.map((g) => g.length)).size > 1, "guard off: frames genuinely have mixed sizes (the bug precondition)");
  for (let f = 0; f < off.rec.length; f++) for (let i = 0; i < off.rec[f].length; i++) off.rec[f][i] = (i * 7 + f * 3 + off.rec[f].length) % (RAMP_LAST + 1);
  const Nfinal = off.cols * off.rows; // header N = the grid AFTER the mid-bake change (60*30), > the early frames
  ok(off.rec[0].length < Nfinal, "guard off: early frames are SMALLER than the header's cols*rows");
  const hdrBad = { fps: 30, cols: off.cols, rows: off.rows, colour: "#ffffff", shading: true, fade: false, durationMs: 200, audioMime: "" };
  // An under-filled keyframe (frame0.slice(0,Nfinal) is short) makes decodeFrames pull delta bytes in as
  // pixels -> every downstream offset desyncs. Prove it: either decode throws (reads past the buffer) OR a
  // frame that WAS captured cleanly at the final size (frame 3, a real 60x30 grid) comes back wrong.
  let corrupted = false;
  try {
    const decBad = await ASCIIV.decodeAsciiv(await ASCIIV.encodeAsciiv(hdrBad, off.rec, null));
    corrupted = Array.from(decBad.frames[3]).join() !== Array.from(off.rec[3]).join();
  } catch { corrupted = true; } // reading past the desynced stream throws — also a corrupt outcome
  ok(corrupted, "guard off: mixed-size capture corrupts decode (proves the guard is load-bearing)");
  console.log("PASS: without the guard, a mixed-size capture provably corrupts decode");
}

// ---------------------------------------------------------------------------
// 3. PLAYBACK PHASE MAPPING — embed.html loop() index math
// ---------------------------------------------------------------------------
const wrap = (i, n) => ((i % n) + n) % n;                                     // draw()'s defensive re-mod
const newIndex = (t, clipDur, n) => wrap(Math.floor((t % clipDur) / clipDur * n), n); // the fix
const oldIndex = (t, fps, n) => wrap(Math.floor(t * fps), n);                // the old buggy mapping
// embed.html load(): clipDur = (durationMs>0 ? durationMs/1000 : 0) || (frames.length/fps) || 10
const computeClipDur = (durationMs, nframes, fps) => (durationMs > 0 ? durationMs / 1000 : 0) || (nframes / fps) || 10;
// loop(): manual-loop the audio only when its own duration is unusable (webm Infinity); native loop otherwise
const usesManualAudioLoop = (audioDuration) => !(isFinite(audioDuration) && audioDuration > 0);

function testPhaseMapping() {
  const n = 143, clipDur = 5.0, fps = 29; // the documented case: round(143/5) = 29

  // (a) new mapping sweeps [0, n) exactly once over one loop: monotonic, starts 0, ends n-1, hits all n
  const seen = new Set();
  let prev = -1;
  const steps = 5000;
  for (let s = 0; s < steps; s++) {
    const t = (s / steps) * clipDur;      // t in [0, clipDur)
    const i = newIndex(t, clipDur, n);
    ok(i >= 0 && i < n, "new index in range");
    ok(i >= prev, "new index monotonic non-decreasing within a loop");
    prev = i; seen.add(i);
  }
  eq(newIndex(0, clipDur, n), 0, "new: loop starts at frame 0");
  eq(newIndex(clipDur - 1e-6, clipDur, n), n - 1, "new: just before clipDur reaches the last frame");
  eq(seen.size, n, "new: every one of the n frames is hit exactly once across the loop");

  // (b) wraps in lockstep with the clock at clipDur
  eq(newIndex(clipDur, clipDur, n), 0, "new: index wraps to 0 exactly at clipDur");
  eq(newIndex(clipDur + 1e-6, clipDur, n), 0, "new: stays wrapped just past clipDur");
  eq(newIndex(2 * clipDur, clipDur, n), 0, "new: wraps again at 2*clipDur (phase-locked)");

  // (c) reproduce the OLD bug: floor(t*fps) wraps EARLY — index resets before t reaches clipDur.
  // 143 frames at fps 29: floor(t*29) hits 143 at t ≈ 4.931s, i.e. it wraps ~0.07s (2 frames) BEFORE the
  // clip actually ends -> a visible backward jump every loop. Confirm the new mapping does NOT wrap early.
  let oldWrapT = 0;
  for (let s = 1; s < steps; s++) {
    const t = (s / steps) * clipDur;
    if (Math.floor(t * fps) >= n) { oldWrapT = t; break; }
  }
  ok(oldWrapT > 0 && oldWrapT < clipDur, `old floor(t*fps) wraps early at t=${oldWrapT.toFixed(3)}s < ${clipDur}s`);
  ok(oldIndex(oldWrapT, fps, n) < oldIndex(oldWrapT - 0.02, fps, n), "old: index jumps backward mid-loop (the visible glitch)");
  ok(newIndex(oldWrapT, clipDur, n) < n, "new: at that same t the fix is still in-range, no early wrap");
  ok(newIndex(oldWrapT, clipDur, n) >= newIndex(oldWrapT - 0.02, clipDur, n), "new: no backward jump at the old wrap point");
  console.log("PASS: new clipDur mapping sweeps [0,n) once and wraps in lockstep; old floor(t*fps) wrapped early");

  // (d) clipDur fallbacks: durationMs authoritative, else frameCount/fps, else 10
  eq(computeClipDur(5000, 143, 29), 5.0, "clipDur: durationMs authoritative");
  eq(computeClipDur(0, 143, 29), 143 / 29, "clipDur: durationMs=0 falls back to frameCount/fps");
  eq(computeClipDur(undefined, 143, 29), 143 / 29, "clipDur: durationMs missing falls back to frameCount/fps");
  eq(computeClipDur(0, 0, 0), 10, "clipDur: all-bogus falls back to 10");
  console.log("PASS: clipDur fallbacks (durationMs -> frameCount/fps -> 10) hold");

  // (e) Infinity audio duration -> manual loop; finite -> native loop
  ok(usesManualAudioLoop(Infinity) === true, "audio: Infinity duration -> manual clipDur loop");
  ok(usesManualAudioLoop(NaN) === true, "audio: NaN duration -> manual loop");
  ok(usesManualAudioLoop(0) === true, "audio: 0 duration -> manual loop");
  ok(usesManualAudioLoop(4.98) === false, "audio: finite duration -> native <audio loop>");
  console.log("PASS: audio loop mode picks manual for Infinity/NaN/0, native for finite duration");
}

(async () => {
  await testRoundTrip();
  await testFailClosed();
  await testCaptureInvariant();
  testPhaseMapping();
  console.log(`\nALL GREEN — ${passes} assertions passed`);
})().catch((e) => { console.error("FAIL:", e); process.exit(1); });
