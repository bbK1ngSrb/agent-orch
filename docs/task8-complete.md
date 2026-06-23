# Task 8 — Complete

**Task:** `adapters/` — pluggable agent CLIs.
**Status:** APPROVED (audit attempt 2, `docs/task8-audit2.md`).
**Commits:** `6def766 feat(agent-orch): pluggable Claude + Codex adapters`; `e2d0672 fix(agent-orch): audit fail-safe DISAGREE on agent nonzero exit (F4)`.

## Files created/changed

| File | Purpose |
| ---- | ------- |
| `src/adapters/cli-adapter.js` | `makeCliAdapter({name, bin, buildArgs}) -> { name, author(task,wd), audit(branch,wd) }`. `author` runs the agent on the rendered author prompt (hard error on failure). `audit` runs the rendered review prompt via `runCapture` and returns a `parseVerdict` result — but **F4**: on nonzero/crashed exit (`ok:false`) it returns a fail-safe `DISAGREE` *without* trusting partial output. |
| `src/adapters/claude.js` | `buildArgs(prompt) -> ["-p", prompt]`; default export = adapter `{name:"claude", bin:"claude"}`. |
| `src/adapters/codex.js` | `buildArgs(prompt, wd) -> ["exec","--cd",wd,prompt]`; default export = adapter `{name:"codex", bin:"codex"}`. |
| `src/adapters/index.js` | Registry: `get(name)` → adapter or throws `unknown agent`; `bins()` map. |
| `test/adapters.test.js` | 5 tests: claude args, codex args, registry resolve/reject, audit DISAGREE on nonzero exit, **and** audit ignores `AGREE` printed by a crashed agent (the F4 fix). |

## Audit history

- **Attempt 1 — CHANGES** (`task8-audit1.md`): `audit()` ignored `runCapture`'s `ok:false`, so an agent printing `AGREE` then `exit 3` was wrongly accepted as AGREE — violates the F4 fail-safe.
- **Fix** (`e2d0672`): `audit()` now returns `{decision:"DISAGREE", reason:"agent exited nonzero", raw}` whenever `ok` is false; added a regression test (`echo AGREE; exit 3` → DISAGREE).
- **Attempt 2 — APPROVED** (`task8-audit2.md`): no findings, 28/28 tests pass.

## Tests added + results

Full suite (`node --test`):
```
ℹ tests 28
ℹ pass 28
ℹ fail 0
```
(smoke + 4 verdict + 3 prompts + 2 scope + 5 gate + 4 config + 4 git + 5 adapters)

## Decisions / deviations

- The F4 fix is the smallest change that satisfies the fail-safe: a single `if (!ok) return DISAGREE` guard plus one regression test. No adapter API change.
- Unrelated to this task: the `.github/workflows/node.js.yml` CI file was added then deleted on `main` from outside the build loop (`b1f91e9`).
