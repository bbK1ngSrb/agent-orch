# Migrating to agent-orch v0.5.0

v0.5.0 is a clean CLI break. Update scripts and configuration as follows:

| # | v0.4.x | v0.5.0 | Migration |
|---:|---|---|---|
| 1 | `orch config` wizard | `orch config [--check] [--json]` | Edit `.orch/orch.yml` directly, then validate it. |
| 2 | `orch review <branch>` | `orch pr <branch> [--until ...]` | Use `--until once` for audit-only review. |
| 3 | `orch update` | `orch upgrade` | Replace the removed alias. |
| 4 | `orch agent build <name>` | `orch agent add <name> --build` | Use `landing: pr` if the scaffold should open a PR. |
| 5 | `--merge` on `pr` | `--until merged` | Replace the boolean with the explicit goal. |
| 6 | `merge:` config key | `landing:` | Rename the key; native auto-merge settings are removed. |
| 7 | `--pr` agent-build flag | `landing: pr` | Configure the landing mode instead of passing a per-run flag. |
| 8 | `orch_review` MCP tool | `orch_pr` | Pass `branch` or `number`, plus an `until` goal. |
| 9 | bare run means one pass | bare `task`, `issue`, and `pr` mean `--until ready` | Use `--until once` for a single pass. |
| 10 | native auto-merge config | per-run `--until merged` | Opt into merging only when the readiness goal is requested. |
| 11 | `continue` goal override | recorded goal is inherited | Bare `orch continue <sid>` resumes the saved goal; only `--until once` may be explicitly typed. `ready` and `merged` overrides are rejected with exit 64. |

The `continue` rule is intentional: a resumed run must not accept a goal that
the current resume path cannot apply. To change a future run's goal, start a
new run with `--until ready` or `--until merged`; to perform one resumed pass,
use `orch continue <sid> --until once`.

Removed commands and flags fail with usage exit code `64`. Run `orch help`
after updating scripts to see the complete v0.5.0 command surface.
