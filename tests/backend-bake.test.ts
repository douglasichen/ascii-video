import { test } from "vitest";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegPath from "ffmpeg-static";
import { bakeAsciivFromFile, decodeFramesFromMp4 } from "../api/bake";
import { decodeAsciiv } from "../src/codec";
import { buildFrameHTML, buildContrastLUT } from "../src/pure";

// Backend-bake correctness gate. The whole point of the backend bake is that it produces the SAME .asciiv a
// browser would, by REUSING pure.buildFrameHTML + codec.encodeAsciiv2 rather than reimplementing them. These
// tests prove the seam ffmpeg → shared code → encode → decode is intact:
//   1. Fidelity — the frame grids the decode path yields are, byte-for-byte, what pure.buildFrameHTML's `rec`
//      produces on the SAME RGBA. (Guarantees "backend quantization == live look" for identical pixels.)
//   2. End-to-end — bake a synthesized clip (ffmpeg makes its own fixture, so this runs anywhere ffmpeg-static
//      installs), decode it back, assert the v:2 header + frame count + audio survive the round-trip.

const settings = {
  color: "#ffffff", shading: true, detail: 6, contrast: 50, brightness: 50,
  invert: false, saturation: 0, fade: true, maxfps: 30,
};

// A short silent+tone test clip via ffmpeg's lavfi sources — no external fixture needed.
function makeClip(dir: string, withAudio: boolean): string {
  const out = join(dir, "clip.mp4");
  const args = ["-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc=duration=1.5:size=96x64:rate=15"];
  if (withAudio) args.push("-f", "lavfi", "-i", "sine=frequency=440:duration=1.5");
  args.push("-pix_fmt", "yuv420p", "-t", "1.5");
  if (withAudio) args.push("-c:a", "aac", "-shortest");
  args.push("-y", out);
  const r = spawnSync(ffmpegPath as string, args);
  assert.strictEqual(r.status, 0, "ffmpeg fixture gen failed: " + r.stderr);
  return out;
}

test("decode path is byte-identical to pure.buildFrameHTML on the same RGBA", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bake-fid-"));
  try {
    const cols = 40, rows = 24;
    const clip = makeClip(dir, false);
    const frames = await decodeFramesFromMp4(clip, cols, rows, 15, settings as any);
    assert.ok(frames.length > 0, "no frames decoded");
    // Re-derive the FIRST frame's expected grid by pulling that exact RGBA out of ffmpeg and running the
    // shared code directly — the backend and this reference must agree cell-for-cell.
    const rawArgs = ["-hide_banner", "-loglevel", "error", "-i", clip, "-an",
      "-vf", `scale=${cols}:${rows}:flags=bilinear`, "-r", "15", "-frames:v", "1",
      "-pix_fmt", "rgba", "-f", "rawvideo", "-"];
    const raw = spawnSync(ffmpegPath as string, rawArgs, { maxBuffer: 1 << 24 });
    assert.strictEqual(raw.status, 0);
    const clut = new Uint8ClampedArray(256);
    buildContrastLUT(clut, settings.contrast, settings.brightness, settings.invert);
    const rec = new Uint16Array(cols * rows);
    buildFrameHTML(new Uint8Array(raw.stdout.buffer, raw.stdout.byteOffset, cols * rows * 4), cols, rows, settings as any, clut, rec);
    assert.deepStrictEqual(Array.from(frames[0]), Array.from(rec), "backend grid != buildFrameHTML rec");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("bake → decode round-trips: v:2 header, frame count, audio", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bake-e2e-"));
  try {
    const cols = 48, rows = 32, fps = 15;
    const clip = makeClip(dir, true);
    const bytes = await bakeAsciivFromFile(clip, cols, rows, fps, settings as any);
    const dec = await decodeAsciiv(bytes);
    assert.strictEqual(dec.header.v, 2, "expected v:2");
    assert.strictEqual(dec.header.cols, cols);
    assert.strictEqual(dec.header.rows, rows);
    assert.strictEqual(dec.header.fps, fps);
    assert.strictEqual(dec.header.shading, true);
    assert.strictEqual(dec.header.cube, false, "saturation 0 -> gray levels, not cube");
    assert.ok(dec.header.frameCount >= 15 && dec.header.frameCount <= 30, "frameCount ~ 1.5s*15fps, got " + dec.header.frameCount);
    assert.ok(dec.frames.length === dec.header.frameCount);
    assert.ok(dec.audio && dec.audio.length > 0, "audio track missing");
    assert.match(dec.header.audioMime || "", /audio\/webm/);
    // decoded grids are the same u16 cells we encoded (frame 0 non-trivial)
    assert.ok((dec.frames[0] as Uint16Array).some((v) => v !== 0), "frame 0 all-zero (decode broken)");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("saturation>0 bakes cube colour keys", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bake-cube-"));
  try {
    const clip = makeClip(dir, false);
    const bytes = await bakeAsciivFromFile(clip, 32, 24, 15, { ...settings, saturation: 80 } as any);
    const dec = await decodeAsciiv(bytes);
    assert.strictEqual(dec.header.cube, true, "saturation>0 must set cube");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
