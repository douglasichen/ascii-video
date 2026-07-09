import { test } from "vitest";
import assert from "node:assert";
// Correctness gate for baked-embed CREATION + PLAYBACK (ported from bench/embed-check.js + tests/test_codec.js).
// Loads the REAL codec (src/codec.ts) and hammers:
//   1. Codec round-trip across many randomized configs — frames byte-identical, header fields survive,
//      audio round-trips, validHeader/decode fail closed on corrupted or truncated input.
//   2. Capture-size invariant — the computeGrid `if (recording) return` guard.
//   3. Playback phase mapping — the embed.html clipDur fix.
//   4. Timestamp-driven frame mapping — the A/V-sync fix (frameAt).
import { RAMP, encodeAsciiv, decodeAsciiv, validHeader, frameAt, buildRows } from "../src/codec";

const RAMP_LAST = RAMP.length - 1;

// deterministic PRNG so any failure reproduces exactly
function mulberry32(seed: number) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hex2 = (n: number) => n.toString(16).padStart(2, "0");

// ---------------------------------------------------------------------------
// 1. CODEC ROUND-TRIP — many randomized configs
// ---------------------------------------------------------------------------
test("codec round-trip byte-identical across randomized configs", async () => {
  const rnd = mulberry32(0xA5C11);
  const pick = <T>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)];
  const dimChoices = [1, 2, 3, 7, 16, 40, 80, 120, 160, 200];
  let configs = 0;

  for (let n = 0; n < 60; n++) {
    const cols = pick(dimChoices), rows = pick(dimChoices);
    const frameCount = 1 + Math.floor(rnd() * 300);
    const fps = 1 + Math.floor(rnd() * 240);
    const fade = rnd() < 0.5;
    const shading = rnd() < 0.5;
    const durationMs = Math.round((frameCount / fps) * 1000);
    const colour = "#" + hex2((rnd() * 256) | 0) + hex2((rnd() * 256) | 0) + hex2((rnd() * 256) | 0);
    const N = cols * rows;

    const frames: Uint8Array[] = [];
    const g = new Uint8Array(N);
    for (let i = 0; i < N; i++) g[i] = (rnd() * (RAMP_LAST + 1)) | 0;
    frames.push(g.slice());
    for (let k = 1; k < frameCount; k++) {
      const changes = Math.min(N, 1 + Math.floor(rnd() * Math.max(1, N / 4)));
      for (let c = 0; c < changes; c++) g[(rnd() * N) | 0] = (rnd() * (RAMP_LAST + 1)) | 0;
      frames.push(g.slice());
    }

    let audio: Uint8Array | null = null;
    if (rnd() < 0.66) {
      const alen = Math.floor(rnd() * 5000);
      audio = new Uint8Array(alen);
      for (let i = 0; i < alen; i++) audio[i] = (rnd() * 256) | 0;
    }
    const audioMime = audio ? pick(["audio/webm", "audio/mp4", "audio/webm;codecs=opus", ""]) : "";

    const header = { fps, cols, rows, colour, shading, fade, durationMs, audioMime };
    const bytes = await encodeAsciiv(header, frames, audio);
    const dec = await decodeAsciiv(bytes);

    assert.strictEqual(dec.header.frameCount, frameCount, `frameCount survives (cfg ${n})`);
    assert.strictEqual(dec.header.cols, cols, `cols survives (cfg ${n})`);
    assert.strictEqual(dec.header.rows, rows, `rows survives (cfg ${n})`);
    assert.strictEqual(dec.header.fps, fps, `fps survives (cfg ${n})`);
    assert.strictEqual(dec.header.durationMs, durationMs, `durationMs survives (cfg ${n})`);
    assert.strictEqual(dec.header.fade, fade, `fade survives (cfg ${n})`);
    assert.strictEqual(dec.header.colour, colour, `colour survives (cfg ${n})`);
    assert.strictEqual(dec.header.shading, shading, `shading survives (cfg ${n})`);

    assert.strictEqual(dec.frames.length, frameCount, `frame count matches (cfg ${n})`);
    for (let k = 0; k < frameCount; k++) {
      assert.deepStrictEqual(Array.from(dec.frames[k]), Array.from(frames[k]), `frame ${k} byte-identical (cfg ${n})`);
    }

    if (audio) assert.deepStrictEqual(Array.from(dec.audio!), Array.from(audio), `audio round-trips (cfg ${n})`);
    else assert.strictEqual(dec.audio, null, `no audio -> null (cfg ${n})`);
    configs++;
  }
  console.log(`PASS: codec round-trip byte-identical across ${configs} randomized configs`);
});

// ---------------------------------------------------------------------------
// 1b. validHeader / decode FAIL CLOSED on corrupted or truncated input
// ---------------------------------------------------------------------------
test("validHeader + decode fail closed on corrupted/truncated input", async () => {
  const good = { fps: 30, cols: 40, rows: 20, colour: "#aabbcc", shading: true, fade: false, durationMs: 1000, audioMime: "" };
  const frames = [new Uint8Array(40 * 20)];
  const bytes = await encodeAsciiv(good, frames, null);

  await decodeAsciiv(bytes); // sanity: the good one decodes

  const bads = [
    { ...good, colour: "red" },
    { ...good, colour: "#fff" },
    { ...good, colour: "#fff}</style><script>x" }, // css/html-injection colour (from test_codec.js)
    { ...good, cols: 0 },
    { ...good, rows: 5000 },
    { ...good, cols: 2000, rows: 2000 },
    { ...good, fps: 0 },
    { ...good, fps: 999 },
    { ...good, cols: 4.5 }, // non-integer dim (from test_codec.js)
    { ...good, audioMime: "audio/wav" },
    { ...good, audioMime: "text/plain" },
  ];
  const t3 = { ...good, frameCount: 3 };
  assert.ok(validHeader({ ...t3, times: [0, 10, 20] }) === true, "validHeader accepts monotonic times of length==frameCount");
  assert.ok(validHeader({ ...t3, times: [0, 0, 20] }) === true, "validHeader accepts non-strict (equal) monotonic times");
  const badTimes = [
    { ...t3, times: [0, 10] },
    { ...t3, times: [0, 10, 20, 30] },
    { ...t3, times: [0, 20, 10] },
    { ...t3, times: [0, -5, 10] },
    { ...t3, times: [0, NaN, 20] },
    { ...t3, times: "0,10,20" },
    { ...t3, times: {} },
  ];
  for (const b of badTimes) assert.ok(validHeader(b) === false, `validHeader rejects bad times ${JSON.stringify(b.times).slice(0, 22)}`);

  for (const b of bads) assert.ok(validHeader({ ...b, frameCount: 1 }) === false, `validHeader rejects ${JSON.stringify(b).slice(0, 44)}`);
  assert.ok(validHeader({ ...good, frameCount: 0 }) === false, "validHeader rejects frameCount < 1");
  assert.ok(validHeader({ ...good, frameCount: 1 }) === true, "validHeader accepts a good header");
  assert.ok(validHeader(null) === false, "validHeader rejects null");
  assert.ok(validHeader("nope") === false, "validHeader rejects non-object");

  // buildRows clamps out-of-range char-indices instead of emitting undefined/garbage class names (test_codec.js)
  const badGrid = Uint8Array.from([0, 200, 255, 5]);
  const clamped = buildRows(badGrid, 4, 1, true);
  assert.ok(!clamped.includes("undefined"), "no undefined from out-of-range indices");
  assert.ok(!/class=[a-z]?>/.test(clamped.replace(/class=[a-h]>/g, "")), "only valid a..h level classes emitted");

  const badMagic = bytes.slice(); badMagic[0] = 0x00;
  await assert.rejects(() => decodeAsciiv(badMagic), /not an .asciiv/);

  const badHeader = bytes.slice(); badHeader[10] = 0x22; // '"' mid-JSON -> invalid
  await assert.rejects(() => decodeAsciiv(badHeader));

  const truncated = bytes.slice(0, bytes.length - 5);
  await assert.rejects(() => decodeAsciiv(truncated));

  // gzip bomb: a VALID header (small dims/frameCount) but a frame blob that decompresses to far more than the
  // header could ever legitimately hold. The header caps are supposed to keep a tiny file from OOMing the
  // viewer, but decode fully materializes the decompressed stream first — so this must fail closed, not swell.
  {
    const gz = async (u8: Uint8Array) =>
      new Uint8Array(await new Response(new Response(u8).body!.pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
    // rebuild the good file with tiny dims (N=4, frameCount=1 -> max legit frame stream = 4 bytes)
    const tiny = { fps: 30, cols: 2, rows: 2, colour: "#ffffff", shading: true, fade: false, durationMs: 100, audioMime: "" };
    const base = await encodeAsciiv(tiny, [new Uint8Array([1, 2, 3, 4])], null);
    const bdv = new DataView(base.buffer, base.byteOffset, base.byteLength);
    const bh = bdv.getUint32(4, true), ba = bdv.getUint32(8 + bh, true);
    const prefix = base.subarray(0, 12 + bh + ba);
    const bomb = await gz(new Uint8Array(200000)); // ~200 bytes -> 200000 bytes, vs a 4-byte header budget
    const malicious = new Uint8Array(prefix.length + bomb.length);
    malicious.set(prefix, 0); malicious.set(bomb, prefix.length);
    await assert.rejects(() => decodeAsciiv(malicious), /frame stream too large/, "oversized decompressed frame stream is rejected, not materialized");
  }

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
  await assert.rejects(() => decodeAsciiv(out), /invalid .asciiv header/);

  console.log("PASS: validHeader + decode fail closed on corrupted/truncated input");
});

// ---------------------------------------------------------------------------
// 2. CAPTURE-SIZE INVARIANT — the computeGrid `if (recording) return` guard
// ---------------------------------------------------------------------------
test("capture guard keeps every frame == cols*rows; a mixed-size capture provably corrupts decode", async () => {
  const sizes: [number, number][] = [[40, 20], [40, 20], [40, 20], [60, 30], [60, 30]];
  function capture(guardOn: boolean) {
    let [cols, rows] = sizes[0];
    const rec: Uint8Array[] = [];
    for (let f = 0; f < sizes.length; f++) {
      if (!guardOn) { [cols, rows] = sizes[f]; }
      const g = new Uint8Array(cols * rows);
      for (let i = 0; i < g.length; i++) g[i] = (i + f) % (RAMP_LAST + 1);
      rec.push(g);
    }
    return { rec, cols, rows };
  }

  const on = capture(true);
  const N = on.cols * on.rows;
  for (let f = 0; f < on.rec.length; f++) assert.strictEqual(on.rec[f].length, N, `guard on: frame ${f} == cols*rows`);
  const hdr = { fps: 30, cols: on.cols, rows: on.rows, colour: "#ffffff", shading: true, fade: false, durationMs: 200, audioMime: "" };
  const dec = await decodeAsciiv(await encodeAsciiv(hdr, on.rec, null));
  for (let f = 0; f < on.rec.length; f++) assert.deepStrictEqual(Array.from(dec.frames[f]), Array.from(on.rec[f]), `guard on: frame ${f} decodes faithfully`);
  console.log("PASS: capture guard keeps every frame == cols*rows; decode is faithful");

  const off = capture(false);
  assert.ok(new Set(off.rec.map((g) => g.length)).size > 1, "guard off: frames genuinely have mixed sizes (the bug precondition)");
  for (let f = 0; f < off.rec.length; f++) for (let i = 0; i < off.rec[f].length; i++) off.rec[f][i] = (i * 7 + f * 3 + off.rec[f].length) % (RAMP_LAST + 1);
  const Nfinal = off.cols * off.rows;
  assert.ok(off.rec[0].length < Nfinal, "guard off: early frames are SMALLER than the header's cols*rows");
  const hdrBad = { fps: 30, cols: off.cols, rows: off.rows, colour: "#ffffff", shading: true, fade: false, durationMs: 200, audioMime: "" };
  let corrupted = false;
  try {
    const decBad = await decodeAsciiv(await encodeAsciiv(hdrBad, off.rec, null));
    corrupted = Array.from(decBad.frames[3]).join() !== Array.from(off.rec[3]).join();
  } catch { corrupted = true; }
  assert.ok(corrupted, "guard off: mixed-size capture corrupts decode (proves the guard is load-bearing)");
  console.log("PASS: without the guard, a mixed-size capture provably corrupts decode");
});

// ---------------------------------------------------------------------------
// 3. PLAYBACK PHASE MAPPING — embed.html loop() index math
// ---------------------------------------------------------------------------
test("clipDur mapping sweeps [0,n) once and wraps in lockstep; old floor(t*fps) wrapped early", () => {
  const wrap = (i: number, n: number) => ((i % n) + n) % n;
  const newIndex = (t: number, clipDur: number, n: number) => wrap(Math.floor((t % clipDur) / clipDur * n), n);
  const oldIndex = (t: number, fps: number, n: number) => wrap(Math.floor(t * fps), n);
  const computeClipDur = (durationMs: number | undefined, nframes: number, fps: number) => ((durationMs ?? 0) > 0 ? (durationMs as number) / 1000 : 0) || (nframes / fps) || 10;
  const usesManualAudioLoop = (audioDuration: number) => !(isFinite(audioDuration) && audioDuration > 0);

  const n = 143, clipDur = 5.0, fps = 29;

  const seen = new Set<number>();
  let prev = -1;
  const steps = 5000;
  for (let s = 0; s < steps; s++) {
    const t = (s / steps) * clipDur;
    const i = newIndex(t, clipDur, n);
    assert.ok(i >= 0 && i < n, "new index in range");
    assert.ok(i >= prev, "new index monotonic non-decreasing within a loop");
    prev = i; seen.add(i);
  }
  assert.strictEqual(newIndex(0, clipDur, n), 0, "new: loop starts at frame 0");
  assert.strictEqual(newIndex(clipDur - 1e-6, clipDur, n), n - 1, "new: just before clipDur reaches the last frame");
  assert.strictEqual(seen.size, n, "new: every one of the n frames is hit exactly once across the loop");

  assert.strictEqual(newIndex(clipDur, clipDur, n), 0, "new: index wraps to 0 exactly at clipDur");
  assert.strictEqual(newIndex(clipDur + 1e-6, clipDur, n), 0, "new: stays wrapped just past clipDur");
  assert.strictEqual(newIndex(2 * clipDur, clipDur, n), 0, "new: wraps again at 2*clipDur (phase-locked)");

  let oldWrapT = 0;
  for (let s = 1; s < steps; s++) {
    const t = (s / steps) * clipDur;
    if (Math.floor(t * fps) >= n) { oldWrapT = t; break; }
  }
  assert.ok(oldWrapT > 0 && oldWrapT < clipDur, `old floor(t*fps) wraps early at t=${oldWrapT.toFixed(3)}s < ${clipDur}s`);
  assert.ok(oldIndex(oldWrapT, fps, n) < oldIndex(oldWrapT - 0.02, fps, n), "old: index jumps backward mid-loop (the visible glitch)");
  assert.ok(newIndex(oldWrapT, clipDur, n) < n, "new: at that same t the fix is still in-range, no early wrap");
  assert.ok(newIndex(oldWrapT, clipDur, n) >= newIndex(oldWrapT - 0.02, clipDur, n), "new: no backward jump at the old wrap point");
  console.log("PASS: new clipDur mapping sweeps [0,n) once and wraps in lockstep; old floor(t*fps) wrapped early");

  assert.strictEqual(computeClipDur(5000, 143, 29), 5.0, "clipDur: durationMs authoritative");
  assert.strictEqual(computeClipDur(0, 143, 29), 143 / 29, "clipDur: durationMs=0 falls back to frameCount/fps");
  assert.strictEqual(computeClipDur(undefined, 143, 29), 143 / 29, "clipDur: durationMs missing falls back to frameCount/fps");
  assert.strictEqual(computeClipDur(0, 0, 0), 10, "clipDur: all-bogus falls back to 10");
  console.log("PASS: clipDur fallbacks (durationMs -> frameCount/fps -> 10) hold");

  assert.ok(usesManualAudioLoop(Infinity) === true, "audio: Infinity duration -> manual clipDur loop");
  assert.ok(usesManualAudioLoop(NaN) === true, "audio: NaN duration -> manual loop");
  assert.ok(usesManualAudioLoop(0) === true, "audio: 0 duration -> manual loop");
  assert.ok(usesManualAudioLoop(4.98) === false, "audio: finite duration -> native <audio loop>");
  console.log("PASS: audio loop mode picks manual for Infinity/NaN/0, native for finite duration");
});

// ---------------------------------------------------------------------------
// 4. TIMESTAMP-DRIVEN FRAME MAPPING — the A/V-sync fix (frameAt)
// ---------------------------------------------------------------------------
test("timestamp-driven frame mapping (frameAt) — exact on uneven capture, backward-compatible", async () => {
  // (a) times survive encode/decode byte-for-byte alongside frames
  {
    const cols = 20, rows = 10, N = cols * rows, frameCount = 40;
    const frames: Uint8Array[] = [], g = new Uint8Array(N);
    frames.push(g.slice());
    for (let k = 1; k < frameCount; k++) { g[k % N] = k % (RAMP_LAST + 1); frames.push(g.slice()); }
    const rnd = mulberry32(0x71E5);
    const times: number[] = []; let acc = 0;
    for (let k = 0; k < frameCount; k++) { times.push(Math.round(acc)); acc += 20 + rnd() * 160; }
    const header = { fps: 12, cols, rows, colour: "#88ccff", shading: true, fade: false, durationMs: 4000, times, audioMime: "" };
    const dec = await decodeAsciiv(await encodeAsciiv(header, frames, null));
    assert.deepStrictEqual(dec.header.times, times, "times[] round-trips through encode/decode");
    assert.strictEqual(dec.header.times!.length, frameCount, "times length == frameCount after decode");
  }

  // (b) frameAt sweeps [0,n) once per period
  {
    const n = 50, period = 5000;
    const rnd = mulberry32(0x1234);
    const times: number[] = []; let acc = 0;
    for (let k = 0; k < n; k++) { times.push(Math.round(acc)); acc += 1 + rnd() * ((period * 0.9) / n); }
    const seen = new Set<number>(); let prev = -1;
    for (let s = 0; s < 6000; s++) {
      const t = (s / 6000) * period;
      const i = frameAt(times, period, t);
      assert.ok(i >= 0 && i < n, "frameAt in range");
      assert.ok(i >= prev, "frameAt monotonic non-decreasing within a period");
      prev = i; seen.add(i);
    }
    assert.strictEqual(frameAt(times, period, 0), 0, "frameAt: period starts at frame 0");
    assert.strictEqual(seen.size, n, "frameAt: every frame is hit across one period");
    assert.strictEqual(frameAt(times, period, period), 0, "frameAt: wraps to 0 exactly at period");
    assert.strictEqual(frameAt(times, period, period + 1e-6), 0, "frameAt: stays wrapped just past period");
    assert.strictEqual(frameAt(times, period, 2 * period + times[3]), 3, "frameAt: phase-locked across multiple periods");
    for (let k = 0; k < n; k++) assert.strictEqual(frameAt(times, period, times[k]), k, `frameAt hits frame ${k} at its own timestamp`);
    console.log("PASS: frameAt sweeps [0,n) once, is monotonic, hits every frame, and wraps in lockstep");
  }

  // (c) THE FIX vs THE BUG on a synthetic UNEVEN capture
  {
    const n = 60, period = 6000;
    const rnd = mulberry32(0xBEEF);
    const times: number[] = []; let acc = 0;
    for (let k = 0; k < n; k++) {
      times.push(acc);
      const slow = (k % 7 === 0);
      acc += slow ? 260 : 20 + rnd() * 70;
    }
    const span = times[n - 1] + 40;
    for (let k = 0; k < n; k++) times[k] = Math.round((times[k] / span) * (period * 0.98));
    const truth = (t: number) => { const p = t % period; let r = 0; for (let k = 0; k < n; k++) if (times[k] <= p) r = k; return r; };
    const evenPhase = (t: number) => { const p = t % period; return Math.min(n - 1, Math.floor(p / period * n)); };
    let fixErr = 0, oldErr = 0, fixMax = 0, oldMax = 0;
    const S = 4000;
    for (let s = 0; s < S; s++) {
      const t = (s / S) * period;
      const gt = truth(t);
      const df = Math.abs(frameAt(times, period, t) - gt);
      const dp = Math.abs(evenPhase(t) - gt);
      fixErr += df; oldErr += dp; if (df > fixMax) fixMax = df; if (dp > oldMax) oldMax = dp;
    }
    assert.strictEqual(fixErr, 0, "fix: timestamp lookup matches ground-truth frame at every sampled instant (0 error)");
    assert.strictEqual(fixMax, 0, "fix: worst-case frame error is 0");
    assert.ok(oldErr > 0, `old even-phase is wrong on uneven capture (total |err| = ${oldErr} frames over ${S} samples)`);
    assert.ok(oldMax >= 2, `old even-phase peak error is a visible ${oldMax}-frame lead/lag`);
    assert.ok(fixErr < oldErr, "fix strictly reduces the animation-vs-audio frame error vs even-phase");
    console.log(`PASS: on uneven capture the timestamp fix is exact (0 err) where even-phase drifts (${oldErr} frame-err, peak ${oldMax})`);
  }

  // (d) BACKWARD COMPAT: a v:1 file with NO times still decodes; player-side guard leaves times=null
  {
    const cols = 16, rows = 8, N = cols * rows, frameCount = 25;
    const frames: Uint8Array[] = [new Uint8Array(N)];
    for (let k = 1; k < frameCount; k++) { const g = frames[k - 1].slice(); g[k] = k % (RAMP_LAST + 1); frames.push(g); }
    const header = { fps: 10, cols, rows, colour: "#ffffff", shading: true, fade: false, durationMs: 2500, audioMime: "" };
    const bytes = await encodeAsciiv(header, frames, null);
    const dec = await decodeAsciiv(bytes);
    assert.strictEqual(dec.header.v, 1, "v:1 preserved (times added without a version bump)");
    assert.ok(dec.header.times === undefined, "old-style header has no times field");
    assert.ok(validHeader(dec.header) === true, "validHeader accepts a v:1 header without times");
    // read into a fresh binding — the assert.ok above (`asserts value`) narrowed dec.header.times to undefined
    const rawTimes = dec.header.times as number[] | undefined;
    const playerTimes = Array.isArray(rawTimes) && rawTimes.length === dec.frames.length ? rawTimes : null;
    assert.strictEqual(playerTimes, null, "player falls back to null times -> even-phase mapping");
    const n = dec.frames.length, period = dec.header.durationMs! / 1000, seen = new Set<number>();
    for (let s = 0; s < 3000; s++) seen.add(Math.floor(((s / 3000 * period) % period) / period * n));
    assert.strictEqual(seen.size, n, "v:1 fallback even-phase still hits every frame");
    console.log("PASS: v:1 (no times) decodes and cleanly falls back to even-phase mapping");
  }
});
