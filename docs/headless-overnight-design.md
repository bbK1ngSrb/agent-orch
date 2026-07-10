# Headless overnight orch: planner + DAG + diverse-retry

**Status: design / proposal — not implemented.** This document is the durable
design record for a feature that lets an orch run survive an unattended
overnight without a human babysitting it. The tracking issue for the feature
links here. Nothing described below ships until it is decomposed into the
separate deliverables listed at the end; each lands and is reviewed on its own.

Written in the teaching register the rest of this repo uses: it explains *why*
each piece exists and defines the non-obvious terms inline, because the design
only makes sense once you see the one problem it is built around.

---

## 1. The problem: an authority gap, not a knowledge gap

Today a single `orch` cycle is `author → cross-audit → test-gate → merge`
(see `docs/orch-manual.md` for the full mental model). It has exactly one way
to *not* finish cleanly: it stops and waits for a human. Reviewer disagreement
past `reviseCap` and red tests **escalate** — the cycle writes a local
`DECISION.md` and halts (it does *not* open a PR). A merge conflict or file
overlap instead **demotes** to a PR fallback (or the same decision file when
there is no remote). The two mechanisms differ in how they record the stop, but
the effect is identical: nothing is discarded, but nothing proceeds either.

For a person sitting at the keyboard that is the right default: one stop, one
glance, one decision. For an *overnight* run it is fatal. A single blocked
merge, one PR conflict, one "how do I proceed?" halts the entire run, and eight
hours of unattended compute produce one stuck cycle instead of a night of work.

The instinct is to say orch stops because it *doesn't know* how to resolve the
situation. That is almost never true. Orch usually knows exactly how to resolve
it — the resolution is just **semi-irreversible** (merging, parking, giving up
on a subtree) and no policy pre-authorizes the call, so it defers to the human.
The gap is one of **authority**, not knowledge.

The whole design follows from that reframing. Real headless is not "make the
agent smarter." It is **front-loading the irreversible decisions** so that
"ask the human" becomes "diagnose it, set that subtree aside, keep going — the
human reads a queue at breakfast."

---

## 2. The design in one breath

Two new stages wrap the existing cycle, and one new terminal state joins
`escalate`:

1. **Planner** — turns a raw task (or an existing issue `#N`) into a **DAG** of
   single-purpose sub-issues plus explicit dependency **edges**.
2. **Plan audit** — a second agent adversarially audits that DAG *before any
   code is written*.
3. **Parallel authoring** — edge-free sub-issues author in parallel; edged ones
   wait on their upstreams. Each sub-issue becomes its own orch cycle.
4. **Park + cascade** — a sub-issue that cannot land **parks** (the new terminal
   state) instead of halting the run; its dependents wait, everything off that
   subtree keeps going, and a diagnosis note is appended to a **breakfast
   queue**.
5. **Convergent-failure detector** — decides, for a failing sub-issue, whether
   to keep retrying (coding error) or to park (spec/logic hole).

A "DAG" (directed acyclic graph) is just tasks-as-nodes with one-way dependency
arrows and no cycles — the standard shape for "these can run in any order, those
must wait." The point of computing it *here*, at decompose time, is the crux of
the whole design (§4).

---

## 3. The five pieces

### 3.1 Planner

Input: one task or issue. Output: a set of **sub-issues**, each
*single-purpose* and *independently buildable*, plus a set of **edges** where a
real code dependency forces order.

The discipline is: **no edge means the two units are genuinely parallel; an edge
means one truly cannot be built until the other exists.** Not "feels related" —
a compile-time or contract-level dependency. Independence is a property you
*design in* while decomposing; you cannot rediscover it at merge time, when the
diffs already overlap and it is too late to pull them apart.

### 3.2 Plan audit

This is the existing `author → cross-audit` pattern lifted one level up: a
*different* agent adversarially reviews the **plan** instead of the **code**.
It checks the three things the planner can get wrong — are the units actually
independent, are the boundaries clean, are the edges correct (none missing that
would cause two "parallel" units to collide, none invented that serialize work
needlessly). Auditing the plan is far cheaper than discovering a bad
decomposition after four PRs have been authored against it.

### 3.3 Parallel authoring

Each sub-issue runs as an ordinary orch cycle — same author, cross-audit,
test-gate, merge — so this reuses everything that already exists. The only new
scheduling rule is the DAG: a unit starts once all its upstream edges have
landed; edge-free units all start at once, bounded by the existing
`concurrency` cap. Each unit gets its own author branch, exactly as today; how
its result reaches `main` then follows orch's existing merge modes unchanged —
by default (`merge: no-ff`) successful cycles merge into the shared
`orch/integration` branch and pile onto one persistent integration→`main` PR,
while `merge: pr` mode instead gives each cycle its own PR straight to `main`.

### 3.4 Park + cascade — a new terminal state

Today a cycle has one non-merge exit: `escalate`. This design adds a second:
**park**. Parking is escalation that does **not** stop the run. When a unit
cannot land, it parks; its edge-**children** wait (their dependency was never
satisfied), but every unit *not* downstream of it keeps going. One park never
stops the whole run — that single property is what makes an overnight run
survivable.

A park writes a **diagnosis note** to a **breakfast queue**: a simple ordered
log the human reads the next morning. Each entry says which unit parked, the
park reason (see §3.5), and the evidence. The human wakes up to a queue to
triage, not a run that died at 1 a.m. on its first obstacle.

Park is deliberately kept distinct from `escalate`; this design does not touch
the existing escalate path, its verdict handling, or the test-gate. It adds a
parallel terminal state alongside them.

### 3.5 Convergent-failure detector

This fires *before* park and answers the one question that decides everything:
is a failing unit a **coding error** (keep retrying) or a **spec/logic hole**
(park and escalate to the breakfast queue)?

The signal is **convergence**. Run K independent, **diverse** attempts at the
unit. If they all fail the **same acceptance-test assertion**, the spec itself
is unsatisfiable — the failure is in the *problem*, not the *attempts*. If they
fail in different places, or one goes green, it was a coding problem and normal
retry was right.

Two details make this real rather than theater:

- **Diversity is what turns convergence into evidence.** If every attempt is the
  same agent with the same approach, them all failing the same way proves
  nothing — it is one failure sampled K times. Diversity means a genuinely
  different **approach** (strongest signal) or at least a different **model**
  (the cheap default). Rewording the prompt is explicitly **banned** — it looks
  like variation while changing nothing, and would manufacture false
  convergence.
- **The assertion must be structured, not scraped from error text.** Convergence
  is measured on *which acceptance-test assertion failed*, identified
  structurally — not by string-matching raw stderr, which drifts between runs
  and would make identical failures look different (or vice versa).

Control flow is **sequential with early exit**, so the cheap outcomes cost the
least:

- any attempt goes **green** → ship it, stop;
- **≥ 2 convergent** failures (same assertion, diverse attempts) → park
  `convergent`, recording the contradiction (the assertion the spec cannot
  satisfy);
- retry **cap** reached (~4, mirroring today's `reviseCap` ceiling) without
  convergence → park `inconclusive`.

`convergent` and `inconclusive` are distinct park reasons on purpose: the first
says "your spec is self-contradictory, here is the assertion that proves it";
the second says "we could not decide in the budget, a human should look." They
demand different things from the reader at breakfast.

---

## 4. The keystone: every sub-issue carries a fixed acceptance test

The detector in §3.5 anchors entirely on **a fixed acceptance test per unit**.
Remove that anchor and the whole thing collapses: with no test, there is no
assertion for convergence to bite on, and "did these attempts converge?"
degrades into the detector *asking an agent whether it feels stuck* — the
exact "headless that lies" failure mode this design exists to kill.

**Decision: the planner MUST emit, for every sub-issue, a concrete acceptance
test — or criteria crisp enough to be mechanically turned into one — as a
required output. Plan audit enforces this as a hard gate.** A sub-issue that
arrives with only vague prose is bounced back to the planner, or parked
`inconclusive`; it is **never authored**.

This is cheap: plan audit already inspects every unit, so the gate adds a check,
not a stage. And it makes "untestable" a **decompose-time verdict** — a unit
that cannot be pinned to a test is caught before a single line is written,
which is exactly consistent with the design's whole thesis of front-loading the
irreversible calls.

---

## 5. Dropped: `scope.maxLines` as an escalate gate

The current `scope.maxLines` knob (`orch.example.yml`) rejects an author commit
that exceeds a line count. As a *gate on plan output* this design deliberately
does **not** use it, because line count measures **size** as a proxy for
"single-purpose and independently reviewable" — and once the planner splits by
*logic*, that proxy is actively wrong. A clean 2000-line from-scratch docs PR is
one purpose and should sail; a 200-line diff smeared across three concerns
should not, and should be split. Line count cannot tell those two apart, so
gating on it would reject the good case and pass the bad one.

It survives, at most, as a **soft hint to the planner** ("this unit looks large,
consider splitting"), never as a hard gate on the plan. Note this is a statement
about the *planner's* output only; it does not change the existing
`scope.maxLines` author-commit gate, which is out of scope for this design.

---

## 6. Scope and decomposition

This is the design and tracking record. Implementation decomposes — fittingly,
via exactly the kind of DAG it describes — into four independently reviewable
deliverables, each landing on its own:

1. **The planner stage** — task/issue → DAG of sub-issues + edges, each unit
   carrying its required acceptance test.
2. **The plan-audit stage** — adversarial DAG review, with the acceptance-test
   hard gate from §4.
3. **The `park` terminal state + breakfast queue** — the new non-halting exit
   and the human-readable morning queue, kept separate from `escalate`.
4. **The convergent-failure detector** — diverse sequential retry with
   early-exit and the `convergent` / `inconclusive` park reasons.

Each is a separate deliverable so it can be reviewed and merged independently —
which is the same independence discipline the planner is being asked to enforce
on everything else.
