import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register, setPaths, deregister, listLive, countLive, peerPaths } from "../src/inflight.js";

const IS_WINDOWS = process.platform === "win32";

test("register/setPaths/deregister roundtrip with a live pid", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-if-"));
  register(d, "s1", { branch: "pr/claude/a-s1", pid: process.pid, baseSha: "abc" });
  assert.equal(countLive(d), 1);
  setPaths(d, "s1", ["src/x.js"], "def");
  assert.deepEqual(listLive(d)[0].paths, ["src/x.js"]);
  assert.equal(listLive(d)[0].baseSha, "def");
  deregister(d, "s1");
  assert.equal(countLive(d), 0);
});

test("register does not persist the large-scope sanction", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-if-"));
  register(d, "sanctioned", { branch: "b", pid: process.pid, baseSha: "z", allowLargeScope: true });
  assert.equal("allowLargeScope" in listLive(d)[0], false);
});

test("listLive drops dead-pid entries", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-if-"));
  register(d, "dead", { branch: "pr/x/dead", pid: 999999999, baseSha: "z" });
  register(d, "alive", { branch: "pr/x/alive", pid: process.pid, baseSha: "z" });
  assert.equal(countLive(d), 1);
  assert.equal(listLive(d)[0].sid, "alive");
});

test("peerPaths excludes the caller's own sid", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-if-"));
  register(d, "me", { branch: "b", pid: process.pid, baseSha: "z" });
  register(d, "peer", { branch: "b2", pid: process.pid, baseSha: "z" });
  setPaths(d, "me", ["a.js"]);
  setPaths(d, "peer", ["b.js", "c.js"]);
  assert.deepEqual(peerPaths(d, "me").sort(), ["b.js", "c.js"]);
});

test("listLive deletes a corrupt entry", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-if-"));
  register(d, "good", { branch: "b", pid: process.pid, baseSha: "z" });
  mkdirSync(join(d, "inflight"), { recursive: true });
  writeFileSync(join(d, "inflight", "corrupt.json"), "{bad json");
  assert.equal(countLive(d), 1); // corrupt dropped, good kept
});

test("setPaths is a no-op when the record is removed before the call", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-if-"));
  register(d, "gone", { branch: "b", pid: process.pid, baseSha: "z" });
  deregister(d, "gone");
  setPaths(d, "gone", ["a.js"]); // must not throw
});

test("setPaths does not throw when the record vanishes between read and write",
  { skip: IS_WINDOWS && "chmod doesn't restrict directory writes on Windows" }, () => {
    const d = mkdtempSync(join(tmpdir(), "orch-if-"));
    register(d, "s1", { branch: "b", pid: process.pid, baseSha: "z" });
    // The read still succeeds but the atomic write fails (EACCES) — the same
    // failure shape as another process removing the record mid-call, and a
    // throw here would abort a live runCycle (engine.js try/finally, no catch).
    chmodSync(join(d, "inflight"), 0o555);
    try {
      setPaths(d, "s1", ["a.js"]); // must not throw
    } finally {
      chmodSync(join(d, "inflight"), 0o755);
    }
  });
