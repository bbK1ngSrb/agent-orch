import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, branchExists, createTaskBranch, attachExistingBranch, pruneWorktree, mergeIntoMain } from "../src/git.js";

function newRepo() {
  const d = mkdtempSync(join(tmpdir(), "orch-git-"));
  git(["init", "-b", "main"], d);
  git(["config", "user.email", "t@t"], d);
  git(["config", "user.name", "t"], d);
  writeFileSync(join(d, "a.txt"), "1\n");
  git(["add", "."], d);
  git(["commit", "-m", "init"], d);
  return d;
}

test("createTaskBranch lifecycle + ff-only merge", () => {
  const repo = newRepo();
  const wt = join(repo, ".orch", "wt", "b");
  createTaskBranch(repo, wt, "pr/claude/x", "main");
  writeFileSync(join(wt, "b.txt"), "2\n");
  git(["add", "."], wt);
  git(["commit", "-m", "add b"], wt);
  pruneWorktree(repo, wt);

  const r = mergeIntoMain(repo, "pr/claude/x", "ff-only");
  assert.equal(r.ok, true);
  assert.match(git(["log", "--oneline"], repo), /add b/);
});

test("createTaskBranch refuses an existing branch", () => {
  const repo = newRepo();
  git(["branch", "pr/claude/dup"], repo);
  assert.throws(() => createTaskBranch(repo, join(repo, ".orch/wt/d"), "pr/claude/dup", "main"), /already exists/);
});

test("attachExistingBranch refuses a missing branch (F5: no silent create)", () => {
  const repo = newRepo();
  assert.equal(branchExists(repo, "pr/claude/nope"), false);
  assert.throws(() => attachExistingBranch(repo, join(repo, ".orch/wt/n"), "pr/claude/nope"), /does not exist/);
});

test("ff-only merge fails (ok:false) when main moved", () => {
  const repo = newRepo();
  const wt = join(repo, ".orch", "wt", "c");
  createTaskBranch(repo, wt, "pr/claude/y", "main");
  writeFileSync(join(wt, "c.txt"), "3\n");
  git(["add", "."], wt);
  git(["commit", "-m", "add c"], wt);
  pruneWorktree(repo, wt);
  // move main forward so the branch no longer fast-forwards
  writeFileSync(join(repo, "a.txt"), "changed\n");
  git(["add", "."], repo);
  git(["commit", "-m", "move main"], repo);

  const r = mergeIntoMain(repo, "pr/claude/y", "ff-only");
  assert.equal(r.ok, false);
});
