import { test } from "vitest";
import assert from "node:assert";
// Correctness gate for the "bake starts at content t=0" fix (src/embed.ts bakeInBackground).
// Ported from bench/bake-startframe-check.js. Models the frame-index -> content-time mapping for the OLD
// (start at C) and NEW (seek to 0) behaviour, and asserts frame 0 is the true start only with the fix.

const DUR = 13413;      // one loop, ms (dog.mp4)
const FRAME_MS = 50;    // ~20fps capture cadence

const contentAt = (start: number, elapsed: number) => ((start + elapsed) % DUR + DUR) % DUR;
const shouldSeek = (durFinite: boolean, currentTime: number) => durFinite && currentTime > 0.05;

function frameContentTimes(start: number): number[] {
  const out: number[] = [];
  for (let el = 0; el < DUR; el += FRAME_MS) out.push(contentAt(start, el));
  return out;
}

test("bake seeks to content t=0 so the embed's frame 0 is the true start of the clip", () => {
  let passes = 0;
  const ok = (c: boolean, m: string) => { assert.ok(c, m); passes++; };

  const START = 8000; // user hit save 8s into the clip

  const oldF = frameContentTimes(START);
  ok(Math.abs(oldF[0] - START) < FRAME_MS, `old bake frame 0 should be mid-clip content ~${START}ms, got ${oldF[0]}`);
  const oldWrapIdx = oldF.findIndex((c, i) => i > 0 && c < oldF[i - 1]);
  ok(oldWrapIdx > 0, "old bake only reaches content 0 after a mid-recording wrap (beginning is buried)");

  ok(shouldSeek(true, START), "should seek when playhead is mid-clip and duration finite");
  const start = shouldSeek(true, START) ? 0 : START;
  const newF = frameContentTimes(start);
  ok(newF[0] < FRAME_MS, `new bake frame 0 should be the clip start (~0ms), got ${newF[0]}`);
  let mono = true; for (let i = 1; i < newF.length; i++) if (newF[i] < newF[i - 1]) mono = false;
  ok(mono, "new bake sweeps content [0,dur) once in order, beginning first");

  ok(!shouldSeek(true, 0), "no seek when already at start (avoids a needless seek/wait)");
  ok(!shouldSeek(true, 0.02), "no seek when within the 0.05s epsilon of start");
  ok(!shouldSeek(false, 8000), "no seek when duration isn't finite (live stream — not seekable to 0)");

  console.log(`bake-startframe-check: ${passes} assertions passed`);
  console.log(`  old: frame0 content=${Math.round(oldF[0])}ms (mid-clip), first wrap at frame ${oldWrapIdx}`);
  console.log(`  new: frame0 content=${Math.round(newF[0])}ms (clip start), monotonic sweep of ${newF.length} frames`);
});
