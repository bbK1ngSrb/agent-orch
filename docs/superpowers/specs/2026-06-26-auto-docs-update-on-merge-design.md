# Auto docs-update on successful merge — design

Date: 2026-06-26
Repo: agent-orch (portable to printseek and future standalone repos)

## Problem

After a PR/branch merges, docs drift. We want documentation to be
auto-refreshed on **every successful merge**, across agent-orch and every other
standalone repo that uses the `orch` tool.

## Goals

- Trigger a docs-update task automatically on a successful merge.
- Cover both merge surfaces: local merges done by `orch` and GitHub PR merges.
- Never loop: a docs-only merge must not re-trigger another docs-update.
- Portable: the tool-side behavior applies to any repo running `orch`; the CI
  side is a copy-paste template for each standalone repo.
- Opt-in per repo (`docs.autoUpdate`), enabled in agent-orch now.

## Non-goals

- Deterministic doc generation. "Docs update" means running the existing
  agentic `orch task` cycle with a docs prompt — same as a manual run.
- Per-file or partial doc targeting. The agent decides what to touch.
- Capturing/streaming the spawned task's logs (fire-and-forget; see ceiling).

## Coverage model (the "Both" decision)

Two merge surfaces, hooked separately so they never double-fire:

| Surface | Merge mechanism | Trigger | GH event? |
|---|---|---|---|
| `orch task` / `orch review` | local `git merge` into local `main` | in-tool hook (cli.js) | no |
| `orch pr --merge`, GitHub UI merge | `gh pr merge` / GitHub | Action `orch-docs.yml` | yes |

The in-tool hook lives **only** on the engine local-merge path (`orch
task`/`review`), which produces no GitHub event. The Action fires **only** on
GitHub `pull_request closed (merged)`. The two sets of merges are disjoint, so a
single merge triggers exactly one docs-update.

## Loop guard

Before triggering, check whether the merged branch changed **docs-only** files
(every changed path matches a glob in `cfg.docs.paths`). If docs-only → skip.

The auto docs-update task, by construction, merges a docs-only branch. On its
merge the guard sees docs-only and skips — the loop is broken structurally, no
counters or markers needed. A mixed PR (code + docs) still triggers once.

Edge: empty changed-file list → treated as *not* docs-only is irrelevant (no
files means nothing to document); we define `isDocsOnly([]) === false` so an
empty/odd diff never silently suppresses a real update. Equally it would never
spawn anything useful, but false is the safe, predictable value.

## Components

### 1. Config — `src/config.js`

Add to `DEFAULTS`:

```js
docs: {
  autoUpdate: false, // opt-in per repo; flip true in .orch/orch.yml
  prompt: "update documentation to reflect the latest merged changes",
  paths: ["*.md", "docs/**", "**/*.md"], // docs-only globs = loop guard
},
```

Shallow-merge user override like `scope`/`github`:
`docs: { ...DEFAULTS.docs, ...(user.docs || {}) }`.

Validation (in `validate`):
- `typeof cfg.docs.autoUpdate === "boolean"`.
- `cfg.docs.prompt` is a non-empty string.
- `cfg.docs.paths` is an array of strings.

Portability: each repo's `.orch/orch.yml` sets `docs.autoUpdate: true` to turn
it on. agent-orch's own config is set to `true` (this change).

### 2. docs-only helper + changed files

`src/scope.js`: export the existing `globToRegExp`, and add:

```js
export function isDocsOnly(files, globs) {
  if (!files.length) return false;
  const res = globs.map(globToRegExp);
  return files.every((f) => res.some((re) => re.test(f)));
}
```

`src/git.js`: add a thin wrapper:

```js
export function changedFiles(repo, branch) {
  const out = gitTry(["diff", "--name-only", `main...${branch}`], repo);
  return out.ok ? out.out.split("\n").map((s) => s.trim()).filter(Boolean) : [];
}
```

(`main...branch` = changes on `branch` since the merge-base, matching how
`scope.count` already scopes a branch's diff.)

### 3. engine.js — stamp the result

After a successful local merge, compute and attach `docsOnly` to the merged
result so the caller can decide. Engine stays pure — it reports, it does not
spawn:

```js
const files = git.changedFiles(repo, branch);
const docsOnly = isDocsOnly(files, cfg.docs.paths);
return { status: "merged", reason: "agreed + green + merged", rounds: round, docsOnly };
```

The `no-merge` (PR-bridge) return path is unchanged — it does not merge, so it
carries no `docsOnly`.

### 4. cli.js — post-merge trigger (local surface)

After `runCycle` returns for `task`/`review`:

```js
if (res.status === "merged" && cfg.docs.autoUpdate && !res.docsOnly) {
  spawnDocsTask(cfg.docs.prompt);
}
```

`spawnDocsTask` spawns a detached `orch task <prompt>` and unrefs it, prints
`▶ post-merge: docs-update spawned`:

```js
let docsSeq = 0;
function spawnDocsTask(prompt, deps = { spawn }, orchDir) {
  // task mode derives the branch from the prompt slug, so a FIXED prompt would
  // collide on the 2nd run (git rejects an existing task branch) and fail
  // invisibly. Lead with a unique stamp -> unique slug/branch every run.
  const tagged = `auto-docs ${Date.now().toString(36)}${(docsSeq++).toString(36)} ${prompt}`;
  let stdio = "ignore";
  if (orchDir) { const fd = openSync(join(orchDir, "auto-docs.log"), "a"); stdio = ["ignore", fd, fd]; }
  deps.spawn(process.execPath, [process.argv[1], "task", tagged],
    { detached: true, stdio }).unref();
}
```

**Branch-collision guard (review finding):** a fixed prompt yields a fixed slug
→ fixed branch `pr/<author>/<slug>`. `git.js` rejects an existing branch and
merged branches are not deleted, so the 2nd post-merge docs-update would fail —
silently, under detached stdio. Fix: lead the prompt with a unique stamp
(`Date.now()` + an in-process counter so two merges in one ms still differ),
giving a unique slug/branch per run. Output is captured to `.orch/auto-docs.log`
(when `orchDir` is known) so a failed detached run leaves a trail.

ponytail ceiling: ms stamp + counter + append-only log; rotate the log if it
ever grows. Unique branches accumulate the same way every `orch task` branch
already does (the tool does not auto-delete merged task branches).

### 5. GitHub Action — `.github/workflows/orch-docs.yml`

Repo-agnostic template. Direct push to main (chosen):

```yaml
name: orch-docs
# Auto-refresh docs after a PR merges. Self-hosted [orch] runner (agent CLIs +
# keys live there). Skips docs-only merges to avoid a re-trigger loop.
on:
  pull_request:
    types: [closed]
permissions:
  contents: write
concurrency:
  group: orch-docs-${{ github.repository }}
  cancel-in-progress: false
jobs:
  docs:
    if: >
      github.event.pull_request.merged == true &&
      github.event.pull_request.head.repo.fork == false
    runs-on: [self-hosted, orch]
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0, ref: main }
      - name: skip docs-only merges
        id: guard
        env:
          BASE: ${{ github.event.pull_request.base.sha }}
          HEAD: ${{ github.event.pull_request.head.sha }}
        run: |
          files=$(git diff --name-only "$BASE" "$HEAD")
          if [ -z "$files" ]; then echo "skip=1" >> "$GITHUB_OUTPUT"; exit 0; fi
          if echo "$files" | grep -qvE '(\.md$|^docs/)'; then
            echo "skip=0" >> "$GITHUB_OUTPUT"
          else
            echo "skip=1" >> "$GITHUB_OUTPUT"   # docs-only -> skip
          fi
      - if: steps.guard.outputs.skip == '0'
        run: npm install -g .          # assumes the repo vendors orch
      - if: steps.guard.outputs.skip == '0'
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          orch task "update documentation to reflect the latest merged changes"
          git push origin HEAD:main
```

Notes:
- The bash docs-only check mirrors the tool's `cfg.docs.paths` defaults
  (`*.md`, `docs/`). Kept as a literal grep so the template is self-contained.
- ponytail ceiling: direct `git push origin HEAD:main`. If branch protection
  later requires PRs, switch this step to open a PR via `gh` (docs-only guard
  already prevents that PR from re-triggering).
- For printseek and future repos: copy this file. It needs `orch` on the
  runner's PATH; a repo that doesn't vendor orch installs it from an orch
  checkout (agent-orch is not published to npm).

### 6. agent-orch config change

Set `docs.autoUpdate: true` in `agent-orch/.orch/orch.yml` (create the `docs:`
block) so the feature is live in this repo. Other repos stay off until they
opt in.

## Tests (`node --test`)

- **config**: `docs` defaults present; validation rejects bad `autoUpdate` /
  empty `prompt` / non-array `paths`; user override shallow-merges.
- **scope.isDocsOnly**: docs-only list → true; mixed list → false; empty → false.
- **engine**: merged result includes `docsOnly` (mock `git.changedFiles` +
  `isDocsOnly`); both true and false cases.
- **cli.spawnDocsTask**: called once when `merged && autoUpdate && !docsOnly`;
  not called when `docsOnly`, when `autoUpdate` false, or when not merged
  (inject a mock `spawn`).
- **docs.test.js**: README documents the auto docs-update feature and the
  `orch-docs.yml` template.

## Files touched

- `src/config.js` — docs defaults + validation + merge
- `src/scope.js` — export `globToRegExp`, add `isDocsOnly`
- `src/git.js` — add `changedFiles`
- `src/engine.js` — stamp `docsOnly` on merged result
- `src/cli.js` — `spawnDocsTask` + post-merge trigger
- `.orch/orch.yml` — enable `docs.autoUpdate` for agent-orch
- `.github/workflows/orch-docs.yml` — new Action
- `README.md` — document feature + template + portability note
- tests across the above

## Portability summary

- Items 1–4 (config, scope, git, engine, cli) ship inside `orch`. Any standalone
  repo that runs `orch` gets the behavior by setting `docs.autoUpdate: true`.
- Item 5 (Action) is a documented copy-paste template for printseek and future
  repos.
