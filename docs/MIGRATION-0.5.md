# Migrating to agent-orch v0.5.0

v0.5.0 is a clean CLI break. Update scripts and configuration as follows:

| # | v0.4.x | v0.5.0 | Migration |
|---:|---|---|---|
| 1 | `orch config` wizard | `orch config [--check] [--json]` | Edit `.orch/orch.yml` directly, then validate it. |
| 2 | `orch review <branch>` | `orch pr <branch> [--until ...]` | Use `--until once` for audit-only review. |
| 3 | `orch update` | `orch upgrade` | Replace the removed alias. |
| 4 | `orch agent build <name>` | `orch agent add <name> --build` | Use the combined spelling to scaffold an adapter. |
| 5 | `--merge` on `pr` | `--until merged` | Replace the boolean with the explicit goal. |
| 6 | `merge:` config key | `landing:` | Rename the key; its values remain `no-ff`, `ff-only`, or `pr`. |
| 7 | `--pr` agent-build flag | `landing: pr` | Configure the landing mode instead of passing a per-run flag. |
| 8 | `orch_review` MCP tool | `orch_pr` | Pass `branch` or `number`, plus an `until` goal. |
| 9 | bare run means one pass | bare `task`, `issue`, and `pr` mean `--until ready` | Use `--until once` for a single pass. |
| 10 | native auto-merge config | per-run `--until merged` | Opt into merging only when the merge goal is requested. |
| 11 | `continue` goal override | recorded goal is inherited | Bare `orch continue <sid>` resumes the saved goal; only `--until once` may be explicitly typed. `ready` and `merged` overrides are rejected with exit 64. |

Removed config keys are a harsher failure than removed commands. A removed
command exits 64 when you type it, but a removed key in `.orch/orch.yml` makes
config loading fail, so every command in that repository refuses to start until
the file is migrated, including commands unrelated to the removed key. Run
`orch config --check` to list exactly which keys must change. A repository that
drives its own releases through orch must migrate `.orch/orch.yml` in the same
window as the upgrade, or the tool needed to perform the release is the tool
that the old configuration just broke.

The `continue` rule reads as a refusal because it is one: the resume path cannot
install a new controller policy, so `orch continue <sid> --until ready|merged`
exits 64 saying that goal "is not yet available" here rather than accepting the
flag and quietly ignoring it. A recorded `ready`/`merged` goal is still
inherited by a bare `orch continue <sid>`. To change a future run's goal, start
a new run with `--until ready` or `--until merged`; to perform one resumed pass,
use `orch continue <sid> --until once`.

Removed commands and flags fail with usage exit code `64`. Run `orch help`
after updating scripts to see the complete v0.5.0 command surface.
