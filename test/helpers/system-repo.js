// Shared system-test fixtures: a real temp git repo (plus a bare origin and a
// second clone acting as a peer) and the fake cycle deps that let `main()` run
// a whole cycle without spawning an agent. Extracted from cli.test.js so
// test/system-v2.test.js can drive the same real-repo/fake-gh setup instead of
// growing a second, drifting copy of it.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as gitDep from "../../src/git.js";

export function initGitRepo(prefix = "orch-main-") {
  const d = mkdtempSync(join(tmpdir(), prefix));
  gitDep.git(["init", "-b", "main"], d);
  gitDep.git(["config", "user.email", "t@t"], d);
  gitDep.git(["config", "user.name", "t"], d);
  // core.autocrlf defaults to true on Windows git and rewrites LF to CRLF on
  // checkout, which would make file-content assertions platform-dependent.
  gitDep.git(["config", "core.autocrlf", "false"], d);
  writeFileSync(join(d, "a.txt"), "1\n");
  gitDep.git(["add", "."], d);
  gitDep.git(["commit", "-m", "init"], d);
  return d;
}

export function initGitRepoOn(branch, prefix = "orch-main-") {
  const d = mkdtempSync(join(tmpdir(), prefix));
  gitDep.git(["init", "-b", branch], d);
  gitDep.git(["config", "user.email", "t@t"], d);
  gitDep.git(["config", "user.name", "t"], d);
  gitDep.git(["config", "core.autocrlf", "false"], d);
  writeFileSync(join(d, "a.txt"), "1\n");
  gitDep.git(["add", "."], d);
  gitDep.git(["commit", "-m", "init"], d);
  return d;
}

export function addOriginWithPeer(repo) {
  const remote = mkdtempSync(join(tmpdir(), "orch-cli-remote-"));
  gitDep.git(["init", "--bare", "-b", "main"], remote);
  gitDep.git(["remote", "add", "origin", remote], repo);
  gitDep.git(["push", "-u", "origin", "main"], repo);
  const parent = mkdtempSync(join(tmpdir(), "orch-cli-peer-"));
  const peer = join(parent, "repo");
  gitDep.git(["clone", remote, peer], parent);
  gitDep.git(["config", "user.email", "t@t"], peer);
  gitDep.git(["config", "user.name", "t"], peer);
  gitDep.git(["config", "core.autocrlf", "false"], peer);
  return { remote, peer };
}

export function fakeCycleDeps() {
  const verdict = { decision: "AGREE", reason: "ok", raw: "", usage: { model: "gpt-test-review", tokens: 20 } };
  return {
    adapters: { get: (name) => ({ name, async author() { return { usage: { model: "gpt-test-author", tokens: 40 } }; }, async audit() { return verdict; } }) },
    git: { ...gitDep, changedFiles: () => ["a.txt"] },
    gate: { detect: () => "true", run: () => ({ pass: true, log: "" }) },
    scope: { count: () => 0 },
    notify: { phase() {}, writeRound() {}, escalate() {}, buildDecisionBrief() { return ""; } },
    inflight: { setPaths() {} },
    finalize: async () => ({ status: "merged", reason: "test", sha: "abc" }),
  };
}
