// sources.ts — getting a video onto the screen. Three ways in, all landing on playSrc():
//  • a video FILE (drop / upload) -> a same-origin blob URL. Always samples cleanly, no CORS/IP issues.
//  • a direct VIDEO URL -> used as-is (needs CORS on that host for getImageData; crossorigin is set).
//  • a YOUTUBE link -> /api/resolve turns it into a stream URL. Best-effort: from a cloud host YouTube
//    often bot-blocks the resolver, so file/direct-url are the reliable paths (see CLAUDE.md Deployment).
// Also owns the load-in-flight concurrency guard (computing) and the loader overlay.
import { video, screen, status, urlInput, loadBtn, loaderMsg, loaderSub, IS_MOBILE } from "./dom.js";
import { rt } from "./state.js";
import { computeGrid } from "./render.js";
import { applyAudio } from "./audio.js";
import { normalizeYouTube, makeObjectUrlSlot } from "./pure.js";

// True while a video/link is resolving or loading. The submit CTAs (load button + url field) are disabled
// for the duration so a second submit can't race the first (avoids swapping the source mid-load).
export function setComputing(on: boolean): void {
  rt.computing = on;
  urlInput.disabled = on;
  refreshLoadBtn();
}
// Load is disabled while a load is in flight OR when the url field is empty (nothing to submit).
export function refreshLoadBtn(): void {
  loadBtn.disabled = rt.computing || !urlInput.value.trim();
}

const MAX_SECONDS = 300; // deny anything longer than 5 minutes (both youtube + dropped files)

// A dropped file plays via a blob: object URL, which pins the WHOLE file (≤50MB) in memory until revoked.
// The slot holds at most one and frees it whenever we move to a new source (another file, a link, or the
// >5min reject), so reloads can't leak. (Logic lives in pure.ts, node-tested.)
const urlSlot = makeObjectUrlSlot();

export function playSrc(src: string): void {
  rt.firstPaintPending = true; // hold the reveal + CTA block until the first ascii frame actually paints
  video.onloadedmetadata = () => {
    if (isFinite(video.duration) && video.duration > MAX_SECONDS) {
      video.pause(); video.removeAttribute("src"); video.load(); // stop + release the source
      urlSlot.free(); // and free its blob — we're discarding this source
      document.body.classList.remove("playing");
      return showError("sorry — we only support videos under 5 minutes");
    }
    computeGrid();
  };
  video.src = src;
  // Try WITH sound (unless the user explicitly muted). applyAudio falls back to muted if the browser blocks
  // unmuted autoplay — and because it keys off userMuted (not a per-load flag), an already-unmuted session
  // stays unmuted across new drops/links; only the speaker button ever mutes.
  applyAudio();
}

// Show an error centrally and drop out of any loading state so the empty stage returns for a retry.
export function showError(msg: string): void { rt.firstPaintPending = false; setComputing(false); stopLoader(); status.textContent = msg; }

const MAX_BYTES = 50 * 1024 * 1024; // 50 MB cap on dropped files
export function loadFile(file: File): void {
  if (rt.computing || !file) return; // ignore a drop while another load is in flight
  // We claim mp4-only. Reject anything else up front (covers both the upload button and drag-drop,
  // since both route through here) rather than half-playing a format we don't promise to support.
  const isMp4 = file.type === "video/mp4" || /\.mp4$/i.test(file.name);
  if (!isMp4) return showError("sorry — we only accept mp4 files");
  if (file.size > MAX_BYTES) return showError("sorry — mp4 must be under 50MB");
  rt.currentFile = file; rt.currentSourceId = "";
  setComputing(true); startLoader(false);
  playSrc(urlSlot.set(file)); // set() frees the previous file's blob, then mints + tracks this one
}

// The loader visual is a pure-CSS mosaic (no render-loop cost). It covers two waits: a youtube resolve
// (~1 min — a single "downloading video…" label + the "~a minute" note) and a dropped-file decode
// (near-instant — "rendering ascii…", note hidden). Pass isYouTube to pick which.
export function startLoader(isYouTube: boolean): void {
  status.textContent = ""; // clear any prior error
  document.body.classList.remove("playing"); // bring the loading screen back, even over a clip that's playing
  screen.textContent = "";                    // clear the current ascii so only the loader shows
  video.pause();                              // stop the current clip while the new one loads
  document.body.classList.add("loading");
  loaderSub.style.display = isYouTube ? "block" : "none";
  loaderMsg.textContent = isYouTube ? "downloading video…" : "rendering ascii…"; // static, no cycling
}
export function stopLoader(): void {
  document.body.classList.remove("loading");
}

export async function loadYouTube(url: string): Promise<void> {
  url = normalizeYouTube(url);
  rt.currentFile = null;
  rt.currentSourceId = (url.match(/[?&]v=([A-Za-z0-9_-]{11})/) || [, ""])[1] || url;
  urlSlot.free(); // switching away from any dropped file — free its blob
  setComputing(true); startLoader(true);
  const fail = (m?: string) => showError("couldn’t load — " + (m || "try another link or upload an mp4"));

  let job: any;
  try {
    job = await fetch("/api/resolve?url=" + encodeURIComponent(url)).then((r) => r.json());
  } catch (err) { return fail((err as Error).message); }
  if (job.streamUrl) { stopLoader(); status.textContent = ""; return playSrc(job.streamUrl); } // cache hit -> instant
  if (!job.runId) return fail(job.error || "");

  const deadline = Date.now() + 240000; // give up after 4 min
  const poll = async (): Promise<void> => {
    if (Date.now() > deadline) return fail("this took too long — try again or upload an mp4");
    let s: any;
    try {
      s = await fetch("/api/resolve?runId=" + encodeURIComponent(job.runId) +
                      "&datasetId=" + encodeURIComponent(job.datasetId) +
                      "&videoId=" + encodeURIComponent(job.videoId || "")).then((r) => r.json());
    } catch { return void setTimeout(poll, 3000); } // transient network blip — keep polling
    if (s.streamUrl) { stopLoader(); status.textContent = ""; return playSrc(s.streamUrl); }
    if (["FAILED", "ABORTED", "TIMED-OUT"].includes(s.status)) return fail(s.error || s.status);
    setTimeout(poll, 3000); // READY / RUNNING — keep waiting
  };
  poll();
}

export function loadInput(text: string): void {
  if (rt.computing) return;
  const s = (text || "").trim();
  if (!s) return;
  if (/youtu\.?be/i.test(s)) { loadYouTube(s); return; } // youtube.com / youtu.be
  rt.currentFile = null; rt.currentSourceId = s;
  urlSlot.free(); // switching to a direct URL — free any dropped-file blob
  setComputing(true); startLoader(false);
  playSrc(s); // treat anything else as a direct video URL
}

export function bindSources(): void {
  // A source can be rejected (expired / IP-locked / no CORS). Surface it instead of a black screen.
  video.addEventListener("error", () => { if (video.src) showError("this wouldn’t play — try a file or another link"); });
  if (IS_MOBILE) {
    // Resume if the mobile browser suspends/stalls the stream. Guarded so it never fights the >5min reject
    // (which pauses a too-long video) or an in-progress bake. There's no keyboard pause on mobile.
    const resume = () => { if (video.src && isFinite(video.duration) && video.duration <= MAX_SECONDS && !video.ended && !rt.baking && !rt.computing) video.play().catch(() => {}); };
    ["pause", "waiting", "stalled"].forEach(ev => video.addEventListener(ev, resume));
  }
}
