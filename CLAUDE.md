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

## One live session per checkout

Two interactive sessions sharing this working tree race on a single `HEAD`: a commit
can land on whichever branch the other session last checked out (see issue #14). Run
each concurrent session in its own `git worktree`. orch's per-cycle worktree isolation
does **not** cover manual/interactive sessions sharing the primary checkout.

<!-- orch:begin (managed by `orch init --link`; edits here are overwritten) -->
## orch
This repo uses agent-orch. See `.orch/ORCH.md` for usage; config in `.orch/orch.yml`.
@.orch/ORCH.md
<!-- orch:end -->
