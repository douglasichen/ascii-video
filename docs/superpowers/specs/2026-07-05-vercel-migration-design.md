# ASCII video player: move to a real Vercel project

## Context

The current tool is a local prototype: `ascii-drop.html` (canvas-based ASCII
renderer with resolution/color/contrast sliders) served by a stdlib
`http.server` (`server.py`), which shells out to the `yt-dlp` CLI to
**download the full mp4** to disk before serving it back to the page.

Goal: turn this into a real, git-versioned project deployed on Vercel,
without the local server or full video download. Embeddable-widget /
public-API ambitions (mentioned as a future goal) are explicitly **out of
scope** for this build — see Non-goals.

## Decisions made during brainstorming

- **Video source stays YouTube-via-yt-dlp.** Flagged the ToS/reliability
  risk of downloading YouTube content; user accepted it as a known,
  acceptable risk for personal use.
- **Resolve, don't download.** The backend calls yt-dlp's
  `extract_info(url, download=False)` to get a direct CDN stream URL and
  hands that straight to the browser's `<video>` element, instead of
  downloading the mp4 and re-serving it. Trade-off accepted: these URLs can
  be flaky (IP/session-locked, may fail to hotlink) but there's no storage
  or bandwidth cost and no re-hosting of YouTube content.
- **Hosting: Vercel.** Backend runs as a Vercel Python serverless function
  (yt-dlp is a Python package; no binary-bundling headaches).
- **No framework.** Plain static file(s) + one Vercel serverless function.
  No Next.js/React — there's exactly one page and one endpoint; a framework
  buys nothing here.
- **No embed/snippet generator, no auth, no rate limiting.** Explicitly
  descoped for this build. The "generate an embed code for any website" idea
  is a real future project but a distinct one — different risk profile
  (public multi-tenant API, abuse from strangers hammering the resolver),
  different design questions (iframe vs. div+script, expiring-URL
  re-resolution on third-party pages). Do that as its own
  brainstorm/spec/plan when it's actually being built.
- **Blur slider removed.** Was a CSS `filter: blur()` on the finished canvas
  raster — a display-time effect on the rendered glyphs, not a step in the
  video→filters→ascii pipeline. Cut for conceptual cleanliness.

## Architecture

```
repo/
  api/
    resolve.py       # Vercel Python function: GET /api/resolve?url=<youtube-url>
  public/
    index.html        # the dashboard (was ascii-drop.html)
  vercel.json          # optional: only if defaults need overriding
  requirements.txt      # yt-dlp
  README.md
```

**`api/resolve.py`** — a Vercel Python serverless function (BaseHTTPRequestHandler
per Vercel's Python runtime convention). On `GET /api/resolve?url=...`:
1. Validate `url` is present and looks like a YouTube URL.
2. Run `yt_dlp.YoutubeDL(...).extract_info(url, download=False)`.
3. Pick a progressive (video+audio combined) mp4 format from
   `info["formats"]` — same constraint as today's `-f mp4/best[ext=mp4]/best`,
   translated to picking from the `formats` list instead of shelling to the
   CLI.
4. Respond `{"streamUrl": "...", "title": "..."}` as JSON, or
   `{"error": "..."}` with a non-200 status on failure (invalid URL,
   extraction failure, no suitable format).

**`public/index.html`** — today's `ascii-drop.html`, with one change: instead
of `fetch("/download?url=...")` triggering a full download and then setting
`video.src = "/current.mp4"`, it calls `fetch("/api/resolve?url=...")` and
sets `video.src` directly to the returned `streamUrl`. Everything else
(canvas rendering loop, resolution/gray/contrast sliders with reset buttons,
loop, space-to-pause) is unchanged.

## Data flow

1. User pastes a YouTube URL into the dashboard, clicks Load.
2. Browser calls `GET /api/resolve?url=<encoded>`.
3. Function resolves the URL via yt-dlp, returns a direct stream URL.
4. Browser sets `<video src>` to that URL and calls `.play()` (still inside
   the click handler, so autoplay-with-sound isn't blocked).
5. The existing `requestAnimationFrame` loop samples video frames onto an
   offscreen canvas, applies contrast/grayscale, maps luminance to ASCII
   characters, and draws colored glyphs onto the visible canvas — unchanged
   from the current prototype.

## Error handling

- Missing/invalid `url` query param → `400` with a JSON error message shown
  in the existing `#status` element.
- yt-dlp extraction failure (private/deleted/geo-blocked video, unsupported
  URL) → `500` with yt-dlp's error message truncated, shown in `#status`.
- Stream URL fails to play in the `<video>` element (hotlink rejected, CORS,
  expired) → not distinguishable from other playback stalls; out of scope
  to specifically detect this for now. If this proves common in practice,
  falling back to full-download-and-serve is the documented escape hatch
  (see Non-goals) — not building it preemptively.

## Non-goals (explicitly deferred)

- Embed-code generator / snippet product for third-party sites.
- Public multi-tenant API, auth, API keys, rate limiting, abuse prevention.
- Fallback to download-and-serve if direct-URL hotlinking proves unreliable.
- The existing local-only tools (`ascii_video.py` batch converter,
  `server.py` local http.server) are left as-is; they are not part of this
  migration and keep working locally for offline/batch use.

## Testing

- `api/resolve.py`: one runnable check (`if __name__ == "__main__"` style
  smoke test, or a `test_resolve.py`) that calls the resolve logic against a
  known stable public video (e.g. "Me at the zoo",
  `https://www.youtube.com/watch?v=jNQXAC9IVRw`) and asserts a `streamUrl`
  comes back. Mirrors the manual verification already done for the local
  prototype's yt-dlp integration.
- Manual end-to-end check after deploy: paste the same test URL into the
  deployed dashboard, confirm it plays as ASCII with sound, confirm sliders
  and reset buttons still work.
