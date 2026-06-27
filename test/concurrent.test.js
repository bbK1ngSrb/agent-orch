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
    github: { demote: async ({ branch }) => ({ prUrl: null }) }, // no remote → local escalate
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
  git(["checkout", "-b", "work"], d); // cwd off main
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

test("two disjoint branches both auto-merge into main", async () => {
  const repo = newRepo();
  const orchDir = join(repo, ".orch");
  const baseA = makeBranch(repo, orchDir, "pr/claude/a-1", "a.txt", "A\n");
  const baseB = makeBranch(repo, orchDir, "pr/codex/b-2", "b.txt", "B\n");

  const rA = await finalize({ repo, orchDir, branch: "pr/claude/a-1", sid: "1", baseSha: baseA, paths: ["a.txt"], testCmd: "true", cfg: { merge: "no-ff" }, rounds: 1 }, realDeps());
  const rB = await finalize({ repo, orchDir, branch: "pr/codex/b-2", sid: "2", baseSha: baseB, paths: ["b.txt"], testCmd: "true", cfg: { merge: "no-ff" }, rounds: 1 }, realDeps());

  assert.equal(rA.status, "merged");
  assert.equal(rB.status, "merged");
  const log = git(["log", "--oneline", "main"], repo);
  assert.match(log, /add a.txt/);
  assert.match(log, /add b.txt/);
});

test("overlapping branches: first merges, second demotes (overlap)", async () => {
  const repo = newRepo();
  const orchDir = join(repo, ".orch");
  const baseA = makeBranch(repo, orchDir, "pr/claude/a-1", "shared.txt", "A\n");
  const baseB = makeBranch(repo, orchDir, "pr/codex/b-2", "shared.txt", "B\n");

  const rA = await finalize({ repo, orchDir, branch: "pr/claude/a-1", sid: "1", baseSha: baseA, paths: ["shared.txt"], testCmd: "true", cfg: { merge: "no-ff" }, rounds: 1 }, realDeps());
  const rB = await finalize({ repo, orchDir, branch: "pr/codex/b-2", sid: "2", baseSha: baseB, paths: ["shared.txt"], testCmd: "true", cfg: { merge: "no-ff" }, rounds: 1 }, realDeps());

  assert.equal(rA.status, "merged");
  assert.equal(rB.status, "pr-fallback");
  assert.match(rB.reason, /overlap/);
});

test("clean text merge but post-merge tests fail → demote, main unchanged", async () => {
  const repo = newRepo();
  const orchDir = join(repo, ".orch");
  const base = makeBranch(repo, orchDir, "pr/claude/a-1", "a.txt", "A\n");
  const before = git(["rev-parse", "main"], repo);

  const deps = realDeps();
  deps.gate = { run: () => ({ pass: false }) }; // post-merge test fails
  const r = await finalize({ repo, orchDir, branch: "pr/claude/a-1", sid: "1", baseSha: base, paths: ["a.txt"], testCmd: "false", cfg: { merge: "no-ff" }, rounds: 1 }, deps);

  assert.equal(r.status, "pr-fallback");
  assert.match(r.reason, /post-merge-test-fail/);
  assert.equal(git(["rev-parse", "main"], repo), before); // main rolled back
});
