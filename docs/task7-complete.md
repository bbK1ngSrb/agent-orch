# Task 7 — Complete

**Task:** `git.js` — worktree + branch + merge helpers.
**Status:** APPROVED (audit attempt 1, `docs/task7-audit1.md`).
**Commit:** `3dcd8fe feat(agent-orch): git worktree + merge helpers`.

## Files created/changed

| File | Purpose |
| ---- | ------- |
| `src/git.js` | Exports: `git(args, cwd)` (run git, return trimmed stdout); `branchExists(repo, branch)`; `createTaskBranch(repo, path, branch, base)` — **task mode**, throws if branch already exists, else `worktree add -b`; `attachExistingBranch(repo, path, branch)` — **review mode** (F5), throws if branch missing, never creates; `pruneWorktree(repo, path)` (force-remove + prune); `mergeIntoMain(repo, branch, mode)` — checks out main, merges `--ff-only`/`--no-ff`, returns `{ ok, reason }` instead of throwing. Internal `gitTry` swallows failures and captures stderr/stdout. |
| `test/git.test.js` | 4 tests over real temp git repos: createTaskBranch lifecycle + ff-only merge; createTaskBranch refuses existing branch; attachExistingBranch refuses missing branch (F5); ff-only merge returns `ok:false` when main moved. |

## Tests added + results

TDD loop: wrote `test/git.test.js` → FAILED (`Cannot find module '../src/git.js'`) → wrote `git.js` → 4 pass.

Full suite (`node --test`):
```
ℹ tests 23
ℹ pass 23
ℹ fail 0
```
(smoke + 4 verdict + 3 prompts + 2 scope + 5 gate + 4 config + 4 git)

## Decisions / deviations

- None to the task implementation. Implementation and tests match the plan verbatim.
- Note: an unrelated `.github/workflows/node.js.yml` (Node CI) commit landed on `main` from outside this build loop; auditor confirmed it is outside Task 7 scope.
