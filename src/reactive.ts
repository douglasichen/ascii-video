// reactive.ts — music reactivity (the `react` toggle, off by default).
// Graph: <video> → MediaStreamAudioSource → AnalyserNode → destination (audio stays audible). Energy-based
// beat detection on the kick band (instantaneous energy vs an adaptive mean + k·std over ~1s, refractory
// gap); a beat kicks an envelope (env→1, exp decay) that pulses brightness/contrast + punches resolution
// and drifts the colour hue. All of it writes the DRIVEN state keys from `base` + audio, so it rides the
// existing paint()/span-merge model untouched. See experiments/music-reactive-notes.md. Idle unless react.
import { state, base, DRIVEN } from "./state.js";
import { video } from "./dom.js";
import { buildPalette, computeGrid } from "./render.js";
import { clamp, bandAvg, hslHex, hexHue, mixHex } from "./pure.js";

let audioCtx: AudioContext, analyser: AnalyserNode, freqData: Uint8Array, audioReady = false;
export function initAudio(): void {
  if (audioReady) return;
  try {
    audioCtx = new ((window as any).AudioContext || (window as any).webkitAudioContext)();
    // Feed the analyser from a CAPTURED stream, NOT createMediaElementSource(video). The element-source
    // node PERMANENTLY reroutes the <video>'s audio into the graph, which then makes the embed bake's
    // video.captureStream().getAudioTracks() come back silent/empty — so every embed baked after music
    // mode was ever on had no sound. A MediaStreamAudioSource taps a copy and leaves the element's own
    // audio path (speakers + captureStream) completely untouched.
    const src = audioCtx.createMediaStreamSource((video as any).captureStream());
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;                // 512 bins, ~43 Hz/bin at 44.1kHz
    analyser.smoothingTimeConstant = 0.55;  // some smoothing, but keep transients for beats
    src.connect(analyser);
    // Sink at gain 0: keeps the graph pulled (so getByteFrequencyData fills on every browser) WITHOUT
    // re-emitting the captured audio to the speakers — the element already plays it, so a full-gain
    // forward here would double/echo. (With the old element-source this had to be full gain; not anymore.)
    const sink = audioCtx.createGain(); sink.gain.value = 0;
    analyser.connect(sink); sink.connect(audioCtx.destination);
    freqData = new Uint8Array(analyser.frequencyBinCount);
    audioReady = true;
  } catch (e) { /* no captureStream / no audio track / cross-origin (tainted) video -> reactivity stays off */ }
}

interface Rx { hist: number[]; env: number; lastBeat: number; hue: number; bass: number; mid: number; treb: number; on: boolean; }
export const rx: Rx = { hist: [], env: 0, lastBeat: 0, hue: 210, bass: 0, mid: 0, treb: 0, on: false };
// The music-off invariant, in one place: restore every DRIVEN key to its resting `base` value and drop out
// of music mode. Called from applyReactivity's off-branch AND setControl's react-toggle-off (controls.ts).
export function restoreBase(): void { for (const k of DRIVEN) (state as any)[k] = base[k]; buildPalette(base.color); computeGrid(); rx.on = false; }
export function applyReactivity(now: number): void {
  if (state.react && !audioReady) initAudio();
  if (!state.react || !audioReady) {
    if (rx.on) restoreBase();
    return; // music off (or unavailable) → state stays exactly at the user's base values
  }
  if (audioCtx.state === "suspended") audioCtx.resume();
  if (!rx.on) { rx.hue = hexHue(base.color); rx.on = true; } // entering music mode: seed hue from base colour

  analyser.getByteFrequencyData(freqData);
  const kick = bandAvg(freqData, 1, 5); // ~43–215 Hz kick + sub-bass, the beat driver
  const bass = bandAvg(freqData, 1, 8), mid = bandAvg(freqData, 8, 50), treb = bandAvg(freqData, 50, 200);
  const sm = 0.25; // smooth the bands (steadies colour drift between beats)
  rx.bass += (bass - rx.bass) * sm; rx.mid += (mid - rx.mid) * sm; rx.treb += (treb - rx.treb) * sm;

  // adaptive beat threshold: kick must beat the recent mean by k·std (k shrinks as sensitivity rises)
  const h = rx.hist; h.push(kick); if (h.length > 43) h.shift();
  let m = 0; for (const v of h) m += v; m /= h.length;
  let vsum = 0; for (const v of h) vsum += (v - m) * (v - m); const sd = Math.sqrt(vsum / h.length);
  const kFac = 2.0 - (state.sensitivity / 100) * 1.4; // sens 0→k2.0 (strict) .. 1→k0.6 (loose)
  if (kick > m + kFac * sd && kick > 0.10 && now - rx.lastBeat > 200) {
    rx.lastBeat = now; rx.env = 1;
    rx.hue += 20 + rx.treb * 40; // each beat nudges the hue so colour keeps evolving
  }
  rx.env *= 0.86; // exponential envelope decay — the smooth pulse

  const punch = state.punch / 100, cor = state.contrastReact / 100, cr = state.colorReact / 100, rr = state.resReact / 100;
  rx.hue += 0.2 + rx.bass * 1.4 + rx.treb * 0.8; // continuous drift, faster on busier tracks

  // colour: blend the user's base colour toward the audio-driven hue by the colour-react amount
  if (cr > 0) {
    const light = clamp(46 + rx.env * 26 + rx.mid * 16, 22, 82);
    const sat = clamp(58 + rx.treb * 42, 40, 100);
    state.color = mixHex(base.color, hslHex(rx.hue, sat, light), cr);
  } else state.color = base.color;
  buildPalette(state.color);

  // brightness + contrast each pulse on the beat, independently scaled (fold into CONTRAST_LUT for free)
  state.brightness = clamp(base.brightness + (rx.env * 42 + rx.bass * 12 - 6) * punch, 0, 100);
  state.contrast = clamp(base.contrast + (rx.env * 30 + rx.treb * 22) * cor, 0, 100);
  // resolution "zoom-punch": a strong beat momentarily coarsens the grid, scaled by resolution-react.
  // Integer + regrid only on change, so the sample canvas isn't reallocated every frame.
  const d = Math.round(clamp(base.detail - rx.env * rr * 2.5, 1, 9));
  if (d !== state.detail) { state.detail = d; computeGrid(); }
}

// Audio fade in/out toward each loop's start/end (state.fade). Runs per rVFC so it tracks currentTime as
// the loop wraps. Fade window shrinks for very short clips so the in/out never overlap.
const FADE_SECONDS = 1.5;
export function updateFade(): void {
  if (!state.fade || !isFinite(video.duration) || video.duration <= 0) { video.volume = 1; return; }
  const d = video.duration, t = video.currentTime, f = Math.min(FADE_SECONDS, d / 3);
  let v = 1;
  if (t < f) v = t / f;
  else if (t > d - f) v = (d - t) / f;
  video.volume = v < 0 ? 0 : v > 1 ? 1 : v;
}
