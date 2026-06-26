# agent-orch

Run two local coding agents (Claude, Codex) in a cross-audit loop on any git repo.
One authors a small change; the other audits it; on agreement + green tests it
merges to `main` locally; on disagreement it revises (capped); on stalemate it
asks you. All compute is local.

## Requirements
- Node ≥ 18
- At least one agent CLI on PATH: `claude`, `codex`, or `ccr` (for local-llm models)

## Install
Not yet published to npm — install from source. The CLI is exposed as `orch`:
```bash
git clone https://github.com/bbK1ngSrb/agent-orch.git
cd agent-orch
npm install -g .        # puts `orch` on your PATH
orch <command>
```
Prefer not to install globally? Run the CLI in place with `node bin/orch.js <command>`
from the cloned checkout.

## Usage
Run from inside the git repo you want orchestrated:
```bash
orch init                                  # scaffold .orch/orch.yml, verify agent CLIs
orch task "fix the flaky login test"       # author + cross-audit + test-gate + merge
orch review pr/claude/some-branch          # audit an existing branch (no authoring)
orch pr 42                                  # audit a GitHub PR, post verdict as a comment
orch pr 42 --merge                          # ...and merge it via gh if agents approve
```
Add `--dry` to any `task`/`review` run to simulate a cycle without touching git,
agents, or tests. `orch` exits non-zero (`2`) when a cycle escalates for a human.

`orch pr <n>` needs the [`gh`] CLI authenticated. It fetches the PR head, runs an
audit-only cycle (local `main` is never touched — GitHub owns the merge), and
posts the verdict as a PR comment. With `--merge` it runs `gh pr merge` when the
agents approve and tests pass.

[`gh`]: https://cli.github.com/

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
orch init
orch task "fix the flaky login test"
```

## Commands
- `orch init` — scaffold `.orch/orch.yml`, verify agent CLIs.
- `orch task "..."` — author + cross-audit + test-gate + merge.
- `orch review <branch>` — audit an existing branch.
- `orch pr <n> [--merge]` — audit a GitHub PR, comment the verdict, optionally merge via `gh`.

## Config (`.orch/orch.yml`, all optional)
See `orch.example.yml`. Most repos need no config. A bare `orch.yml` at the
repo root is still read for back-compat, but `.orch/orch.yml` wins if both exist.

## How it decides to merge
Merge happens only when the reviewer says `AGREE` **and** the repo's tests pass.
No test command detected → it refuses to auto-merge and tells you.

## Auto docs-update on merge
Opt-in per repo. With `docs.autoUpdate: true` in `.orch/orch.yml`, a successful
merge auto-spawns a detached `orch task` that refreshes documentation:
```yaml
docs:
  autoUpdate: true   # off by default
  prompt: "update documentation to reflect the latest merged changes"
  paths: ["*.md", "docs/**", "**/*.md"]   # docs-only globs = loop guard
```
**Loop guard:** the trigger is skipped when the merged branch changed only docs
files (every path matches `docs.paths`) — so the docs-update's own docs-only
merge never re-triggers another one — and when the merge was a no-op (empty diff:
nothing to update, which would otherwise re-spawn forever). A mixed code+docs
merge triggers once.

This covers local merges done by `orch task`/`orch review`. GitHub PR merges
(`orch pr --merge`, GitHub UI) are a separate surface, not yet wired up here.

**Portability:** the behavior ships inside `orch` — any standalone repo gets it
by setting `docs.autoUpdate: true`.

## License
[Apache-2.0](LICENSE)
