# agent-orch

Run two local coding agents (Claude, Codex) in a cross-audit loop on any git repo.
One authors a small change; the other audits it; on agreement + green tests it
merges to `main` locally; on disagreement it revises (capped); on stalemate it
asks you. All compute is local.

## Requirements
- Node ≥ 18
- At least one agent CLI on PATH: `claude`, `codex`, or `ccr` (for local-llm models)

## Agents
`claude`, `codex`, and three local-llm models served via [llama-swap] behind
claude-code-router (`ccr`): `qwen3-coder-30b`, `deepseek-coder-v2-lite`,
`glm-4.5-air`. Local models need `ccr` on PATH and `~/.claude-code-router/config.json`
defining a `local` provider (see `local-llm/configs/`).

Pick who authors and who audits explicitly in `orch.yml`:
```yaml
author: qwen3-coder-30b   # writes the change
reviewer: claude          # audits it
```
Set both or neither. Unset → the `agents:` list rotates author each cycle.

[llama-swap]: http://192.168.10.60:8080/

## Quickstart
```bash
cd your-repo
npx agent-orch init
npx agent-orch task "fix the flaky login test"
```

## Commands
- `orch init` — scaffold `.orch/orch.yml`, verify agent CLIs.
- `orch task "..."` — author + cross-audit + test-gate + merge.
- `orch review <branch>` — audit an existing branch.

## Config (`.orch/orch.yml`, all optional)
See `orch.example.yml`. Most repos need no config. A bare `orch.yml` at the
repo root is still read for back-compat, but `.orch/orch.yml` wins if both exist.

## How it decides to merge
Merge happens only when the reviewer says `AGREE` **and** the repo's tests pass.
No test command detected → it refuses to auto-merge and tells you.

## License
MIT
