import test from "node:test";
import assert from "node:assert/strict";
import { execSpec, runUpgrade } from "../src/upgrade.js";

function capture() {
  let out = "";
  return {
    stdout: { isTTY: false, write: (chunk) => { out += chunk; } },
    output: () => out,
  };
}

function execWithLatest(version, calls = []) {
  return (cmd, args = []) => {
    calls.push([cmd, ...args]);
    if (cmd === "npm" && args.join(" ") === "view @bbk1ng/agent-orch version") return version;
    return "";
  };
}

test("execSpec unwraps a Windows npm .cmd shim into a direct node spawn", () => {
  const shim = '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\npm\\bin\\npm-cli.js" %*\r\n';
  const spec = execSpec("npm", ["root", "-g"], {
    resolve: () => "C:\\Program Files\\nodejs\\npm.cmd",
    platform: "win32",
    read: () => shim,
  });
  assert.equal(spec.bin, process.execPath);
  assert.deepEqual(spec.args, [
    "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
    "root",
    "-g",
  ]);
});

test("execSpec passes npm through untouched on POSIX", () => {
  const spec = execSpec("npm", ["view", "pkg", "version"], {
    resolve: () => "npm",
    platform: "linux",
  });
  assert.deepEqual(spec, { bin: "npm", args: ["view", "pkg", "version"] });
});

test("execSpec falls back to the bare command when PATH resolution misses", () => {
  const spec = execSpec("npm", ["root", "-g"], {
    resolve: () => null,
    platform: "linux",
  });
  assert.deepEqual(spec, { bin: "npm", args: ["root", "-g"] });
});

test("linked dev install prints git-pull guidance and never installs", async () => {
  const io = capture();
  const calls = [];
  const result = await runUpgrade({
    current: "1.0.0",
    exec: execWithLatest("1.1.0", calls),
    resolveInstall: () => ({ type: "linked", realPath: "/src/agent-orch" }),
    stdout: io.stdout,
    flags: {},
  });
  assert.equal(result.status, "linked");
  assert.match(io.output(), /linked dev install/i);
  assert.match(io.output(), /git pull.*\/src\/agent-orch/);
  assert.deepEqual(calls, []);
});

test("registry install with newer version runs npm install latest", async () => {
  const io = capture();
  const calls = [];
  const result = await runUpgrade({
    current: "1.0.0",
    exec: execWithLatest("1.1.0", calls),
    resolveInstall: () => ({ type: "registry", path: "/npm/root/@bbk1ng/agent-orch" }),
    stdout: io.stdout,
    flags: {},
  });
  assert.equal(result.status, "upgraded");
  assert.deepEqual(calls, [
    ["npm", "view", "@bbk1ng/agent-orch", "version"],
    ["npm", "install", "-g", "@bbk1ng/agent-orch@latest"],
  ]);
  assert.match(io.output(), /1\.0\.0 -> 1\.1\.0/);
  assert.match(io.output(), /updated to latest/);
});

test("--check reports availability and never installs", async () => {
  const io = capture();
  const calls = [];
  const result = await runUpgrade({
    current: "1.0.0",
    exec: execWithLatest("1.1.0", calls),
    resolveInstall: () => ({ type: "registry" }),
    stdout: io.stdout,
    flags: { check: true },
  });
  assert.equal(result.status, "available");
  assert.deepEqual(calls, [["npm", "view", "@bbk1ng/agent-orch", "version"]]);
  assert.match(io.output(), /upgrade available/);
});

test("--check uses the shared version comparison", async () => {
  const io = capture();
  const result = await runUpgrade({
    current: "1.0.0",
    exec: execWithLatest("1.0.0.1"),
    resolveInstall: () => ({ type: "registry" }),
    stdout: io.stdout,
    flags: { check: true },
  });
  assert.equal(result.status, "available");
  assert.match(io.output(), /upgrade available/);
});

test("--dry prints the install command and never installs", async () => {
  const io = capture();
  const calls = [];
  const result = await runUpgrade({
    current: "1.0.0",
    exec: execWithLatest("1.1.0", calls),
    resolveInstall: () => ({ type: "registry" }),
    stdout: io.stdout,
    flags: { dry: true },
  });
  assert.equal(result.status, "dry");
  assert.deepEqual(calls, [["npm", "view", "@bbk1ng/agent-orch", "version"]]);
  assert.match(io.output(), /npm install -g @bbk1ng\/agent-orch@latest/);
});

test("already latest is a no-op", async () => {
  const io = capture();
  const calls = [];
  const result = await runUpgrade({
    current: "1.1.0",
    exec: execWithLatest("1.1.0", calls),
    resolveInstall: () => ({ type: "registry" }),
    stdout: io.stdout,
    flags: {},
  });
  assert.equal(result.status, "current");
  assert.deepEqual(calls, [["npm", "view", "@bbk1ng/agent-orch", "version"]]);
  assert.match(io.output(), /already latest/);
});
