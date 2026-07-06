"use strict";
// Candidate BUILD variants, measured against baseline by render-bench.js.
// All must stay byte-identical to baseline (pure speed). The bench asserts it.
const { RAMP, RAMP_LAST, RAMP_SCALE, QUANT_LEVEL, LEVEL_CLASS } = require("./render-bench.js");

// V1: accumulate a run's chars into one string, push the whole <i>…</i> at run close.
// Cuts per-char array.push (cells) down to per-run pushes.
function runAccum(data, cols, rows, clut, shade) {
  const parts = [];
  let runs = 0;
  for (let r = 0; r < rows; r++) {
    let base = r * cols * 4;
    if (shade) {
      let runLv = -1, runChars = "";
      for (let c = 0; c < cols; c++, base += 4) {
        const gray = clut[data[base]] * 0.299 + clut[data[base + 1]] * 0.587 + clut[data[base + 2]] * 0.114;
        const lv = QUANT_LEVEL[gray | 0];
        if (lv !== runLv) {
          if (runLv !== -1) parts.push("<i class=", LEVEL_CLASS[runLv], ">", runChars, "</i>");
          runChars = "";
          runLv = lv; runs++;
        }
        const ci = gray * RAMP_SCALE < RAMP_LAST ? (gray * RAMP_SCALE) | 0 : RAMP_LAST;
        runChars += RAMP[ci];
      }
      parts.push("<i class=", LEVEL_CLASS[runLv], ">", runChars, "</i>");
    } else {
      let rowChars = "";
      for (let c = 0; c < cols; c++, base += 4) {
        const gray = clut[data[base]] * 0.299 + clut[data[base + 1]] * 0.587 + clut[data[base + 2]] * 0.114;
        const ci = gray * RAMP_SCALE < RAMP_LAST ? (gray * RAMP_SCALE) | 0 : RAMP_LAST;
        rowChars += RAMP[ci];
      }
      parts.push(rowChars);
    }
    if (r < rows - 1) parts.push("\n");
  }
  return { html: parts.join(""), runs };
}

// V2: build each ROW as one string (tags inline via +=), push per row, join("").
function rowString(data, cols, rows, clut, shade) {
  const parts = [];
  let runs = 0;
  for (let r = 0; r < rows; r++) {
    let base = r * cols * 4;
    let row = "";
    let runLv = -1;
    for (let c = 0; c < cols; c++, base += 4) {
      const gray = clut[data[base]] * 0.299 + clut[data[base + 1]] * 0.587 + clut[data[base + 2]] * 0.114;
      if (shade) {
        const lv = QUANT_LEVEL[gray | 0];
        if (lv !== runLv) {
          if (runLv !== -1) row += "</i>";
          row += "<i class=" + LEVEL_CLASS[lv] + ">";
          runLv = lv; runs++;
        }
      }
      const ci = gray * RAMP_SCALE < RAMP_LAST ? (gray * RAMP_SCALE) | 0 : RAMP_LAST;
      row += RAMP[ci];
    }
    if (shade) row += "</i>";
    parts.push(row);
    if (r < rows - 1) parts.push("\n");
  }
  return { html: parts.join(""), runs };
}

// V3: V2 but accumulate the whole document in one string (no array, no join).
function oneString(data, cols, rows, clut, shade) {
  let out = "";
  let runs = 0;
  for (let r = 0; r < rows; r++) {
    let base = r * cols * 4;
    let runLv = -1;
    for (let c = 0; c < cols; c++, base += 4) {
      const gray = clut[data[base]] * 0.299 + clut[data[base + 1]] * 0.587 + clut[data[base + 2]] * 0.114;
      if (shade) {
        const lv = QUANT_LEVEL[gray | 0];
        if (lv !== runLv) {
          if (runLv !== -1) out += "</i>";
          out += "<i class=" + LEVEL_CLASS[lv] + ">";
          runLv = lv; runs++;
        }
      }
      const ci = gray * RAMP_SCALE < RAMP_LAST ? (gray * RAMP_SCALE) | 0 : RAMP_LAST;
      out += RAMP[ci];
    }
    if (shade) out += "</i>";
    if (r < rows - 1) out += "\n";
  }
  return { html: out, runs };
}

// V4: runAccum, but the whole run open-tag is one interned string per level.
// "<i class=a>" etc. precomputed so a run open is a single concat, not three.
const OPEN = LEVEL_CLASS.map(cl => "<i class=" + cl + ">");
function runAccumOpen(data, cols, rows, clut, shade) {
  const parts = [];
  let runs = 0;
  for (let r = 0; r < rows; r++) {
    let base = r * cols * 4;
    if (shade) {
      let runLv = -1, runChars = "";
      for (let c = 0; c < cols; c++, base += 4) {
        const gray = clut[data[base]] * 0.299 + clut[data[base + 1]] * 0.587 + clut[data[base + 2]] * 0.114;
        const lv = QUANT_LEVEL[gray | 0];
        if (lv !== runLv) {
          if (runLv !== -1) parts.push(OPEN[runLv], runChars, "</i>");
          runChars = "";
          runLv = lv; runs++;
        }
        const ci = gray * RAMP_SCALE < RAMP_LAST ? (gray * RAMP_SCALE) | 0 : RAMP_LAST;
        runChars += RAMP[ci];
      }
      parts.push(OPEN[runLv], runChars, "</i>");
    } else {
      let rowChars = "";
      for (let c = 0; c < cols; c++, base += 4) {
        const gray = clut[data[base]] * 0.299 + clut[data[base + 1]] * 0.587 + clut[data[base + 2]] * 0.114;
        const ci = gray * RAMP_SCALE < RAMP_LAST ? (gray * RAMP_SCALE) | 0 : RAMP_LAST;
        rowChars += RAMP[ci];
      }
      parts.push(rowChars);
    }
    if (r < rows - 1) parts.push("\n");
  }
  return { html: parts.join(""), runs };
}

// V5: oneString + premultiplied luminance LUTs (gray = rL[r]+gL[g]+bL[b]).
// Same IEEE result (each weight mul is just hoisted out of the loop), saves 3 mul/px.
// LUTs rebuilt per frame from clut; here we build them inside so signature matches.
function oneStringLum(data, cols, rows, clut, shade) {
  const rL = new Float64Array(256), gL = new Float64Array(256), bL = new Float64Array(256);
  for (let v = 0; v < 256; v++) { const x = clut[v]; rL[v] = x * 0.299; gL[v] = x * 0.587; bL[v] = x * 0.114; }
  let out = "";
  let runs = 0;
  for (let r = 0; r < rows; r++) {
    let base = r * cols * 4;
    let runLv = -1;
    for (let c = 0; c < cols; c++, base += 4) {
      const gray = rL[data[base]] + gL[data[base + 1]] + bL[data[base + 2]];
      if (shade) {
        const lv = QUANT_LEVEL[gray | 0];
        if (lv !== runLv) {
          if (runLv !== -1) out += "</i>";
          out += "<i class=" + LEVEL_CLASS[lv] + ">";
          runLv = lv; runs++;
        }
      }
      const ci = gray * RAMP_SCALE < RAMP_LAST ? (gray * RAMP_SCALE) | 0 : RAMP_LAST;
      out += RAMP[ci];
    }
    if (shade) out += "</i>";
    if (r < rows - 1) out += "\n";
  }
  return { html: out, runs };
}

module.exports = { runAccum, rowString, oneString, runAccumOpen, oneStringLum };
