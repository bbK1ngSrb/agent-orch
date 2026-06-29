import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { git, branchExists, branchSyncStatus, createTaskBranch, attachExistingBranch, pruneWorktree, reclaimOrphanWorktrees, ensureIntegrationWorktree, syncWorktreeToMain, mergeInWorktree, changedSince, syncMainFromOrigin, resetMainToOriginIfDiverged } from "../src/git.js";

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

function addOrigin(repo) {
  const remote = mkdtempSync(join(tmpdir(), "orch-remote-"));
  git(["init", "--bare", "-b", "main"], remote);
  git(["remote", "add", "origin", remote], repo);
  git(["push", "-u", "origin", "main"], repo);
  return remote;
}

function cloneRemote(remote) {
  const parent = mkdtempSync(join(tmpdir(), "orch-peer-"));
  const peer = join(parent, "repo");
  git(["clone", remote, peer], parent);
  git(["config", "user.email", "t@t"], peer);
  git(["config", "user.name", "t"], peer);
  return peer;
}

function commitFile(repo, file, text, msg) {
  writeFileSync(join(repo, file), text);
  git(["add", "."], repo);
  git(["commit", "-m", msg], repo);
}

test("createTaskBranch lifecycle + ff-only merge in the integration worktree", () => {
  const repo = newRepo();
  git(["checkout", "-b", "work"], repo); // cwd off main so integration can own main
  const wt = join(repo, ".orch", "wt", "b");
  createTaskBranch(repo, wt, "pr/claude/x", "main", "");
  writeFileSync(join(wt, "b.txt"), "2\n");
  git(["add", "."], wt);
  git(["commit", "-m", "add b"], wt);
  pruneWorktree(repo, wt);

  const integ = ensureIntegrationWorktree(repo, join(repo, ".orch"));
  syncWorktreeToMain(integ);
  const r = mergeInWorktree(integ, "pr/claude/x", "ff-only");
  assert.equal(r.ok, true);
  assert.match(git(["log", "--oneline", "main"], repo), /add b/);
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

test("branchSyncStatus reports a branch at main as synced", () => {
  const repo = newRepo();
  git(["branch", "development"], repo);
  assert.deepEqual(
    branchSyncStatus(repo, "development", "main"),
    {
      ok: true,
      synced: true,
      status: "synced",
      branchSha: git(["rev-parse", "development"], repo),
      baseSha: git(["rev-parse", "main"], repo),
    },
  );
});

test("branchSyncStatus reports development behind main", () => {
  const repo = newRepo();
  git(["branch", "development"], repo);
  commitFile(repo, "main.txt", "main\n", "advance main");
  const r = branchSyncStatus(repo, "development", "main");
  assert.equal(r.ok, true);
  assert.equal(r.synced, false);
  assert.equal(r.status, "behind");
});

test("branchSyncStatus treats same-tree branches as code-synced", () => {
  const repo = newRepo();
  git(["checkout", "-b", "development"], repo);
  commitFile(repo, "marker.txt", "same\n", "add marker");
  git(["checkout", "main"], repo);
  commitFile(repo, "marker.txt", "same\n", "add marker another way");
  const r = branchSyncStatus(repo, "development", "main");
  assert.equal(r.ok, true);
  assert.equal(r.synced, true);
  assert.equal(r.status, "same-tree");
});

test("branchSyncStatus reports diverged branches with different trees", () => {
  const repo = newRepo();
  git(["checkout", "-b", "development"], repo);
  commitFile(repo, "dev.txt", "dev\n", "advance development");
  git(["checkout", "main"], repo);
  commitFile(repo, "main.txt", "main\n", "advance main");
  const r = branchSyncStatus(repo, "development", "main");
  assert.equal(r.ok, true);
  assert.equal(r.synced, false);
  assert.equal(r.status, "diverged");
});

test("merge conflict in the integration worktree returns ok:false and aborts cleanly", () => {
  const repo = newRepo();
  git(["checkout", "-b", "work"], repo);
  // two branches off main that both edit a.txt → real content conflict
  const wt = join(repo, ".orch", "wt", "u");
  createTaskBranch(repo, wt, "pr/claude/u", "main", "");
  writeFileSync(join(wt, "a.txt"), "from branch u\n");
  git(["add", "."], wt); git(["commit", "-m", "edit a (u)"], wt);
  pruneWorktree(repo, wt);
  // advance main with a conflicting edit
  const integ = ensureIntegrationWorktree(repo, join(repo, ".orch"));
  writeFileSync(join(integ, "a.txt"), "from main\n");
  git(["add", "."], integ); git(["commit", "-m", "edit a (main)"], integ);

  const r = mergeInWorktree(integ, "pr/claude/u", "no-ff");
  assert.equal(r.ok, false);
  // worktree left clean (merge aborted) — a fresh merge can run next
  assert.equal(git(["status", "--porcelain"], integ), "");
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

test("ff-only merge fails when main moved past the branch base", () => {
  const repo = newRepo();
  git(["checkout", "-b", "work"], repo);
  const wt = join(repo, ".orch", "wt", "c");
  createTaskBranch(repo, wt, "pr/claude/y", "main", "");
  writeFileSync(join(wt, "c.txt"), "3\n");
  git(["add", "."], wt); git(["commit", "-m", "add c"], wt);
  pruneWorktree(repo, wt);
  const integ = ensureIntegrationWorktree(repo, join(repo, ".orch"));
  writeFileSync(join(integ, "d.txt"), "4\n"); // move main forward (disjoint file)
  git(["add", "."], integ); git(["commit", "-m", "move main"], integ);

  const r = mergeInWorktree(integ, "pr/claude/y", "ff-only");
  assert.equal(r.ok, false); // no longer a fast-forward
});

test("createTaskBranch writes pid\\nsid into the ownership marker", () => {
  const repo = newRepo();
  const wt = join(repo, ".orch", "wt", "pr_claude_m");
  createTaskBranch(repo, wt, "pr/claude/m", "main", `${process.pid}\nabc-1`);
  const marker = readFileSync(`${realpathSync(wt)}.orch-task`, "utf8");
  assert.equal(marker, `${process.pid}\nabc-1`);
  pruneWorktree(repo, wt);
});

test("reclaim PRESERVES a worktree whose owner PID is alive (live peer)", () => {
  const repo = newRepo();
  const orchDir = join(repo, ".orch");
  const wt = join(orchDir, "wt", "pr_claude_live");
  createTaskBranch(repo, wt, "pr/claude/live", "main", `${process.pid}\nlive-1`); // our pid = alive

  reclaimOrphanWorktrees(repo, orchDir);

  assert.equal(branchExists(repo, "pr/claude/live"), true); // live peer untouched
  assert.match(git(["worktree", "list"], repo), /pr_claude_live/);
  pruneWorktree(repo, wt);
});

test("reclaim SWEEPS a worktree whose owner PID is dead", () => {
  const repo = newRepo();
  const orchDir = join(repo, ".orch");
  const wt = join(orchDir, "wt", "pr_claude_dead");
  createTaskBranch(repo, wt, "pr/claude/dead", "main", "999999999\ndead-1"); // PID that cannot run

  reclaimOrphanWorktrees(repo, orchDir);

  assert.equal(branchExists(repo, "pr/claude/dead"), false);
  assert.doesNotMatch(git(["worktree", "list"], repo), /pr_claude_dead/);
});

test("reclaim PRESERVES a dead-pid orphan branch that has committed work (#27)", () => {
  const repo = newRepo();
  const orchDir = join(repo, ".orch");
  const wt = join(orchDir, "wt", "pr_claude_committed");
  createTaskBranch(repo, wt, "pr/claude/committed", "main", "999999999\ncommitted-1"); // dead pid
  // author committed before the kill → branch carries work that must survive
  writeFileSync(join(wt, "authored.txt"), "work\n");
  git(["add", "."], wt); git(["commit", "-m", "author result"], wt);

  reclaimOrphanWorktrees(repo, orchDir);

  assert.equal(branchExists(repo, "pr/claude/committed"), true); // committed work kept for resume
  assert.doesNotMatch(git(["worktree", "list"], repo), /pr_claude_committed/); // worktree still reclaimed
});

test("reclaim SWEEPS a worktree with an empty (pre-PID / died-early) marker", () => {
  const repo = newRepo();
  const orchDir = join(repo, ".orch");
  const wt = join(orchDir, "wt", "pr_claude_empty");
  createTaskBranch(repo, wt, "pr/claude/empty", "main", ""); // legacy empty marker

  reclaimOrphanWorktrees(repo, orchDir);

  assert.equal(branchExists(repo, "pr/claude/empty"), false);
});

test("changedSince lists files merged into main after a base sha", () => {
  const repo = newRepo();
  const base = git(["rev-parse", "main"], repo);
  writeFileSync(join(repo, "new.txt"), "x\n");
  git(["add", "."], repo); git(["commit", "-m", "land new"], repo);
  assert.deepEqual(changedSince(repo, base), ["new.txt"]);
});

test("syncMainFromOrigin fast-forwards local main before new task bases", () => {
  const repo = newRepo();
  const remote = addOrigin(repo);
  const peer = cloneRemote(remote);
  commitFile(peer, "remote.txt", "remote\n", "advance remote");
  git(["push", "origin", "main"], peer);

  const r = syncMainFromOrigin(repo);

  assert.equal(r.ok, true);
  assert.equal(r.updated, true);
  assert.equal(git(["rev-parse", "main"], repo), git(["rev-parse", "origin/main"], repo));
  assert.equal(readFileSync(join(repo, "remote.txt"), "utf8"), "remote\n");
});

test("syncMainFromOrigin uses the remote-tracking main when a local origin/main branch exists", () => {
  const repo = newRepo();
  const remote = addOrigin(repo);
  git(["branch", "origin/main", "main"], repo);
  const staleLocalOriginMain = git(["rev-parse", "refs/heads/origin/main"], repo);
  const peer = cloneRemote(remote);
  commitFile(peer, "remote.txt", "remote\n", "advance remote");
  git(["push", "origin", "main"], peer);

  const r = syncMainFromOrigin(repo);

  assert.equal(r.ok, true);
  assert.equal(r.updated, true);
  assert.equal(git(["rev-parse", "main"], repo), git(["rev-parse", "refs/remotes/origin/main"], repo));
  assert.equal(git(["rev-parse", "refs/heads/origin/main"], repo), staleLocalOriginMain);
  assert.equal(readFileSync(join(repo, "remote.txt"), "utf8"), "remote\n");
});

test("syncMainFromOrigin refuses a local main diverged from origin/main", () => {
  const repo = newRepo();
  const remote = addOrigin(repo);
  const peer = cloneRemote(remote);
  commitFile(peer, "remote.txt", "remote\n", "advance remote");
  git(["push", "origin", "main"], peer);
  commitFile(repo, "local.txt", "local\n", "advance local");

  const r = syncMainFromOrigin(repo);

  assert.equal(r.ok, false);
  assert.match(r.reason, /diverged/);
  assert.notEqual(git(["rev-parse", "main"], repo), git(["rev-parse", "origin/main"], repo));
});

test("resetMainToOriginIfDiverged rolls local main back when origin advanced", () => {
  const repo = newRepo();
  const remote = addOrigin(repo);
  const peer = cloneRemote(remote);
  commitFile(peer, "remote.txt", "remote\n", "advance remote");
  git(["push", "origin", "main"], peer);
  commitFile(repo, "local.txt", "local\n", "advance local");

  const r = resetMainToOriginIfDiverged(repo);

  assert.equal(r.rolledBack, true);
  assert.equal(git(["rev-parse", "main"], repo), git(["rev-parse", "origin/main"], repo));
  assert.equal(readFileSync(join(repo, "remote.txt"), "utf8"), "remote\n");
});

test("reclaim PRESERVES a worktree whose branch is in liveBranches even when marker has dead pid (final-review I3)", () => {
  const repo = newRepo();
  const orchDir = join(repo, ".orch");
  const wt = join(orchDir, "wt", "pr_claude_inflight");
  createTaskBranch(repo, wt, "pr/claude/inflight", "main", "999999999\ninflight-1"); // dead pid — would normally be swept
  // pass the branch as live-in-flight → must be preserved (marker-before-add race)
  reclaimOrphanWorktrees(repo, orchDir, new Set(["pr/claude/inflight"]));
  assert.equal(branchExists(repo, "pr/claude/inflight"), true); // branch preserved
  assert.match(git(["worktree", "list"], repo), /pr_claude_inflight/); // worktree preserved
  pruneWorktree(repo, wt); // cleanup
});

test("reclaim still sweeps a dead-pid worktree NOT listed in liveBranches", () => {
  const repo = newRepo();
  const orchDir = join(repo, ".orch");
  const wt = join(orchDir, "wt", "pr_claude_deadx");
  createTaskBranch(repo, wt, "pr/claude/deadx", "main", "999999999\ndead-x"); // dead pid
  // pass a different branch as live — deadx is not protected
  reclaimOrphanWorktrees(repo, orchDir, new Set(["pr/claude/some-other"]));
  assert.equal(branchExists(repo, "pr/claude/deadx"), false); // swept
  assert.doesNotMatch(git(["worktree", "list"], repo), /pr_claude_deadx/);
});

test("reclaim never sweeps the .orch/integration worktree", () => {
  const repo = newRepo();
  git(["checkout", "-b", "work"], repo);
  const orchDir = join(repo, ".orch");
  ensureIntegrationWorktree(repo, orchDir);
  reclaimOrphanWorktrees(repo, orchDir);
  assert.match(git(["worktree", "list"], repo), /integration/); // outside wt/ → untouched
});
