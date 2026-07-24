# agent-orch — repo instructions

agent-orch authors a change, cross-audits it with a second agent, gates on tests,
and merges. Educational artifact — **do not use in production** (see LICENSE, README).
ESM, Node ≥18, single dep (`yaml`). Tests: `npm test` (`node --test`).

## Reporting findings — open an issue for every proven defect

When a bug, error, or security issue is **proven real** — reproduced, or verified
by reading the code/test output, not merely suspected — open a GitHub issue for it
**immediately**, before or alongside the fix:

```
gh issue create --title "<concise defect>" --body "<what/why/repro/severity>"
```

Include: what happens, why it matters, a minimal repro, and a severity. Fixing it
in the same session does not replace the issue — the issue is the durable record and
the closing PR references it (`Closes #N`). Do **not** open issues for speculative or
unverified hunches; prove it first.

## Tone for issue/PR comments — teaching, not just reporting

This repo is an **educational artifact** — explain like a professor talking to a
freshman, not like a terse bug tracker. When writing a GitHub issue, PR description,
or PR review comment:

- Explain the *why*, not just the *what*: what mechanism breaks, why it breaks that
  way, what concept the reader should walk away understanding.
- Define non-obvious terms in-line briefly (race condition, fast-forward merge,
  worktree isolation) rather than assuming the reader already knows them.
- Still be concrete: concise, findings, and severity still apply — teaching tone
  augments precision, it doesn't replace it with vagueness or padding.
- Applies to **new** comments going forward; do not rewrite existing open issues/PRs
  retroactively for this.

## Delegate discrete tasks to fresh subagents

Main session context grows fast toward 300k limit. For each new discrete task
(bug fix, feature, investigation) that doesn't need prior conversation nuance,
delegate to a fresh Agent call (not fork) instead of working inline — the
subagent's exploration/tool-noise stays out of main context, only its summary
returns. Reserve inline work for quick follow-ups tied to what's already in
context. `/clear` between unrelated task batches; `/compact` when context
grows but recent history still matters.

## One live session per checkout

Two interactive sessions sharing this working tree race on a single `HEAD`: a commit
can land on whichever branch the other session last checked out (see issue #14). Run
each concurrent session in its own `git worktree`. orch's per-cycle worktree isolation
does **not** cover manual/interactive sessions sharing the primary checkout.

## Route agent changes through orch

Agent-generated changes destined for `main` must start as a GitHub Issue and run
through an orch cycle (`orch issue <n>` or the poller's `@orch-bot` trigger).
Never hand-author a direct agent PR to `main` from an interactive session. In
this repo, interactive `orch`, `/orch`, and the poller all use the same ambient
`gh` identity—the repo owner—not `orch[bot]`. GitHub does not allow a PR author
to approve its own PR, so an owner-authored direct PR can satisfy `main`'s
required-review rule only by bypassing it.

An agreed, green, security-clean cycle lands on `orch/integration`, and orch
opens or updates the single persistent `orch/integration → main` PR. Merge that
standing PR as the deliberate human checkpoint. Resolve escalations (security
floor, conflict, or overlap) and re-run the change through orch, or handle them
at the persistent PR; never force a per-change agent PR. `--merge` applies only
to `orch pr`, so it does not make an Issue cycle merge to `main`.

This rule applies to agent-generated output. A trivial human/owner chore or
documentation change may still use a direct owner PR.

<!-- orch:begin (managed by `orch init --link`; edits here are overwritten) -->
## orch
This repo uses agent-orch. See `.orch/ORCH.md` for usage; config in `.orch/orch.yml`.
@.orch/ORCH.md
<!-- orch:end -->
