# Issue #24 — `orch task` resume on quota-abort (instead of re-author from scratch)

## Problem
`orch task` mints a fresh `sid`/branch each run (`cli.js:307`). On a Claude usage-limit
abort mid-cycle, the author's committed work survives on an orphan branch but the next
`orch-loop.sh` retry starts a brand-new branch → re-authors from scratch. Wasted tokens.
Severity low–med; end-state already correct. `orch pr` path unaffected.

## Approach (advisor-confirmed)
A per-task **resume record** under `.orch/resume/<hash>.json`, keyed on
`sha1(authorName \0 full-task-text)` (full text, not slug — slug collisions would
resume the wrong branch). Keep `sid` in branch names (dropping it re-introduces the
`spawnDocsTask` fixed-prompt collision, cli.js:22).

**Lifecycle = the correctness pivot:** write record *before* `runCycle`, delete it
*after `runCycle` returns* (any status), NOT in a `finally`.
- normal return (merged/escalated/demoted) → terminal → clear record.
- throw (quota) → clear skipped → record survives → next run resumes.
Return-vs-throw is the interrupted-vs-done discriminator (no status enumeration).
Can't reuse the inflight registry — it deregisters in `finally` (cli.js:365), gone on abort.

**Resume guards (keep it an efficiency gap, never a correctness bug):**
1. branch must exist AND have commits ahead of main (`changedFiles().length > 0`).
   Quota can hit mid-author *before* any commit → empty branch → re-author fresh.
2. branch must NOT be in the live-inflight set (don't hijack a concurrent cycle).
Audit + test-gate still run on resumed work, so even a mis-resume can't merge garbage.

**Ordering:** move the `!dry` HEAD-check + `liveBranches` + `reclaimOrphanWorktrees`
block ABOVE `runs` construction, so resume resolution sees post-reclaim truth. Dominant
quota case (soft `claude` non-zero exit → engine `finally` prunes worktree, bare branch
ref survives) → reclaim ignores it (no worktree) → resume works. Hard-kill case
(worktree+marker survive) → reclaim deletes branch first → resume degrades to fresh
restart == today's behavior (no regression, no crash).

## Steps
- [ ] **TDD** `test/resume.test.js`: record→lookup roundtrip; lookup null when absent;
      different task text / author → different file; clear removes it.
- [ ] **src/resume.js**: `record/lookup/clear` (mirror inflight.js shape).
- [ ] **TDD** `test/engine.test.js`: `resume:true` → `attachExistingBranch` called,
      `createTaskBranch` NOT called, `author.author` NOT called on round 1, proceeds to audit.
- [ ] **src/engine.js**: `resume` opt → attach instead of create + skip initial author;
      scope gate still runs on resumed work; revise loop unchanged.
- [ ] **TDD** `test/cli.test.js`: export + test `resolveTaskBranch` — fresh when no
      record; resume when record+branch+commits; skip-resume when live; clear-stale when
      no commits; dry → always fresh, never touches git/store.
- [ ] **src/cli.js**: extract `resolveTaskBranch(ctx, {git,resume})`; wire into task-mode
      `runs.map`; move `!dry` block above runs; clear record after successful `runCycle`.
- [ ] `npm test` green (full suite).
- [ ] Update README/docs note: `task` retries now resume; document hard-kill degrade.
- [ ] Commit on a branch, PR, `Closes #24`.

## Out of scope (YAGNI)
- No branch-naming change, no inflight refactor.
- Lingering resume record for a detached docs task that aborts (never retried) = tiny
  permanent json; negligible, note with a `ponytail:` comment.

## Review
- `src/resume.js` (new): record/lookup/clear keyed on sha1(author\0task). 4 unit tests.
- `src/engine.js`: `resume` opt → attachExistingBranch + skip initial author; scope gate
  still runs on resumed work. 2 engine tests.
- `src/cli.js`: `resolveTaskBranch()` (exported, dep-injected) — fresh/resume/stale-clear/
  live-skip/dry branches; moved reclaim above runs; clear record after runCycle returns.
  7 cli tests.
- `harness/orch-loop.sh` + `README.md`: documented resume + clean-restart fallbacks.
- Full suite 221 → 233 (+12), all green. Real-git smoke confirmed resume:true on a branch
  with commits, stale-clear→fresh, and fresh self-record.
- DONE.
