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
   repeats, up to `roundCap` rounds (default 3) — the initial review is round
   one, so 3 buys 3 reviews and 2 revisions — except under `orch review`,
   which has no author to revise and so escalates immediately on the first
   `DISAGREE` instead of looping. Before each round orch checks that the
   branch actually differs from its base. An empty diff means there is nothing
   to review, so the cycle escalates right there with `author produced no
   changes — nothing to review` rather than paying a reviewer to read an empty
   patch (and, worse, letting an `AGREE` on nothing reach the merge step). The
   check repeats every round, but it compares the *whole branch* against its
   base — not one revision against the previous one. So it catches a revise
   that leaves the branch empty (the author undid its own work), while a
   revise that simply adds nothing new keeps the earlier diff in place and the
   loop still runs to `roundCap`. Under `orch review` the same check rejects
   an already-merged or empty branch before the audit runs.
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
   safe. Three things are outside the scan. First, a built-in path exemption:
   markdown and `docs/**` paths are dropped before the added-line content
   scan runs (mirroring `docs.paths`), because prose cannot execute a secret
   read at runtime. That exemption applies to the content scan only — a
   separate path-based floor over the *changed paths* still covers the
   guardrail file under `docs/`: a change to `docs/CODEOWNERS` trips a
   `guardrail-touch` finding today. Second, files matching a `security.ignore`
   glob (default:
   none) — an escape hatch for committed build artifacts like minified
   bundles, where pattern-matching on generated text false-positives (a
   `RegExp#exec()` call in minified code reads exactly like a subprocess
   `exec()`). Exempting a path skips *every* security rule for it, so list
   only generated files, never authored code. `orch.example.yml` ships the
   block commented out for exactly that reason. Third, and narrowest: the
   `secret-read` rule alone skips an added line whose trimmed content starts
   with `//`, because a `//` line comment naming `.orch/` or `.env` describes a
   path rather than reading one. Read that exemption literally — it is only
   `//` line comments (a `#` comment in Python or YAML is *not* exempt), only
   whole-line ones (`readFileSync(".orch/x") // fixture` still fires, and so
   does `/* note */ readFileSync(".orch/x")`), and only that one rule:
   `env-read`, `network`, `guardrail-touch`, and the subprocess check all still
   fire on comment lines. This runs on every cycle that reaches AGREE + green, including the
   `orch pr`/PR-bridge audit-only path (§2.7) where nothing else merges.
5. **Merge** — *only if* every reviewer said `AGREE`, tests passed, **and**
   the security scan found nothing — the branch is merged. How and where it
   merges is the part this manual spends the most time on, because there are
   three distinct answers. `orch review <branch>` **does merge** on this same
   AGREE-and-green outcome, exactly like `orch task`; the only thing it skips
   is the authoring step. Only `orch pr` stops short of a local merge — it
   reports its verdict and leaves GitHub to own the actual merge (§2.7).

If any stage fails — reviewer disagreement past the cap, red tests, a risky
security-scan finding, a merge conflict, an author that produced no changes at
all — the cycle does not merge. It
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

1. Under a short-lived `merge.lock` (so two concurrent cycles don't race each
   other), orch first fetches `origin/orch/integration` and fast-forwards the
   local integration branch when it is behind. A **fast-forward** only advances
   along existing history; it creates no merge commit. If the refs have
   **diverged** — each has commits the other lacks — orch demotes with `sync`
   rather than guessing at a merge. A second reconciliation, integration
   against the *base* branch, is deliberately more forgiving: behind the base
   fast-forwards as above, but diverged from the base does **not** demote — orch
   merges the base into integration (`git merge --no-edit`) and carries on.
   The asymmetry is intentional. Divergence from `origin/orch/integration` means
   two writers disagree about the same branch, which a human has to settle;
   divergence from the base is the routine aftermath of an integration PR landed
   by **squash or rebase**, where `main` gains integration's tree under a brand-new
   commit that shares no history with it. Left unlinked, the next cycle's land
   hits add/add conflicts on files both sides already agree on; the merge commit
   re-establishes the base as an ancestor and only ever adds a commit, never
   rewrites one. If that merge conflicts, orch aborts it and proceeds to the
   merge attempt anyway rather than demoting — no worse than the no-op it
   replaced, though nothing surfaces the skip, so a repeat `dirty-merge` is the
   symptom you'd actually see. Orch itself always merges the persistent
   integration PR with a merge commit (see `github.mergeMethod`, §5.1), so this
   path is reached only when a *human* squash- or rebase-merges it on GitHub. The cycle then merges into
   `orch/integration` locally, and a post-merge re-test runs against the
   *integrated* tree, not just the branch — catching semantic conflicts a plain
   git merge wouldn't.
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

**What `merged` means on this default path.** The claim is local and
path-specific: orch reports `merged` only after the integrated worktree and the
local `orch/integration` ref agree on the merged SHA. That does not prove that
`origin/main` contains the commit yet; if the PR bridge fails, the reason says
the content is local-only. The stronger remote verification described in §2.7
belongs to `orch pr --merge`, whose GitHub merge is pinned to the fetched and
reviewed PR head and checked against `origin/main` afterward.

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
`merge-deferred` trigger), `orch` posts a comment on the *source issue* itself —
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
orch pr 42 --merge     # ...and ask GitHub to merge if agents approve + tests pass
```

That merge request goes to GitHub's REST merge endpoint (`gh api -X PUT
repos/{owner}/{repo}/pulls/<n>/merge`), not `gh pr merge`. Plain `gh pr merge`
runs its own client-side "is this mergeable?" precheck, and that precheck is
blind to ruleset bypasses — it refuses merges the server would actually
allow.

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

**The fetched and reviewed head is the only one eligible to merge.** With
`--merge`, orch resolves the fetched PR head's commit SHA before review and
pins GitHub's merge request to it. If the PR head moves during review, GitHub
rejects the pinned request; orch stops and tells you to re-run
`orch pr 42 --merge` so the new head is audited instead of landing code the
agents never saw.

**Merge verification, not just a trusted success response.** After the pinned
GitHub merge request returns success, `orch` doesn't take that at face value:
it re-fetches `origin/main` and confirms that the merge commit reported by
`gh` is present as an ancestor before it prints `merged`. This matters because
a squash or rebase merge mints a brand-new commit SHA that has nothing to do
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

**Polling is cheap.** The dashboard caches its state reads — checkpoint
files, `runs.jsonl`, and review-log tails — keyed on each file's
mtime/size/inode, so a live-TUI refresh (or any repeated render in one
process) only re-reads files that actually changed since the last poll. Log
tails are served by reading just the last 16 KiB of the newest round file
rather than loading the whole thing. The cache is in-memory only and never
writes anything, so the read-only guarantee above still holds, and a changed
file is picked up on the very next poll.

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

### 2.12b `orch mcp` — serve orch to AI clients over MCP

`orch mcp` turns the CLI into a **Model Context Protocol** server. MCP is a small
JSON-RPC protocol that lets an AI client (Hermes Agent, Claude Code, anything
else that speaks it) *discover* the operations a program offers and call them
with typed arguments, instead of the client having to memorise a shell recipe.
The server speaks newline-delimited JSON-RPC 2.0 on **stdin/stdout**, so stdout
carries protocol frames only — every diagnostic goes to stderr.

Configure it the same way in both clients. Claude Code (`.mcp.json` in the repo,
or `~/.claude.json`):

```json
{
  "mcpServers": {
    "orch": { "command": "orch", "args": ["mcp"] }
  }
}
```

Hermes Agent (its MCP server list, same shape):

```json
{
  "mcpServers": {
    "orch": { "command": "orch", "args": ["mcp"], "cwd": "/path/to/your/repo" }
  }
}
```

The server runs the cycle in whatever directory it was started in, so point
`cwd` at the repo you want orchestrated (Claude Code starts it in the project
directory already).

The tools:

| Tool | Runs | Notes |
| --- | --- | --- |
| `orch_status` | `orch dashboard --json --once` | Read-only; returns the parsed snapshot. Optional `limit`. |
| `orch_plan` | `orch task --dry` | Plans a cycle — branch, author, reviewers — without calling an agent, touching git or merging anything. Leaves the author rotation where it was; an escalated plan still writes its brief (§2.13). |
| `orch_task` | `orch task` | Full cycle from a task description. |
| `orch_issue` | `orch issue <n>` | Full cycle from a GitHub issue. |
| `orch_review` | `orch review <branch>` | Audit-only. |
| `orch_continue` | `orch continue <sid>` | Resume from a checkpoint. |

Every call returns JSON: `ok`, `exitCode`, the `command` that ran, a `cycles`
array (each with `sid`, `branch`, `status`, `reason`, `prUrl`, `closes`,
`rounds`) read from the run records the call appended, `logs` paths, and the raw
`stdout`/`stderr`. `.orch/runs.jsonl` is repo-wide, so a cycle another client or
a terminal `orch` finished mid-call also lands in that tail; `cycles` holds only
the records this call produced. Every tool that *starts* a cycle — `orch_task`,
`orch_issue`, `orch_review` — matches on the cycle id's process prefix, because
the child that minted that id is the process the call spawned. `orch_continue`
resumes a cycle whose id predates that child, so it matches the sid literally
instead. A branch name is deliberately never used as the key: two `orch_review`
calls auditing the same branch at once would each read back the other's verdict
alongside their own. A cycle that escalates
comes back as a *tool* error (`isError: true`) with the reason readable — not as
a protocol error, so the client can act on it.

**What the server deliberately cannot do.** The CLI stays the source of truth:
each tool spawns `bin/orch.js` with a fixed argument list, `shell: false`, and no
caller-supplied flags — free text is passed after `--` and refused outright if it
starts with `-`, so a task string can't smuggle in `--allow-protected` or
`--config-file`. There is **no shell tool** and **no `orch pr` tool**, and no
tool can emit `--merge`. Since `--merge` is orch's only PR-merge path, an MCP
client cannot merge a pull request itself: the server hands out no merge
authority that a hand-typed `orch` in the same repo does not already have. That
much is a property of the tool table, not of a policy setting — see the test.
Everything else — the security floor, the protected-path intake
refusal (§2.14), the test gate, per-cycle worktree isolation, checkpoints and the
concurrency cap (§4.5) — lives in the cycle the child process runs, so it applies
to an MCP-started cycle exactly as it does to a hand-typed one, including when
several cycles are started at once.

**What it cannot promise: where a green cycle lands.** That is the repo's config
talking, and it answers the same way for an MCP-started and a hand-typed cycle.
Under the defaults (`integrationBranch: orch/integration` in §5, `main.autoMerge:
false` in §5.1) the cycle lands on the integration branch and `main` advances
only when a human merges the standing integration PR — the human checkpoint. A
repo that points `integrationBranch` at its `baseBranch`, or sets
`main.autoMerge: true`, has already opted every green cycle out of that
checkpoint; exposing MCP does not change that, but it does mean the checkpoint is
not there to rely on. Check both keys before pointing a client at a repo.

**One caveat.** A real cycle takes minutes and the tool call blocks for all of
it, so a client with a short tool timeout may give up while the cycle keeps
running to completion in the child process; poll `orch_status` to see where it
got to. `orch_status` and `orch_plan` return immediately.

### 2.13 Flags that apply across commands

- **`--dry`** — plan a `task`/`review` cycle without shelling out to agents,
  touching git, or running tests. Never deletes worktrees or branches. Since
  v0.4.302 (#471) it also keeps its bookkeeping out of `.orch/`: the author it
  picks is computed but not persisted to `.orch/last-author`, and round logs and
  run records are stubbed out. The rotation is therefore unchanged — the next
  real cycle starts from the same agent the plan showed you, and a plan that
  runs clean in a repo that has never run orch leaves no `.orch/` directory
  behind. **The escalation path is the exception.** Escalating is how orch
  reports that a cycle cannot proceed, so it is not stubbed: any escalation the
  plan reaches still writes its brief to
  `.orch/reviews/<branch>/DECISION.md` and resets `.orch/kpi.json`, creating
  `.orch/` if it was absent. The easiest one to hit is an unset test gate — with
  `test:` empty in `orch.yml` there is no command to run, so the plan escalates
  with "no test gate detected" and exits 2.
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
- **`--allow-protected`** — run a `task`/`issue` even though the work order text
  names a protected path, instead of being refused at intake. See §2.14.

### 2.14 The protected-path intake refusal

Before `orch task` / `orch issue` starts the cycle — no author agent runs, no
branch or worktree is created, no run is recorded — orch scans the work order
**text** for mentions of a *protected path*. A protected path is an entry on the
hardcoded denylist `DEFAULT_PROTECTED` in `src/intake/allowlist.js`: orch's own
guardrail machinery (`src/gate.js`, `src/verdict.js`, `src/notify.js`,
`src/security-review.js`, `src/intake/**`), CI wiring (`.github/workflows/**`,
`.github/actions/**`), `package.json`, `package-lock.json`, `CODEOWNERS` and
`.github/CODEOWNERS`, `Dockerfile`, `sandbox/**`. It is a denylist and
deliberately not config-driven, so an ordinary new file never needs a config
edit to be writable.

If the scan hits, orch refuses:

```console
$ orch task "tighten the glob in src/security-review.js"
orch: refusing to run: the task names protected path(s): src/security-review.js
orch cannot author changes to protected paths — the review-time guard rejects such a diff, so this run could only end in stalemate. Make the change directly (hand-land it), reword the task if the mention is incidental, or pass --allow-protected to run anyway.
```

The refusal happens at intake rather than after three rounds because a work order
that **genuinely requires** a change to a protected path is **unsatisfiable by
construction**. Two independent floors protect the denylist, and they do not fire
in the order the names might suggest:

1. **The security scan's `guardrail-touch` floor fires first.** `scanDiff` in
   `src/security-review.js` (§1.1 step 4) matches changed paths against the same
   protected set (plus `docs/CODEOWNERS`). One finding means `DISAGREE` with no
   severity threshold. In the engine that escalate sits *above* the merge-boundary
   path check, so an ordinary protected-path diff never reaches step 2.
2. **`checkPaths` is the merge-boundary backstop.** It runs once on the final
   diff, past AGREE and green, only if the security scan already said AGREE. It
   is still load-bearing: it is the only of the two that fails closed on a `..`
   path-traversal segment, which the security floor's anchored globs would not
   match. Do not read "merge-boundary path floor" as "checkPaths is what blocks a
   normal guardrail edit" — for that case, `guardrail-touch` already escalated.

So intake refuses early: running the cycle would burn author + audit work only to
hit `guardrail-touch` on the first otherwise-agreeing round. Diagnostic
consequence — nothing started, so there is no run in `orch dashboard`, no branch,
and no `.orch/reviews/<branch>/DECISION.md`. The stderr line is the only artifact.

`--allow-protected` exists because the scan is **textual** and can false-positive —
an incidental mention of a filename should not lock you out. That is its main
case. The flag skips *only* the intake scan; it cannot make orch **land** a
guardrail change. A real protected-path diff still hits `guardrail-touch` and
escalates.

A change that genuinely must touch a guardrail has exactly two routes:

1. **Hand-author it** without orch (the right default for a small guardrail tweak).
2. **`--allow-protected` to have orch stage it.** The flag skips only the intake
   scan, so the cycle runs, then escalates at `guardrail-touch`, leaving the
   branch and its `DECISION.md` for a hand review and hand merge.

Without the flag neither route produces a branch, because nothing starts.

Either route ends outside `finalize()`, so the version bump and CHANGELOG entry
that a green merge writes **when `release.autoBump: true`** never run. Close the
recovery with two steps, plus a third only in an auto-bump repo:

1. **Verify** the staged branch (or your hand-authored commit) is correct.
2. **Merge** it onto `orch/integration` (resolve conflicts there; do not open a
   per-change PR against `main`).
3. **Only if `release.autoBump: true`** (§4.1 — it is `false` by default, and
   then a clean merge does no release bookkeeping either, so there is nothing to
   recover): **`orch release "<changelog entry>"`** — bumps `package.json` (and
   the lock file / site version span when present), prepends a CHANGELOG section
   with your entry, and commits `chore(release): vX.Y.Z`. Requires a clean working
   tree; refuses otherwise and leaves your uncommitted files untouched. Does
   **not** create a git tag (CI tags on push).

### 2.15 `orch release "<changelog entry>"`

The bookkeeping half of a merge, on demand. Version bumps and CHANGELOG lines
live inside `finalize()` (§4.1) behind `release.autoBump`, so in a repo that
opted in with `release.autoBump: true`, *any* landing that bypasses `finalize()` —
the escalation recovery in §2.14, a `dirty-merge` hand-merge (§3.4), a plain
hand-authored commit — leaves commits nobody can map to a released version.
`orch release` runs that same bookkeeping after the fact:

```bash
orch release "hand-landed guardrail fix (closes #403)"
```

- Bumps `package.json`, `package-lock.json`, and the landing page's version
  span when present, and prepends a CHANGELOG section holding your entry.
- Commits everything it wrote as `chore(release): vX.Y.Z` — on whatever branch
  is currently checked out. It does not switch branches for you, so check out
  `orch/integration` (after the hand-merge) *before* running it.
- **Refuses a dirty working tree**, so it can never sweep your uncommitted work
  into a release commit. Fix or stash first, then re-run.
- Recovers only the files it wrote if the bump fails partway — no whole-tree
  reset, so nothing of yours is discarded.
- Does **not** create or push a git tag: tagging is CI's job on push, and a
  local tag would race it. The tag-release workflow derives the tags from the
  push's commit range (`scripts/release-tags.js`), so a push carrying several
  `chore(release)` commits gets every version tagged, not just the tip — and
  the job fails loudly if that derivation crashes rather than silently
  tagging nothing. One known limitation remains: `GITHUB_TOKEN` is refused when
  `git push`ing a tag whose history reaches a `.github/workflows/` change
  (reachability alone is enough — the tag itself introduces no content). That
  left `v0.4.216` untagged until a hand repair (#416); the ready-to-apply fix
  lives in `PLANNED.md` because the workflow path is protected from orch
  authorship.

It needs no cycle, no agents, and no `.orch/` state — it is pure git and file
bookkeeping, and orch never calls it for you.

It also never *reads* `release.autoBump`: run it and it bumps, whatever the
config says. That asymmetry is the one thing to keep straight. `autoBump`
(§4.1) is `false` by default, and a repo that left it there gets **no** release
bookkeeping from a clean merge — so a hand merge in that repo has skipped
nothing, and running `orch release` would manufacture a `chore(release)` commit
the repo deliberately opted out of. Reach for `release` only where `autoBump` is
`true` (or where you have decided, this once, that you want a release commit).

### 2.16 Running several issues in a row

A shell chain is already a useful batch runner; no new `orch` command is needed.
Choose the operator based on whether a failed cycle should stop the queue:

```bash
orch issue 442 && orch issue 443
```

`&&` runs the commands sequentially and stops at the first cycle that exits
nonzero. This is usually the right default: an escalation means a human needs
to look, and continuing would base later cycles on a contested tree.

```bash
orch issue 442; orch issue 443
```

`;` also runs the commands sequentially, but runs the next command regardless of
the previous command's outcome.

For more than two or three issues, a loop is the same keep-going behavior in a
more readable form:

```bash
for n in 442 443 445 446; do orch issue "$n"; done
```

Be careful with `&`. It backgrounds the preceding `&&` list, so this line:

```bash
orch issue 442 && orch issue 443 && orch issue 445 & orch issue 446
```

is parsed as:

```bash
( orch issue 442 && orch issue 443 && orch issue 445 ) &
orch issue 446
```

That is a three-cycle chain in the background plus a fourth cycle running at the
same time — two lanes, not one queue.

Serial execution is the default recommendation for an issue queue. Each cycle
bases its worktree on the local base branch and merges into
`orch/integration`. Two cycles touching overlapping files can therefore start
from the same base and collide at merge time; orch demotes the later one to
`merge-deferred`. Running in sequence lets each cycle see the previous cycle's
merge and avoids that overlap.

#### Exit codes in a chain

`&&` depends on the exit status, not on the wording of the terminal summary:

| Code | Meaning |
|---|---|
| `0` | Normal completion: merged, approved, or a successful dry run. |
| `1` | An uncaught exception (`bin/orch.js:5`): orch itself broke. |
| `2` | An escalation, `merge-deferred`, a non-approved `orch pr`, or the concurrency cap being hit. |

Exit `2` for a cycle outcome is not a crash. It means orch is working
correctly and declining to land something on its own — a human should decide
this — which is why halting the rest of a `&&` chain is usually sensible.
There is one important batching gotcha: the concurrency cap shares exit `2`
with escalation. If another cycle is already live and the cap is reached, orch
prints:

```text
orch: concurrency cap N reached — M cycles live; skipping <branch>
```

Nothing was reviewed or decided in that case; the issue was skipped. At the
shell, the two outcomes are indistinguishable, so read the printed line rather
than relying on the exit status alone. The `2` status is set in the `agent build`,
`task`/`issue`/`review`, `continue`, and `pr` handlers for the relevant outcomes.

After a halt, use `orch dashboard` for the full run history. The durable record
is `.orch/runs.jsonl`; its rows include `ts`, `branch`, `sid`, `verdict`,
`reason`, and `rounds`, with optional `tokens`, `costUsd`, `sha`, `prUrl`, and
`closes` fields.

### 2.17 `orch upgrade` (alias: `orch update`)

Self-updates the globally installed `orch` binary to the latest published
version. It works out how orch was installed and re-runs the matching command,
so you do not have to remember whether it was `npm`, `pnpm`, or something else.

```bash
orch upgrade            # install the latest version
orch upgrade --check    # report the latest version without installing anything
```

`--check` is the form to use in a script or a shell prompt: it tells you whether
you are behind and changes nothing on disk. orch also checks for updates in the
background during ordinary runs and prints a one-line notice when a newer
version exists — `upgrade` is how you act on that notice.

Unlike every other command in this part, `upgrade` does not read `.orch/` and
does not care which repo you are standing in. It manages the tool, not your
project.

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
**defers to a PR** instead (see §3.4, `merge-deferred`) rather than force- or
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
locally the same way ordinary `merge-deferred` does (§3.4) — it does not silently
merge somewhere else.

If `github.autoMergePr: true` and enabling auto-merge fails (e.g. branch
protection isn't set up for it), the PR itself still stands — only the
auto-merge step is skipped, never the PR. When enabling it succeeds, orch also
makes one immediate REST merge attempt, using the numeric PR number parsed from
the creation URL and pinned to the exact reviewed commit OID. This covers an
already-green PR whose review requirement is satisfied by a ruleset bypass but
whose native auto-merge remains `BLOCKED`. If the direct attempt is not ready,
orch swallows that failure and leaves the PR plus native auto-merge in place;
it does not poll or retry this one-shot direct path.

**Consequence you should know:** `merge: pr` does not run orch's
`release.autoBump` or CHANGELOG behavior described in §4.1 — those only apply
to the local integration path. Unless the PR itself carries release-file
changes, it lands without a version bump.

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

### 3.4 `merge-deferred` (this can happen under *any* merge mode)

Separately from `merge: pr`, **any** cycle — regardless of which `merge:`
mode you've configured — can demote when one of these triggers fires:

| Trigger | Meaning |
|---|---|
| `overlap` | Your changed files collide with a live concurrent cycle's files |
| `dirty-merge` | The merge into `orch/integration` itself fails |
| `integration-test` | Tests fail after merging into the integrated tree |
| `lock` | The local merge lock was never acquired in time |
| `sync` | Pre-landing branch reconciliation failed: local `main` from `origin/main`, local `orch/integration` from `origin/orch/integration`, or `orch/integration` from the base branch |

For most triggers, with a remote and `gh` available orch pushes the branch and
opens a PR, carrying full context in the PR body: round count, base SHA,
changed paths, and trigger-specific detail (the overlapping paths, the
conflicting paths, etc.) plus a one-line suggested next action. Without a
remote/`gh`, it writes `.orch/reviews/<branch>/DECISION.md` instead and keeps
the branch for manual review.

**`dirty-merge` never opens a per-change PR against `main`.** That would
create a second door into the trunk beside the standing
`orch/integration → main` PR. Instead orch escalates with the staged branch
and conflict detail so a human can hand-merge into `orch/integration`; the
standing integration PR remains the only trunk gate. After that hand-merge is
pushed to `origin/orch/integration`, a repo running `release.autoBump: true`
runs `orch release "<entry>"` so the version/CHANGELOG bookkeeping still lands
(the recovery never entered `finalize()`); under the default `autoBump: false`
there is none to land, so skip it (§2.15). The next cycle normally fast-forwards its local integration
branch automatically. A genuine divergence instead demotes with `sync`.

The `.orch/runs.jsonl` entry records `verdict: "merge-deferred"` and the cause
as a top-level `trigger` field.

**Automatic redrive of `overlap` deferrals — usually you do nothing.** An
`overlap` deferral is the one trigger orch can often heal by itself, because
nothing is actually *wrong* with the work: the peer cycle simply built its
branch on an integration tip that another cycle was about to move, so merging
it as-is would merge a stale result. Rather than throw that work away, orch
parks the cycle in a small on-disk queue (`.orch/deferred/<sid>.json`). This
applies to the local integration path (`no-ff`/`ff-only`) — under `merge: pr`
there is no shared integration tip to collide on or rebase onto, so the
`overlap` trigger never fires there in the first place.

When the blocking cycle finishes merging — still holding `merge.lock`, so no
peers ever fan out in parallel — orch walks that queue and, for every parked
peer the land unblocked:

1. **Rebases** the peer's branch onto the new `orch/integration` tip. A real
   line conflict fails here and the peer simply stays deferred for a human.
2. **Re-runs the full merge and the post-merge test gate.** A redriven merge is
   *gated, not trusted*: rebasing can produce a tree that merges cleanly but
   behaves wrongly (a "semantic conflict"), and only re-running the tests on the
   integrated tree catches that. Nothing is merged on the strength of the
   earlier, pre-rebase green run.
3. **Cascades.** A peer that heals becomes a new "just landed" blocker itself,
   so a cycle C that was deferred behind B gets redriven once B heals behind A.

Two limits keep this from becoming a retry loop. A peer that is still blocked by
a *live* in-flight cycle is left queued untouched (it hasn't used up anything —
its turn comes when that cycle lands). And each peer gets exactly **one**
automatic attempt (`MAX_REDRIVE_ATTEMPTS` in `src/deferred.js`); if that attempt
fails the rebase, the merge, or the gate, the cycle stays `merge-deferred` and a
human owns it from there. A failed redrive adds no extra noise: the escalation
PR opened by the original demotion is left exactly as it was, rather than a
second demote PR being opened beside it. A *successful* redrive usually retires
it: the merged path deletes the cycle's remote `pr/*` head, and GitHub closes a
PR whose head branch is gone. That cleanup is **conditional**, though — it only
runs once the integration PR bridge has pushed `orch/integration` to origin. If
that push or PR step fails, orch deliberately keeps the `pr/*` head (it is then
the only remote copy of the just-landed work) and the original escalation PR
stays open. So a redriven cycle can be merged locally and *still* show an open
`merge-deferred` PR; that PR is a leftover of the bridge failure, not a sign the
work was lost — check `.orch/runs.jsonl` for the cycle's `merged` record before
acting on it.

So the practical advice when you see an `overlap` deferral is: **wait for the
blocking cycle to finish, then check again** before doing anything by hand.

**Takeaway:** `merge-deferred` is not a mode you choose — it's the safety net that
catches a cycle whenever the fast local path can't complete cleanly, under
*any* `merge:` setting. `merge: pr` just makes "always a PR" the *primary*
path instead of the fallback.

### 3.5 Decision guide — which merge mode do I actually want?

| You want... | Set |
|---|---|
| Fast local iteration, single shared PR gate to `main`, concurrent cycles land without fighting each other | `merge: no-ff` (default) — do nothing |
| Same as above, but a strictly linear `orch/integration` history (no merge commits), and can tolerate more frequent `merge-deferred` outcomes | `merge: ff-only` |
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

One surface implements this: it lives inside `orch` itself, so any merge orch
performs locally (`orch task`, `orch review`, `orch pr --merge`) triggers it. A
merge done purely in GitHub's web UI never reaches orch, so nothing refreshes
the docs for it — run a docs task by hand if you merge that way.

There used to be a second, GitHub-side surface (an `orch-docs.yml` Action). It
was removed in v0.4.211 because it never worked: it required a *self-hosted
runner* — a machine you register with the repo, needed here because the agent
CLIs and their API keys cannot live on GitHub's hosted images — and none was
ever registered. A job whose labels match no runner does not fail; it queues
until GitHub cancels it at roughly 24 hours. So the Action reported neither
success nor failure for its entire life while the repo's docs quietly drifted.
The lesson generalizes: automation that fails loudly is nearly harmless, but
automation that silently never runs is worse than none, because people stop
doing the work by hand on the assumption that it is covered.

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

The checkpoint's first write happens earlier than any of that: the moment the
author's commit lands, orch records the branch under stage `"authored"`,
before the first audit call. Without it a cycle that died *during* round-1
review left nothing addressable by sid — the checkpoint's first write was
post-audit and the inflight record is deregistered on every exit path — so
`orch continue <sid>` said there was nothing to resume even though the
branch with the finished work was sitting right there. The stage buys
addressability only, not speed: it records no verdict and no green gate, so a
resumed run still audits and still gates from round 1.

Each recorded verdict is pinned to the branch head commit OID at the moment
it was recorded (`git rev-parse --verify refs/heads/<branch>`, so a tag that
happens to share the branch's name can't shadow the real head). The OID is
captured once per review round, and that single captured value then binds
the round's cached-verdict check, checkpoint writes,
security and path reads, and the final merge — a branch ref that moves
mid-round cannot launder unaudited content into a checkpoint the tests
actually ran on. On resume the shortcut is honoured only when the recorded OID
still equals the current head, and that match is re-verified at the moment
the cached verdict is consumed rather than only when the checkpoint is first
read: if the branch moved between the crash and `orch continue` — a manual
commit, a rebase, another cycle's revise — the new content does not inherit
a verdict earned by different code, and that round is re-audited (or the
gate re-run) instead. The recorded round is still adopted either way, so
resume keeps working; it just refuses to skip checks it cannot prove still
apply. A checkpoint written by an older orch has no OID and is treated as
unverifiable, not as a match — the cost is one extra audit on a resume that
spans an upgrade.

If the checkpoint outlives its branch (you deleted it, or it only ever landed
on the remote), `orch continue` no longer dies with a bare "branch no longer
exists": it distinguishes a remote-only branch (stop and ask you to check it
out) from a truly-gone one (clear the orphaned checkpoint/inflight record and
exit clean), so stale resume state can't wedge later runs.

Resume state lives as one small JSON file per record across four stores —
`.orch/checkpoints/`, `.orch/inflight/` and `.orch/deferred/` name their files
after the sid; `.orch/resume/` instead keys on a hash of the author plus the
full task text, so a re-run of the same task finds its record before a sid
exists. All four now share one storage primitive (`src/sid-store.js`) — the
filename is just the key it is handed — and therefore one
**corrupt-file policy**: a record that no longer parses as JSON — half-written
by a kill mid-write, hand-edited, truncated by a full disk — is discarded and
the run proceeds exactly as if that record had never existed. Deleting it from
disk is attempted too, since a file that can never become valid again is only
clutter — but that cleanup is **best-effort**: if the unlink itself fails (a
read-only mount, a permission or lock error), the file survives and is simply
re-discarded on the next read. Treating the record as absent is the guarantee;
removing the file is the tidy-up, and a failed tidy-up is never turned into an
error the caller has to handle.

Before the stores were unified, what happened depended on which code
path touched the file: the directory scans in `inflight` and `deferred` deleted
it, while every single-record lookup — including both of those stores' own —
skipped it silently and left it on disk. The behaviour is now deliberate and
identical everywhere. Operationally the cost is
the same as any missing record: `orch continue <sid>` reports nothing to resume,
and a fresh run re-authors or re-audits rather than trusting garbage.

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
roundCap: 3                      # max review rounds incl. the first
                                 # reviseCap is the deprecated alias for this key
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
- **`roundCap`** — how many review rounds a cycle gets before it gives up and
  escalates. The *initial* review is round one, so `roundCap: 3` means three
  reviews and at most two author revisions. Raise it if your reviewers tend to
  converge slowly; lower it to fail fast and escalate to a human sooner. The old
  name `reviseCap` still works: orch normalises it onto `roundCap` and prints a
  deprecation warning. If both keys appear in the same file, `roundCap` wins and
  the conflict is warned about rather than silently resolved.
- **`stageTimeout`** — kills a stalled author or review stage (whole process
  group, wall-clock, not CPU time) rather than hanging forever on a wedged
  agent CLI. `0` disables it — not recommended in CI. **The environment
  variable `ORCH_STAGE_TIMEOUT_MS` overrides this key entirely** — when it is
  set, the value here is not consulted at all. That precedence is deliberate:
  the variable is the ops escape hatch, so it has to win, or you could never
  raise a wedged repo's timeout without first editing its `orch.yml`. Mind the
  units — this key is in **minutes**, the variable is in **milliseconds**, so
  the equivalent of `stageTimeout: 25` is `ORCH_STAGE_TIMEOUT_MS=1500000`.
  Copying `25` across gives you a 25-millisecond cap that kills every stage on
  contact. See §5.2.
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
  (§1.1 step 4). Empty by default — but empty does **not** mean "every added
  line is scanned": markdown and `docs/**` paths are dropped by the scanner
  itself, before `security.ignore` is even consulted. This list exists for
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
  to have orch merge it directly instead of relying on native auto-merge. A
  one-shot `merge: pr` per-cycle PR gets one immediate, reviewed-OID-pinned
  direct REST attempt after native auto-merge is armed; if that attempt is too
  early, nothing re-invokes it later the way the persistent integration PR is
  re-touched every cycle.
- **`main.autoMerge`** — opt-in (default `false`). When `true`, every cycle
  that re-touches the persistent `orch/integration → main` PR checks whether
  *all* of that PR's status checks are green and, if so, merges it directly
  via `gh` (a merge commit, same as the mirror model requires). The merge is
  pinned to the integration tip this cycle pushed and verified (`sha=` on the
  REST merge endpoint). The persistent PR is designed to accumulate work from
  several cycles: a concurrent peer that lands on `orch/integration` between
  this cycle's push and its merge attempt is legitimate green work, not an
  intruder. On 409 (head moved) orch logs once that *integration advanced past
  the commit this cycle verified — the newer cycle will merge it*, does not
  escalate, and leaves the cycle's `merged` status and PR URL alone; every
  other error stays swallowed so a still-pending check is not cycle noise. This
  is the fallback for when native auto-merge (`github.autoMergePr`) stalls at
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

### 5.2 Environment variables

Everything above lives in `.orch/orch.yml`, which is per-repo and checked in.
The variables below are per-shell and per-run — the escape hatches you reach
for when you cannot or should not edit the config file, such as a one-off CI
job or a repo you do not own. Where the two overlap, **the variable wins**.

| Variable | Effect |
|---|---|
| `ORCH_STAGE_TIMEOUT_MS` | Per-stage wall-clock cap in **milliseconds**, overriding `stageTimeout` (which is in minutes). `0` disables the watchdog. |
| `ORCH_DRYRUN` | Set to `1` to force dry-run mode, exactly as if `--dry` had been passed: orch plans the cycle without shelling out to an agent or touching git. |
| `ORCH_PROGRESS_INTERVAL_MS` | How often a running stage prints its "still running" heartbeat. Purely cosmetic; lower it when you are watching a slow stage and want more frequent signs of life. |
| `ORCH_APP_ID`, `ORCH_APP_PRIVATE_KEY` | GitHub App credentials. When both are set, orch mints a short-lived installation token and every `gh` shell-out runs as `orch[bot]` instead of your ambient login. |
| `GH_TOKEN` | Standard `gh` token. Used when App credentials are absent; falls back to your ambient `gh` login if unset. |
| `ORCH_NO_UPDATE_CHECK` | Set to any non-empty value to disable the startup check against the npm registry for a newer `orch`. `NO_UPDATE_NOTIFIER` (the ecosystem-standard spelling) and `CI` have the same effect. Reach for this on an offline or locked-down machine, where the check can only ever fail. |
| `NO_COLOR` | Honoured as usual — suppresses ANSI colour in orch's output. |

Two of these need a word of warning. `ORCH_STAGE_TIMEOUT_MS` and
`stageTimeout` control the same watchdog in different units, and the variable
silently wins — if a timeout you configured appears to do nothing, check the
environment before you suspect the config loader. And `ORCH_DRYRUN=1` left
exported in a shell makes *every* subsequent `orch` command a no-op that still
prints a plausible-looking plan; it is the right tool for a scripted rehearsal
and the wrong thing to leave in a profile.

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
- **"Two cycles I ran at once both ended `merge-deferred` instead of
  merging locally."** Check whether their changed files overlapped
  (`overlap` trigger). If so, **usually you do nothing**: once the blocking
  cycle lands, orch rebases the parked peer onto the new integration tip and
  re-runs the merge and the test gate by itself (§3.4). Wait for the other
  cycle to finish, then look again. Each peer gets one automatic attempt — if
  that fails, or the trigger wasn't `overlap`, the deferral is yours to
  resolve, and it is the correct safety behavior for genuinely overlapping
  work. To avoid the deferral in the first place, give concurrent cycles
  disjoint `--authors`/`--reviewers` and disjoint file scopes.
- **"Why didn't my version get bumped?"** The bump is opt-in: set
  `release.autoBump: true` in `.orch/orch.yml` (it's off by default). Even
  then it only happens on the local integration path (`no-ff`/`ff-only`),
  never under `merge: pr`. A landing outside the local integration path keeps
  the existing package version unless it carries its own release-file change.
  For this repo, the next deliberate release update is made by running
  `node scripts/orch-release.js` by hand.
- **"I ran `orch review` just to get a second opinion, and it merged the
  branch!"** That's correct, and by design (§2.6) — `orch review` skips only
  the *authoring* step; agreement + green tests + a clean security scan still
  merges it, exactly like `orch task` would. If you want a verdict with no
  possibility of a local merge, point `orch pr` at a GitHub PR instead —
  that's the one command in this list that never merges locally.
