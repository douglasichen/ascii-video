// audio.js — playback audio policy: autoplay with sound when the browser allows, a manual speaker toggle,
// and unmute-on-first-gesture. (Distinct from reactive.js, which taps the audio for the FFT beat detector.)
//
// Play WITH sound by default, never force-mute on our own. Reality check (verified 2026 against
// Chrome/Safari/Firefox autoplay docs): zero-gesture unmuted autoplay is NOT possible on a first visit —
// every browser blocks it without either a user gesture, an installed PWA, or (Chrome desktop only) a high
// Media Engagement Index from past visits. There is no honest hack; we don't pretend otherwise. So we
// ALWAYS try unmuted first. Returning/engaged visitors (MEI) get instant sound with zero clicks. Everyone
// else's unmuted play() is rejected -> we fall back to muted so the video still plays, show the "click for
// sound" cue, and unmute on the very first interaction anywhere. The only thing that keeps sound off is the
// user explicitly hitting the speaker button (userMuted). Nothing else ever mutes.
import { video, audioBtn, soundcue, IS_MOBILE } from "./dom.js";

let userMuted = false;  // the user's explicit choice via the speaker button — the ONLY thing that silences us
let activated = false;  // page has received a real user gesture (which lets the browser grant unmuted play)

export function syncAudio() {
  audioBtn.classList.toggle("muted", video.muted);
  // Cue shows only while we're silently muted awaiting a gesture — not when the user chose to mute.
  soundcue.style.display = (video.muted && !userMuted && document.body.classList.contains("playing")) ? "block" : "none";
}
// Set audio to the desired state (sound unless the user muted). If the browser refuses unmuted autoplay,
// downgrade to muted so playback still starts; a later gesture (or the 'playing' retry) brings sound in.
export function applyAudio() {
  video.muted = userMuted;
  syncAudio();
  video.play().catch(() => {
    if (!userMuted) { video.muted = true; syncAudio(); video.play().catch(() => {}); } // unmuted blocked -> muted fallback
  });
}

// First real interaction anywhere unmutes (a gesture is what the autoplay policy accepts). Widest set of
// user-activation events, capture phase so nothing can swallow it, first one wins then all are removed.
// The speaker button manages its own mute, so ignore gestures on it here.
const GESTURE_EVENTS = ["pointerdown", "pointerup", "click", "keydown", "touchstart", "touchend"];
function onFirstGesture(e) {
  if (e && e.target && e.target.closest && e.target.closest("#audio")) return;
  activated = true;
  GESTURE_EVENTS.forEach(ev => document.removeEventListener(ev, onFirstGesture, true));
  if (!userMuted && video.muted) applyAudio(); // unmute now; if the clip isn't loaded yet, 'playing' retries
}

export function bindAudio() {
  // iOS SUSPENDS a display:none / opacity:0 <video> after a few seconds (the "plays then freezes", which
  // also kills its audio). The is-mobile class makes it full-frame + actually rendered (opacity 1) but
  // hidden behind an opaque cover, which iOS treats as visible so it keeps decoding. Also opt into the
  // "playback" audio session so sound ignores the hardware silent switch (iOS 16.4+). Desktop: none of this.
  if (IS_MOBILE) {
    document.body.classList.add("is-mobile");
    try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch { /* older iOS */ }
  }
  // Speaker button = manual override, both directions. Records the explicit choice so new loads respect it.
  audioBtn.addEventListener("click", () => {
    video.muted = !video.muted; userMuted = video.muted;
    if (!video.muted) video.play().catch(() => {});
    syncAudio();
  });
  GESTURE_EVENTS.forEach(ev => document.addEventListener(ev, onFirstGesture, true));
  // Reveal the ASCII (handled by the render loop); here just settle audio once frames start.
  video.addEventListener("playing", () => {
    // If the user already gestured while this clip was still resolving, its unmute never took (no src yet).
    // Now that it's actually playing, retry — activation is in hand, so the unmuted play() will be granted.
    if (activated && !userMuted && video.muted) applyAudio();
    syncAudio(); // reflect muted state now; the reveal waits for the first ascii paint
  });
  // Live mobile debug readout (add ?debug=1) so device-only issues can be reported precisely.
  if (new URLSearchParams(location.search).has("debug")) {
    const el = document.getElementById("mdbg"); el.style.display = "block";
    setInterval(() => { el.textContent =
      `mob=${IS_MOBILE} muted=${video.muted} paused=${video.paused} t=${(video.currentTime || 0).toFixed(1)} rs=${video.readyState} playing=${document.body.classList.contains("playing")}`; }, 300);
  }
}
