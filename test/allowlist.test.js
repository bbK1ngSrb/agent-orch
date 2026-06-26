import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPaths, DEFAULT_PROTECTED } from "../src/intake/allowlist.js";

test("allows ordinary source and test paths", () => {
  const r = checkPaths(["src/config.js", "test/config.test.js", "README.md"]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.violations, []);
});

test("rejects a workflow edit", () => {
  const r = checkPaths(["src/foo.js", ".github/workflows/orch-pr.yml"]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.violations, [".github/workflows/orch-pr.yml"]);
});

test("rejects gate/verdict/audit guardrail modules", () => {
  assert.equal(checkPaths(["src/gate.js"]).ok, false);
  assert.equal(checkPaths(["src/verdict.js"]).ok, false);
  assert.equal(checkPaths(["src/notify.js"]).ok, false);
});

test("rejects manifests and lockfiles", () => {
  assert.equal(checkPaths(["package.json"]).ok, false);
  assert.equal(checkPaths(["package-lock.json"]).ok, false);
});

test("rejects the container/sandbox build definition", () => {
  assert.equal(checkPaths(["Dockerfile"]).ok, false);
  assert.equal(checkPaths(["sandbox/harness.sh"]).ok, false);
});

test("reports every violation, not just the first", () => {
  const r = checkPaths(["src/gate.js", "package.json"]);
  assert.deepEqual(r.violations.sort(), ["package.json", "src/gate.js"]);
});

test("DEFAULT_PROTECTED is non-empty and covers workflows", () => {
  assert.ok(DEFAULT_PROTECTED.includes(".github/workflows/**"));
});
