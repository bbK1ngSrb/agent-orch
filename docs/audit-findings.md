# agent-orch Folder Audit Findings

Date: 2026-06-23
Scope: `/home/bbk1ng/rdp.local/ai/orchestration`

Audited files:
- `2026-06-23-agent-orch-design.md`
- `2026-06-23-agent-orch-plan.md`
- Deleted tracked files from `HEAD` for context:
  - `2026-06-23-cross-audit-pr-orchestration-design.md`
  - `2026-06-23-cross-audit-pr-orchestration.md`

## Summary

The current folder now contains the repo-agnostic `agent-orch` design and implementation plan. The direction is coherent, but the implementation plan has several issues that would either violate the design contract or make the generated CLI unsafe to run as documented.

Highest priority fixes:
1. Split `task` and `review` engine paths so `orch review <branch>` is truly audit-only.
2. Wire `ORCH_DRYRUN=1` / `--dry` before any implementation work relies on it.
3. Add the promised lock and pause-file safety rails, or remove those promises from the design.

## Findings

### F1 - Critical - `orch review <branch>` is not audit-only

Evidence:
- Design says `review <branch>` is "audit-only on an existing branch (no author step)": `2026-06-23-agent-orch-design.md:39-45`.
- Design repeats that reviewers audit and only produce a verdict: `2026-06-23-agent-orch-design.md:67-71`.
- CLI sets `task = null` for `review`, but still calls `runCycle(...)`: `2026-06-23-agent-orch-plan.md:1336-1348`.
- `runCycle` always runs `await author.author(task, worktree)` before any audit: `2026-06-23-agent-orch-plan.md:1101-1104`.

Impact:
- Running `orch review <branch>` would invoke an author agent with `task = null` and may mutate/commit to a branch that should only be audited.
- This breaks the public CLI contract and could corrupt a human-created branch.

Recommended fix:
- Add an explicit engine mode, for example `mode: "task" | "review"`.
- In review mode, skip the initial author step and skip author revisions unless the user explicitly asks for auto-revise.
- Add a test asserting `orch review <branch>` performs zero `author.author(...)` calls.

### F2 - High - Dry-run is promised but not wired

Evidence:
- Architecture promises the engine can run fully stubbed under `ORCH_DRYRUN=1`: `2026-06-23-agent-orch-plan.md:7`.
- CLI parses `--dry`: `2026-06-23-agent-orch-plan.md:1276-1282`.
- CLI dependency factory always returns real adapters, git, gate, scope, and notify: `2026-06-23-agent-orch-plan.md:1304-1306`.
- `main(...)` never checks `flags.dry` or `process.env.ORCH_DRYRUN`: `2026-06-23-agent-orch-plan.md:1308-1356`.

Impact:
- Users may expect a safe dry run, but the CLI would still create worktrees, invoke real agent CLIs, run tests, and merge through real git helpers.
- Tests only prove injected stubs work when manually supplied, not that the production CLI selects them.

Recommended fix:
- Implement a production dependency factory that checks `flags.dry || process.env.ORCH_DRYRUN === "1"`.
- Stub agent, gate, and merge behavior in dry-run mode.
- Add a CLI-level test proving `--dry` does not call real adapters or git helpers.

### F3 - High - Safety rails are promised, then deliberately omitted

Evidence:
- Design promises a global lock and pause-file kill switch: `2026-06-23-agent-orch-design.md:186-193`.
- Plan self-review says `.orch/lock` is not a task and v1 ships without it: `2026-06-23-agent-orch-plan.md:1514-1515`.
- Plan self-review says `.orch/pause` is deferred: `2026-06-23-agent-orch-plan.md:1516`.

Impact:
- The design advertises one-cycle-at-a-time safety and an operator kill switch, but the planned implementation lacks both.
- Concurrent `orch task` runs can collide in `.orch/wt`, branch names, `.orch/reviews`, and merge state.

Recommended fix:
- Add a task before packaging that implements `.orch/lock` with lock-file creation/removal or a portable lock directory.
- Check `.orch/pause` before authoring, before review, before gate, and before merge.
- If these are intentionally out of scope, remove them from the design and README so users do not rely on them.

### F4 - High - Reviewer failures are not fail-safe `DISAGREE`

Evidence:
- Design says malformed or missing verdicts are treated as `DISAGREE`: `2026-06-23-agent-orch-design.md:179-184`.
- Adapter `run(...)` uses `execFileSync(...)`, which throws on nonzero exit: `2026-06-23-agent-orch-plan.md:785-790`.
- `audit(...)` does not catch that throw before parsing: `2026-06-23-agent-orch-plan.md:800-803`.

Impact:
- If an agent crashes, times out, exits nonzero, or writes a malformed partial answer, the run can throw instead of writing a round log and escalating as a controlled disagreement.
- This weakens the "never auto-merge on ambiguous output" safety story and can leave cleanup to the `finally` path without a useful decision artifact.

Recommended fix:
- Catch adapter execution errors in `audit(...)`.
- Parse captured stdout/stderr when available, and return `{ decision: "DISAGREE", reason: "unparseable verdict", raw }` when no valid verdict exists.
- Add tests for nonzero agent exit, empty output, and stderr-only output.

### F5 - Medium - `addWorktree` silently creates missing branches

Evidence:
- `addWorktree` creates `branch` from `base` when `rev-parse --verify branch` fails: `2026-06-23-agent-orch-plan.md:690-696`.
- `review <branch>` accepts a branch name and passes it into the same `runCycle` path: `2026-06-23-agent-orch-plan.md:1336-1348`.

Impact:
- A typo in `orch review pr/claude/foo` could create a new branch from `main` and audit/merge the wrong thing instead of rejecting the command.
- This is especially risky because `review` is described as operating on an existing branch.

Recommended fix:
- Split worktree helpers into `createTaskBranch(...)` and `attachExistingBranch(...)`.
- For review mode, require the branch to exist locally or resolve it explicitly from a configured remote; otherwise fail before invoking agents.

### F6 - Medium - Scope parser snippet contains literal NUL sentinels

Evidence:
- The planned `globToRegExp` snippet contains literal NUL placeholder characters in string literals: `2026-06-23-agent-orch-plan.md:332-338`.

Impact:
- Copying this snippet into source may produce hard-to-see control characters in `scope.js`.
- Even if Node accepts it, it makes review, diffing, and editor behavior worse than using a visible sentinel string.

Recommended fix:
- Replace the literal control character with a visible sentinel, for example:

```js
const DOUBLE_STAR = "__ORCH_DOUBLE_STAR__";
```

### F7 - Repository hygiene - Two tracked files are deleted in the worktree

Evidence:
- `git status --short` reports:
  - `D 2026-06-23-cross-audit-pr-orchestration-design.md`
  - `D 2026-06-23-cross-audit-pr-orchestration.md`

Impact:
- This may be intentional replacement by the repo-agnostic `agent-orch` docs, but the deletion is currently unstaged/uncommitted state.
- If intentional, commit the deletion with the new docs. If not, restore them before further edits.

## Suggested Next Order

1. Fix F1 and F2 before implementation begins; they affect core CLI semantics.
2. Decide whether F3 safety rails are v1 requirements. If yes, add explicit tasks and tests.
3. Harden adapter error handling for F4.
4. Split branch creation vs branch review behavior for F5.
5. Clean the NUL sentinel and commit or restore the deleted legacy docs.
