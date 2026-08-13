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

## How a PR lands: merge commits only

Every PR is merged with `gh pr merge <n> --merge`. Squash and rebase merging
are disabled on the repo (`allow_squash_merge: false`,
`allow_rebase_merge: false`), so `--squash` fails outright rather than quietly
doing the wrong thing.

The reason is ancestry. A merge commit records both parents, so every commit of
the merged branch stays reachable from `main` — it becomes an *ancestor* of
`main`, which is exactly what git's merge detection tests. A squash flattens the
branch into one new commit: the content lands, the history does not. Rebase does
the same, because it rewrites commits into new SHAs. Without ancestry,
`git branch --merged main` stops listing branches that have in fact landed,
`git branch -d` refuses to delete them, and orch's own post-merge `pr/*` cleanup
leaves orphans behind.

The one-line check, which must hold after every landing of the standing
`orch/integration → main` PR:

```sh
git merge-base --is-ancestor origin/orch/integration origin/main
```

Note this is a policy of *this* repo, not of the tool: `github.mergeMethod` in
`orch.yml` still offers `squash`/`merge`/`rebase` for PRs orch merges in your
own repo (manual §5.1).

## Git hooks

`npm install` wires up the committed hooks in `githooks/` (via
`git config core.hooksPath githooks`). The `reference-transaction` hook
refuses to delete the protected branches `main` and `orch/integration`
locally — GitHub already protects them server-side, but plain git will
happily `branch -D` them in your clone. For an intentional delete, prefix
the command with `ALLOW_BRANCH_DELETE=1`.

## Tests
`npm test` (uses built-in `node:test`). Keep modules pure where possible and
inject side effects so they stay unit-testable.
