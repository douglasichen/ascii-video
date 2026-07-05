# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A YouTube-link-to-live-ASCII-art video player, plus one older standalone
batch-conversion tool. Two separate, unrelated code paths — don't assume
they share logic:

- **`ascii-drop.html` + `server.py`** — the live player. Paste a YouTube
  URL, it plays in the browser as animated ASCII text with tunable
  detail/color/contrast, looping, with audio. This is the active thing being
  developed.
- **`ascii_video.py`** — an older, independent CLI tool that batch-converts
  every frame of a local mp4 into a single giant self-contained HTML file
  (frames baked into a JS array, played back against an embedded base64
  audio track). Still works, not part of the live player, not under active
  development.

## Running the live player locally

```
python3 server.py
```

Serves `ascii-drop.html` at `http://localhost:8420/`. Needs `yt-dlp` on
PATH (`pip install yt-dlp`) and `ffmpeg`/`ffprobe` (Homebrew).
`server.py`'s `/download` endpoint shells out to the `yt-dlp` CLI to
**download the full mp4** to `current.mp4` (gitignored) before the page
plays it — this is a local-dev-only shortcut, see Architecture below for
why the real deployment won't work this way.

## Running the batch converter

```
python3 ascii_video.py <input.mp4> [-o out.html] [--cols N] [--fps N]
python3 ascii_video.py --selftest
```

Pipes raw grayscale frames straight from `ffmpeg` (no Pillow dependency) to
build one big HTML file with every frame baked in as ASCII text plus a
base64-embedded audio track.

## Architecture: the live player's rendering pipeline

`ascii-drop.html` is a single self-contained file (no build step, no
framework). Pipeline, in order: **video → per-pixel filters (contrast,
color→gray) → luminance → ASCII character → colored DOM text**.

- An offscreen `<canvas id="sample">` is the *only* canvas — it exists
  solely to call `drawImage(video, ...)` and `getImageData()` to sample the
  current video frame at low resolution (`cols` × `rows`, computed in
  `computeGrid()`). It is never displayed.
- The visible output (`<pre id="screen">`) is **real DOM text, not
  canvas-rendered glyphs.** Canvas `fillText` was tried for coloring
  characters and reverted — rasterized glyphs go blurry when the page is
  zoomed, since it's a fixed-resolution bitmap rather than font rendering.
  DOM text stays crisp at any zoom.
- Per-character color is achieved by building each row's HTML as a
  sequence of `<span style="color:rgb(...)">` runs — adjacent same-color
  characters are merged into one span (cheap single-pass optimization,
  keeps markup size down for large flat-color regions) rather than one span
  per character.
- **Known footgun:** `#screen` must NOT have `display:flex`. It was
  centered with flex+align-items+justify-content early on, which broke
  multi-line rendering — each per-color `<span>` becomes its own flex item,
  and the flex layout algorithm ignores the plain-text newline characters
  between rows, collapsing the whole grid onto one visual line. Centering
  is done instead via `position:fixed; top:50%; left:50%;
  transform:translate(-50%,-50%)`, which doesn't touch the `<pre>`'s normal
  inline formatting context.
- The **detail** slider is intentionally a 1–10 scale, not a raw pixel
  size. It used to be a font-px control, but smaller-px-means-more-detail
  is backwards from intuition; `fontPx = 22 - detail*2` converts the
  friendly 1–10 scale to the internal font size (1 = chunky/20px, 10 =
  fine/2px).
- All tunable parameters (`detail`, `gray`, `contrast`) live in one
  `CONTROLS` object that drives both the generated slider UI and the
  `state` object read each frame — add a new tunable parameter there rather
  than wiring up ad hoc sliders.
- Autoplay-with-sound only works because `video.play()` is called
  synchronously inside the Load button's click handler (a user gesture);
  moving it into an async continuation after a `fetch()` await can break
  autoplay in some browsers.

## Where this is headed (see the design doc)

`docs/superpowers/specs/2026-07-05-vercel-migration-design.md` is an
**approved but not-yet-implemented** design for deploying this properly:
replace `server.py`'s full-mp4-download with a Vercel Python serverless
function (`api/resolve.py`) that calls yt-dlp's
`extract_info(url, download=False)` to get a direct CDN stream URL and
hands that straight to the browser — no download, no re-hosting, no local
server. Explicitly deferred/out of scope (their own future projects, not
partially-built here): an embeddable widget/snippet generator for
third-party sites, auth, rate limiting. Read that doc before starting the
Vercel migration work.
