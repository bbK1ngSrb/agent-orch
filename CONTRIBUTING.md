# Contributing

## Picking up an idea

[PLANNED.md](PLANNED.md) (near-term, detailed) and [FUTURE.md](FUTURE.md)
(1mo/3mo/1yr horizon) list ideas that aren't scoped into an implementation
plan yet. Contributors are more than welcome to pick up anything on either
list — open an issue or PR referencing it.

## Adding an agent adapter
1. Create `src/adapters/<name>.js`:
   ```js
   import { makeCliAdapter } from "./cli-adapter.js";
   export function buildArgs(prompt, wd) { return [/* your CLI's args */]; }
   export default makeCliAdapter({ name: "<name>", bin: "<binary>", buildArgs });
   ```
2. Register it in `src/adapters/index.js` (add it to the `NATIVE` map).
3. Add a `buildArgs` unit test in `test/adapters.test.js`.

The adapter contract: `author(task, wd)` makes commits in the worktree;
`audit(branch, wd)` returns a `Verdict` (it ends its output with `AGREE`/`DISAGREE`).

## Tests
`npm test` (uses built-in `node:test`). Keep modules pure where possible and
inject side effects so they stay unit-testable.
