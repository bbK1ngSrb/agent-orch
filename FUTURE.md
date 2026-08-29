# Future

Horizon roadmap — less certain and less detailed than [PLANNED.md](PLANNED.md).
Ideas parked here haven't been scoped into an implementation plan yet.
Contributors: more than welcome to pick up anything on this list — see
[CONTRIBUTING.md](CONTRIBUTING.md).

## 1 month (v0.4)

- Model/effort-aware rotation pool — **decided against** on
  [#323](https://github.com/bbk1ng/agent-orch/issues/323) only for the `agents:`
  key: its entries stay bare adapter names and rich role specs are rejected at
  config validation. The approved narrow form puts `<agent> [model] [effort]`
  specs in YAML `authors:`/`reviewers:` pools, which rotate one cross-agent pair
  per cycle; CLI plural overrides retain their parallel fan-out/panel behavior.

## 3 months (v0.5)

- Dashboard visibility for orch cycles running outside the launching
  terminal (background/detached via `nohup`/`tmux`, or a future `--detach`
  flag) — see [docs/idea-detach-dashboard-visibility.md](docs/idea-detach-dashboard-visibility.md).
- Drop quota-exhausted agents from the rotation pool on the fly, instead of
  letting a 403 kill the whole cycle — orch already detects the condition
  (`LIMIT_RE` in `cli-adapter.js`) but can only abort on it; pre-flight probing
  is the weaker alternative. Includes moving limit detection into the adapter
  contract next to `capabilities` (one shared regex cannot cover seven CLIs) and
  scaffolding the field in `orch agent build` — see
  [docs/idea-agent-quota-exclusion.md](docs/idea-agent-quota-exclusion.md).
  Audited behavior as of 2026-08-11 is recorded in
  [docs/idea-agent-readiness-audit.md](docs/idea-agent-readiness-audit.md):
  detection today covers the **reviewer seat only** (`author()` never consults
  `LIMIT_RE`), the regex misses "at capacity" / "session limit" / bare `403`,
  there is no fallback to another agent on either seat, and exit codes conflate
  "agent unavailable" with "orch bug".

## 1 year
