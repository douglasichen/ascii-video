# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**asciify** (asciify.xyz) — a YouTube-link-(or dropped-mp4)-to-live-ASCII-art
video player, plus one older standalone batch-conversion tool. Two separate,
unrelated code paths — don't assume they share logic:

(Note: "ascii-video" still appears as infrastructure identifiers — the git repo
history, the S3 bucket `ascii-video-clips`, the `aws/` CDK package — those are
NOT renamed, since the bucket name is baked into every already-published embed.)

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

`index.html` + `embed.html` hold the markup + `<style>`; the JS is **TypeScript
under `src/`, bundled by Vite** (multi-page: `index.html` served at `/`,
`embed.html` at `/embed.html`). `index.html` loads exactly one entry —
`<script type="module" src="/src/main.ts">`; `embed.html` loads
`<script type="module" src="/src/embed-page.ts">`. Both import the shared codec
from `./codec` (a normal module — no more `window.ASCIIV` global). Pipeline, in
order: **video → contrast/brightness/invert filter → luminance → quantized
level → ASCII character → tinted DOM text**.

### Build / dev / test (Vite + TypeScript + Vitest)

- `npm run dev` — Vite dev server for the two static pages. **For the full
  local stack** (incl. the Python `/api/resolve` + `/api/save` functions) run
  `vercel dev`. `python3 server.py` is the older standalone yt-dlp
  same-origin-download helper (serves `index.html` too), kept for that path.
- `npm run build` — `vite build` → `dist/` (emits `dist/index.html` AND
  `dist/embed.html`, each with hashed, self-contained JS bundles; the codec is a
  shared chunk both pages import). `npm run preview` serves `dist/`.
- `npm run typecheck` — `tsc --noEmit` (strict, `moduleResolution: bundler`).
- `npm test` — `vitest run` (tests live in `tests/`, DOM-free, importing the
  REAL `src/*.ts` so a refactor regression is actually caught).
- Config: `package.json`, `tsconfig.json`, `vite.config.ts` (the multi-page
  `rollupOptions.input`). `node_modules/` + `dist/` are git/vercel-ignored.

### Module layout (`src/`)

- **`src/pure.ts`** — the DOM-free core, imported by the browser modules AND by
  the Vitest tests. Owns the byte-exact hot loop (`buildFrameHTML`), the
  quantization tables (`QUANT_LEVEL`/`LEVEL_CLASS`, the `CQ` cube),
  `buildContrastLUT` (contrast→invert→brightness order), `gridDims`/`fontPxFor`,
  `buildPaletteCSS`/`buildColorCubeCSS`, the music colour helpers (`hslHex`/
  `hexHue`/`mixHex`/`clamp`/`bandAvg`), `normalizeYouTube`, and `embedSig`.
  **No `document`/`window`** — keep it that way so it stays node-importable.
- **`src/codec.ts`** — the shared `.asciiv` codec (was the standalone
  `asciiv-codec.js`): `encodeAsciiv2`/`resampleToFps`/`buildRows2` (v:2) +
  `encodeAsciiv`/`buildRows`/`frameAt` (v:1 legacy) + `decodeAsciiv`/
  `buildPaletteCSS`/`validHeader`. Imported by `embed.ts` (encode) AND `embed-page.ts`
  (decode) so the baked and live players can never drift. Node-runnable
  (CompressionStream/Response exist in Node 18+) so the format round-trips in a
  headless test.
- **`src/state.ts`** — `CONTROLS`, `state`/`base`, `DRIVEN`, and the `rt`
  runtime object, plus the `ControlDef`/`State`/`Rt` interfaces.
  **Shared-mutable-state pattern:** ES-module imports are read-only in importers
  (you can't reassign an imported `let`), so every reassignable shared primitive
  (`cols`, `rows`, `recording`, `recFrames`, `recStart`, `computing`,
  `firstPaintPending`, `currentFile`, …) lives on `rt` and is mutated in place
  (`rt.cols = …`). `state`/`base` are typed by the `State` interface (so
  `state.detail` is a `number`, `state.color` a `string`) and mutated in place.
  A leaf module (imports nothing).
- **`src/dom.ts`** — cached, typed `getElementById` refs + `IS_MOBILE`.
- **`src/render.ts`** — the DOM glue around `pure.ts`: `computeGrid`,
  `buildPalette`, `paint()` (draw→build→dom), the rVFC `renderFrame`/
  `scheduleFrame` loop, the fps profiler, `initRenderStyles`.
- **`src/reactive.ts`** — music reactivity (`initAudio`, `applyReactivity`, the
  beat detector, `updateFade`, `rx`).
- **`src/audio.ts`** — playback audio policy (`applyAudio`/`syncAudio`, the
  speaker toggle, gesture-to-unmute; `userMuted`/`activated` are module-local).
- **`src/controls.ts`** — the control-panel builder (`buildControls`) + `setControl`.
- **`src/sources.ts`** — `loadInput`/`loadFile`/`loadYouTube`/`playSrc`, the
  loader overlay, and the `computing` concurrency guard (`setComputing`).
- **`src/embed.ts`** — the save CTA: `embedHash`/`startBake`/`bakeInBackground`/
  `showSnippet` (imports `encodeAsciiv` from `./codec`).
- **`src/main.ts`** — the only entry point in `index.html`: imports the rest,
  runs each module's init, binds the cross-cutting events (resize, load/confirm,
  drag-drop, keyboard, feedback, beforeunload), then kicks the render loop and
  the default clip. Circular imports between render/reactive/sources/controls
  are fine because no module calls an imported function at top-level
  evaluation — only inside functions run later, after main's init.
- **`src/embed-page.ts`** — the embed player, `embed.html`'s entry: fetch the
  baked `.asciiv` from S3 by `?id=`, `decodeAsciiv`, play the ascii against the
  embedded audio.
- **Strict-mode typing notes:** messy DOM/WebAudio/MediaRecorder APIs that are
  disproportionate to type precisely are narrowed with a commented `any`
  (e.g. `webkitAudioContext`, `video.captureStream()`, `navigator.audioSession`,
  the rVFC callback metadata, `window.WORST`). `pure.ts`/`codec.ts` are fully
  typed. The dynamic string-keyed writes to the precisely-typed `state`/`base`
  go through a `Record<string, unknown>` view.
- **Tests (`tests/`, Vitest, DOM-free, import the real `src/`):**
  `golden-render.test.ts` (locks `buildFrameHTML` byte-identical to the trusted
  baseline in `tests/helpers.ts` across a settings matrix — the behaviour-
  preservation lock — plus saturation sat=0 byte-match, cube validity, and the
  cube-vs-gray span run-count ratio staying ~1.3x), `pure.test.ts` (palette /
  LUT order / grid / cube / colour helpers / `normalizeYouTube` / `embedSig`),
  `embed.test.ts` (v:1 codec round-trip + `validHeader`/decode fail-closed +
  capture-size invariant + playback phase + timestamp `frameAt`),
  `asciiv2.test.ts` (the v:2 format: `resampleToFps` vs ground truth + the
  bounded-sync-error composition proof, v:2 round-trip/byte-stability, the
  fixed-fps playback mapping, v:1-still-decodes + v:2 fail-closed/bomb),
  `bake-hidden.test.ts` + `bake-startframe.test.ts` (the bake guards).
  `tests/helpers.ts` is the trusted baseline + synthetic frame generators (ported
  from the old render-bench/color-check benches). The old
  measurement-only benches (`render-bench`/`color-bench`/`variants`) were perf
  harnesses with no assertions; their one load-bearing assertion — the shipped
  build variant equals the baseline byte-for-byte — is covered by
  `golden-render.test.ts`. `tests/test_api.py` stays (Python, run separately).

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
  colours, which shatters the merge (~4.3× more spans, measured by the old
  color-bench harness) and tanks FPS. But a single user-chosen **base colour**
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
  to before, asserted in `tests/golden-render.test.ts`); >0 mixes each channel from the
  **base-colour-tinted gray** toward the source colour by `sat/100`, then snaps to
  the cube. Base colour and saturation **combine** (not mutually exclusive): at any
  saturation the chosen colour still tints the low end, and the mix rides up toward
  the video's own colour as saturation increases (base white = neutral, i.e. the old
  gray→video behaviour). Only active with shading on. Since `.asciiv` **v:2**,
  saturation IS carried into baked embeds — the bake captures each cell's displayed
  colour key (gray level or cube index) alongside its glyph, so a saved clip is
  WYSIWYG and saturation is back in `embedSig` (it changes the baked bytes). See
  "Baked embeds".
- **Build assembly: one cons-string, not an array + join.** `paint()` grows the
  whole frame's markup with `out += …` rather than pushing per-cell parts into an
  array and `join()`-ing. V8 builds it as a rope and flattens once at assignment,
  which skips both the per-cell `push` and the join — ~68% less build time and
  ~4× lower worst-frame (the old array path GC-spiked to 7–10 ms; this holds ~2 ms)
  on byte-identical output. (The ~68%/~4× perf deltas were measured by the old
  render-bench harness; the byte-identity that lock depended on is now asserted by
  `tests/golden-render.test.ts` against the trusted baseline in `tests/helpers.ts`.)
  Other hot-loop specifics: the
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
`state` from `base` + audio. Each target has its own react amount (0 = that
target doesn't react): `sensitivity` (beat threshold), `punch` (brightness
flash), `contrastReact` (contrast flash), `colorReact` (blends `base.color` → an
audio-driven hue via `mixHex`/`hslHex`), `resReact` (beat "zoom-punch" on the
resolution grid). Key non-regression property: **off by
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

- **Instant snippet.** Baking is slow (backend ffmpeg transcode, or the legacy
  real-time MediaRecorder loop), so we show the `<iframe>` snippet *immediately*
  on click and bake+upload in the **background**. `embed.html` treats a 404/403
  as "not baked yet" → shows *"ascii video will be here soon!"* and re-polls, so
  a snippet pasted before the bake finishes lights up on its own.
- **Caching / dedup.** Same source + same look → same key. `POST /api/save`
  with `{hash}` `head_object`s it: a HIT returns `{cached:true}` and the client
  skips the whole bake+upload; a MISS presigns *that deterministic key* (no hash
  → a random key, old behaviour). This is the "cache the uploaded file by content
  hash" path — it also naturally dedups identical embeds in the bucket.

`api/save.py` validates the hash is 64 hex before trusting it as a key.
Progress shows in the modal's `#embedstat`, not by blocking the button.

### Backend bake (`api/bake.ts`, ffmpeg) — the default path

The bake compute moved OFF the browser. The old real-time path
(`bakeInBackground` in `embed.ts`) recorded the on-screen `<video>` via
`captureStream()` + `MediaRecorder` — a full clip-length wait that also
**required the tab to stay foreground** (rVFC stops firing when hidden, so a
tab-switch mid-bake froze frames; there's a whole hidden-guard for it). The
default now is a **Node serverless function** (`api/bake.ts`) that ffmpegs the
clip faster-than-real-time, headless:

- **Same bytes, shared code.** The function imports the SAME
  `pure.buildFrameHTML` / `buildContrastLUT` and `codec.encodeAsciiv2` the
  browser uses — the quantization + v:2 encoder are NOT reimplemented in Python
  or duplicated. ffmpeg (`ffmpeg-static`, bundled ~78 MB linux binary, under
  Vercel's 250 MB limit) decodes to raw RGBA at exactly `cols×rows` and the
  fixed `fps` (`scale=…:flags=bilinear` — closest to canvas `drawImage`), each
  frame is fed through `buildFrameHTML` with a `rec` buffer, then
  `encodeAsciiv2`. Audio: `-c:a libopus -f webm` → `audioMime` "audio/webm".
  Given identical RGBA the packed cells are byte-identical to the live look; the
  one difference is *sampling* (ffmpeg scale/YUV→RGB vs canvas), which the
  8-level / 125-cube quantization collapses → visually identical, not
  bit-identical (the old real-time bake wasn't bit-deterministic either).
- **Same UX (instant snippet + dedup unchanged).** The **client** still owns the
  content-hash key, snippet, and `/api/save` cache check. On a MISS it fires
  `/api/bake` with the ALREADY-RESOLVED playback URL (`video.currentSrc` — the
  Apify mp4 for youtube, or the direct URL), the grid, settings, and the
  presigned upload; the function fetches the source, bakes, and uploads to that
  presigned S3 key itself (plain multipart `fetch`, no AWS SDK — it reuses the
  presign `/api/save` already minted). The embed page polls S3 and lights up.
- **Fallback keeps everything working.** `tryBackendBake` returns false — and
  the client falls back to the real-time `bakeInBackground` — for **dropped
  files** (`blob:` sources aren't fetchable server-side; backend file-upload is
  deferred phase-2), clips **over the `BACKEND_MAX_SEC`=90 s cap**, or if
  `/api/bake` is unreachable (not deployed yet). So no source regresses.
- **Feasibility / limits.** A 17.8 s clip bakes in ~1–2 s at real grids
  (faster-than-real-time). What binds first is NOT the 300 s function timeout but
  the **25 MB S3 upload cap** (`api/save.py`): v:2 delta size scales with
  motion×grid×duration, so a high-motion clip at a large grid can exceed 25 MB
  well before 90 s and the presigned POST rejects it (same ceiling the old bake
  had). `api/bake.ts` also bounds in-memory grids (`MAX_TOTAL_CELLS`) so a huge
  grid × long clip can't OOM the function. `vercel.json` gives the function
  `maxDuration:300` + `memory:1769` and `includeFiles` the ffmpeg binary (nft
  doesn't reliably trace the computed binary path). The real answer for long
  (up-to-5-min) clips is a background queue/worker — deferred; the current slice
  ships the feasible short-clip range and falls back for the rest.

### The `.asciiv` format: v:2 (fixed-fps, WYSIWYG colour) and why

Container (both versions): `"ASCV" | u32 headerLen | header JSON | u32 audioLen
| audio bytes | gzip(frame stream)`. The codec (`src/codec.ts`) is shared by the
encoder (`embed.ts`) and the embed player (`embed-page.ts`) and dispatches on
`header.v`. Audio is the MediaRecorder blob, embedded as-is.

**v:2 — what the bake writes now.** Two ideas:

- **Fixed framerate, one clock.** Capture is rVFC-driven and UNEVEN in time.
  v:1 shipped the raw per-frame capture timestamps (`times[]`) and made the
  player map the audio clock through them — which meant *three* clocks (frame
  origin `recStart`, the audio recorder's real start, and the playback period:
  `audioEl.duration` vs `durationMs` vs the times span) that all had to agree
  and never quite did. Every mismatch was a sync bug (the freeze, the missing
  beginning, frames-ahead-of-audio). v:2 kills the mapping instead of patching
  it: at bake time `resampleToFps` snaps the capture onto a **uniform fps grid
  aligned to the audio recorder's own t=0** (`recStart` is stamped at
  `mr.onstart`, not after `mr.start()` returns — that gap was the "frames run
  ahead" origin bug). Each grid instant takes the frame that was actually on
  screen then; grid instants before the first capture take frame 0 (the
  seek-to-0 start frame), so the foreground-only timeline can't bake in gaps.
  `durationMs` is derived as `frameCount/fps*1000`, so the header cannot
  disagree with itself. Playback is `frame = floor(phase * fps)` clamped to
  `frameCount-1`, wrapping on the audio's own duration — a constant, bounded,
  non-accumulating error (≤ one grid step + one capture gap; proven in
  `tests/asciiv2.test.ts`). No `times[]`, no binary search, no drift.
- **WYSIWYG per-cell colour.** Each cell is a packed u16: low 4 bits = ramp
  char-index (0..9), bits 4+ = the colour key the live renderer *actually
  displayed* — a gray level 0..7, or (when `header.cube`) a 125-colour cube
  index 0..124, i.e. saturation carries into the bake. `buildFrameHTML` fills
  the capture buffer with exactly these keys, and the embed player's
  `buildRows2` reproduces the live markup **byte-for-byte** (locked in
  `tests/golden-render.test.ts`). Colour stays a tiny fixed class palette
  (never raw RGB), so the span-merge perf mechanism is untouched. Frame stream:
  keyframe = `cols*rows` u16 LE, then per frame `u32 changedCount +
  changed*(u32 cellIndex, u16 cell)` — duplicated resampled frames cost 4
  bytes. `saturation` is part of `embedSig` again (it changes the bytes).

**v:1 — legacy, decode frozen.** Already-published S3 embeds are v:1 (u8
char-index cells, colour *derived* from the glyph, optional `times[]`); the
player keeps the old `frameAt`/even-phase paths for them, unchanged. The
decoder fail-closes on unknown versions, malformed fields, and oversized
decompressed streams (gzip-bomb cap covers both layouts).

## Deployment (Vercel)

Implements `docs/superpowers/specs/2026-07-05-vercel-migration-design.md`.
Structure: **Vercel auto-detects Vite** and runs `vite build` → `dist/`
(`index.html` at `/`, `embed.html` at `/embed.html`, hashed JS bundles), while
running the `api/` functions alongside: `api/*.py` as **Python** functions
(`/api/resolve`, `/api/save`, `/api/feedback`; `requirements.txt` = `yt-dlp`,
`boto3`) AND `api/bake.ts` as a **Node** function (`/api/bake`, the backend bake;
`package.json` `dependencies` = `ffmpeg-static`). `.vercelignore` keeps
`server.py`/`ascii_video.py`/`tests/`/artifacts out of the upload. `vercel.json`
carries the Vite `buildCommand`/`outputDirectory` **and** the `api/bake.ts`
function config (`maxDuration:300`, `memory:1769`, `includeFiles` for the ffmpeg
binary). Deploy with `vercel` / `vercel --prod` (needs `vercel login` first).
NOTE: `maxDuration:300` needs a Pro plan (Hobby caps at 60 s — lower it there).

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

## Contributing workflow (PRs + agent review)

Non-trivial changes land through a pull request, even when an agent is working
solo — the PR is the durable record of what changed and why. The loop:

1. **Branch + PR.** Work on a `fix/…` / `simplify/…` / `feat/…` branch and open
   a PR against `main` whose body states the problem, the fix, and how it was
   verified. Keep each PR single-purpose; when parallel agents are involved,
   partition by **non-overlapping file sets** so the PRs can never conflict.
2. **Green before review.** `npm run typecheck`, `npm test` (Vitest), and
   `npm run build` must pass; Python changes also run `python3 tests/test_api.py`.
   A bug fix adds a test that **fails before and passes after** the change.
3. **Agent review.** A separate reviewer (usually a spawned agent) checks the
   branch out in its own worktree, re-runs the suites, adversarially verifies
   the claim, and leaves a review **comment** with a verdict (LGTM /
   request-changes). GitHub blocks approving your *own* PR, so the sign-off is a
   comment-type review, not a formal Approve.
4. **Merge.** Once reviewed and green, merge to `main` (`gh pr merge --merge
   --delete-branch`). `main` is the source of truth.
5. **Deploy is separate.** Vercel is **not** wired to auto-deploy on a `main`
   push — production only updates on an explicit `vercel --prod`. Merging ≠
   shipping; deploy deliberately (security fixes especially).

Practical notes: spawned agents each run in a throwaway git worktree under
`.claude/worktrees/`; `gh auth setup-git` wires `git push` to the `gh`
credential (a bare `git push` over HTTPS otherwise fails to authenticate).
The bench suite lives in `tests/*.test.ts` (Vitest, importing the real
`src/*.ts`) — a refactor that changes `pure.buildFrameHTML` output for the same
inputs breaks `golden-render.test.ts` on purpose.
