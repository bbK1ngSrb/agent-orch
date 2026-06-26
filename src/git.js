import { execFileSync } from "node:child_process";

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
export function createTaskBranch(repo, path, branch, base) {
  if (branchExists(repo, branch)) throw new Error(`branch already exists: ${branch}`);
  git(["worktree", "add", "-b", branch, path, base], repo);
}

// review mode: branch MUST exist (human/other tool made it). Never create it.
export function attachExistingBranch(repo, path, branch) {
  if (!branchExists(repo, branch)) throw new Error(`branch does not exist: ${branch}`);
  git(["worktree", "add", path, branch], repo);
}

export function pruneWorktree(repo, path) {
  gitTry(["worktree", "remove", "--force", path], repo);
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
