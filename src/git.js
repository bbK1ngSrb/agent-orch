import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sleepSync } from "./lock.js";

function originRef(base) {
  return `refs/remotes/origin/${base}`;
}

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
  // Signal 0 either succeeds (process exists, we can signal it) or throws.
  // EPERM means the process exists but we lack permission — still alive.
  // Any other code (ESRCH, or Windows' error for an out-of-range/bogus pid)
  // means dead: treating unrecognized errors as "alive" left huge test pids
  // (e.g. 999999999) wrongly protected from reclaim on Windows.
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

export function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

export function gitTry(args, cwd) {
  try {
    const out = execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
    return { ok: true, out: (out || "").toString() };
  } catch (e) {
    return { ok: false, out: (e.stderr || e.stdout || e.message || "").toString() };
  }
}

// Files changed on `branch` since its merge-base with the configured base branch.
export function changedFiles(repo, branch, base = "main") {
  const out = gitTry(["diff", "--name-only", `${base}...${branch}`], repo);
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

export function verifyOriginContains(repo, commit, base = "main") {
  const fetched = fetchOriginMain(repo, { base });
  if (!fetched.ok) return { ok: false, reason: fetched.reason };
  const r = gitTry(["merge-base", "--is-ancestor", commit, originRef(base)], repo);
  return r.ok
    ? { ok: true }
    : { ok: false, reason: `${commit} is not contained in origin/${base}` };
}

// Ref-lock contention: concurrent orch cycles share one .git and thus one
// refs/remotes/origin/main. A losing fetch fails "cannot lock ref" — transient,
// not a real sync problem — so retry a couple times before giving up.
const REF_LOCK_RE = /cannot lock ref/i;

export function fetchOriginMain(
  repo,
  { base = "main", retries = 2, sleep = sleepSync, fetch = () => gitTry(["fetch", "origin", `${base}:${originRef(base)}`], repo) } = {},
) {
  if (!gitTry(["remote", "get-url", "origin"], repo).ok)
    return { ok: false, missingOrigin: true, reason: "no origin remote configured" };
  for (let attempt = 0; ; attempt++) {
    const r = fetch();
    if (r.ok) return { ok: true };
    const reason = r.out.trim();
    if (attempt >= retries || !REF_LOCK_RE.test(reason)) return { ok: false, reason };
    sleep(50 * 2 ** attempt);
  }
}

function mainWorktreePath(repo, base = "main") {
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
    } else if (line === `branch refs/heads/${base}`) {
      onMain = true;
    }
  }
  return flush();
}

function moveMainToOrigin(repo, mode, base = "main") {
  const path = mainWorktreePath(repo, base);
  if (path) {
    if (mode === "reset") {
      git(["reset", "--hard", originRef(base)], path);
      git(["clean", "-fd"], path);
    } else {
      git(["merge", "--ff-only", originRef(base)], path);
    }
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
      moveMainToOrigin(repo, "merge", base);
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
    let path = null;
    let branch = null;
    const flush = () => {
      if (path && normalize(path).startsWith(wtRoot)) {
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
        const removed = gitTry(["worktree", "remove", "--force", path], repo);
        if (removed.ok) recovered = true;
        // Delete only a throwaway with no committed work; keep committed branches
        // so a resume can reattach (#27). changedFiles is `diff base...branch`.
        if (branch && owned && changedFiles(repo, branch, base).length === 0)
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

// If GitHub advanced the base branch after the last integration PR merge,
// integration can be cleanly behind it. Fast-forward that safe prefix case
// before landing more local work; never rewrite or discard integration commits.
export function reconcileIntegrationToBase(integrationPath, base = "main") {
  const head = git(["rev-parse", "HEAD"], integrationPath);
  const target = git(["rev-parse", base], integrationPath);
  if (head === target) return { ok: true, updated: false };
  if (!gitTry(["merge-base", "--is-ancestor", "HEAD", base], integrationPath).ok) {
    return { ok: true, updated: false, skipped: "not-fast-forward" };
  }
  try {
    git(["merge", "--ff-only", base], integrationPath);
    return { ok: true, updated: true, from: head, to: target };
  } catch (e) {
    const reason = (e.stderr || e.stdout || e.message || "").toString().trim();
    return { ok: false, reason: `could not fast-forward integration to ${base}: ${reason}` };
  }
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
// (+ package-lock.json's root version, + src/version.js — the source
// `orch --version` reads from) and prepends a CHANGELOG.md entry, then commits
// — so every merge to main is traceable to a version. No-op (returns null) if
// package.json is missing/unparsable, or if anything below fails (dirty
// target-repo pre-commit hooks, missing git identity, etc.) — this must never
// throw out of a finalize that already landed the merge (issue #44).
export function bumpVersion(integrationPath, entry) {
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

  try {
    const versionPath = join(integrationPath, "src", "version.js");
    pkg.version = version;
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
    if (existsSync(versionPath)) writeFileSync(versionPath, `export const VERSION = "${version}";\n`);

    const lockPath = join(integrationPath, "package-lock.json");
    if (existsSync(lockPath)) {
      const lock = JSON.parse(readFileSync(lockPath, "utf8"));
      lock.version = version;
      if (lock.packages?.[""]) lock.packages[""].version = version;
      writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    }

    const changelogPath = join(integrationPath, "CHANGELOG.md");
    const date = new Date().toISOString().slice(0, 10);
    const section = `## ${version} — ${date}\n- ${entry}\n\n`;
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
        writeFileSync(sitePath, next);
        siteBumped = true;
      }
    }

    const addFiles = ["package.json", "CHANGELOG.md"];
    if (existsSync(versionPath)) addFiles.push("src/version.js");
    if (existsSync(lockPath)) addFiles.push("package-lock.json");
    if (siteBumped) addFiles.push("docs/index.html");
    git(["add", ...addFiles], integrationPath);
    git(["commit", "-m", `chore(release): v${version}`], integrationPath);
    return version;
  } catch {
    gitTry(["reset", "--hard", "HEAD"], integrationPath);
    gitTry(["clean", "-fd"], integrationPath);
    return null;
  }
}

// Files changed on the landing branch since a given sha (what landed after a branch's base).
// Three-dot: diff from merge-base(sha, base) to base. Two-dot would return the
// REVERSE diff when base is behind sha (integration behind main), reporting every
// main-only change as "landed on integration" and false-positiving the overlap guard.
export function changedSince(repo, sha, base = "main") {
  const out = gitTry(["diff", "--name-only", `${sha}...${base}`], repo);
  return out.ok ? out.out.split("\n").map((s) => s.trim()).filter(Boolean) : [];
}
