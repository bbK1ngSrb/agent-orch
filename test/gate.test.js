import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detect, run, splitArgs } from "../src/gate.js";

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
  assert.equal(run("node -e process.exit(0)", tmp()).pass, true);
  assert.equal(run("node -e process.exit(1)", tmp()).pass, false);
});

test("splitArgs is quote-aware", () => {
  assert.deepEqual(splitArgs("npm test"), ["npm", "test"]);
  assert.deepEqual(splitArgs("go test ./..."), ["go", "test", "./..."]);
  assert.deepEqual(splitArgs('node -e "process.exit(0)"'), ["node", "-e", "process.exit(0)"]);
});

test("run does not interpret shell metacharacters", () => {
  const d = tmp();
  // If a shell ran this, the `;` would chain and `touch` would fire.
  const r = run("node -e process.exit(1) ; touch pwned", d);
  assert.equal(r.pass, false); // `;` is a literal argv token, not a command chain
  assert.equal(existsSync(join(d, "pwned")), false); // touch never ran
});
