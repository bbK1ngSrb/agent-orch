import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ORIGIN_MAIN_REF = "refs/remotes/origin/main";

// Ownership marker: a sibling file next to an orch-created task worktree. Its
// presence is the ONLY signal that lets the orphan sweep delete a branch — so
// review-attached user branches (no marker) are never auto-deleted. Sited next
// to the worktree dir, not inside it, so `git worktree remove` can't touch it.
const taskMarker = (path) => `${path}.orch-task`;

// First line of the ownership marker is the owner PID. Empty/garbage → null.
function ownerPid(markerPath) {
  try {
    const pid = parseInt(readFileSync(markerPath, "utf8").split("\n")[0].trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== "ESRCH"; }
}

export function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function gitTry(args, cwd) {
  try {
    const out = execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
    return { ok: true, out: (out || "").toString() };
  } catch (e) {
    return { ok: false, out: (e.stderr || e.stdout || e.message || "").toString() };
  }
}

// Files changed on `branch` since its merge-base with main (matches scope.count).
export function changedFiles(repo, branch) {
  const out = gitTry(["diff", "--name-only", `main...${branch}`], repo);
  return out.ok ? out.out.split("\n").map((s) => s.trim()).filter(Boolean) : [];
}

export function branchExists(repo, branch) {
  return gitTry(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repo).ok;
}

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
  git(["worktree", "add", "--", path, branch], repo);
}

// --- post-run completion helpers (see src/complete.js) ---

// Current branch name, or "HEAD" when detached. --abbrev-ref prints "HEAD" detached.
export function currentBranch(repo) {
  return git(["rev-parse", "--abbrev-ref", "HEAD"], repo);
}

// Detach the primary checkout onto main's tip. A detached checkout peels `main` to
// its commit without claiming the branch ref, so this succeeds even while the
// integration worktree owns `main` — freeing the operator's old branch for deletion.
export function detachToMain(repo) {
  git(["switch", "--detach", "--quiet", "main"], repo);
}

// Safe delete: a branch is safe to drop only when it is fully contained in `main`
// (every commit already on main → deleting the ref loses nothing). We test that
// against main directly via merge-base, NOT `branch -d`, because `-d` judges "merged"
// relative to the current HEAD — which, if a detach failed, is still the operator's
// branch and would wrongly flag a truly-merged cycle branch as unmerged. unmerged:true
// means real commits would be lost, so the caller must gate on the operator's consent.
export function deleteBranchSafe(repo, branch) {
  const inMain = gitTry(["merge-base", "--is-ancestor", branch, "main"], repo).ok;
  if (!inMain) return { ok: false, unmerged: true };
  const r = gitTry(["branch", "-D", branch], repo); // proven contained in main → -D is loss-free
  return r.ok ? { ok: true } : { ok: false, reason: r.out.trim() };
}

// Force delete (-D) — drops a branch regardless of merge state. Only ever reached
// after the operator explicitly consents to losing the work.
export function forceDeleteBranch(repo, branch) {
  git(["branch", "-D", branch], repo);
}

// Fast-forward-only push of main to origin. Never forces; a missing remote, auth
// failure, or non-ff rejection comes back as {ok:false, reason} for plain reporting.
export function pushMain(repo) {
  const r = gitTry(["push", "origin", "main"], repo);
  return r.ok ? { ok: true } : { ok: false, reason: r.out.trim() };
}

function fetchOriginMain(repo) {
  if (!gitTry(["remote", "get-url", "origin"], repo).ok)
    return { ok: false, missingOrigin: true, reason: "no origin remote configured" };
  const r = gitTry(["fetch", "origin", `main:${ORIGIN_MAIN_REF}`], repo);
  return r.ok ? { ok: true } : { ok: false, reason: r.out.trim() };
}

function mainWorktreePath(repo) {
  const list = gitTry(["worktree", "list", "--porcelain"], repo);
  if (!list.ok) return null;
  let path = null;
  let onMain = false;
  const flush = () => {
    const hit = onMain ? path : null;
    path = null;
    onMain = false;
    return hit;
  };
  for (const line of list.out.split("\n")) {
    if (line.startsWith("worktree ")) {
      const hit = flush();
      if (hit) return hit;
      path = line.slice("worktree ".length);
    } else if (line === "branch refs/heads/main") {
      onMain = true;
    }
  }
  return flush();
}

function moveMainToOrigin(repo, mode) {
  const path = mainWorktreePath(repo);
  if (path) {
    if (mode === "reset") {
      git(["reset", "--hard", ORIGIN_MAIN_REF], path);
      git(["clean", "-fd"], path);
    } else {
      git(["merge", "--ff-only", ORIGIN_MAIN_REF], path);
    }
    return;
  }
  git(["branch", "-f", "main", ORIGIN_MAIN_REF], repo);
}

export function syncMainFromOrigin(repo) {
  const fetched = fetchOriginMain(repo);
  if (!fetched.ok) {
    if (fetched.missingOrigin) return { ok: true, skipped: true, reason: fetched.reason };
    return { ok: false, reason: `could not fetch origin/main: ${fetched.reason}` };
  }

  const local = git(["rev-parse", "main"], repo);
  const remote = git(["rev-parse", ORIGIN_MAIN_REF], repo);
  if (local === remote) return { ok: true, updated: false };

  const localBehind = gitTry(["merge-base", "--is-ancestor", "main", ORIGIN_MAIN_REF], repo).ok;
  if (localBehind) {
    try {
      moveMainToOrigin(repo, "merge");
    } catch (e) {
      const reason = (e.stderr || e.stdout || e.message || "").toString().trim();
      return { ok: false, reason: `could not fast-forward local main to origin/main: ${reason}` };
    }
    return { ok: true, updated: true, from: local, to: remote };
  }

  const remoteBehind = gitTry(["merge-base", "--is-ancestor", ORIGIN_MAIN_REF, "main"], repo).ok;
  return {
    ok: false,
    reason: remoteBehind
      ? "local main is ahead of origin/main; push or reset main before running orch"
      : "local main has diverged from origin/main; sync or reset main before running orch",
  };
}

export function resetMainToOriginIfDiverged(repo) {
  const fetched = fetchOriginMain(repo);
  if (!fetched.ok) return { rolledBack: false, reason: fetched.reason };
  if (gitTry(["merge-base", "--is-ancestor", ORIGIN_MAIN_REF, "main"], repo).ok)
    return { rolledBack: false, reason: "origin/main is already an ancestor of local main" };
  const from = git(["rev-parse", "main"], repo);
  const to = git(["rev-parse", ORIGIN_MAIN_REF], repo);
  moveMainToOrigin(repo, "reset");
  return { rolledBack: true, from, to };
}

export function pruneWorktree(repo, path) {
  let canon = path;
  try { canon = realpathSync(path); } catch { /* already gone */ }
  gitTry(["worktree", "remove", "--force", path], repo);
  gitTry(["worktree", "prune"], repo);
  rmSync(taskMarker(canon), { force: true });
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
export function reclaimOrphanWorktrees(repo, orchDir, liveBranches = new Set()) {
  // Canonicalize: git stores worktree paths as realpaths, but orchDir may arrive
  // via a symlink (this repo is reachable through /mnt/... and a ~/...-symlink).
  // Without this the prefix match silently skips every orphan on the alt path.
  let wtRoot;
  try {
    wtRoot = join(realpathSync(orchDir), "wt") + "/";
  } catch {
    gitTry(["worktree", "prune"], repo); // no orchDir yet = no orphans to sweep
    return;
  }
  const list = gitTry(["worktree", "list", "--porcelain"], repo);
  if (list.ok) {
    let path = null;
    let branch = null;
    const flush = () => {
      if (path && path.startsWith(wtRoot)) {
        // Belt 1: branch is registered as in-flight (worktree may not have marker yet —
        // this protects the window between `git worktree add` and `writeFileSync(marker)`).
        if (branch && liveBranches.has(branch)) {
          path = null;
          branch = null;
          return;
        }
        const marker = taskMarker(path);
        const owned = existsSync(marker); // orch-created throwaway?
        const pid = owned ? ownerPid(marker) : null;
        if (owned && pid !== null && pidAlive(pid)) {
          // Belt 2: live peer in a concurrent cycle — leave it entirely alone
          path = null;
          branch = null;
          return;
        }
        gitTry(["worktree", "remove", "--force", path], repo);
        // Delete only a throwaway with no committed work; keep committed branches
        // so a resume can reattach (#27). changedFiles is `diff main...branch`.
        if (branch && owned && changedFiles(repo, branch).length === 0)
          gitTry(["branch", "-D", "--", branch], repo); // never a user branch
        rmSync(marker, { force: true });
      }
      path = null;
      branch = null;
    };
    for (const line of list.out.split("\n")) {
      if (line.startsWith("worktree ")) {
        flush(); // new record — act on the previous one first
        path = line.slice("worktree ".length);
      } else if (line.startsWith("branch ")) {
        branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
      }
    }
    flush(); // last record has no trailing "worktree " to trigger it
  }
  gitTry(["worktree", "prune"], repo);
}

// One reused worktree, checked out on the `main` branch, where all merges land.
// Because it owns `main`, cwd must NOT be on main (enforced by the CLI preflight)
// — git forbids the same branch in two worktrees. The merge commit advances main
// directly; no ref-move gymnastics.
export function ensureIntegrationWorktree(repo, orchDir) {
  const path = join(orchDir, "integration");
  mkdirSync(orchDir, { recursive: true });
  gitTry(["worktree", "prune"], repo); // clear a stale registration if the dir was removed
  if (!existsSync(path)) git(["worktree", "add", path, "main"], repo);
  return path;
}

// Pull the integration worktree to main's current tip and drop any leftover
// half-merge / untracked cruft from a crashed finalize (§6.4).
export function syncWorktreeToMain(integrationPath) {
  git(["reset", "--hard", "main"], integrationPath);
  git(["clean", "-fd"], integrationPath);
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

// Simple patch-per-merge version bump, run in the integration worktree right
// after a merge lands and the post-merge test gate passes. Bumps package.json
// + src/version.js (the source `orch --version` reads from) and prepends a
// CHANGELOG.md entry, then commits — so every merge to main is traceable to a
// version. No-op (returns null) if package.json is missing or unparsable, so
// this never blocks a merge that would otherwise succeed.
export function bumpVersion(integrationPath, entry) {
  const pkgPath = join(integrationPath, "package.json");
  const versionPath = join(integrationPath, "src", "version.js");
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch {
    return null;
  }
  const parts = String(pkg.version).split(".");
  if (parts.length !== 3 || parts.some((p) => !/^\d+$/.test(p))) return null;
  const version = `${parts[0]}.${parts[1]}.${Number(parts[2]) + 1}`;

  pkg.version = version;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  if (existsSync(versionPath)) writeFileSync(versionPath, `export const VERSION = "${version}";\n`);

  const changelogPath = join(integrationPath, "CHANGELOG.md");
  const date = new Date().toISOString().slice(0, 10);
  const section = `## ${version} — ${date}\n- ${entry}\n\n`;
  const prior = existsSync(changelogPath) ? readFileSync(changelogPath, "utf8").replace(/^# Changelog\n+/, "") : "";
  writeFileSync(changelogPath, `# Changelog\n\n${section}${prior}`);

  const addFiles = ["package.json", "CHANGELOG.md"];
  if (existsSync(versionPath)) addFiles.splice(1, 0, "src/version.js");
  git(["add", ...addFiles], integrationPath);
  git(["commit", "-m", `chore(release): v${version}`], integrationPath);
  return version;
}

// Files changed on main since a given sha (what landed after a branch's base).
export function changedSince(repo, sha) {
  const out = gitTry(["diff", "--name-only", `${sha}..main`], repo);
  return out.ok ? out.out.split("\n").map((s) => s.trim()).filter(Boolean) : [];
}
