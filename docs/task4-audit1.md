# Task 4 Audit 1

Audited Task 4 only, against `docs/plan.md` section "Task 4: `scope.js` -- changed-line count vs main".

Checked committed Task 4 files:
- `src/scope.js`
- `test/scope.test.js`

Findings:
- `src/scope.js` implements the planned `parseNumstat(numstat, ignore = []) -> number` and `count(branch, cwd, ignore = []) -> number` exports.
- `parseNumstat` sums added and deleted counts, skips binary numstat rows where either side is `-`, and applies ignore globs before adding to the total.
- The glob implementation preserves the `**` sentinel before translating `*`, matching the plan's intent for patterns such as `dist/**`.
- `count()` runs `git diff --numstat main...${branch}` in the provided `cwd`, decodes UTF-8 output, and delegates counting to `parseNumstat`.
- `test/scope.test.js` contains real assertions for line summing, binary skipping, and ignore globs including `*.lock` and `dist/**`.
- No Task 4 scope creep was found; the implementation commit added only the planned source and test files.

Test run:
- Command: `node --test`
- Result: PASS, 10/10 tests passed, including Task 4's 2 tests and all earlier task tests.

VERDICT: APPROVED
