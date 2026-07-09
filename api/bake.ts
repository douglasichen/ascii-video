// api/bake.ts — BACKEND bake: turn a video source + render settings + grid into the SAME .asciiv bytes the
// browser's real-time "save" bake produces, then upload to S3. Moves the compute off the browser's
// MediaRecorder path (real-time, tab-foreground-bound, fragile) onto ffmpeg (faster-than-real-time,
// headless). See CLAUDE.md "Baked embeds".
//
// FIDELITY: the per-cell quantization + the .asciiv v:2 encoder are the SHARED browser code
// (src/pure.ts buildFrameHTML/buildContrastLUT, src/codec.ts encodeAsciiv2) — NOT reimplemented here — so
// given identical RGBA the packed cells are byte-identical to the live look. The one thing that differs is
// the *sampling*: the browser downscales via canvas drawImage+getImageData, we downscale via ffmpeg
// `scale=…:flags=bilinear`. YUV→RGB + scaling are not bit-identical across the two, but the 8-level / 125-
// cube quantization collapses the small differences, so the bake is visually identical (the old real-time
// bake wasn't bit-deterministic across browsers/machines either). See the PR for the honest write-up.
//
// FLOW (client stays in charge of the instant-snippet + dedup): the browser computes the content-hash key,
// shows the <iframe> snippet immediately, POSTs /api/save {hash} to check the cache and (on a miss) get a
// presigned S3 upload, then fires THIS endpoint with the resolved source URL + settings + the presigned
// upload. We fetch the source, ffmpeg-decode it to the exact cols×rows grid at the fixed fps, asciify every
// frame with the shared code, encode .asciiv v:2, and upload via the presigned POST. The embed page polls
// S3 and lights up when the object appears — same UX as before, just baked server-side.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lookup as dnsLookup } from "node:dns/promises";
import ffmpegPath from "ffmpeg-static";
import { buildFrameHTML, buildContrastLUT, type FrameSettings } from "../src/pure.js";
import { encodeAsciiv2, type EncodeHeader } from "../src/codec.js";

// Bounds — a bake holds every frame's grid in memory (encodeAsciiv2 delta-encodes across the whole array)
// and the function has a wall-clock/memory budget, so cap the work. Over-cap clips fall back to the
// browser's real-time bake (the client decides; see embed.ts). Generous for the short clips embeds are for.
const MAX_CELLS = 200_000;         // cols*rows — mirrors the render's practical grid
const MAX_FPS = 30;                // matches the maxfps slider cap
const MAX_SECONDS = 90;            // backend-bake length cap (well inside the 300s function budget)
const MAX_FRAMES = MAX_FPS * MAX_SECONDS;
// The in-memory cost is every frame's u16 grid held at once (encodeAsciiv2 delta-encodes across the whole
// array). Bound cols*rows*frames so a huge-grid × long-clip combo can't OOM the function: 30M cells = 60MB
// of grids. This is the effective frame cap per grid size (see decodeFramesFromMp4). NOTE: the 25MB S3
// upload cap (api/save.py) usually binds FIRST for high-motion clips — a large grid over ~30–90s can exceed
// it and the presigned POST rejects the upload (same 25MB ceiling the old real-time bake used).
const MAX_TOTAL_CELLS = 30_000_000;
const MAX_SOURCE_BYTES = 60 * 1024 * 1024; // dropped files cap at 50MB; a resolved 360p clip is smaller
const FETCH_TIMEOUT_MS = 60_000;

interface BakeSettings extends FrameSettings {
  detail: number; contrast: number; brightness: number; invert: boolean;
  saturation: number; fade: boolean; maxfps: number;
}
interface BakeRequest {
  source: string;                    // the ALREADY-RESOLVED playback URL (video.src): Apify mp4 / direct URL
  cols: number; rows: number; fps: number;
  settings: BakeSettings;
  upload: { url: string; fields: Record<string, string> }; // presigned S3 POST from /api/save
}

// ── SSRF guard ────────────────────────────────────────────────────────────────────────────────────────
// This endpoint fetches a client-supplied URL server-side. On Lambda-backed hosts an unguarded fetch to a
// private/link-local address (169.254.169.254, 127.0.0.1, 10/8 …) can reach instance metadata / internal
// services. Require https, resolve the host, and reject any non-public address. (Residual DNS-rebind risk
// is noted in the PR; a full fix pins the resolved IP into the connection.)
function isPrivateIp(ip: string): boolean {
  if (ip.includes(":")) { // IPv6: block loopback, link-local, ULA, and v4-mapped
    const l = ip.toLowerCase();
    if (l === "::1" || l.startsWith("fe80") || l.startsWith("fc") || l.startsWith("fd")) return true;
    const m = l.match(/::ffff:(\d+\.\d+\.\d+\.\d+)/); if (m) return isPrivateIp(m[1]);
    return false;
  }
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true; // malformed -> refuse
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224; // private/link-local/multicast/reserved
}
async function assertPublicHttps(raw: string): Promise<void> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error("bad source url"); }
  if (u.protocol !== "https:") throw new Error("source must be https");
  const { address } = await dnsLookup(u.hostname);
  if (isPrivateIp(address)) throw new Error("source resolves to a non-public address");
}

// ── ffmpeg ──────────────────────────────────────────────────────────────────────────────────────────────
function runFfmpeg(args: string[], onStdout?: (b: Buffer) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath as string, args, { stdio: ["ignore", onStdout ? "pipe" : "ignore", "pipe"] });
    let err = "";
    if (onStdout && ff.stdout) ff.stdout.on("data", onStdout);
    ff.stderr?.on("data", (d) => { err = (err + d).slice(-2000); });
    ff.on("error", reject);
    ff.on("close", (code) => code === 0 ? resolve() : reject(new Error("ffmpeg exited " + code + ": " + err)));
  });
}

// Decode the source to raw RGBA at EXACTLY cols×rows and `fps`, asciifying each frame on the fly with the
// shared render code so we never hold more than one RGBA frame plus the (small) packed grids. Returns the
// v:2 cell grids — byte-for-byte what buildFrameHTML's `rec` captures in the browser. bilinear scaling is
// the closest match to canvas drawImage's default smoothing.
export async function decodeFramesFromMp4(
  input: string, cols: number, rows: number, fps: number, settings: BakeSettings,
): Promise<Uint16Array[]> {
  const frameBytes = cols * rows * 4;
  const frameCap = Math.min(MAX_FRAMES, Math.floor(MAX_TOTAL_CELLS / (cols * rows))); // bound memory by grid size
  const clut = new Uint8ClampedArray(256);
  buildContrastLUT(clut, settings.contrast, settings.brightness, settings.invert);
  const frames: Uint16Array[] = [];
  let acc = Buffer.alloc(0);
  const onData = (chunk: Buffer) => {
    acc = acc.length ? Buffer.concat([acc, chunk]) : chunk;
    while (acc.length >= frameBytes) {
      if (frames.length >= frameCap) { acc = Buffer.alloc(0); return; }
      const raw = acc.subarray(0, frameBytes);
      const rec = new Uint16Array(cols * rows);
      buildFrameHTML(new Uint8Array(raw.buffer, raw.byteOffset, frameBytes), cols, rows, settings, clut, rec);
      frames.push(rec);
      acc = acc.subarray(frameBytes);
    }
  };
  await runFfmpeg([
    "-hide_banner", "-loglevel", "error", "-i", input,
    "-an", "-vf", `scale=${cols}:${rows}:flags=bilinear`, "-r", String(fps),
    "-frames:v", String(frameCap), "-pix_fmt", "rgba", "-f", "rawvideo", "-",
  ], onData);
  return frames;
}

// Extract audio as opus-in-webm (audioMime "audio/webm" — matches the codec's AUDIO_MIME_OK and the
// browser MediaRecorder default). Returns null if the source has no audio track.
export async function extractAudio(input: string, dir: string): Promise<Uint8Array | null> {
  const out = join(dir, "audio.webm");
  try {
    await runFfmpeg(["-hide_banner", "-loglevel", "error", "-i", input, "-vn", "-c:a", "libopus", "-b:a", "96k", "-f", "webm", "-y", out]);
  } catch { return null; } // no audio stream -> ffmpeg errors; a silent embed is fine
  try { const b = await readFile(out); return b.length ? new Uint8Array(b) : null; } catch { return null; }
}

// The whole bake, given a LOCAL file path: decode+asciify frames, extract audio, encode .asciiv v:2. Split
// out so tests can drive it on a fixture mp4 without any network/S3. fps is clamped; frameCount = the frames
// ffmpeg actually produced (already even at `fps`), so the v:2 fixed-fps timeline is drift-free by construction.
export async function bakeAsciivFromFile(path: string, cols: number, rows: number, fps: number, settings: BakeSettings): Promise<Uint8Array> {
  const dir = await mkdtemp(join(tmpdir(), "asciiv-"));
  try {
    const [frames, audio] = await Promise.all([
      decodeFramesFromMp4(path, cols, rows, fps, settings),
      extractAudio(path, dir),
    ]);
    if (!frames.length) throw new Error("no frames decoded");
    const header: EncodeHeader = {
      fps, cols, rows, colour: settings.color, shading: settings.shading, fade: settings.fade,
      durationMs: Math.round((frames.length / fps) * 1000),
      cube: settings.shading && settings.saturation > 0,
      audioMime: audio ? "audio/webm" : "",
    };
    return encodeAsciiv2(header, frames, audio);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Fetch the resolved source to /tmp (size-capped), bake, and return the .asciiv bytes.
async function bakeFromUrl(source: string, cols: number, rows: number, fps: number, settings: BakeSettings): Promise<Uint8Array> {
  await assertPublicHttps(source);
  const dir = await mkdtemp(join(tmpdir(), "asciiv-src-"));
  const inPath = join(dir, "in.mp4");
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let buf: Buffer;
    try {
      const r = await fetch(source, { signal: ctrl.signal, redirect: "follow" });
      if (!r.ok) throw new Error("source fetch failed (" + r.status + ")");
      const len = Number(r.headers.get("content-length") || 0);
      if (len && len > MAX_SOURCE_BYTES) throw new Error("source too large");
      const ab = await r.arrayBuffer();
      if (ab.byteLength > MAX_SOURCE_BYTES) throw new Error("source too large");
      buf = Buffer.from(ab);
    } finally { clearTimeout(timer); }
    await writeFile(inPath, buf);
    return bakeAsciivFromFile(inPath, cols, rows, fps, settings);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Upload the .asciiv bytes to the presigned S3 POST minted by /api/save (fields first, file LAST — S3
// requires that order; FormData preserves insertion order).
async function uploadToS3(upload: BakeRequest["upload"], bytes: Uint8Array): Promise<void> {
  const fd = new FormData();
  for (const [k, v] of Object.entries(upload.fields)) fd.append(k, v);
  fd.append("file", new Blob([bytes], { type: "application/octet-stream" }));
  const r = await fetch(upload.url, { method: "POST", body: fd });
  if (!r.ok) throw new Error("s3 upload failed (" + r.status + ")");
}

// Validate the untrusted request body before doing any expensive work.
function parseRequest(body: any): BakeRequest {
  const isInt = (x: any, lo: number, hi: number) => Number.isInteger(x) && x >= lo && x <= hi;
  if (!body || typeof body !== "object") throw new Error("bad body");
  const { source, cols, rows, fps, settings, upload } = body;
  if (typeof source !== "string") throw new Error("bad source");
  if (!isInt(cols, 1, 4096) || !isInt(rows, 1, 4096) || cols * rows > MAX_CELLS) throw new Error("bad grid");
  if (!isInt(fps, 1, MAX_FPS)) throw new Error("bad fps");
  if (!settings || typeof settings !== "object") throw new Error("bad settings");
  if (typeof settings.color !== "string" || !/^#[0-9a-f]{6}$/i.test(settings.color)) throw new Error("bad colour");
  if (!upload || typeof upload.url !== "string" || !upload.fields || typeof upload.fields !== "object") throw new Error("bad upload");
  const s: BakeSettings = {
    color: settings.color, shading: !!settings.shading,
    detail: Number(settings.detail) || 0, contrast: Number(settings.contrast) || 0,
    brightness: Number(settings.brightness) || 0, invert: !!settings.invert,
    saturation: Math.max(0, Math.min(100, Number(settings.saturation) || 0)),
    fade: !!settings.fade, maxfps: Number(settings.maxfps) || fps,
  };
  return { source, cols, rows, fps, settings: s, upload };
}

// Vercel Node serverless handler. Fired-and-forgotten by the client (it already showed the snippet); the
// embed page polls S3 and lights up when we finish the upload. Returns 200 {ok} / 4xx-5xx {error}.
export default async function handler(req: any, res: any): Promise<void> {
  const json = (status: number, obj: any) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(obj));
  };
  if (req.method !== "POST") return json(405, { error: "POST only" });
  // Same-origin CSRF deterrent (mirrors api/save.py): a declared Origin/Referer host must equal ours.
  const origin = req.headers.origin || req.headers.referer || "";
  if (origin) {
    try {
      const host = String(req.headers.host || "").split(":")[0].toLowerCase();
      if (new URL(origin).hostname.toLowerCase() !== host) return json(403, { error: "cross-origin refused" });
    } catch { return json(403, { error: "bad origin" }); }
  }
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return json(400, { error: "bad json" }); } }
  if (!body) { // some runtimes don't pre-parse — read the stream
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    } catch { return json(400, { error: "bad json" }); }
  }
  let reqData: BakeRequest;
  try { reqData = parseRequest(body); } catch (e) { return json(400, { error: (e as Error).message }); }
  try {
    const bytes = await bakeFromUrl(reqData.source, reqData.cols, reqData.rows, reqData.fps, reqData.settings);
    await uploadToS3(reqData.upload, bytes);
    return json(200, { ok: true, bytes: bytes.length });
  } catch (e) {
    return json(502, { error: (e as Error).message.slice(0, 300) });
  }
}
