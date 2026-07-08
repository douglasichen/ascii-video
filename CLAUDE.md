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
  to before, asserted in `bench/color-check.js`); >0 mixes each channel from the
  **base-colour-tinted gray** toward the source colour by `sat/100`, then snaps to
  the cube. Base colour and saturation **combine** (not mutually exclusive): at any
  saturation the chosen colour still tints the low end, and the mix rides up toward
  the video's own colour as saturation increases (base white = neutral, i.e. the old
  gray→video behaviour). Only active with shading on.
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
- The **detail** slider is intentionally a 1–9 scale, not a raw pixel
  size. It used to be a font-px control, but smaller-px-means-more-detail
  is backwards from intuition; `fontPx = 22 - detail*2` converts the
  friendly 1–9 scale to the internal font size (1 = chunky/20px, 9 =
  fine/4px). Default 6: finer only helps up to a point, past which the cell
  count explodes span count faster than it adds usable detail.
- **`maxfps` slider (default/max 30).** Caps how often the ascii is rebuilt:
  the render loop only repaints when `now - lastRender >= 1000/maxfps -
  FRAME_JITTER`. The video keeps playing at its own rate; lowering this just
  skips rebuilds, so it's the throttle for weak hardware / huge grids (fewer
  DOM rebuilds = less GC). (Replaced the old fixed ~60fps `MIN_FRAME_MS` cap.)
- All tunable parameters (`detail`, `contrast`, `color`, `maxfps`, …) live in one
  `CONTROLS` object that drives both the generated control UI and the `state`
  object read each frame — add a new tunable parameter there rather than wiring
  up ad hoc controls. Entries are range sliders by default; `type: "color"`
  renders an `<input type=color>` **plus an editable hex field** in the row's
  value cell (type an exact `#rrggbb`; the two stay in sync), and its value is
  kept as the hex string, not coerced to a Number.
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
- **Audio: autoplay + loop + a speaker toggle (`#audio`).** Desktop autoplays
  unmuted; mobile blocks unmuted autoplay after an async resolve, so `playSrc`
  sets `video.muted = IS_MOBILE` and the round `#audio` button (pulses while
  muted) brings sound in on a tap. `syncAudio()` mirrors `video.muted` onto the
  button. (Replaced the old mobile-only "tap for sound" pill.)
- **Concurrency guard.** `computing` (with `setComputing`) disables the load
  button + url field while a video/link is resolving or loading (set on
  submit, cleared on the `playing` event or an error), and `loadFile`/
  `loadInput` bail early if it's set — so a second submit can't race the first.
- **Debug (`d` key).** Toggles the `#fps` profiler line **and** `body.show-bounds`,
  a dashed outline around `#screen` marking exactly what the embed bakes.

## Controls panel: sections + `base`

`CONTROLS` entries carry a `section` (`basic` / `advanced` / `music`); the builder
emits a full-width header row whenever the section changes. There are now two
mirrors of the values: **`state`** (live, read each frame) and **`base`** (the
user's resting values). `setControl` writes both. This exists for music mode.

## Music reactivity (`react` toggle, off by default)

Ported from `experiment/music-reactive`. A `<video> → MediaElementSource →
AnalyserNode → destination` graph (`initAudio`, lazy on first use) taps the FFT
without muting playback. `applyReactivity(now)` runs each render frame *before*
`paint()` and, on a beat (energy-based detector on the ~43–215 Hz kick band,
adaptive `mean + k·std`, 200 ms refractory), pumps an envelope that drives the
**DRIVEN** keys (`brightness`, `contrast`, `color`, `detail`) — writing them into
`state` from `base` + audio. Each target is independently tunable: `sensitivity`
(beat threshold), `punch` (brightness/contrast flash), `colorReact` (blends
`base.color` → an audio-driven hue via `mixHex`/`hslHex`), `resReact` (beat
"zoom-punch" on the resolution grid). Key non-regression property: **off by
default, and turning it off restores `state` to `base` exactly** — so main's
default behaviour and the shipped look are unchanged. It stays fast because it
only ever changes *which* single base colour `buildPalette()` ramps to (still ≤8
colours/frame) and folds brightness/contrast into the existing `CONTRAST_LUT`;
`detail` is an int and only re-grids on an actual change. Music parameter rows are
hidden (`body.music-on`) until the toggle is on. *Known limitation:* once the
graph is created, the embed bake's `captureStream()` audio can be silent while
music is on (niche combo). See `experiments/music-reactive-notes.md`.

## Baked embeds (`save` button → `.asciiv` on S3)

The **save** CTA (top-right, `#embed`) bakes the currently-playing clip into a
self-contained ascii embed. Key idea: the embed's S3 key is a **content hash**
known *before* baking — `embedHash()` = SHA-256 of the source (a file's bytes,
or the youtube id / direct url) **plus the exact render settings**. That buys two
things at once:

- **Instant snippet.** Baking records one full loop in real time (unavoidably
  slow — MediaRecorder audio is real-time), so we show the `<iframe>` snippet
  *immediately* on click and bake+upload in the **background**. `embed.html`
  treats a 404/403 as "not baked yet" → shows *"ascii video will be here soon!"*
  and re-polls, so a snippet pasted before the bake finishes lights up on its own.
- **Caching / dedup.** Same source + same look → same key. `POST /api/save`
  with `{hash}` `head_object`s it: a HIT returns `{cached:true}` and the client
  skips the whole bake+upload; a MISS presigns *that deterministic key* (no hash
  → a random key, old behaviour). This is the "cache the uploaded file by content
  hash" path — it also naturally dedups identical embeds in the bucket.

`api/save.py` validates the hash is 64 hex before trusting it as a key.
Progress shows in the modal's `#embedstat`, not by blocking the button.

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
