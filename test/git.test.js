import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { git, branchExists, createTaskBranch, attachExistingBranch, pruneWorktree, mergeIntoMain, reclaimOrphanWorktrees } from "../src/git.js";

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

test("untracked collision -> advice names the files, not a rebase", () => {
  const repo = newRepo();
  const wt = join(repo, ".orch", "wt", "u");
  createTaskBranch(repo, wt, "pr/claude/u", "main");
  writeFileSync(join(wt, "spec.md"), "from branch\n");
  git(["add", "."], wt);
  git(["commit", "-m", "add spec"], wt);
  pruneWorktree(repo, wt);
  // same path exists untracked in main's working tree
  writeFileSync(join(repo, "spec.md"), "local untracked\n");

  const r = mergeIntoMain(repo, "pr/claude/u", "ff-only");
  assert.equal(r.ok, false);
  assert.match(r.advice, /untracked files in main/);
  assert.match(r.advice, /spec\.md/);
});

test("reclaimOrphanWorktrees removes a crashed cycle's worktree AND its branch", () => {
  const repo = newRepo();
  const orchDir = join(repo, ".orch");
  // simulate a cycle that died before its finally: worktree + branch left behind
  const wt = join(orchDir, "wt", "pr_claude_orphan");
  createTaskBranch(repo, wt, "pr/claude/orphan", "main");
  assert.equal(branchExists(repo, "pr/claude/orphan"), true);

  reclaimOrphanWorktrees(repo, orchDir);

  assert.equal(branchExists(repo, "pr/claude/orphan"), false); // same-slug retry can now re-create it
  assert.doesNotMatch(git(["worktree", "list"], repo), /pr_claude_orphan/);
});

test("reclaimOrphanWorktrees PRESERVES a review-attached user branch (only sweeps the worktree)", () => {
  const repo = newRepo();
  const orchDir = join(repo, ".orch");
  // a human's real branch, attached for `orch review` — NOT orch-created
  git(["branch", "feature/human"], repo);
  const wt = join(orchDir, "wt", "feature_human");
  attachExistingBranch(repo, wt, "feature/human"); // review mode: no ownership marker

  reclaimOrphanWorktrees(repo, orchDir);

  assert.equal(branchExists(repo, "feature/human"), true); // user branch must survive a crashed review
  assert.doesNotMatch(git(["worktree", "list"], repo), /feature_human/); // worktree still reclaimed
});

test("createTaskBranch leaves no marker behind after a normal prune", () => {
  const repo = newRepo();
  const wt = join(repo, ".orch", "wt", "pr_claude_z");
  createTaskBranch(repo, wt, "pr/claude/z", "main");
  pruneWorktree(repo, wt);
  assert.equal(existsSync(`${wt}.orch-task`), false);
});

test("reclaimOrphanWorktrees leaves the main worktree and other branches alone", () => {
  const repo = newRepo();
  git(["branch", "keep/me"], repo); // a branch with no orphan worktree
  reclaimOrphanWorktrees(repo, join(repo, ".orch"));
  assert.equal(branchExists(repo, "keep/me"), true);
  assert.equal(branchExists(repo, "main"), true);
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
