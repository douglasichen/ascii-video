// embed.js — the "save" CTA: bake the currently-playing clip into a self-contained .asciiv on S3 and hand
// back an <iframe> snippet. Key idea: the S3 key is a CONTENT HASH known BEFORE baking (source + exact
// render settings, see pure.embedSig), so we can show the snippet instantly and bake in the background, and
// an identical source+look is never re-baked (cache/dedup). Uses the shared codec at window.ASCIIV
// (asciiv-codec.js, loaded as a classic script before this module). See CLAUDE.md "Baked embeds".
import { embedBtn, embedWrap, embedCode, video } from "./dom.js";
import { state, rt } from "./state.js";
import { embedSig } from "./pure.js";

const fmt = s => { s = Math.max(0, Math.round(s)); return (s / 60 | 0) + ":" + String(s % 60).padStart(2, "0"); };

// The background bake/upload is a backend detail — deliberately NOT surfaced in the modal. The snippet is
// handed over immediately; if a viewer loads the embed before it finishes, embed.html shows its own
// "ascii video will be here soon!" placeholder. So this is a no-op (calls left in place, intentionally silent).
function setEmbedStat() {}

async function sha256hex(bytes) {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// Deterministic embed identity = source content (a file's bytes, or the youtube id / direct url) + the
// EXACT render settings (pure.embedSig). This is the whole trick behind both the instant snippet and
// caching: the key is known BEFORE baking (baking is a full real-time loop, unavoidably slow), so we can
// show the snippet now and bake in the background; and an identical source+look hashes to the same key, so
// it's never re-baked.
async function embedHash() {
  const sig = embedSig(rt.currentSourceId, state, rt.cols, rt.rows);
  const src = rt.currentFile
    ? (await sha256hex(new Uint8Array(await rt.currentFile.arrayBuffer()))) + sig
    : sig;
  return sha256hex(new TextEncoder().encode(src));
}

// Click -> compute the key -> show the snippet IMMEDIATELY (the link 404s until the bake lands; the embed
// page shows "ascii video will be here soon!" and polls). Then: if the server already has this key we're
// done (cached); otherwise bake + upload in the background so the button never blocks on the ~real-time loop.
async function startBake() {
  if (!video.videoWidth || rt.baking) return;
  embedBtn.disabled = true;
  try {
    const hash = await embedHash();
    showSnippet(hash + ".asciiv"); // instant
    setEmbedStat("preparing…"); // clear any stale status from a previous save
    let save;
    try {
      save = await fetch("/api/save", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hash }) }).then(r => r.json());
    } catch { save = null; }
    if (save && save.cached) return setEmbedStat("✓ already generated — your embed is live now");
    if (!save || !save.upload) return setEmbedStat("couldn’t reach the embed service — the snippet still works once it’s generated");
    await bakeInBackground(save.upload);
  } finally {
    embedBtn.disabled = false; // label stays "save" (static icon+text); progress shows in the modal
  }
}

// Records exactly one loop from wherever the video is now (it keeps looping, so audio + frames wrap
// seamlessly), encodes to .asciiv, and uploads to the presigned key. Runs while the snippet is already
// shown, so its real-time cost is off the click path.
async function bakeInBackground(upload) {
  rt.baking = true;
  document.body.classList.add("baking"); // opaque cover over the live player while we seek+scrub it to capture
  const dur = isFinite(video.duration) && video.duration > 0 ? video.duration : 10;
  setEmbedStat(`generating… your embed goes live in about ${fmt(dur)}`);
  let mr = null; const audioChunks = [];
  try {
    const stream = video.captureStream ? video.captureStream() : null;
    const at = stream ? stream.getAudioTracks() : [];
    if (window.MediaRecorder && at.length) {
      mr = new MediaRecorder(new MediaStream(at));
      mr.ondataavailable = e => { if (e.data && e.data.size) audioChunks.push(e.data); };
    }
  } catch { /* captureStream/MediaRecorder unsupported -> silent embed */ }
  rt.recFrames = []; rt.recTimes = []; rt.recPausedMs = 0;
  // Capture is driven by requestVideoFrameCallback, which STOPS firing while the tab is hidden. Without this
  // guard, switching tabs mid-bake captures no frames for that span while the wall clock + audio recorder run
  // on — baking a multi-second FROZEN hold into `times` (that's the "freezes sometimes" bug). So while hidden,
  // pause the video + audio recorder and freeze the elapsed/timestamp clock: the bake only accumulates
  // continuous FOREGROUND time, keeping frames and audio in lockstep no matter how the user tab-switches.
  let hiddenSince = 0;
  const onVis = () => {
    if (document.hidden) {
      if (!hiddenSince) { hiddenSince = performance.now(); video.pause(); if (mr && mr.state === "recording") mr.pause(); }
    } else if (hiddenSince) {
      rt.recPausedMs += performance.now() - hiddenSince; hiddenSince = 0;
      if (mr && mr.state === "paused") mr.resume();
      video.play().catch(() => {});
    }
  };
  document.addEventListener("visibilitychange", onVis);
  try {
    if (video.paused) await video.play();
    // Seek to content t=0 BEFORE audio + frame capture start, so the embed's frame 0 is the real start of
    // the clip. Without this the bake records "from wherever the video is now" (playhead C): frame 0 =
    // mid-clip, the true beginning lands at the tail of the loop, and a viewer entering the iframe starts
    // partway through — the "beginning missing" bug. Both the audio recorder (captureStream) and frames must
    // begin here and stay in lockstep, so we seek+settle before mr.start()/recStart. Await `seeked` (not just
    // set currentTime) so the first captured frames are real start-of-clip, not stale/blank mid-seek. Timeout
    // fallback so a browser that never fires `seeked` can't hang the bake. Skip when already at/near 0 or the
    // duration isn't seekable (live stream). The live player just continues from 0 afterward — it's looping.
    if (isFinite(video.duration) && video.currentTime > 0.05) {
      await new Promise(res => {
        let done = false;
        const finish = () => { if (done) return; done = true; video.removeEventListener("seeked", finish); res(); };
        video.addEventListener("seeked", finish);
        video.currentTime = 0;
        setTimeout(finish, 500);
      });
    }
    if (mr) mr.start();
    // recStart is the origin frame timestamps are measured from — set it right at mr.start()/recording so it
    // matches the audio recording's own t=0. Playback maps audioEl.currentTime through these times.
    rt.recStart = performance.now();
    // If the tab is ALREADY hidden the instant recording starts (e.g. switched away during the /api/save
    // fetch, before onVis was even attached — no transition fires), seed the hidden state by hand so that
    // opening span is still excluded and rVFC-starved frames don't bake a gap.
    if (document.hidden) { hiddenSince = rt.recStart; if (mr && mr.state === "recording") mr.pause(); }
    rt.recording = true;
    await new Promise(res => {
      const t0 = performance.now();
      const iv = setInterval(() => {
        const el = (performance.now() - t0 - rt.recPausedMs - (hiddenSince ? performance.now() - hiddenSince : 0)) / 1000;
        setEmbedStat(`generating… ${fmt(el)} / ${fmt(dur)}`);
        if (el >= dur) { clearInterval(iv); res(); }
      }, 200);
    });
    rt.recording = false;
    let audioBlob = null;
    if (mr) audioBlob = await new Promise(res => { mr.onstop = () => res(new Blob(audioChunks, { type: mr.mimeType || "audio/webm" })); mr.stop(); });
    if (!rt.recFrames.length) throw new Error("no frames captured");
    setEmbedStat("encoding…");
    const audio = audioBlob ? new Uint8Array(await audioBlob.arrayBuffer()) : null;
    const fps = Math.max(1, Math.round(rt.recFrames.length / dur));
    // times[] = each frame's real capture instant (ms from recStart); durationMs = the FULL recording span
    // (the loop period), so the last frame holds until the loop wraps in lockstep with the ~dur-long audio.
    const times = rt.recTimes.map(t => Math.round(t));
    const header = { fps, cols: rt.cols, rows: rt.rows, colour: state.color, shading: state.shading, fade: state.fade,
                     durationMs: Math.round(dur * 1000), times, audioMime: audioBlob ? (audioBlob.type || "audio/webm") : "" };
    const bytes = await window.ASCIIV.encodeAsciiv(header, rt.recFrames, audio);
    rt.recFrames = []; rt.recTimes = []; // free memory early
    setEmbedStat("uploading…");
    const fd = new FormData(); // presigned POST: fields first, file LAST (S3 requires this order)
    Object.entries(upload.fields).forEach(([k, v]) => fd.append(k, v));
    fd.append("file", new Blob([bytes], { type: "application/octet-stream" }));
    const up = await fetch(upload.url, { method: "POST", body: fd });
    if (!up.ok) throw new Error("upload failed (" + up.status + ")");
    setEmbedStat("✓ your embed is live");
  } catch (e) {
    setEmbedStat("couldn’t finish generating — " + (e.message || "try again"));
  } finally {
    document.removeEventListener("visibilitychange", onVis);
    document.body.classList.remove("baking");
    if (hiddenSince && mr && mr.state === "paused") mr.resume(); // don't leave the recorder wedged if we bailed while hidden
    rt.recording = false; rt.baking = false;
  }
}

function showSnippet(key) {
  const src = location.origin + "/embed.html?id=" + encodeURIComponent(key);
  embedCode.value = `<iframe src="${src}" width="640" height="360" allow="autoplay" style="border:0"></iframe>`;
  embedWrap.hidden = false;
  embedCode.focus(); embedCode.select();
}

export function bindEmbed() {
  embedBtn.addEventListener("click", startBake);
  document.getElementById("embedcopy").addEventListener("click", () => {
    embedCode.select();
    if (navigator.clipboard) navigator.clipboard.writeText(embedCode.value);
    const b = document.getElementById("embedcopy"); b.textContent = "copied"; setTimeout(() => (b.textContent = "copy"), 1200);
  });
  // Close returns you to the player. Also drop the baking cover: it only exists to hide the seek/scrub behind
  // the snippet card, so once the card is dismissed there's nothing to cover — the bake finishes in the
  // background (the "playing" event / finally still fire). Without this you'd close the card onto the opaque
  // "generating your embed…" screen instead of your clip.
  document.getElementById("embedclose").addEventListener("click", () => {
    embedWrap.hidden = true;
    document.body.classList.remove("baking");
  });
}
