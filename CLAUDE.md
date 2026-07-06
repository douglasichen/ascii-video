# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A YouTube-link-to-live-ASCII-art video player, plus one older standalone
batch-conversion tool. Two separate, unrelated code paths — don't assume
they share logic:

- **`index.html` + `api/resolve.py`** (deploys to Vercel) — the live player.
  Paste a YouTube URL, it plays in the browser as animated ASCII text with
  tunable detail/contrast/brightness/invert/shading/colour/saturation, looping, with audio.
  This is the active thing being developed. Runs locally via `server.py` too.
- **`ascii_video.py`** — an older, independent CLI tool that batch-converts
  every frame of a local mp4 into a single giant self-contained HTML file
  (frames baked into a JS array, played back against an embedded base64
  audio track). Still works, not part of the live player, not under active
  development.

## Running the live player locally

```
python3 server.py
```

Serves `index.html` at `http://localhost:8420/`. Needs `yt-dlp` on PATH
(`pip install yt-dlp`) and `ffmpeg`/`ffprobe` (Homebrew). `server.py`'s
`/api/resolve` endpoint shells out to the `yt-dlp` CLI to **download the full
mp4** to `current.mp4` (gitignored), then returns `{"streamUrl":"/current.mp4?…"}`
— a same-origin file, which the canvas can `getImageData` without CORS taint.
The deployed function returns the same shape but with a direct CDN URL (see
Deployment). One `index.html` drives both; only the resolver differs.

## Running the batch converter

```
python3 ascii_video.py <input.mp4> [-o out.html] [--cols N] [--fps N]
python3 ascii_video.py --selftest
```

Pipes raw grayscale frames straight from `ffmpeg` (no Pillow dependency) to
build one big HTML file with every frame baked in as ASCII text plus a
base64-embedded audio track.

## Architecture: the live player's rendering pipeline

`index.html` is a single self-contained file (no build step, no
framework). Pipeline, in order: **video → contrast/brightness/invert filter →
luminance → quantized level → ASCII character → tinted DOM text**.

- An offscreen `<canvas id="sample">` is the *only* canvas — it exists
  solely to call `drawImage(video, ...)` and `getImageData()` to sample the
  current video frame at low resolution (`cols` × `rows`, computed in
  `computeGrid()`). It is never displayed.
- The visible output (`<pre id="screen">`) is **real DOM text, not
  canvas-rendered glyphs.** Canvas `fillText` was tried for coloring
  characters and reverted — rasterized glyphs go blurry when the page is
  zoomed, since it's a fixed-resolution bitmap rather than font rendering.
  DOM text stays crisp at any zoom.
- Per-character shading is achieved by building each row's HTML as a
  sequence of `<span style="color:#rrggbb">` runs — adjacent same-color
  characters are merged into one span. This merge is not a nicety, it is
  **the** performance mechanism: the whole render is bottlenecked by span
  count (build time, `innerHTML` parse, layout, and paint all scale with
  it), not by the per-pixel math. See the perf notes below.
- **Perf / why one base colour, not per-cell RGB.** Output luminance is
  quantized to 8 levels (`QUANT_LEVEL`/`LEVEL_CLASS`, precomputed once), so a
  whole frame contains at most 8 distinct colours → neighbouring cells
  constantly match → runs merge into long spans → few spans. (Was 16; dropped
  to 8 because it roughly halves the span count with banding still hidden by
  the char ramp — span count is the render's bottleneck.) Raw per-cell RGB *from
  the video* stays removed because independent 8-bit channels give ~16M possible
  colours, which shatters the merge (~4.3× more spans, measured in
  `bench/color-bench.js`) and tanks FPS. But a single user-chosen **base colour**
  is free: `buildPalette()` ramps the 8 level classes from black → that colour
  (white = the classic gray ramp), so it's still ≤ 8 colours/frame and merging is
  untouched. It rebuilds that one `<style>` on change and sets `#screen.style.color`
  for turbo's flat text.
- **`saturation` slider (per-cell video colour, default 0 = off).** The old
  per-cell-from-video path was removed for the span-explosion above, but it comes
  back *affordably* by quantizing hard: each channel is snapped to `CQ`=5 levels,
  so the whole palette is a fixed `CQ³`=125-colour cube. Adjacent cells keep
  landing in the same bucket → runs still merge → only **~1.34× the gray span
  count** (measured node-side AND confirmed in a real browser: the `innerHTML`+
  layout DOM phase was 1.33× gray, matching the proxy). Each cube colour is one
  static CSS class (`.k123{color:#rrggbb}`, built once in a `<style>`), so a cell
  emits `<i class=k123>` — same short class-based markup as the gray levels, not
  inline styles. `saturation`=0 uses the untouched 8-level gray path (byte-identical
  to before, asserted in `bench/color-check.js`); >0 mixes each channel toward the
  source colour by `sat/100` then snaps to the cube, and overrides the base-colour
  tint (you're showing the video's own colour). Only active with shading on.
- **Build assembly: one cons-string, not an array + join.** `paint()` grows the
  whole frame's markup with `out += …` rather than pushing per-cell parts into an
  array and `join()`-ing. V8 builds it as a rope and flattens once at assignment,
  which skips both the per-cell `push` and the join — ~68% less build time and
  ~4× lower worst-frame (the old array path GC-spiked to 7–10 ms; this holds ~2 ms)
  on byte-identical output. Measured by `bench/render-bench.js` (a headless node
  harness that replays the exact build loop on synthetic frames and asserts the
  HTML is unchanged). Other hot-loop specifics: the
  offscreen canvas uses `willReadFrequently:true` (CPU-backed, avoids
  GPU-readback stalls on `getImageData`); a per-frame 256-entry contrast LUT
  replaces per-pixel `adjustContrast` calls; colors are compared as the
  quantized int key, never as freshly-built strings. The `#fps` readout is a
  live profiler (avg draw/build/dom split + worst-frame peak) gated behind
  `DEBUG` (a JS var, off by default; press `d` outside the link box to toggle) —
  when off it's hidden, the `[WORST]` logs are silenced, and the per-frame
  forced-layout measurement is skipped. It's how you attribute any FPS drop to a phase.
- **`shading` checkbox (in `CONTROLS`, default on).** When **off**, each row
  renders as plain single-colour text via `screen.textContent` instead of the
  per-cell `<i class>` tinted spans. Measured ~20× cheaper on the dom phase (no
  HTML parse, no per-cell element create/destroy) — the span machinery, not the
  text volume, is the whole cost. The trade is losing the luminance tint
  (brightness then rides on the char ramp only). Default stays shaded (the
  signature look); turning shading off is the fast escape hatch for big grids /
  weak hardware where the shaded path can't hold the video's framerate. (This
  was originally a `turbo` slider — same mechanism, renamed for clarity: "shading
  off" *is* turbo.)
- **`brightness` / `contrast` sliders and the `invert` checkbox** all fold into
  the one per-frame 256-entry `CONTRAST_LUT` in `paint()`. Because the LUT is
  applied before quantization, they're free per pixel — no per-cell cost, they
  just shift which gray level / char each cell lands on. `Uint8ClampedArray`
  clamps for free. **Order matters:** contrast (scale around 128) → invert
  (`255 - value`) → brightness (additive), so brightness is applied *after* the
  invert and still brightens the displayed image whether or not invert is on
  (fold it in before the invert and the slider reverses).
- **Known footgun:** `#screen` must NOT have `display:flex`. It was
  centered with flex+align-items+justify-content early on, which broke
  multi-line rendering — each per-color `<span>` becomes its own flex item,
  and the flex layout algorithm ignores the plain-text newline characters
  between rows, collapsing the whole grid onto one visual line. Centering
  is done instead via `position:fixed; top:50%; left:50%;
  transform:translate(-50%,-50%)`, which doesn't touch the `<pre>`'s normal
  inline formatting context.
- The **detail** slider is intentionally a 1–8 scale, not a raw pixel
  size. It used to be a font-px control, but smaller-px-means-more-detail
  is backwards from intuition; `fontPx = 22 - detail*2` converts the
  friendly 1–8 scale to the internal font size (1 = chunky/20px, 8 =
  fine/6px). Capped at 8 (default 6) on purpose: finer than that the cell
  count explodes span count faster than it adds usable detail.
- All tunable parameters (`detail`, `contrast`, `turbo`, `color`) live in one
  `CONTROLS` object that drives both the generated control UI and the `state`
  object read each frame — add a new tunable parameter there rather than wiring
  up ad hoc controls. Entries are range sliders by default; `type: "color"`
  renders an `<input type=color>` instead (and its `input` value is kept as the
  hex string, not coerced to a Number).
- The frame render lives in `paint()` (draw→build→dom), split out of the rVFC
  loop so it can be called on demand. `setControl()` calls `paint()` after every
  control change so adjustments preview immediately **even while paused** — the
  loop is gated on `!video.paused`, so without this a paused `detail` change only
  swapped the font size on stale text and scaled it (looked like a zoom). See
  `docs/optimization-notes.md`.
- Autoplay-with-sound only works because `video.play()` is called
  synchronously inside the Load button's click handler (a user gesture);
  moving it into an async continuation after a `fetch()` await can break
  autoplay in some browsers.

## Deployment (Vercel)

Implements `docs/superpowers/specs/2026-07-05-vercel-migration-design.md`.
Structure: `index.html` (static, served at `/`), `api/resolve.py` (Python
serverless function at `/api/resolve`), `requirements.txt` (`yt-dlp`),
`.vercelignore` (keeps `server.py`/`ascii_video.py`/artifacts out of the
deploy). Zero-config — no `vercel.json`. Deploy with `vercel` / `vercel --prod`
(needs `vercel login` first).

Input sources (`loadInput()` dispatches by type): a **video file** (drag-drop
or ↑ upload) plays as a same-origin blob URL — the reliable path on any host,
since a blob never has CORS/IP/bot problems; a **direct video URL** is used
as-is (needs CORS on that host for `getImageData`); a **YouTube link** goes
through `/api/resolve`. YouTube is now **best-effort** — from a cloud IP it
usually bot-blocks (see below), so file/direct-URL are what make the live link
dependable.

`api/resolve.py` calls yt-dlp's `extract_info(url, download=False)` to get a
direct progressive-mp4 CDN URL and returns `{"streamUrl","title"}` — no
download, no re-hosting. **Known risk (accepted in the spec):** those
`googlevideo.com` URLs can be IP/session-locked (resolved from Vercel's IP,
played from the user's) and may not send CORS headers, which can break both
playback and the canvas `getImageData` the renderer needs (`<video>` has
`crossorigin="anonymous"` so it *can* sample when CORS is present). The
documented escape hatch if this proves unreliable is proxying/downloading
through the function. Still out of scope: embed/snippet generator, auth, rate
limiting.
