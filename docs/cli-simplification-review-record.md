> **SUPERSEDED (2026-08-17).** This document is kept as prior art only. It is replaced by
> `docs/cli-v2-proposal.md`, `docs/cli-v2-design.md` and `docs/cli-v2-implementation-plan.md`,
> which resolve its open decisions differently (single `--until ready|merged|once` flag, standing
> integration PR as the merge target, clean break at v0.5.0). Where the two sets disagree, the
> `cli-v2-*` set wins; the conflict list is in `docs/cli-v2-proposal.md` §9.
> Note: the content hashes recorded below were computed before this header (and the matching
> headers on the three reviewed documents) were prepended; they no longer match the files on disk.

# Review record: outcome-driven CLI simplification

**Scope:** design approval only; no implementation or rollout authorization  
**Source baseline:** `587965117bdd7e702c02e0e7830b5e10fe06d175`
(`v0.4.315`)  
**Review date:** 2026-08-16  
**Status:** internal review approved; final Claude confirmation pending

---

## 1. Artifacts under review

- `docs/cli-simplification-proposal.md`
- `docs/cli-simplification-design.md`
- `docs/cli-simplification-implementation-plan.md`

Frozen content hashes for the final review candidate:

- proposal: `2795299bc5dd7a7292b457039fe896ec61afc622a51c057926c9cf9408bc6ea8`
- design: `081a4d45c60232dcde4f33b56fa177d86969e731b65d33d6b12d1def644c35f7`
- implementation plan: `c5b71303e22c8796ff9ed386a8811ba7de5bbcd4370879c5ff2c73c1c9ea3349`

This record approves or rejects only those documents. It does not assert that
the feature exists, authorize a production merge, or waive any implementation
gate in the plan.

## 2. Evidence baseline

The advisory review used the source tree and current behavior rather than
project lore as the primary evidence:

- Git HEAD was `587965117bdd7e702c02e0e7830b5e10fe06d175`, with the root checkout
  on `main...origin/main` and the pre-existing untracked `pr465/` preserved.
- Live CLI help confirmed the current `task`, `issue`, `review`, `continue`, and
  `pr --merge` surface.
- The 2026-08-16 dashboard snapshot contained 332 records, 135 legacy `merged`
  records, 7 `pr` records, a directional 42.8% success rate, and zero clean
  unattended cycles. The review treated these as legacy metrics, not a reliable
  post-design SLO.
- Specialists traced current CLI dispatch, checkpoints/resume, engine/gates,
  finalization, GitHub publication/merge, release generation, notification, and
  dashboard behavior.
- Read-only focused suites run by the specialists passed: 172/172 workflow
  tests, 182/182 landing tests, and 272/272 combined state/engine/finalize/
  GitHub/config/metrics tests. Test counts were corroboration, not substitutes
  for authority, concurrency, protocol, or documentation review.

## 3. Review method

The review used four layers:

1. Three parallel source specialists mapped CLI/UX, solver/resume, and
   approval/landing risks.
2. Claude performed an independent source-backed architecture review. Its first
   pass was conditional and produced findings F1-F15.
3. Independent implementation, safety/concurrency, and fresh-reader reviewers
   adversarially checked the revised documents.
4. A final Claude pass and final frozen-snapshot reader checks determine the
   approval recorded below.

No reviewer was authorized to edit product code, Git history, repository
configuration, or GitHub state.

## 4. Decision ledger

The following decisions are non-negotiable for implementation:

1. `--auto` exhausts bounded safe remedies and may publish/wait for one
   task-scoped outcome PR, but never merges, enables native auto-merge, or
   enrolls a merge queue.
2. `--approved` is invocation-only operator authority. It is not agent
   agreement, a GitHub review, or permission to bypass any gate or ruleset.
3. Task, issue, review, and continue share one normalized outcome controller.
   `pr --approved` is the documented solver-off compatibility exception.
4. Every merge is bound to one SID, repository, permitted landing base, PR, and
   reviewed head. Head/base movement invalidates evidence; later invocations
   must re-present authority.
5. V1 uses an immediate ordinary merge only when a strict server-enforced
   up-to-date rule demonstrably applies to the actor without bypass. Native
   auto-merge and queue enrollment are prohibited.
6. Security findings, protected paths, missing human approval, ambiguous remote
   state, and unprovable policy fail closed. The solver cannot edit merely to
   evade the deterministic security scanner.
7. Outcome PR publication, generated changes, merge requests, issue actions,
   and cleanup are durable and idempotent. Foreign review refs remain immutable.
8. `integrated`, `pr-ready`, and verified `merged` are distinct. Metrics reduce
   only valid V2 SIDs; SID-less history remains individually visible.
9. Bare review becomes audit-only only when P9 and its P10 migration notice ship
   together. Strict parser corrections and the tightened `pr --merge` alias are
   disclosed as script-visible changes.
10. No implementation begins from this record alone: every phase, test,
    fault-injection, preview-cohort, and independent implementation-review gate
    in the plan still applies.

## 5. Finding disposition

| Finding | Severity at discovery | Final disposition |
| --- | --- | --- |
| F1 security repair could optimize around a textual scanner | High | Resolved: every deterministic security finding is authority/manual-only in v1. |
| F2 dedicated PR lost integration Guard 2/base-race protection | High | Resolved: current-base containment, complete revalidation, exact-head request, and mandatory strict server enforcement without bypass. |
| F3 PR landing base unspecified | Medium | Resolved: `automation.prBase`, default `baseBranch`; supplied PR must match. |
| F4 `pr --approved` conflicted with solver semantics | Medium | Resolved: solver off, supplied-PR landing, authority only. |
| F5 repaired review merge target ambiguous | Medium | Resolved: repair child is sole target; green no-PR review uses an owned publication ref. |
| F6 auto could arm a future merge | Medium | Resolved: merge calls, native auto-merge, queues, and both legacy auto-merge paths are prohibited. |
| F7 issue could close before verification | Medium | Resolved: `Refs #N`; only approved policy closes through API after base verification. |
| F8 bare-review compatibility contradiction | Medium | Resolved: deliberate correction ships atomically with replacement flags and migration note. |
| F9-F15 vocabulary, helper isolation, missing record, resume, budgets, config, metrics | Low | Resolved in the design and plan; this file supplies F11's durable record. |
| IV-01-IV-09 implementation sequencing/state/publication findings | High/Medium | Resolved: P0/P9 timing, V2 preservation, release failure, PR state matrix, SID handling, and two-phase preflight are explicit. |
| Native auto-merge authority could outlive invocation | High | Resolved: prohibited for v1; pre-existing external requests stop manual. |
| Fresh-reader queue/dry/edge-terminal/migration gaps | Medium/clarity | Resolved with an exhaustive outcome-option schema, terminal matrix, external-merge attribution, and quantitative promotion gates. |
| Foreign review/PR generated-release policy was undefined | Medium | Resolved: reuse requires exact fingerprint; review may create an owned fully revalidated child; solver-off PR stops without mutation. P5 is a prerequisite of P7/P8. |

## 6. Reviewer verdicts

| Reviewer | Focus | Verdict |
| --- | --- | --- |
| CLI/UX specialist | Current grammar, automation contract, compatibility | Findings incorporated |
| Solver/workflow specialist | Resume, evidence, failure taxonomy, bounded repair | Findings incorporated |
| Approval/landing specialist | Authority, exact-head landing, concurrency, telemetry | Findings incorporated |
| Claude pass 1 | Independent architecture/source review | Conditional; F1-F15 required revision |
| Implementation verifier | Feasibility, dependency order, migration, state | **APPROVE**; no High/Medium findings |
| Safety verifier | Base race, bypass, persistent authority, foreign ownership | **APPROVE**; no High/Medium findings |
| Fresh-reader final pass | End-to-end command and terminal clarity | **APPROVE**; no High/Medium finding or material ambiguity |
| Claude pass 2 | Final independent F1-F15 and new-finding audit | Pending final verdict |

## 7. Final approval

Final design approval is recorded only after the two pending rows above return
unconditional `APPROVE`, with no High or Medium finding and Claude scores of at
least 4/5 in every requested dimension. Until then this is an evidence ledger,
not the final approval certificate.
