import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sleepSync } from "./lock.js";
import { pidAlive } from "./pid.js";

export function originRef(base) {
  return `refs/remotes/origin/${base}`;
}

const REF_LOCK_RE = /cannot lock ref/i;

function failureText(error) {
  return String(error?.out ?? error?.stderr ?? error?.reason ?? error?.message ?? error);
}

// Concurrent orch cycles can race while updating a remote-tracking ref. Keep
// the retry policy in one place for both result-returning and throwing callers.
export function retryOnRefLock(fn, { retries = 2, sleep = sleepSync } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return fn();
    } catch (error) {
      if (attempt >= retries || !REF_LOCK_RE.test(failureText(error))) throw error;
      sleep(50 * 2 ** attempt);
    }
  }
}

// Ownership marker: a sibling file next to an orch-created task worktree. Its
// presence is the ONLY signal that lets the orphan sweep delete a branch — so
// review-attached user branches (no marker) are never auto-deleted. Sited next
// to the worktree dir, not inside it, so `git worktree remove` can't touch it.
const taskMarker = (path) => `${path}.orch-task`;
const preserveMarker = (path) => `${path}.orch-preserve`;

// Capture failures leave the worktree as the only copy of the author's edits.
// Keep a sibling marker so a later process's orphan sweep cannot destroy it.
export function preserveWorktree(path, reason) {
  writeFileSync(preserveMarker(realpathSync(path)), `${reason}\n`);
}

// First line of the ownership marker is the owner PID. Empty/garbage → null.
function ownerPid(markerPath) {
  try {
    const pid = parseInt(readFileSync(markerPath, "utf8").split("\n")[0].trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

export function gitTry(args, cwd) {
  try {
    const out = execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
    return { ok: true, out: (out || "").toString() };
  } catch (e) {
    // `code` is the child's exit status so callers can tell "ran, said no"
    // (git's exit 1) from "never ran" (anything else). A signal kill leaves
    // e.status null, which stays null and counts as an error, not a success.
    const code = typeof e.status === "number" ? e.status : null;
    return { ok: false, out: (e.stderr || e.stdout || e.message || "").toString(), code };
  }
}

// A repair author may stage a file containing conflict markers, which makes
// Git consider the index resolved even though the tree is not. Keep this
// check deterministic and local to the worktree; callers use it before the
// repaired rebase is allowed to advance.
//
// git grep exits 0 when it matched, 1 when it searched and found nothing, and
// something else when the search never ran (worktree gone, pathspec outside the
// repository, unopenable repo). Reporting that last case as "no markers" would
// be a fail-open, so it comes back as { error } and the caller stops.
export function unresolvedConflictMarkers(path, paths = []) {
  const args = ["grep", "-n", "-I", "-E", "^(<<<<<<<|>>>>>>>)"];
  if (paths.length) args.push("--", ...paths);
  const result = gitTry(args, path);
  if (result.ok) return { markers: result.out.trim() };
  if (result.code === 1) return { markers: "" };
  return { markers: "", error: result.out.trim() || `git grep exited ${result.code}` };
}

// Files changed on `branch` since its merge-base with the configured base branch.
// -z + split on NUL so paths with newlines/control chars stay intact (git
// C-quotes those without -z). No .trim() — POSIX allows leading/trailing spaces.
export function changedFiles(repo, branch, base = "main") {
  const out = gitTry(["diff", "--name-only", "-z", `${base}...${branch}`], repo);
  return out.ok ? out.out.split("\0").filter(Boolean) : [];
}

export function branchExists(repo, branch) {
  return gitTry(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repo).ok;
}

// Retained as a public helper for consumers that inspect branch freshness
// directly; orch's current landing path uses the narrower reconciliation helpers.
export function branchSyncStatus(repo, branch, base = "main") {
  const branchRef = gitTry(["rev-parse", "--verify", "--quiet", `${branch}^{commit}`], repo);
  if (!branchRef.ok) return { ok: false, reason: `branch not found: ${branch}` };
  const baseRef = gitTry(["rev-parse", "--verify", "--quiet", `${base}^{commit}`], repo);
  if (!baseRef.ok) return { ok: false, reason: `base not found: ${base}` };

  const branchSha = branchRef.out.trim();
  const baseSha = baseRef.out.trim();
  if (branchSha === baseSha) return { ok: true, synced: true, status: "synced", branchSha, baseSha };

  const branchTree = git(["rev-parse", `${branch}^{tree}`], repo);
  const baseTree = git(["rev-parse", `${base}^{tree}`], repo);
  if (branchTree === baseTree) {
    return { ok: true, synced: true, status: "same-tree", branchSha, baseSha };
  }

  const branchBehind = gitTry(["merge-base", "--is-ancestor", branch, base], repo).ok;
  const baseBehind = gitTry(["merge-base", "--is-ancestor", base, branch], repo).ok;
  const status = branchBehind ? "behind" : baseBehind ? "ahead" : "diverged";
  return { ok: true, synced: false, status, branchSha, baseSha };
}

// task mode: branch must NOT exist (orch owns it). Fail otherwise.
export function createTaskBranch(repo, path, branch, base, markerContent = "") {
  if (branchExists(repo, branch)) throw new Error(`branch already exists: ${branch}`);
  git(["worktree", "add", "-b", branch, "--", path, base], repo);
  // Marker now records the owner so the sweep can spare LIVE peers (no global
  // lock anymore). Empty marker = died before writing = swept (legacy parity).
  writeFileSync(taskMarker(realpathSync(path)), markerContent);
}

// review mode: branch MUST exist (human/other tool made it). Never create it.
export function attachExistingBranch(repo, path, branch) {
  if (!branchExists(repo, branch)) throw new Error(`branch does not exist: ${branch}`);
  const listed = gitTry(["worktree", "list", "--porcelain"], repo);
  if (listed.ok) {
    let expected = path;
    try { expected = realpathSync(path); } catch { /* worktree does not exist yet */ }
    const attached = [...worktreeRecords(listed.out)]
      .find((record) => normalizePathForCompare(record.path) === normalizePathForCompare(expected));
    if (attached) {
      if (attached.branch === branch) return;
      throw new Error(`worktree path already attached to ${attached.branch || "a detached HEAD"}: ${path}`);
    }
  }
  git(["worktree", "add", "--", path, branch], repo);
}

// --- post-run completion helpers (see src/complete.js) ---

// Current branch name, or "HEAD" when detached. --abbrev-ref prints "HEAD" detached.
export function currentBranch(repo) {
  return git(["rev-parse", "--abbrev-ref", "HEAD"], repo);
}

// Safe delete: a branch is safe to drop only when it is fully contained in the
// configured landing branch (every commit already there → deleting the ref loses
// nothing). We test that branch directly via merge-base, NOT `branch -d`, because
// `-d` judges "merged" relative to the current HEAD. unmerged:true
// means real commits would be lost, so the caller must gate on the operator's consent.
export function deleteBranchSafe(repo, branch, base = "main") {
  const inBase = gitTry(["merge-base", "--is-ancestor", branch, base], repo).ok;
  if (!inBase) return { ok: false, unmerged: true };
  const r = gitTry(["branch", "-D", branch], repo); // proven contained in base → -D is loss-free
  return r.ok ? { ok: true } : { ok: false, reason: r.out.trim() };
}

// Force delete (-D) — drops a branch regardless of merge state. Only ever reached
// after the operator explicitly consents to losing the work.
export function forceDeleteBranch(repo, branch) {
  git(["branch", "-D", branch], repo);
}

// Best-effort remote-branch cleanup. A cycle's `pr/*` head has served its whole
// purpose once its content lands on the integration branch; left on origin it just
// accumulates one orphan per cycle (#339). gitTry never throws and a missing remote
// ref is a harmless no-op, so this can never break a merge that already succeeded.
// The caller is responsible for never handing it a protected branch.
export function deleteRemoteBranch(repo, branch) {
  return gitTry(["push", "origin", "--delete", branch], repo);
}

// Retained as a public helper for callers that explicitly verify a commit
// against a remote-tracking base. The normal cycle has a separate integration
// path; this helper is not silently treated as a production landing guard.
export function verifyOriginContains(repo, commit, base = "main") {
  const fetched = fetchOriginMain(repo, { base });
  if (!fetched.ok) return { ok: false, reason: fetched.reason };
  const r = gitTry(["merge-base", "--is-ancestor", commit, originRef(base)], repo);
  return r.ok
    ? { ok: true }
    : { ok: false, reason: `${commit} is not contained in origin/${base}` };
}

export function fetchOriginMain(
  repo,
  { base = "main", retries = 2, sleep = sleepSync, fetch = () => gitTry(["fetch", "origin", `${base}:${originRef(base)}`], repo) } = {},
) {
  if (!gitTry(["remote", "get-url", "origin"], repo).ok)
    return { ok: false, missingOrigin: true, reason: "no origin remote configured" };
  try {
    retryOnRefLock(() => {
      const result = fetch();
      if (!result.ok) throw result;
      return result;
    }, { retries, sleep });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: failureText(error).trim() };
  }
}

export function* worktreeRecords(porcelainOut) {
  let record = null;
  for (const line of String(porcelainOut).split("\n")) {
    if (line.startsWith("worktree ")) {
      if (record) yield record;
      record = { path: line.slice("worktree ".length), branch: null };
    } else if (record?.path && line.startsWith("branch ")) {
      record.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (record?.path && line === "detached") {
      record.detached = true;
    }
  }
  if (record) yield record;
}

function mainWorktreePath(repo, base = "main") {
  const list = gitTry(["worktree", "list", "--porcelain"], repo);
  if (!list.ok) return null;
  for (const record of worktreeRecords(list.out)) {
    if (record.branch === base) return record.path;
  }
  return null;
}

function moveMainToOrigin(repo, base = "main") {
  const path = mainWorktreePath(repo, base);
  if (path) {
    git(["merge", "--ff-only", originRef(base)], path);
    return;
  }
  git(["branch", "-f", base, originRef(base)], repo);
}

export function syncMainFromOrigin(repo, base = "main") {
  const fetched = fetchOriginMain(repo, { base });
  if (!fetched.ok) {
    if (fetched.missingOrigin) return { ok: true, skipped: true, reason: fetched.reason };
    return { ok: false, reason: `could not fetch origin/${base}: ${fetched.reason}` };
  }

  const local = git(["rev-parse", base], repo);
  const remote = git(["rev-parse", originRef(base)], repo);
  if (local === remote) return { ok: true, updated: false };

  const localBehind = gitTry(["merge-base", "--is-ancestor", base, originRef(base)], repo).ok;
  if (localBehind) {
    try {
      moveMainToOrigin(repo, base);
    } catch (e) {
      const reason = (e.stderr || e.stdout || e.message || "").toString().trim();
      return { ok: false, reason: `could not fast-forward local ${base} to origin/${base}: ${reason}` };
    }
    return { ok: true, updated: true, from: local, to: remote };
  }

  const remoteBehind = gitTry(["merge-base", "--is-ancestor", originRef(base), base], repo).ok;
  if (remoteBehind) {
    return { ok: false, reason: `local ${base} is ahead of origin/${base}; reconcile it before running orch` };
  }
  return { ok: false, reason: `local ${base} has diverged from origin/${base}; reconcile it before running orch` };
}

export function pruneWorktree(repo, path) {
  let canon = path;
  try { canon = realpathSync(path); } catch { /* already gone */ }
  gitTry(["worktree", "remove", "--force", path], repo);
  gitTry(["worktree", "prune"], repo);
  rmSync(taskMarker(canon), { force: true });
  rmSync(preserveMarker(canon), { force: true });
}

// Windows paths are case-insensitive at the filesystem level, but git.exe's
// own realpath normalization and Node's realpathSync don't always agree on
// drive-letter/segment casing (e.g. `C:/Users/...` vs `c:/users/...`) — a
// GitHub Actions windows-latest runner reliably produces this mismatch via
// its 8.3-short-form %TEMP%. A case-sensitive prefix comparison then silently
// treats every orphan as outside wtRoot and sweeps nothing. Lower-case both
// sides of the comparison on Windows only — POSIX paths stay case-sensitive
// (case IS significant there — lower-casing unconditionally would make two
// genuinely distinct directories collide).
export function normalizePathForCompare(p, platform = process.platform) {
  const s = p.replace(/\\/g, "/");
  return platform === "win32" ? s.toLowerCase() : s;
}

// Reclaim worktrees a crashed cycle left under .orch/wt — the engine prunes its
// own worktree in a finally, so anything still here is from a cycle killed
// before that ran. Safe to sweep because the caller holds the single-cycle
// lock: no live cycle owns these. A branch is deleted ONLY when its orch-task
// marker is present AND it carries no commits beyond main (a killed-before-commit
// throwaway); review-attached user branches have no marker and are always preserved.
// A branch with committed author work (killed AFTER the author commit) is kept so
// `orch task` can reattach and resume it instead of re-authoring (#27) — losing
// committed work is the real defect; a stray empty-worktree branch is recoverable.
export function reclaimOrphanWorktrees(repo, orchDir, liveBranches = new Set(), { platform = process.platform, base = "main" } = {}) {
  let recovered = false;
  const normalize = (p) => normalizePathForCompare(p, platform);
  // Canonicalize: git stores worktree paths as realpaths, but orchDir may arrive
  // via a symlink (this repo is reachable through /mnt/... and a ~/...-symlink).
  // Without this the prefix match silently skips every orphan on the alt path.
  let wtRoot;
  try {
    wtRoot = normalize(join(realpathSync(orchDir), "wt")) + "/";
  } catch {
    gitTry(["worktree", "prune"], repo); // no orchDir yet = no orphans to sweep
    return { recovered };
  }
  const list = gitTry(["worktree", "list", "--porcelain"], repo);
  if (list.ok) {
    for (const { path, branch } of worktreeRecords(list.out)) {
      if (path && normalize(path).startsWith(wtRoot)) {
        // A failed author-capture left dirty work here as the only recoverable
        // copy. This marker deliberately outlives the process that created it.
        if (existsSync(preserveMarker(path))) continue;
        // Belt 1: branch is registered as in-flight (worktree may not have marker yet —
        // this protects the window between `git worktree add` and `writeFileSync(marker)`).
        if (branch && liveBranches.has(branch)) {
          continue;
        }
        const marker = taskMarker(path);
        const owned = existsSync(marker); // orch-created throwaway?
        const pid = owned ? ownerPid(marker) : null;
        if (owned && pid !== null && pidAlive(pid)) {
          // Belt 2: live peer in a concurrent cycle — leave it entirely alone
          continue;
        }
        const removed = gitTry(["worktree", "remove", "--force", path], repo);
        if (removed.ok) recovered = true;
        // Delete only a throwaway with no committed work; keep committed branches
        // so a resume can reattach (#27). changedFiles is `diff base...branch`.
        if (branch && owned && changedFiles(repo, branch, base).length === 0)
          gitTry(["branch", "-D", "--", branch], repo); // never a user branch
        rmSync(marker, { force: true });
      }
    }
  }
  gitTry(["worktree", "prune"], repo);
  return { recovered };
}

// One reused worktree, checked out on the dedicated integration branch where
// local merges land. `main` stays free for an operator checkout and mirrors
// GitHub's main via fetch + fast-forward only.
export function ensureIntegrationWorktree(repo, orchDir, branch = "orch/integration", base = "main") {
  const path = join(orchDir, "integration");
  mkdirSync(orchDir, { recursive: true });
  gitTry(["worktree", "prune"], repo); // clear a stale registration if the dir was removed
  if (!existsSync(path)) {
    if (branchExists(repo, branch)) git(["worktree", "add", path, branch], repo);
    else git(["worktree", "add", "-b", branch, path, base], repo);
  } else if (git(["rev-parse", "--abbrev-ref", "HEAD"], path) !== branch) {
    if (branchExists(repo, branch)) git(["switch", branch], path);
    else git(["switch", "-c", branch, base], path);
  }
  return path;
}

// Pull the integration worktree to its branch tip and drop any leftover
// half-merge / untracked cruft from a crashed finalize (§6.4).
export function syncWorktreeToIntegration(integrationPath, branch = "orch/integration") {
  git(["reset", "--hard", branch], integrationPath);
  git(["clean", "-fd"], integrationPath);
}

// A human can land work straight on origin/<integration> — that is the documented
// recovery when a cycle escalates on the protected-path floor and orch may not
// merge the fix itself. Local would otherwise stay stale, the next cycle would
// build on the wrong base, and `openIntegrationPr`'s push would be rejected as
// non-fast-forward. Fast-forward the local branch onto origin before landing;
// never rewrite, and escalate on a real divergence — the merge base is ambiguous
// there and a human has to choose.
export function reconcileIntegrationToOrigin(integrationPath, branch = "orch/integration") {
  const ref = originRef(branch);
  const fetched = fetchOriginMain(integrationPath, {
    base: branch,
    // Force only the remote-tracking ref: it is a mirror of origin by definition,
    // so a force-pushed origin should still land here as data, not as a fetch error.
    fetch: () => gitTry(["fetch", "origin", `+${branch}:${ref}`], integrationPath),
  });
  if (!fetched.ok) {
    // No origin, or the branch does not exist there yet (first cycle in a repo):
    // nothing to reconcile against, and local is authoritative.
    if (fetched.missingOrigin || /couldn't find remote ref/i.test(fetched.reason || ""))
      return { ok: true, updated: false, skipped: true };
    return { ok: false, reason: `could not fetch origin/${branch}: ${fetched.reason}` };
  }

  const head = git(["rev-parse", "HEAD"], integrationPath);
  const remote = git(["rev-parse", ref], integrationPath);
  if (head === remote) return { ok: true, updated: false };
  // Local ahead of origin — the normal case between a land and its push.
  if (gitTry(["merge-base", "--is-ancestor", ref, "HEAD"], integrationPath).ok)
    return { ok: true, updated: false };
  if (!gitTry(["merge-base", "--is-ancestor", "HEAD", ref], integrationPath).ok)
    return { ok: false, reason: `local ${branch} has diverged from origin/${branch}; reconcile it before running orch` };
  try {
    git(["merge", "--ff-only", ref], integrationPath);
    return { ok: true, updated: true, from: head, to: remote };
  } catch (e) {
    const reason = (e.stderr || e.stdout || e.message || "").toString().trim();
    return { ok: false, reason: `could not fast-forward ${branch} to origin/${branch}: ${reason}` };
  }
}

// If GitHub advanced the base branch after the last integration PR merge,
// integration can be cleanly behind it. Fast-forward that safe prefix case
// before landing more local work; never rewrite or discard integration commits.
// Histories also diverge on every landing where the integration PR is squashed
// or rebased: base carries a new commit with integration's tree but no shared
// history. (This repo now disables both, so it stays on the ancestry path; a
// repo that squashes its integration PR still lands here.)
// For that case an ordinary merge commit re-establishes base as an ancestor
// (content-identical trees merge cleanly); without it the next cycle's land
// hits add/add conflicts on files both sides already agree on. A merge only
// ever ADDS a commit whose first parent is the old integration head, so the
// no-rewrite invariant holds. On conflict: abort and skip as before — the
// behaviour is never worse than the old no-op.
export function reconcileIntegrationToBase(integrationPath, base = "main") {
  const head = git(["rev-parse", "HEAD"], integrationPath);
  const target = git(["rev-parse", base], integrationPath);
  if (head === target) return { ok: true, updated: false };
  // Integration strictly ahead (nothing new on base): nothing to do.
  if (gitTry(["merge-base", "--is-ancestor", base, "HEAD"], integrationPath).ok) {
    return { ok: true, updated: false };
  }
  if (gitTry(["merge-base", "--is-ancestor", "HEAD", base], integrationPath).ok) {
    try {
      git(["merge", "--ff-only", base], integrationPath);
      return { ok: true, updated: true, from: head, to: target };
    } catch (e) {
      const reason = (e.stderr || e.stdout || e.message || "").toString().trim();
      return { ok: false, reason: `could not fast-forward integration to ${base}: ${reason}` };
    }
  }
  // Diverged histories (the post-squash case): merge base in to re-link them.
  const m = gitTry(["merge", "--no-edit", base], integrationPath);
  if (!m.ok) {
    gitTry(["merge", "--abort"], integrationPath);
    const reason = m.out.trim();
    return { ok: true, updated: false, skipped: "merge-conflict", ...(reason ? { reason } : {}) };
  }
  return { ok: true, updated: true, from: head, to: git(["rev-parse", "HEAD"], integrationPath) };
}

// Replay `branch`'s commits onto `onto` (typically orch/integration after a peer
// landed). When `expectedSha` is supplied, rebase that immutable commit and only
// advance the branch with an update-ref compare-and-swap. Used by finalize's
// Tier-1 redrive of overlap-demoted peers (#350).
// Runs in a temporary worktree so the caller's integration worktree stays put.
// On conflict or a moved branch: drop the temp worktree and leave `branch` alone.
// `keepWorktreeOnConflict` is reserved for the repair remedy, which needs the
// conflicted tree to remain available to the author. The default is unchanged.
// `keepWorktreeOnSuccess` is separate because TEST_RED can have no Git conflict
// while still needing the rebased worktree for the author to repair the test.
export function rebaseBranchOnto(repo, orchDir, branch, onto, expectedSha = null, {
  keepWorktreeOnConflict = false,
  keepWorktreeOnSuccess = false,
} = {}) {
  if (!branch || !onto || branch === onto) {
    return { ok: false, reason: "rebaseBranchOnto: invalid branch/onto" };
  }
  if (expectedSha) {
    const current = gitTry(["rev-parse", "--verify", `refs/heads/${branch}`], repo);
    if (!current.ok || current.out.trim() !== expectedSha) {
      return {
        ok: false, moved: true, ...(keepWorktreeOnConflict ? { precondition: true } : {}),
        reason: "branch moved before rebase",
      };
    }
  }
  const path = join(orchDir, "wt", `rebase-${String(branch).replace(/[^\w.-]+/g, "_")}`);
  gitTry(["worktree", "remove", "--force", path], repo);
  rmSync(path, { recursive: true, force: true });
  const addArgs = expectedSha
    ? ["worktree", "add", "--detach", "--", path, expectedSha]
    : ["worktree", "add", "--", path, branch];
  const add = gitTry(addArgs, repo);
  if (!add.ok) return {
    ok: false,
    ...(keepWorktreeOnConflict ? { precondition: true } : {}),
    reason: add.out.trim() || "worktree add failed",
  };
  let keepWorktree = false;
  try {
    const rb = gitTry(["rebase", onto], path);
    if (!rb.ok) {
      const conflicts = gitTry(["diff", "--name-only", "-z", "--diff-filter=U"], path);
      const conflictPaths = conflicts.ok ? conflicts.out.split("\0").filter(Boolean) : [];
      if (keepWorktreeOnConflict && conflictPaths.length) {
        keepWorktree = true;
        return {
          ok: false,
          conflict: true,
          conflicts: conflictPaths,
          path,
          reason: rb.out.trim() || "rebase failed",
        };
      }
      gitTry(["rebase", "--abort"], path);
      return {
        ok: false,
        ...(keepWorktreeOnConflict ? { executed: true } : {}),
        reason: rb.out.trim() || "rebase failed",
      };
    }
    const head = gitTry(["rev-parse", "HEAD"], path);
    if (!head.ok) return {
      ok: false,
      ...(keepWorktreeOnConflict ? { executed: true } : {}),
      reason: head.out.trim() || "rebased head unreadable",
    };
    const sha = head.out.trim();
    if (expectedSha) {
      const update = gitTry(["update-ref", `refs/heads/${branch}`, sha, expectedSha], repo);
      if (!update.ok) return {
        ok: false,
        moved: true,
        ...(keepWorktreeOnConflict ? { executed: true } : {}),
        reason: update.out.trim() || "branch moved during rebase",
      };
    }
    if (keepWorktreeOnSuccess) keepWorktree = true;
    return { ok: true, sha, ...(keepWorktreeOnSuccess ? { path } : {}) };
  } finally {
    if (!keepWorktree) removeRebaseWorktree(repo, path);
  }
}

function removeRebaseWorktree(repo, path) {
  gitTry(["worktree", "remove", "--force", path], repo);
  rmSync(path, { recursive: true, force: true });
}

// Finish a conflict preserved by rebaseBranchOnto(). The author adapter has
// already staged and committed its repair, so `rebase --continue` records the
// repaired commit and the same CAS protects the branch update as the plain
// rebase path. A clean TEST_RED rebase has no rebase operation left to
// continue, but still uses this helper to CAS the author's repair commit.
// The temporary worktree is always cleaned up here.
export function finishRebase(repo, branch, path, expectedSha = null, {
  continueRebase = true,
  conflictPaths = [],
} = {}) {
  try {
    if (continueRebase) {
      const scan = unresolvedConflictMarkers(path, conflictPaths);
      if (scan.error) {
        gitTry(["rebase", "--abort"], path);
        return { ok: false, reason: `marker scan unavailable: ${scan.error}` };
      }
      if (scan.markers) {
        gitTry(["rebase", "--abort"], path);
        return { ok: false, reason: "rebase repair left conflict markers" };
      }
      const rb = gitTry(["-c", "core.editor=true", "rebase", "--continue"], path);
      if (!rb.ok) {
        gitTry(["rebase", "--abort"], path);
        return { ok: false, reason: rb.out.trim() || "rebase continue failed" };
      }
    }
    const head = gitTry(["rev-parse", "HEAD"], path);
    if (!head.ok) return { ok: false, reason: head.out.trim() || "rebased head unreadable" };
    const sha = head.out.trim();
    if (expectedSha) {
      const update = gitTry(["update-ref", `refs/heads/${branch}`, sha, expectedSha], repo);
      if (!update.ok) return { ok: false, moved: true, reason: update.out.trim() || "branch moved during repaired rebase" };
    }
    return { ok: true, sha };
  } finally {
    removeRebaseWorktree(repo, path);
  }
}

// A failed author run happens after rebaseBranchOnto() has returned a preserved
// conflicted worktree, so it needs an explicit abort-and-cleanup entry point
// rather than another option on the original rebase call.
export function abortRebase(repo, path) {
  try { gitTry(["rebase", "--abort"], path); }
  finally { removeRebaseWorktree(repo, path); }
}

// Merge `branch` into the worktree's checked-out main. On any failure, abort so
// the worktree is left clean for the next finalize.
export function mergeInWorktree(integrationPath, branch, mode, message = null) {
  const flag = mode === "no-ff" ? "--no-ff" : "--ff-only";
  // A custom message only applies to a real merge commit (no-ff); ff-only fast-
  // forwards with no commit to carry it, so the flag is dropped there.
  const args = message && flag === "--no-ff"
    ? ["merge", flag, "-m", message, branch]
    : ["merge", flag, branch];
  const m = gitTry(args, integrationPath);
  if (m.ok) return { ok: true, reason: "merged" };
  const reason = m.out.trim();
  gitTry(["merge", "--abort"], integrationPath); // ff-only failures are no-ops here; harmless
  if (/untracked working tree files would be overwritten/i.test(reason)) {
    const files = reason.split("\n").filter((l) => /^\t/.test(l)).map((l) => l.trim());
    return { ok: false, reason, advice: `remove or commit these untracked files in main: ${files.join(", ")}` };
  }
  return { ok: false, reason };
}

// Merge-bump version bump (the "cc" half of the x.y.zcc scheme — see
// src/versioning.js for the "z" publish-bump half), run in the integration
// worktree right after a merge lands and the post-merge test gate passes.
// Bumps package.json's patch field by 1 (+ package-lock.json's root
// version) and prepends a CHANGELOG.md entry, then commits — so every merge
// to main is traceable to a version. Decimal carry rolls cc 99->00 into z on
// its own; that's by design, not a bug (a merge cadence that high between
// publishes means a publish is overdue anyway). No-op (returns null) if
// package.json is missing/unparsable, or if anything below fails (dirty
// target-repo pre-commit hooks, missing git identity, etc.) — this must
// never throw out of a finalize that already landed the merge (issue #44).
//
// opts.recovery:
//   "destructive" (default) — `git reset --hard` + `git clean -fd`. Safe only
//     inside orch's own integration worktree (finalize). Never use from a
//     human checkout.
//   "written-files" — restore only the paths this function wrote
//     (`git checkout --` for pre-existing files; unlink for files it created).
//     Used by `orch release` so a failed bump never deletes unrelated work.
export function bumpVersion(integrationPath, entry, opts = {}) {
  const recovery = opts.recovery === "written-files" ? "written-files" : "destructive";
  const pkgPath = join(integrationPath, "package.json");
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch {
    return null;
  }
  const parts = String(pkg.version).split(".");
  if (parts.length !== 3 || parts.some((p) => !/^\d+$/.test(p))) return null;
  const version = `${parts[0]}.${parts[1]}.${Number(parts[2]) + 1}`;

  // Paths we touch, so a written-files recovery can roll back only those.
  // `created` are untracked files we introduced; `restored` already existed.
  const created = [];
  const restored = [];
  const touch = (rel) => {
    const abs = join(integrationPath, rel);
    if (existsSync(abs)) restored.push(rel);
    else created.push(rel);
    return abs;
  };

  try {
    touch("package.json");
    pkg.version = version;
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

    const lockPath = join(integrationPath, "package-lock.json");
    if (existsSync(lockPath)) {
      touch("package-lock.json");
      const lock = JSON.parse(readFileSync(lockPath, "utf8"));
      lock.version = version;
      if (lock.packages?.[""]) lock.packages[""].version = version;
      writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    }

    const changelogPath = touch("CHANGELOG.md");
    const date = new Date().toISOString().slice(0, 10);
    const section = `## v${version} — ${date}\n- ${entry}\n\n`;
    const prior = existsSync(changelogPath) ? readFileSync(changelogPath, "utf8").replace(/^# Changelog\n+/, "") : "";
    writeFileSync(changelogPath, `# Changelog\n\n${section}${prior}`);

    // The GitHub Pages site (docs/index.html) hard-codes the release version in
    // its header (left of the GitHub link) as `>vX.Y.Z</span>`, inside the
    // inline-SPA JSON string — the page is the built artifact, no generator.
    // Nothing else touches it, so without this it froze while the package
    // bumped on. The closing tag's `/` may be written literally (`</span>`) or
    // escaped (`<\/span>`, `</span>`) depending on how the design tool
    // exported the bundle, so the lookahead accepts all three — a re-export
    // that flips the encoding must not silently freeze the version again (#192).
    // Best-effort, span-anchored: only that one version span is rewritten.
    const sitePath = join(integrationPath, "docs", "index.html");
    let siteBumped = false;
    if (existsSync(sitePath)) {
      const html = readFileSync(sitePath, "utf8");
      const next = html.replace(/v\d+\.\d+\.\d+(?=<(?:\\u002F|\\\/|\/)span>)/, `v${version}`);
      if (next !== html) {
        touch("docs/index.html");
        writeFileSync(sitePath, next);
        siteBumped = true;
      }
    }

    const addFiles = ["package.json", "CHANGELOG.md"];
    if (existsSync(lockPath)) addFiles.push("package-lock.json");
    if (siteBumped) addFiles.push("docs/index.html");
    git(["add", ...addFiles], integrationPath);
    git(["commit", "-m", `chore(release): v${version}`], integrationPath);
    return version;
  } catch {
    if (recovery === "written-files") {
      const all = [...new Set([...restored, ...created])];
      if (all.length) gitTry(["reset", "HEAD", "--", ...all], integrationPath);
      if (restored.length) gitTry(["checkout", "--", ...restored], integrationPath);
      for (const rel of created) {
        try { rmSync(join(integrationPath, rel), { force: true }); } catch { /* best-effort */ }
      }
    } else {
      gitTry(["reset", "--hard", "HEAD"], integrationPath);
      gitTry(["clean", "-fd"], integrationPath);
    }
    return null;
  }
}
