// embed-page.ts — the embed player (embed.html). Fetches a baked .asciiv from S3 by ?id=, decodes it with
// the shared codec (src/codec.ts), and plays the ascii back against the embedded audio track. Kept a
// separate entry from the main player: it's a tiny read-only viewer. See CLAUDE.md "Baked embeds".
import { buildRows, buildPaletteCSS, decodeAsciiv, frameAt } from "./codec.js";

// Public S3 base for baked clips (bucket name is not secret). id = <timestamp>-<uuid>.asciiv
const S3_BASE = "https://ascii-video-clips-992382605182.s3.us-east-1.amazonaws.com/";
const screen = document.getElementById("screen") as HTMLPreElement;
const loadEl = document.getElementById("load") as HTMLElement;
const errEl = document.getElementById("err") as HTMLElement;
const tap = document.getElementById("tap") as HTMLElement;
const audioEl = document.getElementById("audio") as HTMLAudioElement;
let frames: Uint8Array[] = [], cols = 0, rows = 0, fps = 30, shading = true, raf = 0, fadeOn = false, times: number[] | null = null;
// Authoritative loop period (seconds) from the header. Used to map the clock -> frame index instead of
// t*fps: fps is round(frameCount/dur) (an average over an UNEVEN, maxfps-throttled capture), so t*fps
// drifts from the real loop length and the ascii wraps a hair before/after the audio -> a visible jump
// every loop. Mapping the phase across [0,clipDur) makes frames and audio wrap together. Also survives
// MediaRecorder webm blobs whose audioEl.duration reports Infinity.
let clipDur = 10;

// Real monospace glyph advance (as a fraction of font-size), measured once from the actual rendered font
// so the grid fills to the constraining edge exactly rather than assuming a magic 0.6 that varies by font.
let charAspect = 0.6;
function measureCharAspect() {
  const probe = document.createElement("span");
  probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;font-family:var(--mono);font-size:100px;line-height:1;";
  probe.textContent = "0".repeat(100);
  document.body.appendChild(probe);
  const w = probe.getBoundingClientRect().width;
  document.body.removeChild(probe);
  if (w > 0) charAspect = w / 100 / 100; // width per char / font-size
}

function fit() { // scale the font so the fixed grid fills the frame, keeping aspect (letterboxed, never stretched)
  if (!cols || !rows) return;
  const f = Math.min(window.innerWidth / (cols * charAspect), window.innerHeight / rows);
  screen.style.fontSize = Math.max(1, f) + "px"; // fractional -> fills to the edge, no rounding margin
}
window.addEventListener("resize", fit);

function draw(i: number) {
  const g = frames[((i % frames.length) + frames.length) % frames.length];
  if (shading) screen.innerHTML = buildRows(g, cols, rows, true);
  else screen.textContent = buildRows(g, cols, rows, false);
}
// Frame index follows the audio clock ONLY when audio is genuinely advancing (playing AND currentTime moving);
// otherwise a wall-clock timer drives it. This keeps the ascii animating no matter what audio does — blocked,
// buffering, muted, missing or stalled — instead of freezing on frame 0 (which happens if you trust !paused
// alone: play() flips paused=false synchronously, long before any audio data has actually started).
let clockBase = performance.now();
function loop() {
  // audio clock when it's actually playing past 0 (A/V sync); wall clock otherwise (blocked/buffering/muted/none)
  const at = audioEl.currentTime;
  const audioLive = !!audioEl.src && !audioEl.paused && at > 0;
  // Loop period: when the audio reports a finite duration, IT is the master (frames must wrap exactly when
  // the audio wraps, else they drift a little each loop). Otherwise fall back to the baked clipDur.
  const audioFinite = isFinite(audioEl.duration) && audioEl.duration > 0;
  const period = audioLive && audioFinite ? audioEl.duration : clipDur;
  // Force-loop the audio on period when its own duration is unusable (MediaRecorder webm often reports
  // Infinity, so <audio loop> never wraps it) — otherwise the sound plays through once then goes silent
  // while the ascii keeps looping. When duration IS finite we leave native loop=true to wrap it.
  if (audioLive && !audioFinite && at >= period) audioEl.currentTime = 0;
  const t = audioLive ? audioEl.currentTime : (performance.now() - clockBase) / 1000;
  if (fadeOn && audioLive) {
    const f = Math.min(1.5, period / 3); // fade window (shrinks for short clips)
    const a = at % period;
    let v = 1; if (a < f) v = a / f; else if (a > period - f) v = (period - a) / f;
    audioEl.volume = v < 0 ? 0 : v > 1 ? 1 : v;
  }
  // Clock -> frame index. With per-frame times (new files) map by REAL capture cadence so the animation
  // tracks the audio through the uneven capture; otherwise the even-phase mapping (old files). Both wrap in
  // lockstep with `period`; draw() re-mods defensively.
  draw(times ? frameAt(times, period * 1000, t * 1000) : Math.floor((t % period) / period * frames.length));
  raf = requestAnimationFrame(loop);
}

// One-tap / first-interaction sound enable. Only wired up when unmuted autoplay was refused.
function enableSound() {
  audioEl.muted = false;
  audioEl.play().catch(() => {});
  tap.hidden = true;
  document.removeEventListener("pointerdown", enableSound);
  document.removeEventListener("keydown", enableSound);
}
function offerSound() {
  tap.hidden = false;
  tap.onclick = enableSound;
  // also unmute on ANY first interaction anywhere in the frame, so the common case feels like "it just plays"
  document.addEventListener("pointerdown", enableSound, { once: true });
  document.addEventListener("keydown", enableSound, { once: true });
}

// Sound control. FORCE_MUTE (?muted=1) keeps it silent with no tap pill (used by the landing demo).
// setMuted is the single flip point and notifies the embedding page so it can sync its own button UI.
const FORCE_MUTE = new URLSearchParams(location.search).has("muted");
function setMuted(m: boolean) {
  audioEl.muted = m;
  if (!m) audioEl.play().catch(() => {});
  try { parent.postMessage({ type: "asciify:muted", muted: audioEl.muted }, "*"); } catch {}
}
// Embedders can wire their OWN mute button/event via postMessage to the iframe:
//   iframe.contentWindow.postMessage("asciify:toggle", "*")   // also "asciify:mute" / "asciify:unmute"
// and listen for { type:"asciify:muted", muted } messages back to keep their button in sync.
window.addEventListener("message", (e) => {
  const cmd = typeof e.data === "string" ? e.data : (e.data && e.data.type);
  if (cmd === "asciify:mute") setMuted(true);
  else if (cmd === "asciify:unmute") setMuted(false);
  else if (cmd === "asciify:toggle") setMuted(!audioEl.muted);
});
function startAudio() {
  audioEl.loop = true;
  if (FORCE_MUTE) { setMuted(true); return; } // ?muted=1 → stay muted, no tap pill (landing demo / silent embeds)
  // 1) try unmuted straight away. 2) if the host blocks it, fall back to MUTED autoplay so the clip is at
  // least alive and A/V-synced, and surface a tasteful tap to bring sound in (also unmutes on any click/key).
  audioEl.muted = false;
  audioEl.play().catch(() => {
    audioEl.muted = true;
    audioEl.play().catch(() => {}); // muted autoplay is almost always allowed; ignore if even that's refused
    offerSound();
  });
}

async function load() {
  const id = new URLSearchParams(location.search).get("id");
  if (!id) return showError();
  let dec;
  try {
    const r = await fetch(S3_BASE + id);
    if (r.status === 404 || r.status === 403) return comingSoon(); // not baked yet -> placeholder, keep polling
    if (!r.ok) throw 0;
    dec = await decodeAsciiv(new Uint8Array(await r.arrayBuffer()));
  } catch { return showError(); }

  const h = dec.header;
  frames = dec.frames; cols = h.cols; rows = h.rows; fps = h.fps; shading = h.shading; fadeOn = !!h.fade;
  // Per-frame capture times (v:1 files after the sync fix). Absent on older files -> times stays null and
  // loop() falls back to the even-phase mapping. Guard the length in case a header slips through mismatched.
  times = Array.isArray(h.times) && h.times.length === frames.length ? h.times : null;
  // Loop period: header durationMs is authoritative; fall back to frameCount/fps if it's missing/bogus.
  clipDur = ((h.durationMs ?? 0) > 0 ? (h.durationMs as number) / 1000 : 0) || (frames.length / fps) || 10;
  document.head.appendChild(document.createElement("style")).textContent = buildPaletteCSS(h.colour);
  screen.style.color = h.colour;
  loadEl.style.display = "none";
  measureCharAspect();
  fit();
  if (dec.audio) {
    audioEl.src = URL.createObjectURL(new Blob([dec.audio], { type: h.audioMime || "audio/webm" }));
    startAudio();
  }
  clockBase = performance.now();
  loop();
}

function showError() {
  loadEl.style.display = "none";
  errEl.style.display = "flex";
}
// The snippet is handed out the instant "save" is clicked — before the background bake finishes uploading.
// Until the clip lands, show a friendly placeholder and re-check every few seconds so it appears on its own.
function comingSoon() {
  loadEl.style.display = "";
  errEl.style.display = "none";
  const cap = loadEl.querySelector(".cap");
  if (cap) cap.textContent = "ascii video will be here soon!";
  setTimeout(load, 5000);
}
load();
