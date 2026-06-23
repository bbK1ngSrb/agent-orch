# Task 11 — Complete

**Task:** `cli.js` + `lock.js` — init / task / review, dry-run, lock & pause.
**Status:** APPROVED (audit attempt 1, `docs/task11-audit1.md`).
**Commit:** `4844552 feat(agent-orch): cli with init/task/review + preflight`.

## Files created/changed

| File | Purpose |
| ---- | ------- |
| `src/lock.js` | F3 — `acquireLock(orchDir)` atomic `O_EXCL` (`wx`) create of `.orch/lock` (false if held); `releaseLock`; `isPaused` (`.orch/pause` exists). |
| `src/slug.js` | `slugify(text)` → lowercase, non-alnum→`-`, trim dashes, ≤40 chars, fallback `task`. |
| `src/cli.js` | `main(argv)` dispatches `init` / `task` / `review` / `version`. `parse` (parseArgs, `--dry`/`--version`). `nextAuthor` alternates agents via `.orch/last-author`. `preflight` checks agent CLIs on PATH (skipped under dry). `realDeps`/`dryDeps` — F2 dry-run touches no real git/agent/test. task→author+revise loop; review→`mode:"review"` audit-only. Lock acquired around the cycle, released in `finally`; pause aborts; escalation sets `exitCode=2`. |
| `test/lock.test.js` | 2 tests: lock exclusivity until release; pause-file detection. |
| `test/cli.test.js` | 4 tests: slugify; `--dry` task completes with no agent on PATH (F2); parse; nextAuthor alternation + persistence. |

## Tests added + results

TDD: lock test → lock impl → 2 pass. cli test → FAIL (no cli.js) → slug.js + cli.js → 4 pass.

Full suite + binary smoke (`node --test && node bin/orch.js --version`):
```
ℹ tests 44
ℹ pass 44
ℹ fail 0
```
`node bin/orch.js --version` → `0.1.0` (entrypoint now wires through `cli.js`, the import stub that has failed since Task 1 is resolved).
(smoke + 4 verdict + 3 prompts + 2 scope + 5 gate + 4 config + 4 git + 5 adapters + 2 notify + 8 engine + 2 lock + 4 cli)

## Decisions / deviations

- **Committed `src/lock.js` + `test/lock.test.js` with the cli commit.** The plan's Step 6 `git add` lists only `src/cli.js src/slug.js test/cli.test.js` and omits the lock files (created in Steps 1a/1b), but they are named Task 11 deliverables and the suite needs them. Included; auditor confirmed the file set is correct.
