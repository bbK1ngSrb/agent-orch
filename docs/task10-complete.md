# Task 10 — Complete

**Task:** `engine.js` — the cross-audit state machine.
**Status:** APPROVED (audit attempt 1, `docs/task10-audit1.md`).
**Commit:** `f9fae22 feat(agent-orch): cross-audit state machine engine`.

## Files created/changed

| File | Purpose |
| ---- | ------- |
| `src/engine.js` | `runCycle(opts, deps) -> Promise<{status, reason, rounds}>`. Pure DI state machine — every collaborator (`adapters`, `git`, `gate`, `scope`, `notify`) arrives via `deps`, so tests stub it and dry-run is just another stub set; no env checks inside. **task mode**: createTaskBranch → author writes → optional scope cap → audit/revise loop up to `cfg.reviseCap` → on AGREE gate tests, merge only if green, else escalate. **review mode** (F1): attachExistingBranch, no author/revise, audit once, AGREE+green→merge, DISAGREE→escalate `rounds:1`. Worktree pruned in `finally`. |
| `test/engine.test.js` | 8 stub-driven tests: AGREE+green→merged; AGREE+red→escalated; DISAGREE→escalated at cap (3 rounds); DISAGREE→AGREE→merged round 2; no test gate→escalated; scope cap→escalated; review never calls author; review escalates on first DISAGREE. |

## Tests added + results

TDD loop: wrote `test/engine.test.js` → FAILED (`Cannot find module '../src/engine.js'`) → wrote `engine.js` → 8 pass.

Full suite (`node --test`):
```
ℹ tests 38
ℹ pass 38
ℹ fail 0
```
(smoke + 4 verdict + 3 prompts + 2 scope + 5 gate + 4 config + 4 git + 5 adapters + 2 notify + 8 engine)

## Decisions / deviations

- None. Implementation and tests match the plan verbatim.
