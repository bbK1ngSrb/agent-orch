# Lessons

## orch in a shared clone: concurrent sessions collide on the working tree

**Date:** 2026-06-27

**What happened:** Two Claude sessions drove `orch` in the *same* clone at once.
While one session worked on `pr/claude/orch-stale-lock-reclaim`, the other ran
cycles that checked out `main` and merged 12 commits — silently reverting the
first session's working tree (`git.js` snapped back to main's version mid-edit)
and leaving HEAD on `main`. During an `orch review` the feature branch was also
deleted mid-cycle (recovered from `git reflog` / `git fsck --no-reflogs`).

**Why:** orch's `.orch/lock` serializes *cycles within one process tree*, not
two independent sessions. Both sessions share one working tree and one HEAD, so
any `git checkout` / merge in session B clobbers session A's in-progress edits.
A per-directory lock can't see another agent's session.

**How to apply:**
- One clone = one orch driver at a time. If a second session must run, give it
  its own `git worktree` (or a separate clone), never the same working tree.
- Before running `orch`, check for a live peer: `ps aux | grep cli.js`, inspect
  `git log --oneline` vs your expected HEAD, and confirm `git branch --show-current`.
  If HEAD or main moved unexpectedly, a peer session is active — stop, don't fight.
- Feature work that must survive a peer's `main` checkouts belongs in an isolated
  worktree, not the shared tree.
- If a branch vanishes mid-cycle, recover the commit before doing anything else:
  `git fsck --no-reflogs | grep commit` and `git reflog`, then
  `git branch <name> <sha>`. Reflog/fsck retain dangling commits.
- Don't re-run `orch review` in the shared clone just to re-bless a change orch
  already audited — the re-run is itself the hazard (it was what deleted the
  branch). Rebase onto current main, run the test gate, merge directly.
