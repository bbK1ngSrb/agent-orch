# Concurrent orch sessions on one repo — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let many `orch task` cycles run concurrently against one repo dir — author/audit/test fully parallel, only the final merge serialized — with auto-merge for clean work and PR-fallback (or local escalation) for risky work.

**Architecture:** Drop the whole-cycle `.orch/lock`. Each cycle gets a session id (`sid`) → unique branch `pr/<author>/<slug>-<sid>` and worktree. Crash recovery becomes PID-aware (ownership marker holds `pid\nsid`; a worktree is swept only if its owner PID is dead). Merges happen in a dedicated `.orch/integration` worktree (cwd HEAD never touched) under a short `.orch/merge.lock`, guarded by a file-overlap pre-check and a post-merge re-test. The engine stays a pure state machine; all new side effects arrive through injected collaborators (`finalize`, `inflight`).

**Tech Stack:** Node ≥18, ESM, `node:test`, `node:fs`, `node:child_process` (`git`/`gh` via `execFileSync`), `yaml` (only runtime dep). No new dependencies.

## Global Constraints

- Node `>=18`, `"type": "module"` — ESM `import`/`export` only.
- No new npm dependencies. Only `yaml` is allowed.
- Merge is **local, no push** (parity with today). The only push is in the PR-fallback path.
- `Date.now()` is permitted (this is runtime code, not a workflow script).
- State file names are fixed: `.orch/merge.lock`, `.orch/integration` (worktree), `.orch/inflight/<sid>.json`, ownership marker `<worktreePath>.orch-task` containing `<pid>\n<sid>`.
- Branch name: `pr/<author>/<slug>-<sid>`. Worktree path: `.orch/wt/<branch with "/" → "_">`.
- O_EXCL atomicity is validated on this nfs4 mount only; do not weaken the `lock.js` primitive.
- Tests run with `node --test` (`npm test`). The whole suite must stay green after every task.
- **Precondition (new):** `orch task`/`orch review` require cwd HEAD ≠ `main` (the `.orch/integration` worktree owns `main`). This is enforced by a preflight error (Task 10). The cwd-on-main hybrid is a documented §7 ceiling, not built.

---

## File structure

**New files:**
- `src/sid.js` — session-id generator (pure).
- `src/inflight.js` — in-flight cycle registry under `.orch/inflight/` (register/setPaths/deregister/listLive/countLive/peerPaths).
- `src/finalize.js` — the locked finalize collaborator (merge-lock → sync integration → overlap → merge → re-test → land or demote).
- `test/sid.test.js`, `test/inflight.test.js`, `test/finalize.test.js` — their tests.

**Modified files:**
- `src/config.js` — add `concurrency` key + validation.
- `src/lock.js` — parameterize lock name; add `acquireBlocking`.
- `src/git.js` — PID-aware marker/reclaim; integration-worktree helpers; `mergeInWorktree`; `changedSince`; remove `mergeIntoMain`.
- `src/github.js` — add `demote` (push + `gh pr create`, else local escalate).
- `src/engine.js` — capture `baseSha`, write inflight paths, call injected `finalize` instead of `git.mergeIntoMain`.
- `src/cli.js` — generate `sid`; drop whole-cycle lock from the task path; register inflight + concurrency cap; integration preflight; wire `finalize`/`inflight` into real and dry deps.
- Their `test/*.test.js` counterparts.

---

## Task 1: Add `concurrency` config key

**Files:**
- Modify: `src/config.js:5-21` (DEFAULTS), `src/config.js:23-48` (validate)
- Test: `test/config.test.js`

**Interfaces:**
- Produces: `cfg.concurrency` (positive integer, default `4`).

- [ ] **Step 1: Write the failing test**

Add to `test/config.test.js`:

```js
test("concurrency defaults to 4 and must be a positive integer", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-cfg-"));
  assert.equal(load(d).concurrency, 4);

  mkdirSync(join(d, ".orch"), { recursive: true });
  writeFileSync(join(d, ".orch", "orch.yml"), "concurrency: 8\n");
  assert.equal(load(d).concurrency, 8);

  writeFileSync(join(d, ".orch", "orch.yml"), "concurrency: 0\n");
  assert.throws(() => load(d), /concurrency must be a positive integer/);
});
```

Ensure the top of `test/config.test.js` imports `mkdirSync`, `writeFileSync` from `node:fs`, `mkdtempSync` from `node:fs`, `tmpdir` from `node:os`, `join` from `node:path`, and `load` from `../src/config.js` (add any missing ones).

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/config.test.js`
Expected: FAIL — `load(d).concurrency` is `undefined`.

- [ ] **Step 3: Add the default and validation**

In `src/config.js`, add to `DEFAULTS` (after `merge: "ff-only",`):

```js
  concurrency: 4, // max concurrent cycles per repo dir; over this, a cycle exits rather than blocks
```

In `validate(cfg)`, add (after the `reviseCap` check):

```js
  if (!Number.isInteger(cfg.concurrency) || cfg.concurrency < 1)
    throw new Error("orch.yml: concurrency must be a positive integer");
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/config.test.js`
Expected: PASS.

- [ ] **Step 5: Update the init scaffold**

In `src/cli.js`, the `SCAFFOLD` string, under `# === Cycle ===` after the `merge:` line, add:

```
concurrency: 4            # max concurrent orch cycles in this repo dir; over this a cycle exits; default: 4
```

- [ ] **Step 6: Run the full suite + commit**

Run: `npm test`
Expected: all pass.

```bash
git add src/config.js src/cli.js test/config.test.js
git commit -m "feat(config): add concurrency cap key (default 4)"
```

---

## Task 2: Parameterize the lock name + blocking acquire

**Files:**
- Modify: `src/lock.js:9-45`
- Test: `test/lock.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `acquireLock(orchDir, lockName = "lock", retried = false): boolean` (back-compat — default name unchanged).
  - `releaseLock(orchDir, lockName = "lock"): void`
  - `acquireBlocking(orchDir, lockName = "lock", { intervalMs = 200, timeoutMs = 300000 } = {}): boolean` — polls until acquired or times out.

- [ ] **Step 1: Write the failing tests**

Add to `test/lock.test.js`:

```js
test("a named lock is independent of the default lock", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-lock-"));
  assert.equal(acquireLock(d, "merge.lock"), true);
  assert.equal(acquireLock(d, "lock"), true); // different file, not blocked
  assert.equal(acquireLock(d, "merge.lock"), false); // same file, held
  releaseLock(d, "merge.lock");
  releaseLock(d, "lock");
  assert.equal(existsSync(join(d, "merge.lock")), false);
});

test("acquireBlocking returns true when free, false on timeout when held by a live owner", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-lock-"));
  assert.equal(acquireBlocking(d, "merge.lock", { intervalMs: 5, timeoutMs: 100 }), true);
  // still held by us (live PID) → a second blocking acquire must time out, not hang
  assert.equal(acquireBlocking(d, "merge.lock", { intervalMs: 5, timeoutMs: 50 }), false);
  releaseLock(d, "merge.lock");
});
```

Add `acquireBlocking` to the import line at the top of `test/lock.test.js`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/lock.test.js`
Expected: FAIL — `acquireBlocking is not a function`; `acquireLock(d, "merge.lock")` ignores the name.

- [ ] **Step 3: Implement parameterization + blocking acquire**

Replace `acquireLock` and `releaseLock` in `src/lock.js` and add `acquireBlocking` + `sleepSync`:

```js
export function acquireLock(orchDir, lockName = "lock", retried = false) {
  mkdirSync(orchDir, { recursive: true });
  const lockPath = join(orchDir, lockName);
  try {
    writeFileSync(lockPath, String(process.pid), { flag: "wx" });
    return true;
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    if (!retried && isStale(lockPath)) {
      rmSync(lockPath, { force: true });
      return acquireLock(orchDir, lockName, true); // one shot — never recurse on a re-crash
    }
    return false;
  }
}

export function releaseLock(orchDir, lockName = "lock") {
  rmSync(join(orchDir, lockName), { force: true });
}

// Block until the named lock is acquired or the timeout elapses. Used for the
// merge-lock: finalize must serialize (wait its turn), not skip its merge.
export function acquireBlocking(orchDir, lockName = "lock", { intervalMs = 200, timeoutMs = 300000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (acquireLock(orchDir, lockName)) return true;
    if (Date.now() >= deadline) return false;
    sleepSync(intervalMs);
  }
}

// Synchronous sleep with no busy-spin and no dependencies.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
```

`isStale` is unchanged (it already takes a full `lockPath`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/lock.test.js`
Expected: PASS (existing lock tests still pass — default name preserved).

- [ ] **Step 5: Commit**

```bash
git add src/lock.js test/lock.test.js
git commit -m "feat(lock): parameterize lock name + add blocking acquire for merge-lock"
```

---

## Task 3: Session id module

**Files:**
- Create: `src/sid.js`
- Test: `test/sid.test.js`

**Interfaces:**
- Produces: `newSid(): string` — short, collision-resistant within and across processes (`<pid>-<base36 counter>`).

- [ ] **Step 1: Write the failing test**

Create `test/sid.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { newSid } from "../src/sid.js";

test("newSid is unique per call and carries the pid", () => {
  const a = newSid();
  const b = newSid();
  assert.notEqual(a, b);
  assert.ok(a.startsWith(String(process.pid) + "-"));
  assert.match(a, /^\d+-[0-9a-z]+$/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/sid.test.js`
Expected: FAIL — cannot find `../src/sid.js`.

- [ ] **Step 3: Implement**

Create `src/sid.js`:

```js
// Per-cycle session id. pid disambiguates across processes; the monotonic
// counter disambiguates multiple cycles in one process. No Math.random/Date
// needed — this is enough and stays readable in branch names.
let counter = 0;
export function newSid() {
  return `${process.pid}-${(counter++).toString(36)}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/sid.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sid.js test/sid.test.js
git commit -m "feat(sid): per-cycle session id generator"
```

---

## Task 4: PID-aware ownership marker + reclaim

**Files:**
- Modify: `src/git.js:35-41` (`createTaskBranch`), `src/git.js:63-99` (`reclaimOrphanWorktrees`)
- Test: `test/git.test.js`

**Interfaces:**
- Consumes: marker content string from the engine (`<pid>\n<sid>`).
- Produces:
  - `createTaskBranch(repo, path, branch, base, markerContent = ""): void` — writes `markerContent` into `<path>.orch-task`.
  - `reclaimOrphanWorktrees(repo, orchDir): void` — sweeps a marked worktree **only if** its owner PID is dead (or the marker is empty/unparseable = legacy/pre-PID crash). A live owner's worktree is preserved.

- [ ] **Step 1: Write the failing tests**

Add to `test/git.test.js`:

```js
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

test("reclaim SWEEPS a worktree with an empty (pre-PID / died-early) marker", () => {
  const repo = newRepo();
  const orchDir = join(repo, ".orch");
  const wt = join(orchDir, "wt", "pr_claude_empty");
  createTaskBranch(repo, wt, "pr/claude/empty", "main", ""); // legacy empty marker

  reclaimOrphanWorktrees(repo, orchDir);

  assert.equal(branchExists(repo, "pr/claude/empty"), false);
});
```

Add `readFileSync` and `realpathSync` to the `node:fs` import in `test/git.test.js`.

> Note: the existing test "reclaimOrphanWorktrees removes a crashed cycle's worktree AND its branch" uses `createTaskBranch(repo, wt, "pr/claude/orphan", "main")` with no marker arg → empty marker → still swept. It stays green. The "PRESERVES a review-attached user branch" test uses `attachExistingBranch` (no marker) → no marker file → preserved. It stays green.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/git.test.js`
Expected: FAIL — `createTaskBranch` writes `""` regardless; reclaim sweeps the live-peer worktree.

- [ ] **Step 3: Implement marker write + PID-aware reclaim**

In `src/git.js`, change `createTaskBranch` (the `writeFileSync` line):

```js
export function createTaskBranch(repo, path, branch, base, markerContent = "") {
  if (branchExists(repo, branch)) throw new Error(`branch already exists: ${branch}`);
  git(["worktree", "add", "-b", branch, path, base], repo);
  // Marker now records the owner so the sweep can spare LIVE peers (no global
  // lock anymore). Empty marker = died before writing = swept (legacy parity).
  writeFileSync(taskMarker(realpathSync(path)), markerContent);
}
```

Add two helpers near the top of `src/git.js` (after `taskMarker`):

```js
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
```

Add `readFileSync` to the `node:fs` import at the top of `src/git.js` (it currently imports `existsSync, realpathSync, rmSync, writeFileSync`).

In `reclaimOrphanWorktrees`, change the `flush` closure so it spares live owners:

```js
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/git.test.js`
Expected: PASS (new + existing reclaim tests).

- [ ] **Step 5: Commit**

```bash
git add src/git.js test/git.test.js
git commit -m "feat(git): PID-aware ownership marker + reclaim spares live peers"
```

---

## Task 5: Integration-worktree helpers + merge-in-worktree

**Files:**
- Modify: `src/git.js` — add `ensureIntegrationWorktree`, `syncWorktreeToMain`, `mergeInWorktree`, `changedSince`; **remove** `mergeIntoMain` (lines 101-121)
- Test: `test/git.test.js` — migrate the 3 `mergeIntoMain` tests to `mergeInWorktree`; add an integration-worktree test

**Interfaces:**
- Produces:
  - `ensureIntegrationWorktree(repo, orchDir): string` — creates (once) and returns `.orch/integration`, checked out on the `main` branch. Reused thereafter.
  - `syncWorktreeToMain(integrationPath): void` — `reset --hard main` + `clean -fd` (discards any half-merge / cruft).
  - `mergeInWorktree(integrationPath, branch, mode): { ok, reason, advice? }` — `git merge --ff-only|--no-ff` inside the worktree; aborts on failure so nothing is left half-merged.
  - `changedSince(repo, sha): string[]` — `git diff --name-only <sha>..main`.

- [ ] **Step 1: Migrate the old merge tests + write the new ones**

In `test/git.test.js`:

1. Change the import line — drop `mergeIntoMain`, add the four new names:

```js
import { git, branchExists, createTaskBranch, attachExistingBranch, pruneWorktree, reclaimOrphanWorktrees, ensureIntegrationWorktree, syncWorktreeToMain, mergeInWorktree, changedSince } from "../src/git.js";
```

2. Replace the body of "createTaskBranch lifecycle + ff-only merge" to merge in the integration worktree:

```js
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
```

3. Replace "untracked collision -> advice names the files, not a rebase":

```js
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
```

4. Replace "ff-only merge fails (ok:false) when main moved":

```js
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
```

5. Add a new test asserting `changedSince` + integration never swept:

```js
test("changedSince lists files merged into main after a base sha", () => {
  const repo = newRepo();
  const base = git(["rev-parse", "main"], repo);
  writeFileSync(join(repo, "new.txt"), "x\n");
  git(["add", "."], repo); git(["commit", "-m", "land new"], repo);
  assert.deepEqual(changedSince(repo, base), ["new.txt"]);
});

test("reclaim never sweeps the .orch/integration worktree", () => {
  const repo = newRepo();
  git(["checkout", "-b", "work"], repo);
  const orchDir = join(repo, ".orch");
  ensureIntegrationWorktree(repo, orchDir);
  reclaimOrphanWorktrees(repo, orchDir);
  assert.match(git(["worktree", "list"], repo), /integration/); // outside wt/ → untouched
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/git.test.js`
Expected: FAIL — new functions not exported; `mergeIntoMain` import gone but still defined (unused) is fine; the four new tests fail.

- [ ] **Step 3: Implement the helpers and remove `mergeIntoMain`**

In `src/git.js`, delete the entire `mergeIntoMain` function (lines 101-121) and replace with:

```js
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
```

Add `mkdirSync` to the `node:fs` import at the top of `src/git.js`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/git.test.js`
Expected: PASS.

- [ ] **Step 5: Confirm no other module still imports `mergeIntoMain`**

Run: `grep -rn "mergeIntoMain" src test`
Expected: only matches inside `src/engine.js` (handled in Task 9) and `src/cli.js` dryDeps (handled in Task 10). If any other file references it, note it for that task.

- [ ] **Step 6: Commit**

```bash
git add src/git.js test/git.test.js
git commit -m "feat(git): integration worktree + merge-in-worktree, drop mergeIntoMain"
```

---

## Task 6: In-flight cycle registry

**Files:**
- Create: `src/inflight.js`
- Test: `test/inflight.test.js`

**Interfaces:**
- Produces:
  - `register(orchDir, sid, { branch, pid, baseSha }): void` — writes `.orch/inflight/<sid>.json` (`{ sid, branch, pid, baseSha, paths: [], ts }`).
  - `setPaths(orchDir, sid, paths, baseSha?): void` — updates the entry's `paths` (and `baseSha` if given). No-op if the file is gone.
  - `deregister(orchDir, sid): void`
  - `listLive(orchDir): object[]` — entries whose PID is alive; deletes dead entries as a side effect (inflight reclaim).
  - `countLive(orchDir): number`
  - `peerPaths(orchDir, sid): string[]` — flattened `paths` of all live entries except `sid`.

- [ ] **Step 1: Write the failing tests**

Create `test/inflight.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register, setPaths, deregister, listLive, countLive, peerPaths } from "../src/inflight.js";

test("register/setPaths/deregister roundtrip with a live pid", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-if-"));
  register(d, "s1", { branch: "pr/claude/a-s1", pid: process.pid, baseSha: "abc" });
  assert.equal(countLive(d), 1);
  setPaths(d, "s1", ["src/x.js"], "def");
  assert.deepEqual(listLive(d)[0].paths, ["src/x.js"]);
  assert.equal(listLive(d)[0].baseSha, "def");
  deregister(d, "s1");
  assert.equal(countLive(d), 0);
});

test("listLive drops dead-pid entries", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-if-"));
  register(d, "dead", { branch: "pr/x/dead", pid: 999999999, baseSha: "z" });
  register(d, "alive", { branch: "pr/x/alive", pid: process.pid, baseSha: "z" });
  assert.equal(countLive(d), 1);
  assert.equal(listLive(d)[0].sid, "alive");
});

test("peerPaths excludes the caller's own sid", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-if-"));
  register(d, "me", { branch: "b", pid: process.pid, baseSha: "z" });
  register(d, "peer", { branch: "b2", pid: process.pid, baseSha: "z" });
  setPaths(d, "me", ["a.js"]);
  setPaths(d, "peer", ["b.js", "c.js"]);
  assert.deepEqual(peerPaths(d, "me").sort(), ["b.js", "c.js"]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/inflight.test.js`
Expected: FAIL — cannot find `../src/inflight.js`.

- [ ] **Step 3: Implement**

Create `src/inflight.js`:

```js
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const dir = (orchDir) => join(orchDir, "inflight");
const file = (orchDir, sid) => join(dir(orchDir), `${sid}.json`);

export function register(orchDir, sid, { branch, pid, baseSha }) {
  mkdirSync(dir(orchDir), { recursive: true });
  writeFileSync(file(orchDir, sid), JSON.stringify({
    sid, branch, pid, baseSha, paths: [], ts: new Date().toISOString(),
  }));
}

export function setPaths(orchDir, sid, paths, baseSha) {
  const p = file(orchDir, sid);
  if (!existsSync(p)) return;
  const e = JSON.parse(readFileSync(p, "utf8"));
  e.paths = paths;
  if (baseSha) e.baseSha = baseSha;
  writeFileSync(p, JSON.stringify(e));
}

export function deregister(orchDir, sid) {
  rmSync(file(orchDir, sid), { force: true });
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== "ESRCH"; }
}

// Live entries; dead-owner files are deleted here (doubles as inflight reclaim).
export function listLive(orchDir) {
  const d = dir(orchDir);
  if (!existsSync(d)) return [];
  const out = [];
  for (const f of readdirSync(d)) {
    if (!f.endsWith(".json")) continue;
    const p = join(d, f);
    try {
      const e = JSON.parse(readFileSync(p, "utf8"));
      if (Number.isInteger(e.pid) && pidAlive(e.pid)) out.push(e);
      else rmSync(p, { force: true });
    } catch {
      rmSync(p, { force: true }); // unreadable → stale
    }
  }
  return out;
}

export function countLive(orchDir) {
  return listLive(orchDir).length;
}

export function peerPaths(orchDir, sid) {
  return listLive(orchDir).filter((e) => e.sid !== sid).flatMap((e) => e.paths || []);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/inflight.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/inflight.js test/inflight.test.js
git commit -m "feat(inflight): in-flight cycle registry for cap + overlap"
```

---

## Task 7: PR-fallback / local-escalation helper

**Files:**
- Modify: `src/github.js` — add `demote`
- Test: `test/github.test.js`

**Interfaces:**
- Consumes: `gh(args, input?)`, `git(args, cwd)` (throwing forms), `notify` (`escalate`), `log?`.
- Produces:
  - `demote({ repo, orchDir, branch, reason }, { gh, git, notify, log? }): Promise<{ prUrl: string | null }>` — if the repo has a remote AND `gh` is available: push the branch and `gh pr create`, returning the URL. Otherwise: local escalation (write `DECISION.md` via `notify.escalate`, keep the branch), returning `{ prUrl: null }`.

- [ ] **Step 1: Write the failing tests**

Add to `test/github.test.js` (match the file's existing stub style — the module shells out only through injected `gh`/`git`):

```js
import { demote } from "../src/github.js";

test("demote opens a PR when a remote and gh are present", async () => {
  const calls = [];
  const gh = (args) => { calls.push(["gh", ...args]); return args[0] === "--version" ? "gh 2" : "https://github.com/o/r/pull/7\n"; };
  const git = (args) => { calls.push(["git", ...args]); return args[0] === "remote" ? "origin\n" : ""; };
  const notify = { escalate: () => { throw new Error("should not escalate when PR opens"); } };

  const r = await demote({ repo: "/r", orchDir: "/r/.orch", branch: "pr/claude/x-1", reason: "overlap" }, { gh, git, notify });
  assert.equal(r.prUrl, "https://github.com/o/r/pull/7");
  assert.ok(calls.some((c) => c[0] === "git" && c[1] === "push"));
  assert.ok(calls.some((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "create"));
});

test("demote escalates locally when there is no remote", async () => {
  let escalated = null;
  const gh = () => "gh 2";
  const git = (args) => (args[0] === "remote" ? "" : ""); // no remotes
  const notify = { escalate: (orchDir, branch, brief) => { escalated = { branch, brief }; } };

  const r = await demote({ repo: "/r", orchDir: "/r/.orch", branch: "pr/claude/x-1", reason: "conflict" }, { gh, git, notify });
  assert.equal(r.prUrl, null);
  assert.equal(escalated.branch, "pr/claude/x-1");
  assert.match(escalated.brief, /conflict/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/github.test.js`
Expected: FAIL — `demote` is not exported.

- [ ] **Step 3: Implement**

Add to `src/github.js`:

```js
function hasRemote(repo, git) {
  try { return git(["remote"], repo).trim().length > 0; } catch { return false; }
}

function ghAvailable(gh) {
  try { gh(["--version"]); return true; } catch { return false; }
}

// Demote an approved-but-unmergeable branch: open a PR if we can, else escalate
// locally (keep the branch + write DECISION.md). Never pushes to main.
export async function demote(ctx, deps) {
  const { repo, orchDir, branch, reason } = ctx;
  const { gh, git, notify, log = () => {} } = deps;
  if (!hasRemote(repo, git) || !ghAvailable(gh)) {
    notify.escalate(orchDir, branch,
      `# Escalation — ${branch}\n\nAuto-merge demoted (reason: ${reason}). No git remote or gh CLI available to open a PR. The branch is kept for manual review.\n`);
    return { prUrl: null };
  }
  git(["push", "-u", "origin", branch], repo);
  const url = gh([
    "pr", "create", "--head", branch, "--base", "main",
    "--title", `orch: ${branch}`,
    "--body", `Auto-demoted by agent-orch (reason: ${reason}). Agents agreed and the branch was green in isolation, but it could not be safely auto-merged into main.`,
  ]).trim();
  log(`opened PR for ${branch}: ${url}`);
  return { prUrl: url };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/github.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/github.js test/github.test.js
git commit -m "feat(github): demote helper — open PR or escalate locally"
```

---

## Task 8: The finalize collaborator

**Files:**
- Create: `src/finalize.js`
- Test: `test/finalize.test.js`

**Interfaces:**
- Consumes (deps, all injectable): `git` (`git`, `ensureIntegrationWorktree`, `syncWorktreeToMain`, `mergeInWorktree`, `changedSince`), `gate` (`run`), `lock` (`acquireBlocking`, `releaseLock`), `inflight` (`peerPaths`), `github` (`demote`), `notify` (`recordRun`, `cleanupReviews`).
- Produces:
  - `finalize(ctx, deps): Promise<{ status, reason, sha?, prUrl? }>` where `ctx = { repo, orchDir, branch, sid, baseSha, paths, testCmd, cfg, rounds }`.
  - `status` is `"merged"` (landed) or `"pr-fallback"` (demoted — overlap | conflict | post-merge-test-fail | merge-lock timeout). On success records `{ verdict: "merged", sha }`; on fallback records `{ verdict: "pr-fallback", reason }`.

- [ ] **Step 1: Write the failing tests**

Create `test/finalize.test.js` (pure unit test with stubbed deps — no real git):

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { finalize } from "../src/finalize.js";

function baseDeps(over = {}) {
  const recorded = [];
  const deps = {
    git: {
      ensureIntegrationWorktree: () => "/integ",
      syncWorktreeToMain: () => {},
      changedSince: () => [],
      mergeInWorktree: () => ({ ok: true, reason: "merged" }),
      git: (args) => (args[0] === "rev-parse" ? "deadbee" : ""),
    },
    gate: { run: () => ({ pass: true, log: "" }) },
    lock: { acquireBlocking: () => true, releaseLock: () => {} },
    inflight: { peerPaths: () => [] },
    github: { demote: async () => ({ prUrl: "https://x/pr/1" }) },
    notify: { recordRun: (d, e) => recorded.push(e), cleanupReviews: () => {} },
  };
  return { deps: { ...deps, ...over }, recorded };
}

const ctx = () => ({
  repo: "/r", orchDir: "/r/.orch", branch: "pr/claude/x-1", sid: "1",
  baseSha: "base", paths: ["src/a.js"], testCmd: "npm test", cfg: { merge: "no-ff" }, rounds: 1,
});

test("clean path → merged + recorded", async () => {
  const { deps, recorded } = baseDeps();
  const r = await finalize(ctx(), deps);
  assert.equal(r.status, "merged");
  assert.equal(recorded[0].verdict, "merged");
});

test("path overlap with a peer → pr-fallback (no merge attempted)", async () => {
  let merged = false;
  const { deps, recorded } = baseDeps({
    inflight: { peerPaths: () => ["src/a.js"] },
    git: { ...baseDeps().deps.git, mergeInWorktree: () => { merged = true; return { ok: true }; } },
  });
  const r = await finalize(ctx(), deps);
  assert.equal(r.status, "pr-fallback");
  assert.equal(r.reason.includes("overlap"), true);
  assert.equal(merged, false);
  assert.equal(recorded[0].verdict, "pr-fallback");
});

test("overlap with a changeset landed since base → pr-fallback", async () => {
  const { deps } = baseDeps({ git: { ...baseDeps().deps.git, changedSince: () => ["src/a.js"] } });
  const r = await finalize(ctx(), deps);
  assert.equal(r.status, "pr-fallback");
  assert.match(r.reason, /overlap/);
});

test("merge conflict → pr-fallback", async () => {
  const { deps } = baseDeps({ git: { ...baseDeps().deps.git, mergeInWorktree: () => ({ ok: false, reason: "CONFLICT" }) } });
  const r = await finalize(ctx(), deps);
  assert.equal(r.status, "pr-fallback");
  assert.match(r.reason, /conflict/);
});

test("post-merge test failure → reset + pr-fallback", async () => {
  const resets = [];
  const g = baseDeps().deps.git;
  const { deps } = baseDeps({
    gate: { run: () => ({ pass: false, log: "boom" }) },
    git: { ...g, git: (args) => { if (args[0] === "reset") resets.push(args); return args[0] === "rev-parse" ? "pre" : ""; } },
  });
  const r = await finalize(ctx(), deps);
  assert.equal(r.status, "pr-fallback");
  assert.match(r.reason, /post-merge-test-fail/);
  assert.ok(resets.length === 1); // rolled main back to pre-merge sha
});

test("merge-lock timeout → pr-fallback without touching the worktree", async () => {
  let ensured = false;
  const { deps } = baseDeps({
    lock: { acquireBlocking: () => false, releaseLock: () => {} },
    git: { ...baseDeps().deps.git, ensureIntegrationWorktree: () => { ensured = true; return "/integ"; } },
  });
  const r = await finalize(ctx(), deps);
  assert.equal(r.status, "pr-fallback");
  assert.equal(ensured, false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/finalize.test.js`
Expected: FAIL — cannot find `../src/finalize.js`.

- [ ] **Step 3: Implement**

Create `src/finalize.js`:

```js
// The only globally-serialized step. Holds .orch/merge.lock while it syncs the
// integration worktree, runs the two conflict guards (file-overlap pre-check +
// post-merge re-test), and either lands the merge into local main or demotes the
// branch to a PR / local escalation. The engine calls this via deps.finalize so
// it stays a pure state machine.
export async function finalize(ctx, deps) {
  const { repo, orchDir, branch, sid, baseSha, paths, testCmd, cfg, rounds } = ctx;
  const { git, gate, lock, inflight, github, notify } = deps;

  if (!lock.acquireBlocking(orchDir, "merge.lock")) {
    return demote(ctx, deps, "merge-lock timeout"); // never acquired → don't touch the worktree
  }
  try {
    const integration = git.ensureIntegrationWorktree(repo, orchDir);
    git.syncWorktreeToMain(integration);

    // Guard 1: file-overlap. Anything that landed on main since our base, plus
    // any live peer's changed paths. Read under the lock so it is consistent.
    const others = [...git.changedSince(repo, baseSha), ...inflight.peerPaths(orchDir, sid)];
    if (overlaps(paths, others)) return demote(ctx, deps, "overlap");

    const preSha = git.git(["rev-parse", "HEAD"], integration); // main tip pre-merge
    const m = git.mergeInWorktree(integration, branch, cfg.merge);
    if (!m.ok) return demote(ctx, deps, "conflict");

    // Guard 2: re-run the test gate against integrated main.
    const { pass } = gate.run(testCmd, integration);
    if (!pass) {
      git.git(["reset", "--hard", preSha], integration); // roll main back
      return demote(ctx, deps, "post-merge-test-fail");
    }

    const sha = git.git(["rev-parse", "--short", "HEAD"], integration);
    notify.recordRun(orchDir, { ts: new Date().toISOString(), branch, verdict: "merged", sha, rounds });
    notify.cleanupReviews(orchDir, branch);
    return { status: "merged", reason: "agreed + green + merged", sha };
  } finally {
    lock.releaseLock(orchDir, "merge.lock");
  }
}

function overlaps(mine, others) {
  const set = new Set(others);
  return mine.some((p) => set.has(p));
}

async function demote(ctx, deps, reason) {
  const { orchDir, repo, branch, rounds } = ctx;
  const { github, notify } = deps;
  const r = await github.demote({ repo, orchDir, branch, reason }, github);
  notify.recordRun(orchDir, {
    ts: new Date().toISOString(), branch, verdict: "pr-fallback", reason, rounds,
    ...(r.prUrl ? { prUrl: r.prUrl } : {}),
  });
  return {
    status: "pr-fallback",
    reason: r.prUrl ? `${reason} → PR ${r.prUrl}` : `${reason} → escalated locally (no remote)`,
    prUrl: r.prUrl,
  };
}
```

> Note on `github.demote(..., github)`: the engine wires `deps.github` as an object exposing `demote(ctx, self)` where `self` carries `gh/git/notify/log`. The finalize test stubs `github.demote` directly, ignoring the second arg. Task 9 wires the real binding so the second arg is the real `{ gh, git, notify, log }`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/finalize.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/finalize.js test/finalize.test.js
git commit -m "feat(finalize): locked merge with overlap + re-test guards, demote on failure"
```

---

## Task 9: Wire the engine to `finalize` + `inflight`

**Files:**
- Modify: `src/engine.js:5-21` (signature + base sha), `src/engine.js:78-94` (merge block)
- Test: `test/engine.test.js`

**Interfaces:**
- Consumes: `opts.sid` (from the CLI), `deps.finalize(ctx)`, `deps.inflight.setPaths(...)`.
- Produces: `runCycle` returns `status: "merged"` (landed) or `status: "pr-fallback"` (demoted) in place of the old inline merge/escalate-on-merge-fail path. `docsOnly`/`noop` still returned.

- [ ] **Step 1: Write/adjust the failing tests**

In `test/engine.test.js`, the existing tests inject a `git` stub with `mergeIntoMain`. They must move to a `finalize` stub. Add `finalize` and `inflight` to the deps used in the success-path test, and add a fallback test. Representative additions (adapt to the file's existing helper/deps shape):

```js
test("AGREE + green → finalize lands the merge (status merged)", async () => {
  const calls = [];
  const deps = {
    adapters: { get: () => ({ name: "claude", async author() {}, async audit() { return { decision: "AGREE", reason: "ok" }; } }) },
    git: {
      createTaskBranch() {}, attachExistingBranch() {}, pruneWorktree() {},
      changedFiles: () => ["src/a.js"],
      git: (args) => (args[0] === "rev-parse" ? "base" : ""),
    },
    gate: { detect: () => "npm test", run: () => ({ pass: true }) },
    scope: { count: () => 0 },
    inflight: { setPaths: (...a) => calls.push(["setPaths", ...a]) },
    finalize: async () => ({ status: "merged", reason: "merged", sha: "abc" }),
    notify: makeNotifyStub(), // existing helper or inline stub capturing recordRun/escalate/etc.
  };
  const res = await runCycle({
    mode: "task", task: "do x", branch: "pr/claude/x-1", sid: "1",
    authorName: "claude", reviewerName: "claude", cfg: testCfg(), orchDir: "/o", repo: "/r",
    worktree: "/o/wt/x",
  }, deps);
  assert.equal(res.status, "merged");
  assert.ok(calls.some((c) => c[0] === "setPaths"));
});

test("AGREE + green but finalize demotes → status pr-fallback", async () => {
  const deps = { /* as above */ };
  deps.finalize = async () => ({ status: "pr-fallback", reason: "overlap → PR https://x/1", prUrl: "https://x/1" });
  const res = await runCycle({ /* same opts */ }, deps);
  assert.equal(res.status, "pr-fallback");
});
```

> If `test/engine.test.js` has a shared `realishDeps()`/`makeNotify()` helper, extend it to include `inflight: { setPaths(){} }` and `finalize: async () => ({ status: "merged", reason: "merged", sha: "x" })` so the other existing tests keep passing.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/engine.test.js`
Expected: FAIL — engine still calls `git.mergeIntoMain` (now undefined in stubs) and does not call `deps.finalize`.

- [ ] **Step 3: Edit the engine**

In `src/engine.js`, add `sid` to the destructured opts (line 6):

```js
  const { mode = "task", task, branch, authorName, reviewerName, cfg, orchDir, repo, worktree, noMerge = false, sid } = opts;
```

Add `finalize, inflight` to the deps destructure (line 7):

```js
  const { adapters, git, gate, scope, notify, finalize, inflight } = deps;
```

Pass the PID-aware marker when creating the task branch. Change line 22 from `git.createTaskBranch(repo, worktree, branch, "main");` to:

```js
  else git.createTaskBranch(repo, worktree, branch, "main", `${process.pid}\n${sid}`);
```

After the branch is created/attached (right after line 21, the `if (mode === "review") ... else ...` block), capture the base sha:

```js
  const baseSha = git.git(["rev-parse", "main"], repo);
```

After the task-mode author/scope block and before `const cap = ...` (around line 41), publish this cycle's changed paths so peers' overlap checks can see them:

```js
    // Publish changed paths for peer overlap checks (best-effort; finalize re-reads at land time).
    if (inflight) inflight.setPaths(orchDir, sid, git.changedFiles(repo, branch), baseSha);
```

Replace the merge block (current lines 78-94, from the `// Compute the loop-guard signals` comment through the `return { status: "merged", ... }`) with:

```js
        // Compute the loop-guard signals BEFORE finalize: a ff merge makes
        // main...branch empty, so reading it post-merge always yields [].
        const changed = git.changedFiles(repo, branch);
        const docsOnly = isDocsOnly(changed, cfg.docs.paths);
        const noop = changed.length === 0;
        const fin = await finalize({
          repo, orchDir, branch, sid, baseSha, paths: changed,
          testCmd, cfg, rounds: round,
        }, deps);
        notify.phase(fin.status === "merged" ? `merged ${branch}` : `demoted ${branch} (${fin.reason})`);
        return { status: fin.status, reason: fin.reason, rounds: round, docsOnly, noop };
```

(The old `git.mergeIntoMain` call, its escalate-on-fail branch, the inline `recordRun`, and `cleanupReviews` are all removed — `finalize` now owns recording and cleanup.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/engine.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine.js test/engine.test.js
git commit -m "feat(engine): delegate merge to injected finalize; publish inflight paths"
```

---

## Task 10: Wire the CLI — sid, drop whole-cycle lock, cap, integration preflight, real/dry deps

**Files:**
- Modify: `src/cli.js` — imports, `realDeps`/`dryDeps`, the `task`/`review` command block (lines ~283-345)
- Test: `test/cli.test.js`

**Interfaces:**
- Consumes: `newSid` (`./sid.js`), `inflight` (`./inflight.js`), `finalize` (`./finalize.js`), `demote` (`./github.js`), config `concurrency`.
- Produces: task/review branches carry a `sid`; no whole-cycle lock on the task path; per-cycle inflight registration with a cap gate; integration preflight (error if cwd on `main`).

- [ ] **Step 1: Write the failing tests**

Add to `test/cli.test.js` (these run under `ORCH_DRYRUN=1` / `--dry`, which must NOT touch real git or require CLIs — match the file's existing dry-run harness):

```js
test("task branch includes a sid suffix", async () => {
  // capture the branch passed to runCycle by stubbing deps.cycle or asserting on console output
  // (use the file's existing pattern for inspecting the cycle invocation)
  const logs = await runMainCapture(["task", "do a thing", "--dry"]); // helper in this test file
  assert.match(logs.join("\n"), /pr\/[a-z]+\/do-a-thing-\d+-[0-9a-z]+:/);
});

test("over the concurrency cap, a cycle is skipped (not blocked)", async () => {
  // pre-seed .orch/inflight with `concurrency` live entries (pid = process.pid),
  // then run one more `orch task` and assert it reports the cap message.
  // (build the repo dir via the file's existing tmp-repo helper)
});

test("orch task errors clearly when cwd HEAD is main", async () => {
  // tmp git repo left on main; run `orch task "x"` (non-dry path stubbed preflight)
  // assert the thrown error mentions the integration worktree / switch off main.
});
```

> Implement these against `test/cli.test.js`'s existing helpers (it already drives `main(argv, deps)` with stubbed `preflight`). If a helper to capture `console.log` does not exist, add a minimal one at the top of the file. Keep the cap test deterministic by writing inflight files directly with `inflight.register`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/cli.test.js`
Expected: FAIL — no sid in branch; no cap handling; no main-preflight error.

- [ ] **Step 3: Edit imports and deps**

In `src/cli.js`, update imports:

```js
import { acquireLock, releaseLock, acquireBlocking, isPaused } from "./lock.js";
import { slugify } from "./slug.js";
import { newSid } from "./sid.js";
import * as inflight from "./inflight.js";
import { finalize } from "./finalize.js";
import { demote } from "./github.js";
```

(`runPr` import stays; `runCycle` import stays.)

Update `realDeps()` to inject `finalize` and `inflight`, binding `finalize`'s collaborators (note `github` is an object whose `demote` is pre-bound to real shells):

```js
function realDeps() {
  const ghShell = (args, input) => execFileSync("gh", args, { input, encoding: "utf8" }).toString();
  const githubDep = { demote: (ctx) => demote(ctx, { gh: ghShell, git: git.git, notify, log: (m) => process.stderr.write(`▶ ${m}\n`) }) };
  const finalizeDep = (ctx, deps) => finalize(ctx, { git, gate, lock: { acquireBlocking, releaseLock }, inflight, github: githubDep, notify });
  return { adapters, git, gate, scope, notify, inflight, finalize: finalizeDep };
}
```

> `finalize` ignores its own first-class deps arg for collaborators — it reads them from the closure above. The engine calls `deps.finalize(ctx, deps)`; `finalizeDep` discards the engine's `deps` and uses the bound real collaborators. (In `src/finalize.js`, `finalize(ctx, deps)` reads `deps.git`, `deps.lock`, etc. — so pass the bound object directly instead. Simplify by making `finalizeDep = (ctx) => finalize(ctx, { git, gate, lock: { acquireBlocking, releaseLock }, inflight, github: githubDep, notify })`. The engine calls `deps.finalize(ctx, deps)`; the extra `deps` arg is ignored.)

Final `realDeps` (use this exact form):

```js
function realDeps() {
  const ghShell = (args, input) => execFileSync("gh", args, { input, encoding: "utf8" }).toString();
  const githubDep = { demote: (ctx) => demote(ctx, { gh: ghShell, git: git.git, notify, log: (m) => process.stderr.write(`▶ ${m}\n`) }) };
  const finalizeDep = (ctx) => finalize(ctx, { git, gate, lock: { acquireBlocking, releaseLock }, inflight, github: githubDep, notify });
  return { adapters, git, gate, scope, notify, inflight, finalize: finalizeDep };
}
```

In `src/finalize.js`, `demote(ctx, deps)` calls `github.demote(ctx, github)` — but `githubDep.demote` takes only `(ctx)`. Adjust the `finalize.js` `demote` helper call to `github.demote(ctx)` (drop the second arg). Update Task 8's `demote` helper line accordingly:

```js
  const r = await github.demote({ repo, orchDir, branch, reason });
```

(The finalize unit test in Task 8 stubs `github.demote` as `async () => (...)`, which accepts any args — still passes.)

Update `dryDeps()`: remove `mergeIntoMain` from the git stub, add `git`/`changedFiles` already present, add `inflight` + `finalize` stubs:

```js
function dryDeps() {
  const verdict = { decision: "AGREE", reason: "(dry-run: assumed agree)", raw: "" };
  return {
    adapters: { get: (n) => ({ name: n, async author() {}, async audit() { return verdict; } }) },
    git: {
      createTaskBranch() {}, attachExistingBranch() {}, pruneWorktree() {},
      git() { return "(dry-run)"; },
      changedFiles() { return []; },
    },
    gate: { detect: () => "true", run: () => ({ pass: true, log: "(dry-run)" }) },
    scope: { count: () => 0 },
    inflight: { setPaths() {} },
    finalize: async () => ({ status: "merged", reason: "dry-run", sha: "dry" }),
    notify,
  };
}
```

- [ ] **Step 4: Edit the task/review command block**

In the `if (command === "task" || command === "review")` block:

Generate a `sid` per run and put it in the branch + opts. In the task-mode `runs = authors.map(...)`:

```js
      runs = authors.map((authorSpec) => {
        const authorName = authorSpec.agent;
        const sid = newSid();
        const branch = `pr/${authorName}/${slugify(task)}-${sid}`;
        const reviewerList = reviewersForAuthor(authorName, reviewers);
        return {
          mode, task, branch, sid, authorName, author: authorSpec,
          reviewerName: reviewerList[0].agent, reviewerNames: reviewerList.map((s) => s.agent),
          reviewers: reviewerList,
          cfg, orchDir, repo, worktree: join(orchDir, "wt", branch.replace(/\//g, "_")),
        };
      });
```

In the review-mode single run, add `sid`:

```js
      const sid = newSid();
      runs = [{
        mode, task, branch, sid, authorName, author: { agent: authorName, model: null, effort: null },
        reviewerName: reviewers[0].agent, reviewerNames: reviewers.map((s) => s.agent),
        reviewers,
        cfg, orchDir, repo, worktree: join(orchDir, "wt", branch.replace(/\//g, "_")),
      }];
```

Replace the lock + run loop (current lines 328-343). Remove `acquireLock`/`releaseLock` around the cycles; add the integration preflight, then per-cycle inflight registration + cap gate:

```js
    // Integration worktree owns `main`; cwd must be on a working branch.
    if (!dry) {
      const head = git.git(["rev-parse", "--abbrev-ref", "HEAD"], repo);
      if (head === "main")
        throw new Error("orch needs `main` for its .orch/integration worktree — switch cwd to a working branch (e.g. `git switch -c work`) and rerun.");
      git.reclaimOrphanWorktrees(repo, orchDir); // PID-aware: clears dead cycles, spares live peers
    }

    const results = [];
    for (const run of runs) {
      if (!dry) {
        const baseSha = git.git(["rev-parse", "main"], repo);
        inflight.register(orchDir, run.sid, { branch: run.branch, pid: process.pid, baseSha });
        const live = inflight.countLive(orchDir);
        if (live > cfg.concurrency) {
          inflight.deregister(orchDir, run.sid);
          console.log(`orch: concurrency cap ${cfg.concurrency} reached — ${live} cycles live; skipping ${run.branch}`);
          process.exitCode = 2;
          continue;
        }
      }
      try {
        const result = await runCycle(run, dry ? dryDeps() : realDeps());
        results.push(result);
        console.log(`orch${dry ? " (dry)" : ""}: ${run.branch}: ${result.status} (${result.reason}) after ${result.rounds} round(s)`);
        if (result.status === "escalated" || result.status === "pr-fallback") process.exitCode = 2;
      } finally {
        if (!dry) inflight.deregister(orchDir, run.sid);
      }
    }
    // After the cycles: the detached docs-update runs `orch task`, so spawn it
    // outside the loop. maybeSpawnDocs only fires on a real `merged` result.
    for (const result of results) maybeSpawnDocs(result, cfg, { dry }, orchDir);
    return;
```

> The `acquireLock`/`releaseLock`/`isPaused` imports stay: `isPaused` is still checked above; `acquireLock`/`releaseLock` are still used by the `pr` command (left unchanged — `orch pr` does not merge locally, so its existing serialization is harmless and out of scope).

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/cli.test.js`
Expected: PASS.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: all pass. If `test/smoke.test.js` or `test/docs.test.js` exercised the old `mergeIntoMain` or the whole-cycle lock on the task path, update them to the new flow (sid branches, no `.orch/lock` on task, finalize-driven merge).

- [ ] **Step 7: Manual smoke (dry-run, no agents needed)**

Run:
```bash
node bin/orch.js task "concurrent smoke test" --dry
```
Expected: a line like `orch (dry): pr/claude/concurrent-smoke-test-<pid>-0: merged (dry-run) after 1 round(s)` and no `.orch/lock` left behind.

- [ ] **Step 8: Commit**

```bash
git add src/cli.js src/finalize.js test/cli.test.js test/smoke.test.js test/docs.test.js
git commit -m "feat(cli): sid branches, drop whole-cycle lock, concurrency cap, integration preflight"
```

---

## Task 11: Concurrent integration test (the load-bearing one)

**Files:**
- Create: `test/concurrent.test.js`

**Interfaces:**
- Consumes: real `git.js` + `finalize.js` + `inflight.js` against tmp git repos. No agent CLIs (drive the cycle with stubbed adapters via `runCycle`, or drive `finalize` directly with real git).

This task proves the spec §8 integration scenarios with real git, which the per-module unit tests do not.

- [ ] **Step 1: Write the integration tests**

Create `test/concurrent.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, createTaskBranch, pruneWorktree, ensureIntegrationWorktree } from "../src/git.js";
import { finalize } from "../src/finalize.js";
import * as inflight from "../src/inflight.js";
import { acquireBlocking, releaseLock } from "../src/lock.js";
import * as notify from "../src/notify.js";

function realDeps() {
  return {
    git, gate: { run: () => ({ pass: true }) },
    lock: { acquireBlocking, releaseLock },
    inflight,
    github: { demote: async ({ branch }) => ({ prUrl: null }) }, // no remote → local escalate
    notify,
  };
}

function newRepo() {
  const d = mkdtempSync(join(tmpdir(), "orch-cc-"));
  git(["init", "-b", "main"], d);
  git(["config", "user.email", "t@t"], d);
  git(["config", "user.name", "t"], d);
  writeFileSync(join(d, "base.txt"), "0\n");
  git(["add", "."], d); git(["commit", "-m", "init"], d);
  git(["checkout", "-b", "work"], d); // cwd off main
  return d;
}

function makeBranch(repo, orchDir, name, file, content) {
  const wt = join(orchDir, "wt", name.replace(/\//g, "_"));
  const base = git(["rev-parse", "main"], repo);
  createTaskBranch(repo, wt, name, "main", `${process.pid}\n${name}`);
  writeFileSync(join(wt, file), content);
  git(["add", "."], wt); git(["commit", "-m", `add ${file}`], wt);
  pruneWorktree(repo, wt);
  return base;
}

test("two disjoint branches both auto-merge into main", async () => {
  const repo = newRepo();
  const orchDir = join(repo, ".orch");
  const baseA = makeBranch(repo, orchDir, "pr/claude/a-1", "a.txt", "A\n");
  const baseB = makeBranch(repo, orchDir, "pr/codex/b-2", "b.txt", "B\n");

  const rA = await finalize({ repo, orchDir, branch: "pr/claude/a-1", sid: "1", baseSha: baseA, paths: ["a.txt"], testCmd: "true", cfg: { merge: "no-ff" }, rounds: 1 }, realDeps());
  const rB = await finalize({ repo, orchDir, branch: "pr/codex/b-2", sid: "2", baseSha: baseB, paths: ["b.txt"], testCmd: "true", cfg: { merge: "no-ff" }, rounds: 1 }, realDeps());

  assert.equal(rA.status, "merged");
  assert.equal(rB.status, "merged");
  const log = git(["log", "--oneline", "main"], repo);
  assert.match(log, /add a.txt/);
  assert.match(log, /add b.txt/);
});

test("overlapping branches: first merges, second demotes (overlap)", async () => {
  const repo = newRepo();
  const orchDir = join(repo, ".orch");
  const baseA = makeBranch(repo, orchDir, "pr/claude/a-1", "shared.txt", "A\n");
  const baseB = makeBranch(repo, orchDir, "pr/codex/b-2", "shared.txt", "B\n");

  const rA = await finalize({ repo, orchDir, branch: "pr/claude/a-1", sid: "1", baseSha: baseA, paths: ["shared.txt"], testCmd: "true", cfg: { merge: "no-ff" }, rounds: 1 }, realDeps());
  const rB = await finalize({ repo, orchDir, branch: "pr/codex/b-2", sid: "2", baseSha: baseB, paths: ["shared.txt"], testCmd: "true", cfg: { merge: "no-ff" }, rounds: 1 }, realDeps());

  assert.equal(rA.status, "merged");
  assert.equal(rB.status, "pr-fallback");
  assert.match(rB.reason, /overlap/);
});

test("clean text merge but post-merge tests fail → demote, main unchanged", async () => {
  const repo = newRepo();
  const orchDir = join(repo, ".orch");
  const base = makeBranch(repo, orchDir, "pr/claude/a-1", "a.txt", "A\n");
  const before = git(["rev-parse", "main"], repo);

  const deps = realDeps();
  deps.gate = { run: () => ({ pass: false }) }; // post-merge test fails
  const r = await finalize({ repo, orchDir, branch: "pr/claude/a-1", sid: "1", baseSha: base, paths: ["a.txt"], testCmd: "false", cfg: { merge: "no-ff" }, rounds: 1 }, deps);

  assert.equal(r.status, "pr-fallback");
  assert.match(r.reason, /post-merge-test-fail/);
  assert.equal(git(["rev-parse", "main"], repo), before); // main rolled back
});
```

- [ ] **Step 2: Run the tests**

Run: `node --test test/concurrent.test.js`
Expected: PASS.

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add test/concurrent.test.js
git commit -m "test: concurrent finalize scenarios (disjoint merge, overlap demote, post-merge fail)"
```

---

## Task 12: Docs — README + spec ceilings + handoff close-out

**Files:**
- Modify: `README.md` (concurrency section), `docs/superpowers/specs/2026-06-27-concurrent-orch-sessions-design.md` (mark implemented + add the cwd-on-main ceiling), `tasks/concurrent-orch-handoff.md` (close out)

- [ ] **Step 1: Document the feature + the precondition**

In `README.md`, add a "Concurrent cycles" section covering:
- run `orch task` N times (explicit roles) for parallel cycles in one repo;
- `concurrency:` config key (default 4); over-cap cycles exit;
- the **cwd must be on a working branch, not `main`** precondition and why (integration worktree owns main);
- PR-fallback vs local escalation, and that auto-merge is local (no push) except the fallback push.

- [ ] **Step 2: Mark the spec implemented and record the ceiling**

In the spec, change Status to `Implemented`. Under §7, add the cwd-on-main ceiling:
> The integration worktree owns `main`, so orch requires cwd be on a non-main branch. The cwd-on-main hybrid (merge directly in cwd under the merge-lock — safe because merge-lock serializes finalize) is a documented upgrade path, not built in v1.

- [ ] **Step 3: Close the handoff**

In `tasks/concurrent-orch-handoff.md`, append a "Status: implemented in <commit-range>" note pointing at this plan.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/superpowers/specs/2026-06-27-concurrent-orch-sessions-design.md tasks/concurrent-orch-handoff.md
git commit -m "docs: concurrent orch sessions — usage, precondition, ceilings"
```

---

## Self-Review

**Spec coverage**

| Spec section | Task(s) |
|---|---|
| §4.1 Two-phase locking (drop cycle lock, add merge.lock) | 2 (merge.lock), 10 (drop cycle lock) |
| §4.2 sid → branch isolation | 3, 10 |
| §4.3 PID-aware orphan reclaim (marker `pid\nsid`) | 4 |
| §4.4 Integration worktree + hybrid merge (sync → overlap → merge → re-test → land/fallback) | 5 (worktree+merge), 8 (finalize orchestration), 7 (fallback) |
| §4.5 File-overlap pre-check (`inflight/<sid>.json` + `base..main`) | 6 (registry), 8 (overlap logic), 9 (publish paths) |
| §4.6 Concurrency cap | 1 (config), 10 (register+count+exit) |
| §5 State files | 2,4,6,8 (each file's writer) |
| §6.1 merge-lock serialization | 8 (blocking acquire) |
| §6.2 author rotation race (explicit roles) | unchanged — `nextAuthor` already skips `last-author` when roles fixed; documented in Task 12 |
| §6.3 PID reuse (conservative keep) | 4 (live PID kept) |
| §6.4 integration worktree reset before merge | 5 (`syncWorktreeToMain`), 8 |
| §7 ceilings (cwd-on-main, non-Node, NFS) | 12 |
| §8 testing (unit + 4 integration scenarios + reclaim-with-live-peer) | 4,6,8 (unit), 11 (integration) |

**Decision recorded by this plan (spec left it implicit):** §4.4's "cwd HEAD never on main" is enforced as a hard preflight error (Task 10), because git forbids advancing `main` from a side worktree while `main` is checked out in cwd. The cwd-on-main hybrid is documented (Task 12), not built.

**PR-fallback no-remote gap:** resolved — Task 7 `demote` falls back to local escalation (keep branch + `DECISION.md`) when there is no remote / `gh`.

**Placeholder scan:** every code step shows complete code; test steps show real assertions. The CLI test bodies (Task 10 Step 1) reference the file's existing dry-run harness rather than reprinting it — the implementer must read `test/cli.test.js` first; this is intentional (those helpers already exist and vary), not a placeholder for new logic.

**Type/name consistency check:**
- `acquireBlocking(orchDir, lockName, opts)` — defined Task 2, used Task 8 via `lock.acquireBlocking`, wired Task 10. ✓
- `newSid()` — Task 3, used Task 10. ✓
- `createTaskBranch(repo, path, branch, base, markerContent)` — Task 4; engine passes `${pid}\n${sid}` — note: the engine does NOT call `createTaskBranch` directly with the marker in this plan; the marker is written by `git.createTaskBranch` and the engine calls it via `git.createTaskBranch(repo, worktree, branch, "main")`. **Consistency fix:** Task 9 must pass the marker. Add to Task 9 Step 3: change the engine's `git.createTaskBranch(repo, worktree, branch, "main")` call (engine.js line 22) to `git.createTaskBranch(repo, worktree, branch, "main", `${process.pid}\n${sid}`)`. ✓ (recorded here)
- `ensureIntegrationWorktree`/`syncWorktreeToMain`/`mergeInWorktree`/`changedSince` — Task 5, used Task 8/11. ✓
- `inflight.register/setPaths/deregister/listLive/countLive/peerPaths` — Task 6, used Tasks 8,9,10. ✓
- `demote(ctx, deps)` — Task 7; called as `github.demote(ctx)` from finalize (Task 8 corrected in Task 10 Step 3) with `demote` pre-bound to real shells in `realDeps`. ✓
- `finalize(ctx, deps)` returns `{ status: "merged"|"pr-fallback", reason, sha?, prUrl? }` — Task 8, consumed Task 9. ✓

**Added during review:** Task 9 must update the `createTaskBranch` call to pass the `pid\nsid` marker (folded into Task 9 Step 3 above — apply it there).

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-27-concurrent-orch-sessions.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session with checkpoints.

Which approach?
