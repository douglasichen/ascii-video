/* Shared .asciiv codec — the single source of truth for the baked-embed format, imported by BOTH the
 * main player (encode, src/embed.ts) and the embed player (decode, src/embed-page.ts) so they can never
 * drift. Also runnable in Node (globals CompressionStream / Response exist in Node 18+) so the format
 * round-trips in a headless test (tests/embed.test.ts).
 *
 * Container (little-endian):
 *   "ASCV" | u32 headerLen | header JSON | u32 audioLen | audio bytes | gzip(frame stream)
 * header: { v, fps, cols, rows, frameCount, colour, shading, durationMs, audioMime, times? }
 * `times` (optional, added without a version bump — still v:1): per-frame capture timestamps in ms
 *   relative to recording start, monotonic non-decreasing, length == frameCount. Playback maps the audio
 *   clock -> frame by these real times instead of even phase (capture is maxfps/rVFC-throttled, i.e. UNEVEN
 *   in time, so frame i's true instant isn't i/frameCount*clipDur). Absent on old files -> even-phase fallback.
 * frame stream (pre-gzip): frame0 = cols*rows char-indices (0..9); frameK = u32 changed count, then
 *   count*(u32 cellIndex, u8 charIndex) applied over the running grid. Low motion -> tiny deltas.
 *
 * Per cell we store ONLY the ramp char-index; the colour level is derived from it (both monotonic in
 * luminance), and the palette is rebuilt from `colour`. One value/cell keeps the file small.
 */

// The full decoded header. On encode, `v` and `frameCount` are injected; callers pass the rest.
export interface AsciivHeader {
  v: number;
  fps: number;
  cols: number;
  rows: number;
  frameCount: number;
  colour: string;
  shading: boolean;
  fade?: boolean;
  durationMs?: number;
  audioMime?: string;
  times?: number[];
}
// What encodeAsciiv accepts (it adds v + frameCount itself).
export type EncodeHeader = Omit<AsciivHeader, "v" | "frameCount">;
export interface DecodedAsciiv {
  header: AsciivHeader;
  frames: Uint8Array[];
  audio: Uint8Array | null;
}

export const RAMP = " .:-=+*#%@";        // 10 chars — MUST match the main renderer
const RAMP_LAST = RAMP.length - 1;
export const LEVELS = 8;                  // colour levels — MUST match the main renderer
const LEVEL_CLASS: string[] = [];
for (let i = 0; i < LEVELS; i++) LEVEL_CLASS[i] = String.fromCharCode(97 + i); // "a".."h"

const ciToLevel = (ci: number): number => Math.round((ci / RAMP_LAST) * (LEVELS - 1)); // char-index -> colour level

// Header caps — an .asciiv can be uploaded by anyone (presigned /api/save), so the embed player
// decodes untrusted input. These bound allocation so a tiny malicious file can't OOM the viewer,
// and constrain the fields that drive markup/CSS. Generous vs. any real clip; a violation fails closed.
const MAX_DIM = 4096, MAX_CELLS = 1_000_000, MAX_FRAMES = 100_000, MAX_TOTAL_CELLS = 100_000_000, MAX_FPS = 240;
const AUDIO_MIME_OK = /^audio\/(webm|mp4|ogg)\b/i;   // base type; tolerates a ";codecs=…" suffix
// `h` is untrusted parsed JSON — validate every field before trusting it as a header.
export function validHeader(h: any): boolean {
  const isInt = (x: any, lo: number, hi: number) => Number.isInteger(x) && x >= lo && x <= hi;
  if (!h || typeof h !== "object") return false;
  if (typeof h.colour !== "string" || !/^#[0-9a-f]{6}$/i.test(h.colour)) return false;
  if (!isInt(h.cols, 1, MAX_DIM) || !isInt(h.rows, 1, MAX_DIM)) return false;
  if (h.cols * h.rows > MAX_CELLS) return false;
  if (!isInt(h.frameCount, 1, MAX_FRAMES)) return false;
  if (h.frameCount * h.cols * h.rows > MAX_TOTAL_CELLS) return false;
  if (!isInt(h.fps, 1, MAX_FPS)) return false;
  if (h.audioMime != null && h.audioMime !== "" &&
      !(typeof h.audioMime === "string" && AUDIO_MIME_OK.test(h.audioMime))) return false;
  // Optional per-frame timestamps: if present must be one finite, non-negative, non-decreasing number per
  // frame (bounds the array to frameCount, already capped). Malformed -> fail closed like any other field.
  if (h.times != null) {
    if (!Array.isArray(h.times) || h.times.length !== h.frameCount) return false;
    let prev = -1;
    for (const x of h.times) { if (!Number.isFinite(x) || x < prev) return false; prev = x; }
  }
  return true;
}

// Map a playback clock (ms, any value >= 0) to a frame index using per-frame capture timestamps.
// Wraps the clock into [0, periodMs) then binary-searches for the last frame whose timestamp <= phase —
// so frames advance at their REAL captured cadence and wrap in lockstep with the loop period. times must
// be monotonic non-decreasing (validHeader guarantees it); the returned index is always in [0, len).
export function frameAt(times: number[], periodMs: number, tMs: number): number {
  let p = tMs % periodMs; if (p < 0) p += periodMs;
  let lo = 0, hi = times.length - 1, r = 0;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (times[m] <= p) { r = m; lo = m + 1; } else hi = m - 1; }
  return r;
}

// #screen <style>: level i ramps black -> base colour. Mirrors the main app's buildPalette().
export function buildPaletteCSS(colour: string): string {
  const r = parseInt(colour.slice(1, 3), 16), g = parseInt(colour.slice(3, 5), 16), b = parseInt(colour.slice(5, 7), 16);
  let css = "#screen i{font-style:normal}";
  for (let i = 0; i < LEVELS; i++) {
    const f = i / (LEVELS - 1);
    const hex = [r, g, b].map((x) => Math.round(x * f).toString(16).padStart(2, "0")).join("");
    css += `#screen .${LEVEL_CLASS[i]}{color:#${hex}}`;
  }
  return css;
}

// grid (Uint8Array cols*rows of char-indices) -> the same markup the main renderer emits.
export function buildRows(grid: Uint8Array, cols: number, rows: number, shading: boolean): string {
  const parts: string[] = [];
  for (let r = 0; r < rows; r++) {
    let runLv = -1, base = r * cols;
    for (let c = 0; c < cols; c++) {
      const raw = grid[base + c];
      const ci = raw >= 0 && raw <= RAMP_LAST ? raw : 0; // clamp untrusted char-indices to the ramp
      if (shading) {
        const lv = ciToLevel(ci);
        if (lv !== runLv) { if (runLv !== -1) parts.push("</i>"); parts.push("<i class=", LEVEL_CLASS[lv], ">"); runLv = lv; }
      }
      parts.push(RAMP[ci]);
    }
    if (shading) parts.push("</i>");
    if (r < rows - 1) parts.push("\n");
  }
  return parts.join("");
}

async function gzip(u8: Uint8Array): Promise<Uint8Array> {
  const s = new Response(u8).body!.pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
// Decompress with a hard output cap. The frame stream is untrusted (any .asciiv can be uploaded via the
// presigned /api/save and the 25 MB cap only bounds the COMPRESSED size), so a tiny highly-compressible gzip
// can balloon to gigabytes and OOM the viewer — the header caps don't help because the whole buffer is
// materialized here, before decodeFrames reads a byte. Stream-read and abort once the output exceeds the
// header-implied maximum (computed by the caller); a legit stream is always <= that bound.
async function gunzip(u8: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  const rs = new Response(u8).body!.pipeThrough(new DecompressionStream("gzip"));
  const reader = rs.getReader();
  const chunks: Uint8Array[] = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) { await reader.cancel(); throw new Error("frame stream too large"); }
    chunks.push(value);
  }
  return concat(chunks);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let n = 0; for (const c of chunks) n += c.length;
  const out = new Uint8Array(n); let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

function encodeFrames(frames: Uint8Array[], N: number): Uint8Array {
  const chunks: Uint8Array[] = [frames[0].slice(0, N)]; // keyframe
  for (let k = 1; k < frames.length; k++) {
    const prev = frames[k - 1], cur = frames[k], changed: number[] = [];
    for (let i = 0; i < N; i++) if (cur[i] !== prev[i]) changed.push(i);
    const buf = new Uint8Array(4 + changed.length * 5);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, changed.length, true);
    let o = 4;
    for (const i of changed) { dv.setUint32(o, i, true); dv.setUint8(o + 4, cur[i]); o += 5; }
    chunks.push(buf);
  }
  return concat(chunks);
}

function decodeFrames(stream: Uint8Array, N: number, frameCount: number): Uint8Array[] {
  const grid = stream.slice(0, N); // running grid (mutated + snapshotted per frame)
  const frames: Uint8Array[] = [grid.slice()];
  const dv = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  let o = N;
  for (let k = 1; k < frameCount; k++) {
    const count = dv.getUint32(o, true); o += 4;
    for (let j = 0; j < count; j++) { grid[dv.getUint32(o, true)] = dv.getUint8(o + 4); o += 5; }
    frames.push(grid.slice());
  }
  return frames;
}

export async function encodeAsciiv(header: EncodeHeader, frames: Uint8Array[], audio: Uint8Array | null): Promise<Uint8Array> {
  const N = header.cols * header.rows;
  const full = { v: 1, frameCount: frames.length, ...header };
  const headerBytes = new TextEncoder().encode(JSON.stringify(full));
  const audioBytes = audio || new Uint8Array(0);
  const framesGz = await gzip(encodeFrames(frames, N));
  const prefix = new Uint8Array(4 + 4 + headerBytes.length + 4 + audioBytes.length);
  const dv = new DataView(prefix.buffer);
  prefix.set([65, 83, 67, 86], 0); // "ASCV"
  dv.setUint32(4, headerBytes.length, true);
  prefix.set(headerBytes, 8);
  dv.setUint32(8 + headerBytes.length, audioBytes.length, true);
  prefix.set(audioBytes, 12 + headerBytes.length);
  return concat([prefix, framesGz]);
}

export async function decodeAsciiv(u8: Uint8Array): Promise<DecodedAsciiv> {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (u8[0] !== 65 || u8[1] !== 83 || u8[2] !== 67 || u8[3] !== 86) throw new Error("not an .asciiv file");
  const headerLen = dv.getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(u8.subarray(8, 8 + headerLen)));
  if (!validHeader(header)) throw new Error("invalid .asciiv header"); // fail closed on untrusted input
  const audioLen = dv.getUint32(8 + headerLen, true);
  const audioStart = 12 + headerLen;
  const audio = audioLen ? u8.subarray(audioStart, audioStart + audioLen) : null;
  const framesGz = u8.subarray(audioStart + audioLen);
  // Max legit decompressed frame stream = keyframe (N) + per delta-frame (u32 count + count*(u32 idx,u8 val),
  // count <= N). Header is already validated/capped here, so this bounds the bomb to what the header allows.
  const N = header.cols * header.rows;
  const maxStream = N + (header.frameCount - 1) * (4 + 5 * N);
  const frames = decodeFrames(await gunzip(framesGz, maxStream), N, header.frameCount);
  return { header, frames, audio: audio ? audio.slice() : null };
}
