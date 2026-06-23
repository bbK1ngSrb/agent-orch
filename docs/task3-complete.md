# Task 3 — Complete

**Task:** `prompts.js` + prompt templates.
**Status:** APPROVED (audit attempt 1, `docs/task3-audit1.md`).
**Commit:** `db88327 feat(agent-orch): prompt templates + renderer`.

## Files created/changed

| File | Purpose |
| ---- | ------- |
| `src/prompts.js` | `renderTemplate(tpl, vars)` — pure `{{key}}` substitution, leaves unknown placeholders intact, stringifies values. `render(name, vars)` — reads `src/prompts/<name>.md` (resolved relative to the module via `import.meta.url`) and runs it through `renderTemplate`. |
| `src/prompts/author.md` | Author-agent prompt. `{{task}}` placeholder; rules enforce smallest change, tests, commit-in-worktree, never touch `main`, no push. |
| `src/prompts/review.md` | Adversarial-reviewer prompt. `{{branch}}` placeholder; review-only; >~3 logical changes = reject; ends with exactly one `AGREE`/`DISAGREE` verdict token. |
| `test/prompts.test.js` | 3 tests: known-var substitution; unknown placeholder preserved; review template renders with branch var and contains both verdict tokens. |

## Tests added + results

TDD loop: wrote `test/prompts.test.js` → FAILED (`Cannot find module '../src/prompts.js'`) → wrote `prompts.js` + both templates → 3 pass.

Full suite (`node --test`):
```
ℹ tests 8
ℹ pass 8
ℹ fail 0
```
(smoke + 4 verdict + 3 prompts)

## Decisions / deviations

- **Committed `test/prompts.test.js`.** The plan's Step 5 `git add` lists only `src/prompts.js src/prompts/` and omits the test file, but the task's Files section names it as a deliverable. Leaving the test uncommitted would be wrong, so it was included. Auditor confirmed the file set is correct.
