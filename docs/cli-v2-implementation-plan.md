# CLI v2 implementation plan — slices, tests, rollout, issue kit

**Status:** design-only, approved for planning, NOT implemented; supersedes
`docs/cli-simplification-*.md` (2026-08-16).
**Date:** 2026-08-17 (revised same day after two adversarial reviews)
**Author:** external advisor review (team-lead audit, 8 specialists + 4 verifiers)
**Revision:** 2026-08-17, after two adversarial reviews; "review impl-<id>" / "review fidelity-<id>" tags cite their finding ids; "lead decision" marks calls the team lead made on those findings.
**Reads first:** `docs/cli-v2-proposal.md` (contract), `docs/cli-v2-design.md`
(mechanics; glossary in its §0 — the same names are used here).
**Baseline:** commit `5879651` (v0.4.315), 2070/2070 tests green
(`node --test`, 4.7 s).

---

## 1. Delivery rules

1. **One slice = one GitHub issue = one orch cycle** (`orch issue <n>`); agent
   changes land on `orch/integration` and reach `main` only through the standing
   PR (repo rule, `CLAUDE.md` "Route agent changes through orch"). Slices that
   touch guardrail paths (`src/gate.js`, `src/notify.js`, `src/intake/**`,
   `package.json`, `.github/workflows/**` — `intake/allowlist.js:9-23`) escalate
   at `guardrail-touch` by design; run them with `--allow-protected`, review the
   staged branch, hand-merge to `orch/integration`, then `orch release "<entry>"`
   if `release.autoBump` is on (`.orch/ORCH.md`). Only two slices touch a
   protected path: P11 (`src/gate.js` timeout) and P12 (`package.json` version
   bump); no slice edits `src/notify.js` (its `kpi.json` streak metric is left
   alone — design §16).
2. Every slice lands green: `npm test` on Linux CI, plus the slice's new tests.
   Windows leg stays advisory (`ci.yml`, `continue-on-error: true`).
3. **No slice changes default behaviour before the cutover slice (P12)** — with
   this precise meaning: a command typed today keeps today's behaviour, output
   and exit code (the one exception being the exit-code corrections that are
   bug fixes, P1: unknown command 64, `--dry` honoured, invalid flag 64). New
   behaviour is reachable only by new flags/keys (`--until ready|merged`,
   `--max-attempts`, `--detach`, `--json`, `config --check`, `agent add
   --build`). `--until` defaults to `once` (strict parity, design §6) until P12
   flips it to `ready`. Removals, renames and the wizard swap happen only in
   P12. Removed config keys **warn** until P12 and **error** from P12
   (design §15).
4. Bug fixes discovered by the audit ship in the slice that touches that code
   (listed per slice) and reference the already-filed issue.
5. Tests lock the surface: `test/cli.test.js` (~3100 lines), `completion.test.js`,
   `config.test.js`, `config-wizard.test.js`, `github.test.js`, `mcp.test.js`,
   `docs.test.js` (README cross-check) will break broadly and predictably at the
   clean break. §4 schedules the migration so the suite is green after every
   slice.
6. Never weaken review/test/security/protected-path checks to make a scenario
   pass (prior plan §1 rule, kept).
7. Docs (README, `docs/orch-manual.md`, `.orch/ORCH.md`, `orch.example.yml`,
   completion, MCP schema) update **in the slice that changes the behaviour**,
   not at the end.
8. Every slice is **independently landable and demonstrable from the CLI**
   (review impl-M7): each acceptance list below names a command and an observable, not
   only unit fakes.
9. Teaching tone in issues/PRs (repo `CLAUDE.md`).

---

## 2. Dependency graph

```
P0 env allowlist ─────────────────────────────────────────────▶ P6 (adapter contract: envKeys + limitPattern live in the same files)
P1 schema/parser/exit codes/--dry/help ─┐
P2 run record ──────────────────────────┼─▶ P5 controller + readiness + `--until ready` (remedy-less) ─▶ P6 remedies: rebase, integration repair, rotate, lock scheme
P3 failure classes + chooser ───────────┤                                                              └▶ P7 remedies: reauthor, ask, continue fresh budget
P4 github.js primitives ────────────────┘                                                                   └▶ P8 `--until merged`
                                                                                                                 ├▶ P9 `pr <n|branch>`
                                                                                                                 └▶ P10 `--detach`
P11 config folds (warn) + `config --check` + gate timeout ───────────────────────────────────────────────────────┐
                                                                                                                 ▼
                                                                          P12 cutover (bare==ready, removals, docs, 0.5.0) ─▶ P13 telemetry + fault tests + release
```

Scheduling: P0 is a **prerequisite in time** (owner decision 22: ship it
first) and a code dependency of P6 (both edit `src/adapters/*`). P1–P4 are
independent of each other in *content*, but P0, P1 and P11 all edit `src/cli.js`
(review impl-m9) — run them **serially** (P0 → P1 → … ) to avoid three-way conflicts;
P2/P3/P4 touch disjoint files and may run in parallel with each other after P1.

---

## 3. Slices

Size: S ≤ 200 changed lines, M ≤ 600, L > 600 (excluding tests).

### P0 — Adapter env allowlist (security prerequisite) — **M**

**Goal.** No adapter subprocess receives `process.env`; it receives the
allowlisted env of design §14.1 (base set + per-adapter `envKeys` +
`env.passthrough` + adapter `env` overrides; never `GH_TOKEN`/`GITHUB_TOKEN`/
`GH_ENTERPRISE_TOKEN`/`ORCH_APP_*`). Closes **#502**.
**Files.** `src/adapters/cli-adapter.js:18-25` (`mergeAdapterEnv`), `:216-218`
(spawn env), `:454` (`makeCliAdapter` opts → `envKeys`); every
`src/adapters/*.js` declares `envKeys` per the design §14.1 table (`agy.js`
none; `zai.js:10-16` keeps its getter); `src/cli.js:1198-1211` (stop mutating
`process.env.GH_TOKEN`; keep the token in a closure passed to `ghShell`,
`cli.js:48-49`); `src/config.js` (new `env.passthrough`, regex + denylist);
`orch.example.yml`.
**New functions.** `buildAdapterEnv(adapter, runOpts, cfg) → object` (pure);
`ghEnv()` in `cli.js` returning `{...process.env, GH_TOKEN}` for gh spawns only.
**Verification step (review impl-B5).** Before merging: run each of the 10 adapters
once (`orch task "print hello" --author <agent> --reviewer <other>` in a
scratch repo) under the scrubbed env and record the keys each actually needed;
correct the design §14.1 table in the same PR (rows marked *verify*). Decide
copilot per design §14.1: `COPILOT_GITHUB_TOKEN` passthrough if the CLI honours
it, else HOME-based `copilot login` only — document the outcome in
`orch.example.yml`.
**Tests.** new `test/adapter-env.test.js`: base set present (incl.
`SSH_AUTH_SOCK`); `GH_TOKEN`/`GITHUB_TOKEN`/`GH_ENTERPRISE_TOKEN` absent even
when set in the parent; per-adapter table-driven test that each adapter's
`envKeys` survive; `passthrough: [GH_TOKEN]` rejected by `validate()`; `zai`
getter still yields `ANTHROPIC_AUTH_TOKEN`; `NODE_OPTIONS` dropped.
`test/adapters.test.js`: spawn stub asserts env shape. `test/cli.test.js`
App-token tests (grep `ORCH_APP_ID`): `gh` spawn env has the token, adapter
spawn env does not.
**Acceptance.** `env | grep -E 'GH_TOKEN|GITHUB_TOKEN'` inside a fake adapter
yields nothing; `gh auth status` inside orch still succeeds with an App token;
each real adapter still authenticates in the manual step; `npm test` green.
**Risk.** an adapter needing an undeclared key → `env.passthrough`; `config
--check` (P11) later warns about dropped keys. **Rollback.** revert.

### P1 — Command schema, parser, per-command validation, exit codes, `--dry` everywhere, help — **L**

**Goal.** Design §3: `SCHEMA`; parser wrapper; every flag validated per command
(64); unknown command → stderr + 64; numeric validation; `--dry` honoured or
rejected on every command; help + completion from `SCHEMA`; exit codes 3/64
wired for today's paths (concurrency-cap → 3; escalated/deferred → 2; `pr`
not-approved → 2). Adds, accepted but inert until later slices: `--until`
(default `once`; `ready|merged` → 64 "not yet available"), `--max-attempts`,
global `--json` (minimal `run.end` event), `agent add --build` (delegates to
today's `buildAgent`). Also fixes `--refresh-ms` NaN (cli #5) and `--cheap` on
build (cli #7). Closes **#497, #498, #499, #500**; part of **#501**.
**Files.** new `src/schema.js`; `src/cli.js:390-425` (`PARSE_OPTIONS`/`parse` →
wrapper), `:1156-1169` (generalised guard), `:1093,1491,1514,1712,1736` (exit
codes), `:1721-1741` (`pr` reads `flags.dry` → dry deps), `:1278-1309` (`agent
add` threads `config-file` + `dry`; `configPath(dir, override)` in
`config.js:164`), `:1786-1800` (`release --dry`), `:1223-1250` (`init --dry`),
`:1804` (unknown → 64), `:1806-1860` (`printUsage` from schema);
`src/completion.js`; `bin/orch.js` (map `UsageError` → 64, `BlockedError` → 3).
**Test harness (review impl-m2).** new `test/helpers/fake-gh.js`: a scripted `gh`
double `mkGh(script)` returning canned stdout / thrown errors with `HTTP <code>`
in `message` (mirroring `execFileSync`), recording every call — used by P1
(`--dry` on `pr` = zero gh writes) and by P4–P9.
**`--dry` and records (review impl-m3).** `--dry` writes **no** run record and no
`.orch/` state (today's `dryDeps()`, `cli.js:809-825`); the only exception is
today's documented one (an escalation still writes `DECISION.md`).
**Tests.** `test/schema.test.js` (matrix from schema); `test/cli.test.js`
(usage text, `--merge` guard message → generic, `--dry` on `pr`/`agent
add`/`release`/`init` with the fake gh/git asserting zero writes, unknown
command 64, `--refresh-ms abc` → 64); `test/completion.test.js` → consumes
schema; `test/docs.test.js` README flag list.
**Acceptance.** `orch tsk x; echo $?` → 64, usage on stderr; `orch issue 1
--file f` → 64; `orch pr 1 --dry` → fake gh recorded zero writes; `orch pr 1
--until ready` → 64 "not yet available". **Risk.** `cli.test.js` churn — one
cycle. **Rollback.** revert. **Protected.** none.

### P2 — Durable run record + lineage + lookup — **M**

**Goal.** Design §5: `.orch/run-records/<runId>.json`, `RunRecord` v1
(`retries`, `headMovedRepins`, `merge.requests[]` ordinals, `human.askCommentId`,
`interrupted`), lookup by runId or cycle sid, `continue` resolves records first
and, for a terminal `stopped-at-cap`/`wait-timeout` record, clears
`outcome`/`exit` and grants a fresh attempt budget (§5.3 — inert until P5 uses
`maxAttempts`). Every non-dry run writes a record; dashboard unaffected.
**Files.** new `src/run-record.js`; `src/cli.js:1312-1521` (write record around
`runCycle`), `:1544-1717` (`continue` lookup order); `finalize.js`/`engine.js:69-75`
callers pass extra `runs.jsonl` fields (additive; `notify.js` untouched).
**New functions.** plan §9. **Tests.** `test/run-record.test.js`:
create/update/lookup, atomic write survives simulated crash, lookup by cycle
sid, schemaVersion check, resume-terminal clears outcome and sets
`maxAttempts := attempt + n`; `test/cli.test.js`: a run leaves a record with
`outcome`; `continue <runId>` and `<sid>` resolve.
**Acceptance.** after `orch task x` (fake deps) `.orch/run-records/<sid>.json`
exists with `outcome`; `orch task x --dry` writes none. **Risk.** low.

### P3 — Structured failure classes + fingerprint + chooser; fix round drift — **M**

**Goal.** Design §6 mapping + §7 classifier/fingerprint (class + normalized
summary only)/chooser incl. free-retry caps and MA9 rows, as pure functions;
`runCycle`/`finalize` results carry `class`. Fixes **#506** (`stage:"revising"`
checkpoint with the new round right after the revise commit,
`engine.js:384-386`; `engine.js` not protected).
**Files.** new `src/failure.js`; `src/engine.js:369-386`, `:158-381` (additive
`class` on each escalate); `src/finalize.js` demote paths (trigger → class).
**Tests.** `test/failure.test.js`: 19 mapping rows + 13 remote/human/internal
classes, fingerprint equal across different trees with same findings, chooser
table incl. convergence, free-retry caps, `retry n` per-reply and per-run
ceilings; `test/engine.test.js`: with `roundCap: 3`, crash after revise 1 →
resume at round 2 → escalates after round 3, not 4. **Protected.** none.

### P4 — `github.js` primitives (read/write, idempotent, un-swallowed) — **M**

**Goal.** Design §9 primitive list, all synchronous over `execFileSync` (impl
m4), HTTP status parsed from the thrown error's `message`/`stderr` (`HTTP
<code>`), never message-text branching. `pushAndCreatePr` (`github.js:265-278`)
→ `findPrByHead` first (**#503**); `tryMergeDirect` (`github.js:66-75`) callers
→ `mergePrHeadBound` (**#504**); `runPr` comment (`github.js:203`) →
`commentOnce`. `collaboratorPermission` returns `{permission, roleName}` from
`{permission, role_name}`; `listComments` uses `--paginate`; `requiredChecks`
reads the rules array (`type == "required_status_checks"`) then classic
protection, `known:false` on 403.
**Files.** `src/github.js` (new exports; `mergeDirect` kept as transport);
`src/cli.js:1874-1881` (`githubDeps` shape unchanged).
**Tests.** `test/github.test.js` with `fake-gh.js`: find-or-create returns
existing PR; `commentOnce` edits when marker exists; `mergePrHeadBound` maps
200/409/405/401/403/500 by status only; `demote` twice → one PR; permission
`role_name: maintain` + `permission: write` → accepted; 403 → `{ok:false}`;
`requiredChecks` for rules array / classic / 403 / 404.
**Acceptance (fields to verify at P4 against the live API, review impl-M2/M4).**
`GET /repos/{o}/{r}/collaborators/{u}/permission` → `{permission, role_name,
user}`; `GET /repos/{o}/{r}/rules/branches/{b}` → array with `type` and
`parameters.required_status_checks[].context`; `GET
/repos/{o}/{r}/branches/{b}/protection` → `required_status_checks.contexts`;
`gh pr view --json` fields `mergeable mergeStateStatus reviewDecision
statusCheckRollup isCrossRepository maintainerCanModify headRepositoryOwner`;
`gh api` stderr format `gh: <message> (HTTP <code>)`. Each verified value is
recorded in the PR description. **Protected.** none.

### P5 — Run controller + readiness inspector + `--until ready` (remedy-less) — **M**

**Goal.** Design §6 machine and §9 inspector, wired so `--until ready|merged`
become *available* (still not default): `runUntil(policy, record, deps)` drives
`CYCLING → LANDED → READINESS → READY (0)`; any classified failure with no
remedy available (all remedies ship in P6/P7, so in P5 `policy.remedies` is
forced empty) → `STOPPED_AT_CAP` (2) / `BLOCKED` (3) with `blockedReason`;
`ciWaitMinutes` bounds each wait and an expiry consumes an attempt; `once`
parity path formalised (no readiness read); `--json` events; `merged` is
accepted but stops at `READINESS` with "merge phase ships in P8" (exit 2) —
stated in `--help` until P8. Also updates `prChecksGreen` callers to the §9
rule 4 predicate.
**Files.** new `src/run-controller.js`, `src/readiness.js`; `src/cli.js` run
commands call `runUntil` when `until !== "once"`; `src/github.js` (rule 4).
**Tests.** `test/readiness.test.js` (fixtures per `mergeStateStatus`, checks,
`reviewDecision`, draft, closed, external merge, head-moved-still-ancestor,
empty rollup × required known-empty/known-nonempty/unknown);
`test/run-controller.test.js` (transitions with scripted cycle results, wait
expiry consumes an attempt, re-pin cap); `test/cli.test.js` happy path.
**Acceptance (CLI-observable).** In a tmp repo with a fake remote and fake gh:
`orch task "x" --until ready --json | tail -1 | jq .exit` → `0` when the fake
standing PR is green; → `2` with `failureClass:"REMOTE_BEHIND"` when it is
`BEHIND` (no remedy yet); `orch task "x"` (bare) still behaves exactly as today.

### P6 — Remedies part 1: `rebase` (task branch), integration repair (§10A), `rotate` (quota exclusion), lock scheme (§12) — **L**

**Goal.** Design §8a, §8b, §10A, §12 (lock scheme incl. the
`standing-pr.lock → merge.lock` order and the non-blocking
`integration-repair.lock`; `merge.lock` alone is what P6 exercises, but the
order rule and the lock helper land here so P8 only adds its phase). Adapter contract gains `limitPattern`
(both seats classify; `cli-adapter.js:304`); in-run agent exclusion, diverse
rotation, `automation.rotateModels`; `rotate` starts a **new cycle at round 1
with cleared checkpoint and `reviewerOverride`** (review impl-B1); integration repair
in a scratch worktree with `merge.lock` only around the ff/push, local gate
re-run after `updateBranch`; `releaseLock` ownership check; `agent add --build`
scaffolds `limitPattern`/`envKeys` placeholders.
**Files.** new `src/remedies/rebase.js`, `src/remedies/rotate.js`,
`src/integration-repair.js` (from `resolveIntegrationConflict`, `cli.js:680`);
`src/adapters/cli-adapter.js`, `src/adapters/*.js` (`limitPattern` where
known); `src/cli.js:494-535` (`nextAuthor` exclusion-aware); `src/git.js` (use
`rebaseBranchOnto(repo, orchDir, branch, onto, expectedSha)`, `git.js:420`;
add `scratchWorktree()`); `src/lock.js:50-52`.
**Tests.** `test/remedies.test.js`: CAS abort, non-diverse rotate skipped,
quota on author seat → `AGENT_QUOTA` → next agent, integration repair paths
(BEHIND → update-branch → local gate; CONFLICTING → resolver → gate+scan(+audit)
→ ff → push), `integration-repair.lock` loser polls instead of spawning a
resolver, lock order and release-in-finally (fake lock records order);
`test/lock.test.js`: release by non-owner is a no-op.
**Acceptance (CLI-observable).** fake standing PR `BEHIND` + `orch task "x"
--until ready` → `0` after one repair; pool `[a,b,c]`, author `a` quota → next
cycle `b`/`c`; stalemate at `roundCap: 3` → `rotate` → new cycle logs 3 fresh
rounds; identical fingerprint twice → next remedy.

### P7 — Remedies part 2: `reauthor`, `ask` (draft PR, permission, polling, exit 4), `continue` fresh budget — **M**

**Goal.** Design §8c (no split), §8d, §5.3 resume of terminal runs.
**Files.** new `src/remedies/reauthor.js`, `src/remedies/ask.js`; `src/cli.js`
(`continue` → controller). **Tests.** `test/remedies.test.js` (ask template +
marker, reply parsing, permission gating incl. `role_name`, 403 → BLOCKED,
pagination cursor, backoff, timeout → 4, late reply on resume, `retry n`
ceilings), `test/cli.test.js` (`continue <runId>` after exit 2 proceeds with a
fresh budget).
**Acceptance (CLI-observable).** fake gh with a stalemate and no reply → exit
4 with resume command; reply `orch: retry` from a write user → run resumes;
`orch continue <runId>` after exit 2 → `run.resume` event, new attempts.

### P8 — `--until merged`: standing-PR merge, head-bound, verified — **M**

**Goal.** Design §10.4–10.8 + §12 `standing-pr.lock`: the whole merge phase
under `standing-pr.lock` — final readiness read (may re-pin), then, when the
repo has no required checks, `reconcileIntegrationToOrigin` + local gate at
exactly that SHA under nested `merge.lock`, a re-pin invalidating any prior gate
result,
`PUT …/merge {merge_method:"merge", sha}`, status-only 405 handling (re-read →
`REMOTE_REVIEW_REQUIRED` → ask), re-pin cap, verify by ancestry, ff local base,
tidy non-interactive, `landing: pr` variant, `integrationBranch == baseBranch`.
`main.autoMerge`/`github.autoMergePr` paths in `openIntegrationPr`
(`github.js:440-442`, `482-490`) bypassed when a v2 run is active (removed P12).
**Files.** new `src/landing.js`; `src/github.js`; `src/finalize.js:237-279`
(`integrationSha` already computed). **Tests.** `test/landing.test.js` with a
fake `gh` that really merges in the fixture's **bare remote** (so the ancestry
proof is honest): 200 → verify → 0; 409 → re-check → 0; 405 review → ask; two
controllers racing (sequential fake) → one merge; no required checks → local
gate ran on the exact SHA that was merged (fixture: peer lands Z between the
first gate and the in-lock re-read → gate re-runs on Z or falls back to §10.2;
never merges Z on X's gate); a push after readiness invalidates it.
**Acceptance (CLI-observable).** `orch task "x" --until merged --json | jq -r
'select(.event=="merge.verified")'` prints one event; `git merge-base
--is-ancestor <mergeCommit> origin/main` true in the fixture.

### P9 — `pr <number|branch>` unification — **M**

**Goal.** Design §11; `orch_pr` MCP tool (replaces `orch_review`, old kept until
P12); `review` command delegates. Push authority per review impl-M8
(`isCrossRepository == false` **and** orch-owned branch namespace **and**
`viewerPermission().push`); adds the CI/mergeability check `runPr` lacks
(**#508**). **Files.** `src/github.js:163-247` (`runPr` → v2),
`src/cli.js:1721-1741`, `src/mcp.js:80-148` (`orch_pr` with `until`,
`mcpMayMerge` gate). **Tests.** `test/github.test.js` (no merge when checks
pending; colleague's same-repo branch → repair branch, no push),
`test/mcp.test.js` (`orch_pr` argv; `until:"merged"` rejected by default),
`test/cli.test.js` (`pr <branch>` resolves local branch).
**Acceptance (CLI-observable).** fake PR with one pending check + `--until
merged` → waits then merges only after green; fork PR → `pr/repair/<n>-<runId>`
created, no foreign push. Closes #508.

### P10 — `--detach` — **S**

**Goal.** Design §13 lifecycle: detached spawn to a log file, parent waits ≤ 5 s
and propagates an early child exit (with log tail) or prints `run.detached`;
child registers inflight (`detached, log, runId`), SIGTERM handler marks the
record `interrupted` and releases locks; no rotation; no attach/kill commands.
**Files.** `src/cli.js` (early in `main`), `src/inflight.js:16-18` (optional
fields), `src/run-controller.js` (signal handler). **Tests.** `test/cli.test.js`
with `spawn` stub: argv minus `--detach`, env `ORCH_DETACHED`, log path pattern,
early-exit propagation; `test/inflight.test.js` extra fields; `test/dashboard.test.js`
read-only: a live inflight record with extra fields still renders.
**Acceptance.** `orch task x --detach --json` prints `run.detached` within 5 s
and exits 0; `orch tsk x --detach` exits 64 (child's code) with the log tail.

### P11 — Config v2 (warn mode), `config --check`/`--json`, `gateTimeout` — **M**

**Goal.** Design §15: `automation.*`, `landing`, `gateTimeout`, `env.passthrough`
(from P0), `test`/`author` type checks (config #1/#2), closed schema — but
**removed/renamed keys only warn** in this slice (rule 3), including `merge:` and
`main.*`, whose old semantics keep working until P12. `orch config` **without
flags keeps launching the wizard** (rule 3); `orch config --check` and `orch
config --json` are the new non-interactive paths; `init` writes the commented
example. `gate.run` timeout = `gateTimeout` (**#505**; `src/gate.js` is
protected → `--allow-protected`, hand-land).
**Files.** `src/config.js:6-53`, `:57-114`, `:164`; `src/cli.js:1252-1260`
(config command: flags → non-interactive), `:1223-1250` (init template);
`src/gate.js:53-58`; `orch.example.yml`; `docs/orch-manual.md` Part 5.
**Tests.** `test/config.test.js` (new keys, warnings for old keys, closed
schema, `test` string check), `test/config-command.test.js` (`--check` exit
codes, `--json` shape), `test/gate.test.js` (timeout → `pass:false`, "gate timed
out"), `test/conflict-resolution.test.js` (renamed keys accepted, old warn);
`config-wizard.test.js` untouched.
**Acceptance.** a v0.4 `orch.yml` with `main.autoMerge: true` → `orch config
--check` exit 0 with a warning naming `--until merged`; `orch config` still opens
the wizard on a TTY. **Protected.** `src/gate.js` (hand-land).

### P12 — Cutover to v0.5.0 — **L (mostly deletions + docs)**

**Goal.** Bare run command == `--until ready`; remove `review`, `agent build`,
`update`, `--merge`, `--pr`, `--no-banner`, banner code, wizard (`config` becomes
the printer/validator by default), `main.*`, `github.autoMergePr`, `merge:`
acceptance (rename enforced), `reviseCap`; removed keys → **errors** with the
design §15 messages; MCP tool table (`orch_review` removed → JSON-RPC
`-32601 … use orch_pr`, `until` on all cycle tools); README (incl. the MCP
authority sentence), manual, ORCH.md, example yml, completion, CHANGELOG,
`docs/MIGRATION-0.5.md` (proposal §4.1 table incl. MCP rows); `package.json`
version `0.5.0` (**protected** → hand-land). Poller (outside repo): whitelist
`--until once|ready`, default `--until ready` (separate PR).
**Tests.** delete `config-wizard.test.js`; update `cli.test.js` (removed
commands → 64, bare == ready), `mcp.test.js`, `docs.test.js`,
`completion.test.js`, `config.test.js` (warn → error); + `test/migration.test.js`
(every migration-table row → 64 with the new spelling in the message).
**Acceptance.** `orch review x` → 64 "use `orch pr x --until once`"; `orch task
x` (fake deps) runs the ready loop; README no longer promises "no way to emit
--merge". **Risk.** L; schedule with no other cycles in flight. **Rollback.**
`npm i -g @bbk1ng/agent-orch@0.4.<last>`.

### P13 — Telemetry, fault-injection suite, release — **M**

**Goal.** Design §16 `runs.jsonl` fields; redrive `quietFail` lines
(`finalize.js:195,209`, not protected — note this resets the `kpi.json` streak
where nothing was written before, design §16); design §17 fault matrix as
`test/v2-faults.test.js`; system tests; the **success-metric audit script**
(`scripts/v2-metrics.mjs`, reads `.orch/run-records/*.json` + `runs.jsonl`:
clean-unattended = `outcome == "reached" && human.replies.length == 0`; false
ready/merged = exit 0 without a readiness observation / ancestry proof); tag
`v0.5.0`, npm publish via the tag workflow (hand-tag if the history touches
`.github/workflows`).
**Acceptance.** all matrix rows green; the metrics script reports > 0 clean
unattended runs on the fixture set; release published. `notify.js` untouched.

Audit defects fixed en passant (issue → slice): #497 P1 · #498 P1 · #499 P1 ·
#500 P1 · #501 P1/P5 · #502 P0 · #503 P4 · #504 P4 · #505 P11 · #506 P3 ·
#508 P9 · engine H3 (quietFail) P13 · engine H5 (releaseLock) P6 · config #1/#2
P11 · cli #5 (`--refresh-ms` NaN) P1 · cli #7 (`--cheap` on build) P1. **Not**
in scope: #507 (dashboard `authored` label — dashboard untouched).

---

## 4. Test migration plan

| Slice | Test files changed | Keep-green tactic |
|---|---|---|
| P0 | + `adapter-env.test.js`; `adapters.test.js`, `cli.test.js` (App-token block) | fake spawn captures env; per-adapter table |
| P1 | + `schema.test.js`, `helpers/fake-gh.js`; `cli.test.js` (usage text, `--merge` guard message, exit codes, `--dry` on 4 commands, unknown cmd), `completion.test.js` (schema-driven), `docs.test.js` | keep old assertions where behaviour is unchanged; message changes updated in the same PR |
| P2 | + `run-record.test.js`; `cli.test.js` | additive |
| P3 | + `failure.test.js`; `engine.test.js`, `finalize.test.js` (additive `class`) | additive |
| P4 | `github.test.js` (fake-gh scripting), `finalize.test.js` | additive; old `openIntegrationPr` tests kept |
| P5 | + `readiness.test.js`, `run-controller.test.js`; `cli.test.js` (`--until ready` happy path); `github.test.js` (rule 4 predicate) | `--until` explicit only; bare-command tests untouched |
| P6 | + `remedies.test.js`; `adapters.test.js` (limitPattern), `lock.test.js`, `conflict-resolution.test.js` (function moved → thin alias until P12) | new files mostly |
| P7 | `remedies.test.js`, `cli.test.js` (`continue` fresh budget) | additive |
| P8 | + `landing.test.js`; `github.test.js` | additive |
| P9 | `github.test.js` (`runPr`), `mcp.test.js` (`orch_pr` added, `orch_review` still present), `cli.test.js` | additive |
| P10 | `cli.test.js`, `inflight.test.js`, `dashboard.test.js` (read-only) | additive |
| P11 | `config.test.js` (dense), + `config-command.test.js`, `gate.test.js`, `conflict-resolution.test.js` | old keys warn, so old key tests pass with a warning assertion added; wizard tests untouched |
| P12 | delete `config-wizard.test.js`; `cli.test.js` (removed commands → 64, bare == ready), `mcp.test.js`, `docs.test.js`, `completion.test.js`, `config.test.js`; + `migration.test.js` | one PR; full suite locally first |
| P13 | + `v2-faults.test.js`, `system-v2.test.js` | additive |

Between slices the suite is always green because every removal and default
flip is deferred to P12 and every earlier slice is additive or message-only.

---

## 5. Verification commands per slice

```
# all slices
npm test                                            # 2070 + new, 0 fail
node --test test/<new-file>.test.js                 # the slice's own file
git merge-base --is-ancestor origin/orch/integration origin/main   # after each hand-land (repo rule)

# P0
GH_TOKEN=secret node -e 'import("./src/adapters/cli-adapter.js").then(m=>console.log("GH_TOKEN" in m.buildAdapterEnv({envKeys:[]},{}, {env:{passthrough:[]}})))'   # false
# P1
node bin/orch.js tsk x; echo $?                     # 64, usage on stderr
node bin/orch.js issue 1 --file f; echo $?          # 64
node bin/orch.js pr 1 --dry --json                  # zero gh writes (test/helpers/fake-gh.js via ORCH_TEST_DEPS in cli.test.js; manual: fake `gh` on PATH)
node bin/orch.js --help | diff - <(node -e 'import("./src/schema.js").then(m=>process.stdout.write(m.renderHelp()))')  # empty
# P2
node bin/orch.js task "x" --dry; ls .orch/run-records/   # empty (dry writes no record); a non-dry fake run writes one
# P5
node bin/orch.js task "x" --until ready --json | tail -1 | jq .exit    # 0 in fixture repo (green fake PR); 2 with failureClass REMOTE_BEHIND (no remedies yet)
# P6
node bin/orch.js task "x" --until ready --json | jq -r 'select(.event=="remedy")'   # integration repair applied on a BEHIND fixture
# P8
node bin/orch.js task "x" --until merged --json | jq -r 'select(.event=="merge.verified")'
# P10
node bin/orch.js task "x" --detach --json; node bin/orch.js dashboard --once --json | jq '.live[0].detached'   # true
# P11
node bin/orch.js config --check; echo $?            # 0 with warnings on a v0.4 file (errors only from P12)
# P12
node bin/orch.js review x; echo $?                  # 64 with the new spelling
node bin/orch.js version                            # 0.5.0
```

---

## 6. Rollout

- **Single trunk (owner decision, 2026-08-17).** No long-lived `v0.5`/`dev`
  branch. A second trunk would need its own integration branch, standing PR,
  poller routing and constant backports of 0.4.x fixes; the additive slices
  below already give a beta period without that cost. The "beta" *is*
  `--until ready|merged` opt-in on 0.4.x; pace the slice issues as slowly as
  wanted, and cutover (P12) waits for the evidence gate. Optional cosmetic
  label: bump `package.json` to `0.5.0-beta.N` when P5 lands (first usable
  `--until ready`); npm `next` dist-tag publishing is **not** assumed — check
  the trusted-publishing workflow first if it is wanted.
- **Pre-cutover (0.4.x):** P0–P11 ship as normal orch cycles → `orch/integration`
  → standing PR → `main`, each bumping 0.4.x per `release.autoBump`. New
  behaviour is reachable only by explicit opt-in (`--until ready|merged`,
  `--max-attempts`, `--detach`, `--json`, `config --check`, `agent add --build`);
  no env flag or config switch is introduced (advisor decision: an explicit flag
  *is* the opt-in; a second switch would create a third behaviour mode). Exit
  codes for existing invocations change only where P1 fixes a bug (unknown
  command 64, invalid flag 64, concurrency-cap 3).
- **Evidence gate before P12** (softened from prior plan §16 numbers, which
  were sized for the dedicated-PR mechanism): ≥ 10 `--until ready` runs and
  ≥ 3 `--until merged` runs on this repo with zero false-ready/false-merged
  (P13's metrics script), and the fault matrix green. Owner may waive
  (decision 9 accepted the risk).
- **Cutover:** P12 lands as one cycle; version `0.5.0`; tag; npm publish;
  `docs/MIGRATION-0.5.md` linked from README and CHANGELOG. Poller updated the
  same day.
- **Rollback:** `npm i -g @bbk1ng/agent-orch@0.4.<last>`; run records under
  `.orch/run-records/` are ignored by 0.4.x; 0.4.x does not reject unknown keys
  (closed schema is v2), so a v2 config loads with defaults for the new keys —
  the renamed `landing:` must be renamed back to `merge:` by hand (documented in
  the migration guide).

---

## 7. Definition of done (programme)

1. All slices merged to `main`; version `0.5.0` published; `npm test` green on
   Linux CI with ≥ 2070 + new tests; Windows advisory leg not worse than today.
2. `orch --help` matches design §3 schema; `orch tsk` → 64; every migration-table
   row (CLI and MCP) → 64 / JSON-RPC error with the new spelling.
3. Bare `orch task|issue|pr|continue` == `--until ready`; `--until merged` merges
   the standing PR head-bound after exact-head readiness and verifies by
   ancestry; `--until once` is today's single pass with the new exit codes only.
4. Adapter subprocess env never contains `GH_TOKEN`/`GITHUB_TOKEN`/
   `GH_ENTERPRISE_TOKEN` (test + manual check); every shipped adapter still
   authenticates (P0 manual step recorded).
5. Fault matrix (design §17) green; zero duplicate remote side effects.
6. Success metrics (proposal §7) via P13's script: clean unattended runs > 0
   within 20 runs; ≥ 60% of `ready` runs exit 0 unattended over the first 50;
   every exit 2 has a resume command; every exit 3 a `blockedReason`.
7. README, manual, ORCH.md, example yml, completion, MCP schema describe v2
   only; prior `cli-simplification-*.md` carry a "superseded by" header (owner
   decision 1; docs-only owner PR).
8. Tracking issue closed with links to all slice issues.

---

## 8. Issue drafting kit

Audit-derived defect issues already exist: #497 #498 #499 #500 #501 #502 #503
#504 #505 #506 #507 #508 — do not re-file; slices reference them. Slice issues
below are ready to paste (`gh issue create --title "…" --body-file -`). Numbers
`#TBD` are filled when created; the tracking issue lists them all.

### Tracking issue

**Filed:** [#509](https://github.com/bbk1ng/agent-orch/issues/509) (2026-08-17).
**Title:** `CLI v2 (v0.5.0): --until ready|merged|once, bounded loop, headless-first — tracking`
**Body:**
> This tracks the CLI overhaul designed in `docs/cli-v2-proposal.md`,
> `docs/cli-v2-design.md`, `docs/cli-v2-implementation-plan.md` (2026-08-17,
> supersedes `docs/cli-simplification-*.md`).
> **Why:** today orch stops at the first stalemate/demotion and a human must
> re-run; zero clean unattended cycles in 332 runs. v2 gives every run command
> one outcome flag (`--until`), a bounded remedy loop, distinct exit codes,
> per-command flag validation, and removes orch's token and the ambient env
> from adapter subprocesses (#502).
> **Slices (one issue each, one orch cycle each):** P0 #TBD · P1 #TBD · P2 #TBD
> · P3 #TBD · P4 #TBD · P5 #TBD · P6 #TBD · P7 #TBD · P8 #TBD · P9 #TBD · P10
> #TBD · P11 #TBD · P12 #TBD · P13 #TBD.
> **Defects fixed on the way:** #497 #498 #499 #500 #501 #502 #503 #504 #505
> #506 #508.
> **Done when:** plan §7.

### P0 — `Adapter subprocesses must receive an allowlisted env, never process.env`
> **What:** `src/adapters/cli-adapter.js:218` spawns every author/reviewer CLI
> with the parent's full `process.env`; `src/cli.js:1205-1211` puts a repo-scoped
> App token in `process.env.GH_TOKEN`. An author agent running an untrusted work
> order can `printenv` and exfiltrate it — and the diff-based security floor
> never sees it, because nothing lands in the diff (see #502).
> **Do:** implement design §14.1 verbatim: `buildAdapterEnv(adapter, runOpts,
> cfg)` = base set (`PATH HOME USER LOGNAME SHELL LANG LC_* TERM TMPDIR TMP TEMP
> TZ XDG_* SSL_CERT_* *_PROXY SSH_AUTH_SOCK GIT_AUTHOR_* GIT_COMMITTER_* ORCH_*`)
> + the adapter's declared `envKeys` (table in design §14.1; every adapter file
> declares its own) + `env.passthrough` from `orch.yml` (never `GH_TOKEN`,
> `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `ORCH_APP_*`) + the adapter's `env`
> overrides. Pass the gh token only to `ghShell` spawns. Before merging, run each
> of the 10 adapters once under the scrubbed env and correct the table; decide
> copilot (`COPILOT_GITHUB_TOKEN` or HOME-based login — never `GH_TOKEN`).
> **Accept:** new `test/adapter-env.test.js` incl. a per-adapter table; `GH_TOKEN`
> set in the parent is absent in the adapter spawn env and present in the `gh`
> spawn env; every adapter authenticates in the manual step; `npm test` green.
> Design: `docs/cli-v2-design.md` §14.1. Closes #502.

### P1 — `Command schema: per-command flag validation, exit 64, --dry everywhere, generated help`
> **What:** flags are declared once (`cli.js:392-416`) but read ad hoc per
> command, so `--dry` is ignored by `pr` (a real merge can happen, #497),
> `agent add` ignores `--config-file` (#498), a typo'd command exits 0 (#499),
> only `--merge` is cross-validated (#500), and exit 2 means five things (#501).
> **Do:** `src/schema.js` (design §3); a parser wrapper that rejects
> unknown/out-of-scope flags and unknown commands with **exit 64** (usage to
> stderr); numeric validation; `--dry` honoured on every mutating command and
> rejected on read-only ones; help and completion rendered from the schema; exit
> codes 3 (concurrency cap) and 64 wired; `--until` (default `once`;
> `ready|merged` rejected "not yet available"), `--max-attempts`, global
> `--json`, `agent add --build` accepted; `test/helpers/fake-gh.js` scripted
> double. No default behaviour changes beyond these bug fixes.
> **Accept:** `orch tsk x` → 64; `orch issue 1 --file f` → 64; `orch pr 1 --dry`
> performs zero gh writes (fake gh records calls); `test/schema.test.js` matrix;
> `completion.test.js` consumes the schema. Closes #497 #498 #499 #500; part of #501.

### P2 — `Durable run record (.orch/run-records/<runId>.json) with lineage and resume-with-fresh-budget`
> **What:** checkpoint/resume are cleared on every terminal return
> (`cli.js:1506-1509`, `1684-1693`), so `orch continue` cannot revisit an
> escalated cycle and nothing persists attempts, remedies, or the merge ordinal.
> **Do:** `src/run-record.js` per design §5 (schema v1, atomic writes, lookup by
> runId or cycle sid; `continue` on a `stopped-at-cap`/`wait-timeout` record
> clears `outcome`/`exit` and sets `maxAttempts := attempt + n`); every non-dry
> run writes one; `--dry` writes none. Checkpoint semantics unchanged.
> **Accept:** `test/run-record.test.js`; after any run a record with `outcome`
> exists; `orch continue <runId>` and `<sid>` resolve to it.

### P3 — `Structured failure classes, fingerprints, remedy chooser; fix round drift`
> **What:** outcomes are free-text reasons; a loop needs classes. Also
> `engine.js:384-386` increments `round` after the revise commit without a
> checkpoint, so a crash there under-counts rounds on resume (#506).
> **Do:** `src/failure.js`: `classify()` mapping every escalate/demote trigger
> (design §6 table) to a class, `fingerprint()` over class + normalized summary
> only, `chooseRemedy()` (design §7 table incl. free-retry caps, convergence,
> `retry n` ceilings); attach `class` to cycle results; write a
> `stage:"revising"` checkpoint with the new round right after the revise commit.
> **Accept:** `test/failure.test.js`; `engine.test.js`: with `roundCap: 3`, crash
> after revise 1 → resume at round 2 → escalates after round 3, not 4. Closes #506.

### P4 — `github.js: idempotent PR create, marker comments, head-bound merge with un-swallowed errors, read primitives`
> **What:** `pushAndCreatePr` (`github.js:265-278`) creates unconditionally —
> a second call throws and kills the process (#503); `tryMergeDirect`
> (`github.js:66-75`) swallows 401/403 (#504); there is no way to read PR
> comments, reviews, required checks, or collaborator permission.
> **Do:** add the design §9 primitives, synchronous over `execFileSync`, HTTP
> status parsed from the thrown error (`HTTP <code>`), never message-text
> branching: `prView`, `listComments` (`--paginate`), `collaboratorPermission`
> (`permission` + `role_name`), `requiredChecks` (rules array →
> `required_status_checks`, then classic protection, `known:false` on 403),
> `findPrByHead`, `createPr` (find-or-create), `commentOnce(marker)`,
> `mergePrHeadBound` → `{merged|head-moved|blocked|rejected|not-found}`,
> `updateBranch`, `viewerPermission`; route `demote`/`openPr`/`runPr` through
> them. Record the live API field shapes you verified in the PR description.
> **Accept:** `github.test.js`: `openPr` twice → one `pr create`; merge result
> mapping for 200/409/405/401/403/500; `runPr` comment edited in place. Closes
> #503 #504.

### P5 — `Run controller + readiness inspector + --until ready (remedy-less)`
> **What:** design §6 + §9. **Do:** `src/run-controller.js` (`runUntil`),
> `src/readiness.js` (`inspect`, `waitReady` with backoff and `ciWaitMinutes`;
> each expiry consumes an attempt), exit codes 0/2/3 with `blockedReason`,
> `--json` events; `--until ready|merged` become available (not default;
> `merged` stops at readiness until P8, stated in `--help`); `once` = strict
> parity (no readiness read); update `prChecksGreen` callers to the §9 rule 4
> predicate.
> **Accept:** `readiness.test.js`, `run-controller.test.js`; in a fixture repo
> `orch task "x" --until ready --json` exits 0 on a green fake standing PR and 2
> with `failureClass:"REMOTE_BEHIND"` on a `BEHIND` one; bare `orch task "x"`
> unchanged.

### P6 — `Remedies 1: rebase+repair, integration repair, rotate with quota exclusion, lock scheme`
> **What:** design §8a, §8b, §10A, §12. **Do:** adapter `limitPattern` on both
> seats; in-run exclusion + diverse rotation + `automation.rotateModels`;
> `rotate` starts a new cycle at round 1 with a cleared checkpoint and
> `reviewerOverride`; `rebase` via `rebaseBranchOnto(repo, orchDir, branch,
> onto, expectedSha)`; integration repair (update-branch → local gate;
> conflicts → resolver in a scratch worktree → gate + scan (+ audit) → ff under
> `merge.lock` → push) under `ready` and `merged`; `merge.lock` guards only the
> git write, agent work holds only the non-blocking `integration-repair.lock`
> (a loser polls readiness instead of spawning a resolver); lock order
> `standing-pr.lock → merge.lock`; `releaseLock` ownership check; `agent add
> --build` scaffolds `limitPattern`/`envKeys`.
> **Accept:** `remedies.test.js`; fixture standing PR `BEHIND` + `--until ready`
> → 0 after one repair; pool `[a,b,c]`, author `a` quota → next cycle `b`/`c`;
> stalemate at `roundCap: 3` → `rotate` → 3 fresh rounds.

### P7 — `Remedies 2: reauthor (no split), ask-human via GitHub, continue with fresh budget`
> **What:** design §8c, §8d, §5.3. **Do:** `reauthor` from the work order +
> structured failure history (rewritten narrower for `SCOPE_EXCEEDED`; no child
> runs); `ask` via issue / PR / draft PR (find-or-create), marker comment,
> write-permission-gated replies (`permission`/`role_name`; a failed check
> blocks), `--paginate` polling with backoff, `humanWaitHours` timeout → exit 4;
> `continue <runId>` after 2/4 grants a fresh attempt budget.
> **Accept:** stalemate + no reply → exit 4 with resume command; `orch: retry`
> from a write user → run resumes; `continue <runId>` after exit 2 proceeds.

### P8 — `--until merged: exact-head readiness, head-bound merge, verify by ancestry`
> **What:** design §10.4–10.8, §12. **Do:** `src/landing.js` under
> `standing-pr.lock` (whole merge phase): final readiness read for the exact
> head after the last push; when the repo requires no checks, reconcile the
> integration worktree to that SHA and gate it under nested `merge.lock`; any
> re-pin discards the gate result; `PUT …/merge {merge_method:"merge", sha}`; 405 → re-read → ask on
> `REVIEW_REQUIRED` (status-only branching); 409 → re-pin (cap 3, lock released
> while waiting); verify `merge-base --is-ancestor` for merge commit and
> reviewed SHA; ff local base; tidy non-interactive; `landing: pr` and
> `integrationBranch == baseBranch` variants.
> **Accept:** `landing.test.js` with a fake `gh` that really merges in the
> fixture's bare remote; racing controllers → one merge; no required checks →
> local gate ran before merge.

### P9 — `pr <number|branch>: fold review into pr; owned-branch push authority; CI check before merge`
> **What:** `review <branch>` and `pr <n>` run the same review-mode cycle
> (`engine.js:373-380`); `pr --merge` merges without checking CI (#508). **Do:**
> resolve number vs branch; `once` audit-only with edit-in-place comment;
> `ready` repairs — push only if `isCrossRepository == false` and the head is in
> orch's own branch namespace and the viewer has push; else repair branch;
> `merged` requires readiness then head-bound merge with `github.mergeMethod`;
> MCP `orch_pr` with `until` gated by `automation.mcpMayMerge`.
> **Accept:** pending check + `--until merged` → no merge until green;
> colleague's same-repo branch → repair branch, no push; `mcp.test.js`:
> `until:"merged"` rejected by default. Closes #508.

### P10 — `--detach: background run visible to the existing dashboard`
> **What:** FUTURE.md / `docs/idea-detach-dashboard-visibility.md`. **Do:**
> design §13 lifecycle: detached spawn to `<automation.detachLogDir>/<ts>-<pid>.log`
> (no rotation), parent waits ≤ 5 s and either prints `run.detached` (exit 0)
> or propagates an early child exit with the log tail; child registers inflight
> `detached:true, log, runId`, SIGTERM marks the record `interrupted` and
> releases locks; no attach/kill commands. No dashboard code change.
> **Accept:** `cli.test.js` spawn stub; `dashboard --once --json` lists the run
> as live with `detached:true`; `orch tsk x --detach` exits 64.

### P11 — `Config v2 keys (warn mode), config --check/--json, gateTimeout`
> **What:** design §15; the wizard needs a TTY (`config-wizard.js:293`);
> `merge:` collides with `--merge`; `main.autoMerge`/`github.autoMergePr`/
> `conflictResolution` are subsumed by `--until`; `test` unvalidated;
> `gate.run` has no timeout (#505). **Do:** new keys + validation; removed keys
> **warn** (errors only at P12) with the exact hints; `config --check` /
> `--json` (non-interactive) while bare `config` still opens the wizard until
> P12; `init` writes the commented example; `gate.run` timeout = `gateTimeout`
> (touches protected `src/gate.js` — `--allow-protected`, hand-land).
> **Accept:** `config.test.js`, `config-command.test.js`, `gate.test.js`;
> a v0.4 `orch.yml` with `main.autoMerge: true` → `config --check` exit 0 with a
> warning naming `--until merged`. Closes #505.

### P12 — `Cutover to v0.5.0: bare == --until ready; remove old commands/flags/keys; docs + migration guide`
> **What:** the clean break (owner decision 5/16). **Do:** flip the `--until`
> default to `ready`; delete `review`, `agent build`, `update`, `--merge`,
> `--pr`, `--no-banner`, banner, wizard, `main.*`, `github.autoMergePr`,
> `merge:` acceptance, `reviseCap`; removed keys → errors; MCP `orch_review`
> removed (`-32601 … use orch_pr`, `until` on all cycle tools); README (incl.
> the MCP authority sentence), manual, ORCH.md, example yml, completion,
> CHANGELOG, `docs/MIGRATION-0.5.md` (CLI + MCP rows); version 0.5.0 (hand-land
> the `package.json` bump). Poller default `--until ready` (separate).
> **Accept:** every migration-table row → 64 / JSON-RPC error with the new
> spelling; `orch task x` runs the ready loop; `test/migration.test.js`; suite green.

### P13 — `Telemetry fields, fault-injection suite, metrics script, v0.5.0 release`
> **What:** design §16–17, proposal §7. **Do:** additive `runs.jsonl` fields;
> redrive `quietFail` lines; `test/v2-faults.test.js` (design §17 matrix) and
> `test/system-v2.test.js`; `scripts/v2-metrics.mjs` over run records
> (clean-unattended, false-ready/false-merged); tag + publish. `notify.js`
> untouched.
> **Accept:** matrix green; metrics script reports > 0 clean unattended runs on
> the fixture set; release published.

---

## 9. Cross-slice interfaces (signatures the slices agree on)

So parallel cycles do not invent incompatible shapes, these signatures are
fixed here (JSDoc-level; bodies are the slice's job). All `github.js` primitives
are **synchronous** (they wrap `execFileSync`, `cli.js:48-49`); tests keep their
fakes synchronous.

```js
// P0  src/adapters/cli-adapter.js
export function buildAdapterEnv(adapter, runOpts, cfg);       // → env object (design §14.1); pure
//   adapter contract additions: envKeys?: string[]   limitPattern?: RegExp | ((text)=>boolean)   (P6)

// P1  src/schema.js
export const SCHEMA;                                   // design §3
export function parseArgv(argv, schema = SCHEMA);      // → {command, positionals, flags}; throws UsageError
export function renderHelp(schema = SCHEMA);           // string
export function renderCompletion(schema = SCHEMA);     // bash script string
export class UsageError extends Error { exit = 64 }
export class BlockedError extends Error { exit = 3; reason }
// P1  test/helpers/fake-gh.js
export function mkGh(script);                          // → gh(args, {input}) double recording calls; throws Error("… (HTTP 405)") per script

// P2  src/run-record.js
export function create(orchDir, { runId, command, argv, policy });      // → RunRecord (written)
export function update(orchDir, runId, patch);                          // shallow merge + updatedAt, atomic
export function lookup(orchDir, idOrSid);                               // → RunRecord | null
export function resumeTerminal(orchDir, runId, { maxAttempts });        // clears outcome/exit, grants budget (§5.3)

// P3  src/failure.js
export function classify(input /* cycle result | remote observation | thrown error */); // → Failure
export function fingerprint(failure);                                                  // sha256(class + normalizedSummary)
export function chooseRemedy(failure, record, policy);                                 // → "rebase"|"rotate"|"reauthor"|"ask"|"integration-repair"|null

// P4  src/github.js (additions; sync)
export function prView(n, fields, deps);
export function listComments(n, { since }, deps);                       // paginated
export function collaboratorPermission(login, deps);                    // → {ok:true, permission:"admin"|"write"|"read"|"none", roleName} | {ok:false, status}
export function requiredChecks(base, deps);                             // → {known:bool, contexts:string[]}
export function viewerPermission(deps);                                 // → {push:bool, admin:bool}
export function findPrByHead(head, base, { includeDraft }, deps);       // → {number,url,isDraft,headRefOid} | null
export function createPr({ head, base, title, body, draft }, deps);     // find-or-create
export function commentOnce({ kind, target, body, marker }, deps);      // create or edit-in-place; → {id, created:bool}
export function mergePrHeadBound(n, headSha, method, deps);             // → {result:"merged"|"head-moved"|"blocked"|"rejected"|"not-found", status, message, sha?}
export function updateBranch(n, deps);                                  // → {ok, status, message?}

// P5  src/run-controller.js, src/readiness.js
export async function runUntil(policy, record, deps);                   // drives design §6; → {outcome, exit, record}
export function inspect({ pr, expectedHead, landing, cfg }, deps);      // one read → Readiness | Failure
export async function waitReady(args, deps);                            // polls per automation.* → Readiness | Failure

// P6/P7  src/remedies/*.js, src/integration-repair.js
export async function applyRemedy(name, ctx, deps);                     // → {result:"applied"|"skipped"|"failed", detail}
export async function repairIntegration({ reason, files, cfg }, deps);  // §10A; scratch worktree; merge.lock only around ff/push
// P8  src/landing.js
export async function mergeStanding({ record, cfg }, deps);            // §10.4–10.5 → {result, mergeCommit?, failure?}
```

`deps` objects keep today's shape (`{git, gh, adapters, gate, notify, checkpoint,
inflight, …}`, `cli.js:790-825` `realDeps`/`dryDeps`) so tests inject fakes the
same way as the existing 2070 tests. Existing signatures reused as-is:
`git.rebaseBranchOnto(repo, orchDir, branch, onto, expectedSha = null)`
(`git.js:420`), `lock.acquireBlocking(orchDir, name, {intervalMs, timeoutMs})`
(`lock.js:58`).

---

## 10. Per-slice risk and rollback summary

| Slice | Main risk | Rollback |
|---|---|---|
| P0 | adapter needs an undeclared key | `env.passthrough`; revert |
| P1 | large `cli.test.js` churn; message strings | revert (no state) |
| P2 | disk growth | ignore/delete `.orch/run-records/` |
| P3 | classifier mislabels a trigger | table-driven, per-row tests; revert |
| P4 | live API field shapes differ from assumptions | verification step records real shapes; discriminants fall back to `rejected` → BLOCKED, never a wrong merge |
| P5 | readiness misread → false ready | proposal §7 criterion 2 script; `ready` never merges |
| P6 | integration repair on the shared branch | scratch worktree, `merge.lock` only around ff/push, gate+scan(+audit) on every repair diff, attempt cap |
| P7 | ask-human authorization | permission read failure blocks; replies never reach argv |
| P8 | merge on a moved/untested head | exact-head readiness after last push, local gate when no required checks, head-bound request, ancestry verify |
| P9 | pushing to a branch orch does not own | namespace + `isCrossRepository` + viewer push gate; repair-branch fallback |
| P10 | orphan detached processes | inflight liveness by pid; early-exit propagation; log path printed |
| P11 | dense config test coupling | old keys warn; wizard untouched |
| P12 | one-cycle break; docs drift | schedule alone; `npm i -g @0.4.<last>` |
| P13 | flaky timing tests | fake timers/backoff injection; margins per audit-tests hunt list |
