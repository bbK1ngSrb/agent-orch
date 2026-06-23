# Task 12 — Complete

**Task:** GitHub-ready packaging.
**Status:** APPROVED (audit attempt 1, `docs/task12-audit1.md`).
**Commit:** `6725b4c docs(agent-orch): README, license, contributing, CI`.

## Files created/changed

| File | Purpose |
| ---- | ------- |
| `.github/workflows/ci.yml` | GitHub Actions CI: checkout, setup-node v4 (Node 20), `npm ci \|\| npm install`, `npm test`. Static — no untrusted input in `run:` steps. |
| `README.md` | Project summary, requirements, quickstart (`npx agent-orch init` / `task`), command list, config pointer, merge-decision rule, MIT note. Replaced the pre-implementation placeholder. |
| `orch.example.yml` | Documented optional config with defaults (agents, test, reviseCap, merge, scope). |
| `CONTRIBUTING.md` | How to add an agent adapter (buildArgs + registry + test), the adapter contract, and the test command. |
| `LICENSE` | Standard MIT, `Copyright (c) 2026 agent-orch contributors`. |

## Tests + results

No source/test changes (docs + CI only). Full suite re-verified:
```
ℹ tests 44
ℹ pass 44
ℹ fail 0
```

## Decisions / deviations

- None. Files match the plan verbatim. CI workflow carries no injection surface (no event-context interpolation in shell steps).
