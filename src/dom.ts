// dom.ts — cached element references + environment flags. Imported wherever an element is touched.
// Module scripts are deferred, so the DOM is fully parsed by the time this evaluates.
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

export const video = $<HTMLVideoElement>("video");
export const screen = $<HTMLPreElement>("screen");
export const canvas = $<HTMLCanvasElement>("sample"); // the ONLY canvas — offscreen, sampled for getImageData, never displayed
export const ctx = canvas.getContext("2d", { willReadFrequently: true })!; // CPU-backed: avoids GPU-readback stalls
export const bar = $("bar");
export const fpsEl = $("fps");
export const status = $("status");
export const audioBtn = $("audio");
export const soundcue = $("soundcue");
export const configEl = $("config");
export const urlInput = $<HTMLInputElement>("url");
export const loadBtn = $<HTMLButtonElement>("load");
export const confirmWrap = $("confirmwrap");
export const embedBtn = $<HTMLButtonElement>("embed");
export const embedWrap = $("embedwrap");
export const embedCode = $<HTMLTextAreaElement>("embedcode");
export const loaderEl = $("loader");
export const loaderMsg = loaderEl.querySelector(".msg") as HTMLElement;
export const loaderSub = loaderEl.querySelector(".sub") as HTMLElement;
export const fbWrap = $("fbwrap");
export const fbText = $<HTMLTextAreaElement>("fbtext");
export const fbStat = $("fbstat");
export const fbSend = $<HTMLButtonElement>("fbsend");
export const cfgToggle = $("cfgtoggle");

// Everything gated on IS_MOBILE is mobile-only — desktop behaviour is untouched. Detect touch devices
// broadly (some phones don't report pointer:coarse); ?mobile=1 forces it for testing.
export const IS_MOBILE = matchMedia("(pointer: coarse)").matches || navigator.maxTouchPoints > 0
  || new URLSearchParams(location.search).has("mobile");
