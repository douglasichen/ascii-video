// dom.js — cached element references + environment flags. Imported wherever an element is touched.
// Module scripts are deferred, so the DOM is fully parsed by the time this evaluates.
const $ = (id) => document.getElementById(id);

export const video = $("video");
export const screen = $("screen");
export const canvas = $("sample"); // the ONLY canvas — offscreen, sampled for getImageData, never displayed
export const ctx = canvas.getContext("2d", { willReadFrequently: true }); // CPU-backed: avoids GPU-readback stalls
export const bar = $("bar");
export const fpsEl = $("fps");
export const status = $("status");
export const audioBtn = $("audio");
export const soundcue = $("soundcue");
export const configEl = $("config");
export const urlInput = $("url");
export const loadBtn = $("load");
export const confirmWrap = $("confirmwrap");
export const embedBtn = $("embed");
export const embedWrap = $("embedwrap");
export const embedCode = $("embedcode");
export const loaderEl = $("loader");
export const loaderMsg = loaderEl.querySelector(".msg");
export const loaderSub = loaderEl.querySelector(".sub");
export const fbWrap = $("fbwrap");
export const fbText = $("fbtext");
export const fbStat = $("fbstat");
export const fbSend = $("fbsend");
export const cfgToggle = $("cfgtoggle");

// Everything gated on IS_MOBILE is mobile-only — desktop behaviour is untouched. Detect touch devices
// broadly (some phones don't report pointer:coarse); ?mobile=1 forces it for testing.
export const IS_MOBILE = matchMedia("(pointer: coarse)").matches || navigator.maxTouchPoints > 0
  || new URLSearchParams(location.search).has("mobile");
