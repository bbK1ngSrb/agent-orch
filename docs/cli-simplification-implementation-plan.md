> **SUPERSEDED (2026-08-17).** This document is kept as prior art only. It is replaced by
> `docs/cli-v2-proposal.md`, `docs/cli-v2-design.md` and `docs/cli-v2-implementation-plan.md`,
> which resolve its open decisions differently (single `--until ready|merged|once` flag, standing
> integration PR as the merge target, clean break at v0.5.0). Where the two sets disagree, the
> `cli-v2-*` set wins; the conflict list is in `docs/cli-v2-proposal.md` §9.

# Implementation plan: outcome-driven CLI automation

**Status: design-only approval artifact; no implementation has started or is
authorized here. The hash-bound verdict is in
`docs/cli-simplification-review-record.md`.**  
**Design:** `docs/cli-simplification-design.md`  
**Proposal:** `docs/cli-simplification-proposal.md`

This plan deliberately decomposes the feature into review-sized changes. The
public flags are wired only after the state, evidence, publication, and merge
foundations exist. No intermediate pull request may expose a partially safe
`--approved` path.

---

## 1. Delivery rules

Every implementation pull request must satisfy these rules:

1. Preserve legacy no-flag behavior unless the slice explicitly migrates a
   documented inconsistency.
2. Add focused regression tests in the same change as behavior.
3. Keep public status compatibility until versioned outcome fields exist.
4. Never weaken review, test, security, protected-path, exact-head, or GitHub
   policy checks to make a scenario green.
5. Never use `github.autoMergePr` or `main.autoMerge` as the implementation of
   either new flag.
6. Keep each external side effect idempotent and crash-testable.
7. Do not expose persistent human approval in YAML, MCP, issue comments, or the
   label-triggered workflow.
8. Run focused tests, full `npm test`, and Windows CI before the public flag PR
   is approved.
9. Update help, completion, manual, example config, dashboard vocabulary, and
   run-record schema together with their owning behavior—not as an unreviewed
   documentation sweep at the end.
10. A design-decision change returns to advisory review; code review cannot
    silently redefine the user contract.
11. Treat every author, reviewer, and configured test process as untrusted. No
    outcome slice may launch one until the capability-constrained execution
    broker and its hostile-child tests are green.
12. Do not advertise successful GitHub `--approved` landing while its merge API
    can condition on head but not base ref/OID. Capability absence is a tested
    manual terminal, never a client-side approximation.

---

## 2. Dependency map

```text
P0 vocabulary/baseline
 |
 v
P1 command schema + RunPolicy
 |
 v
P2 durable RunStateV2
 |
 +-----------> P2A constrained child execution
 |                |
 |                v
 +-----------> P3 structured attempt evidence
 |                |
 |                v
 |             P4 bounded solver
 |
 +-----------> P5 generated-release normalization --------+
 |                                                        |
 +-----------> P6 idempotent outcome PR + landing journal |
                  |                                       |
                  +----------------> P7 remote readiness <+
                                      |
                                      v
                                   P8 exact-head/base approved merge

P2 + P2A + P4 + P5 + P6 + P7 + P8
                  |
                  v
P9 task/issue/review/continue integration + public flags
                  |
                  v
P10 dashboard/telemetry/docs/migration + release candidate
```

P2A, P3/P4, P5, and P6 can be developed in parallel after P1/P2 contracts
freeze, but P3/P4 agent/test execution must use P2A before outcome-mode tests.
P7 requires both P5's generated-change primitive and P6's landing journal; P8
requires P7 readiness evidence. P9 is the first slice allowed to advertise the
public feature.

---

## 3. P0 — vocabulary, baseline, and contract tests

### Objective

Create an unambiguous vocabulary and pin current behavior before structural
refactoring.

### Work

- Add a versioned outcome vocabulary module or constants:
  `validated`, `pr-open`, `pr-pending`, `pr-ready`, `merge-pending`,
  `integrated`, `merged`, `blocked`, `manual-action-required`,
  `failed-internal`.
- In the same module, define `legacy-unknown`,
  `legacy-approved-unconfirmed`, `legacy-pr-unconfirmed`, and `legacy-unkeyed`
  as record classifications that are never valid values of the outcome field.
  Missing-SID identity is orthogonal and may accompany another historical
  classification.
- Retain legacy statuses at public output boundaries in P0; add the pure mapping
  and its tests behind an internal adapter, and wire new dashboard rendering
  only in P10.
- Implement legacy classification as a pure function of stored bytes. A valid
  stored PR number/URL without immutable V2 repo/base/head/number proof becomes
  `legacy-pr-unconfirmed`, never canonical `pr-open`; a no-PR
  `merge-deferred` becomes `manual-action-required`, `blocked`, or
  `legacy-unknown` from its supported reason. An online resume may append a new
  V2 observation after exact live proof but never rewrite/reclassify history.
- Map old `status: approved` to `legacy-approved-unconfirmed`, never directly
  to `validated`: current execution can return `approved` before the protected-
  path floor, so the verdict text lacks one required V2 gate. Only a new V2 run
  of every gate may append canonical `validated`.
- Characterize the current `review` inconsistency without changing runtime:
  help says audit-only while a green run can finalize
  (`src/cli.js:1458-1472`, `src/cli.js:1820`). The correction ships only in P9
  together with the replacement flags and P10 migration notice.
- Rename new human-facing machine agreement from `approved` to `validated` or
  `agent-agreed`. Keep compatibility parsing for old records/comments where
  necessary.
- Capture a dashboard/fixture baseline for current outcome counts. Mark current
  `merged`/clean-unattended metrics as semantically mixed.

### Likely files

`src/engine.js`, `src/finalize.js`, `src/github.js`, `src/notify.js`,
`src/dashboard.js`, `src/cli.js`, `test/engine.test.js`,
`test/finalize.test.js`, `test/github.test.js`, `test/notify.test.js`,
`test/dashboard.test.js`.

### Acceptance

- A regression fixture captures the current bare-green-review finalization and
  is explicitly marked for replacement in P9.
- Legacy task/issue/config landing tests remain unchanged.
- No UI uses unqualified `approved` to mean both agent agreement and operator
  authority.
- The dashboard fixture adapter can render old and new records without crashing,
  while public output remains unchanged until P10.
- Stored valid and malformed PR references, dirty-merge/no-URL,
  retry-exhaustion, unknown-reason, and SID-less combinations exercise distinct
  mappings while retaining original verdict/reason/reference. No legacy record
  becomes canonical `pr-open`; the same bytes classify identically with and
  without credentials/network, with zero GitHub call.
- Legacy `approved` fixtures emitted before/without protected-path evidence stay
  `legacy-approved-unconfirmed` offline and never enter V2 validated metrics.

---

## 4. P1 — declarative command schema and immutable `RunPolicy`

### Objective

Eliminate globally parsed, locally remembered flags before adding new ones.

### Work

- Introduce one schema describing command arity, allowed options, conflicts,
  help, and completion.
- Keep strict-arity and inapplicable-flag enforcement behind the internal
  outcome-mode feature gate until P9, so Phase A does not change legacy scripts.
- Parse but do not publicly advertise the new outcome values in the first
  internal PR if downstream foundations are not ready.
- Normalize raw options into the immutable policy from the detailed design.
- Implement two preflight phases: syntax/schema checks before config/network,
  then effective-policy checks after config and minimum read-only source
  resolution but before Git/agent/remote writes.
- Thread policy through dependency injection boundaries without changing legacy
  behavior.
- Make ignored flags and extra operands explicit usage errors.
- Align fresh-run and `continue` preflight error/exit behavior.
- Extend `config.validate` with a closed schema for every `automation.*` key,
  including `prBase`. Every unknown/misspelled key, wrong type, or out-of-range
  value fails preflight; there is no warning-and-default branch.
- Model `--auto --dry` as planning, not an executable RunPolicy instance. Fresh
  task/issue/review dry planning may perform minimum bounded read-only source
  resolution but allocates no SID/state and invokes no child; continue dry reads
  its existing SID without revision.

### Primary touchpoints

- parser and command dispatch: `src/cli.js:390-425`, `src/cli.js:1156-1169`,
  `src/cli.js:1312-1739`;
- help: `src/cli.js:1807-1864`;
- completion: `src/completion.js:16-39`;
- binary exit boundary: `bin/orch.js:3-5`.

### Tests

- parser schema unit tests;
- exact arity for issue/review/continue;
- rejected irrelevant flags;
- action/help/version conflicts;
- help/parser/completion equality per command, extending
  `test/completion.test.js:16-67`;
- no dependency/config/Git call before a usage error;
- task/issue/review dry planning performs zero filesystem/Git/journal/remote
  write and allocates no SID; the issue fixture permits a bounded read-only GET;
  continue dry reads but does not revise its existing record;
- configured multiple authors, explicit cheap routing, and issue-text automatic
  cheap routing all resolve before effective author/reviewer independence is
  accepted; failure occurs before any write or agent call;
- unchanged existing no-flag snapshots.
- rejected unknown/misspelled automation keys and out-of-range budgets.

### Acceptance

The schema is the only list of public flags and examples. Adding a flag in one
place updates validation, help, and completion, and a parity test fails if any
consumer drifts.

---

## 5. P2 — versioned durable run state and migration

### Objective

Make `continue` a real resume of intent and evidence rather than a best-effort
branch reconstruction.

### Work

- Add `RunStateV2`, a dedicated `run-state.js` store, and semantic validation.
- Persist original entry command, normalized task/work order, issue number,
  review/source repository/ref/OID, supplied PR number where applicable, roles,
  immutable policy, budgets, branch ownership, evidence digests, solver state,
  and landing state.
- Add atomic revision/lease protection for concurrent continue.
- Define state retention by terminal stage; do not clear resumable/pending
  states.
- Read v1 checkpoint/resume/inflight records and produce explicit compatibility
  outcomes. Never invent lost review/task semantics. Preserve corrupt or partial
  raw state non-destructively; do not route V2 through the current SID store's
  delete-on-corruption behavior. Reading legacy state performs no write or
  deletion; migration becomes durable only through an atomic valid V2 commit.
- Allocate a stable SID before any executable non-dry new outcome invocation
  records audit, repository mutation, or remote access, including issue fetch,
  `pr --approved`, and its deprecated alias. Planning-only dry invocations are
  outside RunState and persist no SID; continue dry only reads its supplied SID.
- Keep liveness in inflight and durability in run state.

### Primary touchpoints

new `src/run-state.js`, `src/sid-store.js:6-37`,
`src/checkpoint.js:12-29`, `src/resume.js:12-35`,
`src/inflight.js:8-65`, `src/cli.js:1312-1531`,
`src/cli.js:1544-1718`, and their test files.

### Tests

- V2 round-trip and semantic-schema rejection;
- v1 migration for every existing stage;
- original task, review source repository/ref/OID, and supplied PR identity
  survive continue;
- run-wide attempt/no-progress counters survive continue, while each explicit
  invocation gets fresh cumulative local/remote clocks from the stored limits
  and never charges process downtime;
- state/audit retained for `validated`, every PR/pending state,
  `manual-action-required`, `blocked`, and `failed-internal`; only journaled
  `cleanup_complete` clears owned worktree/branch recovery state, while immutable
  audit evidence remains;
- two continue processes race; exactly one lease wins;
- corrupted/partial record fails closed without deletion of useful artifacts;
- fresh task/issue/review and `pr --approved` allocate a valid SID before their
  first audit or remote request; issue/PR remote stubs assert the SID already
  exists; dry task/issue/review assert no SID/state write (with issue GET
  allowed), continue dry asserts no revision, and legacy SID-less records remain
  separately identifiable;
- redaction/path-reference behavior for task text.

### Acceptance

Given only SID and durable files, a fresh process can state exactly what was
requested, what was proven, what side effects occurred, and which stage is safe
to resume.

---

## 5A. P2A — capability-constrained child execution

### Objective

Make the unsupervised guarantee enforceable: agents and tests can change only a
disposable candidate tree and can never mutate controller authority, Git refs,
or provider state.

### Work

- Introduce an execution broker used by every outcome-mode author, reviewer,
  resolver, and configured test. Keep the legacy adapter path isolated for
  no-flag compatibility until separately migrated.
- Materialize a disposable candidate-tree view without writable `.git`, `.orch`,
  parent/sibling worktrees, controller journals/locks, SSH agent, or host control
  sockets. Authors get a writable tree; reviewers get a read-only tree; tests
  get a disposable overlay for outputs.
- Build child environments from an allowlist and ephemeral home. Remove
  `GH_TOKEN`/`GITHUB_TOKEN`, source-control provider CLI config, Git credential
  helpers, askpass, SSH agent, cloud metadata credentials, system/repository Git
  config, hooks, and authority/state paths.
- Enforce provider/Git-remote mutation denial with a network namespace or
  capability proxy. Optional package/download egress is explicit and cannot
  reach GitHub API/Git write endpoints. Environment scrubbing alone is not the
  control.
- Broker model inference through a narrow controller service that exposes no
  raw model credential and no source-control/MCP mutation tool. Do not mount the
  host Codex/Claude config/tool surface merely to make the child CLI work.
- Accept only bounded schema-valid patches, verdicts, and logs. The controller
  validates paths/content/OIDs before applying an author patch to its owned
  worktree.
- Make the controller the only writer of RunState/journal/locks and the only
  process allowed to commit, push, publish, comment, close, or merge. Controller
  Git mutations use explicit sanitized config with hooks and credential helpers
  disabled; only the publication adapter receives scoped provider credentials.
- Add an isolation self-test/capability probe to effective preflight. Failure is
  `manual-action-required` before the first child and before any outcome
  repository/remote mutation.

### Primary touchpoints

new `src/execution-broker.js` and platform backends; `src/adapters/codex.js`,
`src/adapters/claude.js`, `src/adapters/cli-adapter.js`, `src/gate.js`, controller
Git helpers, dependency injection, and Windows/Linux test harnesses.

### Tests

- hostile author/reviewer/test attempts to read or edit `.orch`, `.git`, parent
  paths, sibling worktrees, hooks/config, and controller locks/state;
- attempts `git push`, `gh pr merge`, REST/GraphQL mutation, native auto-merge,
  queue enrollment, issue close/comment, SSH push, credential-helper recovery,
  askpass, inherited provider CLI auth, and cloud-metadata credential theft;
- all attempts fail at the enforced boundary and the provider spy records zero
  writes under both flags, especially `--auto`;
- permitted author patch, reviewer verdict, test outputs, and allowlisted
  dependency reads still work; path traversal/symlink/device/socket artifacts are
  rejected by the controller;
- controller commit bypasses repo/system hooks and uses no ambient credential
  helper; only the scoped publication adapter can perform its journaled write;
- unavailable Linux/Windows isolation backend stops before child execution and
  leaves no SID side effect beyond the already-created preflight audit record.

### Acceptance

No outcome child can observe merge authority or mutate durable state, Git
metadata, another worktree, or provider state. This is demonstrated by hostile
fixtures and enforcement telemetry, not inferred from `shell: false`.

---

## 6. P3 — structured attempt results and evidence invalidation

### Objective

Turn one cycle attempt into a deterministic, classifiable unit without changing
legacy retry behavior yet.

### Work

- Factor `runCycle` so a single attempt returns structured success/failure while
  a legacy wrapper preserves current behavior.
- Preserve human reason strings as presentation only.
- Return test exit/signal/timeout, bounded log path/digest, and command digest.
- Return structured security/path findings unchanged; fixture ranking remains
  advisory.
- Classify every deterministic security finding as authority-required in v1.
  Structured findings support diagnosis and a remediation plan, never an agent
  edit whose success criterion is merely making the textual scan pass.
- Return reviewer raw artifact references and normalized findings.
- Add test timeouts comparable to agent stage timeouts.
- Define evidence invalidation by head/base/config/test/reviewer/prompt/orch
  version.
- Replace broad thrown stage failures with a typed internal/transient boundary
  while keeping unexpected invariant failures loud.

### Primary touchpoints

`src/engine.js:29-391`, `src/gate.js:53-59`, `src/verdict.js:14-35`,
`src/security-review.js:226-379`, `src/review-log.js:12-20`.

### Tests

- every current escalation path produces a stable code plus the old human
  message;
- red test evidence reaches the caller;
- gate timeout/signal/spawn/log truncation;
- malformed verdict and unreadable OID/diff fail closed;
- security finding structures remain non-waivable;
- cached green invalidates independently for each dependency input;
- legacy wrapper still passes the current engine suite.

### Acceptance

No solver control flow depends on regex-matching a human sentence. A test log or
review finding needed for repair is never discarded.

---

## 7. P4 — bounded solver controller

### Objective

Handle repairable and transient escalations without weakening hard stops.

### Work

- Add a controller outside the single-attempt engine.
- Implement the approved failure taxonomy and budgets.
- Maintain two cumulative per-invocation clocks and charge exactly one at a
  time. After config validation, `maxMinutes` applies retrospectively to
  preflight and bounds local Git, agents, tests, generated changes, publication,
  and any local revalidation re-entered from remote wait. Charge
  `remoteWaitMinutes` only during remote polling/waiting and submitted-merge
  verification. Pass the applicable remaining budget to every subprocess/API
  loop and persist before returning on expiry; phase alternation cannot exceed
  their sum.
- Persist `classify -> plan -> apply -> verify` transitions.
- Create normalized failure fingerprints and no-progress detection.
- Allow one strategy/agent switch before a repeated unchanged failure blocks.
- Use owned branches only.
- Produce a terminal evidence packet and exact continue command.
- For review repair, create an owned child branch from pinned provenance.

### Likely new modules

`src/auto-controller.js`, `src/failure.js`, and focused tests such as
`test/auto-controller.test.js`. Names may change, but controller and classifier
must remain separately testable.

### Required scenarios

- review DISAGREE repaired, re-reviewed by an independent reviewer, green;
- deterministic red test repaired;
- transient reviewer timeout retried with backoff;
- rate limit rotates only to a configured permitted provider;
- unchanged author output switches strategy then blocks;
- repeated same failing assertion blocks;
- missing gate, unreadable evidence, protected path, and every security finding
  never auto-repair or auto-waive; they preserve evidence and stop
  `manual-action-required`;
- budget/deadline crash and resume;
- a late stage receives only its remaining time and cannot start a fresh
  full-duration subprocess or API retry after either deadline;
- classification unknown -> `failed-internal`, not speculative retry.

### Acceptance

The solver either reaches `validated` or stops within its configured budgets
with a stable class, complete evidence references, and no repeated side effect.

---

## 8. P5 — PR-safe generated release changes

### Objective

Ensure a dedicated PR's final head—including release bookkeeping—is the head
that reviewers and tests validate.

### Work

- Extract deterministic release bookkeeping from integration finalization.
- In outcome mode, apply it to the owned candidate branch before final review
  and gates.
- Persist `{baseVersion, targetVersion, changelogInput, configDigest}` so resume
  is idempotent, using RunStateV2's `generated_changes_applied` event before the
  general landing journal exists in P6.
- On base-version change, regenerate rather than layer a second bump.
- Rerun all invalidated review/test/security evidence.
- When `release.autoBump` is enabled, treat failure to compute, apply, or commit
  the generated change as a structured terminal/blocking failure. Outcome mode
  must never silently skip it; keep the legacy best-effort wrapper isolated.
- For unchanged foreign review input, reuse its PR only when source provenance
  and exact head match and the head already satisfies the expected
  generated-change fingerprint; otherwise fork an orch-owned publication child,
  apply the change, and fully revalidate. The
  solver-off `pr --approved` path stops `manual-action-required` when the
  supplied head lacks that proof.
- Preserve legacy no-flag release flow until a separate migration is approved.

### Primary touchpoints

`src/finalize.js:205-224`, `src/git.js:497-580`, release/version helpers,
`src/versioning.js`, `scripts/orch-release.js`, `test/git.test.js`, and relevant
finalize/versioning/release tests.

### Tests

- final PR head equals reviewed/tested/security-scanned head;
- crash before/after generated commit does not duplicate bump or changelog;
- two candidate PRs based on one version rebase/regenerate safely;
- foreign review head with bump present may be reused; missing bump produces an
  owned publication child and a new full bundle; foreign `pr --approved` with
  missing bump stops without branch or PR mutation;
- release disabled causes no generated change;
- enabled bump compute/apply/commit failure cannot reach publication or green;
- legacy integration behavior remains unchanged.

### Acceptance

No outcome-mode run can call a post-gate mutation green. Every byte in the PR
head is inside the final evidence bundle.

---

## 9. P6 — landing journal and idempotent dedicated PR

### Objective

Make push/find/create/update publication safe to resume after any response loss
or crash.

### Work

- Add the atomic landing journal stages from the detailed design.
- Import/reference P5's persisted `generated_changes_applied` event rather than
  replaying the generation step or inventing a second source of truth.
- Implement `ensureDedicatedPr` alongside the legacy one-shot helper, with
  exact-head verification and find-or-create.
- Persist a cryptographically random ownership nonce and add an SID search index
  plus keyed exact-tuple ownership proof to orch-created PR metadata. A visible
  SID marker alone is never authoritative.
- Before the first push, run and journal complete exact-head discovery plus
  entry/ownership eligibility. Supplied
  `pr` authority selects only that PR number; unchanged child-free review may
  select only its source-provenance match; task/issue and every child path accept
  only a PR proven by this SID's claim journal, protected nonce proof, provider
  creator, exact ref/base/head, and create response/reconciliation. Reject the
  configured integration/shared aggregation PR or source for every entry. An
  otherwise exact foreign candidate or incomplete pass is an ownership/evidence
  stop with zero publication mutation. Preserve a proven owned PR/ref at its
  exact expected prior OID as an update target rather than misclassifying it as
  no match.
- Implement a repository-global claim adapter keyed by
  `{repository, base, expectedHead}` with atomic create-if-absent/read/CAS-delete.
  Its namespace must be non-landable and proven not to trigger branch/tag CI or
  PR workflows; a Git implementation uses a unique per-SID inert claim object
  under a non-head/non-tag ref namespace. Journal request/result and reconcile
  response loss by exact claim OID. Only the winning SID may push/create; a
  third OID loses safely with zero candidate-ref/PR write, and claims are never
  stolen on time alone. Unsupported claim capability stops before publication.
- Only after stable discovery and claim acquisition, journal push intent. First publication uses an absent-ref
  lease; updates lease against the exact journaled prior OID. Reconcile lost
  responses and crash-before-push from remote truth: new OID completes the
  stage, unchanged expected old OID permits only the identical bounded CAS
  retry, and any third OID stops `head-moved`. Never overwrite an unknown OID.
- After a successful/reconciled push, repeat and journal the complete discovery
  and eligibility pass before any PR mutation. A concurrently appearing
  conflict or incomplete result stops every further write and retains the owned
  claim/ref for recovery; never delete either to hide the race.
- Recover create races/422 and ambiguous API failures by querying, never by
  blindly retrying create. After every create response/reconciliation, run a
  third `post-create` complete discovery pass. Multiple/foreign/ambiguous late
  candidates stop landing and further mutation with the visible recovery state
  retained.
- Implement the discovery matrix exactly after eligibility filtering: reuse one
  eligible open exact match; resume base verification for one eligible merged
  exact match; reopen an eligible closed-unmerged PR only when SID-owned and
  explicitly supported, otherwise stop for manual action; fail closed on
  multiple/ambiguous/ownership-conflict matches; create only from an orch-owned
  source ref.
- Discover by reviewed commit SHA using a union of journal-bound direct lookup,
  commit-associated lookup for open/merged PRs, ownership-marker lookup only as
  an index, and exhaustive paginated `state=all` enumeration exposing
  `headRefOid`/`head.sha` plus source repository/ref provenance for
  closed-unmerged candidates. Cross-check base, exact head, and eligibility.
  Commit-associated absence alone is never no-match; unavailable, incomplete,
  or provenance-unreadable closed-state enumeration is ambiguous manual action
  and forbids creation. Never use branch name as the primary key.
- Make enumeration snapshot-complete or fixed-point. Without a provider
  snapshot token/exact-head guarantee, scan in immutable ascending PR identity
  until two complete consecutive epochs agree on identities, state, head, base,
  source provenance, page boundaries, and high-water identity. Insertion or
  retargeting across pages that prevents stability is incomplete.
- Charge discovery to the cumulative local budget and persist/report method,
  scan epochs, high-water/page boundaries, pages, record count, last cursor,
  observed candidates, and completeness.
  Provider-specific exact-head all-state lookup may replace enumeration only
  when completeness is provable; caps, truncation, rate limits, unreadable
  historic heads, and budget expiry always forbid creation.
- Treat `publication_discovery_observed` as repeatable audit evidence, never a
  cached absence grant: resume and each mutation attempt rerun fresh pre-push,
  post-push, and post-create passes as applicable.
- Release claim and delete a merged/closed owned publication ref only through a
  journaled exact-final-OID CAS delete. Reconcile response loss: absence
  completes, unchanged expected OID permits the identical bounded retry, and a
  third OID is retained and stops cleanup. A prior ownership check never permits
  an unguarded delete.
- Make issue comments update-by-marker. Dedicated PR bodies use `Refs #N`, and
  issue closure occurs through the API only for the `--approved` policy after
  verified merge on the resolved `landingBase`. An `issue --auto` run never
  closes it, including after an externally initiated merge.
- Preserve reused foreign PR bodies and persist provider-reported closing
  references/body digest. Provider PR metadata remains mutable and the merge
  mutation does not pin its digest, so every approved merge path—owned, foreign,
  or supplied—prints an always-on warning that concurrent closing-reference
  effects are not bounded. Attribute actual closures as external provider
  effects; never emit orch's `issue_closed` stage or duplicate them through the
  API.
- Return structured publication outcomes; remove silent error swallowing from
  the new path.

### Primary touchpoints

`src/github.js:265-343`, `src/deferred.js:23-80`, `src/finalize.js:59-84`,
`src/notify.js:59-95`.

### Tests

- first absent-ref creation, crash after intent/before push, concurrent
  remote-ref creation, update-lease failure, response loss after successful
  push, and response loss with no remote effect; only unchanged expected state
  permits the identical bounded retry and an unknown OID is never overwritten;
- response lost after PR create, body update, and comment;
- two distinct SIDs with different candidate refs and the same repo/base/head:
  exactly one claim wins and only it may push/create; lost claim response is
  reconciled by unique OID; loser and orphan-claim recovery never steal;
- concurrent PR creation/422 and post-create late-external-conflict recovery;
- remote head moved before push/update;
- open reuse, merged resume-to-base-verification, owned closed reopen, foreign
  closed manual action, and multiple-match fail-closed discovery;
- wrong base/head, forged/copied SID marker, wrong nonce proof, wrong creator,
  missing claim, and mismatched request window are rejected as foreign;
- configured integration branch/PR and provider-identified shared aggregation
  PR are ineligible for task/issue/review/continue/pr with zero publish/merge;
- task/issue, repair-child, and publication-child paths encountering an
  pre-existing exact-head foreign PR stop ownership-conflict manual with zero
  push/create/reopen/update/merge; child-free review accepts only its matching
  source provenance, and supplied `pr` authority selects only its explicit
  number even when another exact-head PR exists;
- pre-push incomplete discovery performs zero push/PR write; a foreign candidate
  or incomplete pass appearing after the CAS push performs no further write,
  retains the owned ref, and reports the race/coverage;
- crash after a complete pre-push no-match observation never reuses absence;
  resume rescans, and a newly appeared foreign candidate prevents the push;
- a journal/SID-owned PR at the expected prior head is CAS-updated and reused,
  never mistaken for no match or duplicated;
- renamed branch is still found by commit SHA; branch-name-only false matches
  are rejected;
- commit-associated lookup omits a foreign closed-unmerged/deleted-ref PR, but
  exhaustive state-all lookup finds it; unavailable/incomplete pagination
  stops ambiguous and never creates;
- PR insertion and retarget across already-consumed pagination boundaries;
  immutable-order fixed-point epochs either observe it or fail unstable/manual,
  never claim a false no-match;
- complete large-history discovery, page/cursor truncation, unreadable historic
  head, budget expiry, and complete provider exact-head lookup; incomplete
  packets include coverage/cause/evidence and an exact recovery action;
- orch-created issue PR keeps `Refs #N`; a reused foreign closing keyword leaves
  the body unchanged, is attributed externally, and causes zero duplicate close
  API calls or `issue_closed` events across crash/resume; a body edit between
  observation and merge produces the mandatory residual-effect warning and
  truthful post-merge attribution, never a claim that metadata was pinned;
- claim/ref moves after cleanup check but before deletion, plus delete response
  loss with effect/no effect: only exact-OID CAS may remove it and every third
  OID survives;
- at-most-one PR and comment across repeated continue;
- legacy `demote`/`openPr` behavior and their existing tests remain unchanged;
- Windows-safe atomic journal handling.

### Acceptance

Replaying publication from every persisted stage converges on one verified PR
identity without force-updating/deleting an unknown remote ref. A known pre-claim
conflict/incomplete scan produces zero remote mutation, no two orch SIDs can
create distinct-ref duplicates, and no PR is selected without stable pre-push,
post-push, and post-create evidence plus claim/ownership proof.

---

## 10. P7 — remote readiness inspector and wait loop

### Objective

Distinguish PR open, pending, ready, and blocked using live GitHub policy.

### Work

- Query exact head, actual/intended base ref and OID, mergeability, merge state,
  required checks/reviews, ruleset/queue state, closing-reference/body digest,
  and authenticated actor capabilities.
- Resolve the PR base from `automation.prBase` (default `baseBranch`) and require
  the candidate head to contain the current base tip. `BEHIND` is not ready:
  update/revalidate an orch-owned candidate, but stop a foreign review or
  supplied `pr --approved` immediately `manual-action-required` with no remote
  wait and the exact owner-update plus fresh original-command action.
- Reject the configured integration/shared aggregation PR/ref for every entry;
  matching head/base does not make a shared PR task-scoped.
- Treat unknown, empty, partial, or unqueryable requirements as not ready.
- Add bounded polling with backoff/jitter and durable observations.
- When an owned candidate is behind, update it from base, regenerate any
  base-dependent release change, and rerun the full review/test/security/path
  bundle. Never mutate/rebind a foreign review or supplied PR head.
- Prove required review independently (`reviewDecision == APPROVED` when
  required); do not infer it from a bypass-capable merge state.
- Classify an eligible review that is merely absent as `pr-pending` within the
  remote budget. Classify changes-requested, dismissed, or no eligible
  independent approver as immediate `manual-action-required` without spending
  that wait budget.
- Inspect whether GitHub provides server-enforced base currency through a strict
  required-up-to-date rule that applies to the authenticated actor without
  bypass. Client-side rechecks alone are not sufficient authority for
  unattended merge; merge-queue-only repositories are manual in v1 because
  queueing outlives invocation-scoped authority.
- Probe a separate merge-mutation capability that atomically conditions on
  `{PR, expectedHead, expectedBaseRef, expectedBaseOid}`. Head-only conditioning
  cannot close a concurrent base-retarget race and is never approximated by one
  more read or a post-merge check. Record adapter/provider/version evidence.
  GitHub's documented 2026-08-16 REST and GraphQL inputs are head-only, so the
  GitHub adapter must report approved landing unavailable with zero merge call
  until the provider surface changes.
- Prove the configured provider/merge method has a deterministic adapter for
  deriving `baseAtMergeOid` from returned commit/event evidence. If not,
  `--approved` is unsupported before any request while `--auto` remains
  prepare-only.
- Expose a deterministic readiness object to human and machine output.
- Always render whether unattended merge is available; an auto-ready PR with no
  proven strict actor-applicable rule, atomic head/base merge primitive, or
  merge-time-base evidence adapter names that limitation and its corrective
  provider/repository/manual action.

### Primary touchpoints

`src/github.js:77-103`, new readiness helper/module, GitHub tests and CLI output
fixtures.

### Tests

- pending, failed, cancelled, neutral/skipped, missing, empty, and duplicate
  check contexts;
- required review missing/dismissed/changes-requested/satisfied;
- pending eligible approval consumes only remote budget; impossible/adverse
  approval stops manual immediately;
- mergeability unknown/conflicting/behind;
- behind task/issue/repair/publication child updates and fully revalidates;
  behind child-free foreign review and `pr --approved` stop manual immediately,
  consume no wait budget, make zero update/merge call, and print the owner action
  plus fresh original command;
- merge-queue-only repository: report unsupported v1 landing and manual action;
- native auto-merge or queue request already armed: report an external authority
  conflict and do not adopt or cancel it;
- strict up-to-date protection unavailable: prepare may
  proceed, approved merge stops for manual action;
- atomic merge supports head but not base ref/OID (the current GitHub fixture):
  prepare may reach `pr-ready`, approved stops manual with zero merge call;
- PR base is retargeted after the final readiness read while head is unchanged:
  the atomic primitive rejects and no branch is merged; an adapter unable to
  express that condition never calls merge;
- merge, squash, and any supported rebase/event adapter derive an exact
  merge-time base; unavailable capability makes approved manual before request;
- head moves during polling;
- base advances after local green and immediately before readiness;
- behind owned candidate with `release.autoBump` regenerates and fingerprints
  the generated change, then completes the full evidence bundle before
  readiness can become green;
- base advances after the last readiness read and the strict server gate rejects
  the attempted stale combination;
- API rate limit, permission error, and timeout resume;
- no remote or unauthenticated preflight.

### Acceptance

There is no code path from PR creation or local green directly to `pr-ready`.
Readiness always contains fresh, exact-head remote evidence.
For approved landing it also contains the exact base ref/OID and a positive
atomic provider-capability proof; otherwise readiness explicitly says prepare-
only.

---

## 11. P8 — `--approved` merge and base verification primitive

### Objective

Implement merge authority as a separate atomically exact-head/exact-base action
with ordinary policy, not an auto-merge boolean.

### Work

- Accept an invocation-scoped
  `{SID, repo, PR, expectedHead, expectedBaseRef, expectedBaseOid, ordinal}`
  authority object only from trusted CLI dispatch.
- Re-query the PR and readiness immediately before action; head, base ref,
  source/ownership eligibility, and non-shared classification must still match.
- Fetch the current landing base immediately before action; if it advanced,
  update/reverify an owned candidate or stop on a foreign branch before
  accepting merge authority for a new head.
- After every owned base update, make zero merge calls until a new
  review/test/security/path/readiness bundle completes for the resulting exact
  head. External head movement is never repaired or silently rebound.
- Require the server-enforced base-currency evidence from P7 before requesting
  an unattended merge; never attempt to win the observation-to-merge race in
  client code.
- Require P7's provider primitive to atomically reject unless PR, head, base ref,
  and base OID all match the authority object. A head-only primitive, including
  the current GitHub API, is unsupported and receives no merge call.
- Never arm native auto-merge or enqueue a merge queue in v1. Use the ordinary
  non-admin endpoint immediately only when all requirements and strict
  base-currency enforcement are proven and no bypass is used.
- Pin the complete PR/head/base-ref/base-OID tuple in the request.
- Immediately before request, display the last observed closing references/body
  digest and mandatory warning that provider-mutable PR metadata is not
  atomically conditioned. Invocation authority accepts that residual provider
  effect; output never calls it pinned.
- Persist request/remote result and query truth after ambiguous responses. Add
  `merge_rejected`, `merge_response_unresolved`,
  `merge_reconcile_observed`, and `merge_reconciled_no_effect` journal evidence
  with attempt, exact PR/head/base, provider/deferred state, error, merge commit,
  and observation time. Transport loss is not rejection and consumes no
  rejection retry.
- Within the same live invocation only, retry a classified base-currency or
  transient rejection up to `transientRetries` while both cumulative budgets
  remain; every retry returns through owned update, generated changes, the full
  evidence bundle, and readiness. Never carry that authority across resume.
- Verify GitHub `MERGED`, returned merge commit, fetch, and base ancestry.
- Derive and journal `baseAtMergeOid` using P7's proven method. Compare it with
  the atomically bound pre-request base OID: any difference violates the
  provider/invariant contract. A current base advance after the valid merge is
  harmless when the returned merge commit remains its ancestor.
  Missing/malformed advertised evidence is `failed-internal` with no
  closure/cleanup.
- Implement an external-merge observer distinct from the request primitive. An
  eligible PR merged before any orch request records
  `mergeRequestedByOrch:false`, null ordinal/pre-request base/authority proof,
  provider event proof of intended base ref and exact reviewed head, current-
  base merge-commit ancestry, and method/base-at-merge only when derivable. It
  never fabricates strict-rule attribution or counts clean-unattended. A
  reconciliation after a journaled orch request stays request-shaped even when
  actor attribution is unknown.
- Close issue and clean up only after base verification.
- Build the authority-only `pr` adapter behind the internal feature gate. It
  audits a foreign PR head and never invokes the solver or repairs that PR;
  configured generated-release policy must already be satisfied or it stops
  manual;
  public `pr --approved` dispatch and the `pr --merge` warning alias ship in P9.

### Primary touchpoints

`src/github.js:206-240`, `src/github.js:434-488`, `src/cli.js:1721-1739`,
landing journal and issue notification code.

### Tests

- exact head green merges and verifies;
- current GitHub head-only capability makes zero merge calls and returns the
  explicit prepare-only/manual terminal;
- base retarget between final read and request with unchanged head is rejected
  atomically; wrong target receives zero merge, and no post-effect check is
  treated as prevention;
- normal synchronous `merged: true` success journals `github_merged` with the
  returned merge SHA before base verification; a response without both is not
  success;
- head moves before request;
- base moves after the final readiness observation; the server rejects the
  stale combination and orch never reports merged;
- owned base update makes zero merge calls until the complete new evidence
  bundle is green; foreign base update stops for manual action;
- queue required;
- `pr --approved` supplied base differs from resolved `automation.prBase`;
- review/pr supplied source is the configured integration/shared aggregation PR
  or ref: manual with zero merge/publication mutation;
- `pr --approved` with `release.autoBump` enabled and a missing or unprovable
  fingerprint makes zero branch/PR mutation and zero merge call, exits
  `manual-action-required`; matching proof proceeds to the normal gates;
- checks/reviews become stale between inspection and request;
- bypass-capable actor cannot turn unmet policy into success;
- ambiguous network response resolves via query;
- ambiguous response followed by `MERGED`; ambiguous response followed by
  conclusively open/ready, open/degraded, closed-unmerged, moved head, or
  authoritative non-merge with unreadable evidence; and unavailable or
  contradictory reconciliation through remote-budget exhaustion;
- strict-gate rejection is distinguishable from response loss, journaled, and
  bounded; a retry cannot skip any regenerated evidence;
- genuinely unresolved merge effect remains resumable `merge-pending`, while a
  proven no-effect request reports actual lifecycle/readiness: ready/degraded,
  closed-unmerged, moved-head, and unreadable-evidence cases receive the design's
  distinct terminals and require a later fresh `--approved` where another
  request remains applicable; bare reconciliation and every case make zero
  duplicate requests;
- reconciled-no-effect human/JSON output distinguishes requested `merged` from
  actual lifecycle/readiness, states that no merge occurred, and prints the
  exact fresh-approved or manual/evidence next action;
- bare resume may verify an already-completed journaled request but cannot issue
  a second merge request without fresh `--approved`;
- pre-existing native auto-merge/queue request is not adopted, canceled, or
  reported as orch authority;
- owned/foreign/supplied PR body gains closing keywords after last observation:
  warning is always present on every merge, actual effects are attributed after
  merge, and no record claims an atomic body digest;
- GitHub `MERGED` plus temporary missing base ancestry stays `merge-pending`
  only within the remote budget, then becomes `failed-internal` with evidence;
- an orch-requested merge returns a derived merge-time base different from the
  atomically bound pre-request OID -> `failed-internal`; base advances only after
  a valid merge -> normal verified merge; missing/malformed merge-time evidence
  after success -> `failed-internal`. All request paths journal exact tuple,
  method/commit/ordinal and both bases; neither failure closes the issue or
  cleans up;
- external auto/discovery merge has no request: emit verified `merged` only with
  intended-base event/head plus current-base ancestry, keep request ordinal and
  pre-request base null, record method/base-at-merge when derivable, never claim
  strict-rule enforcement, close an auto issue, or count clean-unattended;
- flag absent means primitive cannot be invoked by task text, MCP, workflow, or
  config.

### Acceptance

Every orch-requested `merged` record contains PR, expected head, expected base
ref/OID, request ordinal, merge method/commit, derived matching merge-time base,
current-base ancestry, and capability/observation evidence. Every external
`merged` record instead has `mergeRequestedByOrch:false`, null request/pre-
request fields, proven intended landing/head/ancestry, and explicitly nullable
provider-derived method/base-at-merge evidence. Neither schema fabricates the
other. No legacy bypass helper is reachable from the new policy.

---

## 12. P9 — integrate all entry commands and expose the flags

### Objective

Deliver the complete user contract simultaneously on task, issue, review, and
continue.

### Work

- Advertise both flags in the command schema, help, and completion.
- Enable the schema's strict arity/inapplicable-flag diagnostics and make bare
  `review` audit-only in this slice—not in P0. P9 and the P10 migration notes
  ship atomically so callers always receive the replacement command and notice.
- Route task/issue through solver -> generated changes -> dedicated PR.
- Route every agent/reviewer/test through P2A; no outcome entry can fall back to
  the inherited-environment legacy child path.
- Keep issue open at PR-ready and close only at verified merge.
- If another actor merges an auto outcome PR, verify and report `merged` with
  external provenance and exit 0, but never close its source issue or count the
  run clean-unattended.
- Outcome review uses immutable provenance and an owned repair child when
  needed. A green unchanged review reuses one source-provenance-matching
  exact-head/exact-base PR only when generated-release policy is already
  satisfied; otherwise create an orch-owned publication ref at the reviewed OID,
  apply required generated changes, rerun every gate, and open the outcome PR
  from it. Never push or create from the foreign ref.
- Reject the configured integration branch/PR and any identified shared
  aggregation PR/ref for task, issue, review, continue, and `pr` before
  publication or authority binding.
- Make continue restore entry/policy/evidence/PR and accept a new invocation's
  outcome flag.
- Ensure `--auto` suppresses every merge helper, native auto-merge arm, and
  merge-queue enqueue under every config, including both legacy auto-merge
  booleans set true, while P2A prevents children from reaching those mutations
  independently.
- Ensure `--approved` invokes only P8.
- Route `pr --approved` through P8 with solver off and allocate its SID before
  audit; retain `pr --merge` as a warning alias to the same safe path.
- Add unified terminal summary and stable exit contract.
- Handle cleanup by terminal outcome and P6's journaled exact-OID CAS deletion;
  ownership observed before deletion is not enough.
- A repair child receives its own dedicated PR and is the sole merge target;
  issue zero merge calls against the supplied PR, which is only linked by an
  idempotent comment. Without a repair/publication child, `--approved` may merge
  one matching exact-head/exact-base foreign PR after every gate, but never push
  its ref or rewrite its metadata; it prints the non-atomic metadata-effect
  warning and still requires P8's atomic base capability. Otherwise the owned
  publication-ref PR is the only merge target.
- Apply P6 provenance eligibility before reuse: task/issue and child paths never
  adopt an unrelated exact-SHA PR, while `pr --approved` never substitutes a
  different PR number. Ownership conflicts list all observed candidates and
  perform zero create/reopen/update/merge calls.
- Bare `continue` inherits stored auto policy, but a stored approved outcome
  resumes prepare-only until `--approved` is explicitly supplied again.

### Cross-product acceptance matrix

For each of `task`, `issue`, `review`, and `continue`, cover:

| Requested outcome | Local result | Remote result | Expected |
| --- | --- | --- | --- |
| auto | green | ready | exit 0, `pr-ready`, no merge call |
| auto | green | pending past budget | exit 2, resumable `pr-pending` |
| auto | repairable failure then green | ready | exit 0 with attempt count |
| auto | policy block | n/a | exit 2, `manual-action-required` |
| approved | green | supported atomic provider ready + merged | exit 0, base-verified `merged` |
| approved | green | ready but provider is head-only | exit 2, `manual-action-required`, preparation retained, zero merge call |
| approved | green | base retargets with unchanged head before request | atomic rejection/no merge; invalidate authority and report exact rerun action |
| approved | green | readiness pending before any request | exit 2, resumable `pr-pending`; zero merge request |
| approved | green + request sent | request effect genuinely unresolved at budget expiry | exit 2, resumable `merge-pending`; reconciliation only |
| approved | green + request sent | reconciliation proves no deferred effect and exact-head PR remains ready | exit 2, `pr-ready`; print that merge did not occur and require fresh `--approved` |
| approved | green + request sent | reconciliation proves no effect and PR is closed-unmerged or head moved | exit 2, `manual-action-required`; no repeat |
| approved | green + request sent | reconciliation proves non-merge but exact head/evidence is unreadable | exit 2, `blocked`; no repeat |
| approved | head moves | n/a | invalidate authority/evidence; no merge |
| approved | any red local gate | n/a | no publication/merge beyond safe recovery |

Also cover flag conflicts, cheap identity, no-tidy, allow-protected, config
precedence, exact arity, no remote, GitHub auth, multiple authors rejected, and
old checkpoint behavior. Fresh dry cases perform bounded reads only, allocate no
SID, and write nothing; continue dry does not revise its SID. Review cases
include an existing matching PR, no PR
(owned publication ref created), wrong-base PR, ambiguous matches, a repair
child, a foreign head move, and explicit integration/shared aggregation
exclusion. Every command includes a hostile-child zero-provider-write fixture.
Remote-review cases distinguish an eligible approval that is merely pending
from changes-requested, dismissed, or impossible independent approval.

### Acceptance

The four commands differ only in intake/provenance. From normalized policy
onward, they use the same outcome controller and landing primitives.

---

## 13. P10 — dashboard, telemetry, docs, and release candidate

### Objective

Make the behavior operable and prove migration safety before stable release.

### Work

- Render current phase, solver attempt/budget, blocker class, PR readiness,
  requested outcome, and exact next action.
- Keep dashboard/history offline: legacy classification is deterministic from
  stored bytes, performs zero GitHub calls, and never rewrites old records. Show
  `legacy-approved-unconfirmed`/`legacy-pr-unconfirmed` with stored evidence and
  original verdict/reason; exclude them from canonical V2 outcome metrics.
- Correct metrics so local integration is not counted as base merge and clean
  unattended means requested outcome reached.
- Document the flags in README/manual/generated ORCH doc/example config.
- Keep MCP merge-disabled; optionally add safe auto prepare only in a later
  separately reviewed change.
- Keep label workflow approval-disabled; document protected manual workflow
  requirements without implementing them implicitly.
- Publish migration notes for legacy auto-merge config and the `pr --merge`
  alias, explicitly warning that the alias now uses full readiness, strict
  up-to-date/no-bypass proof, atomic PR/head/base capability, and no queue
  enrollment; the current GitHub head-only baseline exits 2 before merge, and
  formerly successful bypass-dependent scripts may also exit 2.
- Document the publication claim namespace/capability, fixed-point discovery,
  residual mutable-PR-metadata warning, child isolation prerequisite, and exact-
  OID cleanup recovery commands.
- Publish the deliberate breaking correction that bare `review` is audit-only,
  with the `review <branch> --auto` publishing hint.
- Publish the script-visible strict-arity and rejected-inapplicable-flag
  corrections, including before/after command examples.
- Add release-candidate telemetry counters and rollback switch.

### Acceptance

- Full docs/help/completion parity tests pass.
- Dashboard renders mixed old/new history, including `pr-fallback` and
  `merge-deferred`. Metrics reduce only valid-SID V2 records to the latest
  terminal run state; multiple SID-less legacy records remain individually
  visible as `legacy-unkeyed` and are excluded from V2 clean metrics.
- Legacy PR-like records never render or count as canonical `pr-open`;
  structurally valid stored references render
  `legacy-pr-unconfirmed`, while dirty-merge/manual, supported blocked, malformed
  reference, and unknown fixtures retain their original evidence. Rendering is
  byte-stable with/without auth, makes zero GitHub call, and an online derived
  observation never mutates history.
- Legacy `approved` records remain `legacy-approved-unconfirmed` and never count
  as V2 `validated` without a new execution of every V2 gate.
- Incomplete PR discovery summaries show method, pages/records/cursor, every
  scan epoch/boundary/high-water identity, observed candidate, limiting cause,
  claim state, evidence path, and exact recovery action; they distinguish zero-
  mutation pre-claim stops from post-push/post-create stops that retain
  journaled recovery refs and perform no further write.
- Reused-foreign-PR closing references and resulting closures render as
  mutable external provider effects with the mandatory warning, never as orch
  `issue_closed` actions or atomically pinned metadata.
- Fixtures prove multiple legacy SID-less records never collapse together,
  while several invocations of one valid SID reduce to one run.
- No credential, raw reviewer prose, task secret, or token appears in telemetry.
- A release-candidate exercise covers clean, repaired, pending, blocked,
  interrupted/resumed, and exact-head merged runs.

---

## 14. System test and fault-injection plan

### Local/state faults

- process termination before and after every RunState/journal write;
- stale worktree path, orphaned cache, missing local branch, remote-only branch;
- ref-lock races and concurrent continue;
- branch/head/base movement at every verification boundary;
- repeated local/remote phase alternation charges exactly one cumulative budget
  at a time and never exceeds `maxMinutes + remoteWaitMinutes`;
- corrupted/truncated V1/V2 state;
- disk/write failure during checkpoint/journal.

### Agent/solver faults

- hostile child access to `.git`, `.orch`, parent/sibling worktrees, provider
  credentials/config, SSH/askpass/helpers, Git push, provider mutation APIs,
  native auto-merge/queue, hooks, sockets, and cloud metadata endpoints;
- unavailable/partially effective isolation backend on Linux and Windows;
- author/reviewer timeout, quota, crash, malformed verdict;
- same-agent identity under cheap routing;
- unchanged revision and repeated failure fingerprint;
- conflicting reviewer findings;
- repair changes acceptance scope;
- repair touches protected path;
- token/deadline budget exhaustion.

### Gate/security faults

- no test command, red test, hanging test, signal/spawn failure;
- unreadable diff/OID/raw path;
- executable security finding, fixture-only heuristic, guardrail touch;
- generated release change invalidates prior green evidence.

### GitHub faults

- auth absent/expired and no remote;
- push response loss and lease failure;
- publication-claim acquisition/response loss/orphan/third-OID conflict across
  two SIDs with distinct refs but the same exact repo/base/head;
- PR create race, post-create late conflict, and duplicate remote branch;
- pagination insertion/retarget across consumed pages and non-converging fixed-
  point scans;
- check/review policy unknown, pending, failed, then green;
- PR head moves during wait and immediately before merge;
- PR base retargets with unchanged head between final read and merge; head-only
  providers make zero call and atomic providers reject;
- configured integration/shared aggregation PR appears through each entry;
- base advances, merge-queue-only policy detected, or a pre-existing queue
  request conflicts;
- merge request response loss followed separately by confirmed success,
  conclusively open/no deferred effect, degraded readiness, closed-unmerged,
  moved/unreadable head, and unavailable truth through budget expiry;
- GitHub says merged but fetch/base ancestry verification fails;
- orch-requested merge-time base differs from its atomically bound base,
  advertised merge-time-base evidence is missing/malformed for each supported
  method, and base advances only after a valid merge;
- external merge before any orch request uses null request/pre-request fields,
  verifies intended base/head/current ancestry, and never receives strict-rule
  attribution;
- PR body/closing references mutate after observation; actual effects remain
  external and warned;
- claim/publication ref advances between cleanup check/delete, plus delete
  response loss with effect/no effect;
- issue comment/close response loss.

### Topology/config matrix

- legacy `merge: no-ff`, `ff-only`, and `pr` with neither flag;
- both legacy auto-merge booleans on/off in all combinations;
- custom base and integration branch;
- closed-schema unknown/misspelled `automation.*` keys fail preflight;
- `release.autoBump` on/off;
- single author/reviewer override, cheap roles, multiple authors rejected;
- Linux and Windows CI.

---

## 15. Verification commands per slice

Use the smallest relevant test set during development, then the complete suite:

```console
node --test test/cli.test.js test/completion.test.js
node --test test/execution-broker.test.js test/adapters.test.js
node --test test/engine.test.js test/gate.test.js test/security-review.test.js
node --test test/checkpoint.test.js test/resume.test.js test/inflight.test.js
node --test test/finalize.test.js test/github.test.js test/concurrent.test.js
npm test
```

Before merge, also require:

- `git diff --check`;
- help/completion snapshot review;
- targeted crash/fault suite;
- Windows CI result;
- an adversarial review explicitly checking every non-negotiable design
  condition;
- exact tree/head evidence for the release-candidate exercise.

Test count alone is not approval. Security, concurrency, protocol, remote policy,
documentation, and scope claims require their corresponding evidence.

---

## 16. Rollout plan

### Phase A — internal foundations

Land P0-P8 with direct unit/module tests and no public flags. Keep legacy paths
unchanged. P8 must treat the current GitHub head-only merge surface as an
unsupported zero-call capability; no implementation milestone may relabel that
as a successful landing adapter. Instrument only test fixtures or non-public
diagnostics.

### Phase B — opt-in release candidate

Land P9 and P10 as one releasable unit and expose the explicit flags, parser
corrections, migration notes, and bare-review replacement together. Mark the
flags preview in help for one release line. No other default changes. Collect
only the telemetry listed in the design.

Promotion gates:

- zero false-ready/false-merged fault cases;
- no duplicate remote side effect in crash testing;
- no merge/provider/state capability available to auto children across the full
  hostile/config matrix;
- zero merge calls on a head-only provider and zero wrong-base effects in the
  retarget fault matrix;
- one publication winner across every two-SID exact-head claim race and no
  unleased cleanup deletion;
- successful resume from every durable stage;
- no unresolved high-severity adversarial review finding.
- at least 30 days of preview observation covering at least 50 V2 outcome SIDs
  across at least three repositories, including ten repaired runs and five
  crash/resume runs. `--approved` cannot graduate from capability-unavailable
  preview until a supported provider supplies at least ten real atomically
  head/base-bound merges; current GitHub-only observation cannot satisfy this;
- zero observed safety-invariant violation, unintended merge request, duplicate
  side effect, or false terminal state in that preview cohort. Runs stopped by a
  documented policy/manual boundary do not count as failures of the safety gate.

### Phase C — stable explicit modes

Remove preview wording per outcome only after its promotion gates hold in real
repositories. `--auto` may stabilize while `--approved` remains explicitly
capability-unavailable; never imply a GitHub merge capability that does not
exist. Continue the `pr --merge` warning introduced with P9 and begin warnings
for unsafe legacy auto-merge configurations, but do not rewrite config.

### Phase D — optional future migration

Only a separately approved major-release proposal may make bare task/issue
prepare-only or remove legacy merge automation. MCP auto prepare, shared-PR
approval ledgers, multi-author outcome selection, and planner/DAG scheduling are
separate designs.

---

## 17. Rollback

- Public flags can be disabled at dispatch without deleting RunStateV2 or
  landing journals; `continue` must still render/export their state.
- Never roll back by interpreting outcome-mode state through legacy finalization.
- If remote readiness or merge verification is faulty, disable `--approved`
  first while leaving `--auto` prepare-only available.
- Pre-existing externally armed native auto-merge or queue requests must be
  listed explicitly for operator inspection; outcome mode never created them,
  and disabling local code does not cancel remote state.
- Schema readers remain backward compatible for at least one major version.
- No rollback may delete branches, PRs, checkpoints, review artifacts, or
  journals automatically.

---

## 18. Definition of done

Implementation is complete only when:

1. Task, issue, review, and continue implement identical normalized outcome
   semantics; `pr --approved` and the deprecated `pr --merge` alias implement
   the documented solver-off compatibility path.
2. Auto's no-merge property is mechanically proven across config/topology and
   hostile child behavior; children receive no controller/provider capability.
3. Approved merges only exact, green, policy-satisfied PR/head/base-ref/base-OID
   tuples through an atomic provider primitive and verifies base; unsupported
   providers make zero merge calls and remain capability-unavailable.
4. Solver retries are structured, bounded, evidence-led, and no-progress aware.
5. Continue restores the original command, full task context, policy, budgets,
   evidence, branch ownership, and PR.
6. Cross-SID-claimed PR publication, comments, release generation, merge, close,
   and exact-OID cleanup are idempotent under injected crashes/races.
7. Status/output/dashboard vocabulary is truthful and versioned.
8. Help/completion/manual/config examples agree exactly.
9. Focused, full, fault, and Windows suites pass.
10. An independent security/concurrency reviewer and a fresh-reader UX reviewer
    approve the implementation evidence.
11. No design non-negotiable is waived in code review.
12. Release notes explain compatibility, deprecation, and rollback.
13. Legacy approvals/PRs stay non-canonical, dry planning writes no SID/state,
    shared integration PRs are excluded, and external merges use their truthful
    nullable evidence schema.

Until all thirteen are true, the feature remains unimplemented or preview—not
“mostly done.”
