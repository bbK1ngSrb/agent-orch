import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, createTaskBranch, pruneWorktree } from "../src/git.js";
import * as gitNs from "../src/git.js";
import { finalize } from "../src/finalize.js";
import * as inflight from "../src/inflight.js";
import { acquireBlocking, releaseLock } from "../src/lock.js";
import * as notify from "../src/notify.js";

function realDeps() {
  return {
    git: gitNs, gate: { run: () => ({ pass: true }) },
    lock: { acquireBlocking, releaseLock },
    inflight,
    github: {
      demote: async ({ branch }) => ({ prUrl: null }),
      openIntegrationPr: async () => ({ prUrl: null }),
    },
    notify,
  };
}

function newRepo() {
  const d = mkdtempSync(join(tmpdir(), "orch-cc-"));
  git(["init", "-b", "main"], d);
  git(["config", "user.email", "t@t"], d);
  git(["config", "user.name", "t"], d);
  writeFileSync(join(d, "base.txt"), "0\n");
  git(["add", "."], d); git(["commit", "-m", "init"], d);
  return d;
}

function makeBranch(repo, orchDir, name, file, content) {
  const wt = join(orchDir, "wt", name.replace(/\//g, "_"));
  const base = git(["rev-parse", "main"], repo);
  createTaskBranch(repo, wt, name, "main", `${process.pid}\n${name}`);
  writeFileSync(join(wt, file), content);
  git(["add", "."], wt); git(["commit", "-m", `add ${file}`], wt);
  pruneWorktree(repo, wt);
  return base;
}

test("two disjoint branches both auto-merge into integration", async () => {
  const repo = newRepo();
  const orchDir = join(repo, ".orch");
  const baseA = makeBranch(repo, orchDir, "pr/claude/a-1", "a.txt", "A\n");
  const baseB = makeBranch(repo, orchDir, "pr/codex/b-2", "b.txt", "B\n");

  const rA = await finalize({ repo, orchDir, branch: "pr/claude/a-1", sid: "1", baseSha: baseA, paths: ["a.txt"], testCmd: "true", cfg: { merge: "no-ff", integrationBranch: "orch/integration" }, rounds: 1 }, realDeps());
  const rB = await finalize({ repo, orchDir, branch: "pr/codex/b-2", sid: "2", baseSha: baseB, paths: ["b.txt"], testCmd: "true", cfg: { merge: "no-ff", integrationBranch: "orch/integration" }, rounds: 1 }, realDeps());

  assert.equal(rA.status, "merged");
  assert.equal(rB.status, "merged");
  const log = git(["log", "--oneline", "orch/integration"], repo);
  assert.match(log, /add a.txt/);
  assert.match(log, /add b.txt/);
  assert.doesNotMatch(git(["log", "--oneline", "main"], repo), /add a.txt/);
});

test("conflicting branches: first merges, second demotes (conflict, not pre-demoted)", async () => {
  const repo = newRepo();
  const orchDir = join(repo, ".orch");
  const baseA = makeBranch(repo, orchDir, "pr/claude/a-1", "shared.txt", "A\n");
  const baseB = makeBranch(repo, orchDir, "pr/codex/b-2", "shared.txt", "B\n");

  const rA = await finalize({ repo, orchDir, branch: "pr/claude/a-1", sid: "1", baseSha: baseA, paths: ["shared.txt"], testCmd: "true", cfg: { merge: "no-ff", integrationBranch: "orch/integration" }, rounds: 1 }, realDeps());
  const rB = await finalize({ repo, orchDir, branch: "pr/codex/b-2", sid: "2", baseSha: baseB, paths: ["shared.txt"], testCmd: "true", cfg: { merge: "no-ff", integrationBranch: "orch/integration" }, rounds: 1 }, realDeps());

  assert.equal(rA.status, "merged");
  assert.equal(rB.status, "merge-deferred");
  assert.match(rB.reason, /conflict/);
});

test("same file already landed, but cleanly mergeable → second branch still merges (#96)", async () => {
  const repo = newRepo();
  const orchDir = join(repo, ".orch");
  // base.txt has distinct regions; A edits the top, B edits the bottom — same file,
  // file-level overlap, zero textual conflict.
  writeFileSync(join(repo, "base.txt"), "top\n1\n2\n3\n4\n5\n6\n7\n8\nbottom\n");
  git(["add", "."], repo); git(["commit", "-m", "regions"], repo);
  const baseA = makeBranch(repo, orchDir, "pr/claude/a-1", "base.txt", "TOP\n1\n2\n3\n4\n5\n6\n7\n8\nbottom\n");
  const baseB = makeBranch(repo, orchDir, "pr/codex/b-2", "base.txt", "top\n1\n2\n3\n4\n5\n6\n7\n8\nBOTTOM\n");

  const rA = await finalize({ repo, orchDir, branch: "pr/claude/a-1", sid: "1", baseSha: baseA, paths: ["base.txt"], testCmd: "true", cfg: { merge: "no-ff", integrationBranch: "orch/integration" }, rounds: 1 }, realDeps());
  const rB = await finalize({ repo, orchDir, branch: "pr/codex/b-2", sid: "2", baseSha: baseB, paths: ["base.txt"], testCmd: "true", cfg: { merge: "no-ff", integrationBranch: "orch/integration" }, rounds: 1 }, realDeps());

  assert.equal(rA.status, "merged");
  assert.equal(rB.status, "merged");
  const merged = git(["show", "orch/integration:base.txt"], repo);
  assert.match(merged, /TOP/);
  assert.match(merged, /BOTTOM/);
});

test("in-flight peer overlap → merge-deferred before any merge attempt", async () => {
  const repo = newRepo();
  const orchDir = join(repo, ".orch");
  const baseB = makeBranch(repo, orchDir, "pr/codex/b-2", "shared.txt", "B\n");
  // A live peer (not yet landed) has published the same path.
  inflight.register(orchDir, "peer", { branch: "pr/claude/a-1", pid: process.pid, baseSha: baseB });
  inflight.setPaths(orchDir, "peer", ["shared.txt"]);
  try {
    const rB = await finalize({ repo, orchDir, branch: "pr/codex/b-2", sid: "2", baseSha: baseB, paths: ["shared.txt"], testCmd: "true", cfg: { merge: "no-ff", integrationBranch: "orch/integration" }, rounds: 1 }, realDeps());
    assert.equal(rB.status, "merge-deferred");
    assert.match(rB.reason, /overlap/);
  } finally {
    inflight.deregister(orchDir, "peer");
  }
});

test("overlap demote then blocker lands → peer is rebased, re-gated, and auto-lands (#350)", async () => {
  const repo = newRepo();
  const orchDir = join(repo, ".orch");
  // Same file, different lines — stale base, not a true line conflict. Serial
  // execution would land B on top of A; Tier-1 redrive must produce the same.
  writeFileSync(join(repo, "base.txt"), "top\n1\n2\n3\n4\n5\n6\n7\n8\nbottom\n");
  git(["add", "."], repo); git(["commit", "-m", "regions"], repo);
  const baseA = makeBranch(repo, orchDir, "pr/claude/a-1", "base.txt", "TOP\n1\n2\n3\n4\n5\n6\n7\n8\nbottom\n");
  const baseB = makeBranch(repo, orchDir, "pr/codex/b-2", "base.txt", "top\n1\n2\n3\n4\n5\n6\n7\n8\nBOTTOM\n");
  const reviewedA = git(["rev-parse", "refs/heads/pr/claude/a-1"], repo);
  const reviewedB = git(["rev-parse", "refs/heads/pr/codex/b-2"], repo);

  // B finalizes while A is still in-flight → overlap demote + deferred queue.
  inflight.register(orchDir, "1", { branch: "pr/claude/a-1", pid: process.pid, baseSha: baseA });
  inflight.setPaths(orchDir, "1", ["base.txt"]);
  const rB = await finalize({
    repo, orchDir, branch: "pr/codex/b-2", reviewedSha: reviewedB, sid: "2", baseSha: baseB,
    paths: ["base.txt"], testCmd: "true", cfg: { merge: "no-ff", integrationBranch: "orch/integration" }, rounds: 1,
  }, realDeps());
  assert.equal(rB.status, "merge-deferred");
  assert.match(rB.reason, /overlap/);

  // A lands; post-land redrive should rebase + gate + merge B.
  inflight.deregister(orchDir, "1");
  const rA = await finalize({
    repo, orchDir, branch: "pr/claude/a-1", reviewedSha: reviewedA, sid: "1", baseSha: baseA,
    paths: ["base.txt"], testCmd: "true", cfg: { merge: "no-ff", integrationBranch: "orch/integration" }, rounds: 1,
  }, realDeps());
  assert.equal(rA.status, "merged");

  const merged = git(["show", "orch/integration:base.txt"], repo);
  assert.match(merged, /TOP/);
  assert.match(merged, /BOTTOM/);
  // Deferred entry for B must be cleared on successful redrive.
  const { list } = await import("../src/deferred.js");
  assert.equal(list(orchDir).length, 0);
});

test("true line conflict after redrive stays merge-deferred (#350 Tier-1 bound)", async () => {
  const repo = newRepo();
  const orchDir = join(repo, ".orch");
  const baseA = makeBranch(repo, orchDir, "pr/claude/a-1", "shared.txt", "A\n");
  const baseB = makeBranch(repo, orchDir, "pr/codex/b-2", "shared.txt", "B\n");
  const reviewedA = git(["rev-parse", "refs/heads/pr/claude/a-1"], repo);
  const reviewedB = git(["rev-parse", "refs/heads/pr/codex/b-2"], repo);

  inflight.register(orchDir, "1", { branch: "pr/claude/a-1", pid: process.pid, baseSha: baseA });
  inflight.setPaths(orchDir, "1", ["shared.txt"]);
  const rB = await finalize({
    repo, orchDir, branch: "pr/codex/b-2", reviewedSha: reviewedB, sid: "2", baseSha: baseB,
    paths: ["shared.txt"], testCmd: "true", cfg: { merge: "no-ff", integrationBranch: "orch/integration" }, rounds: 1,
  }, realDeps());
  assert.equal(rB.status, "merge-deferred");

  inflight.deregister(orchDir, "1");
  const rA = await finalize({
    repo, orchDir, branch: "pr/claude/a-1", reviewedSha: reviewedA, sid: "1", baseSha: baseA,
    paths: ["shared.txt"], testCmd: "true", cfg: { merge: "no-ff", integrationBranch: "orch/integration" }, rounds: 1,
  }, realDeps());
  assert.equal(rA.status, "merged");

  // Integration has only A's content; B remains deferred for a human.
  assert.match(git(["show", "orch/integration:shared.txt"], repo), /^A\n?$/);
  assert.doesNotMatch(git(["log", "--oneline", "orch/integration"], repo), /add shared\.txt.*B|b-2/);
  const { list, read } = await import("../src/deferred.js");
  assert.equal(list(orchDir).length, 1);
  assert.equal(read(orchDir, "2").redriveAttempts, 1);
  assert.equal(read(orchDir, "2").branch, "pr/codex/b-2");
});

test("clean text merge but post-merge tests fail → demote, integration unchanged", async () => {
  const repo = newRepo();
  const orchDir = join(repo, ".orch");
  const base = makeBranch(repo, orchDir, "pr/claude/a-1", "a.txt", "A\n");
  const before = git(["rev-parse", "main"], repo);

  const deps = realDeps();
  deps.gate = { run: () => ({ pass: false }) }; // post-merge test fails
  const r = await finalize({ repo, orchDir, branch: "pr/claude/a-1", sid: "1", baseSha: base, paths: ["a.txt"], testCmd: "false", cfg: { merge: "no-ff", integrationBranch: "orch/integration" }, rounds: 1 }, deps);

  assert.equal(r.status, "merge-deferred");
  assert.equal(r.trigger, "integration-test");
  assert.match(r.reason, /integration-test/);
  assert.equal(git(["rev-parse", "main"], repo), before); // main was never touched
});
