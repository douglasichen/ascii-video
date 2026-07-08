"use strict";
// Correctness gate for the "bake starts at content t=0" fix (index.html bakeInBackground).
// Node, no deps, plain assert (matches bake-hidden-check.js style).
//
// The bug it guards against: the bake used to record "from wherever the video is now" — it never seeked to
// the start. So if the user hit save with the playhead at content time C, the embed's frame 0 was mid-clip
// content, and content t=0 landed at the tail of the loop. A viewer entering the iframe started partway
// through -> "the beginning is missing." The fix seeks video.currentTime = 0 (and awaits `seeked`) BEFORE
// audio + frame capture start, so both begin at content 0 in lockstep.
//
// This models the mapping frame-index -> content-time for the recording loop (the video plays forward and
// loops, so content advances by foreground elapsed time, wrapping at dur), for the OLD (start at C) and NEW
// (seek to 0) behaviour, and asserts frame 0 is the true start only with the fix.

const assert = require("assert");
let passes = 0;
const ok = (c, m) => { assert.ok(c, m); passes++; };

const DUR = 13413;      // one loop, ms (dog.mp4)
const FRAME_MS = 50;    // ~20fps capture cadence

// contentAt: where in the clip [0,dur) a frame captured `elapsed` ms into the recording came from, given the
// video started the recording at content position `start`. Video loops, so it's modular.
const contentAt = (start, elapsed) => ((start + elapsed) % DUR + DUR) % DUR;

// The seek decision, copied from index.html: seek iff duration is finite AND we're not already at/near 0.
const shouldSeek = (durFinite, currentTime) => durFinite && currentTime > 0.05;

// Build the content-time of each captured frame across one loop, starting at content `start`.
function frameContentTimes(start) {
  const out = [];
  for (let el = 0; el < DUR; el += FRAME_MS) out.push(contentAt(start, el));
  return out;
}

const START = 8000; // user hit save 8s into the clip

// --- OLD behaviour (no seek): frame 0 is mid-clip, the real beginning shows up late in the loop ---
const oldF = frameContentTimes(START);
ok(Math.abs(oldF[0] - START) < FRAME_MS, `old bake frame 0 should be mid-clip content ~${START}ms, got ${oldF[0]}`);
// content 0 appears only after the video wraps, i.e. deep into the embed's frame list -> "beginning missing"
const oldWrapIdx = oldF.findIndex((c, i) => i > 0 && c < oldF[i - 1]);
ok(oldWrapIdx > 0, "old bake only reaches content 0 after a mid-recording wrap (beginning is buried)");

// --- NEW behaviour (seek to 0 first): frame 0 IS the start of the clip ---
ok(shouldSeek(true, START), "should seek when playhead is mid-clip and duration finite");
const start = shouldSeek(true, START) ? 0 : START;
const newF = frameContentTimes(start);
ok(newF[0] < FRAME_MS, `new bake frame 0 should be the clip start (~0ms), got ${newF[0]}`);
// content advances monotonically for the whole loop — no early wrap, the beginning is present and first
let mono = true; for (let i = 1; i < newF.length; i++) if (newF[i] < newF[i - 1]) mono = false;
ok(mono, "new bake sweeps content [0,dur) once in order, beginning first");

// --- seek decision edge cases ---
ok(!shouldSeek(true, 0), "no seek when already at start (avoids a needless seek/wait)");
ok(!shouldSeek(true, 0.02), "no seek when within the 0.05s epsilon of start");
ok(!shouldSeek(false, 8000), "no seek when duration isn't finite (live stream — not seekable to 0)");

console.log(`bake-startframe-check: ${passes} assertions passed`);
console.log(`  old: frame0 content=${Math.round(oldF[0])}ms (mid-clip), first wrap at frame ${oldWrapIdx}`);
console.log(`  new: frame0 content=${Math.round(newF[0])}ms (clip start), monotonic sweep of ${newF.length} frames`);
