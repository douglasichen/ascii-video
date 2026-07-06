// Security checks for the untrusted-.asciiv decode path. Run: node tests/test_codec.js
const assert = require("assert");
const A = require("../asciiv-codec.js");

(async () => {
  // 1. A valid file still round-trips (validation must not reject legit clips).
  const header = { fps: 30, cols: 4, rows: 2, colour: "#0a1b2c", shading: true, durationMs: 100, audioMime: "audio/webm;codecs=opus" };
  const f0 = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7]);
  const f1 = Uint8Array.from([0, 1, 2, 3, 9, 9, 9, 9]);
  const bytes = await A.encodeAsciiv(header, [f0, f1], Uint8Array.from([1, 2, 3]));
  const dec = await A.decodeAsciiv(bytes);
  assert.strictEqual(dec.header.frameCount, 2);
  assert.strictEqual(dec.frames.length, 2);
  assert.deepStrictEqual([...dec.frames[1]], [...f1]);

  // 2. validHeader accepts good headers, rejects the attack shapes.
  const ok = { fps: 30, cols: 4, rows: 2, frameCount: 2, colour: "#abcdef", audioMime: "" };
  assert.ok(A.validHeader(ok), "valid header accepted");
  assert.ok(A.validHeader({ ...ok, audioMime: "audio/mp4" }));
  assert.ok(!A.validHeader({ ...ok, colour: "#fff}</style><script>x" }), "css/html-injection colour rejected");
  assert.ok(!A.validHeader({ ...ok, colour: "red" }), "non-hex colour rejected");
  assert.ok(!A.validHeader({ ...ok, cols: 999999, rows: 999999 }), "oversized grid rejected");
  assert.ok(!A.validHeader({ ...ok, frameCount: 1e9 }), "oversized frameCount rejected");
  assert.ok(!A.validHeader({ ...ok, cols: 0 }), "zero dim rejected");
  assert.ok(!A.validHeader({ ...ok, fps: 0 }), "zero fps rejected");
  assert.ok(!A.validHeader({ ...ok, cols: 4.5 }), "non-integer dim rejected");
  assert.ok(!A.validHeader({ ...ok, audioMime: "text/html" }), "non-audio mime rejected");

  // 3. decodeAsciiv fails closed on an oversized/malicious header.
  const evil = await A.encodeAsciiv({ ...header, cols: 4, rows: 2 }, [f0], null);
  // hand-forge a header claiming a giant grid, reuse the frame body:
  const badHdr = new TextEncoder().encode(JSON.stringify({ v: 1, frameCount: 1e9, fps: 30, cols: 4096, rows: 4096, colour: "#000000" }));
  const dv = new DataView(evil.buffer);
  const oldLen = dv.getUint32(4, true);
  const rebuilt = new Uint8Array(8 + badHdr.length + (evil.length - 8 - oldLen));
  rebuilt.set([65, 83, 67, 86], 0);
  new DataView(rebuilt.buffer).setUint32(4, badHdr.length, true);
  rebuilt.set(badHdr, 8);
  rebuilt.set(evil.subarray(8 + oldLen), 8 + badHdr.length);
  await assert.rejects(() => A.decodeAsciiv(rebuilt), /invalid \.asciiv header/, "malicious header rejected");

  // 4. buildRows clamps out-of-range char-indices instead of emitting undefined/garbage class names.
  const bad = Uint8Array.from([0, 200, 255, 5]); // 200/255 are past the 0..9 ramp
  const html = A.buildRows(bad, 4, 1, true);
  assert.ok(!html.includes("undefined"), "no undefined from out-of-range indices");
  assert.ok(!/class=[a-z]?>/.test(html.replace(/class=[a-h]>/g, "")), "only valid a..h level classes emitted");

  console.log("test_codec.js: OK");
})().catch((e) => { console.error(e); process.exit(1); });
