# Future

Horizon roadmap — less certain and less detailed than [PLANNED.md](PLANNED.md).
Ideas parked here haven't been scoped into an implementation plan yet.
Contributors: more than welcome to pick up anything on this list — see
[CONTRIBUTING.md](CONTRIBUTING.md).

## 1 month (v0.4)

- Model/effort-aware rotation pool — **decided against** on
  [#323](https://github.com/bbk1ng/agent-orch/issues/323): `agents:` entries
  stay bare adapter names and rich role specs (`<agent> [model] [effort]`) are
  rejected at config validation; model/effort belong in the `author`/`reviewer`
  keys or CLI overrides.

## 3 months (v0.5)

- Dashboard visibility for orch cycles running outside the launching
  terminal (background/detached via `nohup`/`tmux`, or a future `--detach`
  flag) — see [docs/idea-detach-dashboard-visibility.md](docs/idea-detach-dashboard-visibility.md).

## 1 year

