// main.ts — the only entry point in index.html (`<script type="module" src="/src/main.ts">`). Imports the
// other modules, runs their one-time init in the same order the old inline script did, binds the remaining
// cross-cutting events (resize, load/confirm, drag-drop, keyboard, feedback, beforeunload), then kicks the
// render loop and the default clip. See CLAUDE.md "Module layout" for what each module owns.
import { rt } from "./state.js";
import { video, fpsEl, urlInput, confirmWrap, fbWrap, fbText, fbStat, fbSend } from "./dom.js";
import { computeGrid, scheduleFrame, initRenderStyles } from "./render.js";
import { buildControls } from "./controls.js";
import { bindAudio } from "./audio.js";
import { bindSources, loadInput, loadFile, refreshLoadBtn } from "./sources.js";
import { bindEmbed } from "./embed.js";

// ── one-time init ────────────────────────────────────────────────────────────────────────────────────
bindAudio();          // is-mobile class, speaker button, gesture-to-unmute, video 'playing' audio settle
buildControls();      // build the panel from CONTROLS + wire inputs/reset/toggle
initRenderStyles();   // initial palette + the fixed colour-cube <style> + debug conveniences
bindSources();        // video error surfacing + mobile stall-resume
bindEmbed();          // save button + snippet copy/close

// Recompute the grid on a real window resize, but NOT on browser zoom (cmd +/-). Both fire a resize and
// both shrink/grow innerWidth in CSS px — but zoom ALSO changes devicePixelRatio, a genuine resize does
// not. So if dpr moved, it was a zoom: leave the resolution fixed and let the zoom just magnify the
// (crisp, DOM-text) output, instead of resampling to a new grid.
let lastDpr = window.devicePixelRatio;
window.addEventListener("resize", () => {
  if (window.devicePixelRatio !== lastDpr) { lastDpr = window.devicePixelRatio; return; }
  computeGrid();
});

// If a clip is already playing, confirm before replacing it. guardLoad defers the actual load until the
// user accepts the "load a new video?" dialog; with nothing playing it loads straight away.
let pendingLoad: (() => void) | null = null;
function guardLoad(action: () => void): void {
  if (document.body.classList.contains("playing")) { pendingLoad = action; confirmWrap.hidden = false; }
  else action();
}
(document.getElementById("confirmyes") as HTMLElement).addEventListener("click", () => { confirmWrap.hidden = true; const a = pendingLoad; pendingLoad = null; if (a) a(); });
(document.getElementById("confirmno") as HTMLElement).addEventListener("click", () => { confirmWrap.hidden = true; pendingLoad = null; });
(document.getElementById("load") as HTMLElement).addEventListener("click", () => guardLoad(() => loadInput(urlInput.value)));
urlInput.addEventListener("keydown", e => { if (e.key === "Enter") guardLoad(() => loadInput((e.target as HTMLInputElement).value)); });
urlInput.addEventListener("input", refreshLoadBtn);
refreshLoadBtn(); // start disabled (field is empty on load)
// Own-mp4 path is drag-and-drop only (see the drop handler below) — no upload button by design.

// feedback: a text field that POSTs to /api/feedback (stored server-side in a private S3 bucket).
(document.getElementById("fbbtn") as HTMLElement).addEventListener("click", () => { fbStat.textContent = ""; fbWrap.hidden = false; fbText.focus(); });
(document.getElementById("fbcancel") as HTMLElement).addEventListener("click", () => { fbWrap.hidden = true; });
fbSend.addEventListener("click", async () => {
  const text = fbText.value.trim();
  if (!text) { fbStat.textContent = "type something first"; return; }
  fbSend.disabled = true; fbStat.textContent = "sending…";
  try {
    const r = await fetch("/api/feedback", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) }).then(r => r.json());
    if (r && r.ok) { fbStat.textContent = "thanks! 🙏"; fbText.value = ""; setTimeout(() => { fbWrap.hidden = true; }, 1100); }
    else fbStat.textContent = (r && r.error) || "couldn’t send — try again";
  } catch { fbStat.textContent = "couldn’t send — try again"; }
  fbSend.disabled = false;
});

// Drag a video file anywhere onto the page.
let dragDepth = 0; // enter/leave fire per-element; count so the cue doesn't flicker over children
document.addEventListener("dragenter", e => { e.preventDefault(); if (dragDepth++ === 0) document.body.classList.add("dragging"); });
document.addEventListener("dragover", e => e.preventDefault());
document.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove("dragging"); } });
document.addEventListener("drop", e => {
  e.preventDefault();
  dragDepth = 0; document.body.classList.remove("dragging");
  const f = (e as DragEvent).dataTransfer?.files[0];
  if (f) guardLoad(() => loadFile(f)); // dropping over a playing clip also asks first
});

// Warn before closing once something's actually playing — leaving loses the ascii video. Only armed
// while playing (no nag on the empty page). Browsers show their own generic text; the custom string is
// ignored by modern browsers, but setting returnValue is what triggers the confirm prompt.
window.addEventListener("beforeunload", e => {
  if (document.body.classList.contains("playing")) {
    e.preventDefault();
    e.returnValue = "are you sure you wanna close? you’ll lose your ascii video";
  }
});

document.addEventListener("keydown", e => {
  const tag = (e.target as HTMLElement).tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return; // don't hijack keys while typing
  // 'd' toggles debug: the fps profiler line AND the dashed outline showing the embed's capture frame.
  if (e.key === "d") { rt.DEBUG = !rt.DEBUG; fpsEl.style.display = rt.DEBUG ? "block" : "none"; document.body.classList.toggle("show-bounds", rt.DEBUG); return; }
  if (e.code === "Space" && video.src) { e.preventDefault(); video.paused ? video.play() : video.pause(); }
});

scheduleFrame(); // start the render loop (self-registers per video frame; idle until a clip plays)

// Preload a default clip on open so the landing is never blank. The youtube resolve is cached server-side
// (instant after the first visitor). playSrc tries WITH sound; if the browser blocks unmuted autoplay it
// falls back to muted and the first interaction anywhere brings sound in (see audio.js).
loadInput("https://www.youtube.com/shorts/f7SeGmBIVlE");
