import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { git, gitTry, branchExists, branchSyncStatus, createTaskBranch, attachExistingBranch, pruneWorktree, reclaimOrphanWorktrees, ensureIntegrationWorktree, syncWorktreeToIntegration, reconcileIntegrationToBase, reconcileIntegrationToOrigin, mergeInWorktree, rebaseBranchOnto, changedFiles, syncMainFromOrigin, bumpVersion, verifyOriginContains, fetchOriginMain, normalizePathForCompare, deleteRemoteBranch, worktreeRecords } from "../src/git.js";
import { checkPaths } from "../src/intake/allowlist.js";

function newRepo() {
  const d = mkdtempSync(join(tmpdir(), "orch-git-"));
  git(["init", "-b", "main"], d);
  git(["config", "user.email", "t@t"], d);
  git(["config", "user.name", "t"], d);
  // core.autocrlf defaults to true on Windows git installs and rewrites LF to
  // CRLF on checkout, which would make file-content assertions below platform-
  // dependent. Keep content byte-identical to what was written.
  git(["config", "core.autocrlf", "false"], d);
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

function addOriginNamed(repo, branch) {
  const remote = mkdtempSync(join(tmpdir(), "orch-remote-"));
  git(["init", "--bare", "-b", branch], remote);
  git(["remote", "add", "origin", remote], repo);
  git(["push", "-u", "origin", branch], repo);
  return remote;
}

function cloneRemote(remote) {
  const parent = mkdtempSync(join(tmpdir(), "orch-peer-"));
  const peer = join(parent, "repo");
  git(["clone", remote, peer], parent);
  git(["config", "user.email", "t@t"], peer);
  git(["config", "user.name", "t"], peer);
  git(["config", "core.autocrlf", "false"], peer);
  return peer;
}

function commitFile(repo, file, text, msg) {
  writeFileSync(join(repo, file), text);
  git(["add", "."], repo);
  git(["commit", "-m", msg], repo);
}

test("worktreeRecords keeps detached records separate from branch records", () => {
  const records = [...worktreeRecords([
    "worktree /repo",
    "HEAD abc",
    "branch refs/heads/main",
    "",
    "worktree /detached",
    "HEAD def",
    "detached",
    "",
    "worktree /feature",
    "HEAD ghi",
    "branch refs/heads/feature",
  ].join("\n"))];

  assert.deepEqual(records, [
    { path: "/repo", branch: "main" },
    { path: "/detached", branch: null, detached: true },
    { path: "/feature", branch: "feature" },
  ]);
});

test("createTaskBranch lifecycle + ff-only merge in the integration worktree", () => {
  const repo = newRepo();
  const wt = join(repo, ".orch", "wt", "b");
  createTaskBranch(repo, wt, "pr/claude/x", "main", "");
  writeFileSync(join(wt, "b.txt"), "2\n");
  git(["add", "."], wt);
  git(["commit", "-m", "add b"], wt);
  pruneWorktree(repo, wt);

  const integ = ensureIntegrationWorktree(repo, join(repo, ".orch"));
  syncWorktreeToIntegration(integ);
  const r = mergeInWorktree(integ, "pr/claude/x", "ff-only");
  assert.equal(r.ok, true);
  assert.match(git(["log", "--oneline", "orch/integration"], repo), /add b/);
  assert.doesNotMatch(git(["log", "--oneline", "main"], repo), /add b/);
});

test("rebaseBranchOnto rebases the reviewed commit and advances the branch with CAS", () => {
  const repo = newRepo();
  git(["checkout", "-b", "feature"], repo);
  commitFile(repo, "feature.txt", "feature\n", "feature");
  const reviewedSha = git(["rev-parse", "HEAD"], repo);
  git(["checkout", "main"], repo);
  commitFile(repo, "main.txt", "main\n", "advance main");
  mkdirSync(join(repo, ".orch", "wt"), { recursive: true });

  const r = rebaseBranchOnto(repo, join(repo, ".orch"), "feature", "main", reviewedSha);

  assert.equal(r.ok, true);
  assert.equal(git(["rev-parse", "feature"], repo), r.sha);
  assert.notEqual(r.sha, reviewedSha);
  assert.equal(gitTry(["merge-base", "--is-ancestor", "main", "feature"], repo).ok, true);
});

test("rebaseBranchOnto refuses to replace a branch that moved past the reviewed commit", () => {
  const repo = newRepo();
  git(["checkout", "-b", "feature"], repo);
  commitFile(repo, "feature.txt", "feature\n", "feature");
  const reviewedSha = git(["rev-parse", "HEAD"], repo);
  git(["checkout", "main"], repo);
  commitFile(repo, "main.txt", "main\n", "advance main");
  const movedSha = git(["rev-parse", "main"], repo);
  git(["update-ref", "refs/heads/feature", movedSha], repo);
  mkdirSync(join(repo, ".orch", "wt"), { recursive: true });

  const r = rebaseBranchOnto(repo, join(repo, ".orch"), "feature", "main", reviewedSha);

  assert.equal(r.ok, false);
  assert.equal(r.moved, true);
  assert.equal(git(["rev-parse", "feature"], repo), movedSha);
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

  const r = reclaimOrphanWorktrees(repo, orchDir);

  assert.equal(r.recovered, true);
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
  const r = reclaimOrphanWorktrees(repo, join(repo, ".orch"));
  assert.equal(r.recovered, false);
  assert.equal(branchExists(repo, "keep/me"), true);
  assert.equal(branchExists(repo, "main"), true);
});

test("ensureIntegrationWorktree uses a dedicated branch and leaves main available", () => {
  const repo = newRepo();

  const integ = ensureIntegrationWorktree(repo, join(repo, ".orch"));
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], integ), "orch/integration");
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], repo), "main");

  // simulate the worktree drifting off the integration branch (crash mid-op, manual
  // recovery) — the merge commit would then land on a detached HEAD and
  // refs/heads/orch/integration would silently never advance
  git(["switch", "--detach", "orch/integration"], integ);

  const wt = join(repo, ".orch", "wt", "b");
  createTaskBranch(repo, wt, "pr/claude/x", "main", "");
  writeFileSync(join(wt, "b.txt"), "2\n");
  git(["add", "."], wt);
  git(["commit", "-m", "add b"], wt);
  pruneWorktree(repo, wt);

  // reused on a later cycle: must reattach before anything merges into it
  const integ2 = ensureIntegrationWorktree(repo, join(repo, ".orch"));
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], integ2), "orch/integration");

  const r = mergeInWorktree(integ2, "pr/claude/x", "ff-only");
  assert.equal(r.ok, true);
  assert.match(git(["log", "--oneline", "orch/integration"], repo), /add b/); // integration branch actually advanced
  assert.doesNotMatch(git(["log", "--oneline", "main"], repo), /add b/);
});

test("changedFiles diffs against a custom base branch", () => {
  const repo = newRepo();
  git(["checkout", "-b", "dev"], repo);
  git(["checkout", "-b", "feature"], repo);
  commitFile(repo, "f.txt", "x\n", "add f");
  assert.deepEqual(changedFiles(repo, "feature", "dev"), ["f.txt"]);

  git(["checkout", "dev"], repo);
  git(["merge", "feature"], repo);
  git(["checkout", "feature"], repo);
  assert.deepEqual(changedFiles(repo, "feature", "dev"), []);
});

// Drive changedFiles against real git output for paths that need -z (control
// chars / C-quoting) and paths that would be corrupted by .trim(). Then feed
// the result into checkPaths so §3c cannot silently allow a protected touch.
test("changedFiles preserves newline-in-name paths from real git -z output", () => {
  const repo = newRepo();
  git(["checkout", "-b", "feature"], repo);
  mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
  const weird = ".github/workflows/a\nb.yml";
  writeFileSync(join(repo, weird), "on: push\n");
  git(["add", "-A"], repo);
  git(["commit", "-m", "weird workflow name"], repo);

  const files = changedFiles(repo, "feature", "main");
  assert.ok(files.includes(weird), `expected exact path in ${JSON.stringify(files)}`);
  // Distinguishes a real Item-2 fix: checkPaths must see the real path bytes.
  const prot = checkPaths(files);
  assert.equal(prot.ok, false);
  assert.ok(prot.violations.includes(weird));
});

test("changedFiles preserves leading and trailing spaces in filenames", () => {
  const repo = newRepo();
  git(["checkout", "-b", "feature"], repo);
  writeFileSync(join(repo, " leading.txt"), "x\n");
  writeFileSync(join(repo, "trailing.txt "), "y\n");
  git(["add", "-A"], repo);
  git(["commit", "-m", "spaced names"], repo);

  const files = changedFiles(repo, "feature", "main").sort();
  assert.deepEqual(files, [" leading.txt", "trailing.txt "]);
});

// Real-git drive of the same gitTry + -z unmerged listing used by
// resolveIntegrationConflict (cli.js). A conflicted path that is exactly
// allowed-paths joined by newlines must stay one intact path so the metaOnly
// whitelist cannot treat fragments as separate allowed files.
test("unmerged -z listing preserves newline-in-name conflicted paths from real git", () => {
  const repo = newRepo();
  const forged = "CHANGELOG.md\npackage.json";
  const allowed = new Set(["CHANGELOG.md", "package.json"]);

  // Side A (main) and side B (feature) add different content at the same path
  // → add/add conflict on merge.
  git(["checkout", "-b", "feature"], repo);
  writeFileSync(join(repo, forged), "feature side\n");
  git(["add", "-A"], repo);
  git(["commit", "-m", "forged path on feature"], repo);

  git(["checkout", "main"], repo);
  writeFileSync(join(repo, forged), "main side\n");
  git(["add", "-A"], repo);
  git(["commit", "-m", "forged path on main"], repo);

  const merge = gitTry(["merge", "--no-edit", "feature"], repo);
  assert.equal(merge.ok, false, "merge must conflict");

  // Same command + parse as src/cli.js conflict listing (gitTry, no .trim()).
  const listed = gitTry(["diff", "--name-only", "-z", "--diff-filter=U"], repo);
  assert.equal(listed.ok, true);
  const conflicts = listed.out.split("\0").filter(Boolean);
  assert.ok(conflicts.includes(forged), `expected exact path in ${JSON.stringify(conflicts)}`);
  assert.equal(conflicts.length, 1, "forged path must not tear into two entries");
  const metaOnly = conflicts.length > 0 && conflicts.every((p) => allowed.has(p));
  assert.equal(metaOnly, false, "forged newline-joined path must not pass the metaOnly whitelist");

  // Without -z, git C-quotes control chars — quoted form is not the real path
  // and is not in allowed either; -z is what makes the listing path-true.
  const quoted = git(["diff", "--name-only", "--diff-filter=U"], repo);
  assert.notEqual(quoted, forged);
  assert.ok(!allowed.has(quoted.replace(/\n$/, "")), "C-quoted listing must not match an allowed path");
});

// git()'s .trim() would collapse " CHANGELOG.md" into the whitelist entry;
// production must use gitTry so the exact path fails metaOnly.
test("unmerged -z listing preserves leading-space paths (no trim) from real git", () => {
  const repo = newRepo();
  const spaced = " CHANGELOG.md";
  const allowed = new Set(["CHANGELOG.md"]);

  git(["checkout", "-b", "feature"], repo);
  writeFileSync(join(repo, spaced), "feature side\n");
  git(["add", "-A"], repo);
  git(["commit", "-m", "spaced path on feature"], repo);

  git(["checkout", "main"], repo);
  writeFileSync(join(repo, spaced), "main side\n");
  git(["add", "-A"], repo);
  git(["commit", "-m", "spaced path on main"], repo);

  const merge = gitTry(["merge", "--no-edit", "feature"], repo);
  assert.equal(merge.ok, false, "merge must conflict");

  const listed = gitTry(["diff", "--name-only", "-z", "--diff-filter=U"], repo);
  assert.equal(listed.ok, true);
  const conflicts = listed.out.split("\0").filter(Boolean);
  assert.ok(conflicts.includes(spaced), `expected exact path in ${JSON.stringify(conflicts)}`);
  const metaOnly = conflicts.length > 0 && conflicts.every((p) => allowed.has(p));
  assert.equal(metaOnly, false, "leading-space path must not pass the metaOnly whitelist");

  // Contrast: git() trims and would forge a whitelist hit — the bug this guards.
  const trimmed = git(["diff", "--name-only", "-z", "--diff-filter=U"], repo).split("\0").filter(Boolean);
  assert.ok(trimmed.every((p) => allowed.has(p)), "trim path is the forgery class under test");
});

test("ensureIntegrationWorktree branches the fresh integration branch off a custom base", () => {
  const repo = newRepo();
  git(["checkout", "-b", "dev"], repo);
  commitFile(repo, "d.txt", "1\n", "dev-only commit");

  const integ = ensureIntegrationWorktree(repo, join(repo, ".orch"), "orch/integration", "dev");

  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], integ), "orch/integration");
  assert.match(git(["log", "--oneline", "orch/integration"], repo), /dev-only commit/);
});

test("reconcileIntegrationToBase fast-forwards integration when it is cleanly behind base", () => {
  const repo = newRepo();
  const integ = ensureIntegrationWorktree(repo, join(repo, ".orch"));
  git(["checkout", "main"], repo);
  writeFileSync(join(repo, "main.txt"), "main\n");
  git(["add", "main.txt"], repo);
  git(["commit", "-m", "advance main"], repo);
  syncWorktreeToIntegration(integ);

  const r = reconcileIntegrationToBase(integ, "main");

  assert.equal(r.ok, true);
  assert.equal(r.updated, true);
  assert.equal(git(["rev-parse", "orch/integration"], repo), git(["rev-parse", "main"], repo));
});

test("reconcileIntegrationToBase never rewrites integration-only commits", () => {
  const repo = newRepo();
  const integ = ensureIntegrationWorktree(repo, join(repo, ".orch"));
  commitFile(integ, "integration.txt", "integration\n", "advance integration");
  git(["checkout", "main"], repo);
  writeFileSync(join(repo, "main.txt"), "main\n");
  git(["add", "main.txt"], repo);
  git(["commit", "-m", "advance main"], repo);
  syncWorktreeToIntegration(integ);
  const before = git(["rev-parse", "orch/integration"], repo);

  const r = reconcileIntegrationToBase(integ, "main");

  assert.equal(r.ok, true);
  assert.equal(r.updated, false);
  assert.equal(r.skipped, "not-fast-forward");
  assert.equal(git(["rev-parse", "orch/integration"], repo), before);
});

// Shared setup for the origin-reconcile tests: a repo whose integration branch
// exists on origin, plus a peer clone standing in for the human who hand-lands
// an escalated fix straight on origin/orch/integration.
function integrationWithOrigin() {
  const repo = newRepo();
  const remote = addOrigin(repo);
  const integ = ensureIntegrationWorktree(repo, join(repo, ".orch"));
  git(["push", "-u", "origin", "orch/integration"], repo);
  const peer = cloneRemote(remote);
  git(["checkout", "orch/integration"], peer);
  return { repo, integ, peer };
}

test("reconcileIntegrationToOrigin fast-forwards integration onto a hand-landed origin commit", () => {
  const { repo, integ, peer } = integrationWithOrigin();
  commitFile(peer, "handlanded.txt", "escalation fix\n", "hand-landed escalation fix");
  git(["push", "origin", "orch/integration"], peer);
  syncWorktreeToIntegration(integ);

  const r = reconcileIntegrationToOrigin(integ);

  assert.equal(r.ok, true);
  assert.equal(r.updated, true);
  // The branch ref — not just worktree HEAD — must move: the push that failed in
  // the reported defect reads refs/heads/orch/integration.
  assert.equal(
    git(["rev-parse", "orch/integration"], repo),
    git(["rev-parse", "refs/remotes/origin/orch/integration"], repo),
  );
  assert.equal(readFileSync(join(integ, "handlanded.txt"), "utf8"), "escalation fix\n");
});

test("reconcileIntegrationToOrigin is a no-op when local integration is ahead of origin", () => {
  const { repo, integ } = integrationWithOrigin();
  commitFile(integ, "local.txt", "local\n", "local land not yet pushed");
  const before = git(["rev-parse", "orch/integration"], repo);

  const r = reconcileIntegrationToOrigin(integ);

  assert.equal(r.ok, true);
  assert.equal(r.updated, false);
  // Not the no-remote-branch skip: origin has the branch, so the fetch really ran.
  assert.equal(r.skipped, undefined);
  assert.equal(git(["rev-parse", "orch/integration"], repo), before);
});

test("reconcileIntegrationToOrigin refuses a divergence instead of discarding either side", () => {
  const { repo, integ, peer } = integrationWithOrigin();
  commitFile(peer, "remote.txt", "remote\n", "hand-landed on origin");
  git(["push", "origin", "orch/integration"], peer);
  commitFile(integ, "local.txt", "local\n", "landed only locally");
  const before = git(["rev-parse", "orch/integration"], repo);

  const r = reconcileIntegrationToOrigin(integ);

  assert.equal(r.ok, false);
  assert.match(r.reason, /diverged/);
  assert.equal(git(["rev-parse", "orch/integration"], repo), before);
});

test("reconcileIntegrationToOrigin skips when origin has no integration branch yet", () => {
  const repo = newRepo();
  addOrigin(repo);
  const integ = ensureIntegrationWorktree(repo, join(repo, ".orch"));

  const r = reconcileIntegrationToOrigin(integ);

  assert.equal(r.ok, true);
  assert.equal(r.skipped, true);
});

test("ff-only merge fails when integration moved past the branch base", () => {
  const repo = newRepo();
  git(["checkout", "-b", "work"], repo);
  const wt = join(repo, ".orch", "wt", "c");
  createTaskBranch(repo, wt, "pr/claude/y", "main", "");
  writeFileSync(join(wt, "c.txt"), "3\n");
  git(["add", "."], wt); git(["commit", "-m", "add c"], wt);
  pruneWorktree(repo, wt);
  const integ = ensureIntegrationWorktree(repo, join(repo, ".orch"));
  writeFileSync(join(integ, "d.txt"), "4\n"); // move integration forward (disjoint file)
  git(["add", "."], integ); git(["commit", "-m", "move integration"], integ);

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

// #134: Windows paths are case-insensitive at the filesystem level, but
// git.exe's own realpath normalization and Node's realpathSync don't always
// agree on segment/drive-letter casing for the SAME real directory (e.g. a
// drive letter reported as `C:` by one and `c:` by the other). A
// case-sensitive prefix match then silently treats a real orphan as outside
// wtRoot, so nothing ever gets swept. This fixes that specific case-folding
// mismatch — it does not address a from-scratch 8.3-short-name-vs-long-name
// *alias* difference (e.g. "RUNNER~1" vs "runneradmin" are different strings,
// not just different casing of the same string; if realpathSync fails to
// expand a short name to long form at all, that's a separate, deeper issue
// this normalization can't paper over).
test("normalizePathForCompare: case-insensitive on win32, case-sensitive on POSIX", () => {
  const mixedCase = "C:/Users/Runner/wt/pr_claude_x";
  const lower = "c:/users/runner/wt/pr_claude_x";
  assert.equal(normalizePathForCompare(mixedCase, "win32"), normalizePathForCompare(lower, "win32"));
  assert.notEqual(normalizePathForCompare(mixedCase, "linux"), normalizePathForCompare(lower, "linux"));
  // backslashes normalized to forward slashes regardless of platform
  assert.equal(normalizePathForCompare("C:\\a\\b", "win32"), "c:/a/b");
  assert.equal(normalizePathForCompare("/a/b", "linux"), "/a/b");
});

test("#134: reclaim still sweeps an orphan on win32 even when git reports a differently-cased path", () => {
  const repo = newRepo();
  const orchDir = join(repo, ".orch");
  const wt = join(orchDir, "wt", "pr_claude_cased");
  createTaskBranch(repo, wt, "pr/claude/cased", "main");
  assert.equal(branchExists(repo, "pr/claude/cased"), true);

  // Simulate the real-world mismatch directly: reclaimOrphanWorktrees's own
  // wtRoot is derived from realpathSync(orchDir), which on this (POSIX) test
  // host agrees in case with what `git worktree list` reports — there's no way
  // to manufacture a genuine case divergence without an actual Windows
  // filesystem. So this asserts the platform="win32" path takes the SAME
  // sweep decision as the default POSIX path for a same-case input — i.e. the
  // win32 branch doesn't accidentally skip or double-remove anything on the
  // happy path — while normalizePathForCompare (tested above) proves the
  // actual case-folding logic that fixes the real mismatch.
  const r = reclaimOrphanWorktrees(repo, orchDir, new Set(), { platform: "win32" });

  assert.equal(r.recovered, true);
  assert.equal(branchExists(repo, "pr/claude/cased"), false);
});

test("fetchOriginMain retries and succeeds on transient ref-lock contention", () => {
  const repo = newRepo();
  addOrigin(repo);
  let calls = 0;
  const sleeps = [];
  const r = fetchOriginMain(repo, {
    sleep: (ms) => sleeps.push(ms),
    fetch: () => {
      calls++;
      return calls < 3
        ? { ok: false, out: "error: cannot lock ref 'refs/remotes/origin/main': is at X but expected Y\n" }
        : { ok: true, out: "" };
    },
  });

  assert.equal(r.ok, true);
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [50, 100]);
});

test("fetchOriginMain gives up after exhausting retries on persistent ref-lock contention", () => {
  const repo = newRepo();
  addOrigin(repo);
  let calls = 0;

  const r = fetchOriginMain(repo, {
    sleep: () => {},
    fetch: () => {
      calls++;
      return { ok: false, out: "error: cannot lock ref 'refs/remotes/origin/main': is at X but expected Y\n" };
    },
  });

  assert.equal(r.ok, false);
  assert.match(r.reason, /cannot lock ref/);
  assert.equal(calls, 3); // initial attempt + 2 retries
});

test("fetchOriginMain does not retry non-lock fetch failures", () => {
  const repo = newRepo();
  addOrigin(repo);
  let calls = 0;

  const r = fetchOriginMain(repo, {
    sleep: () => { throw new Error("should not sleep"); },
    fetch: () => {
      calls++;
      return { ok: false, out: "fatal: could not resolve host\n" };
    },
  });

  assert.equal(r.ok, false);
  assert.match(r.reason, /could not resolve host/);
  assert.equal(calls, 1);
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

test("syncMainFromOrigin refuses local main ahead of origin/main", () => {
  const repo = newRepo();
  addOrigin(repo);
  commitFile(repo, "local.txt", "local\n", "advance local");

  const r = syncMainFromOrigin(repo);

  assert.equal(r.ok, false);
  assert.match(r.reason, /ahead/);
});

test("syncMainFromOrigin follows a custom base branch, not main", () => {
  const repo = newRepo();
  git(["checkout", "-b", "dev"], repo);
  const remote = addOriginNamed(repo, "dev");

  const peer = cloneRemote(remote);
  git(["checkout", "dev"], peer);
  commitFile(peer, "c.txt", "3\n", "peer commit on dev");
  git(["push", "origin", "dev"], peer);

  const r = syncMainFromOrigin(repo, "dev");

  assert.equal(r.ok, true);
  assert.equal(r.updated, true);
  assert.match(git(["log", "--oneline", "dev"], repo), /peer commit on dev/);
});

test("verifyOriginContains checks ancestry against refs/remotes/origin/main", () => {
  const repo = newRepo();
  addOrigin(repo);
  commitFile(repo, "local.txt", "local\n", "advance local");
  const local = git(["rev-parse", "main"], repo);

  const beforePush = verifyOriginContains(repo, local);
  assert.equal(beforePush.ok, false);
  assert.match(beforePush.reason, /not contained in origin\/main/);

  git(["push", "origin", "main"], repo);
  assert.deepEqual(verifyOriginContains(repo, local), { ok: true });
});

test("verifyOriginContains checks the custom base branch's origin ref", () => {
  const repo = newRepo();
  git(["checkout", "-b", "dev"], repo);
  addOriginNamed(repo, "dev");
  const local = git(["rev-parse", "dev"], repo);
  assert.deepEqual(verifyOriginContains(repo, local, "dev"), { ok: true });
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

test("bumpVersion bumps cc by 1, prepends a v-prefixed CHANGELOG heading, and commits", () => {
  const repo = mkdtempSync(join(tmpdir(), "orch-bumpver-"));
  git(["init"], repo);
  git(["config", "user.email", "t@t.com"], repo);
  git(["config", "user.name", "t"], repo);
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "x", version: "0.4.1" }, null, 2));
  git(["add", "."], repo);
  git(["commit", "-m", "init"], repo);

  const version = bumpVersion(repo, "pr/claude/x-1");

  assert.equal(version, "0.4.2");
  const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
  assert.equal(pkg.version, "0.4.2");
  const changelog = readFileSync(join(repo, "CHANGELOG.md"), "utf8");
  assert.match(changelog, /^# Changelog\n\n## v0\.4\.2 — \d{4}-\d{2}-\d{2}\n- pr\/claude\/x-1/);
  const log = git(["log", "-1", "--format=%s"], repo).trim();
  assert.equal(log, "chore(release): v0.4.2");
});

test("bumpVersion carries cc 99 into z on a plain merge bump", () => {
  const repo = mkdtempSync(join(tmpdir(), "orch-bumpver-"));
  git(["init"], repo);
  git(["config", "user.email", "t@t.com"], repo);
  git(["config", "user.name", "t"], repo);
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "x", version: "0.4.99" }, null, 2));
  git(["add", "."], repo);
  git(["commit", "-m", "init"], repo);

  const version = bumpVersion(repo, "pr/claude/x-1");

  assert.equal(version, "0.4.100");
});

test("bumpVersion is a no-op when package.json is missing", () => {
  const repo = mkdtempSync(join(tmpdir(), "orch-bumpver-"));
  git(["init"], repo);
  const result = bumpVersion(repo, "pr/claude/x-1");
  assert.equal(result, null);
});

test("bumpVersion also bumps package-lock.json's root version", () => {
  const repo = mkdtempSync(join(tmpdir(), "orch-bumpver-"));
  git(["init"], repo);
  git(["config", "user.email", "t@t.com"], repo);
  git(["config", "user.name", "t"], repo);
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "x", version: "0.4.1" }, null, 2));
  writeFileSync(
    join(repo, "package-lock.json"),
    JSON.stringify({ name: "x", version: "0.4.1", packages: { "": { version: "0.4.1" } } }, null, 2),
  );
  git(["add", "."], repo);
  git(["commit", "-m", "init"], repo);

  bumpVersion(repo, "pr/claude/x-1");

  const lock = JSON.parse(readFileSync(join(repo, "package-lock.json"), "utf8"));
  assert.equal(lock.version, "0.4.2");
  assert.equal(lock.packages[""].version, "0.4.2");
});

test("bumpVersion returns null and leaves the repo clean when the commit fails", () => {
  const repo = mkdtempSync(join(tmpdir(), "orch-bumpver-"));
  git(["init"], repo);
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "x", version: "0.4.1" }, null, 2));
  git(["add", "."], repo);
  const hooksDir = join(repo, ".git", "hooks");
  mkdirSync(hooksDir, { recursive: true });
  const hookPath = join(hooksDir, "pre-commit");
  writeFileSync(hookPath, "#!/bin/sh\nexit 1\n");
  chmodSync(hookPath, 0o755);
  // Rejecting pre-commit hook forces the commit to fail regardless of git
  // identity, exercising the catch/reset path.
  const version = bumpVersion(repo, "pr/claude/x-1");
  assert.equal(version, null);
});

// Human `orch release` path: recovery must restore only the files the bump
// wrote. A whole-tree reset/clean would delete unrelated uncommitted work in
// a human checkout (finalize's integration worktree is orch-owned, so the
// destructive default stays correct there).
test("bumpVersion recovery:written-files leaves unrelated dirty work untouched when commit fails", () => {
  const repo = mkdtempSync(join(tmpdir(), "orch-bumpver-safe-"));
  git(["init"], repo);
  git(["config", "user.email", "t@t.com"], repo);
  git(["config", "user.name", "t"], repo);
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "x", version: "0.4.1" }, null, 2) + "\n");
  writeFileSync(join(repo, "notes.txt"), "committed notes\n");
  git(["add", "."], repo);
  git(["commit", "-m", "init"], repo);

  const dirtyPayload = "human WIP — must survive a failed release\n";
  writeFileSync(join(repo, "notes.txt"), dirtyPayload);
  writeFileSync(join(repo, "scratch.untracked"), "also mine\n");

  const hooksDir = join(repo, ".git", "hooks");
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(join(hooksDir, "pre-commit"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(hooksDir, "pre-commit"), 0o755);

  const version = bumpVersion(repo, "hand-landed fix", { recovery: "written-files" });
  assert.equal(version, null);
  assert.equal(readFileSync(join(repo, "notes.txt"), "utf8"), dirtyPayload);
  assert.equal(readFileSync(join(repo, "scratch.untracked"), "utf8"), "also mine\n");
  // package.json restored to the pre-bump committed version
  const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
  assert.equal(pkg.version, "0.4.1");
  // CHANGELOG was created by the failed bump and must be removed, not left half-written
  assert.equal(existsSync(join(repo, "CHANGELOG.md")), false);
});

test("deleteRemoteBranch removes an existing remote head (#339)", () => {
  const repo = newRepo();
  addOrigin(repo);
  git(["push", "origin", "HEAD:refs/heads/pr/claude/x-1"], repo);
  assert.ok(git(["ls-remote", "--heads", "origin", "pr/claude/x-1"], repo).trim(), "precondition: remote head exists");
  const r = deleteRemoteBranch(repo, "pr/claude/x-1");
  assert.equal(r.ok, true);
  assert.equal(git(["ls-remote", "--heads", "origin", "pr/claude/x-1"], repo).trim(), "");
});

test("deleteRemoteBranch is a harmless no-op when the remote head is already gone (#339)", () => {
  const repo = newRepo();
  addOrigin(repo);
  // Never pushed — deleting a missing ref must not throw; gitTry reports ok:false.
  const r = deleteRemoteBranch(repo, "pr/claude/never-existed-1");
  assert.equal(r.ok, false);
});
