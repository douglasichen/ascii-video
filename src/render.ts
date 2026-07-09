// render.ts — the rendering pipeline: video → sample → grid → ASCII markup → DOM text, plus the
// requestVideoFrameCallback loop and the DEBUG fps profiler. The byte-exact per-frame maths lives in
// pure.ts (buildFrameHTML / buildContrastLUT / gridDims / the palette+cube CSS); this module is the thin
// DOM glue around it (drawImage/getImageData, <style> updates, innerHTML/textContent). See CLAUDE.md for
// why span/run count — not per-pixel math — is the render's bottleneck, and why output is DOM text (crisp
// at any zoom) not canvas glyphs.
import {
  buildFrameHTML, buildContrastLUT, gridDims, fontPxFor, buildPaletteCSS, buildColorCubeCSS,
} from "./pure.js";
import { state, rt } from "./state.js";
import { video, screen, canvas, ctx, bar, fpsEl } from "./dom.js";
import { applyReactivity, updateFade } from "./reactive.js";
import { setComputing, stopLoader } from "./sources.js";

// Per-frame timings paint() returns so the loop can profile (draw / build / dom phase durations, ms).
interface Timings { d: number; b: number; dom: number; }
// The rVFC metadata fields we read (a minimal shape — the full VideoFrameCallbackMetadata isn't in every lib).
interface FrameMeta { presentedFrames: number; mediaTime: number; }

// contrast curve, rebuilt per frame (256 entries is nothing next to the pixel loop). Uint8Clamped rounds+clamps for free.
const CONTRAST_LUT = new Uint8ClampedArray(256);
// One <style> holding the per-level colours; rebuilt whenever the base colour changes (buildPalette).
const quantStyle = document.head.appendChild(document.createElement("style"));

export function computeGrid(): void {
  if (!video.videoWidth) return;
  // Freeze the grid while baking an embed. recFrames are captured at the CURRENT cols*rows and the header
  // stores ONE cols/rows for the whole file; if anything (music reactivity's res-punch, a resize, a control
  // tweak) regrids mid-bake, frames of different sizes land in one file and the decoder reads garbage past
  // the header's N -> severe glitching. One guard here covers every caller. (state.detail may still move;
  // paint() reads cols/rows, not state.detail, so the captured frames stay consistent.)
  if (rt.recording) return;
  const fontPx = fontPxFor(state.detail);
  const barH = bar.offsetHeight; // top URL bar is fixed and opaque; keep the grid clear of it
  const availH = window.innerHeight - barH;
  const { cols, rows } = gridDims(fontPx, window.innerWidth, availH, video.videoWidth, video.videoHeight);
  rt.cols = cols;
  rt.rows = rows;
  canvas.width = cols;
  canvas.height = rows;
  screen.style.fontSize = fontPx + "px";
  screen.style.top = (barH + availH / 2) + "px"; // center in the space below the bar, not the whole viewport
}

// Level i ramps black (i=0) -> the base colour (i=LEVELS-1); base white = the classic gray ramp. Also sets
// #screen's flat colour for turbo (shading-off) mode. The CSS string is built in pure.buildPaletteCSS.
export function buildPalette(color: string): void {
  quantStyle.textContent = buildPaletteCSS(color);
  screen.style.color = color; // turbo mode's flat text colour
}

// Sample the current video frame and rebuild the ASCII at the CURRENT cols/rows. Split out of the loop so
// a control change can re-render on demand (see setControl) — the loop is the only *other* caller. Returns
// the per-phase timings so the loop can profile; callers that just want a refresh ignore them.
export function paint(): Timings {
  const tDraw = performance.now();
  ctx.drawImage(video, 0, 0, rt.cols, rt.rows);
  const data = ctx.getImageData(0, 0, rt.cols, rt.rows).data;
  const tBuild = performance.now();
  // brightness / contrast / invert fold into this one per-frame LUT (see pure.buildContrastLUT).
  buildContrastLUT(CONTRAST_LUT, state.contrast, state.brightness, state.invert);
  const rec = rt.recording ? new Uint8Array(rt.cols * rt.rows) : null; // capture char-indices while baking an embed
  const out = buildFrameHTML(data, rt.cols, rt.rows, state, CONTRAST_LUT, rec);
  if (rec) { rt.recFrames.push(rec); rt.recTimes.push(performance.now() - rt.recStart - rt.recPausedMs); } // frame + its real capture time
  const tDom = performance.now();
  // textContent skips the HTML parse + per-cell element create/destroy entirely (~20x cheaper).
  if (state.shading) screen.innerHTML = out;
  else screen.textContent = out;
  if (rt.DEBUG) void screen.offsetHeight; // force layout so its cost lands in the measurement (debug only)
  const tEnd = performance.now();
  return { d: tBuild - tDraw, b: tDom - tBuild, dom: tEnd - tDom };
}

// ── render loop + fps profiler ─────────────────────────────────────────────────────────────────────────
let fpsCount = 0, fpsLast = 0, drawMs = 0, buildMs = 0, domMs = 0;
let lastVt = 0; // last video frame time, to detect loop wrap (decode stall on wrap is not a render cost)
let lastPresented = 0, presentedAtWindow = 0; // rVFC frame counter: video frames actually shown vs frames rendered
const FRAME_JITTER = 4; // tolerance so a frame arriving a hair early still counts (see state.maxfps)
let lastRender = -1e9;

// Render once per PRESENTED VIDEO FRAME, not per display refresh: a 30fps video on a 60/120Hz screen was
// rebuilt 2-4x per frame for identical output. requestVideoFrameCallback fires exactly per new frame ->
// halves+ the build/dom/getImageData work and the GC that rides on it. Re-registers itself (always, even
// when the work is skipped) so it self-heals across pause/resume. rAF is the fallback.
export function scheduleFrame(): void {
  const v = video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: (now: number, metadata: FrameMeta) => void) => number };
  if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(renderFrame);
  else requestAnimationFrame((now) => renderFrame(now));
}

// Ranked list of the worst frames since load, worst -> best. Lives on window (set in initRenderStyles) so
// it survives and can be dumped on demand. Loop-wrap frames are excluded. Click #fps to reset the list.
interface WorstRec { ms: number; d: number; b: number; dom: number; grid: string; at: number; }
const WORST_N = 20;
const worst: WorstRec[] = [];
function logWorst(): void {
  console.log("[WORST] top " + worst.length + " frames (worst→best):\n" + worst.map((w, i) =>
    `${String(i + 1).padStart(2)}. ${w.ms.toFixed(0).padStart(3)}ms  d${w.d.toFixed(1)} b${w.b.toFixed(1)} dom${w.dom.toFixed(1)}  ${w.grid} @${w.at}ms`).join("\n"));
}

function renderFrame(now: number, metadata?: FrameMeta): void {
  if (metadata) lastPresented = metadata.presentedFrames; // count video frames even on skipped renders, so "drop" stays honest
  if (!video.paused) updateFade();
  if (!video.paused && !video.ended && rt.rows && now - lastRender >= 1000 / state.maxfps - FRAME_JITTER) {
    lastRender = now;
    applyReactivity(now); // music mode: drive the DRIVEN controls from the audio before painting this frame
    const { d, b, dom } = paint();
    if (rt.firstPaintPending) { // the first ascii frame is now on screen -> reveal it, hide the loader, re-enable CTAs
      rt.firstPaintPending = false;
      document.body.classList.add("playing");
      setComputing(false); stopLoader();
    }
    const total = d + b + dom;
    const vt = metadata ? metadata.mediaTime : video.currentTime; // rVFC gives the exact frame time
    const looped = vt < lastVt; // wrapped to start -> decode stall, skip this frame
    lastVt = vt;
    drawMs += d; buildMs += b; domMs += dom;
    if (!looped && (worst.length < WORST_N || total > worst[worst.length - 1].ms)) {
      const record = total > (worst.length ? worst[0].ms : 0); // new all-time worst?
      worst.push({ ms: total, d, b, dom, grid: `${rt.cols}×${rt.rows}`, at: Math.round(now) });
      worst.sort((x, y) => y.ms - x.ms);
      if (worst.length > WORST_N) worst.length = WORST_N;
      if (rt.DEBUG && record) logWorst(); // only on a new #1 (rare); full list is on window.WORST, dumpWorst() anytime
    }
    fpsCount++;
    if (now - fpsLast >= 500) { // always resets the counters; only writes the readout when DEBUG
      const n = fpsCount, secs = (now - fpsLast) / 1000;
      const renderFps = Math.round(n / secs);
      // normalize to the video: rendered fps vs the video's own fps, and frames we couldn't keep up with
      let head = `${renderFps} fps`;
      if (lastPresented) {
        const vFrames = lastPresented - presentedAtWindow;
        const dropped = Math.max(0, vFrames - n);
        head = `${renderFps}/${Math.round(vFrames / secs)} fps · ${dropped} drop`;
        presentedAtWindow = lastPresented;
      }
      const w = worst[0];
      if (rt.DEBUG) fpsEl.textContent = `${head} · ${rt.cols}×${rt.rows} · `
        + `avg d${(drawMs / n).toFixed(1)} b${(buildMs / n).toFixed(1)} dom${(domMs / n).toFixed(1)} · `
        + (w ? `worst ${w.ms.toFixed(0)}ms (d${w.d.toFixed(0)} b${w.b.toFixed(0)} dom${w.dom.toFixed(0)}) ⟳` : "");
      fpsLast = now;
      fpsCount = drawMs = buildMs = domMs = 0;
    }
  }
  scheduleFrame(); // re-register unconditionally so the chain survives skipped/paused frames
}

// One-time DOM/style setup, called from main after all modules are evaluated. Builds the initial palette,
// injects the fixed 125-colour cube <style>, and wires the debug conveniences (window.WORST/dumpWorst +
// the #fps click-to-reset).
export function initRenderStyles(): void {
  buildPalette(state.color);
  document.head.appendChild(document.createElement("style")).textContent = buildColorCubeCSS();
  (window as any).WORST = worst;
  (window as any).dumpWorst = logWorst;
  fpsEl.addEventListener("click", () => { worst.length = 0; console.log("[WORST] reset"); });
}
