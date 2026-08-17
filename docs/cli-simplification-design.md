> **SUPERSEDED (2026-08-17).** This document is kept as prior art only. It is replaced by
> `docs/cli-v2-proposal.md`, `docs/cli-v2-design.md` and `docs/cli-v2-implementation-plan.md`,
> which resolve its open decisions differently (single `--until ready|merged|once` flag, standing
> integration PR as the merge target, clean break at v0.5.0). Where the two sets disagree, the
> `cli-v2-*` set wins; the conflict list is in `docs/cli-v2-proposal.md` §9.

# Detailed design: `--auto` and `--approved`

**Status: design-only approval artifact; not implemented. The hash-bound verdict
is in `docs/cli-simplification-review-record.md`.**  
**Parent decision:** `docs/cli-simplification-proposal.md`  
**Implementation sequence:** `docs/cli-simplification-implementation-plan.md`

---

## 1. Design principles

1. **Outcome is explicit.** Commands identify the input source; one normalized
   policy identifies the requested terminal outcome.
2. **Authority and evidence are separate.** `--approved` supplies authority;
   review, tests, security, path policy, and GitHub supply evidence.
3. **One run, one identity.** SID—not branch name—is the primary key for local
   state, remote publication, logs, approval audit, and resume.
4. **One run, one outcome PR in v1.** The two new modes never merge a shared
   standing PR. A green review may reuse one source-provenance-matching existing
   PR only when it is not the configured integration/shared aggregation PR;
   otherwise the outcome PR is orch-owned.
5. **Exact artifacts only.** Every cached decision is bound to explicit input
   hashes and SHAs. A changed input invalidates only the evidence that depends on
   it.
6. **Remote writes are resumable.** Query remote truth before repeating an
   action; every side effect has an idempotency key.
7. **Stops are truthful.** An authority block is not called a solver failure; a
   local integration is not called a merge; an open PR is not called ready.
8. **Legacy stays isolated.** Existing behavior is wrapped, not gradually
   changed by scattered `if (auto)` branches.
9. **Children have no landing capability.** Agents and tests operate only on an
   isolated candidate tree and return validated artifacts. The controller alone
   owns durable state, Git metadata, publication, and provider mutations.

---

## 2. Current invariants to preserve

The design builds on, rather than weakens, these current properties:

- all configured reviewers must agree (`src/engine.js:243-264`);
- tests, security, and protected-path checks run against a captured
  `reviewedSha` (`src/engine.js:293-356`);
- a moved or unreadable branch head fails closed before landing
  (`src/finalize.js:30-56`);
- integration landing is serialized and checks live peer overlap
  (`src/finalize.js:83-170`);
- the PR merge path pins the fetched head and verifies the produced merge commit
  on the remote base (`src/github.js:206-240`);
- checkpoint/state writes use SID-keyed atomic stores
  (`src/checkpoint.js:12-29`, `src/deferred.js:23-80`).

The following current behaviors are explicitly not reused as safety proofs:

- machine `AGREE` represented as `approved`;
- `github.autoMergePr` direct merge attempts;
- `main.autoMerge` bypass-capable direct merge;
- `status: merged` after local integration only;
- a `tested` checkpoint bound only to branch OID;
- branch-name reconstruction of lost task and mode during `continue`.
- the provider's current head-only PR merge condition as proof that the PR base
  could not be retargeted between read and mutation;
- inherited agent/test environments or `shell: false` as a capability sandbox.

---

## 3. Normalized run policy

Parse CLI flags once into an immutable policy before config preflight or any
write:

```js
RunPolicy = {
  schema: 1,
  outcome: "legacy" | "pr-ready" | "base-merged",
  solver: "off" | "bounded",
  landing: "configured-legacy" | "outcome-pr" | "supplied-pr",
  landingBase: string,  // automation.prBase; defaults to cfg.baseBranch
  mergeAuthority: "none" | "this-invocation",
  cleanup: "legacy" | "retain-pr-branch",
  entry: "task" | "issue" | "review" | "continue" | "pr",
  sourceSid: string | null
}
```

Normalization:

| CLI input | `outcome` | `solver` | `landing` | authority |
| --- | --- | --- | --- | --- |
| neither flag | `legacy` | `off` | `configured-legacy` | existing behavior |
| task/issue/review/continue `--auto` | `pr-ready` | `bounded` | `outcome-pr` | none |
| task/issue/review/continue `--approved` | `base-merged` | `bounded` | `outcome-pr` | this invocation |
| `pr --approved` (or deprecated `pr --merge`) | `base-merged` | `off` | `supplied-pr` | this invocation |

For outcome-mode runs, `landingBase` comes from `automation.prBase`, defaulting
to `cfg.baseBranch`. It is resolved once at preflight, printed, persisted, and
used for PR creation, readiness, merge verification, and issue completion.
For `pr --approved`, orch first fetches the supplied PR, records its actual base,
and requires that base to equal the resolved `automation.prBase`; a mismatch
stops before authority is bound. All entries also reject the configured
integration branch/PR and any provider-identified shared aggregation PR before
publication or authority binding.

The policy object is threaded through command dispatch, checkpointing, engine,
publication, output, telemetry, and cleanup. No downstream module re-parses raw
flags or re-derives intent from config.

`--approved` is deliberately not stored as durable reusable authority. The
journal may record that it was observed and how it was scoped, but after the
invocation ends a later merge attempt requires the flag again. Outcome mode
never arms native auto-merge or a merge queue in v1. A pre-existing deferred
merge request created by another actor is an external authority conflict and
stops `manual-action-required`; orch neither adopts nor silently cancels it.
If this run already journaled an immediate `merge_requested`, a later bare
`continue` may reconcile that request only: verify an already completed merge,
or return the actual current PR state (`pr-ready` only if readiness still holds)
if it did not merge. Issuing another request still requires `--approved`.

---

## 4. Command schema

Replace the flat global option contract in `src/cli.js:390-425` with one schema
that generates parsing validation, help, and completion:

Outcome-specific schema (the generated schema also carries each command's
existing documented non-outcome options):

| Command | Source | New outcome options | Dry rule |
| --- | --- | --- | --- |
| `task` | text or exactly one `--file` | exactly zero or one of `--auto`, `--approved` | `--auto --dry` allowed |
| `issue` | exactly one integer | exactly zero or one of `--auto`, `--approved` | `--auto --dry` allowed |
| `review` | exactly one branch | exactly zero or one of `--auto`, `--approved` | `--auto --dry` allowed |
| `continue` | exactly one SID | zero or one explicit outcome; bare resume follows the stored-safe rule | `--auto --dry` allowed |
| `pr` | exactly one integer | `--approved`; deprecated `--merge` is the same authority path; `--auto` invalid | no outcome dry mode |

Every `--auto --dry` invocation is planning-only, not a run. Fresh task, issue,
and review planning allocate no SID or durable record; issue planning may fetch
the work order and all entries may perform the minimum bounded read-only source
resolution needed to print the effective plan. `continue --auto --dry` may load
and validate its existing SID without changing its revision. No dry path invokes
an agent/test or performs a filesystem, Git, journal, issue/PR, or other remote
write. The table is exhaustive for the new outcome options; no ellipsis implies
that an outcome flag is silently accepted elsewhere.

Preflight has two explicit phases. Syntax/schema validation occurs before
loading config or touching Git/network state:

- reject both outcome flags;
- reject `--approved --dry`;
- reject ignored flags and extra positionals;
- reject action flags with help/version.

Effective-policy validation runs after config and the minimum necessary
read-only source resolution (including issue work-order fetch for automatic
cheap routing), but before branch creation, agent execution, Git writes, or any
remote write:

- reject configured or explicit multiple authors with either v1 outcome flag;
- resolve normal, explicit-cheap, and path-auto-routed roles;
- verify that the effective author and every reviewer are independent when
  authoring is part of the entry path;
- validate `landingBase`, repository identity, and required read-only
  prerequisites.
- prove the platform can enforce the outcome child capability boundary before
  any agent/test child is launched; inability is a preflight stop;
- probe and print the provider's merge capability. A head-only provider may
  still prepare under `--approved`, but the plan states that landing will stop
  unless an atomic `{PR, expectedHead, expectedBaseRef, expectedBaseOid}`
  primitive is available.

Completion becomes command-scoped. Set parity remains tested, but a second test
asserts that each command's offered flags exactly equal its schema.

---

## 5. Persistent execution context

Current checkpoint, resume, and inflight records are too small for safe solver
resume (`src/checkpoint.js:16-29`, `src/resume.js:12-35`,
`src/inflight.js:8-18`). Introduce a versioned durable run document:

```js
RunStateV2 = {
  schema: 2,
  sid,
  revision,
  entry: {
    command,
    taskText,          // sanitized canonical text or secure artifact reference
    taskHash,
    issueNumber,
    sourceRepository,
    sourceBranch,
    sourcePrNumber,
    sourceOid
  },
  policy: {
    outcome,
    solver,
    landing,
    landingBase,
    cleanup
  },
  roles: {
    author,
    reviewers,
    resolverHistory
  },
  budget: {
    repairUsed,
    repairMax,
    transientUsed,
    transientMax,
    strategySwitchUsed,
    strategySwitchMax,
    invocationId,
    localLimitMs,
    localUsedMs,
    remoteLimitMs,
    remoteUsedMs,
    activeClass,       // "local" | "remote" | null
    activeSince
  },
  branch: {
    name,
    ownedByOrch,
    baseRef,
    baseOid,
    currentOid,
    reviewedOid
  },
  evidence: {
    reviewSetDigest,
    reviewerPromptVersion,
    testCommandDigest,
    testLogPath,
    testLogDigest,
    securityDigest,
    configDigest,
    orchVersion
  },
  solverState: {
    phase,
    attempt,
    failure,
    fingerprint,
    planArtifact,
    previousFingerprints
  },
  landing: {
    stage,
    remote,
    base,
    head,
    publicationClaimRef,
    publicationClaimState,
    ownershipNonceSecretRef,
    prNumber,
    prUrl,
    prCreator,
    mergeMethod,
    mergeRequestedByOrch,
    mergeRequestOrdinal,
    preRequestBaseOid,
    baseAtMergeOid,
    baseAtMergeEvidence,
    mergeCommit,
    remoteUpdatedAt
  },
  authorityAudit: {
    observed,
    observedAt,
    scope,
    reusable: false
  }
}
```

Rules:

- every executable, non-dry new outcome invocation, including `pr --approved`,
  allocates a stable SID before audit, repository mutation, or remote access;
  a planning-only dry invocation allocates/persists no SID and may perform only
  the bounded read-only source resolution defined in §4;
- atomic compare-and-swap on `revision` prevents two `continue` processes from
  advancing the same SID;
- full task text is stored only in the existing protected review/run artifact
  area, while the state can hold a path plus hash if redaction requires it;
- `inflight` remains ephemeral liveness/overlap state and never becomes recovery
  authority;
- RunStateV2 uses a dedicated store with semantic validation and
  non-destructive quarantine/raw preservation. It must not inherit the current
  SID store's delete-on-corruption behavior;
- v1 records migrate lazily: no outcome policy means legacy behavior; a clear
  warning explains that lost entry/task data prevents auto-resume and requires a
  fresh run. Reading legacy state never rewrites or deletes it; an atomic V2
  commit is the first migration write;
- returned `validated`, `pr-open`, `pr-pending`, `pr-ready`, `merge-pending`,
  `manual-action-required`, `blocked`, and `failed-internal` states retain their
  audit/journal and any recovery state required by the terminal policy. Only a
  journaled `cleanup_complete` may clear owned worktree/branch recovery state;
  immutable audit evidence remains retained. Current unconditional
  clear-after-result behavior (`src/cli.js:868-877`, `src/cli.js:1499-1509`) is
  replaced by that exhaustive terminal-policy table.
- attempt/no-progress counters are run-wide and survive `continue`; an explicit
  new invocation restores the configured limits but starts fresh local/remote
  cumulative clocks, so user downtime is never charged and a resume after a
  wait-budget terminal can make bounded progress.

### 5.1 Child capability boundary

Current agent adapters and the configured test command inherit broad process
and filesystem capability. Outcome mode replaces that execution path with a
mandatory broker:

- create a disposable candidate-tree view with no writable `.git`, `.orch`,
  parent directory, sibling worktree, controller journal/lock, SSH agent, or
  host control socket;
- use an ephemeral home and explicit environment allowlist; disable system and
  repository Git config/hooks, credential helpers, askpass, source-control
  provider CLI config, cloud metadata credentials, and inherited authentication
  variables;
- deny Git pushes and provider mutation endpoints at an enforceable network or
  capability-proxy boundary. Optional dependency access is allowlisted and
  cannot reach GitHub/Git remote write paths;
- broker required model inference separately, exposing neither raw model
  credentials nor source-control/MCP mutation tools to the child; model-provider
  transport is not permission to inherit the host Codex/Claude tool surface;
- give authors a writable candidate tree, reviewers a read-only candidate plus
  result channel, and tests a disposable overlay for build artifacts;
- accept only schema-valid, size-bounded patches/verdicts/logs. The controller
  validates paths and OIDs, applies patches to its owned worktree, and performs
  every Git operation through a trusted wrapper backed by generated isolated
  config/Git metadata. The wrapper disables repository/global/system hooks,
  config includes, aliases, external diff/textconv, clean/smudge filters,
  fsmonitor, pager/editor, submodule helpers, credential helpers, askpass, and
  SSH-agent inheritance for checkout/worktree, apply/am, merge/rebase, commit,
  fetch, push, diff, and cleanup—not just commit. Unsupported executable Git
  attributes/config stop preflight;
- inject a scoped source-control credential only into the exact hook-free
  fetch/push transport after the wrapper is established; no hook, helper,
  pager/editor, child, or sibling process inherits it;
- keep `--approved`, the ownership nonce, state paths, and provider mutation
  clients out of every child prompt, environment, filesystem view, and tool
  surface.

The controller is the sole writer of RunState/journal/locks, Git refs/commits,
PRs/issues, and landing actions. Broker unavailability or a failed isolation
self-test stops `manual-action-required` before any child executes. `shell:
false` and environment-variable scrubbing without filesystem/egress enforcement
are insufficient.

---

## 6. State machine

```text
NORMALIZE / PREFLIGHT
        |
        v
ATTACH OR AUTHOR ----> GENERATED CHANGES ----> VERIFY LOCAL
                                              /    |      \
                                             /     |       \
                                      repairable transient policy/authority
                                           |        |          |
                                           v        v          v
                                      DIAGNOSE   RETRY     MANUAL ACTION REQUIRED
                                           |
                                           v
                                    REVISED PLAN / APPLY
                                           |
                                           +-----------> VERIFY LOCAL

VERIFY LOCAL --green--> ENSURE OUTCOME PR --> INSPECT REMOTE
                                                /      |       \
                                           blocked   pending    ready
                                              |         |         |
                                              v         v         v
                                           REPAIR*   WAIT      PR READY (--auto)
                                                                 |
                                                        authority present?
                                                                 |
                                                                 v
                                                        IMMEDIATE MERGE
                                                                 |
                                                                 v
                                                        VERIFY ON BASE
                                                                 |
                                                                 v
                                                               MERGED

* Only when the remote failure is repairable on an orch-owned branch.
```

Every arrow that crosses a side-effect boundary writes state first and confirms
the resulting local/remote truth afterward.

### 6.1 Local verification bundle

`LocalGreen` is a value, not a boolean:

```js
LocalGreen = {
  headOid,
  baseOid,
  reviewers,
  reviewArtifactDigests,
  testCommandDigest,
  testLogDigest,
  securityFindings: [],
  protectedPathFindings: [],
  configDigest,
  orchVersion,
  completedAt
}
```

Changing the head, base, test command, security rules, relevant config,
reviewer set/prompt version, or orch version invalidates the corresponding
evidence. A `tested` checkpoint may no longer skip a gate based on head OID
alone (`src/engine.js:207-217`).

### 6.2 Generated release changes

Dedicated PRs must not push an untested release bump after the gate. Current
integration finalization tests and then applies `release.autoBump`, so its final
tip can differ from the tested tree (`src/finalize.js:205-224`).

For outcome-flag runs:

1. extract deterministic release bookkeeping from finalization;
2. apply it on an orch-owned candidate branch before the final review/test/
   security bundle;
3. record a base-version/config fingerprint so resume does not apply it twice;
4. if the base version changes, regenerate the bump and invalidate verification;
5. if publication discovers a newer base, regenerate on the orch-owned branch
   and repeat the complete evidence bundle; never queue a stale candidate.

When `release.autoBump` is enabled, inability to compute, apply, or commit the
generated change is a structured blocking failure. Outcome mode must never
silently skip the configured bump. The current legacy best-effort wrapper may
remain isolated for no-flag compatibility.

Foreign inputs have an explicit rule. An unchanged `review` branch/PR may be
reused only if its exact head already contains the expected deterministic
generated change and matching fingerprint. Otherwise review mode creates an
orch-owned publication child at the reviewed OID, applies the generated change,
and reruns the complete bundle; the foreign branch/PR remains untouched. The
solver-off `pr --approved` entry never creates that child: if a configured
generated change is absent or cannot be proven for its supplied exact head, it
stops `manual-action-required` with exit 2. `release.autoBump: false` needs no
generated-change proof.

This keeps the exact PR head inside the evidence bundle. Legacy no-flag release
behavior remains unchanged until separately migrated.

---

## 7. Structured failure and solver protocol

String reasons remain for humans but cease to drive control flow. One attempt
returns:

```js
AttemptFailure = {
  code,
  stage,
  summary,
  retryable,
  repairable,
  authorityRequired,
  headOid,
  baseOid,
  evidenceRefs,
  normalizedEvidence,
  cause
}
```

### 7.1 Required classes

| Code family | Examples | Solver behavior |
| --- | --- | --- |
| `REVIEW_*` | disagreement, malformed verdict, reviewer crash | Repair findings; rotate/retry only for classified transient agent failure. |
| `TEST_*` | assertion failure, timeout, spawn error | Persist bounded log; repair code for deterministic failure; retry transient infrastructure. |
| `DIFF_*` | empty output, unreadable diff/OID, head moved | Re-read once; replan empty output; fail closed when evidence remains unreadable. |
| `SCOPE_*` | size or overlap | Decompose/replan only within one-run acceptance criteria; never silently drop scope. |
| `SECURITY_*` | executable-risk finding, fixture-only heuristic | Authority class in v1. Preserve the complete finding set and produce a remediation plan, but do not ask an agent to edit the branch to make the textual scan pass. Stop `manual-action-required`. |
| `POLICY_*` | guardrail/protected path, changes-requested or dismissed review, no eligible independent approver | No solver bypass; emit manual-action packet immediately. |
| `REMOTE_*` | auth, check failure, conflict, API timeout, eligible review not yet submitted | Retry/query remote truth; repair owned branch conflicts; wait for external checks/reviews within the remote budget. |
| `INTERNAL_*` | invalid state/invariant | Preserve state and exit 1. |

### 7.2 Bounded remedy algorithm

Default v1 budgets are config-backed, not extra CLI flags:

```yaml
automation:
  repairAttempts: 2
  transientRetries: 3
  strategySwitches: 1
  maxMinutes: 60
  remoteWaitMinutes: 30
```

Pseudocode:

```text
while the applicable cumulative budget remains:
  result = run one attempt from the earliest invalid stage
  if green: publish
  failure = classify(result)
  persist failure and fingerprint
  if authority required: stop manual-action-required
  if transient and retry budget: backoff; retry stage
  if repairable and repair budget:
      diagnose using full evidence
      require a concrete revised plan and acceptance check
      apply on orch-owned branch
      if fingerprint repeated with unchanged tree:
          switch strategy/agent once
      if repeated again: stop blocked-no-progress
      continue
  stop blocked
```

Fingerprint inputs include the failure code, normalized reviewer findings or
failing assertions, head tree, base OID, and relevant config digest. This fixes
the current behavior where a revision that changes nothing can consume the full
review cap (`src/engine.js:222-230`, `test/engine.test.js:262-267`).

### 7.3 Review repair

Bare `review` is made audit-only to match help. In either new outcome mode:

- the supplied branch and OID remain immutable provenance;
- green review reuses one existing PR only when its source repository/ref
  matches the immutable review provenance, its landing base and head equal the
  resolved base and reviewed OID, and any configured generated-release
  fingerprint is already satisfied, and it is not the configured integration
  branch/PR or another shared aggregation PR; otherwise orch creates an owned
  publication branch at the reviewed OID, applies any required generated
  change, reruns the complete evidence bundle, and opens the outcome PR from
  that branch. A supplied integration/shared aggregation source stops manual
  rather than being copied into a nominally task-scoped PR;
- a repairable disagreement creates an orch-owned child branch at the reviewed
  OID and assigns a resolver author;
- all reviewers then review the child branch's final head;
- cleanup never deletes the supplied branch.

When a repair or publication child exists, that child gets its own dedicated PR
and is the only merge target. In that case orch never updates, closes, or merges
a PR belonging to the supplied branch; it posts one idempotent comment linking
the child PR.
When no repair or publication child is needed, orch may reuse and, under
`--approved`, merge the supplied branch's one matching PR, but it never pushes
that foreign ref or rewrites its PR metadata. If no matching PR exists, the
separate orch-owned publication ref is the only branch it pushes and the only
PR it creates. `--approved` may merge only the final expected outcome head bound
to the complete evidence bundle; for a reused foreign PR that head is the
unchanged reviewed OID.

An interrupted review resumes as review; it never becomes task mode.

---

## 8. Dedicated PR publication

Add `ensureDedicatedPr` alongside one-shot `pushAndCreatePr`
(`src/github.js:265-277`). Legacy `demote` and `openPr` continue to call the
one-shot helper unchanged in v1. The new helper:

1. validate local head equals the expected reviewed OID;
2. before any remote mutation, run the complete exact-head discovery and
   eligibility pass below and journal `publication_discovery_observed` with
   `phase: pre-push` plus coverage. Reuse/verify an eligible exact PR immediately;
   stop on conflict or incompleteness with zero push/PR mutation. Only a complete
   `no match`, or a journal/SID-owned PR whose head equals its journaled expected
   prior OID, may proceed;
3. acquire the deterministic publication claim for
   `{repository, landingBase, expectedHead}` before pushing or mutating a PR.
   The provider adapter must expose a repository-global create-if-absent/read/
   CAS-delete claim namespace that is non-landable and proven not to trigger
   branch/tag CI or PR workflows. For a Git-ref implementation, persist a random
   ownership nonce in protected RunState, create an inert unique claim object
   bound to `expectedHead` and containing only the SID and nonce digest, then
   journal `publication_claim_requested`; the claim lives under a dedicated
   non-head/non-tag ref namespace, never `refs/heads`. An adapter unable to prove
   those properties stops before publication. A
   response loss is reconciled by exact ref OID: this SID's unique claim OID
   proves acquisition, absence permits only the identical bounded retry, and any
   third OID means another SID won. A loser performs no candidate-ref or PR
   write and reports/waits for the winning publication; claims are never stolen
   by age alone;
4. resolve the orch-owned publication ref. Before pushing, journal
   `push_requested` with the ref, new OID, and expected old OID. For first
   publication use `--force-with-lease=<ref>:` to assert that the remote ref does
   not exist; for an update use
   `--force-with-lease=<ref>:<journaled-old-oid>`. On resume from intent or after
   a rejected/lost response, query the ref: the journaled new OID completes
   `pushed`; the journaled expected old OID (including absence) proves the push
   had no effect and permits only the identical CAS push within the configured
   transient-retry and local budgets; any third OID stops `head-moved` and is
   recorded. Never perform a plain or unguarded force push;
5. after the CAS push, rerun complete discovery and eligibility, journaling
   `publication_discovery_observed` with `phase: post-push`, before any PR write.
   A conflict or incomplete result now stops every further mutation and retains
   the journaled claim and orch-owned ref for recovery; neither is deleted or
   force-updated to hide the race;
6. apply the state matrix below. Create only on a second stable `no match`, only
   from the orch-owned ref, and only while this SID owns the exact claim. The PR
   body carries a keyed ownership proof derived from the protected nonce and
   exact tuple. Recover a create-race/422 or ambiguous response by querying, not
   by blindly repeating create;
7. after any create response/reconciliation, run and journal another complete
   fixed-point discovery with `phase: post-create`. Confirm one eligible PR's
   number, creator, ownership proof, base, source ref, and head. A concurrently
   appearing external PR or any duplicate/ambiguous set stops landing and all
   further mutation; the just-created PR/ref/claim remain visible for explicit
   resolution rather than being destructively hidden;
8. persist the remote identity before returning. Only after one eligible PR is
   durably bound and the post-create pass is stable may cleanup release the
   claim with `claim_delete_requested` and an exact claim-OID CAS. A lost delete
   response is reconciled; any third OID is retained and stops cleanup.

The uniqueness fence ends at that durable selection boundary. A foreign exact-
head PR created afterward is disclosed in later observations but cannot replace
or invalidate the journaled `{PR number, claim, nonce proof, creator, base,
head}` binding merely by sharing content. Readiness and merge continue to query
only the bound PR; orch never updates, closes, or merges the late duplicate. If
another actor lands the duplicate, orch reports that external event and
reconciles the bound PR/base truth without claiming its own PR was merged.

`headOid` is the reviewed commit SHA, never a branch name. Discovery uses the
union of: a journal-bound PR-number lookup; the provider's commit-associated-PR
lookup for open/merged candidates; ownership-marker lookup as an index; and an
exhaustive paginated `state=all` repository query whose objects expose
`headRefOid`/`head.sha` plus source repository/ref provenance, filtered by exact
head SHA and landing base. Absence from the commit-associated endpoint alone
never proves no match because it may omit closed-unmerged PRs. If the adapter
cannot exhaustively inspect closed state, pagination/budget expires, or a
candidate's historic head/source provenance is unreadable, the result is
ambiguous `manual-action-required`; orch never takes the no-match create branch.
A branch-name filter is never the primary identity lookup.

“Exhaustive” is temporal, not merely “the last cursor returned.” An adapter must
either expose a provider snapshot token/exact-head completeness guarantee or
perform bounded fixed-point scans ordered by immutable ascending PR identity.
Each epoch records page boundaries, high-water identity, and the full candidate
projection; two consecutive complete epochs must agree on identities, state,
head, base, and source provenance. Creation/retargeting that shifts a page or
prevents a stable pair is incomplete and stops manual. Since an external actor
can still mutate after the final observation, the publication claim fences orch
SIDs and the mandatory post-create scan turns any late external race into a
visible no-landing conflict rather than a false uniqueness claim.

Exact SHA is discovery identity, not ownership authority. Before applying the
matrix, constrain selection by normalized entry provenance:

- `pr --approved` may select only the explicitly supplied PR number; other
  exact-head PRs are recorded but are not candidates for that authority;
- an unchanged `review` with no repair/publication child may select only one
  exact PR whose source repository/ref matches the immutable supplied review
  provenance;
- `task`, `issue`, and every repair/publication-child path may select only a PR
  bound to this SID by a successful publication claim plus a journaled create
  response, or by ambiguity reconciliation that verifies the keyed ownership
  proof, recorded provider creator, exact claim/ref/base/head, and request
  window.

Every entry rejects the configured integration branch/PR and any other
provider-identified shared aggregation PR before this eligibility step. A
visible SID marker alone is never ownership authority: it is predictable and
provider metadata is editable. A forged/copied marker without the protected
nonce proof, claim journal, creator, and exact tuple is a foreign conflict.

Before durable selection on an owned-output or review path, any otherwise exact
foreign candidate outside that eligibility is an ownership conflict. A
pre-push pass stops
`manual-action-required`, lists it, and performs zero remote mutation. If a
candidate appears concurrently after the CAS push, step 4 stops every further
candidate appears concurrently after the CAS push, step 5 stops every further
write and retains the journaled owned ref; it creates/reopens/updates/merges no
PR. After durable selection, later duplicates follow the disclosure-only rule
above. Identical content never transfers PR ownership or operator authority.

Discovery is charged to the cumulative local `maxMinutes` budget as publication
work. Cheap union sources may run first, but no truncation, recency filter, early
match, or single pagination pass may prove either absence or uniqueness. A
provider-specific exact head-SHA lookup over all PR states may replace the
fixed-point enumeration only when the adapter can prove a snapshot-complete
result. A page cap, missing page/cursor, unstable epoch, rate limit, unreadable
historic head, or budget expiry is incomplete and can never become `no match`.
The resulting manual-action packet records method, scan epochs, page boundaries,
high-water identities, records/cursors, every candidate, limiting cause, claim
state, evidence path, and exact recovery action. It never creates a PR;
pre-claim incompleteness makes zero remote mutation, while later incompleteness
retains the claim/owned ref and makes no further write.

Discovery observations are audit evidence, not a reusable absence grant. Resume
and every new mutation attempt repeat the stable pre-push pass immediately
before acting; post-push and post-create passes are likewise fresh for that
attempt.

Discovery is deterministic:

| Match | Action |
| --- | --- |
| exactly one eligible open PR at the expected base/head | reuse it; a permitted foreign review PR remains metadata/ref read-only |
| exactly one eligible merged PR at the expected base/head | record `github_merged` and resume base verification |
| exactly one eligible closed-unmerged PR | reopen only if SID-owned and the provider explicitly supports safe reopen; otherwise `manual-action-required` |
| configured integration/shared aggregation PR or source ref | always ineligible: `manual-action-required` with zero publication/merge mutation |
| any exact but ineligible foreign PR before durable selection on an owned-output/review path | ownership conflict: `manual-action-required`; pre-push means zero remote mutation, post-push means no further write and retained owned ref; list every candidate; no PR is created, reopened, updated, or merged |
| multiple eligible matching PRs or ambiguous state | fail closed with the complete candidate list |
| no match, orch-owned source ref | create once |
| no match, foreign source ref | create an orch-owned publication ref at the reviewed OID, then create once from that ref |

Run idempotency key: `{repository, SID, base, headOid}`. Cross-SID publication
claim key: `{repository, base, headOid}`. An orch-created PR body carries both a
hidden SID index and a keyed proof over the exact tuple using the protected
random nonce. The index supports search; it is not authentication. Ownership
requires the successful claim/journal/provider-creator proof described above. A
reused foreign review PR is never rewritten merely to add either marker; the
landing journal binds that PR's number/base/head/source provenance to the SID,
and any later mismatch fails closed.

Issue comments use `{SID, terminalStage}` markers and update rather than append
duplicates. Orch-created outcome PR bodies use `Refs #N`, never a closing
keyword. Only an `issue --approved` run invokes orch's issue-close API, after the
verified merge commit is observed on `landingBase`; the landing journal makes
that action idempotent. `issue --auto` never invokes it, even when reporting an
externally initiated verified merge. A reused foreign PR body is never
rewritten. Provider-reported closing references from that body are captured in
`readiness_observed` and disclosed before merge when available. PR body/title
and provider closing references are mutable, including on an orch-created PR,
and the provider merge API does not atomically condition on their digest. Every
permitted merge—owned, foreign, or supplied—therefore emits an always-on warning
that the last observation cannot bound provider-native issue effects;
`--approved` accepts that residual provider behavior, not a fiction that
metadata is pinned. Any
resulting observed closure is attributed in `github_merged` as an external
provider effect—not as orch's `issue_closed` stage. Orch never repeats an
already observed closure through the issue API.

---

## 9. Remote readiness

`inspectReadiness(pr, expectedHead)` returns structured evidence:

```js
Readiness = {
  expectedHead,
  actualHead,
  expectedBaseRef,
  actualBaseRef,
  observedBaseOid,
  mergeable,
  mergeState,
  requiredChecks: [{ name, state, conclusion }],
  requiredReviews: { required, satisfied, decision },
  queue: { required, state },
  providerMerge: {
    atomicHeadBaseCondition,
    conditionFields,
    baseAtMergeAdapter
  },
  closingReferences: { observed, bodyDigest, mutable: true },
  blockingReason,
  observedAt
}
```

`pr-ready` requires all of these:

1. actual head equals expected reviewed head;
2. GitHub can compute mergeability and reports no conflict;
3. every required check is known, terminal, and success-equivalent;
4. required review policy is known and satisfied;
5. no ruleset/queue policy currently blocks the head;
6. local evidence is still valid for the same head/base/config.
7. the PR head contains the current landing-base tip: the captured base OID is
   an ancestor of the PR head and GitHub does not report it `BEHIND`.
8. the PR's actual base ref equals the resolved landing-base ref, and it is not
   the configured integration/shared aggregation target.

`BEHIND` handling is ownership-specific and never left as passive waiting. An
orch-owned candidate is updated from base, any base-dependent generated change
is regenerated, and the complete review/test/security/path/readiness bundle is
rerun against its new head. An unchanged foreign review PR or solver-off
supplied `pr --approved` is never updated by orch and stops immediately
`manual-action-required`, exit 2, without consuming remote wait budget. Output
names the owner update/rebase action and the exact original `review ... --auto`
or `--approved`, or `pr <number> --approved`, command to rerun; the old SID's
authority/evidence never rebinds to the moved head.

For unattended merging, readiness additionally records whether GitHub enforces
base currency atomically through a strict required-up-to-date branch rule that
applies to the authenticated actor without admin/ruleset bypass. A client-side
fetch/recheck cannot close the race between observation and the merge request.
If that enforcement cannot be proven, `--auto` may report the current snapshot,
but `--approved` stops `manual-action-required` instead of merging.

It also records whether the actual merge mutation atomically conditions on the
same `{PR, expectedHead, expectedBaseRef, expectedBaseOid}`. Pinning only the
head leaves a retarget race: the PR can keep its head while its base changes
after the last read. A client lock or post-merge ancestry check cannot undo that
destructive effect. At the 2026-08-16 baseline, GitHub's documented
[REST merge](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request)
and GraphQL
[`MergePullRequestInput`](https://docs.github.com/en/graphql/reference/input-objects#mergepullrequestinput)
expose an expected-head condition but no expected-base condition, so the current
GitHub adapter reports approved landing unavailable and makes zero merge calls.
`--auto` may still reach `pr-ready`; `--approved` may do all preparation and then
stop exit 2 with this exact capability gap. Shipping a head-only approximation
is forbidden.

Readiness also proves that the selected provider/merge method exposes enough
commit/event evidence to derive an exact `baseAtMergeOid` after success. The
adapter may use the non-head parent of a merge commit, the parent of a squash
commit, or an equivalently deterministic provider event/rebase-chain proof. If
that capability is known unavailable, `--approved` stops before the request;
post-success missing or malformed evidence is `failed-internal`, never an
assumed merge.

When reviews are required, readiness requires an independently queried
`reviewDecision == APPROVED`; `mergeStateStatus == CLEAN` is insufficient for a
bypass-capable actor. An empty, missing, or unqueryable required-check set is
not green. The current
`statusCheckRollup` helper is insufficient proof of the complete ruleset
(`src/github.js:77-103`). Query live policy; do not infer it from YAML.

Polling uses bounded exponential backoff with jitter and persists observations.
Ctrl-C or process loss leaves `pr-pending` resumable.

---

## 10. Merge authority and verification

On `--approved`, after `pr-ready`:

1. bind the invocation's authority to `{SID, repo, landingBaseRef,
   preRequestBaseOid, PR, expectedHead, requestOrdinal}`;
2. fetch the current landing base. If it advanced since the evidence bundle,
   update only an orch-owned candidate branch, regenerate base-dependent release
   changes, and rerun the full review/test/security/path bundle on the new head.
   A foreign review branch stops `manual-action-required` instead of being
   rewritten;
3. re-query the PR immediately and require its head, base ref, repository,
   source identity, and non-shared eligibility to equal the authority binding;
   any retarget/head/identity change invalidates authority;
4. re-query readiness immediately;
5. require a proven strict server-enforced up-to-date rule that applies to this
   actor without bypass; otherwise stop `manual-action-required`;
6. require a provider merge primitive that atomically rejects unless the PR
   number, expected head, expected base ref, and expected base OID all equal the
   binding. Record the adapter/capability/version evidence. If any condition is
   unavailable, stop `manual-action-required` before a merge call;
7. reject a pre-existing native auto-merge or merge-queue request as an external
   authority conflict;
8. display the last observed closing references/body digest and the always-on
   mutable-metadata warning. The authority accepts possible provider-native
   closing effects changed by a concurrent writer; it never treats the digest
   as atomically pinned;
9. journal `merge_requested` before dispatch with a new ordinal and the entire
   exact binding, then call the ordinary synchronous non-admin merge endpoint
   immediately with all four atomic conditions, only
   after proving all required reviews/checks and confirming no bypass is being
   exercised; never substitute an asynchronous merge/queue endpoint;
10. if the synchronous response reports `merged: true` with a merge SHA, journal
   `github_merged` with `mergeRequestedByOrch: true`, the ordinal, exact binding,
   provider request/actor evidence when available, and that SHA, then continue
   to step 12. If it explicitly and
   authoritatively rejects the request, journal `merge_rejected` with its reason
   and observed base OID; an incomplete/malformed response proceeds to step 11.
   Within the same invocation, a classified base-currency/transient rejection
   may return to step 2 while both budgets remain, up to
   `automation.transientRetries`; every attempt repeats update, generated-change
   handling, the full evidence bundle, and readiness. Authority/policy
   rejection stops immediately. A rejection never carries authority into a
   later invocation;
11. a timeout, transport loss, or otherwise ambiguous response is not
    `merge_rejected` and consumes no rejection retry. Journal
    `merge_response_unresolved`, then append `merge_reconcile_observed` after
    every query. If GitHub authoritatively reports `MERGED`, continue to step 12.
    If authoritative remote truth proves the synchronous request created no
    deferred effect and the PR is not merged, journal
    `merge_reconciled_no_effect` with its lifecycle and observed head. An open
    PR at the expected head is re-inspected and reports the actual state:
    `pr-ready`, exit 2 if still green, otherwise its matching
    pending/blocked/manual terminal. Closed-unmerged or moved-head state stops
    `manual-action-required`, exit 2; an authoritatively non-merged but
    unreadable head/evidence stops `blocked`, exit 2. None remains
    `merge-pending` or becomes `failed-internal`. Never issue a second request
    without a new invocation carrying fresh `--approved`. If remote truth
    remains unavailable or contradictory until the wait budget expires, emit
    durable resumable `merge-pending`, exit 2; a bare `continue` may only
    reconcile it;
12. fetch the returned commit/event evidence and derive `baseAtMergeOid` using
    the method proven in readiness. If it cannot be derived, stop
    `failed-internal`. Because the provider promised an atomic base-OID
    condition, any `baseAtMergeOid != preRequestBaseOid` is a provider/invariant
    violation: record the complete tuple, rule/capability evidence, method, and
    commit and stop `failed-internal`;
13. fetch `landingBase` and require the returned merge commit to be its ancestor.
    A later base advance is harmless when that ancestry holds and step 12
    passed. Only then emit `merged`, close the source issue when this is the
    approved issue policy, and finalize cleanup.

An externally completed exact outcome PR follows a separate observer path. If
no orch request was journaled, record `mergeRequestedByOrch: false`,
`mergeRequestOrdinal: null`, `preRequestBaseOid: null`, and no authority/strict-
rule attribution. Require immutable provider evidence that the PR's merge event
named the intended base ref and exact reviewed head, plus the merge commit's
ancestry on the current landing base. Record the actual merge method and
`baseAtMergeOid` when deterministically derivable; otherwise keep those fields
null with an explicit unavailable-evidence reason. This truthful external
schema may emit `merged` without fabricating a pre-request value, is never
clean-unattended, and `issue --auto` never closes the issue. Reconciliation of a
previously journaled orch request remains the orch-requested schema even when
the provider cannot conclusively attribute which actor won the race.

Any head or base movement invalidates prior evidence and any concrete authority
binding. Before each permitted merge request, the same live invocation may update an
orch-owned candidate, regenerate base-dependent changes, run the entire
review/test/security/path/readiness bundle, and then bind its still-present
authority signal to the new exact head. It never rebinds after an external head
move, on a foreign branch, or in a later invocation; those cases stop and
require `continue <sid> --approved`. The server-enforced strict up-to-date rule
is an additional atomic rejection gate, never a substitute for revalidation.
Direct admin/ruleset bypass is never selected by these flags, and merge queue or
native auto-merge is never armed.

The existing `orch pr --merge` verify-on-base sequence is the behavioral
starting point (`src/github.js:218-240`), but v1 renames its preferred spelling
to `pr --approved` and routes it through the same readiness implementation.

---

## 11. Landing journal and crash recovery

Add an atomic, append-auditable landing journal keyed by SID and head:

```text
validated
generated_changes_applied
publication_discovery_observed (repeatable; pre-push | post-push | post-create)
publication_claim_requested
publication_claim_acquired | publication_claim_conflicted
push_requested
pushed
pr_found | pr_created
claim_delete_requested | claim_released
readiness_observed
merge_requested
merge_rejected | merge_response_unresolved
merge_reconcile_observed (repeatable)
merge_reconciled_no_effect | github_merged
base_verified
issue_closed
cleanup_delete_requested | cleanup_delete_reconciled
cleanup_complete
```

Discovery observations carry phase, method, scan epochs, high-water/page
boundaries, candidates, pages/records/cursor, completeness, limiting cause, and
evidence path. Claim intent/result carries the deterministic claim ref, this
SID's unique claim commit OID, expected absence, exact tuple, and protected
nonce digest. Push intent carries the ref, new OID, and expected absent/prior
remote OID.
Merge-request, rejection, unresolved-response, and reconciliation observations
carry an attempt ordinal plus exact PR/head/base OIDs, authority binding,
provider state, deferred-request state, merge commit if any, query error, and
observation time. `merge_reconciled_no_effect` is an alternative resolution of
a previously ambiguous request, not permission to retry it. A new request is
allowed only after a new validated binding and fresh `--approved` invocation;
an ambiguous response is reconciled, never duplicated.

Before performing any stage, resume queries local/remote truth:

- exact claim ref contains this SID's unique claim OID -> it owns publication;
  absence permits the identical bounded CAS retry only after a journaled intent;
  a third OID is another owner's claim and forbids publication writes;
- remote branch already has expected head -> do not push;
- PR already exists -> do not create;
- native auto-merge or merge queue already armed by any actor -> stop and report
  the external authority conflict;
- GitHub already merged -> verify base;
- orch previously requested an immediate merge but GitHub did not merge -> do
  not repeat it without fresh `--approved` authority;
- issue already closed/comment marker exists -> do not repeat;
- release fingerprint already applied -> do not bump again.

Claim and candidate-ref deletion are side effects, not housekeeping shortcuts.
Before either deletion, journal the exact expected final OID; delete with a
force-with-lease/CAS against only that OID, then reconcile a lost response by
querying the ref. Absence completes the event, the unchanged expected OID allows
only the identical bounded retry, and any third OID is retained and stops
cleanup. No earlier ownership check authorizes an unguarded later delete.

The journal records errors instead of swallowing them. Current
`tryMergeDirect` loses non-409 outcomes (`src/github.js:61-75`); the new path
must return `pending`, `head-moved`, `policy-blocked`, `rejected`, or `merged`.

---

## 12. Concurrency and ownership

- An SID lease prevents concurrent `continue` for the same run.
- A deterministic exact-head publication claim with a unique per-SID claim OID
  serializes distinct SIDs before either can push a candidate ref or create a
  PR. It is a distributed provider CAS, not a process-local lock.
- Owned candidate branches may be repaired and rebased; foreign review branches
  may not.
- Outcome PRs remove task-scoped approval ambiguity but do not take `merge.lock`
  and do not run peer-overlap Guard 2. Mandatory base currency plus full
  re-verification after every base update replaces the local portion of that
  protection; readiness is always refreshed at merge time. For `--approved`, a
  proven server-enforced strict up-to-date rule that applies to the actor is
  mandatory, and the merge primitive must atomically bind PR/head/base ref/base
  OID. The current GitHub head-only primitive is unsupported. Merge-queue-only
  repositories stop for manual action in v1.
- `--authors` is rejected in v1 outcome mode because one invocation cannot
  truthfully promise one terminal result for several candidate PRs.
- Repository concurrency caps still apply. A refusal is a structured expected
  outcome and exits 2 consistently for fresh and resumed runs.
- Shared integration locks remain unchanged for legacy mode.
- Outcome-mode remote PR branches remain alive until GitHub reports the PR
  merged/closed and an exact-OID CAS deletion has been reconciled and journaled;
  `pr-ready` never deletes its own head branch.

---

## 13. Output and exit contract

### 13.1 Human summary

Every outcome-mode invocation ends with the same fields:

```text
Outcome: PR READY
SID: 3457862-0
Source: task
Branch: pr/codex/retry-race-3457862-0
Head: abc1234
PR: https://github.example/owner/repo/pull/42
Local gates: review=green test=green security=green paths=green
Remote gates: checks=green reviews=green mergeable=yes
Unattended merge: available
Solve attempts: 1/2
Next: no merge was requested (--auto)
```

Blocked output names the class, last changed evidence, budgets used, artifact
paths, and one exact resume command.

Every ready summary states whether unattended merge is available. When strict
base-currency enforcement, atomic PR/head/base-ref/base-OID conditioning, or
deterministic merge-time-base evidence cannot be proven, `pr-ready` must say
`Unattended merge: unavailable`, name the missing repository/actor policy or
provider capability, and show the corrective setting or manual next action
before the user spends an `--approved` invocation.

When an approved run's ambiguous request is later proven not to have merged,
the summary states `Requested: MERGED`, the actual observed PR lifecycle/state,
`Merge did not occur`, and the exact safe next action. For a still-ready PR that
is the fresh `continue <sid> --approved` command; a closed, moved, or unreadable
case names its manual/evidence action instead. It never presents a reconciled
no-effect result as a request still in flight.

### 13.2 Machine record

Keep legacy `status` during migration but add versioned `outcome`,
`landingStage`, `requestedOutcome`, `headOid`, `baseOid`, `prNumber`,
`readiness`, `mergeMethod`, `mergeRequestedByOrch`, `mergeRequestOrdinal`,
`preRequestBaseOid`, `baseAtMergeOid`, `baseAtMergeEvidence`,
`publicationClaimState`, `solveAttempts`, and `blockerClass`. Consumers must not
infer base merge from legacy `status: merged`.

The canonical machine outcomes are `validated`, `pr-open`, `pr-pending`,
`pr-ready`, `merge-pending`, `integrated`, `merged`, `blocked`,
`manual-action-required`, and `failed-internal`. Legacy records map as follows:

`legacy-unknown` (an unclassifiable legacy verdict),
`legacy-approved-unconfirmed` (old agent agreement without proof of every V2
gate), `legacy-pr-unconfirmed` (a structurally valid stored PR number/URL without
V2's immutable `{repository, base, headOid, prNumber}` proof), and
`legacy-unkeyed` (a pre-V2 record without a valid SID) are record
classifications, not run outcomes. They live in the same versioned vocabulary
module and are never emitted in the `outcome` field. Missing-SID identity is
orthogonal and may accompany another historical-evidence classification.

Legacy classification is a pure function of immutable stored bytes. Dashboard
and other offline/unauthenticated history readers perform zero network calls,
show the original verdict/reason and stored PR reference, and never rewrite or
dynamically upgrade history. A command already using GitHub for an online
resume/reconciliation may append a new timestamped V2 observation only after
proving exact repository, base, head, and PR number. That observation belongs to
the new run; the legacy record keeps its original classification and is excluded
from V2 outcome metrics.

| Legacy verdict | Migration interpretation |
| --- | --- |
| `approved` | `legacy-approved-unconfirmed`; current legacy execution can emit it before the protected-path floor, so verdict text never proves canonical `validated`. Only a new V2 execution of every required gate may append `validated` |
| `pr` | `legacy-pr-unconfirmed` when a structurally valid stored PR number/URL exists; otherwise `legacy-unknown`. Only a separate online V2 observation can become `pr-open` after exact live proof |
| `pr-fallback`, `merge-deferred` | `legacy-pr-unconfirmed` when a structurally valid stored PR number/URL exists. Without one, map a deterministically supported `dirty-merge`/authority reason to `manual-action-required`, a supported retry-exhaustion reason to `blocked`, and every other case to `legacy-unknown`; always retain the original verdict/reason/reference |
| `merged` | `integrated` unless remote-base verification fields exist |
| `escalated` | `blocked` or `manual-action-required` only after classifying its reason; otherwise legacy-unknown |

One append-only record remains per invocation for audit. V2 records with a
valid SID reduce by SID and count only the latest terminal record for that run,
so a run resumed three times contributes one run—not four. Historical records
without a valid SID remain separate `legacy-unkeyed` records, use a stable
per-record identity, and are excluded from V2 clean-unattended metrics; they are
never coalesced under a missing key.

### 13.3 Exit codes

- `0`: requested outcome reached (`pr-ready` for `--auto`, verified `merged` for
  `--approved`); a verified external merge that supersedes `--auto` is also
  successful but is marked externally completed and not clean-unattended;
- `2`: valid run, requested outcome not reached (pending after wait budget,
  blocked, authority required, concurrency unavailable);
- `1`: usage/preflight error or unexpected internal failure.

This preserves the current 1/2 distinction (`bin/orch.js:3-5`,
`src/cli.js:1510-1517`) while making the run record carry precise state.

Edge terminals are not left to implementation judgment:

| Situation | Outcome and exit |
| --- | --- |
| outcome child isolation/capability self-test is unavailable or fails | `manual-action-required`, 2 before any agent/test child; no child, Git, journal-side-effect, or remote write follows |
| supplied `pr --approved` base differs from `automation.prBase` | `manual-action-required`, 2; no authority binding or merge request |
| configured integration/shared aggregation PR or source is selected by task/issue/review/continue/pr | `manual-action-required`, 2; zero publication or merge mutation |
| multiple matching PRs, foreign closed-unmerged PR, or ambiguous/unstable/incomplete PR discovery | `manual-action-required`, 2, with every observed candidate plus discovery method, epochs/boundaries/pages/records/cursor, limiting cause, and evidence path; pre-claim performs zero remote mutation, later phases retain owned recovery refs and make no further write |
| another SID owns the deterministic exact-head publication claim | `manual-action-required`, 2 (or bounded observation until its publication appears); the losing SID performs zero candidate-ref/PR write and never steals the claim by age |
| exact-head PR exists but is ineligible for this entry/SID/source provenance | `manual-action-required`, 2, with the ownership conflict listed; pre-claim makes zero remote mutation, later phases retain the claim/owned ref and make no further write; no PR is created, reopened, updated, or merged |
| merge queue is the only permitted landing mechanism | `manual-action-required`, 2 for either flag; the outcome PR remains open and orch never enqueues it |
| strict up-to-date enforcement cannot be proven, but direct landing is otherwise allowed | `--auto` may reach snapshot `pr-ready`, 0; `--approved` stops `manual-action-required`, 2 |
| provider cannot atomically condition merge on PR + expected head + expected base ref + expected base OID | `--auto` may reach snapshot `pr-ready`, 0; `--approved` prepares then stops `manual-action-required`, 2 with zero merge calls. This is the current GitHub baseline |
| provider/merge method cannot supply deterministic `baseAtMergeOid` evidence | before request, `--approved` stops `manual-action-required`, 2; if advertised evidence is missing/malformed after success, `failed-internal`, 1 with no issue closure/cleanup |
| foreign review PR or supplied `pr --approved` is `BEHIND` | `manual-action-required`, 2 immediately; never update it or consume remote wait budget. Name the owner update/rebase and exact original outcome command to rerun as a fresh audit |
| required review is not yet submitted and an eligible independent approver may still act | `pr-pending`, 2 if the remote wait budget expires; preserve the observation and exact approver action for resume |
| required review is changes-requested, dismissed, or impossible because no eligible independent approver exists | `manual-action-required`, 2 immediately; do not consume the remote wait budget |
| another actor merges an `--auto` outcome PR | after intended-base event/head and current-base ancestry verification, `merged`, 0, with `mergeRequestedByOrch: false`, null request/pre-request-base fields, and actual method/merge-time-base only when derivable; never attribute strict-rule enforcement or count it clean-unattended |
| bare resume finds this run's journaled immediate request already merged | verify base and finish `merged`, 0; this is reconciliation, not reused authority |
| bare resume proves the journaled request did not merge | no repeat; apply the lifecycle/readiness mapping in the next row and require fresh `--approved` only where another request remains applicable |
| an immediate merge request's effect remains genuinely unresolved because authoritative reconciliation is unavailable or contradictory | `merge-pending`, 2 when the remote budget expires; retain and journal every observation, allow bare-resume reconciliation only, and never repeat the request |
| reconciliation proves the synchronous request created no deferred effect and the PR is not merged | journal `merge_reconciled_no_effect`. Open at expected head reports current readiness (`pr-ready`, 2 if still green); closed-unmerged or moved head is `manual-action-required`, 2; authoritative non-merge with unreadable head/evidence is `blocked`, 2. Never remain `merge-pending`, emit `merged`/`failed-internal`, or request again without a later fresh `--approved` invocation |
| GitHub reports `MERGED`, but its merge commit is not yet an ancestor of `landingBase` | `merge-pending`, 2, while the remote budget remains; journal each re-fetch. On budget exhaustion emit `failed-internal`, 1, naming PR, merge commit, and observed base. Never close the issue or clean up |
| an orch-requested merge's derived `baseAtMergeOid` differs from its atomically bound pre-request base OID | `failed-internal`, 1, recording the complete condition/capability evidence, expected head, merge commit/method, and both base OIDs; never emit `merged`, close the issue, or clean up. A current base tip that advances only after a valid merge is not a violation |
| claim/publication ref moves between cleanup check and delete, or delete response is lost | CAS-delete only the exact journaled OID; a third OID is retained and stops cleanup, while absence or the unchanged expected OID is reconciled without an unguarded delete |

For an issue run, only the `--approved` policy owns automatic issue closure.
`issue --auto` never closes the issue, even if another actor merges its PR while
orch is observing it; output records the verified external merge and the exact
issue-follow-up action.

---

## 14. Configuration

The only new public configuration is bounded automation policy. There is no
approval setting:

```yaml
automation:
  prBase: main             # default is the resolved baseBranch
  repairAttempts: 2
  transientRetries: 3
  strategySwitches: 1
  maxMinutes: 60
  remoteWaitMinutes: 30
```

`maxMinutes` and `remoteWaitMinutes` are cumulative per-invocation budgets, not
one continuously running deadline, and exactly one is charged at any instant.
The local budget covers preflight, local Git work, agents, tests, generated
changes, and PR publication. The remote budget is charged only while polling or
waiting on remote state or verifying a submitted merge. Local work re-entered
from the remote phase—including a base update, release regeneration, and the
full review/test/security/path bundle—is charged to `maxMinutes`. Worst-case
invocation wall clock is their sum regardless of phase alternation. Every
subprocess and API loop receives the remaining applicable budget; expiration
persists its observation and returns a resumable bounded outcome rather than
starting another full-duration operation. `automation` is a closed safety-policy
schema: configuration validation rejects wrong types, out-of-range values, and
every unknown or misspelled key. No unknown key merely warns or silently falls
back to a default budget or landing policy.

CLI outcome intent overrides legacy `github.autoMergePr` and `main.autoMerge`
for that invocation:

- `--auto` hard-disables merge calls;
- `--auto` also forbids native auto-merge arming and merge-queue enqueue;
- `--approved` uses only the new immediate atomic exact-head/exact-base
  readiness/merge path and never arms a deferred remote merge; the current
  head-only GitHub adapter stops before merge;
- no flag preserves current config behavior.

Legacy knobs receive deprecation telemetry but are not rewritten automatically.
The effective policy is printed at preflight and stored in the run record.

---

## 15. Automation-surface boundaries

- The existing GitHub label workflow remains audit-only. It never appends
  `--approved`.
- A future workflow approval path requires a separate protected environment or
  manual dispatch with explicit protected input; it is not a conditional branch
  in the mixed label/manual job.
- MCP may expose `auto: true` only after its fixed argument schema and timeout
  behavior are updated. It must not expose merge authority in v1.
- Task/issue text cannot smuggle controller flags because it remains data after
  `--`. More importantly, the §5.1 broker—not `shell: false` alone—prevents an
  agent/test from reaching Git/provider/state mutation capabilities.
- Non-interactive local CLI use is supported: the explicit flag is the authority
  signal, no confirmation prompt is added. The run records the authenticated
  GitHub actor when available but does not pretend that identity is a code-review
  approval.

---

## 16. Required telemetry

Record without storing sensitive reviewer prose:

- requested/effective policy;
- entry command and SID;
- attempt and retry counts by class;
- normalized blocker class;
- time in author/review/test/security/remote-wait states;
- PR identity and exact head/base;
- merge-request provenance/ordinal, method, nullable pre-request base, derived
  merge-time-base evidence, and atomic head/base capability digest;
- publication claim/scan epochs, ownership-proof result, and CAS cleanup state;
- child-isolation profile/version and denied-capability audit counters;
- readiness components;
- approval signal source and scope (not a credential);
- detected native queue/auto-merge state versus the new direct ordinary merge;
- verified terminal outcome;
- recovery/replay counts for each idempotent side effect.

Success-rate dashboards split `validated`, `pr-ready`, `merge-pending`,
`integrated`, and verified `merged`. Metrics reduce only valid-SID V2 invocation
records by SID; SID-less history stays individually visible as
`legacy-unkeyed`; stored legacy approvals and PR references remain visibly
`legacy-approved-unconfirmed`/`legacy-pr-unconfirmed` rather than guessed V2
outcomes. `cleanUnattendedCycles` counts only V2 SIDs whose requested outcome
was reached without manual action and excludes externally completed merges.

---

## 17. Design decisions closed

| Question | Decision |
| --- | --- |
| Are the flags additive booleans? | No; they are mutually exclusive terminal outcomes. |
| Does `--approved` imply the solver journey? | Yes for task, issue, review, and continue; `pr --approved` is the explicit solver-off exception. |
| Can `--auto` merge through config? | Never. |
| Can `--approved` bypass a gate or ruleset? | Never. |
| Does v1 use the standing integration PR? | No; one task-scoped outcome PR avoids cross-task authority. |
| Can review/pr select the standing integration or another shared aggregation PR? | Never in outcome mode; stop manual with zero publication/merge mutation. |
| What does an outcome PR target? | `automation.prBase`, defaulting to the configured `baseBranch`. |
| Is every escalation solvable? | No; bounded remedy plus explicit manual/policy terminals. |
| Is approval durable across a later invocation? | No; audit is durable and authority is always re-presented. Outcome mode never arms a deferred native/queue merge in v1. |
| Can a review repair its input branch? | No; repairs use an orch-owned child branch. |
| Can review mode merge the supplied foreign PR? | Only the no-repair/no-publication-child, non-shared case: `--approved` may merge one unchanged exact-head/exact-base PR after generated-release/full readiness and atomic provider capability proof, without pushing or rewriting it. The user receives the mandatory mutable-metadata warning. When a child exists, only the child PR may be merged. |
| Does an exact SHA make a foreign PR reusable by any entry? | No. Selection must also satisfy the entry/SID/source-provenance eligibility rules in §8; an ineligible exact match is a fail-closed ownership conflict. |
| Does a hidden SID marker prove ownership? | No. It is an index only; claim acquisition, protected nonce proof, provider creator, exact tuple, and journal establish ownership. |
| Can multiple authors use outcome mode in v1? | No. |
| Is an open PR ready? | No; remote checks, reviews, mergeability, and exact head must be proven. |
| Is local integration merged? | No; report `integrated`. |
| Does continue restore the original mode/task/policy? | Yes; it is mandatory. |
| Does bare continue inherit the stored outcome policy? | It inherits stored `--auto` (`pr-ready`, bounded solver, outcome PR). A stored `base-merged` outcome resumes as `pr-ready`; merge authority must be presented again with `--approved`. |
| Does `pr --approved` run the solver? | No. It is authority-only for a foreign PR head after audit and readiness proof. |
| Does dry planning create a run? | No. Fresh dry planning allocates no SID/state and may perform bounded reads only; continue dry reads but never revises its existing SID. |
| May children inherit GitHub/Git/state capability? | No. Enforced isolation is a prerequisite; controller-only mutation is non-negotiable. |
| Can the current GitHub head-only merge API implement `--approved` landing? | No. Preparation may complete, but landing stops until an atomic PR/head/base-ref/base-OID primitive exists. |
| What if a green review has no eligible matching PR? | If stable discovery also finds no ineligible exact-match conflict, acquire the cross-SID claim, create an orch-owned publication ref at the same reviewed OID, and open/reconcile the outcome PR from that ref; never push the foreign branch. |

Any implementation that changes one of these decisions requires a new design
review rather than an incidental code-review exception.
