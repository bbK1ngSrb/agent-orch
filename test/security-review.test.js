import { test } from "node:test";
import assert from "node:assert/strict";
import { scanDiff } from "../src/security-review.js";

const clean = `--- a/src/config.js
+++ b/src/config.js
@@ -1,3 +1,4 @@
 export function load() {
+  return { ok: true };
 }`;

test("clean diff → AGREE", () => {
  const r = scanDiff(clean);
  assert.equal(r.decision, "AGREE");
  assert.deepEqual(r.findings, []);
});

test("reading process.env → DISAGREE", () => {
  const d = `+++ b/src/x.js\n+  const k = process.env.GITHUB_TOKEN;`;
  const r = scanDiff(d);
  assert.equal(r.decision, "DISAGREE");
  assert.ok(r.findings.some((f) => f.rule === "env-read"));
});

test("opening network → DISAGREE", () => {
  for (const snippet of [
    `+  const res = await fetch("http://evil.test");`,
    `+  import net from "node:net";`,
    `+  require("https").get(url);`,
  ]) {
    const r = scanDiff(`+++ b/src/x.js\n${snippet}`);
    assert.equal(r.decision, "DISAGREE", snippet);
  }
});

test("spawning a subprocess → DISAGREE", () => {
  const d = `+++ b/test/x.test.js\n+  const { execSync } = require("child_process");`;
  assert.equal(scanDiff(d).decision, "DISAGREE");
});

test("ignores removed and context lines", () => {
  const d = `+++ b/src/x.js
-  const k = process.env.SECRET;
   const y = fetch(url);`;
  // The env read is a '-' removal; fetch is a context line (leading space).
  assert.equal(scanDiff(d).decision, "AGREE");
});

test("does not flag the +++ file header itself", () => {
  const d = `+++ b/src/process.env.helper.js\n+  return 1;`;
  assert.equal(scanDiff(d).decision, "AGREE");
});
