import { test } from "vitest";
import assert from "node:assert";
import { state, base, DRIVEN, CONTROLS } from "../src/state.js";

// Coverage for the music-off invariant (CLAUDE.md "Music reactivity" — the KEY non-regression property:
// "off by default, and turning it off restores state to base exactly, so main's default behaviour and the
// shipped look are unchanged"). restoreBase() lives in src/reactive.ts, which imports dom.ts/render.ts and
// therefore can't be imported headless — so this exercises the REAL contract restoreBase's correctness rests
// on, using the REAL state/base/DRIVEN singletons (not a copied constant list, which is what could drift):
//   restoreBase's body is `for (const k of DRIVEN) state[k] = base[k]` (+ DOM-only buildPalette/computeGrid).
// The regression it must catch: applyReactivity overwrites the DRIVEN keys every frame; if a key it drives is
// dropped from DRIVEN, music-off leaves state permanently off-base for that key. So we lock (a) DRIVEN is a
// set of real State keys, (b) it covers every documented music target, and (c) the restore mechanism returns
// exactly the DRIVEN keys to base and touches nothing else.
test("restoreBase contract — DRIVEN restores exactly the music-driven keys and nothing else", () => {
  let passes = 0;
  const ok = (c: boolean, m: string) => { assert.ok(c, m); passes++; };

  // (a) every DRIVEN entry is a real State key (present in both live `state` and resting `base`), no dupes
  assert.strictEqual(new Set(DRIVEN).size, DRIVEN.length, "DRIVEN has no duplicate keys");
  for (const k of DRIVEN) {
    ok(k in state && k in base, `DRIVEN key "${k}" exists in state+base`);
    ok(k in CONTROLS, `DRIVEN key "${k}" is a real CONTROLS tunable`);
  }

  // (b) DRIVEN must cover every target applyReactivity writes (CLAUDE.md: brightness/contrast/color/detail).
  // Dropping any of these from DRIVEN is the exact regression — music-off would stop restoring it.
  for (const k of ["brightness", "contrast", "color", "detail"] as const)
    ok(DRIVEN.includes(k), `applyReactivity drives "${k}" -> it MUST be in DRIVEN so restoreBase resets it`);

  // (c) the restore mechanism: simulate a full music drift (every DRIVEN key + one non-DRIVEN key nudged off
  // base), run the real restore loop over the real DRIVEN, and assert state returns to base on the DRIVEN
  // keys while the non-DRIVEN key is left exactly as-is (restoreBase must NOT touch resting-only controls).
  const savedState = { ...state }, savedBase = { ...base };
  try {
    const bump = (v: unknown) => typeof v === "number" ? (v as number) + 7 : typeof v === "boolean" ? !v : "#0a0b0c";
    for (const k of DRIVEN) (state as any)[k] = bump(base[k]);
    const nonDriven = (Object.keys(state) as (keyof typeof state)[]).find(k => !DRIVEN.includes(k))!;
    (state as any)[nonDriven] = bump(base[nonDriven]);        // a resting-only control the user changed
    const nonDrivenDirty = (state as any)[nonDriven];

    // THE restoreBase body (state-restore half; buildPalette/computeGrid are DOM side effects, not the invariant)
    for (const k of DRIVEN) (state as any)[k] = base[k];

    for (const k of DRIVEN) ok((state as any)[k] === base[k], `restore returns DRIVEN key "${k}" to base`);
    ok((state as any)[nonDriven] === nonDrivenDirty, `restore leaves non-DRIVEN key "${nonDriven}" untouched`);
  } finally {
    Object.assign(state, savedState); Object.assign(base, savedBase); // don't pollute the shared singletons
  }

  console.log(`PASS: restoreBase contract — ${passes} assertions (DRIVEN validity, coverage, restore mechanism)`);
});
