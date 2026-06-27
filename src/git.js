import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
export function mergeInWorktree(integrationPath, branch, mode) {
  const flag = mode === "no-ff" ? "--no-ff" : "--ff-only";
  const m = gitTry(["merge", flag, branch], integrationPath);
  if (m.ok) return { ok: true, reason: "merged" };
  const reason = m.out.trim();
  gitTry(["merge", "--abort"], integrationPath); // ff-only failures are no-ops here; harmless
  if (/untracked working tree files would be overwritten/i.test(reason)) {
    const files = reason.split("\n").filter((l) => /^\t/.test(l)).map((l) => l.trim());
    return { ok: false, reason, advice: `remove or commit these untracked files in main: ${files.join(", ")}` };
  }
  return { ok: false, reason };
}

// Files changed on main since a given sha (what landed after a branch's base).
export function changedSince(repo, sha) {
  const out = gitTry(["diff", "--name-only", `${sha}..main`], repo);
  return out.ok ? out.out.split("\n").map((s) => s.trim()).filter(Boolean) : [];
}
