import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, currentBranch, detachToMain, deleteBranchSafe, forceDeleteBranch, pushMain } from "../src/git.js";

function newRepo() {
  const d = mkdtempSync(join(tmpdir(), "orch-complete-"));
  git(["init", "-b", "main"], d);
  git(["config", "user.email", "t@t"], d);
  git(["config", "user.name", "t"], d);
  writeFileSync(join(d, "a.txt"), "1\n");
  git(["add", "."], d);
  git(["commit", "-m", "init"], d);
  return d;
}

test("currentBranch reports the branch, and 'HEAD' when detached", () => {
  const repo = newRepo();
  assert.equal(currentBranch(repo), "main");
  git(["switch", "--detach", "HEAD"], repo);
  assert.equal(currentBranch(repo), "HEAD");
});

// The load-bearing assumption: a linked worktree owns `main`, yet the primary
// checkout must still be able to detach onto main's tip so its old branch frees up.
test("detachToMain works even while another worktree owns main", () => {
  const repo = newRepo();
  writeFileSync(join(repo, "a.txt"), "2\n"); git(["commit", "-am", "second"], repo);
  const mainSha = git(["rev-parse", "main"], repo);
  // operator is parked on a fresh orch branch first (what switchFromMain does),
  // freeing `main` for the integration worktree to squat — the real run order.
  git(["switch", "-c", "orch/foo"], repo);
  git(["worktree", "add", join(repo, ".orch", "integration"), "main"], repo);

  detachToMain(repo);

  assert.equal(currentBranch(repo), "HEAD");                 // detached, not on a branch
  assert.equal(git(["rev-parse", "HEAD"], repo), mainSha);   // at main's tip
});

test("deleteBranchSafe deletes a merged branch, refuses an unmerged one", () => {
  const repo = newRepo();
  git(["branch", "merged-b"], repo);                         // points at main → merged
  assert.deepEqual(deleteBranchSafe(repo, "merged-b"), { ok: true });

  git(["switch", "-c", "feature"], repo);
  writeFileSync(join(repo, "f.txt"), "x\n"); git(["add", "."], repo); git(["commit", "-m", "f"], repo);
  git(["switch", "--detach", "main"], repo);                 // leave feature, don't check it out
  const r = deleteBranchSafe(repo, "feature");
  assert.equal(r.ok, false);
  assert.equal(r.unmerged, true);                            // work would be lost → caller must gate
});

// Regression: judge "merged" against main, not the current HEAD. If a detach failed,
// HEAD is still the operator's branch — a cycle branch merged into main must STILL be
// deletable (else it's falsely flagged as unmerged leftover).
test("deleteBranchSafe deletes a main-merged branch even while HEAD is on another branch", () => {
  const repo = newRepo();
  git(["switch", "-c", "feature"], repo);
  writeFileSync(join(repo, "f.txt"), "x\n"); git(["add", "."], repo); git(["commit", "-m", "f"], repo);
  git(["switch", "main"], repo); git(["merge", "--no-ff", "feature", "-m", "merge"], repo);
  git(["switch", "-c", "operator-branch"], repo);   // HEAD is NOT main now
  assert.deepEqual(deleteBranchSafe(repo, "feature"), { ok: true }); // still seen as merged-into-main
});

test("forceDeleteBranch drops an unmerged branch", () => {
  const repo = newRepo();
  git(["switch", "-c", "feature"], repo);
  writeFileSync(join(repo, "f.txt"), "x\n"); git(["add", "."], repo); git(["commit", "-m", "f"], repo);
  git(["switch", "--detach", "main"], repo);
  forceDeleteBranch(repo, "feature");
  assert.throws(() => git(["rev-parse", "--verify", "refs/heads/feature"], repo));
});

test("pushMain reports a clean failure when there is no remote (never throws)", () => {
  const repo = newRepo();
  const r = pushMain(repo);
  assert.equal(r.ok, false);
  assert.ok(typeof r.reason === "string" && r.reason.length > 0);
});

test("pushMain fast-forwards an existing remote", () => {
  const remote = mkdtempSync(join(tmpdir(), "orch-remote-"));
  git(["init", "--bare", "-b", "main"], remote);
  const repo = newRepo();
  git(["remote", "add", "origin", remote], repo);
  git(["push", "-u", "origin", "main"], repo);
  writeFileSync(join(repo, "a.txt"), "2\n"); git(["commit", "-am", "second"], repo);
  const r = pushMain(repo);
  assert.equal(r.ok, true);
  assert.equal(git(["rev-parse", "main"], remote), git(["rev-parse", "main"], repo));
});
