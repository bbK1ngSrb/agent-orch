# The orch Manual

A complete reference for `agent-orch` (`orch`): what every command and option
does, why it exists, when to reach for it, and what happens under the hood.
Written for someone who has never run `orch` before but knows git.

If you only want the terse version, `orch --help` and `README.md` cover the
same ground more briefly. This document exists because the biggest source of
confusion is not any single flag — it's *which merge model applies when*, and
that requires understanding a few concepts before the flags make sense.

`orch` itself is cross-platform (Linux, macOS, Windows — CI runs the full
suite on both `ubuntu-latest` and `windows-latest`); the git/process
mechanics described below (worktrees, branches, `merge.lock`) work
identically on all three, so nothing in this manual is Linux/macOS-specific.

---

## Part 1 — The mental model

### 1.1 What a "cycle" is

Every `orch task`, `orch issue`, `orch review`, or `orch agent build` run is a
**cycle**:

1. **Author** — one agent writes a change on its own branch, in its own git
   worktree (isolated from your working directory; you keep working while it
   runs). `orch review` skips this step entirely — it starts from a branch
   you (or something else) already wrote — but everything from here on is the
   same machinery.
2. **Cross-audit** — a *different* agent reviews the author's diff and returns
   `AGREE` or `DISAGREE`. If `DISAGREE`, the author revises and the review
   repeats, up to `reviseCap` rounds (default 3) — except under `orch review`,
   which has no author to revise and so escalates immediately on the first
   `DISAGREE` instead of looping.
3. **Test-gate** — the repo's test command runs against the change. No green
   tests, no merge, no exceptions.
4. **Security scan** — a deterministic pattern scan (`scanDiff` in
   `src/security-review.js`) runs over the *added* lines of the final diff,
   flagging reads of secrets/env (`process.env`, `.ssh/`, `PRIVATE KEY`, ...),
   opening a network connection, spawning a subprocess, or touching
   branch-protection/CODEOWNERS/workflow files. Unlike the LLM reviewers, this
   scan can't be reasoned or prompted out of a finding — any hit escalates,
   even after `AGREE` and green tests. If the final diff itself can't be read,
   orch fails closed and escalates rather than assuming an unseen patch is
   safe. Files matching a `security.ignore` glob are exempt (default: none) —
   an escape hatch for committed build artifacts like minified bundles, where
   pattern-matching on generated text false-positives (a `RegExp#exec()` call
   in minified code reads exactly like a subprocess `exec()`). Exempting a
   path skips *every* security rule for it, so list only generated files,
   never authored code. This runs on every cycle that reaches AGREE + green, including the
   `orch pr`/PR-bridge audit-only path (§2.7) where nothing else merges.
5. **Merge** — *only if* every reviewer said `AGREE`, tests passed, **and**
   the security scan found nothing — the branch is merged. How and where it
   merges is the part this manual spends the most time on, because there are
   three distinct answers. `orch review <branch>` **does merge** on this same
   AGREE-and-green outcome, exactly like `orch task`; the only thing it skips
   is the authoring step. Only `orch pr` stops short of a local merge — it
   reports its verdict and leaves GitHub to own the actual merge (§2.7).

If any stage fails — reviewer disagreement past the cap, red tests, a risky
security-scan finding, a merge conflict — the cycle does not merge. It
**escalates**: it either opens a PR for a human to look at, or writes a local
decision file and keeps the branch around. Nothing is silently discarded.

### 1.2 Two branches you need to know about

- **`main`** — your repo's real trunk. `orch` never runs `git checkout main`,
  never commits to it, never resets it. The *only* way `main` moves is: GitHub
  merges a PR into it, then you (or orch) `git fetch && git merge --ff-only
  origin/main`. Think of local `main` as a mirror, not a workspace.
- **`orch/integration`** — a permanent branch orch maintains for you, checked
  out in a dedicated worktree at `.orch/integration`. This is where *local*
  merges land immediately, without needing GitHub at all. It's real, usable,
  testable code the moment a cycle passes — it just hasn't crossed the
  GitHub bridge into `main` yet.

This split is why orch cycles can merge instantly on your machine even with
zero network access, while `main` still ends up looking exactly like what
GitHub approved.

### 1.3 The "two-speed" merge path (the default you'll use 95% of the time)

This is what happens on a plain `orch task "..."` with no `merge:` override:

```
author branch ──(AGREE + green tests)──▶ orch/integration ──▶ [push] ──▶ persistent PR ──▶ main
                     ▲ fast, local, instant                    ▲ GitHub-mediated, has a natural lag
```

1. The cycle merges into `orch/integration` locally, under a short-lived
   `merge.lock` (so two concurrent cycles don't race each other). A
   post-merge re-test runs against the *integrated* tree, not just the
   branch — catching semantic conflicts a plain git merge wouldn't.
2. On success — and only if you opted in with `release.autoBump: true`
   (default off, see §4.1) — `orch` bumps the merge counter (see §4.1 for the
   `x.y.zcc` scheme) and prepends a `CHANGELOG.md` entry, committed as
   `chore(release): vX.Y.Z`.
3. `orch` pushes `orch/integration` to the remote and opens **or updates**
   one single, persistent PR from `orch/integration → main`. It does not open
   a new PR per cycle — successive cycles pile onto the same PR until it's
   merged. Keeping that PR *fresh* is automatic: whenever another PR lands on
   `main`, this one goes stale (`mergeStateStatus: BEHIND`) — clean, but
   un-mergeable until it absorbs the new commits. Each cycle updates it from
   `main` for you (the "Update branch" button, no conflict to resolve), so a
   headless run never freezes on a stale-but-clean PR. A *conflicting* PR is
   left to the conflict resolver, not blindly updated.
4. If `github.autoMergePr: true`, that PR auto-merges once its own CI checks
   pass. Otherwise a human merges it on GitHub whenever they're ready.
5. Local `main` only advances afterward, by fetching and fast-forwarding.

**Why this design, and not "just merge to main directly"?** Because it lets
you run cycles — including several in parallel — with zero GitHub round-trips
for the fast, local part, while still giving you (or your branch-protection
rules) a single human checkpoint before anything reaches `main`. You get
immediate local usability *and* a deliberate one-PR lag before it's public.

> **Professor's note.** A lot of first-time confusion comes from expecting
> `orch task` to merge straight to `main`. It deliberately doesn't. If you
> want that, you have two options, covered next: turn on
> `github.autoMergePr`, or switch to `merge: pr` entirely (Part 3).

---

## Part 2 — Commands, in the order you'll actually reach for them

### 2.1 `orch init [--link]`

Scaffolds `.orch/orch.yml` and `.orch/ORCH.md`, then prints a detection
summary of which agent CLIs are actually usable on this machine:

```
$ orch init
orch: detected: claude, codex — not found: copilot (CLI not found: PATH + fallback dirs)
```

`--link` additionally appends an idempotent pointer to `.orch/ORCH.md` inside
your repo's `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` (creating one if none
exists), so whichever coding agent you use interactively already knows how to
drive `orch` in this repo.

**When to use it:** once, the first time you set up `orch` in a repo. Safe to
re-run — it won't clobber an existing `.orch/orch.yml`.

### 2.2 `orch config`

An interactive, one-field-at-a-time wizard for creating or editing
`.orch/orch.yml`. It walks every key in the config schema, showing the
current value (or default) and an explanation before you change it.

```bash
orch config
orch config --config-file custom.yml   # write somewhere other than .orch/orch.yml
```

Unlike hand-editing YAML, the wizard **normalizes** what it writes: it runs
the same business-rule validation the loader applies at run time (e.g.
rejecting a `main.conflictResolution` whose only configured resolver is also
the sole reviewer), and it canonicalizes the deprecated
`main.autoResolveConflicts` boolean into `main.conflictResolution` before
saving, so the file it writes never round-trips both the old alias and the
new field in a way that could silently disagree with itself.

**When to use it:** setting up a repo's config for the first time beyond the
bare `orch init` scaffold, or changing a field you're not confident editing
by hand (especially the `main.*` conflict-resolution keys, where the wizard's
validation catches a broken combination before it's saved instead of after
the next run fails to load it).

### 2.3 `orch task "<change>"`

The everyday command. Runs one full cycle — author, cross-audit, test-gate,
merge — described from a plain-English instruction.

```bash
orch task "fix the flaky login test"
```

**Role overrides**, so you're not at the mercy of the rotation pool:

```bash
orch task "add input validation" --author "claude" --reviewer "codex"
orch task "migrate auth module"  --authors claude,codex --reviewers claude,codex
orch task "add input validation" --reviewer "codex"   # reviewer-only: rotate the author, pin the reviewer
```

- `--author` / `--reviewer` — one spec each, singular. Set both to pin both
  roles, or set only `--reviewer` to force the reviewer while the author
  still rotates from the `agents:` pool — the one asymmetric case `task`,
  `issue`, and `review` all allow. Setting only `--author` without a
  `--reviewer` is rejected the same as before; author-only isn't meaningful
  the same way, since the rotation pool already picks *someone* to review.
- `--authors` / `--reviewers` — comma lists; each author writes its **own**
  branch, and every reviewer audits every branch it didn't write. Use this
  when you want several independent attempts at the same change and will
  pick (or let the cycle pick) the best one.

A **role spec** is `"<agent> [model] [effort]"` — agent is required, model
and effort are optional:

```bash
--author "claude claude-opus-4-8 high"
--reviewer "codex"
```

Valid effort values: `minimal`, `low`, `medium`, `high`, `xhigh`, `max`
(what a given agent CLI actually honors depends on the agent — e.g. codex
takes effort via a `-c` config override rather than a flag).

**When to use `orch task`:** any well-scoped, describable change — bug fix,
small feature, refactor — that you're happy to hand off in one shot. This is
the command you'll run the most.

**`--dry`:** plan the cycle without touching git, agents, or tests. Use it to
sanity-check role assignment or a work order before committing real API
spend.

**A note on `gh` authentication.** Even the default `no-ff` path (§1.3) ends
in a `gh` call — `openIntegrationPr` opens or updates the persistent
integration→main PR after *every* successful merge, not just `merge: pr`
runs. So if your repo has a git remote configured, `orch task`/`orch issue`
check `gh auth status` up front, the same fail-fast check `orch pr` always
did (§2.7) — you get one clear "run `gh auth login`" error before any agent
work happens, instead of a cycle that authors, reviews, tests, and merges
successfully, only to fail obscurely at the very last step. A repo with no
remote configured at all skips this check entirely, since there's no PR
bridge to open.

### 2.4 `orch task --file <work-order.json>`

Same cycle, but the instruction comes from a structured, untrusted JSON file
instead of a free-text string — useful when you're generating work orders
programmatically (e.g. from a bug tracker) and don't want free text executed
as instructions:

```json
{
  "title": "fix the flaky login test",
  "problem": "login test fails ~1 in 5 runs under load",
  "repro_steps": ["run npm test 5x"],
  "suspected_paths": ["src/auth.js"],
  "acceptance_criteria": ["test passes 20x in a row"]
}
```

`title` and `problem` are required; the array fields may be empty. The free
text is fenced before being handed to an agent — it is never interpreted as
instructions to orch itself.

**When to use it:** scripted or bulk task generation, or whenever the source
of the request isn't a human typing directly into your terminal.

### 2.5 `orch issue <n>`

Fetches GitHub issue `#n` (title + body), treats it as a work order, runs the
full cycle, and on a successful merge stamps `Closes #n` — so the issue
auto-closes the moment `main` actually reaches that commit (i.e., once the
persistent integration PR merges and GitHub processes the closing keyword).

```bash
orch issue 42
orch issue 42 --reviewer "codex"   # reviewer-only override, same as §2.3's task example
```

If the cycle escalates instead of merging (disagreement past the cap, or a
PR-fallback trigger), `orch` posts a comment on the *source issue* itself —
verdict, branch, reason, round count — because a headless run has no one
watching stdout. This is the only trace besides the local
`.orch/reviews/<branch>/DECISION.md`.

**When to use it:** you already track work as GitHub issues and want orch to
consume them directly rather than re-typing the description as a `task`
string. Needs `gh` authenticated.

### 2.6 `orch review <branch>`

No authoring — but it **does merge**. Points one or more reviewer agents at
an existing branch and runs the exact same audit → test-gate → security-scan
→ merge machinery as `orch task` (§1.1), just starting from a branch you (or
something else) already wrote instead of authoring one. If every reviewer
says `AGREE` and tests pass and the security scan is clean, the branch
merges into `orch/integration` (or opens a PR, under `merge: pr`) the same
way a `task` cycle's result would. A `DISAGREE` escalates immediately —
there's no author to revise, so the retry loop that `task` gets doesn't apply
here; one round decides it.

```bash
orch review pr/claude/some-branch
orch review my-feature-branch --reviewer "codex, claude high"
```

**When to use it:** you (a human) wrote a branch yourself, or an agent wrote
one outside of orch, and you want orch's cross-audit discipline — including
its merge decision — applied to it without re-authoring anything. If you want
a verdict *without* any possibility of a local merge, use `orch pr` (§2.7)
against a GitHub PR instead, which is the audit-only path that never touches
`orch/integration`.

### 2.7 `orch pr <n> [--merge]`

The GitHub PR bridge. Fetches PR `#n`'s head, runs an audit-only cycle
against it (local `main` is never touched — GitHub owns the actual merge),
and posts the verdict as a PR comment.

```bash
orch pr 42            # review only, post a comment
orch pr 42 --merge     # ...and merge via `gh pr merge` if agents approve + tests pass
```

**When to use it:** reviewing a PR that came from *outside* your orch
workflow entirely — a human contributor, a different tool, a fork — and you
want orch's agents to weigh in the same way they would on an internal cycle,
with the option to let orch actually merge it once approved.

Needs `gh` authenticated (`orch` checks this up front and fails fast rather
than partway through a cycle — see §2.3's note on why `orch task`/`orch
issue` check this too).

**The security scan (§1.1) still applies, even though nothing merges here.**
`orch pr` skips the actual merge — GitHub owns that — but not the deterministic
scan: a risky diff escalates instead of reporting `approved`, regardless of
what the LLM reviewers concluded.

**Merge verification, not just a trusted exit code.** After `gh pr merge`
returns success, `orch` doesn't take that at face value: it re-fetches
`origin/main` and confirms the merge commit `gh` actually reports is
present as an ancestor before it prints `merged`. This matters because a
squash or rebase merge mints a brand-new commit SHA that has nothing to do
with the PR branch's own commits — checking the *old* branch head would
prove nothing about whether the new squashed/rebased commit really landed.
If the check fails (a race with GitHub's own propagation, or a merge that
silently didn't take), `orch` refuses to report success and raises an error
instead — the same "don't claim a merge that didn't happen" discipline
described under Merge honesty in the README.

### 2.8 `orch agent build <name> [--pr]`

Scaffolds a missing adapter (`src/adapters/<name>.js`) through orch's *own*
author → audit → test pipeline, in its own isolated worktree/branch.

```bash
orch agent build mynewagent          # lands on a local branch only
orch agent build mynewagent --pr     # opens a PR instead
```

**When to use it:** adding support for a new CLI coding agent that isn't
already in the built-in set (`claude`, `codex`, `copilot`, `gemini`, `agy`,
`grok`, `kimi`, plus the local-llm models).

### 2.9 `orch continue <sid>`

Resumes an interrupted or stalled cycle from its checkpoint (see §4.3 on
crash recovery). You'll be told the `sid` to use when a cycle dies mid-way;
you don't normally invent one yourself.

If the checkpoint's branch no longer exists **locally**, `orch continue`
first checks whether it survives on the remote. If it only lives as
`origin/<branch>` (e.g. the local branch was pruned but the work was pushed),
you get an error telling you to check it out locally before continuing —
orch won't silently re-fetch it. If the branch is gone everywhere, the
checkpoint points at work that no longer exists, so orch clears the stale
resume state and exits cleanly rather than failing on every subsequent
`continue` for that dead `sid`.

### 2.10 `orch dashboard [--json] [--limit N] [--check-history] [--once|--plain] [--refresh-ms N]`

Read-only. Shows live cycle status/stage, a streaming log tail, run history,
and success-rate metrics. It never mutates orch state — that holds in every
mode below.

**Live TUI by default, in a real terminal.** When both stdout and stdin are a
genuine interactive TTY and you didn't pass `--json`/`--once`/`--plain`,
`orch dashboard` opens a full-screen live TUI that polls and redraws every
`--refresh-ms` milliseconds (default `1000`):

```bash
orch dashboard                    # live TUI in an interactive terminal
orch dashboard --refresh-ms 2000  # poll every 2s instead of the 1s default
```

**Static one-shot, everywhere else.** Any of these forces the plain, single
render instead — the same byte-identical text output this command has always
had, so scripts, logs, and CI output stay diffable: `--json`, `--once`,
`--plain`, a piped/redirected stream, or simply not having a TTY at all (cron,
CI, a non-interactive shell):

```bash
orch dashboard --json --limit 5
orch dashboard --check-history
orch dashboard --once        # force the static render even in a real terminal
```

`--check-history` only changes what this command *displays* (in either mode).
For each red history row it asks git whether the row's branch still exists,
and any row whose branch is gone is shown as `resolved` — so a long-since-
merged cycle no longer reads as a lingering failure. This reconciliation is
recomputed from git on every run; the on-disk history (`runs.jsonl`) is left untouched.

**When to use it:** checking on a long-running or concurrent set of cycles
without interrupting them. Reach for `--once`/`--plain` specifically when you
want the old plain-text summary from inside an interactive terminal — piping
or redirecting the live-TUI invocation gets you the static render
automatically, without needing the flag.

### 2.11 `orch agent add <name>`

Appends an already-known agent to the `agents:` rotation pool in
`.orch/orch.yml`, adding it as a new block-sequence item (`- name`) after the
last existing entry. A legacy inline flow array (`agents: [claude, codex]`)
still parses and still works — YAML treats both forms the same — but any repo
scaffolded since the block-sequence rewrite gets the multi-line form; `add`
doesn't rewrite an existing inline array into block style, it just appends in
whichever form is already there. For an agent orch doesn't know at all, use
`orch agent build <name>` (§2.8) instead — `add` registers, `build` creates.

### 2.12 `orch completion [bash]` / `orch completion install`

Prints (or installs to `~/.orch/completion.bash`) the bash tab-completion
script. `npm install -g` already installs it via a postinstall hook; these
exist for manual setups:

```bash
orch completion install
source <(orch completion bash)
```

### 2.13 Flags that apply across commands

- **`--dry`** — plan a `task`/`review` cycle without shelling out to agents,
  touching git, or running tests. Never deletes worktrees or branches.
- **`--cheap`** — force `cheap.role` from `orch.yml` (e.g. a local model or
  the cheapest CLI agent) as both author and reviewer for this one
  `task`/`issue` run. See §5.1 `cheap` for the automatic path-based routing
  that works without the flag.
- **`--config-file <path.yml>`** — layer a custom YAML file on top of
  `.orch/orch.yml` for this run only. Useful for a one-off role/merge-mode
  experiment without editing the repo's config.
- **`--no-tidy`** — skip the post-merge tidy (see §4.5) and leave every
  branch and checkout exactly as the cycle left them.
- **`--no-banner`** — suppress the startup banner (for scripts and logs).

---

## Part 3 — The merge models, in detail (the part people actually ask about)

There are **three** merge behaviors, controlled by `merge:` in
`.orch/orch.yml`. This is the single most consequential config key in the
whole system, because it decides whether your changes ever touch `main`
without a human clicking "merge" on GitHub.

```yaml
merge: no-ff     # default
# merge: ff-only
# merge: pr
```

### 3.1 `merge: no-ff` (the default)

Merges into `orch/integration` with a merge commit (`--no-ff`), even when a
fast-forward would have been possible. This is what enables **concurrent
disjoint cycles**: two `orch task` runs targeting unrelated files can both
land on `orch/integration` without either being forced to rebase onto the
other first — each gets its own merge commit, and `orch/integration`'s history
shows both.

```bash
orch task "migrate auth module"   --authors claude --reviewers codex &
orch task "add rate-limit header" --authors codex  --reviewers claude &
```

Both cycles use the two-speed path from §1.3: fast local merge into
`orch/integration`, then push + persistent PR to `main`.

**When to use it:** the default choice, and correct for almost everyone. Use
it whenever you want fast local iteration with a single, deliberate PR
checkpoint before `main` — including when you're running several cycles at
once.

### 3.2 `merge: ff-only`

Same target (`orch/integration`), but requires a fast-forward — no merge
commit. If a concurrent peer has already advanced `orch/integration` since
this cycle's branch point, the fast-forward isn't possible, and the cycle
**falls back to a PR** instead (see §3.4, PR-fallback) rather than force- or
merge-committing around the conflict.

**When to use it:** you want a strictly linear `orch/integration` history
with no merge commits, and you're comfortable with concurrent cycles
sometimes demoting to a PR instead of always landing locally. Rare in
practice — most repos are fine with merge commits on an internal integration
branch nobody reads by hand.

### 3.3 `merge: pr` — per-cycle PR mode

This is the one to reach for when the complaint is *"I want every orch cycle
to become its own reviewable PR against `main`, not silently disappear into
an integration branch."*

With `merge: pr` set, an agreed + green cycle **skips `orch/integration` and
the local merge.lock entirely**. Instead it pushes its own cycle branch and
opens **its own PR straight to `main`** — one PR per cycle, not one shared
persistent PR.

```yaml
merge: pr
github:
  autoMergePr: true   # optional: let GitHub auto-merge once that PR's own checks pass
```

```bash
orch task "add rate-limit header"   # → opens (or updates) its own PR to main
```

This needs a git remote and the `gh` CLI. Without them, the cycle escalates
locally the same way ordinary PR-fallback does (§3.4) — it does not silently
merge somewhere else.

If `github.autoMergePr: true` and enabling auto-merge fails (e.g. branch
protection isn't set up for it), the PR itself still stands — only the
auto-merge step is skipped, never the PR.

**Consequence you should know:** `merge: pr` bypasses the version-bump-on-merge
and CHANGELOG behavior described in §4.1 entirely — those only apply to the
local integration path (and even there only with `release.autoBump: true`). A
repo on `merge: pr` gets no automatic version bump from orch; that's on you (or
your CI) to handle at the PR-merge stage.

**When to use it:**
- Your branch protection rules require PR review on every change, with no
  exceptions, and you don't want an integration-branch detour at all.
- You want a 1:1 mapping between orch cycles and GitHub PRs for audit/history
  reasons — every change orch makes should show up as its own reviewable
  artifact on GitHub, not folded into a shared branch.
- You don't want the two-speed lag from §1.3 (fast local landing, slower
  GitHub landing) — you'd rather every cycle wait on the same PR gate,
  uniformly.

**When *not* to use it:** if you want cycles to be immediately usable locally
without any GitHub round-trip (e.g. iterating fast with no network, or
running many small concurrent cycles that don't each need their own
formal review), stick with the default `no-ff` two-speed path instead.

### 3.4 PR-fallback (this can happen under *any* merge mode)

Separately from `merge: pr`, **any** cycle — regardless of which `merge:`
mode you've configured — can demote to a PR (or a local escalation if there's
no remote/`gh`) when one of these triggers fires:

| Trigger | Meaning |
|---|---|
| `overlap` | Your changed files collide with a live concurrent cycle's files |
| `conflict` | The merge into `orch/integration` itself fails |
| `post-merge-test-fail` | Tests fail after merging into the integrated tree |
| `merge-lock timeout` | The local merge lock was never acquired in time |
| `main-sync-failed` | Local `main` couldn't catch up to `origin/main` |

With a remote and `gh` available, orch pushes the branch and opens a PR,
carrying full context in the PR body: round count, base SHA, changed paths,
and trigger-specific detail (the overlapping paths, the conflicting paths,
etc.) plus a one-line suggested next action. Without a remote/`gh`, it writes
`.orch/reviews/<branch>/DECISION.md` instead and keeps the branch for manual
review.

**Takeaway:** PR-fallback is not a mode you choose — it's the safety net that
catches a cycle whenever the fast local path can't complete cleanly, under
*any* `merge:` setting. `merge: pr` just makes "always a PR" the *primary*
path instead of the fallback.

### 3.5 Decision guide — which merge mode do I actually want?

| You want... | Set |
|---|---|
| Fast local iteration, single shared PR gate to `main`, concurrent cycles land without fighting each other | `merge: no-ff` (default) — do nothing |
| Same as above, but a strictly linear `orch/integration` history (no merge commits), and can tolerate more frequent PR-fallback | `merge: ff-only` |
| Every cycle becomes its own PR straight to `main`, no shared integration branch, no two-speed lag, branch protection satisfied every time | `merge: pr` |
| Cycles that land locally to still eventually reach `main` without you clicking merge each time | add `github.autoMergePr: true` (works with any mode that opens a PR) |

---

## Part 4 — Everything that happens automatically around a merge

### 4.1 Version bump on merge (opt-in, local integration path only)

```yaml
release:
  autoBump: true    # off by default
```

Off by default: without this flag, a merge lands with no release-file edits
at all — orch doesn't assume your repo wants a merge-counter bump and a
CHANGELOG commit on every integrated cycle. With `release.autoBump: true` in
`.orch/orch.yml`, every cycle that lands via `orch/integration` (i.e. **not**
`merge: pr`) bumps the merge counter in `package.json` right after the
post-merge test gate passes, mirrors that into `package-lock.json`, prepends
a `CHANGELOG.md` entry naming the branch (and issue number, for `orch
issue`), and commits it all as `chore(release): vX.Y.Z`. See this repo's own
README, "Version bump on merge" section, for the full `x.y.zcc` scheme (merge
counter vs. publish counter) — this doc doesn't re-derive it.

This is **best-effort**: a missing or unparsable `package.json`, or any
write/commit failure here, is swallowed — it never blocks or unwinds a merge
that already landed. Don't rely on it as a strict gate; it's a convenience.

### 4.2 Auto docs-update on merge (opt-in)

```yaml
docs:
  autoUpdate: true    # off by default
  prompt: "update documentation to reflect the latest merged changes"
  paths: ["*.md", "docs/**", "**/*.md"]
```

A successful merge spawns a detached `orch task` that refreshes
documentation. A **loop guard** skips the trigger when the merged branch
touched *only* docs files (so the docs-update's own merge doesn't re-spawn
itself forever), and when the merge was a no-op diff. A mixed code+docs merge
triggers once.

Two independent surfaces implement this, so it fires whichever way a merge
happens: local merges (`orch task`/`orch review`) are handled inside `orch`
itself; GitHub-side PR merges (`orch pr --merge`, or a human clicking merge
on GitHub) are handled by the `.github/workflows/orch-docs.yml` Action.

**When to turn it on:** repos where documentation reliably drifts from code
and you're willing to spend an extra cycle's worth of agent time per merge to
keep it current.

### 4.3 Crash recovery

A killed `orch task` can leave worktrees under `.orch/wt`; the next run
sweeps orphans, but only ones whose owning process is actually dead (checked
via a `pid\nsid` marker) — a live peer's worktree is never touched.

If the author had already committed when the process died, the branch and
its commit survive, and the **next run with the same task text** reattaches
that branch and resumes from where it left off (audit → gate → merge)
instead of re-authoring from scratch. This is independent of which agent is
next in the rotation — the resuming run pins the original author.

A finer-grained checkpoint inside a resumed cycle also remembers each
completed review round's verdict and whether the test gate already passed,
so a crash mid-review doesn't force a full re-audit or re-test.

If the checkpoint outlives its branch (you deleted it, or it only ever landed
on the remote), `orch continue` no longer dies with a bare "branch no longer
exists": it distinguishes a remote-only branch (stop and ask you to check it
out) from a truly-gone one (clear the orphaned checkpoint/inflight record and
exit clean), so stale resume state can't wedge later runs.

`--dry` never deletes worktrees or branches, ever.

### 4.4 Post-merge tidy

After a `task` run merges, orch cleans up after itself: pushes
`orch/integration` and opens/updates its persistent PR to `main`, deletes the
temporary work branches it created, and prints a plain-English summary of
what it did. Anything that could lose work — e.g. a branch carrying unmerged
commits — is explained and removed only after you confirm `[y/N]`; with no
terminal attached (CI, cron) it is left untouched and noted instead of
guessed at.

Pass `--no-tidy` to skip all of this and leave every branch and checkout
exactly as-is — useful when you want to inspect the cycle's raw artifacts
before anything is pruned.

### 4.5 Concurrency cap

```yaml
concurrency: 4   # default
```

An over-cap launch exits immediately (`exit 2`) rather than queueing:

```
orch: concurrency cap 4 reached — 5 cycles live; skipping pr/claude/<slug>-<sid>
```

Raise the cap, or wait for a live cycle to finish, then rerun.

---

## Part 5 — Configuration reference (`.orch/orch.yml`)

All keys optional. `.orch/orch.yml` wins over a bare `orch.yml` at repo root
if both exist (back-compat only).

```yaml
# === Agents ===
agents:                          # rotation pool when no explicit roles set
  - claude
  - codex

# === Roles (set both sides or neither) ===
# A role is "<agent> [model] [effort]". Current Claude model ids:
#   claude-opus-4-8, claude-sonnet-5, claude-fable-5, claude-haiku-4-5-20251001
# An unknown/misspelled model id doesn't fail fast — it silently escalates
# the cycle after round 1, so double-check the id before relying on it.
#
# author: claude claude-opus-4-8 high
# reviewer: codex
# authors:
#   - claude claude-opus-4-8 high
#   - codex
# reviewers:
#   - claude
#   - codex high

# === Cycle ===
test: auto                       # or an explicit command, e.g. "pytest -q"
reviseCap: 3                     # max revise rounds before escalation
stageTimeout: 25                 # per-stage wall-clock cap, minutes; 0 = off
concurrency: 4                   # max concurrent cycles per repo dir
baseBranch: main                 # trunk orch reads/diffs/opens PRs against; e.g. dev if main is deploy-only
integrationBranch: orch/integration
merge: no-ff                     # ff-only | no-ff | pr

# === Cheap-agent dispatch (optional) ===
# cheap:
#   role: qwen3-coder-30b
#   paths:
#     - "*.md"
#     - docs/**

# === Scope gate (optional) ===
scope:
  maxLines: 0                    # 0 = off; >0 escalates oversized author commits
  ignore:
    - "*.lock"
    - dist/**
    - "*.snap"

# === GitHub PR bridge ===
github:
  mergeMethod: squash             # squash | merge | rebase
  autoMergePr: false

# === Main mirror PR (integrationBranch -> baseBranch) ===
main:
  autoMerge: false                # true = orch itself merges the persistent integration PR once its checks are green
  conflictResolution: manual      # manual | propose | auto
  # conflictResolutionResolvers:  # default: null; role specs, rotate/fail over per conflict
  #   - claude
  autoResolveConflicts: false     # deprecated alias: true = conflictResolution: auto
  autoResolveConflictPaths:       # whitelisted metadata paths conflictResolution: auto may push
    - CHANGELOG.md
    - docs/index.html
    - package-lock.json
    - package.json

# === Auto docs-update ===
docs:
  autoUpdate: false
  prompt: update documentation to reflect the latest merged changes
  paths:                          # docs-only globs (loop guard)
    - "*.md"
    - docs/**
    - "**/*.md"

# === Release automation ===
release:
  autoBump: false                 # true = merge-counter bump + CHANGELOG commit after each integrated merge (§4.1)
```

### 5.1 Field-by-field notes

- **`agents`** — the rotation pool used when `author`/`reviewer` aren't set.
  Built-in agents: `claude`, `codex`, `copilot`, `gemini`, `agy`, `grok`,
  `kimi`. Local-llm
  models (`qwen3-coder-30b`, `deepseek-coder-v2-lite`, `glm-4.5-air`) run via
  `ccr` and need `~/.claude-code-router/config.json`'s `local` provider
  configured.
- **`author`/`reviewer` vs `authors`/`reviewers`** — singular pins one role
  each; plural runs each author on its own branch, cross-reviewed by every
  reviewer that didn't write it. Set matching CLI flags
  (`--author`/`--reviewer` or `--authors`/`--reviewers`) to override per-run
  without editing the file.
- **`reviseCap`** — how many author-revise rounds happen after a
  `DISAGREE` before the cycle gives up and escalates. Raise it if your
  reviewers tend to converge slowly; lower it to fail fast and escalate to a
  human sooner.
- **`stageTimeout`** — kills a stalled author or review stage (whole process
  group, wall-clock, not CPU time) rather than hanging forever on a wedged
  agent CLI. `0` disables it — not recommended in CI.
- **`merge`** — see Part 3. This is the big one.
- **`cheap`** — `role` is the agent spec `--cheap` forces for one run;
  `paths` auto-routes a `--file`/`orch issue` work order to it *without* the
  flag, when every one of the work order's `suspected_paths` matches a glob
  in `paths` (e.g. route docs-only issues to a cheap local model
  automatically).
- **`scope.maxLines`** — a guardrail against an agent going far beyond the
  ask: `0` disables it; set it to escalate (not silently truncate) any author
  commit whose changed-line count exceeds the limit, ignoring the globs in
  `scope.ignore`.
- **`security.ignore`** — globs exempt from the deterministic security scan
  (§1.1 step 4). Empty by default: everything is scanned. This exists for
  repos that commit build artifacts (a minified `dist/` bundle trips the
  subprocess rule on lit's `RegExp#exec()` — see issue #334); it is a
  *separate* list from `scope.ignore` on purpose, because dropping a file
  from a line count is routine hygiene while dropping it from the security
  floor is a security decision that deserves its own explicit opt-in.
- **`github.mergeMethod`** — only affects PRs orch itself merges via `gh`:
  `orch pr --merge` and the `merge: pr` per-cycle PRs. It does **not** apply
  to the persistent `orch/integration → main` PR — that one always uses a
  merge commit, deliberately, so `orch/integration` stays in `main`'s
  ancestry (a squash or rebase would strand the integration branch outside
  `main`'s history and break the fast-forward mirror model from §1.2). It
  also doesn't touch how a human merges a PR on GitHub's UI. Because that PR
  always uses a merge commit, the repo must have "Allow merge commits"
  enabled in its GitHub merge-button settings — if a repo only allows
  squash/rebase, this PR can never be merged (by orch or by hand).
- **`github.autoMergePr`** — enables GitHub's *native* auto-merge on PRs orch
  opens or updates, so they merge themselves once their own required checks
  pass, with no further orch involvement. If GitHub rejects the auto-merge
  request (e.g. branch protection isn't configured to allow it), the PR
  itself is unaffected — only auto-merge silently doesn't get enabled.
  Caveat: if the branch's review requirement is satisfied only via a GitHub
  ruleset `bypass_actors` grant (rather than a real human approval), GitHub's
  native auto-merge does not reliably fire — it can stay enabled with
  `mergeStateStatus: BLOCKED` indefinitely even after checks pass. For the
  persistent `orch/integration → main` PR, set `main.autoMerge: true` (below)
  to have orch merge it directly instead of relying on native auto-merge; the
  one-shot `merge: pr` per-cycle PR has no such fallback, since nothing
  re-invokes it later the way the persistent integration PR gets re-touched
  every cycle.
- **`main.autoMerge`** — opt-in (default `false`). When `true`, every cycle
  that re-touches the persistent `orch/integration → main` PR checks whether
  *all* of that PR's status checks are green and, if so, merges it directly
  via `gh` (a merge commit, same as the mirror model requires). This is the
  fallback for when native auto-merge (`github.autoMergePr`) stalls at
  `BLOCKED` because the review requirement is satisfied only through a ruleset
  `bypass_actors` grant rather than a human approval. The direct merge runs as
  whatever `gh` identity orch is authenticated as — an `orch[bot]` installation
  token if `ORCH_APP_ID`/`ORCH_APP_PRIVATE_KEY` are set, an explicit `GH_TOKEN`
  if you export one, otherwise your ambient `gh` login — so it only succeeds if
  *that* actor is itself in the branch's `bypass_actors` list. This is required
  for bot-authored PRs because GitHub rejects self-approval: the same actor that
  opened the PR cannot approve its own PR to satisfy a required-review rule. A
  ruleset bypass means the GitHub approval is bypassed, not recorded;
  orch's internal author → cross-audit → test-gate is the review that governs
  the merge. Landing this against a bypass-protected `main` therefore requires
  granting the merging actor that bypass as an explicit, opt-in step; without
  it the merge call just fails and orch retries next cycle. It's also a no-op
  while any check is still pending or failing, and does nothing until a real
  merge lands to re-open/update the PR. Only affects the integration PR, never
  `merge: pr`'s per-cycle PRs.
- **`main.conflictResolution`** — controls what happens when the persistent
  `orch/integration → main` PR is dirty. `manual` comments for a human,
  `propose` lets a resolver draft a resolution and posts the reviewer summary
  without pushing, and `auto` pushes only whitelisted metadata conflicts after
  the configured test gate passes. Non-whitelisted conflicts are proposed for
  human approval even when a different reviewer agrees.
  `main.autoResolveConflicts: true` remains a deprecated alias for `auto`;
  `false` maps to `manual` when no explicit mode is set.
- **`main.conflictResolutionResolvers`** — optional role-spec pool for conflict
  resolution, using the same `"<agent> [model] [effort]"` grammar as authors
  and reviewers. The pool rotates per conflict and failed resolver attempts
  restart from the pre-merge tree before the next resolver tries.
- **`main.autoResolveConflictPaths`** — the glob whitelist `conflictResolution:
  auto` is allowed to push a resolution for; conflicts touching any other path
  are always proposed for human approval, regardless of resolver agreement.
- **`release.autoBump`** — opt-in (default `false`). When `true`, every cycle
  that lands via the local integration path gets the §4.1 merge-counter bump +
  CHANGELOG commit. Left off, orch never edits release files — same opt-in
  philosophy as `docs.autoUpdate`.

---

## Part 6 — Worked scenarios

**"I just want to fix a bug and have it end up on `main` eventually, minimal
ceremony."**
```bash
orch task "fix the flaky login test"
```
Default `merge: no-ff`. Lands on `orch/integration` immediately, opens/updates
the persistent PR to `main`. Merge that PR on GitHub whenever convenient (or
set `github.autoMergePr: true` once, so you never have to).

**"Compliance/branch-protection requires every single change to be its own
reviewable PR into `main` — no exceptions, no shared integration branch."**
```yaml
merge: pr
github:
  autoMergePr: true
```
```bash
orch task "add rate-limit header"
```

**"I want to run five unrelated fixes in parallel tonight and have them all
sitting on `main`-ready code by morning, reviewed via a single PR."**
Keep `merge: no-ff` (default). Launch with explicit disjoint roles so they
don't round-robin into each other:
```bash
orch task "fix bug A" --authors claude --reviewers codex &
orch task "fix bug B" --authors codex  --reviewers claude &
```
All land on `orch/integration`; one persistent PR accumulates all of them.

**"An external contributor opened a PR — I want orch's cross-audit applied to
it, and to merge it myself only if agents approve."**
```bash
orch pr 57
orch pr 57 --merge
```

**"I have a GitHub issue describing a bug; I want it fixed and the issue
closed automatically."**
```bash
orch issue 123
```

**"I wrote a branch by hand and just want a second-opinion audit, no
authoring."**
```bash
orch review my-branch --reviewer "codex, claude high"
```

---

## Part 7 — Common misunderstandings, addressed directly

- **"`orch task` merged, but I don't see it on `main`."** Correct, by design
  under the default `no-ff` mode — it merged into `orch/integration` and
  opened/updated a PR to `main`. Check that PR, or set
  `github.autoMergePr: true` if you want it fully automatic.
- **"I set `merge: pr` but nothing got merged."** `merge: pr` opens a PR *per
  cycle* — it still needs either a human to click merge on GitHub, or
  `github.autoMergePr: true` plus passing CI checks on that PR, to actually
  land on `main`.
- **"Two cycles I ran at once both escalated to PR-fallback instead of
  merging locally."** Check whether their changed files overlapped
  (`overlap` trigger) — give them disjoint `--authors`/`--reviewers` and
  disjoint file scopes, or accept the PR-fallback as the correct safety
  behavior for genuinely overlapping work.
- **"Why didn't my version get bumped?"** The bump is opt-in: set
  `release.autoBump: true` in `.orch/orch.yml` (it's off by default). Even
  then it only happens on the local integration path (`no-ff`/`ff-only`),
  never under `merge: pr`. If you're on `merge: pr` and want version bumps,
  that's your own CI's job now. Separately, this repo's own
  `.github/workflows/version-bump.yml` bumps the merge counter for any merge
  to `main` that doesn't already carry its own version change, regardless of
  merge path. That's the intended model — it's idempotent, so an orch
  integration merge (which already bumped) is skipped and the version moves
  exactly once per landing; only non-orch landings (e.g. direct-to-main PRs)
  get the workflow bump.
- **"I ran `orch review` just to get a second opinion, and it merged the
  branch!"** That's correct, and by design (§2.6) — `orch review` skips only
  the *authoring* step; agreement + green tests + a clean security scan still
  merges it, exactly like `orch task` would. If you want a verdict with no
  possibility of a local merge, point `orch pr` at a GitHub PR instead —
  that's the one command in this list that never merges locally.
