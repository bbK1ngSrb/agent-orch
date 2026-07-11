import { test } from "node:test";
import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register, setPaths, deregister, listLive, countLive, peerPaths } from "../src/inflight.js";

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

test("setPaths replaces the inflight path atomically instead of writing through it", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-if-"));
  register(d, "s1", { branch: "b", pid: process.pid, baseSha: "old" });
  const target = join(d, "inflight", "s1.json");
  const linked = join(d, "linked.json");
  writeFileSync(linked, JSON.stringify({ sid: "s1", branch: "linked", pid: process.pid, baseSha: "old", paths: [] }));
  rmSync(target);
  symlinkSync(linked, target);

  setPaths(d, "s1", ["new.js"], "newbase");

  assert.deepEqual(JSON.parse(readFileSync(linked, "utf8")).paths, []);
  assert.equal(lstatSync(target).isSymbolicLink(), false);
  assert.deepEqual(listLive(d)[0].paths, ["new.js"]);
  assert.equal(listLive(d)[0].baseSha, "newbase");
});

test("listLive deletes a corrupt entry", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-if-"));
  register(d, "good", { branch: "b", pid: process.pid, baseSha: "z" });
  mkdirSync(join(d, "inflight"), { recursive: true });
  writeFileSync(join(d, "inflight", "corrupt.json"), "{bad json");
  assert.equal(countLive(d), 1); // corrupt dropped, good kept
});
