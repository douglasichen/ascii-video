# `.asciiv` Baked Embeds — Design

Date: 2026-07-06
Status: proposed

## Goal

Let a user, after tuning the look of a playing clip, click **generate embed** to:
1. Bake the current playthrough into a compact, self-contained `.asciiv` file (ASCII frames + audio, current config frozen in).
2. Upload it to S3.
3. Get back an `<iframe>` snippet they can paste into any website, which replays the ASCII with audio.

The button **saves to S3 first**, then returns the snippet (which references the just-uploaded object). No live/streaming re-render in the embed — the artifact is fully baked.

## Non-goals

- Live-updating embed as config changes (explicitly dropped — bake is a deliberate button press).
- Re-rendering from the source mp4 in the embed (that was the rejected "recipe" approach).
- Editing/deleting stored artifacts, auth, quotas, a gallery. Out of scope.

## Decisions (locked)

- **Baked artifact**, not recipe. Config (resolution/contrast/brightness/invert/shading/colour) is frozen at bake time.
- **Per cell = one quantized ramp char-index (0–9).** The decoder derives the 8-level colour class from the char-index (both monotonic in luminance) and rebuilds the palette from the header `colour`. Small precision loss accepted for compactness.
- **Capture is real-time**: one full playthrough, hooking the existing render loop for frames + `MediaRecorder(video.captureStream())` for audio.
- **Infra via CDK (TypeScript)** in `aws/`. (Heavier than a 10-line script for one bucket; chosen for reproducible IaC.)
- **Object key**: `<timestamp>-<uuid>.asciiv` (e.g. `1751808000000-9f3c…c2.asciiv`).
- **gzip** via the browser-native `CompressionStream`/`DecompressionStream` — no library.

## The `.asciiv` format

Binary container, little-endian:

```
0   : magic "ASCV"           (4 bytes)
4   : version                (u8, = 1)
5   : headerLen              (u32)
9   : header JSON            (UTF-8, headerLen bytes)
9+H : audioLen               (u32)
    : audio bytes            (audioLen; MediaRecorder output, e.g. audio/webm;opus)
    : gzipped frame stream   (to EOF)
```

**Header JSON:**
```json
{ "fps": 30, "cols": 200, "rows": 60, "frameCount": 1800,
  "colour": "#ffffff", "shading": true, "durationMs": 60000,
  "audioMime": "audio/webm;codecs=opus" }
```

**Frame stream (pre-gzip)** — a current-grid `Uint8Array(cols*rows)` of char-indices, reconstructed by applying frames in order:
- Frame 0 = keyframe: `cols*rows` bytes (char-index 0–9 each).
- Frames 1..n-1 = delta: `u32 changedCount`, then `changedCount × (u32 cellIndex, u8 charIndex)`.

Low-motion clips → tiny deltas → gzip crushes it. `frameCount` in the header bounds the read.

## Capture + encode (client-side, in the main player)

New **generate embed** control (visible only once a video is playing).

On click:
1. Seek to 0, start `MediaRecorder` on the audio track of `video.captureStream()`.
2. Play; record one full pass (until `currentTime` reaches `duration`). The existing render loop already computes a ramp char-index per cell — during recording, push a per-frame copy of those indices (+ mediaTime).
3. On the pass completing: delta-encode the frame arrays, `CompressionStream('gzip')` the frame stream, collect the audio blob, assemble the container blob.
4. Show a bake progress readout (`baking… 00:23 / 01:00`).

The render loop is the source of truth, so baked frames are exactly what was on screen. Reuses `paint()`'s per-cell computation (small addition: record the index array when a `recording` flag is set).

**Caveats:**
- `MediaRecorder`/`captureStream` is solid in Chrome, flakier in Safari → fallback: bake a **silent** embed (frames only) and note it.
- File size scales with the grid. A fine 400×120 grid can be several MB/min after gzip. Bake at the current grid; consider a soft resolution cap / warning for very large grids.

## Save flow

1. `POST /api/save` → returns `{ putUrl, key, getUrl }`.
   - `key = <timestamp>-<uuid>.asciiv`.
   - `putUrl` = presigned S3 **PUT** (content-type `application/octet-stream`, ~5-min expiry).
   - `getUrl` = public object URL.
2. Client `PUT`s the container blob to `putUrl`.
3. On 200, client builds the snippet from `key`/`getUrl` and shows it with a copy button.

`/api/save` is a new Python Vercel function using `boto3` to mint the presigned URL, holding a scoped IAM key (from CDK) in env vars (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `ASCIIV_BUCKET`). `boto3` is added to `requirements.txt` (used only here; note the cold-start cost).

## AWS infra — `aws/` (CDK, TypeScript)

Single stack:
- **S3 bucket** (e.g. `ascii-video-clips`): CORS enabled (GET/PUT from the site origin + `*` for embeds' GET), **public-read on objects** (embeds fetch directly), **block public writes**.
- **IAM user + policy**: `s3:PutObject` on `bucket/*` only (for the presigned PUT), plus `s3:GetObject` if needed. Access key issued as a stack output.
- **Outputs**: bucket name, region, access key id/secret → the user sets these as Vercel env vars.
- Optional later: CloudFront in front of the bucket. Out of scope for v1.

## Embed player — `/embed`

`embed.html` (static, served at `/embed.html?id=<key>`), minimal, no control chrome:
1. Read `id` from `location.search`; fetch the object from S3 (public GET).
2. Decode: parse header, split audio bytes, `DecompressionStream('gzip')` the frame stream, rebuild frames into an array of char-index grids.
3. Replay frames to a `#screen` at `fps`, tinting via the palette rebuilt from `colour` — **reusing the main app's frame→DOM row/span builder** (factor that builder into a small shared core, or duplicate the ~30 lines; decided in the plan, noting index.html's "self-contained" property).
4. Audio: play the decoded audio blob in sync. Browser autoplay policy may require a click → show a small play overlay when needed (honest caveat).
5. Loop.

**Snippet:**
```html
<iframe src="https://<host>/embed.html?id=<timestamp>-<uuid>.asciiv"
        width="640" height="360" frameborder="0" allow="autoplay"></iframe>
```

## Rate limiting & abuse protection

`/api/save` is a public write door — nothing rate-limits it by default (S3 accepts unlimited PUTs and
bills you; Vercel doesn't throttle endpoints automatically). Layers, cheapest/most-effective first:

- **Vercel-native rate limit on `/api/save`** (platform feature, no external state): a **per-IP** limit
  (~10 requests/min — a human bakes occasionally) plus a **global ceiling (~100 req/s)** as the coarse
  backstop the user asked for. Preferred because it needs no Redis and no custom limiter. If the plan
  doesn't expose it, fall back to a lightweight Upstash Redis limiter — but don't build that unless the
  native path is unavailable.
- **Presigned PUT content-length cap** (in `/api/save`, free): sign the URL with a
  `content-length-range` condition (e.g. ≤ 25 MB) so no single upload can be huge — bounds per-write cost
  regardless of request rate. This is the guard that actually caps spend.
- **S3 lifecycle expiry** (in CDK, free): auto-delete objects after N days (e.g. 30) so even a burst that
  slips through doesn't accumulate storage cost forever.

Rate limiting throttles *frequency*; the size cap + lifecycle bound *cost*. Both are worth having; the
size cap and lifecycle are essentially free and always apply even if the rate limiter is misconfigured.

## Error handling

- Bake with no video playing → button hidden.
- `MediaRecorder` unsupported → silent bake + note.
- Presign/`PUT` failure → surface "couldn't save — try again", don't show a snippet.
- Embed: missing/expired/corrupt object → show a small "clip unavailable" message.
- Grid too large → warn before baking (soft cap).

## Build order

1. `aws/` CDK stack → deploy bucket + IAM (user runs `cdk deploy`, sets Vercel env).
2. `/api/save` (presigned PUT) + `boto3`.
3. Capture + encode + `.asciiv` writer in the player, behind the generate-embed button.
4. `embed.html` decoder/player + snippet UI.

Each step is independently testable: (1) a manual `aws s3 cp` GET check, (2) curl `/api/save` + PUT a dummy blob, (3) bake → inspect the blob offline with a small decoder, (4) load `/embed.html?id=` on a real object.
