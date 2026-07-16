# Future

Horizon roadmap — less certain and less detailed than [PLANNED.md](PLANNED.md).
Ideas parked here haven't been scoped into an implementation plan yet.
Contributors: more than welcome to pick up anything on this list — see
[CONTRIBUTING.md](CONTRIBUTING.md).

## 1 month (v0.4)

- Model/effort-aware rotation pool — parse `agents:` entries as full role specs
  (`<agent> [model] [effort]`), rotate by `.agent`, preserve model/effort at
  spawn, and reject duplicate agents in the pool. Decision + rationale on
  [#323](https://github.com/bbk1ng/agent-orch/issues/323).

## 3 months (v0.5)

- Dashboard visibility for orch cycles running outside the launching
  terminal (background/detached via `nohup`/`tmux`, or a future `--detach`
  flag) — see [docs/idea-detach-dashboard-visibility.md](docs/idea-detach-dashboard-visibility.md).

## 1 year

