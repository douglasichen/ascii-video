import { test } from "vitest";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Bridge: run the Python API security suite (tests/test_api.py) as part of `npm test`.
// Without this, `vitest run` only globs *.test.ts, so test_api.py — the ONLY coverage for the resolve/save
// gates (SSRF via ?v=, look-alike-host bypass, runId path-traversal into the Apify token URL, cache-key
// poisoning, and same-origin) — never runs under the documented test command and there's no CI to run it.
// A green `npm test` was therefore silently skipping every API security regression. Shelling out here makes
// those asserts actually gate; a non-zero exit (any failed assert, or import error) fails this test with the
// Python output attached. The repo already hard-depends on python3 (api/*.py are the serverless functions).
test("api security suite (tests/test_api.py) passes", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  let out: string;
  try {
    out = execFileSync("python3", [resolve(here, "test_api.py")], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e: any) {
    const detail = [e?.stdout, e?.stderr].filter(Boolean).join("\n") || e?.message || String(e);
    assert.fail(`tests/test_api.py failed (resolve/save security gates):\n${detail}`);
  }
  assert.ok(/test_api\.py: OK/.test(out), `test_api.py did not report OK:\n${out}`);
  console.log(out.trim());
});
