# Task 10 Report: Wire the CLI — sid, drop whole-cycle lock, cap, integration preflight, real/dry deps

## Status: COMPLETE

All 208 tests pass (was 205 before this task; added 3 new tests).

## Changes

### `src/cli.js`

- **Imports added**: `acquireBlocking` (from `./lock.js`), `newSid` (from `./sid.js`), `* as inflight` (from `./inflight.js`), `finalize` (from `./finalize.js`); `demote` added to existing `runPr` import from `./github.js`.
- **`realDeps()`**: Now injects `inflight` and a bound `finalizeDep` that wires real `git`, `gate`, `lock`, `inflight`, `github`, and `notify` collaborators into `finalize`. `githubDep.demote` pre-binds real `gh`/`git`/`notify` shells so `finalize.js` calls it as `github.demote(ctx)` (single arg).
- **`dryDeps()`**: Two small fixes — `git()` returns `"(dry-run)"` (not `"(dry-run diff)"`); `finalize` stub returns `{ status: "merged", reason: "dry-run", sha: "dry" }`.
- **Task mode `runs`**: Each run now generates a `sid = newSid()` and incorporates it in the branch: `pr/${authorName}/${slugify(task)}-${sid}`.
- **Review mode `runs`**: Added `const sid = newSid()` and included `sid` in the single run object.
- **Task/review run loop**: Dropped `acquireLock`/`releaseLock` from the task/review path entirely. Replaced with:
  1. Integration preflight: checks `git rev-parse --abbrev-ref HEAD`; throws clear error if HEAD is `main`.
  2. `git.reclaimOrphanWorktrees(repo, orchDir)` before the loop.
  3. Per-cycle `inflight.register` + `countLive` cap check (over cap → deregister + log + exit 2 + continue).
  4. `try/finally` per cycle: `inflight.deregister` on exit regardless of success or error.
  5. `pr-fallback` status now also sets `process.exitCode = 2` (was only `escalated`).

### `test/cli.test.js`

- **Imports added**: `mkdirSync` (to fs import), `execFileSync` (from `node:child_process`), `* as inflight` (from `../src/inflight.js`).
- **`runMainCapture` helper**: Creates a tmp dir, chdirs into it, captures `console.log` output, runs `main`, restores. Used by the sid-suffix test.
- **3 new tests**:
  1. `"task branch includes a sid suffix"` — dry-run, asserts branch matches `/pr\/[a-z]+\/do-a-thing-\d+-[0-9a-z]+:/`.
  2. `"over the concurrency cap, a cycle is skipped (not blocked)"` — real git repo (main + work branch), pre-seeds 4 inflight entries (pid=process.pid), asserts exit 2 and cap log message.
  3. `"orch task errors clearly when cwd HEAD is main"` — real git repo on main, asserts `rejects` with message matching `/switch.*working branch|integration worktree|main/`.

### `src/finalize.js`

No changes. Line 50 already uses `github.demote(ctx)` (single arg) from Task 8 — the brief's note about adjusting the call was already resolved in a prior task.

## Finalize.js note

The task brief mentions adjusting `finalize.js`'s `demote` call to `github.demote(ctx)` (drop second arg). This was already done in Task 8 (`finalize.js` line 50: `const r = await github.demote(ctx);`). No change needed, no diff produced for that file.

## Smoke test output

```
orch (dry): pr/claude/concurrent-smoke-test-<pid>-0: merged (dry-run) after 1 round(s)
```

Sid appended, no `.orch/lock` created.

## Self-review checklist

- [x] sid in both task and review run builders
- [x] No whole-cycle lock on task/review path
- [x] Per-cycle inflight register/cap/deregister
- [x] Integration preflight (HEAD == main → throw)
- [x] `realDeps()` injects `finalize` + `inflight`
- [x] `dryDeps()` returns `"dry-run"` reason (not `"merged (dry-run)"`)
- [x] `pr-fallback` sets exit 2
- [x] 3 new tests added and passing
- [x] 208/208 full suite green
- [x] Manual smoke passes
