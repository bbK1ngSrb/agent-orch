import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detect, run } from "../src/gate.js";

function tmp() { return mkdtempSync(join(tmpdir(), "orch-gate-")); }

test("detects npm test from package.json", () => {
  const d = tmp();
  writeFileSync(join(d, "package.json"), JSON.stringify({ scripts: { test: "x" } }));
  assert.equal(detect(d), "npm test");
});

test("detects pytest from a tests/ dir", () => {
  const d = tmp();
  mkdirSync(join(d, "tests"));
  assert.equal(detect(d), "pytest -q");
});

test("detects go test from go.mod", () => {
  const d = tmp();
  writeFileSync(join(d, "go.mod"), "module x\n");
  assert.equal(detect(d), "go test ./...");
});

test("returns null when nothing detected", () => {
  assert.equal(detect(tmp()), null);
});

test("run reports pass/fail by exit code", () => {
  assert.equal(run("exit 0", tmp()).pass, true);
  assert.equal(run("exit 1", tmp()).pass, false);
});
