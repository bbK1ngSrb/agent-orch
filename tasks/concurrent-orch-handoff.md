# Handoff — concurrent orch sessions (resume after /clear)

**Read this first, then go straight to the implementation plan. Brainstorming is DONE — do not re-open the design.**

## State
- Branch: `feat/concurrent-orch-sessions` (off `main`).
- Spec committed: `docs/superpowers/specs/2026-06-27-concurrent-orch-sessions-design.md` (commit `58bca7e`).
- Design approved by user. Advisor consulted (4 hardening points folded in). NFS O_EXCL atomicity empirically validated.

## Next action
Invoke **`superpowers:writing-plans`** on the spec above to produce the implementation plan. No new design decisions are open.

## What we're building (plain version)
Let many `orch task` cycles run at the same time in one repo, instead of one-at-a-time. Each cycle works in its own branch + worktree. Only the final "merge into main" step takes a short lock, one cycle at a time. Before a cycle's work lands in main it must pass two safety checks; if it fails either, that work becomes a PR for a human instead of breaking main.

## Decisions locked (do not re-litigate)
1. **No whole-cycle lock.** Replace with a short `.orch/merge.lock` held only during finalize. (`lock.js`, `cli.js`)
2. **Session id (sid) per cycle.** Branch = `pr/<author>/<slug>-<sid>`. Unique worktree follows. (`cli.js`, `slug.js`)
3. **PID-aware orphan reclaim.** `.orch-task` marker holds `pid\nsid`; reclaim deletes a worktree only if its owner PID is dead. (`git.js`)
4. **Dedicated `.orch/integration` worktree** for all merges. Primary cwd HEAD never touched. Merge is local (parity with today — no push added). (`git.js`, `engine.js`)
5. **Hybrid integration:** clean+safe → auto-merge; conflict / overlap / post-merge-test-fail → PR-fallback via `runCycle({noMerge})` + `github.js`. (`engine.js`)
6. **Two conflict guards:** (a) file-overlap pre-check from `.orch/inflight/<sid>.json`; (b) re-run test-gate against integrated main before landing. (`engine.js`)
7. **Concurrency cap** `concurrency:` in `orch.yml` (default 4). Over cap → cycle exits, doesn't block. (`cli.js`, `config.js`)
8. **Author rotation:** concurrent launches use explicit roles; round-robin stays single-session only (avoids the `last-author` race). (`cli.js`)

## Accepted v1 tradeoffs (in spec §6–7, don't "fix" without asking)
- Serial test-tail: one integration worktree ⇒ post-merge tests serialize under the lock. Upgrade path = per-cycle merge worktrees (documented, not built).
- Uncovered semantic conflicts are an irreducible floor for auto-merge.
- Non-Node toolchains (python venv etc.) may need a setup step in the integration worktree.
- O_EXCL validated on this nfs4 mount only.

## Launch model (v1)
Manual: user runs `orch task` N times with explicit roles. No daemon, no batch launcher (both deferred to v2 / future supervisor).
