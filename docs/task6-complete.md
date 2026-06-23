# Task 6 — Complete

**Task:** `config.js` — load orch.yml + defaults + validate.
**Status:** APPROVED (audit attempt 1, `docs/task6-audit1.md`).
**Commit:** `9ca7587 feat(agent-orch): config loader with defaults + validation`.

## Files created/changed

| File | Purpose |
| ---- | ------- |
| `src/config.js` | `load(dir) -> cfg`: reads optional `orch.yml`, shallow-merges over `DEFAULTS`, deep-merges `scope` (so overriding `scope.maxLines` keeps default `scope.ignore`), then `validate()`. Throws on empty/non-array `agents`, `merge` not in {ff-only,no-ff}, non-positive-int `reviseCap`, negative/non-int `scope.maxLines`. Defaults: agents `[claude,codex]`, test `auto`, reviseCap `3`, merge `ff-only`, scope `{maxLines:0, ignore:[*.lock, dist/**, *.snap]}`. Also exports `DEFAULTS`. |
| `test/config.test.js` | 4 tests: empty dir → defaults; orch.yml override + scope deep-merge; invalid merge throws; empty agents throws. |

## Tests added + results

TDD loop: wrote `test/config.test.js` → FAILED (`Cannot find module '../src/config.js'`) → wrote `config.js` (uses the `yaml` dep) → 4 pass.

Full suite (`node --test`):
```
ℹ tests 19
ℹ pass 19
ℹ fail 0
```
(smoke + 4 verdict + 3 prompts + 2 scope + 5 gate + 4 config)

## Decisions / deviations

- None. Implementation and tests match the plan verbatim. First task to exercise the single runtime dep `yaml`.
