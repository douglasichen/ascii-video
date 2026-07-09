/* Shared .asciiv codec — the single source of truth for the baked-embed format, imported by BOTH the
 * main player (encode, src/embed.ts) and the embed player (decode, src/embed-page.ts) so they can never
 * drift. Also runnable in Node (globals CompressionStream / Response exist in Node 18+) so the format
 * round-trips in a headless test (tests/embed.test.ts, tests/asciiv2.test.ts).
 *
 * Container (little-endian), shared by both versions:
 *   "ASCV" | u32 headerLen | header JSON | u32 audioLen | audio bytes | gzip(frame stream)
 * header: { v, fps, cols, rows, frameCount, colour, shading, durationMs, audioMime, times?, cube? }
 *
 * v:2 (current writer) — FIXED-FPS + WYSIWYG COLOUR. The bake resamples the uneven rVFC capture onto a
 *   uniform fps grid whose t=0 is the AUDIO recorder's start (see embed.ts), so playback is just
 *   frame = floor(t * fps) clamped — one clock, one rate, no per-frame times, no drift. Each cell is a
 *   u16: low 4 bits = ramp char-index (0..9), bits 4+ = the colour key the LIVE renderer actually showed —
 *   a gray level 0..7, or (when header.cube) a 125-colour cube index 0..124 (saturation carries; still a
 *   tiny quantized palette, so playback run-merging is untouched). frame stream: frame0 = cols*rows u16 LE;
 *   frameK = u32 changed count, then count*(u32 cellIndex, u16 cell).
 *
 * v:1 (legacy, already published on S3 — decode must never change) — per cell ONLY the char-index (u8);
 *   the colour level is DERIVED from it and the palette rebuilt from `colour` (so saturation was lost).
 *   frame stream: frame0 = cols*rows u8; frameK = u32 count, then count*(u32 cellIndex, u8 charIndex).
 *   `times` (optional): per-frame capture timestamps (ms from recording start, monotonic, length ==
 *   frameCount); playback maps the audio clock -> frame via frameAt. Absent -> even-phase fallback.
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
  cube?: boolean; // v:2 — colour keys are 125-cube indices (saturation>0) instead of gray levels
}
// What encodeAsciiv accepts (it adds v + frameCount itself).
export type EncodeHeader = Omit<AsciivHeader, "v" | "frameCount">;
export interface DecodedAsciiv {
  header: AsciivHeader;
  frames: Uint8Array[] | Uint16Array[]; // u8 char-indices (v:1) or packed u16 cells (v:2)
  audio: Uint8Array | null;
}

export const RAMP = " .:-=+*#%@";        // 10 chars — MUST match the main renderer
const RAMP_LAST = RAMP.length - 1;
export const LEVELS = 8;                  // colour levels — MUST match the main renderer
const LEVEL_CLASS: string[] = [];
for (let i = 0; i < LEVELS; i++) LEVEL_CLASS[i] = String.fromCharCode(97 + i); // "a".."h"

const ciToLevel = (ci: number): number => Math.round((ci / RAMP_LAST) * (LEVELS - 1)); // char-index -> colour level (v:1 only)
const CUBE_MAX = 124; // CQ^3-1 — the fixed 5-level-per-channel colour cube (mirrors pure.ts CQ=5)

// Header caps — an .asciiv can be uploaded by anyone (presigned /api/save), so the embed player
// decodes untrusted input. These bound allocation so a tiny malicious file can't OOM the viewer,
// and constrain the fields that drive markup/CSS. Generous vs. any real clip; a violation fails closed.
const MAX_DIM = 4096, MAX_CELLS = 1_000_000, MAX_FRAMES = 100_000, MAX_TOTAL_CELLS = 100_000_000, MAX_FPS = 240;
const AUDIO_MIME_OK = /^audio\/(webm|mp4|ogg)\b/i;   // base type; tolerates a ";codecs=…" suffix
// `h` is untrusted parsed JSON — validate every field before trusting it as a header.
export function validHeader(h: any): boolean {
  const isInt = (x: any, lo: number, hi: number) => Number.isInteger(x) && x >= lo && x <= hi;
  if (!h || typeof h !== "object") return false;
  // Version gate: absent/1 = legacy, 2 = fixed-fps. An unknown future version fails closed rather than
  // being misread as v:1 (its frame stream would decode as garbage markup).
  if (h.v != null && h.v !== 1 && h.v !== 2) return false;
  if (h.cube != null && typeof h.cube !== "boolean") return false;
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

// Bake-time resample (v:2): the rVFC capture is UNEVEN in time (maxfps/browser-throttled) — frames[i]
// appeared on screen at timesMs[i] (ms from the audio recorder's start). Snap it onto a uniform fps grid:
// grid instant k/fps shows whatever frame was live then (the last capture at or before it; frame 0 before
// the first capture — the seek-to-0 start frame, so there are never gaps or holds baked in). After this,
// playback needs no per-frame times at all: frame = floor(t * fps). Duplicated frames delta-encode to
// 4 bytes each, so the uniform grid costs almost nothing.
export function resampleToFps<T>(frames: T[], timesMs: number[], fps: number, frameCount: number): T[] {
  const out: T[] = [];
  let j = 0;
  for (let k = 0; k < frameCount; k++) {
    const t = (k * 1000) / fps;
    while (j + 1 < frames.length && timesMs[j + 1] <= t) j++;
    out.push(frames[j]);
  }
  return out;
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

// v:2 grid (Uint16Array cols*rows of packed cells: char-index | colourKey<<4) -> byte-identical markup to
// what the live renderer (pure.buildFrameHTML) showed when the cell was captured — WYSIWYG, including
// saturation (cube=true -> `<i class=k{key}>` cube classes; cube=false -> the gray level classes). Both
// key spaces are tiny fixed palettes, so runs merge exactly as they do live. Untrusted values clamp.
export function buildRows2(grid: Uint16Array, cols: number, rows: number, shading: boolean, cube: boolean): string {
  const parts: string[] = [];
  const maxKey = cube ? CUBE_MAX : LEVELS - 1;
  for (let r = 0; r < rows; r++) {
    let runKey = -1;
    const base = r * cols;
    for (let c = 0; c < cols; c++) {
      const v = grid[base + c];
      let ci = v & 15; if (ci > RAMP_LAST) ci = 0;    // clamp untrusted char-indices to the ramp
      if (shading) {
        let key = v >> 4; if (key > maxKey) key = 0;  // clamp untrusted colour keys to the palette
        if (key !== runKey) {
          if (runKey !== -1) parts.push("</i>");
          parts.push(cube ? "<i class=k" + key + ">" : "<i class=" + LEVEL_CLASS[key] + ">");
          runKey = key;
        }
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

// v:2 stream — same keyframe+delta scheme, u16 cells: frame0 = N u16 LE; frameK = u32 count, then
// count*(u32 cellIndex, u16 cell).
function encodeFrames2(frames: Uint16Array[], N: number): Uint8Array {
  const key = new Uint8Array(N * 2);
  const kdv = new DataView(key.buffer);
  for (let i = 0; i < N; i++) kdv.setUint16(i * 2, frames[0][i], true);
  const chunks: Uint8Array[] = [key];
  for (let k = 1; k < frames.length; k++) {
    const prev = frames[k - 1], cur = frames[k], changed: number[] = [];
    for (let i = 0; i < N; i++) if (cur[i] !== prev[i]) changed.push(i);
    const buf = new Uint8Array(4 + changed.length * 6);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, changed.length, true);
    let o = 4;
    for (const i of changed) { dv.setUint32(o, i, true); dv.setUint16(o + 4, cur[i], true); o += 6; }
    chunks.push(buf);
  }
  return concat(chunks);
}

function decodeFrames2(stream: Uint8Array, N: number, frameCount: number): Uint16Array[] {
  const dv = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  const grid = new Uint16Array(N);
  for (let i = 0; i < N; i++) grid[i] = dv.getUint16(i * 2, true);
  const frames: Uint16Array[] = [grid.slice()];
  let o = N * 2;
  for (let k = 1; k < frameCount; k++) {
    const count = dv.getUint32(o, true); o += 4;
    for (let j = 0; j < count; j++) { grid[dv.getUint32(o, true)] = dv.getUint16(o + 4, true); o += 6; }
    frames.push(grid.slice());
  }
  return frames;
}

// "ASCV" | header JSON | audio | gzip(frame stream) — shared by both encoders.
async function packContainer(full: AsciivHeader, frameStream: Uint8Array, audio: Uint8Array | null): Promise<Uint8Array> {
  const headerBytes = new TextEncoder().encode(JSON.stringify(full));
  const audioBytes = audio || new Uint8Array(0);
  const framesGz = await gzip(frameStream);
  const prefix = new Uint8Array(4 + 4 + headerBytes.length + 4 + audioBytes.length);
  const dv = new DataView(prefix.buffer);
  prefix.set([65, 83, 67, 86], 0); // "ASCV"
  dv.setUint32(4, headerBytes.length, true);
  prefix.set(headerBytes, 8);
  dv.setUint32(8 + headerBytes.length, audioBytes.length, true);
  prefix.set(audioBytes, 12 + headerBytes.length);
  return concat([prefix, framesGz]);
}

// Legacy v:1 encoder — kept byte-for-byte (tests round-trip it; decode of published files depends on it).
export async function encodeAsciiv(header: EncodeHeader, frames: Uint8Array[], audio: Uint8Array | null): Promise<Uint8Array> {
  return packContainer({ v: 1, frameCount: frames.length, ...header }, encodeFrames(frames, header.cols * header.rows), audio);
}

// v:2 encoder — fixed-fps, packed char+colour cells (see the header comment). What the bake writes now.
export async function encodeAsciiv2(header: EncodeHeader, frames: Uint16Array[], audio: Uint8Array | null): Promise<Uint8Array> {
  return packContainer({ v: 2, frameCount: frames.length, ...header }, encodeFrames2(frames, header.cols * header.rows), audio);
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
  // Max legit decompressed frame stream = keyframe + per delta-frame (u32 count + count*(u32 idx, cell),
  // count <= N; cells are u8 (v:1) or u16 (v:2)). Header is already validated/capped here, so this bounds
  // the gzip bomb to what the header allows.
  const N = header.cols * header.rows;
  const v2 = header.v === 2;
  const maxStream = v2 ? 2 * N + (header.frameCount - 1) * (4 + 6 * N) : N + (header.frameCount - 1) * (4 + 5 * N);
  const stream = await gunzip(framesGz, maxStream);
  const frames = v2 ? decodeFrames2(stream, N, header.frameCount) : decodeFrames(stream, N, header.frameCount);
  return { header, frames, audio: audio ? audio.slice() : null };
}
