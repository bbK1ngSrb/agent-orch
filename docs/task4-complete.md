# Task 4 — Complete

**Task:** `scope.js` — changed-line count vs main.
**Status:** APPROVED (audit attempt 1, `docs/task4-audit1.md`).
**Commit:** `de07e39 feat(agent-orch): scope line-count gate with glob ignore`.

## Files created/changed

| File | Purpose |
| ---- | ------- |
| `src/scope.js` | `parseNumstat(numstat, ignore) -> number` (pure): splits `git diff --numstat` output, sums `added + deleted` per line, skips binary rows (`-`/`-`), and skips files matching any ignore glob. `count(branch, cwd, ignore) -> number`: runs `git diff --numstat main...branch` in `cwd` and delegates to `parseNumstat`. Glob→regex helper anchors `^…$`, escapes regex metachars, and translates `**` (via a sentinel) to `.*` while `*` becomes `[^/]*`. |
| `test/scope.test.js` | 2 tests: sums added+deleted while skipping binary; honors ignore globs (`*.lock`, `dist/**`). |

## Tests added + results

TDD loop: wrote `test/scope.test.js` → FAILED (`Cannot find module '../src/scope.js'`) → wrote `scope.js` → 2 pass.

Full suite (`node --test`):
```
ℹ tests 10
ℹ pass 10
ℹ fail 0
```
(smoke + 4 verdict + 3 prompts + 2 scope)

## Decisions / deviations

- None. Implementation and tests match the plan verbatim.
