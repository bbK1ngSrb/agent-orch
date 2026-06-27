# Issue #27 — resume after SIGKILL (committed author branch), not just quota-abort

## Root cause (proven by reading code)

Two compounding bugs:

1. **reclaim deletes the committed branch.** `reclaimOrphanWorktrees` (git.js:110-111)
   removes the orphan worktree **and `git branch -D`** when the marker is orch-owned +
   pid dead. SIGKILL leaves exactly that orphan (engine's `finally`/`pruneWorktree`
   never runs). The next `orch task` reclaim (cli.js:337) nukes the `pr/claude/...`
   branch *before* `resolveTaskBranch` (cli.js:347) can reattach. Quota-abort survives
   only because the engine `finally` (engine.js:119) prunes the worktree but keeps the
   branch, so no orphan remains for reclaim to delete.

2. **Resume key + author rotation miss.** Resume record is keyed `(task, author)`
   (resume.js:11). The rotation pool advances the author across runs
   (claude→codex, cli.js:173-179), so the re-run looks up `(task, codex)` and misses
   the `(task, claude)` record even if the branch survived.

Both must be fixed; fixing only #2 still loses the branch to #1.

## Plan (advisor-revised: plan B for bug #1 — no keepBranches plumbing)

- [ ] **Bug #1 (git.js):** in `reclaimOrphanWorktrees` `flush()`, only `git branch -D`
      a swept owned orphan when it has NO commits beyond main
      (`changedFiles(repo, branch).length === 0`). Always remove the worktree. This
      preserves committed author work (killed-after-commit) while still sweeping
      killed-before-commit branches. Existing orphan tests create no-commit branches,
      so they stay green. Tradeoff: committed-but-abandoned branches linger (no
      worktree) — safer than silently deleting committed work.
- [ ] **Bug #2 (resume.js):** store `author` + `taskHash = sha1(task)` inside the record;
      add `lookupForTask(orchDir, task)` -> array of records `{author, branch, sid, ...}`
      across all authors (scan dir, match taskHash). Keep per-author `lookup/record/clear`.
- [ ] **Bug #2 (cli.js):** `nextAuthor(cfg, orchDir, pinnedAuthor=null)` — rotation pool
      honours a pinned author (no `last-author` advance). In task mode, before
      `nextAuthor`, compute `pinned` = author of any `lookupForTask` record whose branch
      exists, has commits, and isn't live. Fixed roles ignore the pin (already resume
      per-author). Then existing `resolveTaskBranch` per-author lookup hits.
- [ ] **Tests**: resume.test (lookupForTask across authors); git.test (committed orphan
      preserved, no-commit orphan still swept); cli.test (pinned author from a surviving
      committed branch resolves to resume=true on the recorded branch).
- [ ] `npm test` green. Issue #27 already exists; PR closes it.

## Review

Shipped both fixes; 238/238 tests pass.

- **git.js** `reclaimOrphanWorktrees`: `branch -D` now gated on
  `changedFiles(repo, branch).length === 0` — committed orphan branches survive the
  sweep (worktree still reclaimed). New test: committed dead-pid orphan preserved.
- **resume.js**: record now stores `author` + `taskHash`; new `lookupForTask` scans
  records for a task across authors. New tests cover cross-author lookup + empty cases.
- **cli.js** `nextAuthor(cfg, orchDir, pinnedAuthor)`: rotation pool honours a pin
  without advancing `last-author`. Task mode computes the pin from a surviving
  committed branch before author selection, so the resuming run reattaches under the
  original author and `resolveTaskBranch` resumes instead of authoring fresh. New
  tests cover pin-without-rotate and unknown-pin fallback.

Net: a SIGKILL between author-commit and review now resumes the committed branch on
the next `orch task`, independent of how the run died or which agent the pool rotated
to. Verified by reasoning through the path + unit coverage of each piece. No behaviour
change for the quota-abort path (#24) or for killed-before-commit orphans.
