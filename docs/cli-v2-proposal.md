# CLI v2 proposal — one outcome flag, a bounded loop, headless by default

**Status:** design-only, approved for planning, NOT implemented; supersedes
`docs/cli-simplification-*.md` (2026-08-16).
**Date:** 2026-08-17
**Author:** external advisor review (team-lead audit, 8 specialists + 4 verifiers)
**Revision:** 2026-08-17, after two adversarial reviews (implementability, fidelity); tags like "review impl-B4" / "review fidelity-B1" in the design and plan cite those reviews' finding ids.
**Companions:** `docs/cli-v2-design.md` (how it works), `docs/cli-v2-implementation-plan.md` (how it ships).
**Baseline audited:** commit `5879651` (v0.4.315). Every `file:line` below was
verified against that commit by an independent verifier; the audit reports are
summarised, not re-argued, here.

---

## 1. Executive summary

Today `orch` is a single-pass tool: it authors, cross-audits, gates, and lands
*once*, and when anything goes sideways it writes a `DECISION.md` and stops
(`src/engine.js:369-381`), or "demotes" to a `merge-deferred` status
(`src/finalize.js:553-603`) and stops. A human must notice, diagnose, and re-run.
The 2026-08-16 dashboard snapshot showed **zero clean unattended cycles** out of
332 runs (`docs/cli-simplification-review-record.md:37-38`).

This proposal turns `orch` into a **bounded solver**: every run command gets one
outcome flag, `--until ready|merged|once`, and the bare command means
`--until ready`. Under `ready`/`merged` orch retries with a fixed, ordered set of
remedies (rebase + repair, rotate agents, re-author, ask a human) up to
`automation.maxAttempts` (default 3), then stops with a *distinct* exit code that a
script can act on. It also cuts the command surface from 17 to 14, validates every
flag against its command, honours `--dry` everywhere, exits `64` on a typo, adds
`--json` and `--detach`, replaces the interactive config wizard with a
non-interactive `config --check`, and removes orch's own minted `GH_TOKEN` and
the rest of the ambient environment from what adapter subprocesses can see (P0;
not a sandbox — the agent still has `HOME`/`PATH`).

Before / after, the same intent:

```
# today (v0.4.x): one pass; on stalemate you read .orch/reviews/<branch>/DECISION.md and re-run by hand
orch issue 42                      # exit 2 on escalate/demote — same code as "concurrency cap hit"

# after (v0.5.0): keeps going until the standing integration PR is green for this change, or a bounded stop
orch issue 42                      # == orch issue 42 --until ready  → exit 0 = nothing left for orch to do
orch issue 42 --until merged       # …and merge the standing integration→main PR, head-SHA-bound, verified by ancestry
orch issue 42 --until once         # today's single pass, for humans watching
```

Version: **v0.5.0, clean break** (owner decision 5). Old spellings are removed,
not aliased; a migration table is in §4.1.

---

## 2. Problems with today's CLI (verified)

Each item cites the audit that proved it and the code line. "Verified" means an
independent verifier re-read the cited line at commit `5879651`.

| # | Problem (D = defect; slice IDs in the plan use P) | Evidence (file:line) | Audit |
|---|---|---|---|
| D1 | **17 commands** (`init config agent-add agent-build task issue review continue pr release dashboard mcp upgrade update completion version help`), several overlapping (`review <branch>` vs `pr <n>` both run the same review-mode cycle, `engine.js:373-380`; `agent build` is a specialised `task`). | `src/cli.js:1806-1830` (usage text) | cli §1 |
| D2 | **Flags accepted but silently ignored.** `--dry` is never read by `pr` (only 4 `flags.dry` reads exist: `cli.js:1112,1195,1316,1548`) — `orch pr 42 --merge --dry` performs a **real** `gh api -X PUT …/merge` (`github.js:16-20` via `runPr`, `github.js:208`). `agent add` ignores `--dry` and `--config-file` (`cli.js:1291,1293`). `--file` is dropped on `issue`/`review` (`cli.js:1325-1336`). `--cheap` is dropped on `agent build` (`cli.js:1102-1154`, no `applyCheapOverride`). | `cli.js:1721-1741`, `1278-1309` | cli #1, #2, #7 — issues #497, #498 |
| D3 | **Only `--merge` has cross-command validation** (`cli.js:1158-1169`); every other command-scoped flag no-ops elsewhere. The guard's own comment describes the exact bug class it fixed in one place. | `cli.js:1158-1169` | cli #4 — issue #500 |
| D4 | **Exit code 2 is overloaded.** It means "escalated" (`cli.js:1514`), "merge-deferred" (same line), "concurrency cap, nothing attempted" (`cli.js:1491`), "`agent build` escalated" (`1093`), and "`pr` not approved / not asked to merge" (`1736`). A `pr` outcome (agents agreed, human still has to click) exits **0** like `merged` (`cli.js:1498-1521` sets no code for `"pr"`). | `cli.js:1093,1491,1514,1712,1736` | cli #8, tests §4 — issue #501 |
| D5 | **`merge:` config key vs `--merge` flag** share a name and mean unrelated things (`config.js:20` enum `ff-only|no-ff|pr`; `cli.js:396` boolean "also merge this PR"). | `config.js:20`, `cli.js:396` | config §2 |
| D6 | **Interactive-only wizard.** `orch config` throws without a TTY (`config-wizard.js:293`); there is no scriptable path to write or validate config. | `src/config-wizard.js:293` | config #3 |
| D7 | **Banner and TTY residue** on the run path (`cli.js:861-866`, `--no-banner`), an interactive `readline` prompt in `agent add` (`cli.js:594-600`), and `[y/N]` in post-run tidy (`complete.js:32`, gated on `interactive`). Harmless when piped, but noise for a headless-first tool. | `cli.js:861`, `594-600` | cli §4, tests §4 |
| D8 | **Single-pass stop-and-wait model.** Ten escalation triggers (`engine.js:158-381`) write `DECISION.md` and halt; five demotion triggers (`finalize.js:83-216`) return `merge-deferred`, plus one landing escalation (`finalize.js:80`). Only `overlap` demotions are ever auto-retried (`deferred.js:41` hard-codes `trigger:"overlap"`; `MAX_REDRIVE_ATTEMPTS=1`). `dirty-merge`, `integration-test`, `sync`, `lock` are one-shot. | `engine.js:369-381`, `finalize.js:142-149`, `deferred.js:14,41` | engine §1, §3 |
| D9 | **`continue` cannot retry an escalated cycle.** Checkpoint + resume records are cleared unconditionally after *any* terminal return (`cli.js:1506-1509` task/issue; `1684-1693` continue), so `orch continue <sid>` throws "nothing to resume" (`cli.js:1580-1581`) for the very outcomes a loop needs to revisit. | `cli.js:1506-1509`, `1684-1693`, `1580-1581` | engine §2 (verifier: "airtight") |
| D10 | **Non-idempotent PR creation.** `pushAndCreatePr` (`github.js:265-278`) does an unconditional `gh pr create`; a second call for the same head throws out of `demote`/`openPr` → `finalize` → `engine` → `bin/orch.js` `process.exit(1)`. Only `openIntegrationPr` (`github.js:369-379`) does find-or-create. `runPr` re-posts its comment every call (`github.js:203`). | `github.js:265-278`, `369-379` | landing #2, #3 — issue #503 |
| D11 | **`pr --merge` never checks CI.** `runPr` (`github.js:163-247`) merges on orch's own AGREE+green only; `prChecksGreen`/`statusCheckRollup` is called nowhere in it. GitHub protection is the only guard. | `github.js:163-247`, `77-103` | landing §3 — issue #508 |
| D12 | **`tryMergeDirect` swallows every non-409 error** (401 expired App token, 403 scope) — a loop built on it would spin blind. | `github.js:66-75` | landing #4 — issue #504 |
| D13 | **Security: adapters inherit the full `process.env`.** `cli-adapter.js:218` spawns the author/reviewer CLI with `process.env` (or a merge that only *adds* keys, `cli-adapter.js:18-25`); `cli.js:1205-1211` sets `process.env.GH_TOKEN` process-wide. An author agent executing an untrusted work order can `printenv` and exfiltrate a repo-scoped token; the diff-based security floor never sees it. Verifier: exposure is the *whole* ambient env, not just `GH_TOKEN`. | `src/adapters/cli-adapter.js:218`, `src/cli.js:1205-1211` | landing #1 (HIGH) — issue #502 (P0) |
| D14 | **Unattended success is zero.** 332 runs, 42.8% "success", 0 clean unattended cycles (`dashboard --json` field `cleanUnattendedCycles`, `src/dashboard.js:166`). | review-record:37-38 | priorart §2.7 |
| D15 | Smaller defects a loop would amplify: `gate.run` has no timeout and runs Guard 2 while holding `merge.lock` (`gate.js:57`, `finalize.js:206`; issue #505); round counter drifts on crash-during-revise (`engine.js:384-386`; issue #506); unknown command exits 0 (`cli.js:1804`; issue #499); redrive `quietFail` writes nothing to `runs.jsonl` (`finalize.js:195,209`). | as listed | engine H1-H3, cli #3 |

The pattern behind D2–D4 is one design gap: flags are declared once
(`PARSE_OPTIONS`, `cli.js:392-416`) but consumed by ad-hoc reads inside each
command's block. There is no per-command schema, so nothing can say "this flag is
not valid here" except the one hand-written `--merge` guard.

---

## 3. Goals / non-goals

**Goals**

1. A run started headless (cron, poller, MCP, `--detach`) reaches a *useful*
   terminal state without a human, or stops with a code that says exactly why.
2. One flag, one meaning, on every run command; every flag validated per command.
3. Idempotent side effects: any step may be re-run after a crash without
   duplicating a PR, a comment, or a merge.
4. Verify, don't trust: "ready" and "merged" are read back from GitHub and git
   ancestry, never inferred from an exit code.
5. Clean break at v0.5.0 with a complete migration table.

**Non-goals**

- `dashboard` and the TUI (`src/dashboard.js`, `src/tui/*`) are **untouched**;
  redesign is a separate future task (owner decision 20). Its flags stay.
- No change to review quality gates: `roundCap`, cross-audit, test gate,
  deterministic security floor (`security-review.js`), guardrail path floor
  (`intake/allowlist.js`) all keep their semantics.
- No bypass of GitHub branch protection. If protection says no, orch stops.
- Not production software (see LICENSE/README). This is an educational artifact;
  the design explains *why* at each step.
- Not the planner/DAG/park-cascade system of `docs/headless-overnight-design.md`
  §2–§3; this proposal is the safe single-unit runner it can later schedule
  (same boundary the prior proposal drew, `cli-simplification-proposal.md` §3).

---

## 4. The new user-facing contract

### 4.1 Command surface — 17 → 14 (counting `version` and `help`; 15 → 12 without them)

| Before (v0.4.x) | After (v0.5.0) | Note |
|---|---|---|
| `init [--link]` | `init [--link] [--dry]` | writes a **commented** `orch.yml` (today's `orch.example.yml` style); `--dry` prints it |
| `config` (interactive wizard) | `config [--check] [--json]` | non-interactive: prints the effective, validated config with the source of each value; `--check` exits `0`/`1` and lists unknown/removed keys with migration hints; wizard removed |
| `agent add <name>` | `agent add <name> [--build] [--dry]` | honours `--config-file`/`--dry` (fixes #498); `--build` scaffolds a missing adapter through a normal cycle |
| `agent build <name> [--pr]` | `agent add <name> --build` | folded; landing follows the repo's `landing:` mode like any task; `--pr` dropped |
| `task "…"` / `task --file f` | same, plus `--until` | bare = `--until ready` |
| `issue <n>` | same, plus `--until` | poller passes `--until ready` explicitly |
| `review <branch>` | `pr <number\|branch>` | folded: a local branch or a foreign PR head, one command |
| `pr <n> [--merge]` | `pr <number\|branch> [--until …]` | `--merge` removed; `--until merged` replaces it **and now checks CI/mergeability** (fixes #508) |
| `continue <sid>` | `continue <sid\|runId> [--until …]` | resumes an interrupted cycle **or** a stopped/waiting run |
| `release "entry"` | `release "entry" [--dry]` | `--dry` prints the bump |
| `dashboard [...]` | unchanged | out of scope |
| `mcp` | `mcp` | tools gain an `until` param (§4.6) |
| `upgrade`, `update` | `upgrade [--check] [--dry]` | `update` alias dropped |
| `completion [bash]` / `completion install` | unchanged | regenerated from the schema |
| `version`, `help` | unchanged | `help` exit 0; unknown command exit **64** |
| *(banner)* `--no-banner` | removed | no banner on the run path |
| `--merge`, `--pr` | removed | see rows above |
| `--refresh-ms abc` (unvalidated) | validated | dashboard flag stays but numeric flags are validated by the parser |

Migration table for every removed or renamed spelling:

| Old invocation | New invocation |
|---|---|
| `orch review my-branch` | `orch pr my-branch --until once` (audit only) or `orch pr my-branch` (repair until ready) |
| `orch pr 42 --merge` | `orch pr 42 --until merged` |
| `orch pr 42` (audit + comment, no merge) | `orch pr 42 --until once` |
| `orch agent build codex2` | `orch agent add codex2 --build` |
| `orch agent build codex2 --pr` | `orch agent add codex2 --build` with `landing: pr` in `orch.yml` |
| `orch update` / `orch update --check` | `orch upgrade` / `orch upgrade --check` |
| `orch config` (wizard) | edit `.orch/orch.yml` by hand, then `orch config --check` |
| `orch task "x" --no-banner` | `orch task "x"` |
| `orch task "x"` *(single pass, watch it)* | `orch task "x" --until once` — same pass; only exit codes differ: policy/security/concurrency-cap stops exit **3** (was 2), usage errors **64** (was 0/1); banner gone |
| MCP `orch_review {branch}` | `orch_pr {number\|branch, until:"once"}`; a call to the removed tool returns JSON-RPC error `-32601 method not found: orch_review (use orch_pr)` |
| MCP `orch_task`/`orch_issue`/`orch_continue` (one pass) | same tools; `until` param now defaults to `ready` (loops, lands on `orch/integration`); pass `until:"once"` for one pass |
| `main.autoMerge: true` in config | `--until merged` on the run (or poller/MCP config, §4.6) |
| `github.autoMergePr: true` | removed; the loop merges when green, never arms native auto-merge |
| `merge: no-ff` | `landing: no-ff` (same values; renamed to end the flag/key collision) |
| `main.conflictResolution: auto`, `main.autoResolveConflicts` | removed; conflict repair is a loop remedy under `ready`/`merged`, never under `once` |
| `main.conflictResolutionResolvers` | `automation.conflictResolvers` |
| `main.autoResolveConflictPaths` | `automation.conflictAutoPaths` |
| `reviseCap` | `roundCap` (alias removed) |

### 4.2 The ONE outcome flag: `--until ready|merged|once`

The flag names the **goal** the run pursues, so a reader can predict what the
command will do from the goal alone.

- **`ready`** *(default when the flag is omitted)* — loop until a pull request
  exists whose head is exactly the commit orch reviewed and tested (see "landed
  head" below), and GitHub reports it mergeable with every check green. It still
  lands on and pushes `integrationBranch` (today's path) and, when the standing
  PR is red for reasons unrelated to this change, **repairs the integration
  branch** (update-branch, conflict resolution, red-CI fix — design §10A) inside
  the same attempt cap; it **never merges the standing PR**. Exit `0` means:
  nothing is left for orch to do; a human can merge with one click, or a later
  `--until merged` run can.
- **`merged`** — everything `ready` does, then land on `integrationBranch`
  (existing path, `src/finalize.js:59-172`) and merge the **standing**
  `integrationBranch → baseBranch` PR (`github.openIntegrationPr`,
  `github.js:349-490`, already find-or-create). If that standing PR is red for
  reasons unrelated to this change (another cycle's conflict, base moved, red
  CI), the loop **repairs the integration branch too** — rebase/merge base in,
  resolve conflicts, fix tests — inside the same attempt cap (owner decision 17),
  then merges with a head-SHA-bound request — only after readiness was read
  back for the **exact** head being merged, after the last push, and after a
  local test-gate run on that head if the repo requires no checks — and verifies
  by ancestry (`git merge-base --is-ancestor`). Never squash, never rebase-merge
  (repo rule). CI/readiness waits are bounded (`automation.ciWaitMinutes`, each
  expiry costs an attempt), so the merge phase ends.
- **`once`** — a single pass with strict parity to today's run: no readiness
  read, exit 0 on `merged`/`pr`, stop and report on escalation or demotion
  (DECISION.md, issue comment). The only differences from today are the new
  exit codes (3 for policy/security/concurrency-cap instead of 2; 64 for usage)
  and the missing banner — see the migration table. For humans watching a
  terminal.

"Landed head" (definition used everywhere): under `landing: no-ff|ff-only` the
reviewed commit is merged onto `integrationBranch`, so the PR whose head must
match is the standing integration PR and the head is the integration tip this run
produced (`integrationSha`, computed today at `finalize.js:237`); the reviewed
commit must be an ancestor of that head. Under `landing: pr` (per-cycle PR to
base, kept as an explicit opt-out) the head is the reviewed commit itself.

**Why one enum, not two booleans** (owner decision 16). The working names
`--auto`/`--pre-approved` were retired because: (a) `--merge` (flag) vs `merge:`
(config key) already collide today (D5) and a second merge-ish boolean would
compound it; (b) two booleans invite `--auto --pre-approved`, `--pre-approved`
alone (does it loop?), and a validation rule nobody remembers; (c) an enum reads
as the goal — `--until merged` is a sentence. `once` gives the single-pass
behaviour a name instead of "absence of flags".

**Same flag, same meaning on every run command.** `task`, `issue`, `pr`,
`continue` all accept it. On `pr <n>` for a *foreign* PR: `ready` = repair the PR
head until green (orch pushes to that head only if the branch lives in this repo
and orch has write access; otherwise it opens a repair branch and links it),
`merged` = merge when green — and unlike today it **must** check
`mergeable`/`mergeStateStatus`/`statusCheckRollup` first (audit-landing §3:
`runPr` never calls `prChecksGreen`, `github.js:163-247`).

### 4.3 The full flag list and the new `--help`

Rules the parser enforces (generalising the `--merge` guard at `cli.js:1158-1169`
into a declarative per-command schema, design §3):

- every flag is validated against the command; out-of-scope → exit **64** with
  `orch: --file is not valid with 'orch issue'`;
- `--dry` is honoured by every command that can mutate anything, and **rejected**
  (64) by read-only commands (`config`, `dashboard`, `mcp`, `completion`,
  `version`, `help`);
- unknown command → usage on **stderr**, exit **64** (today: stdout, exit 0,
  `cli.js:1804`);
- numeric flags are validated: `--limit`, `--refresh-ms` positive integers,
  `--max-attempts` a non-negative integer (`0` = one pass with the new exit codes);
- `--json` is global: one JSON object per line on stdout, human text off
  (`dashboard --json` keeps its single-snapshot shape — out of scope);
- `--detach` (from `FUTURE.md`) runs the command as a background child, writes
  its log under `automation.detachLogDir` and registers `{pid, sid, detached:true,
  log}` in the inflight store so the *existing* dashboard lists it.

Draft `orch --help` (generated from the schema; this text is the contract):

```
orch — author, cross-audit, test-gate and land a change with coding agents.

Usage: orch <command> [options]

Commands:
  task "change"           Run a cycle for a change; --file <json> reads an untrusted work order.
  issue <number>          Run a cycle from a GitHub issue; closes it when the change reaches base.
  pr <number|branch>      Audit a PR or branch; repair it until ready, or merge it (--until).
  continue <sid|runId>    Resume an interrupted cycle, or a stopped/waiting run.
  release "entry"         Bump version + CHANGELOG by hand (repos with release.autoBump).
  agent add <name>        Add an agent to the pool; --build scaffolds a missing adapter first.
  init                    Write a commented .orch/orch.yml and .orch/ORCH.md.
  config                  Print the effective, validated config; --check exits 1 on problems.
  dashboard               Live status TUI; --once/--json print a static snapshot.
  mcp                     Serve orch as an MCP server over stdio.
  upgrade                 Self-update the global npm install; --check only reports.
  completion [bash|install]  Print or install the shell completion script.
  version | help          Print the version | this help.

Run options (task, issue, pr, continue):
  --until <goal>          ready (default): loop until the PR for this change is green and mergeable; never merge.
                          merged: also land on the integration branch and merge the standing integration PR.
                          once: single pass; stop and report on escalation (today's run, new exit codes).
  --max-attempts <n>      Remedy rounds after the first cycle (default automation.maxAttempts = 3).
  --author <spec>         Author as "<agent> [model] [effort]" (not on continue).
  --authors <a,b>         Comma-separated authors; each writes its own branch (task, issue).
  --reviewer <spec>       Reviewer spec.  --reviewers <a,b>  comma-separated reviewers.
  --cheap                 Force cheap.role for this run (task, issue).
  --file <json>           With task: read the work order from a JSON file.
  --allow-protected       task/issue: run even if the work order names a protected path.
  --no-tidy               Keep task branches and worktrees after a merge.
  --detach                Run in the background; print pid, log path and runId; exit 0.

General options:
  --json                  Machine output: one JSON object per line on stdout.
  --dry                   Plan only: no agents, no git/GitHub writes; under ready/merged plans the first cycle and prints the remedy ladder (rejected on read-only commands).
  --config-file <yml>     Layer a config file over .orch/orch.yml.
  --check                 config: validate and exit 1 on problems.  upgrade: report only.
  --link                  init: link .orch/ORCH.md from agent docs.
  --json --limit <n> --check-history --once|--plain --refresh-ms <n>   dashboard (unchanged).
  -h, --help  --version

Exit codes: 0 goal reached · 1 internal error · 2 stopped at attempt cap (resumable: orch continue <runId>)
            3 blocked, needs a human · 4 waited for a human, no answer · 64 usage
```

Per-command flag matrix (source of truth is the schema in design §3):

| Command | Positional | Flags |
|---|---|---|
| `task` | `"text"` or `--file` | `--until --max-attempts --author(s) --reviewer(s) --cheap --file --allow-protected --no-tidy --detach --dry --json --config-file` |
| `issue` | `<n>` | as `task` minus `--file` |
| `pr` | `<number\|branch>` | `--until --max-attempts --author --reviewer(s) --no-tidy --detach --dry --json --config-file` |
| `continue` | `<sid\|runId>` | `--until --max-attempts --reviewer(s) --no-tidy --detach --dry --json --config-file` |
| `release` | `"entry"` | `--dry --json` |
| `agent add` | `<name>` | `--build --dry --json --config-file` (+ run flags when `--build`) |
| `init` | — | `--link --dry --config-file --json` |
| `config` | — | `--check --json --config-file` |
| `dashboard` | — | `--json --limit --check-history --once --plain --refresh-ms` (unchanged) |
| `upgrade` | — | `--check --dry --json` |
| `mcp`, `completion`, `version`, `help` | — | none (`completion` takes `bash`/`install`) |

### 4.4 Exit-code contract

| Code | Name | Meaning | Today's equivalent |
|---|---|---|---|
| `0` | reached | the `--until` goal was reached and **verified** (`ready`: readiness read back from GitHub; `merged`: merge commit is an ancestor of `origin/<base>`) | 0 (but also `pr`, i.e. not done) |
| `1` | error | orch bug or environment failure (gh missing, unreadable repo, unexpected throw) | 1 |
| `2` | stopped-at-cap | goal not reached, `automation.maxAttempts` exhausted (or `--until once` and the pass escalated/demoted); a report and a durable run record exist; `orch continue <runId>` resumes with a fresh attempt budget | 2 (shared with four other meanings) |
| `3` | blocked | a human must decide: guardrail/protected path touched, security floor finding, no channel to ask (no `gh`/no remote), branch protection refused the merge and no bypass, human replied `orch: abandon`, concurrency cap reached with nothing attempted | 2 |
| `4` | wait-timeout | orch asked a human (comment) and `automation.humanWaitHours` elapsed without an authorised reply; resume with `orch continue <runId>` after answering | none |
| `64` | usage | unknown command, invalid flag for this command, bad value | 0 (unknown command) / 1 (parseArgs throw) |

Why split 2: audit-cli #8 showed a caller cannot tell "an agent disagreement
needs a human" from "cap full, just retry" from "reviewed, not asked to merge".
A loop controller (or `harness/orch-loop.sh`, which today treats `0|2` as
terminal) needs *resumable* (2, 4) distinguished from *needs human* (3) and from
*done* (0). `64` is the conventional `EX_USAGE` from `sysexits.h`.

### 4.5 The bounded loop and its remedies

An **attempt** is one full cycle pass (author or revise → cross-audit → test gate
→ landing) started in response to a classified failure. The first cycle is
attempt 0; `automation.maxAttempts` (default **3**, owner decision 21) caps the
number of *remedy rounds after it*. CI/readiness waits are bounded by
`automation.ciWaitMinutes`; **each expiry consumes one attempt** (so a run
cannot wait forever); `ask` consumes none.
`--max-attempts <n>` overrides per run.

Every failure is classified into a structured class (design §7) and the chooser
picks the first applicable remedy in this order:

1. **rebase + repair** — when the base moved, the standing PR is `BEHIND`/
   `CONFLICTING`, integration's Guard 2 or CI went red, or a `dirty-merge`/`sync`
   demotion happened. Rebase the task branch (CAS-guarded, reusing
   `git.rebaseBranchOnto`, `git.js:420-456`) or merge base into integration, then
   have the *author* fix the specific red test/conflict, then re-audit and re-gate.
2. **rotate agents / stronger model** — when a reviewer or author crashed, hit a
   quota (`AGENT_QUOTA`), or a stalemate repeats with the same finding twice.
   Integrates `FUTURE.md`'s quota-exclusion idea: limit detection moves into the
   adapter contract (`limitPattern` next to `capabilities`,
   `docs/idea-agent-quota-exclusion.md`), applies to **both** seats (today only
   the reviewer path checks `isUsageLimit`, `cli-adapter.js:304`), and the
   exhausted agent is excluded from the pool for the rest of the run with fallback
   to the next pool agent or a configured stronger model.
3. **re-author from scratch** — when the diff was empty, scope was exceeded, or
   two diverse attempts converged on the same failing assertion
   (convergent-failure detector, `headless-overnight-design.md` §3.5). A fresh
   branch is authored from the original work order (rewritten narrower for
   `SCOPE_EXCEEDED`) plus the structured failure history. Splitting into child
   runs is **not** in v0.5 (advisor decision, allowed by decision 7's "re-author
   from scratch / split": it would need child states, budgets and resume rules;
   a human splits the issue) — future work.
4. **ask a human, then wait** — when no automatic remedy applies, or the cap is
   reached. Channel: `issue` runs ask on the issue; `pr` runs ask on the PR;
   `task` runs open (find-or-create, idempotent by head branch) a **draft PR** for
   their branch at first stalemate and ask there (this is how the docs read
   decision 18's "every run opens a draft PR": the draft is the channel when no
   better one exists). Replies count only from users with **write** access
   (`gh api repos/{o}/{r}/collaborators/{u}/permission` — `permission` or
   `role_name`; a failed check blocks rather than ignores). Reply grammar:
   `orch: retry [n]` (n ≤ 3 per reply, at most 2×maxAttempts extra per run),
   `orch: abandon`, or free text (appended to the work order and worth one more
   attempt). Wait default **24 h** (`automation.humanWaitHours`); timeout → exit
   `4` with the exact resume command. `orch continue <runId>` after exit 2 or 4
   grants a fresh attempt budget (design §5.3).

**Never done autonomously**, regardless of flag or config: touching guardrail
paths (`intake/allowlist.js` `DEFAULT_PROTECTED`, enforced at `engine.js:346-351`);
bypassing branch protection; force-pushing any ref; merging with red or pending
checks; merging without binding the request to the observed head SHA; widening
authority from a comment (`orch: merge` is not a command); resolving a
`SECURITY_*` finding by editing the diff to evade the scanner (prior design
§7.1, kept).

### 4.6 Poller and MCP

- The `@orch-bot` issue poller (outside this repo, `~/.orch-poller/poller.sh`)
  spawns `orch issue <n> --until ready` by default (owner decision 14). Its
  argument whitelist may pass `--until once|ready`; `merged` is never accepted
  from a comment — a comment is not merge authority.
- MCP: `orch_task`, `orch_issue`, `orch_pr` (new; replaces `orch_review`, see
  the migration table), `orch_continue` gain an `until` parameter (`ready`
  default — a behaviour change for MCP clients that relied on one pass; `once`
  allowed).
  `merged` is accepted **only** if `automation.mcpMayMerge: true` (default
  `false`); otherwise the tool returns an error. This deliberately changes the
  README's promise (README.md:169): *"there is no arbitrary-command tool, no
  `orch pr` tool, and no way to emit `--merge`, so an MCP client cannot merge a
  pull request itself — it gets no merge authority a hand-typed `orch` in the
  same repo lacks."* New wording: MCP gets merge authority only when the repo
  owner opts in via `automation.mcpMayMerge`, and even then only through the same
  head-bound, CI-checked path a hand-typed `--until merged` uses.

### 4.7 Config changes (summary; full table in design §15)

New `automation:` block — note there is **no** `until` default key; the default
is fixed to `ready` by design so a config file can never silently turn a `ready`
into a `merged` (owner decision 16/19):

```yaml
automation:
  maxAttempts: 3            # remedy rounds after the first cycle
  humanWaitHours: 24        # how long "ask a human" waits before exit 4
  mcpMayMerge: false        # MCP may request --until merged
  remedies: [rebase, rotate, reauthor, ask]   # ordered; remove one to disable it
  # rotateModels: { claude: [claude-opus-4-8] }   # optional escalation ladder for the model field (not the #323 pool-spec design)
  pollSeconds: 30           # readiness poll base interval (exponential backoff, cap 10 min)
  ciWaitMinutes: 30         # max wait for pending checks per readiness check
  conflictResolvers: null   # role specs used to repair integration conflicts (was main.conflictResolutionResolvers)
  conflictAutoPaths: [CHANGELOG.md, docs/index.html, package-lock.json, package.json]  # was main.autoResolveConflictPaths
  detachLogDir: .orch/logs
gateTimeout: 25             # minutes for the test gate (fixes #505); default = stageTimeout
landing: no-ff              # was merge: (values unchanged: no-ff | ff-only | pr)
env:
  passthrough: []           # extra env keys allowed into adapter subprocesses (P0 allowlist)
```

Folded/removed: `main.autoMerge` (→ `--until merged`), `github.autoMergePr`
(removed: native auto-merge is documented as unreliable under `bypass_actors`,
`github.js:471-476`), `main.conflictResolution` + `main.autoResolveConflicts`
(→ loop remedy), `merge:` (→ `landing:`), `reviseCap`. Kept unchanged:
`agents`, roles, `test`, `roundCap`, `stageTimeout`, `baseBranch`,
`integrationBranch`, `concurrency`, `cheap.*`, `scope.*`, `security.*`,
`github.mergeMethod` (applies to non-integration PRs only), `docs.*`,
`release.*`. Clean break: an unknown or removed key is a **config validation
error** with a migration hint, printed by `orch config --check` and by any run
command at preflight.

---

## 5. What stays exactly the same

- Review quality gates: author → cross-audit → `roundCap` rounds → test gate →
  deterministic security floor (`engine.js:319-333`) → protected-path floor
  (`engine.js:346-351`).
- Integration branch model: green cycles land on `integrationBranch` in a
  dedicated worktree (`git.js:313-325`), Guard 2 re-tests the combined tree
  (`finalize.js:206`), the standing `integration → base` PR is the only trunk
  gate (`docs/orch-manual.md` §3.4: *"the standing integration PR remains the only
  trunk gate"*).
- *"`main` is a mirror of GitHub's `main`: orch does not merge, reset, commit, or
  push it directly"* (README.md:376). `--until merged` merges the PR through
  GitHub and then fast-forwards local base from origin — never writes base itself.
- Merge-boundary TOCTOU guard: `reviewedHeadEscalation` (`finalize.js:30-57`).
  (TOCTOU = "time-of-check to time-of-use": the branch must not move between the
  review and the merge; orch re-reads the SHA under `merge.lock`.)
- Lock, inflight, sid, overlap-redrive semantics (`lock.js`, `inflight.js`,
  `deferred.js`, `finalize.js:285-395`).
- Redaction of every outward comment (`redact.js:24-30`).
- `dashboard` and everything it reads (`runs.jsonl` fields `ts branch sid
  verdict rounds tokens costUsd` (+ `resolved`); checkpoint/inflight shapes) —
  new fields are additive only.

---

## 6. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Token spend: the default now loops | hard cap `maxAttempts` (3), each attempt logged with usage (`usage.js`), `--until once` for cheap runs, `--max-attempts 0` for "one pass but new exit codes"; runs.jsonl records per-attempt cost |
| Runaway on the shared standing PR (`ready`/`merged` repair integration) | agent repair work happens in a scratch worktree with no lock held; only the short git write into the integration worktree takes `merge.lock`; the GitHub merge phase takes `standing-pr.lock` (design §12, one scheme); every repair diff passes gate + security floor (+ reviewer audit unless confined to `conflictAutoPaths`); each repair and each CI-wait expiry costs an attempt |
| Human-wait blocks a headless queue | wait is bounded (`humanWaitHours`), returns exit 4 with resume command; `--detach` frees the terminal; poller runs are naturally parallel |
| Concurrency with other cycles | existing `concurrency` cap, `merge.lock`, overlap redrive unchanged; a second `merged` run waits on `standing-pr.lock` and re-checks readiness on the new head; a merge that lands another run's commits too is the integration model (each commit was individually gated) |
| Poller loops (a run asks on the issue, poller sees a new comment) | poller only triggers on `@orch-bot` mentions from write-access users; orch's own question comments carry a marker and never mention `@orch-bot` |
| Env allowlist breaks an adapter that needs an unlisted key | adapters declare `envKeys`; `env.passthrough` for operator extras; P0 slice ships with a `config --check` warning listing keys that will be dropped |
| Clean break breaks users' scripts | migration table (§4.1), `config --check` prints hints, unknown flags exit 64 with the new spelling in the message |
| Prior docs required "evidence from explicit modes first" before flipping the default (`cli-simplification-proposal.md` §8, §11) | conscious risk acceptance by the owner (decision 9/16); pre-cutover slices ship `--until` explicit-only in 0.4.x so evidence accrues before 0.5.0 flips the default |

---

## 7. Success criteria (measurable from `runs.jsonl` / telemetry)

1. Clean unattended runs — defined over run records as `outcome == "reached"`
   with no human reply (the dashboard's `cleanUnattendedCycles` is a consecutive
   *streak* in `kpi.json` reset by every escalation, so it cannot measure this)
   — > 0 within the first 20 v0.5.0 runs; target ≥ 60% of `--until ready` runs
   over the first 50.
2. Zero false `ready`/`merged`: every run that exited 0 has, in its record, a
   readiness observation (or merge commit + ancestry proof) — audit script over
   `runs.jsonl` + `.orch/run-records/*.json`.
3. Zero duplicate remote side effects (PRs, comments, merges) in the
   fault-injection suite (design §17) and in production records (one open PR
   per head, one marker comment per kind, `merge.requests[]` ordinals
   contiguous).
4. Median human commands from "issue filed" to "standing PR green" = 0 for
   issue-poller runs.
5. Exit-code distribution is informative: no run exits 2 without a
   `resumeCommand`; no run exits 3 without a `blockedReason`.
6. Test suite stays green on Linux CI at every slice; total tests ≥ 2070 + new.

---

## 8. Alternatives considered and rejected

| Alternative | Why rejected |
|---|---|
| Dedicated task-scoped PR to base as the merge target (prior design §8, `cli-simplification-proposal.md` §9, §11) | rejected by the owner (decision 4): it bypasses the integration model and the standing PR as the single trunk gate (`orch-manual.md` §3.4); it also needs a claim/CAS ref-race mechanism (~180 lines of prior design §8) that `merge.lock` + overlap redrive already provide for integration |
| Unbounded loop ("keep trying until green") | token spend and runaway on shared branches; owner decision 3 requires a cap |
| Two boolean flags (`--auto`, `--pre-approved`) | invalid combinations, name collision with `merge:` (D5); enum reads as a goal |
| Keep `update`, `review`, `--merge`, `--pr` as aliases | clean break (decision 5); aliases keep the silent-no-op class alive and double the schema/help/completion surface |
| Keep the interactive wizard for TTY users | it is the only TTY-only path left; `init` writes a commented file and `config --check` validates edits — the wizard's job is done better by comments |
| Native GitHub auto-merge (`gh pr merge --auto`) as the `merged` mechanism | proven not to fire under `bypass_actors` (`github.js:471-476`), and it arms a merge that outlives the invocation (prior review-record decision 1) |
| Exit 2 for everything not-0 (prior design §13.3) | loses the resumable / needs-human / timed-out distinction a controller needs |
| Accept `orch: merge` as a comment command | widens merge authority to anyone with write access via chat; they can click merge instead |

---

## 9. Relationship to prior docs (superseded, with the conflict quotes)

The 2026-08-16 set (`docs/cli-simplification-{proposal,design,implementation-plan,review-record}.md`)
was "internal review approved; final Claude confirmation pending"
(review-record:7) — never fully closed. It is **superseded** by this set. Reused
mechanisms are credited in design §1/§7/§9/§11/§16. Explicit divergences:

| Prior text (verbatim) | This proposal |
|---|---|
| proposal §11: *"### Merge the standing integration PR from a task-scoped flag — Rejected. One flag could authorize unrelated accumulated tasks."* | Reversed (owner decision 4). Resolution of the objection: each commit on `orch/integration` was individually authored, cross-audited, tested and scanned before landing; `--until merged` authorises *this* change's landing and then merges a branch every commit of which already passed the same gates. The alternative — a second door into trunk — is what `orch-manual.md` §3.4 already forbids. |
| design §1 principle 4: *"One run, one outcome PR in v1. The two new modes never merge a shared standing PR."* | Reversed for `merged`; `ready` also targets the standing PR (advisor decision, see design §18: one landing path, not two). |
| design §17: *"Does v1 use the standing integration PR? No"* / *"Can review/pr select the standing integration or another shared aggregation PR? Never in outcome mode."* | Reversed. `pr <n>` on a foreign PR merges *that* PR (head-bound), never re-lands it on integration (design §11). |
| implementation-plan §12 P9: *"Reject the configured integration branch/PR and any identified shared aggregation PR/ref for task, issue, review, continue, and `pr`"* | Reversed for task/issue/continue; kept for `pr <n>` when `<n>` *is* the standing PR (that case is `--until merged` on any run, not `pr`). |
| proposal §11: *"### Silently reinterpret bare commands — Rejected for v1"*; §8: *"only after telemetry and migration feedback. This is not part of v1 approval."*; implementation-plan §16 Phase D | Superseded by owner decision 9/16: bare = `--until ready` at v0.5.0. Risk accepted knowingly (§6). |
| proposal §8: *"retain `pr --merge` as a warning alias"* | Removed outright (clean break). |
| design §13.3 exit codes `0/2/1` | Replaced by `0/1/2/3/4/64` (§4.4). |
| design §15: *"MCP … must not expose merge authority in v1"* | Replaced by opt-in `automation.mcpMayMerge` (default off). |
| `FUTURE.md:10-14`: *"Model/effort-aware rotation pool — decided against on #323: `agents:` entries stay bare adapter names"* | Not contradicted: `agents:` stays bare names; `automation.rotateModels` is a separate, ordered escalation ladder the `rotate` remedy applies to the author/reviewer *model field* (owner remedy "stronger model", decision 7). Design §15 says so. |
| design §5/§5.1 execution broker / capability-isolated child | Not adopted in this programme (advisor decision): it is a large subsystem; v2 takes the smaller, verifiable step — an env allowlist for adapter subprocesses (P0) — and keeps controller-only landing. Left as future work. |

Reused with credit: failure taxonomy (design §7.1), bounded remedy pseudocode and
fingerprinting (§7.2), landing journal / resume-queries-truth-first (§11),
`LocalGreen` evidence bundle (§6.1), readiness predicate (§9), verify-on-base
(§10), telemetry list (§16), delivery rules (plan §1), fault-injection matrix
(plan §14), definition of done (plan §18), quota exclusion
(`idea-agent-quota-exclusion.md`), `--detach` registry approach
(`idea-detach-dashboard-visibility.md`, discover-only variant + a thin spawn),
convergent-failure detector (`headless-overnight-design.md` §3.5).

---

## 10. Open questions and decision ledger

Open (few, all advisor-proposed defaults, owner may override at any slice):

1. Should `landing: pr` (per-cycle PR to base) survive v0.5.0 at all? Kept here as
   an explicit opt-out; dropping it would simplify design §10/§11 further.
2. *(decided in design §7: n ≤ 3 per reply, ≤ 2×maxAttempts extra per run.)*
3. Whether `--until merged` on `pr <n>` for a foreign PR should require the PR to
   be non-draft (proposed: yes; drafts are "not ready" by definition).

Decision ledger (owner decisions, `scratchpad/decisions.md`, one row each):

| # | Decision | Where applied |
|---|---|---|
| 1 | Supersede `cli-simplification-*.md`; credit, disagree explicitly | §9 |
| 2 | Flag names were working names; better ones allowed | §4.2 |
| 3 | Loop bounded; mandatory cap = max attempts | §4.5 |
| 4 | Merge target = land on integrationBranch + merge standing PR | §4.2, design §10 |
| 5 | Clean break, v0.5.0, migration table | §4.1 |
| 6 | Headless surfaces to drop = advisor's call | §4.1 (banner, wizard, `update`) |
| 7 | Four remedies allowed | §4.5 |
| 8 | Deliverable = three docs + tracking issue | this set |
| 9 | Bare command == auto; a flag restores single pass | §4.2 (`once`) |
| 10 | No sacred commands | §4.1 |
| 11 | `pr <n>` both semantics; replaces `--merge` | §4.2, design §11 |
| 12 | v0.5.0; full audit | plan §6 |
| 13 | Config keys may fold/rename | §4.7, design §15 |
| 14 | Poller = auto default; MCP exposes outcome param | §4.6 |
| 15 | One more Q round before docs | done (decisions 16–23) |
| 16 | ONE flag `--until ready\|merged\|once`; bare = ready | §4.2 |
| 17 | Standing PR red for unrelated reasons → repair integration too | §4.2, design §10 |
| 18 | Ask-human: draft PR for task runs; issue for issue runs; write-access replies; 24 h | §4.5, design §8d |
| 19 | MCP `until` param; `merged` only with `automation.mcpMayMerge` | §4.6 |
| 20 | Command surface approved; dashboard/TUI untouched | §3, §4.1 |
| 21 | Defaults: maxAttempts 3, humanWait 24 h | §4.7 |
| 22 | Env allowlist for adapters = P0 | plan P0 |
| 23 | Integrate quota exclusion into rotate; `--detach` as headless flag; PLANNED.md no overlap | §4.5, §4.3 |

Advisor decisions (not owner's) are marked "(advisor decision)" in the design;
the summary list is in design §18.
