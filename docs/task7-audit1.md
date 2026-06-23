Task 7 audit, attempt 1.

Plan section reviewed: `### Task 7: git.js - worktree + branch + merge helpers`.

Files inspected for Task 7:
- `src/git.js`
- `test/git.test.js`

Result:
- `src/git.js` provides the planned exports: `git`, `branchExists`, `createTaskBranch`, `attachExistingBranch`, `pruneWorktree`, and `mergeIntoMain`.
- `createTaskBranch` refuses pre-existing branches before creating a worktree branch from the requested base.
- `attachExistingBranch` refuses missing branches and does not silently create review branches.
- `pruneWorktree` removes the worktree with force and prunes stale metadata.
- `mergeIntoMain` checks out `main` when needed, selects `--ff-only` by default and `--no-ff` for no-ff mode, and returns `{ ok, reason }` instead of throwing on merge/check-out failure paths covered by the plan.
- `test/git.test.js` uses real temporary Git repositories and real commits/worktrees. The tests are not mocked or faked, and they cover the four scenarios listed in the plan.
- The Task 7 implementation commit adds only `src/git.js` and `test/git.test.js`. I saw a later `.github/workflows/node.js.yml` commit, but it is outside the Task 7 source/test files under audit.

Verification:
- Ran `node --test` from the repo root.
- Result: 23 passing, 0 failing.
- Task 7's four Git tests passed, and earlier task tests also remained green.

VERDICT: APPROVED
