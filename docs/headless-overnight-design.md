# Headless Overnight Design — Planner + DAG + Diverse-Retry

Status: **design agreed, not built.** Discussion 2026-07-10. Crux resolved 2026-07-10 (see end).

## Problem

The overnight "humanless" orch run stops too often — blocked PR merges, PR
conflicts, "how do I proceed?" prompts. Root cause is **not** a knowledge gap;
it's an **authority gap**. Orch usually knows how to resolve the conflict, but
stops because the action is semi-irreversible and no policy pre-authorizes the
call. Headless-for-real = front-load those decisions so "ask the human" becomes
"diagnose, park, keep going; human reads the queue at breakfast."

## Agreed architecture

Two new stages the engine doesn't have today, wrapped around the existing
author→review→merge cycle.

1. **Planner** — entry: a raw task string *or* an existing issue #N.
   Emits a **DAG**: sub-issues (single-purpose, independently-buildable units)
   plus explicit **dependency edges**. No edge = truly parallel. Edge = real
   code dependency forcing order.
   - Split unit = **sub-issue**, not PR. Issues are the planning unit; PRs the
     delivery unit; 1:1. Splitting straight to PRs skips the artifact needed to
     reason about independence before code exists.
   - Independence is a **decompose-time** property. Cannot be created at merge
     time — only observed. So it must be designed in here.

2. **Plan audit** — a second agent adversarially audits the DAG **before any
   authoring**: are units actually independent, boundaries clean (no
   half-functions split across units), edges correct. This is the existing
   author→audit pattern **lifted one level up**, onto the plan instead of the
   code. It's the safety net against the planner's own spec-authoring errors.

3. **Parallel authoring** — units with no incoming edge run in parallel; edged
   units wait on upstream. Each unit → its own PR.

4. **Park + cascade** — a unit that can't land **parks** (new state; today the
   only terminal exit is `escalate`). Its edge-children wait; everything off
   that subtree keeps going. One park never stops the whole run. Park writes a
   diagnosis note to a **breakfast queue** the human reviews next morning.

5. **Diverse-retry / convergent-failure detector** — fires before park. See
   below. This is what earns the `--dangerously-keep-going-till-100%-sure`
   intent: keep grinding a coding error, park a spec error.

### Dropped / kept

- **Dropped:** `scope.maxLines` as an escalate gate. It measures *size* as a
  proxy for the real property (*single-purpose + independently reviewable*) and
  once the planner splits by *logic* the proxy is actively wrong — a from-scratch
  docs PR is one clean 2000-line unit and should sail through; a 200-line PR
  smeared across 3 concerns should not. Line count can't tell them apart. It
  also fires *after* authoring today (`engine.js:99-105`) — a post-hoc reject
  that throws away work and could never be a real splitter. Survives at most as
  a **soft hint to the planner**, never a gate on output.
- **Kept:** the revise loop (`reviseCap`, default 3) — for in-PR polish *within
  one approach*, orthogonal to diverse-retry.

## The convergent-failure detector

Job: given a failing unit, decide **coding error (keep retrying)** vs **spec/
logic hole (park + escalate)**. Signal = **convergence**: K independent, diverse
attempts all fail the **same way** = the spec is unsatisfiable.

### Sameness (the ballgame)

- **Do NOT** compare raw error text — line numbers, tmp paths, addresses,
  timestamps differ → identical failures read as divergent → never parks.
- **Do NOT** compare "did it fail at all" → everything same → always parks.
- **Anchor on the failing acceptance-test assertion**, structured not textual:
  `(test_id, assertion_kind, expected-shape vs actual-shape)`, volatile bits
  normalized out. K authors all failing `test_X` on the *same assertion* =
  convergent on a contract the spec defined = unsatisfiable/self-contradictory
  spec. Different tests / lint / import-crash across attempts = divergent = just
  coding mistakes, keep going.
- **Fallback** when no structured test output: an **agent judges sameness** —
  constrained to a forced yes/no "same root failure?" over the K summaries.
  Structured-assertion-match is primary; agent-judge is fallback.

### Diversity (what makes convergence *evidence*, not noise)

Correlated attempts (same model, same prompt, same temp) fail alike for *coding*
reasons too → false "converged → park." Ranked:
- **Different approach** (strongest) — structurally different solution.
- **Different model** (good, cheap default) — opus/sonnet/codex, uncorrelated
  blind spots.
- **Prompt reword** (theater) — banned from the detector; makes the flag lie.

Floor = model-diversity; decisive attempts = approach-diversity.

### K (sequential, early-exit — not a fixed batch)

Spawn diverse attempts one at a time:
- Any attempt goes **green** → coding error, ship it, stop (cheap common case).
- **≥2 convergent failures** (same assertion, diverse attempts), none green →
  **park: convergent** + write the contradiction into the breakfast note.
- **Retry cap (~4)** hit without either → **park: inconclusive** — *distinct
  label*. "convergent" = your spec is wrong, here's how (actionable);
  "inconclusive" = I couldn't decide, look yourself. Different queues.

### Scope guard

The detector **trusts the acceptance test.** A weak test that passes while the
code does the wrong thing is *not* the detector's problem — that's plan-audit's
job (is this criterion adequate?) and the reviewer's. Keep it narrow: decide
coding-vs-spec *given a trustworthy test*.

### Placement

Sits **above** the revise loop. Revise polishes within one approach; when revise
is exhausted, *that* is attempt-1's failure, and diverse-retry spawns attempt-2
as a **fresh diverse author**, not a revise.

## Crux — resolved: YES

The detector's anchor is a **fixed acceptance test per unit.** No test → nothing
for convergence to bite on → degrades to agent-vibes (the "headless that lies"
failure we're killing).

**Decision (2026-07-10): the planner MUST produce a concrete acceptance test —
or criteria crisp enough to become one — as a required output for every
sub-issue, and plan-audit MUST reject any sub-issue lacking one.** Rationale:

- The whole design earns its `--dangerously-keep-going-till-100%-sure` intent
  from the convergent-failure detector, and the detector is *defined* to trust a
  per-unit acceptance test (Scope guard). A unit with no test can't feed the
  detector at all, so it can't be run headless by construction — it would fall
  straight through to agent-vibes, the exact failure mode this kills.
- It costs nothing new: plan-audit already adversarially audits each unit for
  independence and clean boundaries. "Does this unit carry a testable acceptance
  criterion?" is one more check in the pass that's already running — not a new
  stage.
- It makes "untestable → park early" a **decompose-time** verdict, consistent
  with the doc's own thesis that independence (and now testability) is a property
  you *design in*, not one you discover at merge time. A unit that genuinely
  can't be given a crisp criterion is a spec smell — surface it in the breakfast
  queue at planning, before wasting author cycles on it.

Consequence for the pipeline: **acceptance-criterion presence is a hard gate in
plan-audit.** A sub-issue with only vague prose criteria is bounced back to the
planner (or parked `inconclusive`), never authored. This locks the detector's
anchor and closes the last open question in the design.
