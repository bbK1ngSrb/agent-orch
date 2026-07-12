import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { exeCandidates, killTree, portableSpawnSpec } from "../src/platform.js";
import { resolveAgentBin } from "../src/agent-bin.js";

test("exeCandidates: POSIX returns the bare name only", () => {
  assert.deepEqual(exeCandidates("claude", "linux"), ["claude"]);
  assert.deepEqual(exeCandidates("claude", "darwin"), ["claude"]);
});

test("exeCandidates: win32 expands PATHEXT, never the bare extensionless name", () => {
  assert.deepEqual(
    exeCandidates("claude", "win32", ".COM;.EXE;.BAT;.CMD"),
    ["claude.com", "claude.exe", "claude.bat", "claude.cmd"],
  );
});

test("exeCandidates: win32 falls back to a default PATHEXT when env is unset", () => {
  assert.ok(exeCandidates("codex", "win32", undefined).includes("codex.cmd"));
});

test("exeCandidates: win32 keeps a name that already carries an extension", () => {
  assert.deepEqual(exeCandidates("git.exe", "win32", ".EXE;.CMD"), ["git.exe"]);
});

test("killTree: POSIX SIGKILLs the process group (negative pid)", () => {
  const calls = [];
  killTree(1234, "linux", { kill: (pid, sig) => calls.push([pid, sig]) });
  assert.deepEqual(calls, [[-1234, "SIGKILL"]]);
});

test("killTree: POSIX swallows an already-gone group", () => {
  killTree(1234, "linux", { kill: () => { throw new Error("ESRCH"); } }); // must not throw
});

test("killTree: win32 uses taskkill /t /f instead of signals", () => {
  const calls = [];
  killTree(1234, "win32", { spawnSync: (bin, args) => calls.push([bin, args]) });
  assert.deepEqual(calls, [["taskkill", ["/pid", "1234", "/t", "/f"]]]);
});

test("portableSpawnSpec: POSIX passes through untouched", () => {
  const spec = portableSpawnSpec("claude", ["-p", "hi"], "linux");
  assert.deepEqual(spec, { bin: "claude", args: ["-p", "hi"] });
});

test("portableSpawnSpec: win32 native exe passes through untouched", () => {
  const spec = portableSpawnSpec("C:\\tools\\codex.exe", ["exec"], "win32");
  assert.deepEqual(spec, { bin: "C:\\tools\\codex.exe", args: ["exec"] });
});

test("portableSpawnSpec: win32 unwraps an npm .cmd shim to node + JS target", () => {
  const shim = [
    "@ECHO off",
    "SETLOCAL",
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
  ].join("\r\n");
  const spec = portableSpawnSpec("C:\\npm\\claude.cmd", ["-p", "multi\nline prompt"], "win32", () => shim);
  assert.equal(spec.bin, process.execPath);
  assert.equal(spec.args[0], win32.join("C:\\npm", "node_modules\\@anthropic-ai\\claude-code\\cli.js"));
  assert.deepEqual(spec.args.slice(1), ["-p", "multi\nline prompt"]); // prompt argv survives verbatim
});

test("portableSpawnSpec: win32 safe non-shim .cmd falls back to cmd.exe /c", () => {
  const spec = portableSpawnSpec("C:\\x\\weird.cmd", ["a"], "win32", () => "@echo custom script");
  assert.equal(spec.bin, process.env.ComSpec || "cmd.exe");
  assert.deepEqual(spec.args, ["/d", "/s", "/c", "C:\\x\\weird.cmd", "a"]);
});

test("portableSpawnSpec: win32 cmd.exe fallback rejects command metacharacters", () => {
  assert.throws(
    () => portableSpawnSpec("C:\\x\\weird.cmd", ["ok", "bad&touch pwned"], "win32", () => "@echo custom script"),
    /unsafe Windows cmd fallback argument: bad&touch pwned/,
  );
});

test("portableSpawnSpec: win32 unreadable .cmd falls back to cmd.exe /c", () => {
  const spec = portableSpawnSpec("C:\\x\\gone.cmd", [], "win32", () => { throw new Error("ENOENT"); });
  assert.equal(spec.bin, process.env.ComSpec || "cmd.exe");
});

test("portableSpawnSpec: win32 cmd fallback rejects dangerous metacharacters", () => {
  assert.throws(
    () => portableSpawnSpec("C:\\x\\gone.cmd", ["safe", "bad&arg"], "win32", () => { throw new Error("ENOENT"); }),
    /unsafe Windows cmd fallback argument: bad&arg/,
  );
});

test("resolveAgentBin: win32 finds a .cmd shim in a fallback dir via PATHEXT", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-agentbin-"));
  const p = join(d, "fake-win-cli.cmd");
  writeFileSync(p, "@echo off\n");
  chmodSync(p, 0o755);
  assert.equal(resolveAgentBin("fake-win-cli", [d], "", "win32"), p);
});

test("resolveAgentBin: win32 PATH hit returns the absolute resolved path", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-agentbin-"));
  const p = join(d, "fake-win-cli2.cmd");
  writeFileSync(p, "@echo off\n");
  chmodSync(p, 0o755);
  // POSIX returns the bare name on a PATH hit; win32 must return the absolute
  // path so the caller can see the .cmd extension and unwrap the shim.
  assert.equal(resolveAgentBin("fake-win-cli2", [], `${win32.delimiter}${d}${win32.delimiter}`, "win32"), p);
});

test("resolveAgentBin: win32 prefers the .cmd shim over a same-named bare POSIX shim (#313)", () => {
  // npm ships both a bare `npm` (POSIX shim) and `npm.cmd` (real Windows shim)
  // in the same global bin dir. The bare file must never win the probe.
  const d = mkdtempSync(join(tmpdir(), "orch-agentbin-"));
  const bare = join(d, "npm");
  const cmd = join(d, "npm.cmd");
  writeFileSync(bare, "#!/bin/sh\n");
  writeFileSync(cmd, "@echo off\n");
  chmodSync(cmd, 0o755);
  assert.equal(resolveAgentBin("npm", [d], "", "win32"), cmd);
});
