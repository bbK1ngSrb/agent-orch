# Concurrent orch sessions on one repo — design

**Date:** 2026-06-27
**Status:** Design approved, pending spec review
**Scope:** Allow multiple `orch task` cycles to run in parallel against the *same* repo directory, safely. This is the headline benefit of long-run headless orchestration: fire N tasks, run them concurrently, harvest results.

---

## 1. Problem

Today the whole orch cycle (author → cross-audit → test-gate → merge) is serialized per repo dir by a single `.orch/lock`. A second `orch task` in the same dir exits immediately. Multi-*repo* concurrency already works (each dir has its own `.orch/`, no shared state) — the constraint is entirely *within* one repo dir.

Collision points that block concurrency (from the architecture map):

| # | Location | Nature | Severity |
|---|----------|--------|----------|
| 1 | `.orch/lock` | whole cycle serialized | by design — the barrier we remove |
| 2 | `.orch/last-author` RMW | TOCTOU before lock | medium (mis-rotation, not corruption) |
| 3 | `branch = pr/<author>/<slug>` | deterministic, non-unique | high (2nd run dies at `createTaskBranch`) |
| 4 | `reclaimOrphanWorktrees` | assumes no live owner | **critical** (deletes a live peer's worktree) |
| 5 | `mergeIntoMain` does `git checkout main` on cwd | assumes exclusive primary checkout | **critical** (git error / corruption) |
| 6 | `runs.jsonl` append | interleave | low |

## 2. Goals / non-goals

**Goals**
- N parallel `orch task` cycles in one repo dir, no corruption, no lost work.
- Support two workloads: (1) many distinct tasks on one repo; (2) one task, many authors/attempts.
- Never disturb the user's primary working-dir HEAD.
- Hybrid integration: auto-merge clean work; demote conflicting/risky work to a PR for human review rather than pushing broken main.
- A concurrency cap so disk + merge contention stay bounded.

**Non-goals (deferred)**
- Supervisor daemon / queue / dashboard (future; the file-coordinated model is designed so a supervisor can sit on top later).
- `orch batch <tasks-file>` launcher (v2).
- Bare-repo + all-worktrees restructure (future option #3).
- Cross-process round-robin author rotation (concurrent launches use explicit roles; see §6.2).

## 3. Coordination model

Keep **independent processes coordinating via files**. No daemon. Drop the whole-cycle lock. The only global barrier becomes a short **merge-lock** held across the finalize step.

This is the smallest diff that achieves raw concurrency-safety, and it composes: a future supervisor can spawn these same processes.

### Empirical foundation (validated 2026-06-27)
- Repo is on an **nfs4** mount (`192.168.10.51:/stepa.local`).
- `O_EXCL` exclusive create (`writeFileSync(..., {flag:"wx"})`, the `lock.js` primitive) was tested under real contention: 25 rounds × 40 racing processes, **exactly 1 winner every round, 0 anomalies**. O_EXCL is atomic on this mount; the existing lock primitive is sound.
- **Validation gate:** if the repo ever moves to a different NFS server/version, re-run the contention test before trusting the merge-lock. (rename-over atomicity is *not* relied upon — see §6.2.)

## 4. The changes

### 4.1 Two-phase locking
- Remove the whole-cycle `acquireLock`/`releaseLock` wrapping `runCycle` in `cli.js`.
- Introduce `.orch/merge.lock` using the existing `lock.js` PID/stale-aware logic (rename the module's target or parameterize the lock path).
- Acquire merge-lock **only** around the finalize step (§4.4). Release immediately after push/PR-fallback. Authoring + audit + per-cycle test run fully parallel and unlocked.

### 4.2 Session id → isolation
- Each cycle generates a `sid` at start (short, collision-resistant; e.g. `${pid}-${base36 monotonic}` — no `Math.random`/`Date.now` constraints here since this is runtime, not a workflow script, but a pid+counter is enough and readable).
- Branch becomes `pr/<author>/<slug>-<sid>`. Fixes collision #3; enables workload #2 (many authors/attempts, same task text).
- Worktree path already derives from branch (`.orch/wt/<branch_slug>`) → unique automatically.

### 4.3 PID-aware orphan reclaim *(critical fix for #4)*
- The ownership marker `<worktreePath>.orch-task` currently is empty. Change it to contain `<pid>\n<sid>`.
- `reclaimOrphanWorktrees` sweeps a marked worktree **only if** its owner PID is dead (`process.kill(pid, 0)` throws `ESRCH`). Live peers are left untouched. `sid` in the marker disambiguates PID reuse.
- This replaces the current "safe because we hold the single-cycle lock" assumption with per-worktree liveness, mirroring the existing stale-lock logic in `lock.js`.

### 4.4 Dedicated integration worktree + hybrid merge *(fixes #5)*
- Reserve `.orch/integration`, a worktree checked out on `main`, created once and reused. Placed under `.orch/` so Node module resolution finds `<repo>/node_modules` (no install step needed for Node projects; see ceiling in §7).
- The primary cwd HEAD is **never** checked out to main. `mergeIntoMain` is rewritten to operate in `.orch/integration`, not `repo` (cwd).
- Finalize step, under merge-lock:
  1. Sync the integration worktree to the current local `main` tip (hard reset/ff). This picks up any merge a peer just landed.
  2. **File-overlap pre-check (§4.5).** If the branch overlaps another in-flight or merged-since-branchpoint changeset → skip to PR-fallback.
  3. `git merge --no-ff <branch>`. Conflict → abort → PR-fallback.
  4. **Re-run the test-gate against integrated main** (`gate.run(testCmd, integrationWorktree)`). Fail → reset integration worktree, PR-fallback.
  5. Clean + green → commit the merge into local `main`. Record `merged`. (Parity with today's `mergeIntoMain`, which is a *local* merge — no push. If a future flow pushes, it does so unchanged here.)
- **PR-fallback:** reuse `runCycle({noMerge:true})` + `github.js` to push the branch and open a PR; record `verdict: "pr-fallback"` with reason (`overlap` | `conflict` | `post-merge-test-fail`) in `runs.jsonl`.

### 4.5 File-overlap pre-check *(cheap complement, catches uncovered semantic conflicts)*
- Each cycle, once authoring is done, writes its changed-path list to `.orch/inflight/<sid>.json` (`{ branch, base_sha, paths: [...], pid }`).
- At finalize (under merge-lock, so the read is consistent), the merging cycle compares its `paths` against:
  - other live `.orch/inflight/*` entries (peer still in flight), and
  - any changeset merged into main *after* this branch's `base_sha` (read from `runs.jsonl` / `git diff base_sha..main --name-only`).
- Any path overlap → PR-fallback (reason `overlap`). Disjoint → proceed to merge.
- Cleanup: remove `.orch/inflight/<sid>.json` on cycle exit (and in PID-aware reclaim for dead owners).

### 4.6 Concurrency cap
- Config key `concurrency: <n>` (in `orch.yml`, default e.g. 4).
- On start, a cycle counts live cycles via `.orch/inflight/*` whose PID is alive (plus its own pre-registration). If `>= n`, the cycle **exits** with a clear message (`concurrency cap N reached — N cycles live`) rather than blocking. (Manual launch model; a future supervisor would queue instead.)
- Registration must be atomic enough: register an `.orch/inflight/<sid>.json` placeholder *before* the count check, then re-count; if over cap, deregister and exit. Cap is a guardrail, not a hard semaphore — small races that admit one extra cycle are acceptable (it only affects disk/merge-lock pressure, never correctness).

## 5. State files (under `.orch/`)

| File | Writer | Format | Concurrency |
|------|--------|--------|-------------|
| `merge.lock` | finalize step | pid | O_EXCL, PID/stale-aware |
| `wt/<branch>/` + `<...>.orch-task` | each cycle | marker holds `pid\nsid` | unique per branch |
| `inflight/<sid>.json` | each cycle | `{branch, base_sha, paths, pid, ts}` | one file per cycle, no shared write |
| `runs.jsonl` | finalize | append one JSON line | O_APPEND, short lines atomic (ceiling: noted) |
| `last-author` | rotation only | author name | skipped when roles fixed (§6.2) |
| `reviews/<branch>/` | per cycle | round files | unique per branch |

## 6. Edge cases & decisions

### 6.1 Merge-lock starvation
One shared integration worktree ⇒ post-merge tests run serially under the lock. Accepted for v1: authoring + audit dominate wall-clock (minutes per cycle), the suite is short. The concurrency cap bounds the worst case. **Upgrade path (documented, not built):** per-cycle rebase+test in the author's own worktree (outside the lock), take merge-lock only to fast-forward `main` if its SHA is unchanged; re-merge+retest if main moved.

### 6.2 Author rotation race (#2)
Concurrent launches **must** use explicit roles (fixed `author`+`reviewer` in config, or `--author`/`--reviewer` flags). When both are fixed, `nextAuthor` skips `last-author` entirely — no race. Round-robin rotation remains a single-session convenience. If concurrent rotation is ever needed, guard the read-modify-write under a dedicated rotate-lock (do **not** rely on temp+rename — that is last-writer-wins, not atomic increment).

### 6.3 PID reuse
`process.kill(pid,0)` can match a recycled PID. `sid` in the marker and inflight file lets a cautious reclaim cross-check; v1 treats PID-alive as "keep" (conservative — never deletes a possibly-live worktree).

### 6.4 Integration worktree corruption / leftover merge
If a finalize crashes mid-merge, the next finalize (holding the lock) resets `.orch/integration` hard to `main` before starting. Reclaim also validates the integration worktree is clean.

## 7. Residuals / ceilings (stated, not hidden)

- **Uncovered semantic conflicts** are irreducible for parallel auto-merge: two disjoint edits that each pass their own gate, merge cleanly, and break main together *only via an interaction no test covers* and *with no path overlap*. Layered defense (overlap → re-test) shrinks this to the floor; it does not eliminate it. The floor demotes nothing — it's the residual risk the user accepts by enabling auto-merge.
- **Non-Node toolchains:** the "worktree inherits deps via upward resolution" property is Node-specific. Python venvs / per-dir build artifacts may need a setup step in the integration worktree. v1 documents this; projects with such toolchains set a `pretest`/setup hook or run overlap-only.
- **NFS portability:** O_EXCL atomicity validated on *this* mount only.

## 8. Testing strategy

- Unit: PID-aware reclaim (alive PID kept, dead PID swept); merge-lock acquire/stale; sid uniqueness; overlap detection (overlapping → fallback, disjoint → merge); cap enforcement.
- Integration (the load-bearing ones):
  - Two concurrent cycles, disjoint files → both auto-merge, main has both.
  - Two concurrent cycles, overlapping files → one merges, other PR-fallbacks (reason `overlap`).
  - Two cycles, clean text merge but post-merge test fails → PR-fallback (reason `post-merge-test-fail`), main not pushed.
  - Reclaim with a live peer present → peer's worktree survives.
- Re-run the O_EXCL contention probe as a documented validation gate (not CI — it's mount-specific).

## 9. Future (explicitly deferred)
- Supervisor daemon: queue, worker pool, retries, observability/dashboard. The file-coordinated processes here are its workers.
- `orch batch <tasks-file>`.
- Bare-repo + all-worktrees model (option #3).
- Per-cycle merge worktrees for true parallel integration (§6.1 upgrade path).
