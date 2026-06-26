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

// --- FIX 1: git diff prefix normalisation and path traversal ---
test("rejects a/src/gate.js (git diff 'a/' prefix strips, then matches)", () => {
  const r = checkPaths(["a/src/gate.js"]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.violations, ["a/src/gate.js"]);
});

test("rejects b/src/verdict.js (git diff 'b/' prefix strips, then matches)", () => {
  const r = checkPaths(["b/src/verdict.js"]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.violations, ["b/src/verdict.js"]);
});

test("rejects ./package.json (./ prefix strips, then matches)", () => {
  const r = checkPaths(["./package.json"]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.violations, ["./package.json"]);
});

test("rejects path with .. traversal segment (fail closed)", () => {
  const r = checkPaths(["src/../src/gate.js"]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.violations, ["src/../src/gate.js"]);
});

test("allows a/README.md (ordinary file after git prefix stripped)", () => {
  const r = checkPaths(["a/README.md"]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.violations, []);
});

// --- FIX 2: .github/actions/** in DEFAULT_PROTECTED ---
test("DEFAULT_PROTECTED covers .github/actions/**", () => {
  assert.ok(DEFAULT_PROTECTED.includes(".github/actions/**"));
});

test("rejects a composite action file (.github/actions/**)", () => {
  const r = checkPaths([".github/actions/evil/action.yml"]);
  assert.equal(r.ok, false);
  assert.ok(r.violations.includes(".github/actions/evil/action.yml"));
});

// --- FIX 3: self-protection coverage tests ---
test("rejects src/intake/workorder.js (src/intake/** in DEFAULT_PROTECTED)", () => {
  assert.equal(checkPaths(["src/intake/workorder.js"]).ok, false);
});

test("rejects src/security-review.js (in DEFAULT_PROTECTED)", () => {
  assert.equal(checkPaths(["src/security-review.js"]).ok, false);
});

test("rejects CODEOWNERS (in DEFAULT_PROTECTED)", () => {
  assert.equal(checkPaths(["CODEOWNERS"]).ok, false);
});

test("rejects .github/CODEOWNERS (in DEFAULT_PROTECTED)", () => {
  assert.equal(checkPaths([".github/CODEOWNERS"]).ok, false);
});
