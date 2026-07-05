# Live player performance + detail-change work

Notes from optimizing `ascii-drop.html`. Everything below was measured live in
the browser (the on-page `#fps` profiler + `window.WORST`), not guessed.

## Where the time actually went

Profiled a running clip (122×119 grid, detail 8, ~30 fps source). Per-frame
phase split from the `#fps` readout:

| phase | meaning | cost |
|-------|---------|------|
| `draw` | `drawImage(video)` + `getImageData` | ~2–5 ms, occasional decode spikes |
| `build` | the pixel→char loop | ~0.4 ms (never the problem) |
| `dom` | writing the frame to `#screen` | **14 ms — the bottleneck** |

The whole render is bottlenecked by the **DOM write**, not the pixel math.
Confirmed with an in-page A/B on one real frame:

- `innerHTML` with per-cell `<i class>` gray spans: **17.2 ms**
- `textContent` plain text (same characters): **0.81 ms**
- → **~21× cheaper.** It's the per-cell element create/destroy + HTML parse
  that costs, not the text volume. Runs already merge well (≈3600 spans for
  14.5k cells), and it's *still* 17 ms — so trimming spans helps but can't get
  close to the plain-text path.

`getImageData` was ruled out as a GC culprit: in a tight loop `drawImage` was
1.08 ms and `getImageData` 0.04 ms. The random `draw` spikes (d23–d44 ms) are
**video-decode / GPU-transfer stalls** — intermittent, decoder-bound, not
fixable from JS.

Key framing: the source video is ~30 fps, so the frame budget is 33 ms.
Steady-state cost was already under that; the dropped frames came from
occasional GC/decode spikes blowing past 33 ms. "Blazingly fast" here =
**lock to the source fps with headroom**, not render faster than the video.

## Changes made

### 1. 8 gray levels instead of 16 (`LEVELS`)
Quantizing luminance to 8 levels instead of 16 roughly halves the span count
(measured live: 16→~3340 spans, 8→~2128), because adjacent cells share a level
more often so runs merge. Cuts the `dom` phase ~30% and shrinks the per-frame
allocation behind the big random GC-pause drops. **Look is unchanged** — the
banding is hidden by the character ramp (verified by screenshot A/B).

### 2. Fast path: shading off (the `shading` checkbox)
When `shading` is off, each row renders as plain single-colour text via
`textContent`, skipping the per-cell `<i>` spans entirely (~20× cheaper `dom`).
Trades the tint for maximum headroom — for large grids / weak hardware where
the shaded path can't hold the framerate. Default stays shaded (the signature
look); shading-off is the escape hatch. (Originally a `turbo` 0/1 slider; same
mechanism, renamed to a `shading` checkbox for clarity — "shading off" = turbo.)

### 3. Detail change no longer "zooms" (the real bug)
Symptom: with the video **paused**, dragging `detail` made the picture appear
to zoom in/out instead of just changing resolution.

Root cause: the render loop is gated on `!video.paused`, so while paused it
never runs. Changing detail called `computeGrid()`, which updated `cols`/`rows`
**and the font size**, but the DOM still held the *old-resolution* text — so the
same characters just got a bigger/smaller font and scaled on screen. Proof: the
rendered first-line length stayed frozen (79 chars) across detail 8/5/2 while
the font went 6→12→18 px, so the on-screen box scaled 2–3×.

Fix: the draw→build→dom body was extracted into a `paint()` function, and
`setControl()` now calls `paint()` immediately after any control change (guarded
by `video.videoWidth && rows`). So any control change re-samples the
**current** frame at the new grid right away — including while paused. Result:
the on-screen box stays a fixed size (~473 px wide here) at every detail level;
only the character resolution changes. No zoom.

### 4. `server.py` sends `Cache-Control: no-store`
This is a constantly-edited local dev tool, but the browser was caching the
page/mp4 — edits didn't show until a hard reload (this bit us mid-session). The
handler now sets `no-store` on every response so a plain reload is always fresh.

## Measured before/after (122×119, ~30 fps source)

| build | fps | drops | dom | worst frame |
|-------|-----|-------|-----|-------------|
| baseline | 25/31 | 2–3 | 14.3 ms | 61 ms |
| 8 levels (shade, default) | 30/30 | 0 | 5.8 ms | 17 ms |
| turbo | 30/30 | 0 | 1.1 ms | 8 ms |

30/30 with 0 drops is the ceiling — you can't render more frames than the video
presents. Both modes now sit there; turbo just leaves more headroom for bigger
grids / weaker machines. The only remaining worst-frame cost is decode-stall
`draw` spikes, which aren't render code.
