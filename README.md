# agent-orch

Run local coding agents (Claude, Codex) in a cross-audit loop on any git repo.
One authors a small change; the other audits it; on agreement + green tests it
merges to `main` locally; on disagreement it revises (capped); on stalemate it
asks you. All compute is local.

**Status:** pre-implementation. Design + TDD plan in `docs/`.

## Quickstart (once built)
```bash
cd your-repo
npx agent-orch init
npx agent-orch task "fix the flaky login test"
```
