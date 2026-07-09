import { test } from "vitest";
import assert from "node:assert";
// Correctness gate for the "pause capture while the tab is hidden" bake guard (src/embed.ts bakeInBackground).
// Ported from bench/bake-hidden-check.js. Replays the recording loop under a scripted visibility timeline for
// BOTH the old (no guard) and new (guard) arithmetic; the formulas are copied verbatim from bakeInBackground.
// Models the browser loop, not the DOM, so it runs headless.

const DUR_MS = 13413;   // one loop (dog.mp4)
const STEP = 10;        // virtual-clock granularity
const FRAME_MS = 50;    // ~20fps capture cadence when visible (rVFC fires)
const isHidden = (now: number) => (now >= 3000 && now < 9000) || (now >= 11000 && now < 12000);
const startHidden = (now: number) => now < 7000;

function runBake(guard: boolean, hiddenAt: (n: number) => boolean) {
  const t0 = 0, recStart = 0;
  let recPausedMs = 0, hiddenSince = 0, lastFrameAt = -1e9;
  const times: number[] = [];
  let now = 0, wallEnd = 0;
  let wasHidden = hiddenAt(0);
  if (guard && wasHidden) hiddenSince = 0;
  for (;;) {
    const hidden = hiddenAt(now);
    if (guard) {
      if (hidden && !wasHidden) { hiddenSince = now; }
      else if (!hidden && wasHidden) { recPausedMs += now - hiddenSince; hiddenSince = 0; }
    }
    wasHidden = hidden;

    if (!hidden && now - lastFrameAt >= FRAME_MS) {
      lastFrameAt = now;
      times.push(guard ? (now - recStart - recPausedMs) : (now - recStart));
    }

    const el = guard
      ? (now - t0 - recPausedMs - (hiddenSince ? now - hiddenSince : 0))
      : (now - t0);
    if (el >= DUR_MS) { wallEnd = now; break; }
    now += STEP;
  }
  return { times, wallEnd };
}

const maxGap = (t: number[]) => { let g = 0; for (let i = 1; i < t.length; i++) g = Math.max(g, t[i] - t[i - 1]); return g; };

test("bake-hidden guard removes the frozen tab-switch gap and keeps one clean foreground loop", () => {
  let passes = 0;
  const ok = (c: boolean, m: string) => { assert.ok(c, m); passes++; };

  const oldRun = runBake(false, isHidden);
  ok(maxGap(oldRun.times) >= 5900, `old bake should bake a ~6s gap, got ${maxGap(oldRun.times)}ms`);
  ok(oldRun.wallEnd >= DUR_MS && oldRun.wallEnd < DUR_MS + STEP, `old bake ends on wall clock at ~${DUR_MS}, got ${oldRun.wallEnd}`);

  const g = runBake(true, isHidden);
  ok(maxGap(g.times) <= 2 * FRAME_MS, `guarded bake must have no frozen gap, got ${maxGap(g.times)}ms`);
  ok(g.times[0] >= 0, "first timestamp non-negative");
  let mono = true; for (let i = 1; i < g.times.length; i++) if (g.times[i] < g.times[i - 1]) mono = false;
  ok(mono, "guarded timestamps are monotonic non-decreasing");
  const last = g.times[g.times.length - 1];
  ok(Math.abs(last - DUR_MS) <= 2 * FRAME_MS, `last frame should sit at ~${DUR_MS}ms foreground, got ${last}`);
  const expected = DUR_MS / FRAME_MS;
  ok(Math.abs(g.times.length - expected) <= 3, `expected ~${expected} frames, got ${g.times.length}`);
  ok(g.wallEnd - DUR_MS >= 6900 && g.wallEnd - DUR_MS <= 7100, `wall span should exceed loop by the 7s hidden, got ${g.wallEnd - DUR_MS}ms`);

  const gs = runBake(true, startHidden);
  ok(maxGap(gs.times) <= 2 * FRAME_MS, `start-hidden bake must have no frozen gap, got ${maxGap(gs.times)}ms`);
  ok(gs.times[0] <= FRAME_MS, `first captured frame should sit at ~0ms foreground, got ${gs.times[0]}`);
  ok(Math.abs(gs.times[gs.times.length - 1] - DUR_MS) <= 2 * FRAME_MS, `start-hidden last frame ~${DUR_MS}ms, got ${gs.times[gs.times.length - 1]}`);

  console.log(`bake-hidden-check: ${passes} assertions passed`);
  console.log(`  old:          maxGap=${maxGap(oldRun.times)}ms (frozen), frames=${oldRun.times.length}`);
  console.log(`  new:          maxGap=${maxGap(g.times)}ms (clean), frames=${g.times.length}, lastTs=${last}ms, wallEnd=${g.wallEnd}ms`);
  console.log(`  start-hidden: maxGap=${maxGap(gs.times)}ms (clean), frames=${gs.times.length}, firstTs=${gs.times[0]}ms, lastTs=${gs.times[gs.times.length - 1]}ms`);
});
