import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  git(["worktree", "add", "-b", branch, path, base], repo);
  // Marker now records the owner so the sweep can spare LIVE peers (no global
  // lock anymore). Empty marker = died before writing = swept (legacy parity).
  writeFileSync(taskMarker(realpathSync(path)), markerContent);
}

// review mode: branch MUST exist (human/other tool made it). Never create it.
export function attachExistingBranch(repo, path, branch) {
  if (!branchExists(repo, branch)) throw new Error(`branch does not exist: ${branch}`);
  git(["worktree", "add", path, branch], repo);
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
// marker is present (so a same-slug task retry doesn't throw on `worktree add
// -b`); review-attached user branches have no marker and are always preserved.
export function reclaimOrphanWorktrees(repo, orchDir) {
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
        const marker = taskMarker(path);
        const owned = existsSync(marker); // orch-created throwaway?
        const pid = owned ? ownerPid(marker) : null;
        if (owned && pid !== null && pidAlive(pid)) {
          // live peer in a concurrent cycle — leave it entirely alone
          path = null;
          branch = null;
          return;
        }
        gitTry(["worktree", "remove", "--force", path], repo);
        if (branch && owned) gitTry(["branch", "-D", branch], repo); // never a user branch
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

export function mergeIntoMain(repo, branch, mode) {
  const cur = git(["rev-parse", "--abbrev-ref", "HEAD"], repo);
  if (cur !== "main") {
    const co = gitTry(["checkout", "main"], repo);
    if (!co.ok) return { ok: false, reason: `cannot checkout main: ${co.out}` };
  }
  const flag = mode === "no-ff" ? "--no-ff" : "--ff-only";
  const m = gitTry(["merge", flag, branch], repo);
  if (m.ok) return { ok: true, reason: "merged" };
  const reason = m.out.trim();
  // Untracked files in main colliding with branch output is NOT a history
  // problem — rebasing won't help. Surface the real fix and the file list.
  if (/untracked working tree files would be overwritten/i.test(reason)) {
    const files = reason.split("\n")
      .filter((l) => /^\t/.test(l))
      .map((l) => l.trim());
    const advice = `remove or commit these untracked files in main, then rerun: ${files.join(", ")}`;
    return { ok: false, reason, advice };
  }
  return { ok: false, reason };
}
