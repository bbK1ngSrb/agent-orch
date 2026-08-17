# CLI v2 design — `--until`, the bounded loop, and the durable run record

**Status:** design-only, approved for planning, NOT implemented; supersedes
`docs/cli-simplification-*.md` (2026-08-16).
**Date:** 2026-08-17
**Author:** external advisor review (team-lead audit, 8 specialists + 4 verifiers)
**Revision:** 2026-08-17, after two adversarial reviews; "review impl-<id>" / "review fidelity-<id>" tags cite their finding ids; "lead decision" marks calls the team lead made on those findings.
**Reads first:** `docs/cli-v2-proposal.md` (the *what* and *why*). This document is
the *how*, precise enough to implement without asking. Where a choice was the
advisor's rather than the owner's it is marked **(advisor decision)** with a
one-line reason; §18 collects them.
**Baseline:** commit `5879651` (v0.4.315). All `file:line` cites are to that commit.

---

## 0. Glossary (used identically in all three docs)

| Term | Meaning |
|---|---|
| **cycle** | one author → cross-audit → test-gate → land pass; `runCycle` (`src/engine.js:29-391`) + `finalize` (`src/finalize.js:59-172`). Identified by a **sid** (`src/sid.js`, `<pid>-<counter36>`). |
| **run** | a `--until` pursuit: one or more cycles plus remedies, readiness checks, waits. Identified by a **runId** = the sid of its first cycle. Persisted in `.orch/run-records/<runId>.json` (§5). |
| **attempt** | new agent work started as a remedy after a classified failure (a new cycle, or an integration repair), **or an expired bounded wait** (`ciWaitMinutes` elapsed). First cycle = attempt 0. Capped by `automation.maxAttempts`. `ask` consumes none. |
| **free retry** | re-doing a step without new agent work (re-read, wait, re-pin); counted per class in `retries`, each with a per-run cap (§7). |
| **integration repair** | §10A: bringing the standing PR back to green (update-branch, conflict resolution, red-CI fix) — allowed under `ready` and `merged`. |
| **reviewed SHA** | the commit the reviewers approved and the test gate passed (`reviewedSha`, `engine.js`); the only content ever landed. |
| **landed head** | under `landing: no-ff\|ff-only`: the integration tip produced by landing this cycle (`integrationSha`, `finalize.js:237`); reviewed SHA is its ancestor. Under `landing: pr`: the reviewed SHA itself. |
| **standing PR** | the persistent `integrationBranch → baseBranch` pull request, found-or-created by `openIntegrationPr` (`src/github.js:349-490`). |
| **head SHA / head-bound merge** | GitHub's `head.sha` of a PR; a merge request that carries the expected head (`sha` field of `PUT /pulls/{n}/merge`, or `gh pr merge --match-head-commit`) so GitHub refuses (HTTP 409) if the branch moved — the merge-time TOCTOU guard. |
| **TOCTOU** | time-of-check-to-time-of-use: state observed, then acted on, after it may have changed. Guarded by head binding and by `reviewedHeadEscalation` (`finalize.js:30-57`). |
| **idempotent** | safe to repeat: the second call finds the effect already present and does not duplicate it (find-or-create PR, comment marker, merge already landed). |
| **fast-forward** | moving a branch pointer to a descendant commit without a merge commit; how local base follows origin (`git.syncMainFromOrigin`, `git.js:207-234`). |
| **draft PR** | a GitHub PR marked draft: visible, commentable, not mergeable until marked ready. Used as the ask-human channel for `task` runs. |
| **mergeable / mergeStateStatus** | GitHub's PR fields: `mergeable ∈ {MERGEABLE, CONFLICTING, UNKNOWN}`; `mergeStateStatus ∈ {CLEAN, BLOCKED, BEHIND, DIRTY, UNSTABLE, HAS_HOOKS, DRAFT, UNKNOWN}`. |
| **statusCheckRollup** | GitHub's per-PR list of checks/statuses with `state`/`conclusion` (`prChecksGreen`, `github.js:77-103`). |
| **failure class** | a structured code (§7) derived from a cycle/remote outcome; drives remedy choice. |
| **remedy** | one of the four operator-orderable remedies `rebase`, `rotate`, `reauthor`, `ask` (§8, `automation.remedies`), plus **`integration-repair`** (§10A), which is always on and not operator-disablable — it is `ready`'s only path to its goal. |
| **exit codes** | `0` reached · `1` error · `2` stopped-at-cap · `3` blocked · `4` wait-timeout · `64` usage (proposal §4.4). |

---

## 1. Design principles

1. **Headless-first.** No TTY assumption on the run path; no banner; every
   prompt has a non-interactive default (`finishRun` tidy: never force-delete;
   `agent add`: never build without `--build`).
2. **One flag, one meaning.** `--until` means the same on `task`, `issue`, `pr`,
   `continue`. No flag has command-specific semantics.
3. **Validate flags per command** from a declarative schema (§3); the schema also
   generates `--help` and completion so they cannot drift (today
   `test/completion.test.js` enforces parity by hand-listing).
4. **Idempotent side effects.** Every remote write is preceded by a query and
   uses a find-or-create / marker-guarded / head-bound primitive (§5.4, reusing
   prior design §11 "resume queries local/remote truth before performing any
   stage").
5. **Verify, don't trust.** `ready` is read back from GitHub; `merged` is proven
   by `git merge-base --is-ancestor` on `origin/<base>` (as `runPr` already does,
   `github.js:218-238`).
6. **Bounded.** Attempts, waits, polls all have caps; nothing loops forever.
7. **Resumable.** Any crash is recoverable by `orch continue <runId>`, which
   re-derives state from the record plus a fresh read of git and GitHub (§5.4).
8. **Never widen authority.** A comment cannot grant merge; MCP cannot merge
   unless the repo opts in; the loop cannot touch guardrail paths, bypass
   protection, force-push, or squash.

---

## 2. Invariants preserved (with current-code anchors)

| Invariant | Where it lives today | v2 |
|---|---|---|
| Guardrail floor: work orders naming protected paths refused at intake unless `--allow-protected`; any diff touching `DEFAULT_PROTECTED` escalates | `src/intake/allowlist.js:9-23,43-53,63-77`; `engine.js:346-351`; `cli.js:1382-1399` | unchanged; class `POLICY_PROTECTED_PATH` → exit 3, no remedy |
| Deterministic security floor over the final diff | `src/security-review.js`, `engine.js:319-333` | unchanged; `SECURITY_FINDING` → exit 3; the solver never edits to evade it |
| Landing = local no-ff/ff-only merge onto `integrationBranch` in a dedicated worktree, under `merge.lock`, Guard 2 re-tests | `finalize.js:59-172`, `git.js:313-325`, `lock.js:58` | unchanged for landing; **extended**: any integration tip orch did not gate locally (GitHub `update-branch`, a re-pinned head) is re-gated before `merged` merges it (§10A, §10.4) |
| Head integrity at landing (`reviewedHeadEscalation`) | `finalize.js:30-57`, called at 68/185/556 | unchanged; class `LAND_HEAD_MOVED` |
| Local base never written except ff from origin | `git.js:207-234` | unchanged; `merged` fast-forwards after GitHub merges |
| Standing PR is the only trunk gate; `dirty-merge` never opens a per-change PR to base | `finalize.js:562-576`; `orch-manual.md` §3.4 | unchanged |
| Lock/inflight/sid semantics; overlap redrive | `lock.js`, `inflight.js:49-57`, `deferred.js`, `finalize.js:285-395` | unchanged; `merge.lock` additionally guards v2's integration-repair write; loop adds `standing-pr.lock` for the GitHub merge phase only (§12) |
| Checkpoint describes an in-flight *cycle* only; cleared on any terminal return | `cli.js:1506-1509`, `1684-1693`; `checkpoint.js` header | **kept** — the new run record (§5) carries cross-cycle state so dashboard's "died mid-flight" heuristic keeps working |
| Redaction before every outward post | `redact.js:24-30` | unchanged; applies to question comments too |
| No shell in git/gh spawns | `git.js:46-57`, `cli.js:48-49` | unchanged; all new calls are argv arrays |

---

## 3. Command schema

A single exported object drives parsing, validation, help, completion, MCP
argument builders and tests. Sketch (JS object literal; the implementation may
freeze it):

```js
export const SCHEMA = {
  // flag definitions: name → {type, value?, help, validate?}
  flags: {
    until:            { type: "enum", values: ["ready","merged","once"], help: "…" },
    "max-attempts":   { type: "int", min: 0, help: "…" },
    author: {type:"string"}, authors:{type:"string"}, reviewer:{type:"string"}, reviewers:{type:"string"},
    cheap:{type:"bool"}, file:{type:"string"}, "allow-protected":{type:"bool"},
    "no-tidy":{type:"bool"}, detach:{type:"bool"},
    json:{type:"bool"}, dry:{type:"bool"}, "config-file":{type:"string"},
    check:{type:"bool"}, link:{type:"bool"}, build:{type:"bool"},
    limit:{type:"int",min:1}, "check-history":{type:"bool"}, once:{type:"bool"}, plain:{type:"bool"},
    "refresh-ms":{type:"int",min:1},
    help:{type:"bool",short:"h"}, version:{type:"bool"},
  },
  // command definitions
  commands: {
    task:      { positional: "text?",  flags: RUN_FLAGS.concat("cheap","file","allow-protected","authors"), mutates: true },
    issue:     { positional: "number", flags: RUN_FLAGS.concat("cheap","allow-protected","authors"), mutates: true },
    pr:        { positional: "number|branch", flags: RUN_FLAGS, mutates: true },
    continue:  { positional: "sid|runId", flags: RUN_FLAGS.filter(f => !["author","authors"].includes(f)), mutates: true },
    release:   { positional: "text", flags: ["dry","json"], mutates: true },
    "agent add": { positional: "name", flags: ["build","dry","json","config-file", ...RUN_FLAGS], mutates: true },  // RUN_FLAGS valid only with --build (parser: 64 otherwise)
    init:      { positional: null, flags: ["link","dry","config-file","json"], mutates: true },
    config:    { positional: null, flags: ["check","json","config-file"], mutates: false },
    dashboard: { positional: null, flags: ["json","limit","check-history","once","plain","refresh-ms"], mutates: false },
    mcp:       { positional: null, flags: [], mutates: false },
    upgrade:   { positional: null, flags: ["check","dry","json"], mutates: true },
    completion:{ positional: "bash|install?", flags: [], mutates: true /* writes ~/.orch/completion.bash */ },
    version:   { positional: null, flags: [] }, help: { positional: null, flags: [] },
  },
};
const RUN_FLAGS = ["until","max-attempts","author","reviewer","reviewers","no-tidy","detach","dry","json","config-file"];
```

Parser rules (replacing the bare `parseArgs` at `cli.js:418-425` with a thin
wrapper over it):

| Rule | Behaviour |
|---|---|
| bool flags | `--x`; `--no-x` only where the schema declares a `no-` form (`--no-tidy` is a flag named `no-tidy`, not a negation) |
| value flags | `--x y` and `--x=y` both accepted (parseArgs semantics) |
| repeated flags | last one wins for scalars; error 64 for `--until` given twice with different values (advisor decision: contradictory goals should not silently resolve) |
| unknown flag | exit 64: `orch: unknown option --foo (see orch help)` |
| flag not in this command's `flags` | exit 64: `orch: --file is not valid with 'orch issue'` |
| `--dry` on `mutates:false` command | exit 64: `orch: --dry has no effect on 'orch config'` |
| unknown command | usage to **stderr**, exit 64 |
| `--help`/`--version` with other flags | general rule: they win **unless** an action-implying flag is present (`--until merged`, `--detach`, `--build`) → 64 ("describe the tool" and "do a thing" contradict; today's rule for `--merge`, `cli.js:1167`) |
| `-h` | alias of `--help`; no other short flags |
| `--` | ends option parsing (MCP passes task text after it, `mcp.js:112`) |

Help is rendered from `SCHEMA` (command list, per-command option groups, exit
codes). `completion.js` renders from the same object. `test/completion.test.js`
becomes a test that both renderers consume `SCHEMA` (no hand lists).

`--json` output shape (one object per line, `event` discriminated; `dashboard --json` keeps its unchanged single-snapshot shape):

| event | fields |
|---|---|
| `run.start` | `runId, command, until, policy, cwd, orchVersion` |
| `cycle.start` / `cycle.end` | `runId, sid, attempt, branch, status, reason?, reviewedSha?, usage` |
| `failure` | `runId, attempt, class, summary, fingerprint` |
| `remedy` | `runId, attempt, remedy, detail` |
| `remote.readiness` | `runId, pr, head, mergeable, mergeStateStatus, checks:{total,green,pending,red}, reviewDecision, ready:bool` |
| `human.ask` / `human.reply` | `runId, channel, url, commentId, deadline` / `user, command, text` |
| `merge.request` / `merge.verified` | `runId, pr, head, method` / `mergeCommit, base, ancestor:true` |
| `run.end` | `runId, outcome, exit, resumeCommand?, blockedReason?, warnings[]?, prUrl?, usage` (`warnings` carries e.g. `required-checks-unknown`, §9) |
| `run.detached` / `run.resume` / `policy.change` | `pid, log, runId` / `runId, previousOutcome, maxAttempts` / `runId, field, from, to` |
| non-run commands | one object: `{command, ok, …}` (e.g. `config`: `{command:"config", ok, config, sources, problems[]}`) |

---

## 4. RunPolicy

Immutable object derived at preflight from flags + config, stored verbatim in the
run record so `continue` re-uses it. On `continue`, `--until` and
`--max-attempts` may replace the stored values (journaled as a `policy.change`
event); all other flags are taken from the record.

```js
RunPolicy = {
  until: "ready"|"merged"|"once",
  maxAttempts: 3,                 // automation.maxAttempts or --max-attempts
  humanWaitHours: 24,
  remedies: ["rebase","rotate","reauthor","ask"],
  pollSeconds: 30, ciWaitMinutes: 30,
  detach: false, dry: false, json: false, tidy: true,
  roles: { author?, authors?, reviewer?, reviewers?, cheap:bool },
  allowProtected: false,
  landing: "no-ff"|"ff-only"|"pr",
  source: { kind:"task"|"issue"|"pr"|"agent-build", text?, issue?, pr?, branch? },
  configDigest: "<sha256 of effective config>",   // evidence only (recorded, not part of any fingerprint)
  orchVersion: "0.5.0",
}
```

`once` sets `maxAttempts = 0` and `remedies = []` internally.

**`--dry` under `ready`/`merged`** (lead decision, review fidelity-MA3): dry plans the
*first cycle only* through today's `dryDeps()` (`cli.js:809-825`), then prints
the remedy ladder and the `automation.*` values that would apply, and exits 0
(unless preflight fails → 1/64). No loop, no readiness polling, no GitHub
reads, no run record written (see §5.2), events `run.start` / `cycle.*` /
`run.end` carry `dry:true`. Under `once` dry is exactly today's `--dry`.

---

## 5. Persistent run state — the durable run record

### 5.1 Why a new record

Today's crash-resume stores (`checkpoints/`, `resume/`, `inflight/`) are cleared
on any terminal return (`cli.js:1506-1509`, `1684-1693`), and `continue` refuses
without them (`cli.js:1580-1581`). Audit-engine §4 lists what a loop needs and no
store reserves: attempt counter, parent-sid lineage, remedy history, structured
last failure. Reusing the checkpoint would break the "checkpoint = in-flight
cycle" invariant that `continue`'s no-diff refusal (`cli.js:1592-1598`) and the
dashboard's interrupted heuristic depend on. So: a **new** store,
`.orch/run-records/` (named to avoid confusion with the `.orch/runs.jsonl`
file), one JSON file per run, written atomically (`atomic-file.js`).

### 5.2 Schema (`.orch/run-records/<runId>.json`, `schemaVersion: 1`)

The record stores only what cannot be re-derived from git or GitHub (lead
decision, review impl-M11): policy, attempt/retry accounting, failure and remedy
history, the question comment id, and the merge-request ordinal. Everything
about PRs, heads, checks and merges is **re-queried** before every write
(§5.4); the copies kept here are evidence for humans and tests, never inputs
to a decision.

```js
RunRecord = {
  schemaVersion: 1,
  runId: "650823-0",                 // == first cycle sid
  createdAt, updatedAt: ISO,
  command: "issue", argv: [...],      // as typed (redacted)
  policy: RunPolicy,                  // §4
  state: "CYCLING"|…,                 // §6
  outcome: null|"reached"|"stopped-at-cap"|"blocked"|"wait-timeout"|"error",
  exit: null|0|1|2|3|4,               // 64 never appears: usage errors abort before a record exists
  attempt: 0,                         // current attempt index (cycles started as remedies)
  retries: { "<class>": n },          // free retries spent per class this run (§7 caps)
  headMovedRepins: 0,                 // §10.4 cap
  cycles: [{ sid, attempt, branch, author, reviewers, status, reason, reviewedSha, integrationSha?, startedAt, endedAt, usage }],
  failures: [{ attempt, class, summary, fingerprint, headTree, baseSha, at, evidence: { decisionFile?, roundFile?, testLog?, ghJson? } }],
  remedies: [{ attempt, remedy, chosenFor: class, detail, at, result: "applied"|"skipped"|"failed" }],
  excludedAgents: [{ name, reason:"quota"|"error", at }],
  branch: "pr/claude/fix-x-650823-0",   // current task branch (may change on reauthor)
  pr: { number, url, kind:"standing"|"per-cycle"|"foreign"|"draft-question" } | null,   // identity only; head/state re-read
  integration: { branch, landedSha } | null,     // evidence
  readiness: { at, headSha, mergeable, mergeStateStatus, checks, reviewDecision, ready } | null,  // last observation (evidence)
  merge: { requests: [{ ordinal, at, headSha, result }], mergeCommit?, verifiedAncestorAt?, mergedBy:"orch"|"external" } | null,
  human: { channel:"issue"|"pr"|"draft-pr", url, askCommentId, askedAt, deadline, replies:[{id,user,at,command,text}] } | null,
  detached: { pid, log, startedAt } | null,
  interrupted: { at, signal } | null, // set by the SIGTERM/SIGINT handler (§13)
  lastError: { message, stack? } | null,
}
```

Field types are JSON primitives; SHAs are 40-hex strings; times ISO-8601 UTC.
`sid` values inside `cycles[]` remain the branch/checkpoint keys, so all existing
stores keep working per cycle. `--dry` runs write **no** record.

### 5.3 Lookup, lineage, resuming a terminal run

- `orch continue <x>`: if `.orch/run-records/<x>.json` exists → resume run `x`;
  else if any record has `cycles[].sid == x` → resume that run; else fall back
  to today's checkpoint/inflight resume (`cli.js:1544-1717`) for pre-v2 sids.
- **Resuming a terminal run** (lead decision, review fidelity-MA2): when the record's
  `outcome` is `stopped-at-cap` or `wait-timeout`, `continue` clears
  `outcome`/`exit`, journals a `run.resume` event, and grants a **fresh attempt
  budget**: `maxAttempts := attempt + (--max-attempts | policy.maxAttempts)`,
  and **`retries[]` and `headMovedRepins` are cleared** (lead decision): a
  `continue` is a fresh, human-initiated bounded episode, so the per-class
  free-retry caps re-apply per continue; the B2 bound then holds per episode,
  which is what a human re-running the command expects.
  `--until once` on `continue` grants no attempts (one pass). A `blocked` run
  resumes only after the blocking condition is gone (guardrail path removed,
  human said something other than abandon); `continue` re-classifies first and
  exits 3 again if it still holds. A `reached` run: `continue` exits 0 with
  "already reached". `error`: resumes from the last state.
- A record is **never** deleted by orch; `outcome` marks it terminal.
- Migration from today's records: none needed — v1 stores keep their meaning; a
  pre-v2 sid without a record resumes the old way.

### 5.4 Query-before-write (the invariant that replaces a side-effect journal)

Every remote write is preceded by a read that answers "is the effect already
there?", using primitives that are idempotent by construction (§9): PR →
`findPrByHead`; comment → `commentOnce` (marker `<!-- orch:<runId>:<kind> -->`
in the body); merge → `prView(state, mergeCommit)` then ancestry; branch push →
compare remote SHA first. A crash between the read and the write is therefore
harmless: the next resume performs the same read and finds the effect (or not).
The record keeps two things a query cannot recover: `human.askCommentId` (which
comment starts the reply window) and `merge.requests[].ordinal` (how many merge
requests this run has issued — the fault matrix's "ordinal 2").

### 5.5 What the untouched dashboard still reads

`dashboard.js` reads `runs.jsonl` fields `ts branch sid verdict rounds tokens
costUsd` (plus `resolved` for `--check-history`), `checkpoints/*.json`
(`branch round stage decision`), and `inflight/*.json` (`pid branch sid`, with
`ts` stamped by `sid-store.js:writeRecord`). v2 appends fields to `runs.jsonl`
lines (`runId attempt until outcome exit failureClass`) and to inflight records
(`detached log runId`) — additive; readers ignore unknown keys. Nothing is
renamed or removed.

---

## 6. State machine

Top-level run machine (states are persisted in `RunRecord.state`; every arrow
that crosses a side-effect boundary writes the record first):

```
 NEW ──preflight ok──▶ CYCLING ──cycle status──┐
  │ (usage/config error → exit 64/1)            │
  │                                             ▼
  │                       ┌── merged/pr/approved ──▶ LANDED ──▶ READINESS ──ready──▶ [until=ready] READY ──▶ exit 0
  │                       │                                     │  ▲                 [until=merged] ▶ MERGING ──▶ VERIFYING ──▶ MERGED ──▶ exit 0
  │                       │                                     │  │ (BEHIND/CONFLICT/CI red → failure)   │ (409 head moved → READINESS)
  │                       │                                     ▼  │                                        │ (405 protection → ask/blocked)
  │                       └── escalated/deferred ───▶ CLASSIFYING ──▶ REMEDYING ──applied──▶ CYCLING
  │                                                     │              │ (ask) ──▶ WAITING_HUMAN ──reply──▶ CYCLING
  │                                                     │              │                        └─timeout──▶ WAIT_TIMEOUT ──▶ exit 4
  │                                                     │ (POLICY/SECURITY/no channel) ──▶ BLOCKED ──▶ exit 3
  │                                                     │ (attempts exhausted, ask unavailable/declined) ──▶ STOPPED_AT_CAP ──▶ exit 2
  └── (uncaught throw anywhere) ──▶ ERROR ──▶ exit 1  (record keeps state for continue)
```

`until=once` (**strict parity with today's single pass**, lead decision, fidelity
B2): `CYCLING → exit 0` on `merged`/`pr`/`approved` — **no READINESS read** —
and `escalated/deferred → CLASSIFYING → (POLICY_PROTECTED_PATH/SECURITY_FINDING
/CONCURRENCY_CAP → 3) else 2`. No REMEDYING, no WAITING_HUMAN. The only
differences from today are the exit codes 3 (was 2) and 64 (was 0/1) and the
absence of the banner; the migration table lists them.

The cycle sub-machine is today's `runCycle` unchanged: `started → authored →
reviewed → tested → finalize` (`engine.js:140,154,275,300,354`).

Terminal state → exit code: `READY`/`MERGED` → 0; `ERROR` → 1;
`STOPPED_AT_CAP` → 2; `BLOCKED` → 3; `WAIT_TIMEOUT` → 4.

Escalation and demotion triggers mapped to failure classes:

| Trigger (today) | Where | Class |
|---|---|---|
| scope cap exceeded | `engine.js:158-163` | `SCOPE_EXCEEDED` |
| empty diff | `engine.js:227-230` | `DIFF_EMPTY` |
| reviewer adapter crashed (`agentError`) | `engine.js:280-284` | `AGENT_ERROR` (or `AGENT_QUOTA` if adapter's limit matcher hit) |
| no test command | `engine.js:288-291` | `TEST_MISSING` |
| test gate red on branch | `engine.js:302-305` | `TEST_RED` |
| unreadable branch head pre-scan | `engine.js:315-318` | `DIFF_UNREADABLE` |
| security diff unreadable | `engine.js:323-326` | `DIFF_UNREADABLE` |
| security scan rejected | `engine.js:327-333` | `SECURITY_FINDING` |
| protected path touched | `engine.js:346-351` | `POLICY_PROTECTED_PATH` |
| DISAGREE stalemate at cap | `engine.js:369-381` | `REVIEW_STALEMATE` |
| head moved at finalize | `finalize.js:30-57` | `LAND_HEAD_MOVED` |
| `landing: pr` and PR open failed | `finalize.js:80` | `LAND_PR_OPEN_FAILED` |
| demote `lock` | `finalize.js:83-85` | `LAND_LOCK` |
| demote `sync` | `finalize.js:93-117` | `LAND_SYNC` |
| demote `overlap` | `finalize.js:119-151` | `LAND_OVERLAP` |
| demote `dirty-merge` | `finalize.js:194-203` | `LAND_DIRTY_MERGE` |
| demote `integration-test` | `finalize.js:207-216` | `LAND_INTEGRATION_TEST` |
| author stage threw (quota/limit/other) | `cli-adapter.js:304`, author path | `AGENT_QUOTA` / `AGENT_ERROR` |
| concurrency cap, nothing attempted | `cli.js:1489-1493` | `CONCURRENCY_CAP` → exit 3, `blockedReason:"concurrency-cap"` (a scheduler may retry later; nothing to resume) |

Remote failure classes (from readiness/merge, §9–§10): `REMOTE_CI_RED`,
`REMOTE_CI_TIMEOUT`, `REMOTE_CONFLICTING`, `REMOTE_BEHIND`,
`REMOTE_REVIEW_REQUIRED`, `REMOTE_CHANGES_REQUESTED`, `REMOTE_PR_CLOSED`,
`REMOTE_MERGE_REJECTED`, `REMOTE_AUTH`, `REMOTE_UNKNOWN`. Human: `HUMAN_ABANDON`,
`HUMAN_TIMEOUT`. Internal: `INTERNAL`.

---

## 7. Structured failure protocol and remedy selection

Failure object (reuses prior design §7 `AttemptFailure`, trimmed):

```js
Failure = { class, stage:"author"|"review"|"gate"|"security"|"land"|"remote"|"human",
            summary, retryable:bool, remedies:[…allowed in order], headSha, baseSha,
            fingerprint, evidence:{…paths/JSON}, at }
```

`fingerprint = sha256(class + normalizedSummary)` — deliberately **without** the
tree, base or config (review impl-M1: every remedy changes the tree, so a tree-bound
fingerprint could never detect "two different attempts failed the same way").
`headTree`/`baseSha` are stored beside it as evidence. `normalizedSummary` = for
`REVIEW_STALEMATE` the reviewer's findings with SHAs/timestamps/line numbers
stripped; for `TEST_RED`/`LAND_INTEGRATION_TEST` the failing test names; for
`REMOTE_CI_RED` the failing check names; for `LAND_DIRTY_MERGE`/
`REMOTE_CONFLICTING` the conflicted paths.

**Two kinds of retry.** An **attempt** starts a new cycle (rebase, rotate,
reauthor) and increments `attempt`. A **free retry** re-does a step without a
new cycle (re-read, wait, re-pin) and increments `retries[<class>]` — or
`retries[<named reason>]` where one class has more than one kind of wait, as
the standing-PR classes do (`repair-lock`, §10A); every free
retry has a **per-run cap** below, after which the class is handled as if the
free retry were exhausted (next remedy, or `STOPPED_AT_CAP`). Nothing loops
without touching one of the two counters (review impl-B2).

Deterministic chooser (first applicable, honouring `policy.remedies` order and
skipping disabled ones; `chooseRemedy` may also return `integration-repair`,
which is never in `policy.remedies` and cannot be disabled). "integration
repair" = §10A, allowed under `ready` and `merged` (lead decision, review
fidelity-B1).

| Class | Free retry (per-run cap) | Remedy list (in order) | Notes |
|---|---|---|---|
| `REVIEW_STALEMATE` | — | `rotate` (reviewer, then author+reviewer), `reauthor`, `ask` | equal fingerprint twice → skip to next remedy |
| `AGENT_ERROR`, `AGENT_QUOTA` | — | `rotate` (exclude the agent for the run), `ask` | `AGENT_QUOTA` never retries the same agent |
| `TEST_RED` | — | `rebase` (repair mode: fix the named failing tests), `rotate`, `reauthor`, `ask` | |
| `TEST_MISSING` | — | `ask` | config problem; message names `test:` |
| `DIFF_EMPTY` | — | `reauthor`, `rotate`, `ask` | |
| `DIFF_UNREADABLE`, `LAND_HEAD_MOVED`, `LAND_LOCK`, `LAND_SYNC` | 1 (30 s backoff) | `rebase`, `ask` | transient/infra |
| `SCOPE_EXCEEDED` | — | `reauthor` (rewritten, narrower work order — no split, see §8c), `ask` | |
| `LAND_OVERLAP` | wait for the peer's redrive up to `ciWaitMinutes` (1) | `rebase` | |
| `LAND_DIRTY_MERGE`, `LAND_INTEGRATION_TEST` (task branch landing) | — | `rebase` (+repair), `rotate`, `ask` | |
| `REMOTE_BEHIND`, `REMOTE_CONFLICTING`, `REMOTE_CI_RED` (standing PR / integration) | a peer holds `integration-repair.lock` → poll readiness up to `ciWaitMinutes`, `retries["repair-lock"]` (3 per run) | integration repair (§10A) — counts as one attempt, `ask` | under `ready` and `merged`; the free retry is the §10A loser path only, and after its cap the run takes the repair itself or `ask` |
| `REMOTE_CI_TIMEOUT` | — (the expiry itself **is** an attempt, §10.2; no separate free retry) | wait again if attempts remain; integration repair if a check *failed* meanwhile; else `ask` | one counter only |
| `REMOTE_UNKNOWN` (mergeability not computed) | re-read ×3, 10 s apart (3) | `ask` | |
| `REMOTE_CHANGES_REQUESTED` | — | `reauthor` in revise mode with the review body as addendum | consumes an attempt |
| `REMOTE_REVIEW_REQUIRED` | — | (`merged` only) `ask` "ready — approve or `orch: abandon`" | not a failure under `ready` |
| `REMOTE_PR_CLOSED` | — | `ask` | a human closed it; do not reopen |
| `LAND_PR_OPEN_FAILED` (`landing: pr`) | 1 | `ask` | |
| `REMOTE_AUTH`, `REMOTE_MERGE_REJECTED` | 1 (30 s) | none → `BLOCKED` (3) | never swallowed (fixes #504) |
| `HUMAN_TIMEOUT` | — | none → `WAIT_TIMEOUT` (4) | |
| `SECURITY_FINDING`, `POLICY_PROTECTED_PATH`, `CONCURRENCY_CAP`, `HUMAN_ABANDON` | — | none → `BLOCKED` (3) | `run.end.blockedReason` names which |
| `INTERNAL` | — | none → `ERROR` (1) | |

Attempt accounting: `rebase`, `rotate`, `reauthor`, integration repair each start
new agent work → `attempt += 1` before it starts (persisted). `ask` consumes
none. A reply of `orch: retry [n]` raises `policy.maxAttempts` by `n` (default
1, max 3 per reply, and at most `2 × automation.maxAttempts` extra per run in
total — the per-run ceiling review impl-m6 asked for). When `attempt > maxAttempts`
and the class's list still has `ask` (enabled, channel exists) → ask once, then
wait; else `STOPPED_AT_CAP`.

Convergence: two consecutive failures with equal `fingerprint` skip the remedy
that produced the second and move to the next; three equal fingerprints → `ask`
(or cap). Rotation must be *diverse*: a `rotate` that would pick the same
agent+model as the failed attempt is not a rotation and is skipped
(`headless-overnight-design.md` §3.5).

Logged: every failure and remedy as record entries and `--json` events; the
`DECISION.md`/issue-comment paths stay for humans (`notify.js`).

---

## 8. Remedies in detail

All git/gh operations are argv arrays via the existing `git()`/`ghShell()`
helpers (`git.js:46-57`, `cli.js:48-49`) — never a shell string. **Every remedy
that starts agent work starts a new cycle with a fresh round counter (round 1),
a cleared checkpoint, and — for `rotate` — `opts.reviewerOverride` set so no
cached verdict is trusted (`engine.js:206-220`).** The previous cycle's branch
is the starting point where the remedy says so; the author prompt for a
remedy cycle includes the prior review log (`.orch/reviews/<branch>/round-*.md`)
so the agent sees what was objected to (lead decision, review impl-B1).

### 8a. `rebase` (rebase on moved base + repair) — task branch

Preconditions: task branch exists locally; base fetched; class not
`POLICY/SECURITY`.

1. `git fetch origin <base>`; read `expected = rev-parse refs/heads/<branch>`.
2. `git.rebaseBranchOnto(repo, orchDir, branch, "origin/<base>", expected)`
   (`git.js:420`, actual signature — `orchDir` hosts the temporary rebase
   worktree): CAS on the branch ref — if the ref moved since `expected`, abort
   without writing (compare-and-swap = write only if the current value still
   equals what we read). On rebase conflict → repair mode.
3. **Repair**: spawn the *author* adapter in the branch's own worktree with a
   structured prompt: the failure class, the failing test names / conflict
   marker list / red check names, "fix only this; do not widen scope". The
   adapter commits (`author()` commits staged changes, `cli-adapter.js:479-483`).
4. New cycle on the repaired branch: full audit + gate + security + landing.

Safety: never `--force`; the push after repair is a plain `git push origin
<branch>` for task branches orch owns (`pr/*` namespace); a non-ff rejection is
`LAND_HEAD_MOVED`, never forced. Writes: `remedies[]`, `branch` (unchanged
name). The integration-branch counterpart is §10A.

### 8b. `rotate` (rotate agents / stronger model + quota exclusion)

Adapter contract addition (`makeCliAdapter` opts, `cli-adapter.js:454`):
`limitPattern?: RegExp | (text)=>bool` (default: shared `LIMIT_RE`,
`cli-adapter.js:42`), and `envKeys?: string[]` (§14). Both `author()` and
`audit()` classify a failure through the adapter's matcher (today only
`runCapture`/`audit` does, `cli-adapter.js:304`; `author()` throws raw output).
Result: `{ ok:false, class:"AGENT_QUOTA"|"AGENT_ERROR", out }` instead of a bare
throw for the author seat.

Rotation algorithm (run controller, not `runCycle`):
1. Add the failed agent to `excludedAgents` (reason `quota`/`error`) for the rest
   of the run (in-run only; no cross-run persistence — the idea doc's chosen
   scope).
2. Candidates = `cfg.agents` minus excluded, keeping "reviewer ≠ author"
   (`nextAuthor`, `cli.js:494-535`).
3. Seat to rotate: the seat that failed; for `REVIEW_STALEMATE`, first the
   reviewer, then on the next `rotate` both.
4. Stronger model: if the failed role spec has no explicit model and the adapter
   has `capabilities.model`, take the next entry of
   `automation.rotateModels[<agent>]` (an ordered escalation ladder applied to
   the author/reviewer *model field*; the `agents:` pool stays bare names — this
   is not the rejected #323 design, see §15). If no candidate differs from the
   failed spec → remedy `skipped` (not diverse).
5. New cycle on the **same branch**, round 1, cleared checkpoint,
   `reviewerOverride` set. Acceptance (plan P6): stalemate at `roundCap: 3` →
   `rotate` → the new cycle performs up to three fresh rounds, not one.

Preflight for `ready|merged` requires ≥ 2 usable agents when `rotate` is
enabled; otherwise `rotate` is disabled for the run and `config --check` warns.

### 8c. `reauthor` (re-author from scratch with a rewritten work order)

1. Fresh branch (`git.createTaskBranch`, `git.js:96-102`) from current
   `origin/<base>`; the old branch is kept and linked in the record.
2. Author prompt = original work order + human addenda + a structured "what
   failed before" section from `failures[]` (class, summary, up to 3
   fingerprints). For `SCOPE_EXCEEDED` the prompt instructs a narrower
   implementation of the *same* work order (e.g. "smallest change that
   satisfies the acceptance test; no refactors"). **Splitting into child runs is
   cut from v0.5** (advisor decision, allowed by the owner's remedy list which
   says "re-author from scratch / split"): it needs child states, budgets and
   resume semantics that no other part of the design uses; a human splits the
   issue instead. Noted as future work.
3. Full cycle on the new branch. GitHub cannot change a PR's head branch, so an
   existing draft question PR for the old branch is closed with a marker comment
   linking the new branch (idempotent), and a new draft is created only when the
   next `ask` needs one.

### 8d. `ask` (ask a human via GitHub, then wait)

Channel selection: `issue` run → the issue; `pr` run → the PR; `task` run →
draft PR for the task branch, find-or-create by head (`findPrByHead`, then
`gh pr create --draft --head <branch> --base <base> --title "orch: <slug>
(question)" --body-file -`). (Owner decision 18 says "every run opens/updates a
draft PR … issue-runs ask on the issue"; the docs read that as: the draft PR is
the channel when no better one exists — `task` runs — and a `pr` run naturally
uses its PR.) If there is no remote or no `gh` → `BLOCKED` with
`blockedReason:"no-channel"`, and the question is written to
`.orch/reviews/<branch>/DECISION.md` as today.

Comment template (posted via `gh issue comment`/`gh pr comment --body-file -`,
redacted, marker first line):

```
<!-- orch:<runId>:ask:<attempt> -->
**orch needs a decision** (run `<runId>`, attempt <n>/<max>, goal `--until <until>`)

What happened: <class> — <summary>
What orch tried: <remedy list with results>
Evidence: <links: branch, DECISION.md path, failing checks>

Reply (users with write access only), one of:
- `orch: retry` — try again with the same work order (add ` 2` for two more attempts)
- `orch: abandon` — stop; orch will exit and leave the branch
- anything else — treated as new instructions appended to the work order (one more attempt)

orch will wait until <deadline UTC>, then exit 4; resume with `orch continue <runId>`.
```

Polling: `gh api --paginate repos/{o}/{r}/issues/{n}/comments?since=<askedAt>`
(PR conversation comments are issue comments; `--paginate` because the endpoint
pages at 30) every `pollSeconds`, exponential backoff ×2 up to 10 min, until
`deadline = askedAt + humanWaitHours`. Only comments with `id > askCommentId`
count. **Authorization:** `gh api repos/{o}/{r}/collaborators/{login}/permission`
returns `{permission, role_name, user}` where `permission ∈ {admin, write,
read, none}` (GitHub folds `maintain` into `write` and `triage` into `read`
here) and `role_name` carries the granular role; accept when `permission ∈
{admin, write}` **or** `role_name ∈ {admin, maintain, write}`. Cached per login
per run. A non-200 (the endpoint needs push access itself, 403 otherwise) →
`BLOCKED` with `blockedReason:"cannot-verify-authorization"` — never silently
ignore replies. Bot comments (`user.type == "Bot"`) and orch's own marker
comments are ignored.

Parsing: first line matching `^orch:\s*(retry(\s+\d+)?|abandon)\s*$`
(case-insensitive) → command; otherwise free text (max 4 KB, redacted, appended
to `policy.source.text` as "Human addendum (<user>, <date>)"). Each reply is
journaled with its comment id; a reply is consumed once. `retry` → back to
`REMEDYING` with the last failure and `maxAttempts += n` (caps in §7). Free text
→ `reauthor` in *revise* mode (same branch, addendum in prompt). `abandon` →
`BLOCKED` (3), reason `human-abandon`, closing comment posted. Timeout →
`WAIT_TIMEOUT` (4), a comment "timed out; resume with …" posted;
`orch continue <runId>` re-polls from `askCommentId` first (a late reply is
honoured) before asking again.

Authorization is by GitHub permission, never by name lists in config (advisor
decision: keeps the trust anchor in GitHub, where the owner already manages it).

---

## 9. Ready check (remote readiness inspector)

Input: `pr` (number), `expectedHead` (landed head, §0), `landing` mode.
Read (after `git fetch origin <base> <integration>` so local refs are fresh —
review impl-m7): `gh pr view <n> --json number,state,isDraft,headRefOid,baseRefName,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,url`.

`ready == true` iff all of:
1. `state == OPEN` and `isDraft == false` (a draft question PR is never "ready");
2. `headRefOid == expectedHead`, **or** (standing PR only) `expectedHead` is an
   ancestor of `headRefOid` *and* `headRefOid == rev-parse origin/<integration>`
   (another cycle landed after us; the standing PR still carries our change and
   is at its current tip — re-pin `expectedHead := headRefOid`, count
   `headMovedRepins`, cap 3 per run, then `ask`);
3. `mergeable == MERGEABLE` and `mergeStateStatus ∉ {CONFLICTING, DIRTY, BEHIND,
   DRAFT}`; `UNKNOWN` → free retry ×3 (10 s) then `REMOTE_UNKNOWN`. `BLOCKED`
   is allowed **only** when 4 holds (i.e. the only blocker is review/ruleset);
   `UNSTABLE`/`HAS_HOOKS` are decided by 4;
4. **checks:** this predicate is defined here, independently of today's
   `prChecksGreen` (`github.js:99-103` returns false for an empty rollup; the
   rule below deliberately differs, and P5 updates its callers and tests —
   review fidelity-mi14). Read the required checks once per run:
   `gh api repos/{o}/{r}/rules/branches/<base>` returns an **array of rule
   objects**; filter `type == "required_status_checks"` and collect
   `parameters.required_status_checks[].context`; if the array is empty also
   read classic protection `gh api repos/{o}/{r}/branches/<base>/protection`
   (404 = none; `required_status_checks.contexts` otherwise); a 403 on either
   read = "required checks unknown". Then: every `statusCheckRollup` entry
   terminal with `conclusion ∈ {SUCCESS, NEUTRAL, SKIPPED}` (a `status`-API
   entry uses `state == SUCCESS`); every required context present and green;
   an **empty rollup** is green only when the required set is known and empty;
   "unknown" → not ready under `merged` (ask); under `ready` it is ready **with
   `run.end.warnings: ["required-checks-unknown"]`** — exit 0 still, but the
   metrics script (plan P13) counts such runs separately from fully verified
   ones;
5. `reviewDecision ∉ {CHANGES_REQUESTED}` (`APPROVED`, `REVIEW_REQUIRED`, `null`
   are fine for `ready`; `merged` handles `REVIEW_REQUIRED` in §10.4).

Polling: pending checks → wait `pollSeconds` ×2 backoff (cap 10 min) up to
`ciWaitMinutes`, then `REMOTE_CI_TIMEOUT` (each expiry consumes one attempt —
§10.2). Failing checks → `REMOTE_CI_RED` with names; `BEHIND` → `REMOTE_BEHIND`;
`CONFLICTING/DIRTY` → `REMOTE_CONFLICTING`; closed → `REMOTE_PR_CLOSED`;
merged-by-someone with our reviewed SHA an ancestor of `origin/<base>` →
outcome `reached`, `mergedBy:"external"`; `CHANGES_REQUESTED` →
`REMOTE_CHANGES_REQUESTED`.

New `github.js` primitives (audit-landing §4 gaps; all **synchronous** like
today's `deps.gh` = `execFileSync`, review impl-m4; each returns parsed JSON or a
discriminated object, and any non-2xx surfaces as `{ok:false, status, message}`
built from `execFileSync`'s thrown error — `gh api` prints `HTTP <code>` and the
JSON `message` on stderr, which `execFileSync` folds into `error.message`/
`error.stderr`; the wrapper parses the code from there, exactly as today's
`tryMergeDirect` greps `\b409\b`, `github.js:66-75`):
`prView(n, fields)`, `listComments(n, {since})` (paginated),
`collaboratorPermission(login)` → `{permission, roleName} | {ok:false,status}`,
`requiredChecks(base)` → `{known:bool, contexts:[]}`, `findPrByHead(head, base,
{includeDraft})`, `createPr({head, base, title, body, draft})` (find-or-create),
`commentOnce({kind, target, body, marker})` (create or edit in place),
`mergePrHeadBound(n, headSha, method)` → `{result:"merged"|"head-moved"|
"blocked"|"rejected"|"not-found", status, message, sha?}` (never throws for
HTTP errors), `updateBranch(n)` (REST `PUT /pulls/{n}/update-branch`, already
used at `github.js:421-429`), `viewerPermission()` (`gh api
repos/{o}/{r}` → `permissions.push`). Fields not verified here are marked
"verify at P4" in the plan's acceptance criteria.

---

## 10. Landing: readiness for `ready`, merge for `merged`

10.1 **Land locally** — unchanged `finalize()` (`finalize.js:59-172`): merge
onto integration under `merge.lock`, Guard 2, push, `openIntegrationPr`
find-or-create (`github.js:369-379`). Result gives `integrationSha` (landed head).

10.2 **Readiness on the standing PR** (§9). Ready → `ready` runs exit 0;
`merged` runs continue at 10.4. Not ready → classify → §7 chooser → usually
§10A. **Bounds (lead decision, review impl-B2):** every CI/readiness wait is bounded by
`automation.ciWaitMinutes`; each expiry consumes one **attempt**; head-moved
re-pins are capped at 3 per run; the one wait that consumes no attempt — a
loser blocked on `integration-repair.lock` (§10A) — is capped at 3 rounds per
run by `retries["repair-lock"]` (§7); therefore the whole standing-PR phase is
bounded by `(maxAttempts + 3 + 1) × ciWaitMinutes` plus repair time, and no
lock is held while waiting (§12).

### 10A. Integration repair (shared by `ready` and `merged`)

Applies when the standing PR is `BEHIND`, `CONFLICTING`, or its checks are red
— whether or not this run caused it (owner decision 17); under `ready` too,
because `ready`'s goal is "the standing PR is green for our landed head" and
nothing else can make it so (lead decision, review fidelity-B1). Each repair is one
attempt. Lock discipline is §12: agent work happens in a **scratch worktree**
outside `merge.lock`; only the short git write into the integration worktree
takes `merge.lock`. **Serialisation between runs (review impl-M2):** before
starting any repair — resolver-driven or not, so `REMOTE_BEHIND`'s
`updateBranch` + reconcile + gate is included — the run takes the
**non-blocking** `integration-repair.lock`
(`acquireLock`, `lock.js:10`); if a peer holds it, this run starts no agent,
spends no attempt, and instead polls readiness (free retry, `ciWaitMinutes`)
and re-classifies once the peer's push lands — one repair per red state, not N.
The winner holds the lock until *after* its ff/push, not merely for the agent
stage (§12) — released earlier, the loser would see it free before the push had
landed and resolve the same red state a second time. The loser's polling is
itself bounded: each round counts against the per-run free-retry counter
`retries["repair-lock"]` (cap 3, §7's `REMOTE_BEHIND`/`REMOTE_CONFLICTING`/
`REMOTE_CI_RED` row). When that cap is exhausted the class is handled as if the
free retry were spent (§7): the run consumes one attempt and re-enters
classification, which takes the repair itself if the lock is now free — a dead
peer's lock is stolen by `acquireLock`'s stale-pid path (`lock.js:18-33`) — or
`ask`. Without the cap a loser could poll for as long as the peer's agent stage
lives (`stageTimeout` can exceed `ciWaitMinutes`) while touching neither
counter, which §7 forbids.

- `REMOTE_BEHIND` → `updateBranch(n)` (GitHub creates a merge commit of base
  into `origin/<integration>`), then under `merge.lock`:
  `git.reconcileIntegrationToOrigin` (`git.js:341-372`) so local integration
  follows; then **re-run the local gate on the new integration tip** (Guard 2
  semantics, `gate.run(testCmd, integrationWorktree)`) before re-checking
  readiness (review impl-B4: GitHub's merge commit was never tested locally).
- `REMOTE_CONFLICTING` / `LAND_DIRTY_MERGE` on integration → create scratch
  worktree at `origin/<integration>`; `git merge origin/<base>`; on conflict
  spawn a resolver author (`automation.conflictResolvers` or the run's author)
  with the conflict file list — today's `resolveIntegrationConflict`
  (`cli.js:680`) reshaped: gate + security scan on the resolution diff always;
  if any conflicted path is outside `automation.conflictAutoPaths`, one
  reviewer audit round on the resolution diff (advisor decision A6); a
  protected path in the diff → `POLICY_PROTECTED_PATH` → 3. Then under
  `merge.lock` (nested inside the still-held `integration-repair.lock`, §12):
  fast-forward the integration worktree to the scratch result
  (`git merge --ff-only`; if integration moved meanwhile → repeat the scratch
  merge once, free retry) and push (plain; non-ff rejection → repeat once).
- `REMOTE_CI_RED` on integration → same scratch-worktree flow with the `rebase`
  repair prompt (fix the named red check), gate + scan (+ audit round outside
  `conflictAutoPaths`), ff under `merge.lock` (nested inside the still-held
  `integration-repair.lock`, §12), push.
- After every push to integration, readiness **and any local gate result** are
  **invalidated** and re-read/re-run for the new head (§9, §10.4); nothing
  merges on a stale observation.

10.3 *(merged from 10A — kept as a pointer so cross-references stay stable.)*

10.4 **Merge, head-bound (`merged` only). Hard rule (lead decision, review impl-B4):**
the merge phase runs **entirely under `standing-pr.lock`** (§12) in this order,
and every step binds to one `headSha`:
1. fresh `git fetch origin <integration> <base>`; **final readiness read** (§9),
   which may re-pin `headSha` once more (counter/cap as §9 rule 2);
2. if the repo has **no required checks** (`requiredChecks.known &&
   contexts.length == 0`): under `merge.lock` (nested — see §12 order), pin the
   integration worktree to the merge target **explicitly** — `git fetch origin
   <integration>`, then `git checkout --detach <headSha>` in the integration
   worktree, asserting `git rev-parse HEAD == headSha` before gating. If
   `origin/<integration>` has already moved past `headSha`, do not gate: release
   both locks and return to step 1 to re-pin, charging the same re-pin counter
   as a 409 (§9 rule 2, cap 3) so this cannot loop. Before `merge.lock` is
   released the worktree is returned to `<integrationBranch>` — §10A's repair
   does `git merge --ff-only` and pushes on that branch, and a detached HEAD
   left behind would break it. (`git.reconcileIntegrationToOrigin`,
   `git.js:341-372`, is the wrong call *here*: it takes no sha and
   fast-forwards to origin's tip **at fetch time**, so a peer push between the
   readiness read and the fetch would silently gate a head that is not
   `headSha` — safe, because the `PUT` then 409s, but it wastes a gate run under
   two locks and can mis-attribute a red result to the wrong head. Keep it for
   `finalize` and §10A, where "follow origin" is the intended semantic.) Then
   the local gate (Guard 2) on that pinned tree —
   green → continue; red → release both locks, classify
   `LAND_INTEGRATION_TEST` on integration → §10A; **any re-pin invalidates a
   prior gate result** — a gate result is valid only for the `headSha` it ran
   on, so a 409 that leads to a re-pin returns to step 1 and re-gates (review
   impl-NEW-B1). If required checks are **unknown** (403) → release, `ask`;
3. the merge request for exactly `headSha`: `gh api -X PUT
repos/{o}/{r}/pulls/{n}/merge -f merge_method=merge -f sha=<headSha>` (the
transport is today's `mergeDirect`, `github.js:16-20`; chosen over `gh pr merge
--match-head-commit` because `gh pr merge` runs a client-side mergeability
precheck that does not know about ruleset `bypass_actors`, `github.js:10-15`),
wrapped by `mergePrHeadBound`, which maps the HTTP status parsed from the
`execFileSync` error (review impl-M3):
- 200 → `merged` with `sha` (merge commit).
- 409 → `head-moved` → release both locks, back to 10.2 (re-pin counter +1; cap 3); a prior gate result is discarded.
- 405 → **do not trust the message text**: release the lock, re-read readiness
  once; if `reviewDecision == REVIEW_REQUIRED` (or `mergeStateStatus ==
  BLOCKED` with green checks) → `REMOTE_REVIEW_REQUIRED` → `ask` on the standing
  PR ("ready to merge; approve it, or reply `orch: abandon`") and wait (§8d);
  if checks are pending/red → back to 10.2; if the PR is already merged/closed
  → 10.5 verify; otherwise `REMOTE_MERGE_REJECTED` with the body → `BLOCKED`.
  (Message strings such as "At least 1 approving review is required" may be
  *logged* for humans; they never drive control flow.)
- 401/403 → `REMOTE_AUTH` → free retry once after 30 s → `BLOCKED`.
- anything else → `REMOTE_MERGE_REJECTED` → `BLOCKED` with the body. Nothing is
  swallowed (fixes #504). Each request is journaled in `merge.requests[]` with
  an ordinal.

**Premise: `origin/<integrationBranch>` is append-only (review NEW-B1).** The
head-binding argument — that no head can be merged which the local gate did not
run on — holds only because that ref never moves *backwards*. It doesn't, in
orch: every writer of it is a plain, non-forced push (`github.js:368`, §10A's
repair push, §11's "a real push rejected non-ff is `LAND_HEAD_MOVED`, never
force"), and the source contains no force-push at all — the only `--force` in
`src/` is `git worktree remove --force` (`git.js:239,296,431,453`). Given that,
any head other than `headSha` is *ahead* of it, and the `sha=<headSha>` binding
rejects the merge with a 409 rather than merging something ungated. A human
force-push to the integration branch out of band would invalidate the argument;
note that `reconcileIntegrationToOrigin` deliberately tolerates one for the
*remote-tracking* ref (`git.js:347`, `+<branch>:<ref>`, "a force-pushed origin
should still land here as data"), so the situation is anticipated even though
orch never causes it. It is not silently unsafe: the run re-reads and re-gates
through the ordinary moved-head route — the 409 above, accounted as a re-pin,
and surfaced as `LAND_HEAD_MOVED` in §7.

Never `squash`/`rebase` for the standing PR (repo rule; the repo also disables
them). `github.mergeMethod` applies only to per-cycle (`landing: pr`) and
foreign PRs.

10.5 **Verify.** `git fetch origin <base>`; `git merge-base --is-ancestor
<mergeCommit> origin/<base>` and `… <reviewedSha> origin/<base>`; both must be
true. Then fast-forward local base (`syncMainFromOrigin`, `git.js:207-234`) and
run the existing tidy (`complete.js finishRun`, `interactive:false`). Record
`merge.verifiedAncestorAt`. Only now: outcome `reached`, exit 0; for `issue`
runs the issue closes via GitHub's `Closes #n` in the standing PR merge (today's
mechanism, README:162) — orch additionally posts a final comment.

10.6 **Config interaction.** `main.autoMerge` and `github.autoMergePr` are
removed (§15); their code paths in `openIntegrationPr` (`github.js:440-442`
native auto-merge, `482-490` direct merge) are **bypassed whenever a v2 run is
active** — from P8, the slice that ships `--until merged` — and deleted in P12,
so the only merge path is 10.4. The bypass matters before the deletion lands:
both paths are called from `openIntegrationPr` under `merge.lock`
(`finalize.js:236`), i.e. outside `standing-pr.lock`, so leaving them live would
let a merge of the standing PR happen behind 10.4's back and outside its
head-binding.

10.7 `landing: pr` variant: the per-cycle PR (`openPr`, `github.js:308-344`,
made find-or-create) is the target; readiness expects `head == reviewedSha`;
merge uses `github.mergeMethod`; verify by ancestry of the merge/squash commit
plus `git diff --quiet <reviewedSha> origin/<base> -- <changed paths>` (content
check, since a squash mints a new SHA). Kept only while open Q1 is open.

10.8 `integrationBranch == baseBranch`: no standing PR exists; `ready` ==
landed + local Guard 2 green + push ok; `merged` == `ready` (advisor decision:
the repo already opted out of the checkpoint, README:169).

---

## 11. `pr <number|branch>` unification

| Input | Resolution |
|---|---|
| all digits | GitHub PR number: `gh pr view --json headRefName,headRefOid,headRepositoryOwner,baseRefName,isCrossRepository,maintainerCanModify,isDraft` |
| otherwise | local branch name (must exist as `refs/heads/<x>` or `refs/remotes/origin/<x>`); if an open PR has that head, attach to it |

Behaviour by `--until`:
- `once`: audit only (today's `orch review` / `orch pr` without `--merge`): one
  review-mode cycle (`mode:"review", noMerge:true`, `github.js:178-183`), one
  comment (marker-guarded, edited in place on later runs — fixes the `runPr`
  comment spam, audit-landing #3), exit 0 if AGREE+green else 2 (3 for
  policy/security).
- `ready`: repair until green. **Repair authority (lead decision, review impl-M8):**
  orch pushes repairs to the PR head **only if** `isCrossRepository == false`
  **and** the head branch is in orch's own namespace (`pr/*` task branches or a
  branch this repo's run records own) **and** `viewerPermission().push == true`.
  Every other head (a colleague's same-repo branch, any fork even with
  `maintainerCanModify`) gets a repair branch `pr/repair/<n>-<runId>` created
  from the PR head; orch repairs there, runs the full audit + gate + readiness
  on that branch, and posts one marker comment linking it — it never rewrites a
  ref it does not own. A real push rejected non-ff is `LAND_HEAD_MOVED` (never
  force). Draft foreign PRs are "not ready" by definition (open Q3, proposed
  yes). Then readiness (§9) on the PR itself with `expectedHead` = the last
  reviewed SHA.
- `merged`: `ready` then head-bound merge of *that* PR with `github.mergeMethod`
  (the one place squash may be used, if the repo allows), verify by ancestry
  (+ content check for squash, §10.7). This adds the CI/mergeability check
  `runPr` lacks today (`github.js:163-247`). A foreign PR is never re-landed on
  integration.
- If `<number>` is the standing integration PR itself: `once` audits it;
  `ready`/`merged` behave as §10.2–10.5 (readiness/repair/merge of the standing
  PR without a new task cycle).

Head pinning: every audit round records `reviewedSha`; a push by someone else
between audit and merge → 409 → re-audit the new head (attempt consumed only if
orch has to repair again; re-pin cap 3).

---

## 12. Concurrency and locks

**One lock scheme (lead decision, review impl-B3), stated once here and referenced
everywhere else:**

| Lock | File | Guards | Held for | Timeout |
|---|---|---|---|---|
| `.orch/lock` (existing) | `.orch/lock` | the coarse "one cycle per checkout" guard, and the **outermost** lock: taken for the whole of `orch pr <n>` (`acquireLock(orchDir)`, `cli.js:1728`, released `cli.js:1738`) — so a `pr <standing-pr-number> --until merged` (§11) holds it while it runs §10.2–10.5. `task`/`issue` runs do **not** take it; they are serialised by the `concurrency` cap and the inflight registry (`cli.js:1489-1493`) | the whole command, agent stages included | none (non-blocking `acquireLock`; already held → "another cycle is running"); stale-pid steal as `lock.js:18-33` |
| `merge.lock` (existing) | `.orch/merge.lock` | **every mutation of the integration worktree/branch**: `finalize` landing (`finalize.js:83-171`), Guard 2, push, and v2's ff/push step of integration repair (§10A) | seconds–minutes (git + one gate run; **never** an agent stage) | `acquireBlocking` 300 s (`lock.js:58`); waiter that times out → `LAND_LOCK` |
| `standing-pr.lock` (new) | `.orch/standing-pr.lock` | **only the GitHub merge phase** of the standing PR: final readiness read, the no-required-checks local gate, `PUT …/merge`, post-merge verify (§10.4–10.5) | seconds, or one gate run when the repo has no required checks | `acquireBlocking` `gateTimeout + 5 min`; timeout → `LAND_LOCK` free retry, then `ask` |
| `integration-repair.lock` (new) | `.orch/integration-repair.lock` | starting **any** §10A repair of the integration branch, resolver-driven or not (`REMOTE_BEHIND`'s `updateBranch` + gate included) — **non-blocking** `acquireLock`; a loser polls readiness instead | one whole repair: the agent stage **and** the ff/push that follows it, the latter under nested `merge.lock` (§10A) — the lock is released only after that push | none (non-blocking); stale-pid steal as `lock.js:18-33` |
| (none) | — | agent work: conflict resolution, repair authoring, reviews — always in a **scratch worktree** (`git worktree add <tmp> origin/<integration>`) or the task branch worktree | minutes | `stageTimeout` |

Rules: there is one **total acquisition order**, and it is a legality
constraint — a lock may be taken while holding any lock to its left, never one
to its right:

**`.orch/lock` → `standing-pr.lock` → `integration-repair.lock` → `merge.lock`**

Two of those edges are actually exercised. `standing-pr.lock → merge.lock` is
the §10.4 step-2 gate. `integration-repair.lock → merge.lock` is a repair's
ff/push (§10A), and it is **not optional**: `integration-repair.lock` is the
outermost lock of a repair — taken before the resolver starts and released only
*after* the repair's push — because releasing it before the push re-opens the
race it exists to close (a losing peer would find the lock free while the
winner's push had not yet landed, and start a second resolver on the same red
state). The `standing-pr.lock → integration-repair.lock` edge is legal but
unused: §10.4 releases `standing-pr.lock` before classifying into §10A
(gate red, and 409 head-moved), so no repair ever runs under it. Never the
reverse of any edge — nothing holding an inner lock ever waits for an outer
one, and `finalize`'s landing (`finalize.js:83-171`) holds only `merge.lock`.
No lock is held across an agent stage except `integration-repair.lock` (that is
its purpose) and the coarse `.orch/lock`; every lock above is released in
`finally` on every exit path (including the SIGTERM handler, §13); readiness
polling and CI waiting hold **no** lock (the coarse `.orch/lock` excepted: under
`orch pr` it spans the command, waits included, which is why nothing else may
block on it); a `head-moved` (409) releases
`standing-pr.lock` before re-checking so a peer that *can* merge is not
starved. `releaseLock` re-reads the lock file and removes it only if `pid ==
process.pid` (engine H5, `lock.js:50-52`); `gate.run` gains `timeoutMs =
cfg.gateTimeout*60e3` (spawnSync `timeout`, `killSignal: SIGKILL`) so a hung
gate cannot pin `merge.lock` (#505) — a timeout is `TEST_RED` "gate timed out".

- **Cycles vs cycles:** unchanged — `concurrency` cap (`cli.js:1489-1493`),
  overlap detection and Tier-1 redrive (`finalize.js:119-151`, `285-395`). A
  v2 run demoted with `LAND_OVERLAP` first lets the existing redrive act (the
  peer redrives us), polling its own branch state up to `ciWaitMinutes` (one
  free retry); if still not landed → `rebase` remedy.
- **Two `--until merged` runs racing for the standing PR:** the second, on
  acquiring `standing-pr.lock`, re-reads the PR: already merged and its
  reviewed SHA an ancestor of `origin/<base>` → `reached` (`mergedBy:
  "external"`); else it proceeds normally with a fresh readiness read.
- **Poller + interactive:** poller runs are ordinary `orch issue … --until
  ready` processes; their question comments never mention `@orch-bot`, so they
  cannot re-trigger the poller.

---

## 13. Headless output contract

- stdout: with `--json`, one JSON object per line (§3), nothing else, **except
  `dashboard --json`, whose single-snapshot shape is unchanged** (out of scope);
  without `--json`, terse human lines (one per event, ≤ 120 chars, no colour
  unless TTY per `colorEnabled`, `tui/theme.js:48-50`). No banner
  (`maybePrintRunBanner`, `cli.js:861-866`, deleted).
- stderr: diagnostics, update-notifier (`update-check.js:125,135`), warnings.
- No prompts on the run path: `finishRun` runs with `interactive:false`
  (leaves unmerged branches, lists them); `agent add` builds only with `--build`.
- Final line (human mode): `orch: <outcome> — <one-line reason>; exit <code>[;
  resume: orch continue <runId>]`. `run.end` always carries `blockedReason` when
  `exit == 3` (values: `guardrail-path`, `security-finding`, `no-channel`,
  `cannot-verify-authorization`, `merge-rejected`, `auth`, `human-abandon`,
  `concurrency-cap`) so a scheduler can tell "retry later" from "never
  unattended" (review impl-m13).
- **`--detach` lifecycle (lead decision, review impl-M10):**
  - parent: `spawn(process.execPath, [bin/orch.js, ...argv minus --detach],
    {detached: true, stdio: ["ignore", logFd, logFd], env: {...process.env,
    ORCH_DETACHED: "1", ORCH_DETACH_LOG: <path>}})`, `child.unref()`; log path
    `<automation.detachLogDir>/<YYYYMMDD-HHMMSS>-<pid>.log`, **no rotation, no
    size cap** (stated: a run's log is bounded by the run; the operator prunes
    the directory); the parent waits ≤ 5 s for either (a) the child's run
    record with `detached.pid == child.pid` → prints `{event:"run.detached",
    pid, log, runId}` (JSON) or one human line, exits **0**; or (b) the child
    exiting inside the window → prints the last 20 log lines to stderr and
    exits with the **child's exit code** (a usage/preflight failure is not
    hidden from cron);
  - child: writes its run record and inflight entry (`detached:true, log,
    runId`) first; survives the parent's SIGINT/terminal close (detached +
    unref, own session on POSIX); on **SIGTERM/SIGINT/SIGHUP** the record
    write `interrupted:{at, signal}` and the lock release happen **inside the
    existing `process.once` handler** of `cli-adapter.js:30-36`, synchronously,
    *before* it kills live child agents and re-raises the signal at itself
    (registration order is therefore irrelevant — one handler does all three);
    the process then dies by the re-raised signal without touching git/GitHub; `orch continue <runId>` resumes it after death;
  - no `attach`/`kill`/`logs` commands in v0.5 (idea doc's minimal variant);
    `tail -f <log>` and `kill <pid>` are the operator's tools; the dashboard
    lists the child as live by pid (`inflight.listLive`, `inflight.js:49-57`)
    with no dashboard code change. Windows: `detached:true` +
    `windowsHide:true`; same contract.

---

## 14. Security

### 14.1 Env allowlist for adapter subprocesses (P0)

`cli-adapter.js:216-218` changes to `env: buildAdapterEnv(adapter, runOpts,
cfg)`. The child env is the union of:

1. **Base set** (every adapter): `PATH HOME USER LOGNAME SHELL LANG LC_* TERM
   TMPDIR TMP TEMP TZ XDG_* SSL_CERT_FILE SSL_CERT_DIR HTTP_PROXY HTTPS_PROXY
   NO_PROXY http_proxy https_proxy no_proxy SSH_AUTH_SOCK GIT_AUTHOR_* GIT_COMMITTER_*`
   (no `ORCH_*`: the only `ORCH_*` reads in adapter code, `ORCH_PROGRESS_INTERVAL_MS`
   and `ORCH_STAGE_TIMEOUT_MS`, happen in the parent, `cli-adapter.js:48,61`) — `HOME` is what lets every CLI find its own login store (`~/.claude`,
   `~/.codex`, `~/.copilot`, `~/.gemini`, `~/.kimi`, `~/.claude-code-router`),
   which is the normal auth path for all of them; `SSH_AUTH_SOCK` so an agent's
   `git fetch` over SSH works. `NODE_OPTIONS` is deliberately excluded (code
   injection into Node-based CLIs).
2. **Adapter `envKeys`** — declared per adapter file (P0 fills this table by
   running each adapter once under a scrubbed env and recording what it needs;
   entries marked *verify* are the advisor's best reading of each CLI's docs and
   must be confirmed at P0):

| adapter (`src/adapters/`) | bin | `envKeys` (proposed; P0 verifies) |
|---|---|---|
| `claude.js` | `claude` | `ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL ANTHROPIC_MODEL CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_* CLAUDE_CONFIG_DIR` |
| `codex.js` | `codex` | `OPENAI_API_KEY OPENAI_BASE_URL CODEX_HOME` *verify* |
| `copilot.js` | `copilot` | `COPILOT_GITHUB_TOKEN` only (see below), `COPILOT_*` *verify* |
| `gemini.js` | `gemini` | `GEMINI_API_KEY GOOGLE_API_KEY GOOGLE_CLOUD_PROJECT GOOGLE_CLOUD_LOCATION GOOGLE_APPLICATION_CREDENTIALS GOOGLE_GENAI_USE_VERTEXAI` *verify* |
| `grok.js` | `grok` | `XAI_API_KEY GROK_*` *verify* |
| `kimi.js` | `kimi` | `KIMI_API_KEY MOONSHOT_API_KEY KIMI_*` *verify* (subscription login lives under `HOME`) |
| `zai.js` | `claude` | `ZAI_API_KEY` (read in the parent for the `ANTHROPIC_AUTH_TOKEN` getter, `zai.js:10-16`) plus the `claude` set |
| `local.js` (×3 models) | `ccr` | the `claude` set plus `CCR_*` *verify* (ccr reads `~/.claude-code-router/config.json` under `HOME`) |
| `agy.js` | `agy` | none (permanently disabled adapter, `agy.js:36-43`) |

3. **`env.passthrough`** from `orch.yml` — the operator's escape hatch for
   *every* adapter (e.g. a corporate proxy var, an unlisted provider key).
   Validation: `/^[A-Z_][A-Z0-9_]*$/`, and it may **never** name
   `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `ORCH_APP_ID`,
   `ORCH_APP_PRIVATE_KEY`.
4. The adapter's own `env` overrides (`mergeAdapterEnv`, `cli-adapter.js:18-25`,
   e.g. zai's getter) — applied last **among the four sources**.

**Never**, from any source — applied **last**, as a hard filter over the union of
all four sources above (so a key admitted by a pattern or by `passthrough` is
still removed): `GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN ORCH_APP_* AWS_*
npm_config_* NODE_OPTIONS`.

**Copilot conflict and its resolution.** The Copilot CLI is a GitHub client by
construction and, when not logged in via `copilot login` (token under `HOME`),
reads a GitHub token from the environment; the vars it documents include
`COPILOT_GITHUB_TOKEN`, `GH_TOKEN` and `GITHUB_TOKEN` (*verify at P0*). Because
`GH_TOKEN`/`GITHUB_TOKEN` are the very variables that would leak orch's
repo-scoped App token to an untrusted author, they stay banned for every
adapter. The operator who wants env-based Copilot auth exports a **separate,
Copilot-scoped** token as `COPILOT_GITHUB_TOKEN`; the adapter declares that key;
orch never sets or copies it from `GH_TOKEN`. If P0 finds the CLI does not
honour `COPILOT_GITHUB_TOKEN`, the documented answer is `copilot login`
(HOME-based) — the adapter is then usable only with a persisted login, and
`config --check` says so. What is *not* acceptable is a passthrough of
`GH_TOKEN`.

`config --check` prints the effective allowlist per configured agent and warns
about keys present in the parent env that will be dropped. P0's tests assert,
per adapter, that its declared keys survive and that the banned set never
does. **Honest limit** (review impl-m8): the agent still gets `HOME` and `PATH`, so it
can invoke the operator's own logged-in `gh`; the allowlist removes *orch's
minted token and the ambient environment* from the agent, it does not sandbox
the agent — that is the prior design's execution broker, deferred (§18 A10).

### 14.2 The rest

- **`GH_TOKEN` scoping:** `cli.js:1205-1211`'s `process.env.GH_TOKEN = …` becomes
  a module-level token passed as `env: {...process.env, GH_TOKEN}` only to
  `ghShell` spawns (`cli.js:48-49`) — never process-wide.
- Guardrail floor unchanged (§2). What the loop can never do: proposal §4.5.
- Comment-command authorization: GitHub collaborator permission (§8d), cached
  per run; a failed permission read blocks rather than ignores; free-text
  replies are redacted, size-capped, and appended as data (never parsed as
  flags — the `--` rule from `mcp.js:112` applies to any text reaching argv).
- MCP: `until` validated against `["ready","once"]` unless
  `automation.mcpMayMerge`; the tool spawns the CLI with a fixed argv as today
  (`mcp.js:198`).

---

## 15. Configuration

Full v2 key table (`DEFAULTS` in `src/config.js`; validation in `validate()`;
"CLI" = flag that overrides for one run). Types: `str`, `int≥0`, `int>0`,
`bool`, `enum`, `list`.

| Key | Type | Default | Validation | CLI |
|---|---|---|---|---|
| `agents` | list(str) | `[claude, codex]` | non-empty, `/^\S+$/` each | — |
| `author` / `reviewer` | str\|null | null | both or neither; **string** when set (fixes config #2) | `--author/--reviewer` |
| `authors` / `reviewers` | list\|null | null | non-empty strings | `--authors/--reviewers` |
| `test` | str | `auto` | **non-empty string** (fixes config #1) | — |
| `roundCap` | int>0 | 3 | | — |
| `stageTimeout` | int≥0 (min) | 25 | | env `ORCH_STAGE_TIMEOUT_MS` |
| `gateTimeout` | int≥0 (min) | = `stageTimeout` | **new** | — |
| `baseBranch` | str | `main` | non-empty | — |
| `integrationBranch` | str | `orch/integration` | non-empty | — |
| `landing` | enum | `no-ff` | `no-ff\|ff-only\|pr` — **renamed from `merge`** | — |
| `concurrency` | int>0 | 4 | | — |
| `cheap.role`, `cheap.paths` | str\|null, list | null, [] | as today | `--cheap` |
| `scope.maxLines`, `scope.ignore` | int≥0, list | 0, [...] | as today | — |
| `security.ignore` | list | [] | as today | — |
| `github.mergeMethod` | enum | `squash` | `squash\|merge\|rebase`; applies to per-cycle and foreign PRs only | — |
| `automation.maxAttempts` | int≥0 | 3 | | `--max-attempts` |
| `automation.humanWaitHours` | number>0 | 24 | ≤ 720 | — |
| `automation.mcpMayMerge` | bool | false | | — |
| `automation.remedies` | list(enum) | `[rebase, rotate, reauthor, ask]` | subset of the four operator-orderable remedies, no duplicates; order = priority. `integration-repair` (§10A) is not listed because it is always on: disabling it would make `ready` unreachable whenever a peer reddens the standing PR | — |
| `automation.rotateModels` | map(agent→list(model)) | {} | models must pass `parseRoleSpec` capability check; **not** the #323 design (`FUTURE.md:10-14` rejected role specs *inside* `agents:` — the pool stays bare names; this is an ordered escalation ladder applied to the author/reviewer model field by the `rotate` remedy, i.e. the owner's "stronger model") | — |
| `automation.pollSeconds` | int>0 | 30 | | — |
| `automation.ciWaitMinutes` | int≥0 | 30 | | — |
| `automation.conflictResolvers` | list(role)\|null | null | role specs (was `main.conflictResolutionResolvers`) | — |
| `automation.conflictAutoPaths` | list | `[CHANGELOG.md, docs/index.html, package-lock.json, package.json]` | (was `main.autoResolveConflictPaths`) | — |
| `automation.detachLogDir` | str | `.orch/logs` | relative to repo or absolute | — |
| `env.passthrough` | list(str) | [] | `/^[A-Z_][A-Z0-9_]*$/`; may not name `GH_TOKEN`/`GITHUB_TOKEN` | — |
| `docs.autoUpdate`, `docs.prompt`, `docs.paths` | as today | | | — |
| `release.autoBump` | bool | false | | — |

Removed keys and the validation error text. **Pre-cutover (P11, 0.4.x) these are
warnings and the old key still works; from P12 (0.5.0) they are errors** —
`config --check` and every run's preflight print all of them, then exit 1:

| Removed | Message |
|---|---|
| `merge` | `orch.yml: 'merge' was renamed to 'landing' in v0.5.0 (same values). Rename the key.` |
| `main.autoMerge` | `orch.yml: 'main.autoMerge' was removed in v0.5.0. Merging is now a per-run goal: pass --until merged (poller/MCP: see docs/cli-v2-proposal.md §4.6).` |
| `github.autoMergePr` | `orch.yml: 'github.autoMergePr' was removed in v0.5.0. Native auto-merge is no longer used; --until merged merges when green.` |
| `main.conflictResolution`, `main.autoResolveConflicts` | `orch.yml: 'main.conflictResolution'/'main.autoResolveConflicts' were removed in v0.5.0. Conflict repair is a loop remedy under --until ready|merged; disable it with automation.remedies.` |
| `main.conflictResolutionResolvers` | `… moved to 'automation.conflictResolvers'.` |
| `main.autoResolveConflictPaths` | `… moved to 'automation.conflictAutoPaths'.` |
| `main` (block, if anything else remains) | `orch.yml: unknown key 'main.<x>'.` |
| `reviseCap` | `orch.yml: 'reviseCap' was removed in v0.5.0; use 'roundCap'.` |
| any other unknown key | `orch.yml: unknown key '<path>' (typo? see orch.example.yml).` — closed schema |

Example `orch.yml` v2 (what `orch init` writes, commented like today's
`orch.example.yml`):

```yaml
agents: [claude, codex]
test: auto
roundCap: 3
stageTimeout: 25
# gateTimeout: 25
baseBranch: main
integrationBranch: orch/integration
landing: no-ff                # no-ff | ff-only | pr   (was: merge)
concurrency: 4
github:
  mergeMethod: squash         # per-cycle (landing: pr) and foreign PRs only; the standing PR always uses a merge commit
automation:
  maxAttempts: 3
  humanWaitHours: 24
  mcpMayMerge: false
  remedies: [rebase, rotate, reauthor, ask]
  # rotateModels: { claude: [claude-opus-4-8] }
  pollSeconds: 30
  ciWaitMinutes: 30
  # conflictResolvers: [claude]
  conflictAutoPaths: [CHANGELOG.md, docs/index.html, package-lock.json, package.json]
  detachLogDir: .orch/logs
env:
  passthrough: []             # extra env keys adapters may see (never GH_TOKEN)
# scope: { maxLines: 0, ignore: ["*.lock", "dist/**", "*.snap"] }
# security: { ignore: [] }
# cheap: { role: qwen3-coder-30b, paths: ["*.md", "docs/**"] }
docs: { autoUpdate: false, prompt: "update documentation to reflect the latest merged changes", paths: ["*.md", "docs/**", "**/*.md"] }
release: { autoBump: false }
```

`orch config` output (human): each effective key with its source
(`default | .orch/orch.yml | --config-file | env`), then warnings (e.g.
"rotate disabled: only 1 usable agent"), then problems. `--json`:
`{command:"config", ok, config, sources, warnings, problems}`.

---

## 16. Telemetry / `runs.jsonl` additions

Every cycle still writes one `runs.jsonl` line via `notify.recordRun`
(`notify.js:61-65`) with today's fields. Added (all optional, additive):
`runId`, `attempt`, `until`, `failureClass`, `remedy` (the remedy that produced
this cycle), `exit` (on the run's last line), `outcome`, `readiness:{ready,
mergeStateStatus, checks}` (compact), `mergeCommit`, `mergedBy`, `humanWaitMs`,
`detached`. `redrive` `quietFail` paths (`finalize.js:195,209`) now also write a
line (`verdict:"merge-deferred", trigger, redrive:true`) — closes engine H3.
Dashboard metrics: `successRate` unaffected. `cleanUnattendedCycles`
(`kpi.json`, `notify.js:87-95`) is a **consecutive streak** reset by any
non-`merged`/`pr` verdict and by every `notify.escalate` — so intermediate
escalations inside a multi-attempt v2 run reset it and the new redrive lines
(`merge-deferred`) reset it too (review impl-M6/m10). `notify.js` is protected, so v2
leaves it alone and defines the programme's success metric over run records
instead (proposal §7): a run is *clean unattended* iff `outcome == "reached"`
and `human.replies` is empty.

---

## 17. Testing strategy

Unit (existing style, `node --test`, fake deps):
- schema/parser: every command × every flag → accepted/64 matrix generated from
  `SCHEMA` (one test loops over the schema; hand-written cases for the messages).
- run record: write/read/lookup by runId and by cycle sid; atomicity
  (crash-simulating writer); query-before-write for each primitive (§5.4); resume of a terminal run grants a fresh budget (§5.3).
- classifier: each of the 19 trigger→class rows in §6 (plus the 13 remote/human/internal classes) with a fake `runCycle`
  result; fingerprint stability (same failure twice → equal; different tests → differ).
- chooser: table-driven from §7 (class, history) → remedy; convergence rules;
  attempt accounting; `retry n` cap.
- readiness: fixture PR JSON for each `mergeStateStatus`, check states,
  `reviewDecision`, draft, closed, merged-externally, head-moved-still-ancestor,
  empty rollup × {required known-empty, required known-nonempty, unknown 403}.
- merge: fake `gh api` returning 200/405(variants)/409/401/403/500 → result
  discriminant; nothing swallowed.
- env allowlist: `buildAdapterEnv` never yields `GH_TOKEN`; adapter `envKeys`
  and `env.passthrough` pass; denylist wins over passthrough.
- ask: comment template + marker; reply parsing; permission gating (write vs
  read vs bot); `since` cursor; late reply on resume.

Fault-injection matrix (new `test/v2-faults.test.js`, fake git+gh with
scripted responses; each row asserts the terminal outcome, exit code, and that
the fake `gh` saw at most one create/comment/merge per idempotency key):

| Fault | Expected |
|---|---|
| crash after `cycle.end`, before classify | resume classifies from record → same remedy |
| crash after `remedy` journaled, before new cycle | resume starts the cycle once (attempt not double-counted) |
| crash after `createPr` was issued, before the record noted the PR | resume `findPrByHead` finds it; no second create |
| crash after `merge` requested, GitHub merged | resume verifies ancestry → 0, no second merge |
| crash after `merge` requested, GitHub did not merge | resume re-checks readiness for the exact head, requests again (`merge.requests[1].ordinal == 2`) |
| `gh` unavailable mid-run | `REMOTE_AUTH`/`no-channel` → 3, record intact |
| base moves between land and readiness | `REMOTE_BEHIND` → update-branch → ready |
| PR closed by human | `REMOTE_PR_CLOSED` → ask → reply/timeout |
| comment from read-only user / bot | ignored; wait continues |
| `orch: retry 2` from write user | maxAttempts +2 |
| quota 403 on author mid-cycle | `AGENT_QUOTA` → rotate excludes agent → cycle with other agent |
| quota on both pool agents | rotate skipped (not diverse) → ask |
| two runs `--until merged` racing | second sees external merge → 0; one merge request total |
| standing PR `BEHIND` under `--until ready` | integration repair (update-branch + local gate) → ready → 0 |
| repo has no required checks, `--until merged` | local gate runs on the exact integration tip before merge |
| stalemate at `roundCap: 3` → `rotate` | new cycle performs up to 3 fresh rounds |
| head moves 4 times during merge phase | re-pin cap → `ask`, no lock held while waiting |
| `continue <runId>` after exit 2 | fresh attempt budget; run proceeds |
| gate hangs > `gateTimeout` | `TEST_RED` (timeout), lock released |
| `--until once` + stalemate | exit 2, no remedy events, DECISION.md written |
| `--dry` on every mutating command | zero git/gh writes (fake deps assert) |

System (`test/cli.test.js` style, real git tmp repo, fake gh): one `--until
ready` happy path, one `merged` happy path incl. ancestry verify, one `pr
<branch>` repair path, `--detach` spawn (assert inflight record + log file).

Test migration: see plan §4.

---

## 18. Decision ledger (closed) and open questions

Owner decisions 1–23: proposal §10 (applied throughout). Advisor decisions made
in this design (owner may overrule per slice):

| # | Advisor decision | Reason |
|---|---|---|
| A1 | `ready` targets the **standing PR** (not a per-task PR) under `landing: no-ff\|ff-only` | one landing path; `merged` = `ready` + merge, not two topologies |
| A2 | Attempts are consumed by new agent work **and by each expired CI/readiness wait**; `ask` consumes none | keeps the loop's termination bound `(maxAttempts+1) × ciWaitMinutes` true; owner's "remedy rounds" reading kept for agent work |
| A3 | `orch: merge` is not a reply command | never widen authority from chat |
| A4 | Reply authorization = GitHub collaborator permission, no config name list | trust anchor stays in GitHub |
| A5 | `merged` on `REMOTE_REVIEW_REQUIRED` asks and waits (exit 4 on timeout) rather than exiting 3 immediately | unattended runs benefit from a human approving during the window |
| A6 | Integration conflict/red-CI repair: gate + security always; reviewer round unless confined to `conflictAutoPaths` | keeps "nothing lands unaudited"; generated files stay fast |
| A7 | Standing-PR phase serialised by new `standing-pr.lock` | reuse `lock.js`; avoids two runs double-merging |
| A8 | `landing: pr` kept as explicit opt-out; per-cycle PR is then the target | minimise churn; flagged as open Q1 |
| A9 | `integrationBranch == baseBranch` ⇒ `merged` == `ready` | repo already opted out of the checkpoint (README:169) |
| A10 | Prior design's execution broker / capability-isolated child not adopted; env allowlist instead | size; verifiable smaller step; left as future work |
| A11 | Run record is a new store (`.orch/run-records/`), checkpoint semantics untouched | dashboard heuristics and `continue` no-diff refusal keep working |
| A12 | `--detach`: thin spawn + inflight fields; no `attach`/`kill` commands | idea doc's minimal variant; dashboard untouched |
| A13 | Exit 3 covers `CONCURRENCY_CAP` (nothing attempted, nothing to resume) | not "stopped at cap"; a human/scheduler must decide when to retry |
| A14 | Env allowlist base set + per-adapter `envKeys` + `env.passthrough` | least privilege with an escape hatch |
| A15 | `--until` twice with different values → 64 | contradictory goals should not silently resolve |
| A16 | `--dry` rejected (64) on read-only commands | "honoured or rejected", never ignored |
| A17 | `reauthor` never splits into child runs in v0.5 | unspecified subsystem (states/budgets/resume); a human splits the issue (review impl-M5) |
| A18 | No side-effect journal; query-before-write + `askCommentId` + merge ordinal only | journal duplicated GitHub truth (review impl-M11) |
| A19 | `automation.rotateModels` kept as an escalation ladder on the model field | owner remedy "stronger model"; distinct from the #323 rejected pool-spec design (§15) |
| A20 | Fingerprint excludes tree/base/config | otherwise convergence can never trigger (review impl-M1) |
| A21 | Draft PR channel = `task` runs; `pr` runs use their PR | reading of decision 18, stated in §8d |

Open questions: proposal §10 (Q1 `landing: pr` survival, Q3 draft foreign
PRs). Q2 (`retry n` cap) is now decided in §7.
