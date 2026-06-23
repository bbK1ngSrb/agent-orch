# Task 1 — Complete

**Task:** Project scaffold + test runner.
**Status:** APPROVED (audit attempt 1, `docs/task1-audit1.md`).
**Commit:** `81d6bf7 chore(agent-orch): scaffold package + node:test runner`.

## Files created/changed

| File | Purpose |
| ---- | ------- |
| `package.json` | npm manifest. `name=agent-orch`, `version=0.1.0`, `type=module` (ESM), `bin.orch=bin/orch.js`, `engines.node>=18`, `scripts.test="node --test"`, single dep `yaml@^2.4.0`. |
| `src/version.js` | Exports `VERSION = "0.1.0"` — the single source of the semver string. |
| `bin/orch.js` | CLI entrypoint (shebang `#!/usr/bin/env node`). Imports `main` from `../src/cli.js` and runs it, printing `orch: <err>` and exiting 1 on rejection. `cli.js` does not exist until Task 11 — by design, the import only fails at runtime, not under `node --test`. |
| `test/smoke.test.js` | Smoke test: imports `VERSION` and asserts it matches `/^\d+\.\d+\.\d+$/`. |
| `.gitignore` | Ignores `node_modules/` and `.orch/`. Pre-existed with identical content, so the scaffold commit touched only the other 4 files; it is tracked and correct. |

## Tests added + results

`test/smoke.test.js` — "version is a semver string". TDD loop followed:
1. Wrote the test → ran `node --test` → FAIL (no `package.json`/`src/version.js`).
2. Wrote implementation → ran `npm install && node --test` → PASS.

Full suite (`node --test` from repo root):
```
ℹ tests 1
ℹ pass 1
ℹ fail 0
```

## Decisions / deviations

- **Path prefix dropped.** The plan prefixes every path with `agent-orch/` and uses `cd agent-orch` / `git add agent-orch/...`, written from a parent-directory vantage point. The git repo root *is* `~/agent-orch` (cwd, holds `docs/` and `.git`), and the design calls this the standalone GitHub repo. So package files live at the repo root (`package.json`, `bin/`, `src/`, `test/`, `.gitignore`) and the `agent-orch/` prefix was stripped. Confirmed correct by the auditor against commit `81d6bf7`.
- **`git add -f package.json`.** `.git/info/exclude` carries claude-code "scrub-mode stubs" ignoring `/package.json` and lockfiles. `package.json` is the core deliverable and the plan commits it, so it was force-added once; once tracked, the exclude no longer applies. The other 4 files were not excluded.
- **`.claude/` and `.mcp.json` left untracked.** Local agent/MCP config, not part of the deliverable — deliberately not committed.
- **`package-lock.json` not committed.** Created by `npm install` but excluded by the scrub-mode stubs and not in the plan's commit list; left untracked.
