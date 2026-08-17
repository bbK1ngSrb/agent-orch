> **SUPERSEDED (2026-08-17).** This document is kept as prior art only. It is replaced by
> `docs/cli-v2-proposal.md`, `docs/cli-v2-design.md` and `docs/cli-v2-implementation-plan.md`,
> which resolve its open decisions differently (single `--until ready|merged|once` flag, standing
> integration PR as the merge target, clean break at v0.5.0). Where the two sets disagree, the
> `cli-v2-*` set wins; the conflict list is in `docs/cli-v2-proposal.md` §9.

# CLI simplification proposal: outcome flags for unattended runs

**Status: design-only approval artifact; not implemented. The hash-bound verdict
is in `docs/cli-simplification-review-record.md`.**  
**Decision date:** 2026-08-16  
**Scope:** `task`, `issue`, `review`, and `continue`; compatibility treatment for
`pr --merge` is included.  
**Authority:** this document never authorizes a code change or production rollout.

---

## 1. Executive decision

Keep the existing input-oriented commands and add two mutually exclusive,
command-independent **outcome policies**:

```console
orch task "fix the retry race" --auto
orch task "fix the retry race" --approved
```

- `--auto` means: **exhaust safe, bounded remedies and prepare one dedicated
  pull request; never merge it.** Success is an exact-head PR that GitHub says
  is ready to merge.
- `--approved` means: **the invoking operator authorizes this run's exact,
  independently validated, green PR to merge once every local and remote gate
  passes and the provider can atomically bind the request to both the expected
  head and intended base.** It runs the same solver as `--auto`; it is not a
  review, test, security, branch-protection, or ruleset bypass. If the provider
  lacks that atomic primitive, orch still prepares the PR but must stop before
  merge.

On `pr`, `--approved` is authority-only: orch audits the supplied foreign head,
never repairs it, and merges only if the same exact-head/exact-base readiness
and provider-capability proof holds. The solver journey applies to `task`,
`issue`, `review`, and `continue`.

The flags are alternatives. `--approved` includes the automated journey, so a
user never types `--auto --approved`.

Both modes use one **task-scoped outcome PR in v1**, targeting
`automation.prBase` (default: the configured `baseBranch`, normally `main`),
even when the repository's legacy no-flag flow uses a shared integration PR. A
task-scoped approval cannot safely merge a shared PR that may contain unrelated
tasks. Task, issue, and repaired-review runs create an orch-owned dedicated PR.
An unchanged green review may reuse one existing PR only when its source
provenance, base, and exact head match; when none exists, orch creates an owned
publication branch at that same reviewed commit and opens the dedicated outcome
PR from it—but only after complete discovery also finds no ineligible exact-PR
ownership conflict. The configured standing integration branch/PR and every
other known shared aggregation PR are categorically ineligible for all outcome
entries, including `review` and `pr`; they stop without mutation. Existing
invocations without either flag retain their current configured landing
behavior, except for the deliberate bare-`review` correction described in §8.

No `solve`, `retry`, `wait-ci`, `open-pr`, `approve`, or `merge-task` command is
added. Recovery uses the command that already exists:

```console
orch continue <sid> --auto
orch continue <sid> --approved
```

This is command reduction by **outcome**, not by hiding materially different
input sources behind an ambiguous positional grammar.

---

## 2. Why change the interface

The current interface exposes lifecycle steps through several paths:

- `task`, `issue`, and `review` enter the cycle differently;
- `continue` reconstructs an interrupted cycle;
- `pr --merge` is the only explicit CLI merge-authority signal;
- config can separately enable per-PR or integration-PR auto-merge.

The result is easy to start but hard to finish unattended. A human must infer
whether an escalation is repairable, decide which command resumes it, find the
right PR, wait for remote checks, and distinguish local integration from a real
base-branch merge.

The live baseline on 2026-08-16 illustrates the gap. `orch dashboard --json
--limit 5` reported 332 recorded runs, a 42.8% recorded success rate, and zero
clean unattended cycles. The most recent three failures were deterministic
security escalations. Those figures are directional rather than a trustworthy
SLO: current telemetry counts some local integration outcomes as merged even
when base-branch publication is incomplete (`src/finalize.js:233-279`,
`src/notify.js:87-94`). Correcting that vocabulary is part of this design.

Three source-level inconsistencies make a flag-only patch unsafe:

1. Help says `review` audits without merging, while its green runtime path can
   finalize (`src/cli.js:1458-1472`, `src/cli.js:1820`,
   `src/engine.js:334-355`).
2. `continue` loses the original entry mode and task text and reconstructs a
   task-mode run from the branch name (`src/cli.js:1638-1661`).
3. A green local cycle, a published PR, a GitHub-ready PR, and a base-merged PR
   are currently collapsed into statuses whose names overclaim the evidence
   (`src/finalize.js:65-84`, `src/finalize.js:233-279`).

The design therefore introduces one normalized run policy and truthful states,
then puts both flags on top of that foundation.

---

## 3. Goals and non-goals

### Goals

1. One command takes a task, issue, branch review, or interrupted SID as far as
   available authority and evidence safely allow.
2. Repairable escalations trigger diagnosis and bounded solution attempts
   instead of an immediate stop.
3. Unrepairable escalations stop with a precise evidence packet and an exact
   resume command; they never loop forever or claim success.
4. `--auto` can never merge or request a future merge: it cannot arm native
   auto-merge, enqueue a merge, reach either legacy auto-merge path, or expose a
   provider-write capability to an author, reviewer, or test child.
5. `--approved` can merge only the exact reviewed head into the exact intended
   base after all local and remote requirements and an atomic provider
   head/base condition are proven green.
6. Runs are resumable and remote side effects are idempotent.
7. Human output, exit codes, run records, dashboard status, and future JSON
   output tell the same truth.
8. Existing no-flag behavior remains compatible during the v1 rollout.

### Non-goals

- Guaranteeing that every task can be solved autonomously.
- Bypassing deterministic security findings, protected paths, required reviews,
  CI, merge queues, or GitHub branch protection.
- Treating an LLM `AGREE` verdict as human approval.
- Persisting `approved: true` in repository configuration.
- Building the planner/DAG/breakfast-queue system described in
  `docs/headless-overnight-design.md`. This proposal supplies the safe
  single-unit runner that that later design can schedule.
- Adding background process supervision or a new batch command.

---

## 4. User-facing contract

### 4.1 Examples

```console
# Prepare a dedicated PR, solve repairable failures, never merge.
orch task "add retry jitter" --auto
orch issue 482 --auto
orch review pr/codex/retry-jitter --auto
orch continue 3457862-0 --auto

# Do the same work, then merge only after every gate is green.
orch task "add retry jitter" --approved
orch issue 482 --approved
orch review pr/codex/retry-jitter --approved
orch continue 3457862-0 --approved
```

### 4.2 Outcome matrix

| Command | `--auto` | `--approved` |
| --- | --- | --- |
| `task` | Author, review, repair, verify, publish/find a dedicated PR, wait for remote readiness, stop. | Same journey, then merge and verify the exact PR head on the resolved landing base. |
| `issue` | Same as task; preserve issue provenance with `Refs #N`; do not close the issue. | Close through the API only after the configured landing base contains the verified merge. |
| `review` | Audit the pinned branch. If it needs repair or lacks a configured deterministic release change, create an orch-owned child/publication branch, apply the change, and fully revalidate it; never mutate, merge, close, or delete the supplied branch/PR. Otherwise reuse one source-provenance-matching exact-head/exact-base PR, or create an owned publication ref at the reviewed commit. | Merge only the outcome PR's exact fully validated artifact: the repair/publication-child PR or the eligible matching existing PR that already satisfies generated-release policy. |
| `continue` | Resume the stored command, task/work order, budgets, evidence, branch, and PR; stop at ready. A bare continue inherits a stored `--auto` policy. | Re-run all invalidated gates, accept merge authority for this invocation, then merge and verify. Stored approval authority is never inherited. |
| `pr` compatibility entry | Invalid: a supplied PR is already published. | Allocate a SID, audit without repair, require the supplied base to equal `automation.prBase`, exclude shared aggregation PRs, prove any configured generated-release change is already present, and use the same exact-head/exact-base capability-gated merge path. Missing policy/capability stops manual; deprecated `--merge` is a warning alias. |

A bare `continue` of a run originally started with `--approved` resumes with
the safe `--auto`/`pr-ready` outcome. The user must pass `--approved` again to
authorize a new merge attempt. It may still reconcile a previously journaled
immediate request: verify a merge that already happened, or report the actual
current PR state (`pr-ready` only when readiness still holds) without repeating
the request.

In review mode, a repair or publication child is the sole merge target and the
supplied PR is never merged. Only when no child is needed may `--approved`
select and merge one unchanged exact-head/exact-base foreign PR, after the same
generated-release and full readiness proof, without pushing its ref or rewriting
its metadata.

An exact commit SHA proves content identity, not PR ownership. `pr --approved`
selects only its supplied PR number; unchanged child-free review may reuse only
the PR belonging to its immutable supplied source provenance; task, issue, and
every repair/publication-child path accept only this SID's claim-, nonce-,
creator-, and journal-proven orch-owned PR. A visible SID marker is an index,
not ownership authority. Any other exact foreign candidate stops
`manual-action-required`, is listed, and is never created around, reopened,
updated, or merged.

If another actor merges an `--auto` outcome PR while orch is watching, orch
verifies and truthfully reports that external merge but does not claim it or
count it clean-unattended. `issue --auto` still never closes the issue; automatic
issue closure belongs only to the `--approved` outcome after verified landing.
Queue-only repositories stop `manual-action-required` in v1 because neither flag
enqueues a deferred merge.

External completion has a different evidence shape from an orch-requested
merge. It records `mergeRequestedByOrch: false`, no authority/request ordinal,
and `preRequestBaseOid: null`; it records the actual provider merge method and
merge-time base only when derivable, plus mandatory current-base ancestry.
Those records never claim that orch's strict-rule proof governed another
actor's request. An orch-requested merge, including later reconciliation of its
journaled request, must retain the non-null request/base evidence.

Orch-created outcome PRs use non-closing `Refs #N` links. A reused foreign PR is
not rewritten, so provider-native closing keywords in its existing body may take
effect when another outcome path merges it. Orch discloses and attributes that
as an external provider action and never repeats an observed closure through its
own issue API.

### 4.3 Definitions shown to users

- **`validated`** — all required agent reviews, the configured local test gate,
  deterministic security scan, and protected-path check passed against one
  pinned head.
- **`pr-open`** — the exact head has an idempotently found or created PR. Remote
  policy is not yet proven.
- **`pr-pending`** — a required check, review, or mergeability computation is
  still pending and may still become green within the remote wait budget; it
  never means orch enrolled the PR in a queue. A review that is impossible for
  this run to obtain is `manual-action-required`, not pending.
- **`pr-ready`** — the expected head is current with the landing base and GitHub reports it
  mergeable with all required checks and reviews satisfied.
- **`merge-pending`** — orch durably submitted one exact-head ordinary merge
  request but its effect is genuinely unresolved, or GitHub reports `MERGED`
  while landing-base ancestry is still being re-fetched.
  During a live invocation orch polls only within the remote wait budget. If the
  request's result is still genuinely unknowable when that budget ends, the
  durable outcome remains resumable `merge-pending`; if reconciliation proves
  no merge occurred, orch reports the actual current PR state instead. An open
  unchanged PR can return to `pr-ready`/pending, a closed-unmerged or moved-head
  PR requires manual action, and unreadable evidence is blocked. Every new merge
  request requires fresh `--approved` authority.
- **`merged`** — GitHub reports the PR merged and the produced merge commit is
  observed on the resolved landing base.
- **`blocked`** — safe bounded remedies were exhausted.
- **`manual-action-required`** — the missing step is authority or policy, not an
  agent coding problem.
- **`failed-internal`** — an invariant or unclassified internal failure stopped
  the run while preserving recovery evidence, including a provider violating a
  proven strict rule or a reported merge that cannot be verified on base before
  the remote budget expires.

Human output may replace hyphens with spaces and uppercase the label, but the
machine identifiers above are canonical everywhere else.

Local integration is called **integrated**, never `merged`.

Legacy history also has non-outcome classifications. In particular,
**`legacy-pr-unconfirmed`** means an immutable old record contains a structurally
valid PR number or URL but lacks contemporaneous exact repo/base/head proof.
Offline readers show that reference and its original verdict/reason without a
network call; they never guess `pr-open` or count it as a V2 outcome. A later
online run may append a new live observation, but it does not rewrite or
reclassify the historical record.

Likewise, **`legacy-approved-unconfirmed`** means an old `status: approved`
record proves only the gates represented by its stored bytes. Current code can
emit that status before the protected-path floor, so it never maps from verdict
text alone to canonical V2 `validated`. Offline migration is deterministic and
does not manufacture missing evidence.

### 4.4 The honest promise

The help text must say:

> `--auto` tries safe repairs until it produces a ready PR or a bounded,
> evidence-backed blocker. It never merges.

> `--approved` on `task`, `issue`, `review`, or `continue` does the same work as
> `--auto`, then merges this run's exact reviewed head once every local gate and
> every GitHub requirement is proven green. It is your authorization, not a
> bypass, and applies to this invocation only.

> `pr --approved` audits the supplied pull request head without repairing it,
> then merges that exact head only if the same readiness proof holds. `--merge`
> is a deprecated alias for the same path.

It must not say that every task becomes merge-ready. A contradictory request,
missing credentials, an unavailable provider, a real security finding, a
guardrail change, an unobtainable required human review, or an unreadable diff
cannot be solved by retrying harder. A merely pending eligible review may be
observed until the remote wait budget expires.

---

## 5. Escalation behavior

`--auto` and `--approved` classify a failure before deciding what to do:

| Class | Examples | Automated action | Terminal if unresolved |
| --- | --- | --- | --- |
| Repairable code | Review disagreement, red test with diagnostics, ordinary merge conflict on an owned branch | Diagnose, write a revised plan, repair, rerun every invalidated gate | `blocked` after bounded no-progress detection |
| Transient infrastructure | Rate/quota reset, timeout, ref-lock race, temporary network/API failure | Backoff, retry the failed stage, optionally rotate a permitted agent/provider | `blocked` with retry evidence |
| Specification/input | Contradictory acceptance criteria, repeated empty diff, missing essential information | One replan/clarification attempt using available repository evidence | `manual-action-required` |
| Security finding | Any deterministic security-scan finding, including a likely fixture false positive | Diagnose and propose a remediation, but make no repair edit in v1; preserve the pre-repair evidence | `manual-action-required` |
| Authority/policy | Required review that this run cannot obtain (changes requested, dismissal, or no eligible independent approver), protected/guardrail path, permissions | Preserve artifacts and name the exact missing authority; a merely not-yet-given eligible review stays `pr-pending` within the wait budget | `manual-action-required` |
| Evidence failure | Unreadable OID/diff, stale reviewed head, malformed verdict | Re-read/revalidate once; never reuse cached green evidence | `blocked` |
| Internal defect | Invalid checkpoint schema, invariant failure, unclassified exception | Fail loudly; retain recovery state | `failed-internal` |

The current engine has no revision-level no-progress detector and discards the
test log when a gate fails (`src/engine.js:222-230`, `src/engine.js:297-305`).
Those are prerequisites for the solver, not follow-up polish.

---

## 6. Approval and trust model

`--approved` is an explicit operator authorization to request a merge. It is
orthogonal to evidence:

```text
operator authority + validated exact head + remote policy green = merge eligible
```

The flag does **not** mean:

- the agents already agreed;
- the operator is a GitHub code reviewer;
- required reviews may be ignored;
- admin/ruleset bypass may be used;
- a future branch head is approved;
- all commits in a shared integration PR are approved.

Authority is scoped to `{SID, repository, landing base ref, pre-request base
OID, PR number, reviewed head SHA}`. Any head/base binding change invalidates
it. The provider merge primitive must condition atomically on the PR, expected
head, and expected base ref/OID; a final client-side re-read is not an
equivalent. The audit journal records that the flag was present, but a later
`continue` invocation must receive `--approved` again.
Outcome mode never arms native auto-merge or a merge queue in v1. If orch finds
a pre-existing deferred merge request armed by another actor, it reports
`manual-action-required` rather than adopting, canceling, or claiming it.

The flag is never accepted from untrusted issue text, MCP free text, or the
existing label-triggered workflow. Repository YAML may configure budgets and
landing mechanics, but never human authority.

Outcome-mode children are untrusted. Authors, reviewers, and configured test
commands run through an enforceable execution broker with a candidate-tree-only
filesystem view, no writable Git metadata, `.orch` state, sibling worktrees, or
controller sockets, an ephemeral sanitized home/config, and no provider-write
credential or egress path. They return patches/results through a validated
artifact channel; only the controller may update durable state, commit, push,
publish, or merge. Every controller Git operation—not only commit—uses a trusted
wrapper that bypasses repository/global/system hooks and unsafe config/includes,
aliases, filters, helpers, and tool callbacks. Source-control credentials are
injected only into the exact hook-free fetch/push primitive and cannot reach a
hook or child. If the platform cannot prove this confinement, either outcome
flag stops before child execution. Merely spawning with `shell: false` does not
satisfy this boundary.

Current machine states and comments use `approved` to mean agent agreement
(`src/github.js:118-147`, `src/finalize.js:411-425`). They must migrate to
`validated` or `agent-agreed` before the CLI flag ships.

---

## 7. Flag rules

| Combination | Decision |
| --- | --- |
| `--auto --approved` | Usage error before any repo, agent, or network action. |
| `--auto --dry` | Allowed as a planning-only, non-run invocation: perform bounded read-only source resolution, print the effective plan and intended dedicated PR, allocate no new SID, and perform no filesystem, Git, agent, journal, or remote write. `continue` may read its existing SID but does not revise it. |
| `--approved --dry` | Rejected; a dry run must not appear to consume merge authority. |
| either flag + `--allow-protected` | Intake mention check may be skipped; final security/path floors remain non-waivable. |
| either flag + `--cheap` | Allowed only when author/reviewer independence still holds; otherwise fail preflight. |
| either flag + `--no-tidy` | Accepted as redundant where the PR branch must remain; print the effective cleanup policy. |
| either flag + multiple authors | Rejected in v1; a single requested outcome must identify one PR. Multi-candidate selection is a later extension. |
| either flag + legacy auto-merge config | Explicit intent wins. `--auto` disables every merge call; `--approved` uses the new gated merge path, not legacy bypass behavior. |

The `automation` configuration block is a closed safety-policy schema. Every
unknown or misspelled key is a preflight error; none merely warns and falls back
to a default budget or landing policy.

An outcome-mode PR head branch remains available while the PR is open or
pending. `pr-ready` never triggers remote-branch deletion; cleanup occurs only
after a verified merge/close. Remote deletion is itself journaled and uses an
exact-final-OID lease; movement or an ambiguous response is reconciled and can
only retain the ref, never blindly delete it.

Exact arity is enforced for `issue`, `review`, and `continue`; extra positionals
stop being silently ignored (`src/cli.js:1325-1359`, `src/cli.js:1544-1547`).
Together with rejecting previously ignored/inapplicable flags, this is a
script-visible validation correction and is included in the migration notes.

---

## 8. Command reduction and compatibility

### v1

- Add both flags to `task`, `issue`, `review`, and `continue`.
- Add `--approved` to `pr` as the preferred spelling of the explicit authority
  path; retain `pr --merge` as a warning alias.
- Treat that alias as spelling compatibility, not behavioral compatibility:
  both spellings use the new readiness, required-review, strict-up-to-date,
  atomic PR/head/base condition, and no-queue path. A legacy `pr --merge` script
  that formerly relied on bypass, head-only mutation, or weak evidence may now
  stop `manual-action-required` with exit 2; release notes and stderr name the
  reason and migration.
- Do not make `--merge` valid on the other commands. Turning a formerly invalid
  destructive invocation into a valid one is unsafe.
- Keep no-flag lifecycle behavior unchanged, with one deliberate exception: bare
  `review` becomes audit-only, aligning runtime with the published help at
  `src/cli.js:1820`. This is breaking for callers that relied on undocumented
  landing behavior; a green bare review prints the exact publishing hint
  (`review <branch> --auto`) and the release notes call out the change.
- Treat strict arity and rejection of formerly ignored or inapplicable flags as
  deliberate parser corrections. They may break scripts that relied on ignored
  input, so ship their diagnostics and migration examples with the same release.
- Generate help, validation, and completion from one command schema so flags are
  offered only where valid. Current completion offers every flag after every
  command (`src/completion.js:16-39`).

### After measured adoption

- Deprecate legacy config paths that direct-merge without complete remote
  readiness/review proof.
- Consider making bare task/issue behavior equivalent to prepare-only in a
  future major release, but only after telemetry and migration feedback. This
  is not part of v1 approval.

---

## 9. Relationship to the standing integration PR

The default integration branch remains valuable: it serializes local landing,
detects overlap, and retests the combined tree (`src/finalize.js:83-216`). It is
not, however, compatible with the sentence “approve this one task” when several
tasks are queued in the same PR.

Therefore:

- legacy/no-flag runs keep the existing integration topology;
- the new outcome flags use one task-scoped outcome PR in v1, targeting
  `automation.prBase` (default: `baseBranch`); it is orch-owned except when an
  unchanged review safely reuses one exact-head/exact-base existing PR whose
  source provenance matches the immutable review input;
- the configured integration branch/PR and any provider-identified shared
  aggregation PR are always excluded from outcome-mode reuse or landing;
- a future shared-PR implementation would require an approval ledger for every
  included SID and exact integration head. It is intentionally deferred because
  it adds substantial internal complexity to a UI simplification feature.

The dedicated PR path does not take the integration merge lock and does not run
the current peer-overlap/integration Guard 2. It replaces that protection with a
hard base-currency rule: a behind head is never ready. When the landing base
advances, orch updates only an orch-owned candidate branch, regenerates any
base-dependent release change, and reruns the full review/test/security/path
bundle. A foreign review branch stops at `manual-action-required` instead of
being rewritten. The same immediate stop applies to solver-off
`pr --approved`: neither case consumes the remote wait budget, and output names
the owner update/rebase plus the exact original outcome command to rerun as a
fresh audit. GitHub protection remains an additional gate, not a substitute for
that revalidation. Because a base can move between
the last client query and the merge request, unattended `--approved` also
requires a proven strict up-to-date branch rule and an immediate merge request
atomically conditioned on PR, expected head, and intended base ref/OID. Native
auto-merge and merge-queue enqueue are out of scope in v1
because they can outlive invocation-scoped authority. Without strict currency
and an atomic condition on the intended base ref/OID as well as the expected
head, orch may prepare the PR but stops `manual-action-required` rather than
race an untested combination or a concurrent PR retarget.

At this review's 2026-08-16 provider baseline, GitHub's documented synchronous
[REST merge input](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request)
and GraphQL
[`MergePullRequestInput`](https://docs.github.com/en/graphql/reference/input-objects#mergepullrequestinput)
condition on the expected head but expose no expected-base condition. Therefore
the GitHub adapter does not yet satisfy this release gate: `--approved` must
stop before merge until a provider primitive with the complete atomic tuple is
available. This is a deliberate product limitation, not permission to weaken
the invariant.

For an orch-requested merge, the selected provider/merge method must also yield
auditable merge-time base evidence. After success orch derives
`baseAtMergeOid` from the returned commit/event, distinguishes a harmless base
advance after merge from a stale combination accepted before merge, and records
the expected head, non-null pre-request base, merge-time base, method, request
ordinal, and merge commit. Unavailable capability stops before the request;
malformed post-success evidence is `failed-internal` and cannot trigger issue
closure or cleanup. An externally completed merge instead uses the truthful
nullable evidence described in §4.2 and never receives strict-rule attribution.

Every orch-owned publication ref uses compare-and-swap semantics: its first
push asserts the remote ref does not exist, later pushes lease against the
journaled prior OID, and a rejected or unresolved push is reconciled against
remote truth rather than retried blindly. An unexpected remote OID stops
`head-moved`.

Distinct SIDs also contend on one deterministic, exact `{repository, base,
head}` publication claim ref before either may push its SID branch or create a
PR. The provider must supply a non-landable claim namespace that cannot trigger
branch/tag CI or PR workflows; otherwise publication stops. Claim acquisition
is an atomic absent-ref CAS and is journaled; only its winner may publish. A
random persisted ownership nonce, successful claim,
provider creator identity, and journaled PR response/reconciliation establish
ownership—the visible SID marker is only a search index. A loser performs no
publication write. Orphaned or ambiguous claims are retained for owner resume
or explicit audited recovery, never stolen on a timer.

Likewise, “no matching PR” is an evidence-backed result. Before the claim/push,
creation requires a provider snapshot guarantee or bounded fixed-point scans in
an immutable order across open, merged, and closed-unmerged state; a conflict,
changing scan, or incomplete scan means zero remote mutation. After claim and
CAS push, orch repeats that complete scan before create and again after any
create response. The distributed claim prevents two orch SIDs from creating
distinct-ref duplicates; an external candidate appearing before the
post-create binding completes becomes a reported conflict with no landing or
further mutation. Once one PR number is durably claim/nonce/creator-bound and
the claim is released, a later foreign duplicate is disclosed but cannot replace
or invalidate that selected identity merely by sharing its commit. Orch never
mutates or merges the duplicate. Every packet reports scan epochs,
boundaries, claim state, candidates, and the exact recovery action.

PR bodies and closing references remain provider-mutable and no current merge
primitive atomically binds a body digest. Before any permitted merge, orch
shows the last observed closing references and an always-on warning that a
concurrent writer can change provider-native issue effects. `--approved`
explicitly accepts that boundedly unpreventable provider effect; orch attributes
what actually occurred after merge and never claims the warning was an atomic
metadata guarantee.

---

## 10. Success criteria

The feature is successful only if all of the following are measurable:

1. Zero false `pr-ready` and zero false `merged` outcomes in fault-injection and
   race tests.
2. `--auto` performs no merge and requests no future merge under every legacy
   config combination: no merge API, `gh pr merge` invocation, native auto-merge
   arm, merge-queue enqueue, `github.autoMergePr`, or `main.autoMerge` path.
3. Every `--approved` merge is atomically bound by the provider to the PR,
   reviewed SHA, and intended base ref/OID, records an auditable merge-time
   base, and is verified on the current landing base; unsupported adapters make
   zero merge calls.
4. Re-running, concurrent distinct-SID publication, or continuing after a crash
   creates at most one orch PR, comment, and release update. An ambiguous
   response never repeats the same merge request;
   every request records one exact `{head, base OID, authority binding, attempt
   ordinal}`. Only a definitive server rejection may consume the documented
   bounded retry after a new full evidence bundle.
5. Repairable-escalation recovery rate is reported separately from retries and
   human-authority blocks.
6. Median operator command count for task-to-ready-PR is one; task-to-verified-
   merge is one when all external gates complete within the wait budget.
7. Every unresolved run prints one exact next command and one evidence path.
8. Existing no-flag lifecycle behavior remains stable during v1 rollout except
   for the explicitly released bare-review and strict-validation corrections.
9. Hostile author/reviewer/test fixtures cannot write controller state, Git
   metadata, sibling worktrees, refs, PRs, queues, issues, or provider state;
   inability to enforce that isolation stops before child execution.

Current `cleanUnattendedCycles` cannot serve as the acceptance metric until
`integrated`, `pr-ready`, and verified `merged` are separated.

---

## 11. Alternatives rejected

### Make retries infinite

Rejected. Some escalations express missing authority, unsatisfiable input, or an
evidence failure. Infinite retries spend money without changing the state.

### Make `--approved` skip review or CI

Rejected. Authority is not evidence. This would also conflict with the pinned-
head invariant already enforced by the engine/finalizer.

### Reuse `github.autoMergePr` or `main.autoMerge`

Rejected as the v1 implementation. Current code can make direct REST merge
attempts without independently proving required reviews, and `main.autoMerge`
deliberately exercises bypass-capable behavior (`src/github.js:297-339`,
`src/github.js:467-485`).

### Merge the standing integration PR from a task-scoped flag

Rejected. One flag could authorize unrelated accumulated tasks.

### Add an `orch auto` command

Rejected. It would duplicate the input grammar of task/issue/review/continue and
make resume more confusing. Outcome flags compose with the existing sources.

### Silently reinterpret bare commands

Rejected for v1. Safety-sensitive default changes require a major release and
evidence from the explicit modes first.

---

## 12. Advisory approval recommendation

The proposal recommends **design-only approval for implementation planning**
when the review record approves these exact document hashes, with these
non-negotiable conditions:

1. One task-scoped outcome PR for both flags in v1; no shared integration PR.
2. `--auto` emits no merge request under any configuration.
3. `--approved` is exact-SHA authority, never a gate or ruleset bypass.
4. Structured, bounded escalation solving with no-progress detection.
5. Full command/mode/task context persists across `continue`.
6. Idempotent remote publication and merge verification.
7. Truthful state vocabulary, including `integrated` versus `merged`.
8. No persistent approval in YAML and no approval authority in untrusted
   automation surfaces.
9. No approved merge is released without an atomic expected-head and
   expected-base provider condition; the current GitHub head-only primitive is
   an explicit blocker.
10. Outcome children are confined and capability-free; the controller alone
    owns state, commits, publication, and landing.

Implementation must follow `docs/cli-simplification-design.md` and the staged
delivery gates in `docs/cli-simplification-implementation-plan.md`. Review and
approval evidence is recorded in `docs/cli-simplification-review-record.md`.
