"use strict";
// Correctness gate for the "pause capture while the tab is hidden" bake guard (index.html bakeInBackground).
// Node, no deps, plain assert (matches embed-check.js / render-bench.js style).
//
// The bug it guards against: frame capture is driven by requestVideoFrameCallback, which STOPS firing while
// the tab is hidden. If the user switches away mid-bake, no frames are captured for that span while the wall
// clock + audio recorder run on — so the frame's real capture time jumps by the whole hidden duration, baking
// a multi-second FROZEN hold into `times`. (Observed live: a shipped clip with a 7027ms gap, median gap 48ms.)
//
// This replays the exact recording loop from index.html — the elapsed-clock end condition and the per-frame
// timestamp — under a scripted visibility timeline, for BOTH the old (no guard) and new (guard) arithmetic,
// and asserts the guard removes the gap while keeping one clean foreground loop. It models the browser loop,
// not the DOM, so it runs headless; the formulas are copied verbatim from bakeInBackground.

const assert = require("assert");
let passes = 0;
const ok = (c, m) => { assert.ok(c, m); passes++; };

const DUR_MS = 13413;   // one loop (dog.mp4)
const STEP = 10;        // virtual-clock granularity
const FRAME_MS = 50;    // ~20fps capture cadence when visible (rVFC fires)
// Scripted visibility: hidden [3000,9000) and [11000,12000) — two tab-switches during the bake.
const isHidden = (now) => (now >= 3000 && now < 9000) || (now >= 11000 && now < 12000);
// Already-hidden at t=0 (switched away during the /api/save fetch, before onVis attached) then revealed.
const startHidden = (now) => now < 7000;

// Replay the recording loop. guard=true applies the fix (pause video+recorder while hidden, freeze the
// clock); guard=false is the old behaviour. `hiddenAt` is the visibility predicate. Returns the captured
// per-frame timestamps + wall duration.
function runBake(guard, hiddenAt) {
  const t0 = 0, recStart = 0;
  let recPausedMs = 0, hiddenSince = 0, lastFrameAt = -1e9;
  const times = [];
  // Seed the already-hidden-at-start case by hand (index.html: `if (document.hidden) hiddenSince = recStart`),
  // since no visibilitychange transition fires for a bake that begins hidden.
  let now = 0, wallEnd = 0;
  let wasHidden = hiddenAt(0);
  if (guard && wasHidden) hiddenSince = 0;
  for (;;) {
    const hidden = hiddenAt(now);
    if (guard) { // onVis transitions: hide -> pause & mark; reveal -> add paused span
      if (hidden && !wasHidden) { hiddenSince = now; }
      else if (!hidden && wasHidden) { recPausedMs += now - hiddenSince; hiddenSince = 0; }
    }
    wasHidden = hidden;

    // Frame capture: rVFC only fires while visible. With the guard the video is PAUSED while hidden, so it
    // also doesn't fire — same "no frames while hidden", the difference is purely in the timestamp math.
    if (!hidden && now - lastFrameAt >= FRAME_MS) {
      lastFrameAt = now;
      times.push(guard ? (now - recStart - recPausedMs) : (now - recStart));
    }

    // Elapsed / end condition (verbatim from the setInterval): guard subtracts hidden time so the recording
    // only ends after DUR_MS of FOREGROUND playback; old code uses raw wall clock.
    const el = guard
      ? (now - t0 - recPausedMs - (hiddenSince ? now - hiddenSince : 0))
      : (now - t0);
    if (el >= DUR_MS) { wallEnd = now; break; }
    now += STEP;
  }
  return { times, wallEnd };
}

const maxGap = (t) => { let g = 0; for (let i = 1; i < t.length; i++) g = Math.max(g, t[i] - t[i - 1]); return g; };

// --- old behaviour REPRODUCES the bug: a ~6000ms frozen hold gets baked into the timestamps ---
const oldRun = runBake(false, isHidden);
ok(maxGap(oldRun.times) >= 5900, `old bake should bake a ~6s gap, got ${maxGap(oldRun.times)}ms`);
ok(oldRun.wallEnd >= DUR_MS && oldRun.wallEnd < DUR_MS + STEP, `old bake ends on wall clock at ~${DUR_MS}, got ${oldRun.wallEnd}`);

// --- the guard: no gap larger than a couple frame intervals, and it captures a full foreground loop ---
const g = runBake(true, isHidden);
ok(maxGap(g.times) <= 2 * FRAME_MS, `guarded bake must have no frozen gap, got ${maxGap(g.times)}ms`);
ok(g.times[0] >= 0, "first timestamp non-negative");
// timestamps stay monotonic non-decreasing (validHeader in the codec requires this)
let mono = true; for (let i = 1; i < g.times.length; i++) if (g.times[i] < g.times[i - 1]) mono = false;
ok(mono, "guarded timestamps are monotonic non-decreasing");
// last timestamp lands at ~DUR_MS of foreground time (frames + audio span exactly one loop, stay in lockstep)
const last = g.times[g.times.length - 1];
ok(Math.abs(last - DUR_MS) <= 2 * FRAME_MS, `last frame should sit at ~${DUR_MS}ms foreground, got ${last}`);
// captured frame count ~= one loop at the capture cadence (not inflated/deflated by the 7s hidden spans)
const expected = DUR_MS / FRAME_MS;
ok(Math.abs(g.times.length - expected) <= 3, `expected ~${expected} frames, got ${g.times.length}`);
// the recording ran LONGER in wall-clock than DUR_MS by exactly the hidden time it excluded (7000ms here)
ok(g.wallEnd - DUR_MS >= 6900 && g.wallEnd - DUR_MS <= 7100, `wall span should exceed loop by the 7s hidden, got ${g.wallEnd - DUR_MS}ms`);

// --- already-hidden at the very start (no transition): the hand-seeded hiddenSince still excludes it ---
const gs = runBake(true, startHidden);
ok(maxGap(gs.times) <= 2 * FRAME_MS, `start-hidden bake must have no frozen gap, got ${maxGap(gs.times)}ms`);
ok(gs.times[0] <= FRAME_MS, `first captured frame should sit at ~0ms foreground, got ${gs.times[0]}`);
ok(Math.abs(gs.times[gs.times.length - 1] - DUR_MS) <= 2 * FRAME_MS, `start-hidden last frame ~${DUR_MS}ms, got ${gs.times[gs.times.length - 1]}`);

console.log(`bake-hidden-check: ${passes} assertions passed`);
console.log(`  old:          maxGap=${maxGap(oldRun.times)}ms (frozen), frames=${oldRun.times.length}`);
console.log(`  new:          maxGap=${maxGap(g.times)}ms (clean), frames=${g.times.length}, lastTs=${last}ms, wallEnd=${g.wallEnd}ms`);
console.log(`  start-hidden: maxGap=${maxGap(gs.times)}ms (clean), frames=${gs.times.length}, firstTs=${gs.times[0]}ms, lastTs=${gs.times[gs.times.length - 1]}ms`);
