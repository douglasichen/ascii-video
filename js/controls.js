// controls.js — the control panel: builds the rows from CONTROLS (see state.js), wires every input, and
// setControl (the single write path for a tunable). All tunables live in the one CONTROLS object so a new
// one is added there, not wired up ad hoc.
import { CONTROLS, state, base, DRIVEN, rt } from "./state.js";
import { configEl, video, cfgToggle } from "./dom.js";
import { buildPalette, computeGrid, paint } from "./render.js";
import { initAudio, rx } from "./reactive.js";

export function setControl(key, value) {
  state[key] = value;
  base[key] = value; // remember the resting value; music mode modulates the DRIVEN keys around base
  const input = document.getElementById(`ctrl-${key}`);
  if (CONTROLS[key].type === "checkbox") input.checked = value; else input.value = value;
  if (!CONTROLS[key].type) document.getElementById(`val-${key}`).textContent = value + CONTROLS[key].unit; // only range controls show a value
  if (key === "react") {
    document.body.classList.toggle("music-on", value); // reveal/hide the music parameter rows
    if (value) initAudio();
    else { for (const k of DRIVEN) state[k] = base[k]; buildPalette(base.color); computeGrid(); rx.on = false; } // restore instantly, even while paused
  }
  if (key === "detail") computeGrid();
  if (key === "color") buildPalette(value);
  // keep the hex field in sync with the swatch, but don't clobber it while the user is typing in it
  if (CONTROLS[key].type === "color") { const hx = document.getElementById(`hex-${key}`); if (hx && document.activeElement !== hx) hx.value = value; }
  // Re-sample the current frame at the new grid RIGHT NOW. The render loop is idle while the video is
  // paused, so without this a detail change would only swap the font size on the stale text — scaling
  // it, which looks like a zoom. Repainting resamples at the new resolution so paused (and mid-play)
  // adjustments preview live at a fixed on-screen size. No-op until a video frame exists.
  if (video.videoWidth && rt.rows) paint();
}

// Build the panel DOM from CONTROLS, then attach the input/hex/reset/toggle listeners. Called from main.
export function buildControls() {
  let curSection = "";
  for (const key in CONTROLS) {
    const c = CONTROLS[key];
    if (c.section && c.section !== curSection) { // full-width section header whenever the group changes
      curSection = c.section;
      const hd = document.createElement("div");
      hd.className = "section"; hd.textContent = curSection;
      configEl.appendChild(hd);
    }
    const row = document.createElement("div");
    row.className = "ctrl";
    // the music *parameter* rows (not the on/off toggle) stay hidden until music is on — keeps the panel simple
    if (c.section === "music" && key !== "react") row.classList.add("music-param");
    let input;
    // colour: hex field (left) + a small square swatch (right), both in the input cell — so the shared value
    // column stays narrow (just the numeric readouts) and every slider runs nearly to its number.
    if (c.type === "color") input = `<div class="colorcell"><input type="text" class="hex" id="hex-${key}" value="${c.default}" spellcheck="false" maxlength="7" aria-label="${c.label} hex"><input type="color" id="ctrl-${key}" value="${c.default}"></div>`;
    else if (c.type === "checkbox") input = `<input type="checkbox" id="ctrl-${key}" ${c.default ? "checked" : ""}>`;
    else input = `<input type="range" id="ctrl-${key}" min="${c.min}" max="${c.max}" step="${c.step}" value="${c.default}">`;
    // value cell: range -> numeric readout; checkbox/colour -> empty. Every row keeps 4 grid cells aligned.
    const valCell = `<span class="val" id="val-${key}">${c.type ? "" : c.default + c.unit}</span>`;
    row.innerHTML = `
      <label>${c.label}</label>
      ${input}
      ${valCell}
      <button class="reset" data-key="${key}" title="reset ${c.label}" aria-label="reset ${c.label}">↺</button>`;
    configEl.appendChild(row);
  }

  for (const key in CONTROLS) {
    const c = CONTROLS[key];
    document.getElementById(`ctrl-${key}`).addEventListener("input", e =>
      setControl(key, c.type === "color" ? e.target.value : c.type === "checkbox" ? e.target.checked : Number(e.target.value)));
  }
  // hex text fields (colour controls): type an exact hex; a valid 6-digit value drives the swatch + state.
  for (const key in CONTROLS) if (CONTROLS[key].type === "color") {
    const hx = document.getElementById(`hex-${key}`);
    hx.addEventListener("input", () => {
      let v = hx.value.trim(); if (v && v[0] !== "#") v = "#" + v;
      if (/^#[0-9a-fA-F]{6}$/.test(v)) setControl(key, v.toLowerCase());
    });
  }
  configEl.addEventListener("click", e => {
    const key = e.target.dataset.key;
    if (key) setControl(key, CONTROLS[key].default);
  });
  // Controls expand out of the bar itself. Collapsed by default -> only the url field shows; the chevron
  // on the bar drops the panel out flush beneath it.
  cfgToggle.addEventListener("click", () => {
    const open = document.body.classList.toggle("cfg-open");
    cfgToggle.setAttribute("aria-expanded", String(open));
  });
  document.body.classList.toggle("music-on", state.react); // reveal the music param rows if react defaults on
}
