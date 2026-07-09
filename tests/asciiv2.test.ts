import { test } from "vitest";
import assert from "node:assert";
// Correctness gate for the .asciiv v:2 format (fixed-fps + WYSIWYG colour) — the sync redesign:
//   1. resampleToFps — the bake-time uneven-capture -> uniform-fps mapping is exactly "the frame that was
//      on screen at each grid instant", and the resample+playback COMPOSITION bounds the content-time
//      error (no drift, mathematically).
//   2. v:2 encode/decode round-trip — packed u16 cells byte-identical, header (v, cube) survives, encode
//      is byte-stable, audio round-trips.
//   3. v:2 playback mapping floor(t*fps) clamped — monotonic sweep, wraps in lockstep, phase-locked over
//      many loops (the drift non-regression), clamp holds when the audio runs a hair long.
//   4. v:1 files STILL decode exactly as before (published-embed compatibility), and unknown versions /
//      malformed cube fields / v:2 gzip bombs fail closed.
import { RAMP, LEVELS, encodeAsciiv, encodeAsciiv2, decodeAsciiv, validHeader, resampleToFps, buildRows2 } from "../src/codec";

const RAMP_LAST = RAMP.length - 1;

function mulberry32(seed: number) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// a plausible packed v:2 cell: char 0..9, colour key 0..124
const randCell = (rnd: () => number) => (((rnd() * (RAMP_LAST + 1)) | 0) | (((rnd() * 125) | 0) << 4));

// ---------------------------------------------------------------------------
// 1. RESAMPLE — uneven capture -> uniform fps grid, aligned to the audio origin
// ---------------------------------------------------------------------------
test("resampleToFps picks the frame active at each grid instant; composition with playback bounds the sync error", () => {
  const rnd = mulberry32(0x2E5A);
  // synthetic uneven rVFC capture: bursts, stalls, jitter — times in ms from the audio origin
  const n = 90;
  const times: number[] = []; let acc = 12; // first frame lands a little AFTER t=0 (real captures do)
  for (let k = 0; k < n; k++) {
    times.push(Math.round(acc));
    acc += (k % 9 === 0) ? 180 : 15 + rnd() * 60; // periodic stall + jitter
  }
  const frames = Array.from({ length: n }, (_, i) => i); // frame payload = its own index
  const durMs = times[n - 1] + 30;
  const fps = Math.max(1, Math.round(n / (durMs / 1000)));
  const frameCount = Math.max(1, Math.round((durMs / 1000) * fps));
  const out = resampleToFps(frames, times, fps, frameCount);

  assert.strictEqual(out.length, frameCount, "resample emits exactly frameCount frames");
  assert.strictEqual(out[0], 0, "grid t=0 shows frame 0 (the seek-to-0 start), even when the first capture lands later");
  // ground truth: at grid instant t, the frame on screen was the LAST captured at or before t
  const truth = (t: number) => { let r = 0; for (let k = 0; k < n; k++) if (times[k] <= t) r = k; return r; };
  let prev = -1;
  for (let k = 0; k < frameCount; k++) {
    const t = (k * 1000) / fps;
    assert.strictEqual(out[k], truth(t), `grid instant ${k} shows the frame that was live then`);
    assert.ok(out[k] >= prev, "source indices are monotonic (no baked-in backward jumps)");
    prev = out[k];
  }

  // COMPOSITION (the on-paper sync proof): playback shows out[floor(t*fps)] at audio time t. The content
  // the viewer sees was captured at times[out[k]] <= t (never ahead of the audio), and no staler than one
  // grid interval + the local capture gap (never behind beyond the capture's own resolution). Constant
  // bounds -> the error CANNOT accumulate across the clip or across loops.
  const maxGap = Math.max(...times.slice(1).map((t, i) => t - times[i]), times[0]);
  for (let s = 0; s < 2000; s++) {
    const t = (s / 2000) * ((frameCount / fps) * 1000);
    const k = Math.min(frameCount - 1, Math.floor((t / 1000) * fps));
    const shownAt = times[out[k]];
    // out[k]===0 exempts the opening hold: before the first capture instant the grid shows frame 0, the
    // seek-to-0 start frame — content t~0, not "ahead" (its capture stamp merely lands a few ms in).
    assert.ok(shownAt <= t + 1e-9 || out[k] === 0, "displayed content is never AHEAD of the audio clock");
    assert.ok(t - shownAt <= 1000 / fps + maxGap, "displayed content is never stale beyond one grid step + one capture gap");
  }
  console.log(`PASS: resampleToFps exact vs ground truth (${frameCount} grid frames @${fps}fps from ${n} uneven captures); sync error bounded by ${Math.round(1000 / fps + maxGap)}ms, non-accumulating`);
});

// ---------------------------------------------------------------------------
// 2. v:2 ROUND-TRIP + BYTE STABILITY
// ---------------------------------------------------------------------------
test("v:2 encode/decode — packed cells byte-identical, header survives, encode byte-stable", async () => {
  const rnd = mulberry32(0xBEE2);
  for (const cube of [false, true]) {
    const cols = 48, rows = 18, N = cols * rows, frameCount = 60;
    const frames: Uint16Array[] = [];
    const g = new Uint16Array(N);
    for (let i = 0; i < N; i++) g[i] = randCell(rnd);
    frames.push(g.slice());
    for (let k = 1; k < frameCount; k++) {
      const changes = 1 + ((rnd() * (N / 5)) | 0);
      for (let c = 0; c < changes; c++) g[(rnd() * N) | 0] = randCell(rnd);
      frames.push(g.slice());
    }
    const audio = new Uint8Array(3000); for (let i = 0; i < audio.length; i++) audio[i] = (rnd() * 256) | 0;
    const header = { fps: 30, cols, rows, colour: "#66ffcc", shading: true, fade: true, durationMs: 2000, cube, audioMime: "audio/webm" };

    const bytes = await encodeAsciiv2(header, frames, audio);
    const again = await encodeAsciiv2(header, frames, audio);
    assert.deepStrictEqual(Array.from(bytes), Array.from(again), "encode is byte-stable (same input -> same bytes)");

    const dec = await decodeAsciiv(bytes);
    assert.strictEqual(dec.header.v, 2, "header v:2 survives");
    assert.strictEqual(dec.header.cube, cube, "cube flag survives");
    assert.strictEqual(dec.header.frameCount, frameCount, "frameCount survives");
    assert.strictEqual(dec.header.fps, 30, "fps survives");
    assert.ok(dec.frames[0] instanceof Uint16Array, "v:2 decodes to Uint16Array grids");
    for (let k = 0; k < frameCount; k++) {
      assert.deepStrictEqual(Array.from(dec.frames[k]), Array.from(frames[k]), `frame ${k} byte-identical (cube=${cube})`);
    }
    assert.deepStrictEqual(Array.from(dec.audio!), Array.from(audio), "audio round-trips");
    assert.ok(validHeader(dec.header), "decoded v:2 header revalidates");
  }
  console.log("PASS: v:2 round-trip byte-identical (gray + cube), encode byte-stable");
});

// ---------------------------------------------------------------------------
// 3. v:2 PLAYBACK MAPPING — floor(t*fps) clamped
// ---------------------------------------------------------------------------
test("v:2 playback floor(t*fps) — full monotonic sweep, lockstep wrap, phase-locked across loops, clamp holds", () => {
  const idx = (t: number, period: number, fps: number, fc: number) => {
    const phase = ((t % period) + period) % period;
    return Math.min(fc - 1, Math.floor(phase * fps));
  };
  const fps = 30, fc = 150, period = fc / fps; // 5s, exactly consistent (what the bake writes)

  const seen = new Set<number>(); let prev = -1;
  for (let s = 0; s < 6000; s++) {
    const t = (s / 6000) * period;
    const i = idx(t, period, fps, fc);
    assert.ok(i >= 0 && i < fc, "index in range");
    assert.ok(i >= prev, "monotonic within a loop");
    prev = i; seen.add(i);
  }
  assert.strictEqual(seen.size, fc, "every frame is hit exactly once per loop");
  assert.strictEqual(idx(0, period, fps, fc), 0, "loop starts at frame 0");
  assert.strictEqual(idx(period, period, fps, fc), 0, "wraps to 0 exactly at the period");
  // the drift non-regression: after ANY number of loops the same phase shows the same frame
  for (const t of [0.001, 1.234, 2.5, 4.999]) {
    for (const loops of [1, 7, 123, 100000]) {
      assert.strictEqual(idx(t + loops * period, period, fps, fc), idx(t, period, fps, fc), `phase-locked after ${loops} loops`);
    }
  }
  // audio blob a hair LONGER than frameCount/fps (MediaRecorder reality): the clamp holds the last frame
  // for the excess instead of reading out of range; wrap still lands on frame 0 — a bounded tail hold,
  // never accumulating error.
  const longPeriod = period + 0.07;
  assert.strictEqual(idx(longPeriod - 0.001, longPeriod, fps, fc), fc - 1, "tail excess holds the last frame (clamped)");
  assert.strictEqual(idx(longPeriod + 0.001, longPeriod, fps, fc), 0, "and the wrap still starts at frame 0");
  console.log("PASS: v:2 playback mapping — monotonic, lockstep wrap, phase-locked over 100k loops, clamped tail");
});

// ---------------------------------------------------------------------------
// 4. COMPATIBILITY + FAIL-CLOSED
// ---------------------------------------------------------------------------
test("v:1 files still decode byte-identically; unknown versions, bad cube, and v:2 bombs fail closed", async () => {
  // v:1 (both with and without times) decodes exactly as before — the published-embed guarantee
  const cols = 16, rows = 8, N = cols * rows, frameCount = 20;
  const v1frames: Uint8Array[] = [new Uint8Array(N)];
  for (let k = 1; k < frameCount; k++) { const g = v1frames[k - 1].slice(); g[k] = k % (RAMP_LAST + 1); v1frames.push(g); }
  for (const times of [undefined, Array.from({ length: frameCount }, (_, i) => i * 40)]) {
    const h = { fps: 10, cols, rows, colour: "#ffffff", shading: true, fade: false, durationMs: 2000, audioMime: "", ...(times ? { times } : {}) };
    const dec = await decodeAsciiv(await encodeAsciiv(h, v1frames, null));
    assert.strictEqual(dec.header.v, 1, "v:1 preserved");
    assert.ok(dec.frames[0] instanceof Uint8Array, "v:1 decodes to Uint8Array char grids (not u16)");
    for (let k = 0; k < frameCount; k++) assert.deepStrictEqual(Array.from(dec.frames[k]), Array.from(v1frames[k]), `v:1 frame ${k} intact`);
    assert.deepStrictEqual(dec.header.times, times, "v:1 times field intact");
  }

  // header validation: unknown version and malformed cube fail closed
  const good = { fps: 30, cols: 4, rows: 4, frameCount: 1, colour: "#ffffff", shading: true };
  assert.ok(validHeader({ ...good, v: 1 }), "v:1 accepted");
  assert.ok(validHeader({ ...good, v: 2, cube: true }), "v:2 + cube accepted");
  assert.ok(validHeader(good), "version-less legacy header accepted (reads as v:1)");
  assert.ok(!validHeader({ ...good, v: 3 }), "unknown future version rejected (not misread as v:1)");
  assert.ok(!validHeader({ ...good, v: "2" }), "string version rejected");
  assert.ok(!validHeader({ ...good, v: 2, cube: "yes" }), "non-boolean cube rejected");

  // buildRows2 clamps hostile cell values instead of emitting garbage classes
  const hostile = Uint16Array.from([0xffff, (300 << 4) | 3, (12 << 4) | 9, 15]);
  const gray = buildRows2(hostile, 4, 1, true, false);
  const cubed = buildRows2(hostile, 4, 1, true, true);
  assert.ok(!gray.includes("undefined") && !cubed.includes("undefined"), "no undefined classes from hostile cells");
  for (const m of cubed.matchAll(/class=k(\d+)/g)) assert.ok(+m[1] <= 124, "cube keys clamped to 0..124");
  for (const m of gray.matchAll(/class=([a-z]+)>/g)) assert.ok(m[1].length === 1 && m[1] >= "a" && m[1] <= String.fromCharCode(96 + LEVELS), "gray keys clamped to a..h");

  // v:2 gzip bomb: a tiny valid v:2 header whose frame stream decompresses far beyond the header budget
  const gz = async (u8: Uint8Array) =>
    new Uint8Array(await new Response(new Response(u8).body!.pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
  const tiny = { fps: 30, cols: 2, rows: 2, colour: "#ffffff", shading: true, fade: false, durationMs: 100, cube: false, audioMime: "" };
  const base = await encodeAsciiv2(tiny, [new Uint16Array([1, 2, 3, 4])], null);
  const bdv = new DataView(base.buffer, base.byteOffset, base.byteLength);
  const bh = bdv.getUint32(4, true), ba = bdv.getUint32(8 + bh, true);
  const prefix = base.subarray(0, 12 + bh + ba);
  const bomb = await gz(new Uint8Array(500000));
  const malicious = new Uint8Array(prefix.length + bomb.length);
  malicious.set(prefix, 0); malicious.set(bomb, prefix.length);
  await assert.rejects(() => decodeAsciiv(malicious), /frame stream too large/, "v:2 bomb rejected, not materialized");

  // truncated v:2 stream fails closed
  const truncated = base.slice(0, base.length - 3);
  await assert.rejects(() => decodeAsciiv(truncated)); // truncated v:2 rejects

  console.log("PASS: v:1 unchanged, unknown versions/bad cube/v:2 bombs/truncation all fail closed");
});
