# Cross-Audit PR Orchestration — Design Spec

**Date:** 2026-06-23
**Status:** Approved (design), pending implementation plan
**Goal:** Claude and Codex author small PRs and headlessly audit each other's PRs on
push, on the `rdp` host, against the local bare repo. Auto-merge on agreement +
green tests; capped revise loop on disagreement; human decides on stalemate.

---

## 1. Constraints (from the deploy environment)

- **GitHub is a `--mirror` of the bare repo** → GitHub PRs get clobbered. PRs CANNOT
  live on GitHub. PRs live on the local bare repo only.
- **`origin` = `/mnt/nas-soul/nfs/stepa.local/repos/unilever.git`** (bare, on NAS).
  Deploy path `rdp → bare → --mirror → GitHub → Windows` stays untouched.
- **`deploy.sh` is THE gate** (pytest must pass). Any auto-merge runs it and respects
  its exit code.
- **Agents never push to `main`.** Only the orchestrator merges, only after the gate.
- Host `rdp` is shared/single-box → one agent runs at a time (global lock).
- Both CLIs present: `codex` (`~/.local/bin/codex`), `claude` (`~/.local/bin/claude`).
- Reuse the existing headless launch pattern in
  `~/rdp.local/scripts/claude-supervisor*.sh`.

## 2. PR model & naming

- A **PR = a branch** `pr/<author>/<topic>`, where `<author> ∈ {claude, codex}`.
  Pushing the branch to `origin` opens/updates the PR.
- **Reviewer = the opposite agent** of `<author>` (claude authors → codex audits,
  and vice-versa).
- Authoring is **human-initiated**: you start a feature session for one agent; that
  agent commits and pushes a `pr/<author>/<topic>` branch. The cross-audit, the
  revise loop, and the merge are the automated parts. (Autonomous task-picking is out
  of scope for this spec.)

## 3. PR scope cap (small-PR discipline)

Enforced at PR-open (every push to `pr/*`):

- **Hard gate (mechanical, hook-enforced):** total changed lines vs `main`
  (`added + deleted`, summed from `git diff --numstat main...<branch>`, excluding
  generated/lock files listed in `pr-scope.ignore`) **< 100**. Over → push is
  **rejected**, telegram pings "PR too large — split", orchestrator does NOT start.
- **Soft gate (judgment, reviewer-enforced):** the PR contains **≤ 3 logical
  changes**. The reviewer assesses this; more than 3 → verdict `DO NOT AGREE` with
  reason "split into smaller PRs". Not mechanically measurable, so it is a review
  criterion, not a hook check.

Rationale: line count is objective and cheap to gate in the hook; "logical changes"
needs reading the diff, which the reviewer already does.

## 4. Trigger

- Bare repo **`post-receive` hook**: `unilever.git/hooks/post-receive`.
- Fires **only** on `refs/heads/pr/*`. Ignores `main`, tags, `refs/notes/*`,
  `refs/reviews/*`, `refs/pr-state/*` → zero interference with deploy.
- Hook is thin and fast (push must return promptly):
  1. Parse `<old> <new> <ref>` from stdin; bail unless ref matches `refs/heads/pr/*`.
  2. **Kill switch:** if `.pr-pause` exists in the work tree root → no-op.
  3. **Loop guard:** if the new tip commit carries a `Review-Bot:` or `Revise-Bot:`
     trailer → no-op (the orchestrator, not the hook, drives the next step).
  4. **Scope hard gate:** compute changed lines vs `main`; if ≥ 100 → reject + ping.
  5. Acquire global lock (non-blocking `flock`); if busy, queue a one-shot retry.
  6. Launch `pr-orchestrator.sh <branch> <author> <reviewer>` **detached**
     (`setsid`/supervisor pattern), then return.

## 5. State machine (`pr-orchestrator.sh`)

```
push pr/<author>/<topic>
        │
        ▼
[1] checkout pr branch into throwaway worktree  work/.pr-wt/<branch>/
        │
        ▼
[2] reviewer audits (read-only on code) → verdict log
        │
   parse verdict (lib/verdict-parse.sh): AGREE | DO NOT AGREE
        │
        ├─ AGREE ──► run deploy.sh (pytest gate) in worktree
        │             ├─ exit 0 ──► git merge --ff-only <branch> into main
        │             │              ├─ ff ok ──► telegram ✅ merged + deployed
        │             │              └─ not ff ──► escalate "rebase needed", no merge
        │             └─ exit ≠0 ──► escalate ⚠ "AGREE but tests fail", no merge
        │
        └─ DO NOT AGREE ──► if Round < 3:
                              author agent revises in worktree (applies findings),
                              commits [Round N+1, Revise-Bot trailer], pushes pr branch
                              → orchestrator re-runs review (Round+1)
                            else (Round == 3, still blocked):
                              build decision brief (§7) → escalate to human, STOP
```

- **Verdict storage:** `docs/reviews/<branch>/round-N.md`, written to the out-of-band
  ref `refs/reviews/<branch>` (NOT the pr branch, NOT main) so it never re-triggers
  the hook and never pollutes the merge. Mirror a copy into the worktree log dir for
  convenience.
- **Round counter:** stored in `refs/pr-state/<branch>` (blob) and echoed in each bot
  commit trailer `Round: N`. Hard cap **3** revise rounds.

## 6. Auto-merge safety rails

- Merge requires **`AGREE` ∧ `deploy.sh` exit 0** — pytest catches a wrong reviewer.
- **`--ff-only`** merge; non-ff → escalate (rebase is the author's job, not the
  orchestrator's).
- Agents never write `main`. Orchestrator is the only merger.
- Every state transition → **telegram** ping (start, verdict, merge, escalate). You
  can interrupt at any point.
- **Kill switch:** `touch .pr-pause` in repo root → hook no-ops.
- Global `flock` → one agent at a time.

## 7. Stalemate → human decides (after 3 rounds)

On the 3rd `DO NOT AGREE`, the orchestrator builds a **decision brief** and escalates
(telegram + `docs/reviews/<branch>/DECISION.md`). The brief presents **both sides with
pros/cons** so you arbitrate:

- **Reviewer's case:** the standing objection(s), with pros/cons of enforcing them.
- **Author's case:** the last rebuttal / why the code stands, with pros/cons.
- **Diff summary** + links to each round's verdict.
- **Ask:** merge as-is / revise per reviewer / abandon — your call.

No auto-merge, no further rounds, until you respond.

## 8. Components (isolated, testable)

| Unit | Job | Interface |
|---|---|---|
| `hooks/post-receive` | ref filter, kill switch, loop guard, scope gate, lock, detach | stdin `<old> <new> <ref>` |
| `pr-orchestrator.sh` | state machine: review → merge / revise / escalate | args `<branch> <author> <reviewer>` |
| `run-reviewer.sh` | wrap `codex exec` / `claude -p` in worktree; emit verdict log | args `<agent> <branch> <round>` → stdout verdict, file log |
| `run-author-revise.sh` | wrap author agent to apply findings, commit (trailers), push | args `<agent> <branch> <round> <verdict-file>` |
| `lib/verdict-parse.sh` | extract `AGREE` / `DO NOT AGREE` + `RUN COMPLETE` sentinel | stdin log → exit code + echo verdict |
| `lib/pr-scope.sh` | changed-line count vs main (respect `pr-scope.ignore`) | args `<branch>` → echo count, exit nonzero if ≥100 |
| `review-prompt.md` | adversarial review prompt (F1–F7 style), branch-parameterized; states the ≤3-logical-change rule | template |

## 9. Headless agent invocation

- **codex reviewer:** `codex exec --cd <worktree> "$(render review-prompt.md)"`
  (non-interactive, sandboxed).
- **claude reviewer:** `claude -p "$(render review-prompt.md)"` in `<worktree>`,
  non-interactive.
- Reviewer is **read-only on code**; its only product is the verdict log. Author
  agents (revise step) run the same wrappers in write mode, commit with bot trailers,
  push.
- Verdict contract: reviewer must end with `AGREE` or `DO NOT AGREE` and print
  `RUN COMPLETE` only on full agreement (reuse the existing review-prompt sentinel).

## 10. Testing

- `lib/verdict-parse.sh` — unit: sample AGREE / DO-NOT-AGREE / malformed logs → right
  exit codes.
- `lib/pr-scope.sh` — unit: synthetic diffs at 99 / 100 / 101 lines, ignore-file
  honored.
- `pr-orchestrator.sh` — **dry-run** (`PR_DRYRUN=1`) stubs agent calls, `deploy.sh`,
  and merge; asserts the state machine takes the correct branch for each
  (verdict × round × deploy-result) combination, incl. the 3-round stalemate brief.
- `post-receive` — test it ignores `main` and bot-trailer pushes, fires on `pr/*`,
  rejects ≥100-line pushes.

## 11. Out of scope (YAGNI)

- Autonomous task-picking (humans initiate authoring).
- GitHub PR UI / Actions (mirror constraint).
- Parallel review (single global lock; one at a time).
- More than 2 agents.

## 12. Open items / defaults chosen

- Escalation channel = **telegram** (MCP already wired).
- Scope ignore list (`pr-scope.ignore`) seeded with lockfiles / generated assets;
  extend as needed.
- Worktree root `work/.pr-wt/` is gitignored and pruned after each run.
