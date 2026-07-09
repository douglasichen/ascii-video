import { test } from "vitest";
import assert from "node:assert";
import { rt, state } from "../src/state.js";
import { buildFrameHTML } from "../src/pure.js";

// Correctness gate for the "on-demand preview repaint must not capture a bake frame" fix (src/controls.ts
// setControl). The renderer can't run headless (paint() touches canvas/getImageData), so — like
// bake-hidden / bake-startframe — this models the two paint() call sites using the REAL rt/state/
// buildFrameHTML and the exact capture line copied from render.ts paint().
//
// The bug: paint() appends to rt.recFrames/recTimes on EVERY call while rt.recording is true, regardless of
// caller. setControl() calls paint() for live preview on every control change. If the user closes the
// snippet card mid-bake (embed.ts embedclose drops #bakecover while the background capture loop keeps
// running) and then drags a slider, that preview repaint injects a spurious out-of-cadence frame into the
// capture — inflating the baked frame count / fps.

const COLS = 8, ROWS = 6;
const clut = new Uint8ClampedArray(256);
for (let v = 0; v < 256; v++) clut[v] = v; // identity LUT
const data = new Uint8ClampedArray(COLS * ROWS * 4).fill(128);

// The capture line, copied verbatim from render.ts paint(): a frame is recorded whenever rt.recording.
function paintOnce(): void {
  const rec = rt.recording ? new Uint8Array(rt.cols * rt.rows) : null;
  buildFrameHTML(data, rt.cols, rt.rows, state, clut, rec);
  if (rec) { rt.recFrames.push(rec); rt.recTimes.push(0); }
}

// setControl's on-demand preview repaint. `guarded` = the fix (skip while recording); false = the old bug.
function onDemandRepaint(guarded: boolean): void {
  if (rt.cols && rt.rows && !(guarded && rt.recording)) paintOnce();
}

function run(guarded: boolean): number {
  rt.cols = COLS; rt.rows = ROWS;
  rt.recFrames = []; rt.recTimes = [];
  rt.recording = true;            // a background bake is in progress
  paintOnce();                    // the render loop captures one genuine frame
  onDemandRepaint(guarded);       // user drags a slider -> setControl -> preview repaint
  onDemandRepaint(guarded);       // ...and again
  const n = rt.recFrames.length;
  rt.recording = false; rt.recFrames = []; rt.recTimes = []; rt.cols = 0; rt.rows = 0;
  return n;
}

test("on-demand control-preview repaint must not inject frames into an in-progress bake", () => {
  const buggy = run(false); // pre-fix: unconditional preview paint captures too
  assert.strictEqual(buggy, 3, `old behaviour leaks preview frames into the bake, got ${buggy}`);

  const fixed = run(true);  // post-fix: setControl skips the preview repaint while rt.recording
  assert.strictEqual(fixed, 1, `only the loop's genuine frame should be captured, got ${fixed}`);

  console.log(`setcontrol-recording: buggy captured ${buggy} frames (1 loop + 2 spurious), fixed captured ${fixed}`);
});
