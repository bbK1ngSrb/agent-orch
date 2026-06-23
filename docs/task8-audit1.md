Task 8 audit, attempt 1.

Checked plan section `Task 8: adapters/ - pluggable agent CLIs`, commit `6def766` (`feat(agent-orch): pluggable Claude + Codex adapters`), and the Task 8 files:

- `src/adapters/cli-adapter.js`
- `src/adapters/claude.js`
- `src/adapters/codex.js`
- `src/adapters/index.js`
- `test/adapters.test.js`

`node --test` from the repository root passes: 27 tests passed, 0 failed. This includes the new adapter tests and all earlier task tests.

1. `src/adapters/cli-adapter.js` does not fully implement the F4 fail-safe required by the plan. The plan says a crashed/nonzero audit agent must return `DISAGREE` instead of accepting the agent result. `runCapture()` records `ok: false`, but `audit()` ignores that flag and always calls `parseVerdict(out)`. A failing command that prints `AGREE` before `exit 3` is therefore accepted as `AGREE`, which violates the fail-safe intent and is not covered by the current test. Repro:

   ```bash
   node --input-type=module -e 'import { tmpdir } from "node:os"; import { makeCliAdapter } from "./src/adapters/cli-adapter.js"; const adapter = makeCliAdapter({ name: "boom", bin: "sh", buildArgs: () => ["-c", "echo AGREE; exit 3"] }); const v = await adapter.audit("pr/x/y", tmpdir()); console.log(JSON.stringify(v));'
   ```

   Actual: `{"decision":"AGREE","reason":"(no reason given)","raw":"AGREE\n"}`. Fix by having `audit()` return a fail-safe `DISAGREE` whenever `runCapture()` reports `ok: false`, and add a test where the fake agent prints `AGREE` then exits nonzero.

VERDICT: CHANGES
