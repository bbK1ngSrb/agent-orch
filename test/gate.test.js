import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detect, run, spawnSpec, splitArgs } from "../src/gate.js";

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

test("spawnSpec on POSIX passes argv through untouched", () => {
  assert.deepEqual(spawnSpec(["npm", "test"], "linux"), { bin: "npm", args: ["test"] });
});

test("spawnSpec on Windows unwraps an npm .cmd shim to a direct node spawn", () => {
  const shim = 'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\npm\\bin\\npm-cli.js" %*';
  const spec = spawnSpec(["npm", "test"], "win32", {
    resolve: () => "C:\\Program Files\\nodejs\\npm.cmd",
    read: () => shim,
  });
  // Never cmd.exe: the shim target runs under our own node, so shell
  // metacharacters in the configured test command stay literal argv.
  assert.equal(spec.bin, process.execPath);
  assert.deepEqual(spec.args, ["C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js", "test"]);
});

test("spawnSpec on Windows passes native exes through when resolution misses", () => {
  const spec = spawnSpec(["go", "test", "./..."], "win32", { resolve: () => null });
  assert.deepEqual(spec, { bin: "go", args: ["test", "./..."] });
});

test("run kills a hung test command at timeoutMs and fails the gate (#505)", () => {
  const d = mkdtempSync(join(tmpdir(), "gate-timeout-"));
  const t0 = Date.now();
  // node fixture, not `sleep`: the Windows CI runner has no POSIX shell tools.
  const r = run(`node -e setTimeout(()=>{},60000)`, d, 500);
  const elapsed = Date.now() - t0;
  assert.equal(r.pass, false, "a timed-out gate fails closed, never passes");
  assert.match(r.log, /timed out after 500ms/);
  assert.ok(elapsed < 30_000, `returned in ${elapsed}ms instead of hanging for the full 60s`);
});

test("run leaves a fast command alone when a timeout is set (no false kill)", () => {
  const d = mkdtempSync(join(tmpdir(), "gate-timeout-ok-"));
  const r = run(`node -e process.exit(0)`, d, 60_000);
  assert.equal(r.pass, true);
  assert.doesNotMatch(r.log, /timed out/);
});

test("timeoutMs of 0 disables the cap (stageTimeout: 0 parity)", () => {
  const d = mkdtempSync(join(tmpdir(), "gate-timeout-off-"));
  const r = run(`node -e process.exit(0)`, d, 0);
  assert.equal(r.pass, true);
});
