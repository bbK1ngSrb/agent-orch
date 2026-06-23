Task 8 audit, attempt 2

Reviewed:
- `docs/plan.md` Task 8 contract.
- Task 8 source files: `src/adapters/cli-adapter.js`, `src/adapters/claude.js`, `src/adapters/codex.js`, `src/adapters/index.js`.
- Task 8 tests: `test/adapters.test.js`.
- Recent Task 8 commits, including the attempt-2 F4 fix.

Findings:
- No actionable findings.
- The adapter registry exposes `claude` and `codex`, rejects unknown agent names, and the adapter `buildArgs` functions match the plan.
- `makeCliAdapter` renders the author/review prompts, runs author failures as hard errors, and makes audit fail safe: nonzero/crashed agent executions return `DISAGREE` without trusting partial output.
- The tests are real behavioral tests, including a nonzero agent that prints `AGREE` before exiting to prove the fail-safe override works.
- Scope is limited to the planned Task 8 adapter files and tests, plus the ready/audit docs.

Verification:
- `node --test` from repo root: PASS, 28/28 tests.

VERDICT: APPROVED
