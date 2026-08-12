import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, deleteBranchSafe, forceDeleteBranch } from "../src/git.js";

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
