# agent-orch

Run two local coding agents (Claude, Codex) in a cross-audit loop on any git repo.
One authors a small change; the other audits it; on agreement + green tests it
merges to `main` locally; on disagreement it revises (capped); on stalemate it
asks you. All compute is local.

## Requirements
- Node ≥ 18
- At least one agent CLI on PATH: `claude` and/or `codex`

## Quickstart
```bash
cd your-repo
npx agent-orch init
npx agent-orch task "fix the flaky login test"
```

## Commands
- `orch init` — scaffold `orch.yml` + `.orch/`, verify agent CLIs.
- `orch task "..."` — author + cross-audit + test-gate + merge.
- `orch review <branch>` — audit an existing branch.

## Config (`orch.yml`, all optional)
See `orch.example.yml`. Most repos need no config.

## How it decides to merge
Merge happens only when the reviewer says `AGREE` **and** the repo's tests pass.
No test command detected → it refuses to auto-merge and tells you.

## License
MIT
