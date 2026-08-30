# `orch --help` specification — v0.5.0

> **Draft — not current documentation.** This document describes agent-orch **v0.5.0**, which has not been released. The behaviour it describes is partly unlanded; passages that are not yet true of any release are marked. For the current release, read `README.md` and `docs/orch-manual.md`. Tracking: #509.

**Status:** implementation spec for P12 (issue #528). Not prose, not a tutorial.
Every code block below is the **literal text** the named command must print, so a
test can assert it byte-for-byte. Where a block contains a line that describes
behaviour P12 has not landed yet, the marker sits *outside* the block and the
unlanded rows are tabulated beneath it — the assertable text stays clean.

**Verified against:** `origin/main` at `4345cb6` (`v0.4.361`), `src/schema.js`
(542 lines) and `src/cli.js` (3388 lines), and re-checked against
`origin/orch/integration` at `4fa3163` (`v0.4.362`), which is ahead of `main`.
`src/schema.js` is byte-identical on both branches — integration's only `src/`
changes are in `cli.js`, `config.js`, `config-wizard.js` and `resume.js` — so
every claim below that is derived from the schema holds on both. Every flag set
in this document is *derived* from `COMMANDS` in `src/schema.js` (see §6.1 for
the derivation), not hand-typed, so the spec cannot drift from the parser.

**Terminology** (used consistently, no synonyms): a *cycle* is one author →
cross-audit → test-gate → security-scan → land pass; a *round* is one
author/reviewer exchange inside a cycle (capped by `roundCap`); a *seat* is a
role slot filled by an `<agent> [model] [effort]` spec; a *work order* is the
task text or issue body an author is given; a *remedy* is an automated recovery
action chosen after a classified failure; an *escalation* is orch stopping and
writing `DECISION.md`; *the standing PR* is the persistent
`orch/integration → main` pull request; *landing* is merging a reviewed branch
onto the integration branch.

---

## 1. The problem

### 1.1 One flat `Options:` block claims 26 flags apply to 18 command rows

`orch --help` today prints two flat blocks: 18 command rows and 26 option rows,
with nothing joining them. Measured on the checkout:

```console
$ orch --help | awk '/^Commands:/{f=1;next}/^$/{f=0}f' | wc -l
18
$ orch --help | awk '/^Options:/{f=1;next}/^$/{f=0}f' | wc -l
26
```

(26 rendered rows, not 27: `FLAGS` has 27 keys and `plain` is hidden by
`help: null` because it is documented on the `--once, --plain` row.)

A reader has no way to learn from that page that `--author` is legal on exactly
three commands (`agent`, `task`, `issue`) and refused on the other thirteen —
including `review`, `continue` and `pr`, which run a cycle and so look like they
should take it. The layout asserts a cross product that does not exist.

### 1.2 The mapping exists in the same object the renderer iterates

`renderHelp()` (`src/schema.js:521-542`) is the whole help surface:

```js
export function renderHelp() {
  const commands = Object.values(COMMANDS)
    .flatMap((c) => c.rows)
    .map(([label, desc]) => `  ${pad(label, 22)}${desc}`);
  const options = Object.entries(FLAGS)
    .filter(([, f]) => f.help)
    .map(([name, f]) => `  ${pad(`${f.label || `--${name}`}${f.arg ? ` ${f.arg}` : ""}`, 22)}${f.help}`);
```

It reads `c.rows`. It never reads `c.flags` — even though `COMMANDS[<cmd>].flags`
is a complete, already-declared command→flag mapping sitting in the very object
being iterated, and even though three other consumers in the repo read it:
`COMMAND_FLAGS` (`src/schema.js:224`), `validate()` (`src/schema.js:276`, `:283`)
and `src/completion.js` (`:38`, `:74`).

`validate()` computes exactly the sentence the help refuses to print — but only
inside an *error message*, i.e. only after you guess wrong:

```js
const valid = Object.keys(COMMANDS).filter((c) => COMMANDS[c].flags.includes(name));
throw usageError(
  `--${name} is not valid with 'orch ${effective}'` +
  (valid.length ? ` — only with: ${valid.map((c) => `orch ${c}`).join(", ")}` : " …"),
);
```

Observed (`src/schema.js:283`):

```console
$ orch dashboard --author "codex"
orch: --author is not valid with 'orch dashboard' — only with: orch agent, orch task, orch issue
$ orch task --limit 5
orch: --limit is not valid with 'orch task' — only with: orch dashboard
```

The tool knows. Help is the one place it will not say so.

### 1.3 Scope is smuggled into prose, in three formats, on half the rows

12 of the 26 option rows encode their scope in the description text, using three
different conventions:

```
  --file <file>         With task, read the work order from a JSON file.
  --config-file <file>  Config YAML path; with config / agent add, write there.
  --check               With config, validate; with upgrade, check latest.
  --link                With init, link .orch/ORCH.md from agent docs.
  --build               With agent add, build the adapter without asking.
  --limit <n>           With dashboard, limit history rows.
  --merge               With pr, merge approved PRs.
  --pr                  With agent build, open a PR instead.
  --check-history       Dashboard: show stale red rows resolved (view only).
  --once, --plain       Dashboard: force the static one-shot print.
  --refresh-ms <n>      Dashboard: live TUI poll interval ms (default 1000).
  --json                Print JSON events (dashboard: a snapshot).
```

Three formats for one idea: a `With X,` clause, a `Dashboard:` label, and a
trailing parenthetical. Of the remaining 14 rows, two — `-h, --help` and
`--version` — really are global (`GLOBAL_FLAGS`, `src/schema.js:56`). The other
12 are *equally* command-scoped and carry no hint at all — `--author`,
`--authors`, `--reviewer`, `--reviewers`,
`--cheap`, `--allow-protected`, `--allow-large-scope`, `--dry`, `--no-tidy`,
`--no-banner`, `--detach`, `--until`. `--author` reads as universal and is
rejected by `review`, `continue`, `pr` and every non-cycle command
(`src/schema.js:113-141` strips it from those flag sets, with comments
explaining why).

`--json` is the sharpest case: it documents only its exception. The primary
meaning ("print JSON events") is stated without saying on which commands, and
the parenthetical explains the single command where the shape differs. `config
--json` (`src/schema.js:91`) is undocumented in the row entirely.

`--until` never says what it does: `once (default); ready waits on PR; merged:
readiness.` — three values, three grammars, and `merged: readiness.` is a
truncation, not a sentence. The *Commands* block describes the flag better than
the *Options* block does (`pr <number|branch>  Review a PR/branch; --until
controls readiness.`).

### 1.4 There is no per-command help, and the two ways to ask for it disagree

Verified on the checkout:

```console
$ orch --help > /tmp/g.txt
$ for c in task issue pr dashboard; do orch $c --help | diff -q - /tmp/g.txt; done
   # (no output — all four are byte-identical to the global help, all exit 0)

$ orch help task
orch: 'orch help' takes no arguments — got 1: task
$ echo $?
64

$ orch --help task | diff -q - /tmp/g.txt   # positional silently ignored
$ echo $?
0
```

Two mechanisms produce this. `src/cli.js:1900` routes `--help` ahead of every
command branch:

```js
if (flags.help || command === "help") { printUsage(); return; }
```

and `src/schema.js:392` short-circuits positional validation whenever `--help`
is set:

```js
export function validatePositionals(command, rest, flags) {
  if (flags.help || flags.version) return;
```

So `orch help task` (exit 64, hard refusal, via `POSITIONAL_ARITY.help = [0, 0]`)
and `orch --help task` (exit 0, silent no-op) are the same user intent with
opposite outcomes, and neither says that per-command help does not exist. The
page's own fallback — `Full docs: see .orch/ORCH.md in initialized repos and the
README.` — offloads the deep dive to a file the CLI cannot show you.

### 1.5 Any command-scoped flag next to `--help` produces a nonsense message

`validate()` (`src/schema.js:257`) sets `effective = flags.help ? "help" : …`,
and `COMMANDS.help.flags` is `[]`. So every command-scoped flag becomes invalid
"with `orch help`" — a command the user never typed:

```console
$ orch task "x" --until merged --help
orch: --until is not valid with 'orch help' — only with: orch task, orch issue, orch review, orch continue, orch pr
$ echo $?
64
```

The refusal may be right (§5.5 keeps a version of it), but the message names the
wrong command. It must name the command the user actually typed.

---

## 2. What v0.5.0 changes, in one table

Only the removals and additions that change help text are listed; the full
break list is the migration guide's job.

| Change | Effect on help |
|---|---|
| `orch review <branch>` removed, folded into `orch pr <number\|branch>` | one fewer page; `pr`'s purpose paragraph covers branches |
| `orch agent build` removed, folded into `agent add --build` | one fewer row; `--pr` flag deleted, its behaviour intended to be reachable as `landing: pr` in orch.yml — which needs a one-line rewiring, see §2.1 |
| `orch update` removed (alias of `upgrade`) | the `upgrade, update` row becomes `upgrade` |
| `--merge` removed (use `--until merged`) | one fewer flag row on `pr` |
| `--no-banner` removed with the banner itself | one fewer flag row on `task` and `issue` (it was never on `pr` or `continue`, and `review`'s page goes away) |
| interactive `config` wizard removed | `config`'s purpose paragraph is now "print the effective config" |
| `--dry` rejected on read-only `config` | one fewer flag row on `config` |
| `--max-attempts <n>` added | one new flag row wherever `--until` is legal |
| bare run commands mean `--until ready` | the `--until` row's stated default flips from `once` to `ready` |

Counting: `COMMANDS` has 16 keys today; `review` and `update` leave, so v0.5
ships **14 help pages** (`§4.1`–`§4.14`), one per surviving `COMMANDS` key.

### 2.1 Rows in this spec that P12 has not landed yet

> **Not yet landed** (P12, #528). Everything in this table is written into the
> help text below as the v0.5 contract; on the current checkout the behaviour
> still differs as noted.

| Line in the spec | Today on `4345cb6` |
|---|---|
| `--until <goal>` default `ready` | default is `once` (`src/cli.js:2121`, `:2911`) |
| `--max-attempts <n>` row | flag does not exist in `FLAGS`; only the config key `automation.maxAttempts` (`src/cli.js:2136`) |
| `config` page has no `--dry` row | `COMMANDS.config.flags` still contains `dry` (`src/schema.js:91`) |
| `config` purpose: "prints the effective config" | bare `orch config` still opens the wizard on a TTY |
| no `pr --merge`, no `agent build`, no `orch update`, no `--no-banner` | all four still exist |
| `agent add --build` honours `landing: pr` (§4.3) | `noMerge: !flags.pr` (`src/cli.js:1816`) returns before `cfg.landing` is read, so today `--pr` is the only thing that makes a build open a PR; #528 must rewire the expression or the clause documents a no-op |
| per-command help exists at all | every `orch <cmd> --help` prints the global page (§1.4) |
| `continue --until ready\|merged` (§4.7's `--until` row) | the *typed* flag is refused with exit 64 (`src/schema.js:292`): "`--until ready` is not yet available with 'orch continue' — only `--until once` (the default)". Only the explicit override is blocked: **inheritance already works**, so a resume of a run whose record carries `policy.until` of `ready` or `merged` reaches the run controller today, and §4.7's exit-2/exit-4 resume paragraph is live |
| `completion install` failure exits 1 (§4.12) | exits **0** and prints the reason on **stdout** (`src/cli.js:3283-3290`; `installCompletion` swallows the error into `{ok:false, reason}`, `src/completion.js:308-321`). Probed with a read-only `$HOME`: `orch: could not install completion script (EACCES …)`, exit 0. Two defects in one line — the missing gate and the error text on stdout |

Everything else in this document — the exit codes 0/1/2/3/4/64
(`src/run-controller.js:11`), the `--limit` default of 10 (`src/cli.js:3297`),
the `--refresh-ms` default of 1000 (`src/cli.js:3307`), the per-command flag
sets, the streams — is true of the checkout today and must stay true.

Every row above was re-checked against `origin/orch/integration` (`4fa3163`,
`v0.4.362`) and none of them has landed there either: that branch changes
`src/cli.js`, `src/config.js`, `src/config-wizard.js` and `src/resume.js` only,
leaving `src/schema.js` untouched, so the parser-side rows (`--dry` on `config`,
`continue --until`, the surviving `--merge`/`agent build`/`update`/`--no-banner`)
are unchanged, and its `cli.js` edits are confined to #532's rotating
author/reviewer pools.

---

## 3. Layout rules the text obeys

These are the rules #528 implements; they are what make the literal blocks below
reproducible rather than hand-drawn.

1. **Two columns.** Two spaces of indent, label left-padded to 24 characters,
   description starting at column 27. Total line width ≤ 88. A description
   longer than one line continues at column 27.
2. **Commands are grouped by purpose**, with a blank line and a group heading
   between groups: *Set up a repo*, *Run a cycle*, *Review and land*, *Operate*,
   *Maintain*. Order is workflow order, not alphabetical: a newcomer reads
   top-down and needs `init` before `task`.
3. **Global help lists global flags only.** `GLOBAL_FLAGS` is `["help",
   "version"]` (`src/schema.js:56`) — the two flags that describe the tool
   rather than run it. Every other flag belongs to at least one command and
   appears **only** on that command's page. This is the fix for §1.1: the global
   page can no longer imply a cross product, because it lists no command-scoped
   flag at all.
4. **A flag row never states its scope.** Scope is the page it is on. Every
   `With X,` / `Dashboard:` / parenthetical convention from §1.3 is deleted.
5. **A flag row states its default** in a trailing `(default: …)`, or nothing if
   there is no default.
6. **Descriptions are imperative and say what the flag does**, never only what
   it does differently somewhere else. `--json` on `task` and `--json` on
   `dashboard` therefore carry *different* text — see §6.2 for the per-command
   override mechanism that makes that possible without duplicating every row.
7. **Exit codes are per page**, listing the subset that command can actually
   produce — not a copy of the full table. A caller scripting `orch config
   --check` should not have to reason about exit 4.
8. **Every page ends with one or two runnable examples**, and every example in
   every page must parse (§6.4 test 6). "Parse" constrains how an example may
   be written: it is a bare `orch …` invocation and nothing else — no
   redirection, no pipe, no `&&`, because test 6 tokenizes an example as argv
   and never hands it to a shell. Shell plumbing worth mentioning goes in the
   page's prose instead (see §4.12, and test 6 for the mechanism).
9. **`orch --help` goes to stdout and exits 0. A usage error goes to stderr and
   exits 64.** Verified today: `orch --help 2>&1 1>/dev/null` is empty, and
   `orch bogsu 2>/dev/null` prints nothing (`bin/orch.js:5,9` use
   `console.error`).

### 3.1 The em-dash and the tool description

The first line becomes the proposal's wording (`docs/cli-v2-proposal.md:240`),
which names the four stages instead of the old comma list:

```
orch — author, cross-audit, test-gate and land a change with coding agents.
```

---

## 4. The literal help texts

### 4.0 `orch --help` / `orch help` / `orch` with no command

> **Not yet landed** (P12, #528) — see §2.1 for the individual rows.

```
orch — author, cross-audit, test-gate and land a change with coding agents.

Usage: orch <command> [options]
       orch <command> --help    Flags, arity and examples for one command.

Set up a repo:
  init                    Write a commented .orch/orch.yml and .orch/ORCH.md.
  config                  Print the effective, validated config.
  agent add <name>        Add an agent to the rotation pool.

Run a cycle:
  task "change"           Author, cross-audit, test-gate and land one change.
  issue <number>          The same, from a GitHub issue; closes it on landing.

Review and land:
  pr <number|branch>      Audit a pull request or a branch; repair or merge it.
  continue <sid>          Resume an interrupted cycle or a stopped run.

Operate:
  dashboard               Live status TUI; --once prints a static snapshot.
  mcp                     Serve orch as an MCP server over stdio.

Maintain:
  release "entry"         Bump version + CHANGELOG by hand (autoBump repos).
  upgrade                 Self-update the global npm install.
  completion              Print or install the bash completion script.
  version                 Print the version.
  help [command]          This page, or one command's page.

Options (valid on every command):
  -h, --help              Show this page, or the named command's page.
  --version               Print the version.

Every other flag belongs to a command: run `orch <command> --help` to see it.

Exit codes:
  0   the goal was reached and verified
  1   internal error (orch bug, or the environment failed)
  2   stopped at the attempt cap — resume with `orch continue <runId>`
  3   blocked: a human must decide (guardrail, security floor, protection)
  4   asked a human and got no answer in automation.humanWaitHours
  64  usage error (unknown command, wrong flag for the command, bad value)

Examples:
  orch init --link
  orch task "add input validation" --reviewer "codex"
  orch issue 42 --until merged
  orch pr 42 --until once

Full docs: .orch/ORCH.md in an initialized repo, and the README.
```

Notes for the implementer:

- The `Options (valid on every command):` heading and the sentence beneath it
  are the load-bearing part of this page. They replace the 26-row block, and
  the sentence is what stops a reader concluding that orch simply lost its
  flags.
- `completion` renders as a single row here; its two subcommand forms live on
  its own page (§4.12). Today it renders two rows (`src/schema.js:159-167`),
  which is what pushes the widest label past the column width.
- `help [command]` documents the new alias (§5.1) on the page a user is already
  reading when they need it.

### 4.1 `orch init --help`

```
orch init — write .orch/orch.yml and .orch/ORCH.md into this repo.

Usage: orch init [options]

Writes a fully commented .orch/orch.yml (every key with its default and a note
on what it does) plus .orch/ORCH.md, the short usage file agents and humans
read from inside the repo. The config is written only if neither .orch/orch.yml
nor a repo-root orch.yml already exists, so your settings survive a re-run;
.orch/ORCH.md is rewritten every time, so do not hand-edit it. This is the only
setup step: orch reads config from .orch/orch.yml and needs nothing else.

Options:
  --link                  Link .orch/ORCH.md from the agent doc files
                          (CLAUDE.md, AGENTS.md) so an agent finds it.
  --config-file <path>    Write to this YAML path instead of .orch/orch.yml.
  --dry                   Print what would be written; write nothing.

Arguments: none.

Exit codes: 0 written · 1 could not write · 64 usage error.

Examples:
  orch init
  orch init --link
```

The overwrite asymmetry in that paragraph is the landed behaviour, not a wish:
`src/cli.js:1997-2000` guards only the config
(`if (!existsSync(ex) && !existsSync(join(repo, "orch.yml"))) writeFileSync(ex, SCAFFOLD)`)
and then calls `writeFileSync(join(orchDir, "ORCH.md"), ORCH_DOC)`
unconditionally. orch's own `--dry` line already says so
(`src/cli.js:1982`): `would write …/orch.yml (only if absent) and …/ORCH.md
(overwrites)`. A help page that promised "existing files are never
overwritten" would contradict the dry-run output of the same command.

### 4.2 `orch config --help`

> **Not yet landed** (P12, #528): bare `orch config` still opens the interactive
> wizard on a TTY, and `--dry` is still accepted (`src/schema.js:91`).

```
orch config — print the effective, validated configuration.

Usage: orch config [options]

Prints every setting orch will actually use for a run in this repo, with the
source of each value: a built-in default, .orch/orch.yml, or a file layered on
with --config-file. Reading it answers "why did that run pick that reviewer"
without reading the code. --check turns it into a gate: it validates instead of
printing, and exits 1 listing every unknown key. A key v0.5 renamed or removed
is listed under Warnings, with the rename to make, and does not fail the gate.
The schema is closed in v0.5 — an unrecognised key is an error, not silence, so
a typo like `roudCap` is reported instead of ignored.

Options:
  --check                 Validate only; exit 1 and list problems.
  --json                  Print the report as one JSON object.
  --config-file <path>    Layer this YAML file over .orch/orch.yml.

Arguments: none.

Exit codes: 0 valid · 1 invalid config (--check) · 64 usage error.

Examples:
  orch config
  orch config --check
```

The warning/problem split is landed behaviour and the page must not overstate
it: `collectConfigIssues` routes every `REMOVED_CONFIG_MESSAGES` hit — `merge`,
`main.autoMerge`, `github.autoMergePr`, `main.conflictResolution`,
`main.autoResolveConflicts`, `main.conflictResolutionResolvers`,
`main.autoResolveConflictPaths` (`src/config.js:71-79`) — into `warnings` and
`continue`s (`src/config.js:114-117`). `problemList` (`src/config.js:143-149`)
collects unknown keys and load errors — never a removed-key message — and
`--check`'s exit is
`report.ok ? 0 : 1` off problems alone (`src/cli.js:1943`), with the two
sections printed separately (`src/cli.js:1443-1450`). Probed: an orch.yml
holding `merge: ff-only` plus `main.autoMerge: true` prints two Warnings and
exits **0** under `--check` (a *bad value* under `merge:` still fails, but on
value validation, not on the key being removed). If v0.5 wants
removed keys to be a hard error, that is a behaviour change needing its own
§2.1 row — it is not something this help text can assert into existence.

### 4.3 `orch agent add --help`

> **Not yet landed** (P12, #528): `orch agent build <name>` still exists as its
> own subcommand, and `--pr` is still a flag.

The heading names what a user types, but the *page* is keyed by the `COMMANDS`
key, which is `agent` — one entry with two subcommands, split only by
`SUBCOMMAND_FLAGS` (`src/schema.js:72-75`, `:94-100`). So `orch agent --help`
and `orch agent add --help` render this same page, `renderHelp("agent")`, under
the fixture name `agent.txt` (§6.4 test 1 iterates `Object.keys(COMMANDS)`);
while `agent build` still exists, `orch agent build --help` resolves here too.

```
orch agent add — add an agent to the rotation pool.

Usage: orch agent add <name> [options]

Appends <name> to the `agents:` list in .orch/orch.yml, which is the pool the
author and reviewer seats rotate through. If orch has no adapter for <name>,
`add` alone changes nothing but the config; pass --build to scaffold the
adapter through a normal cycle — orch writes its own integration code with the
same author, cross-audit and test-gate path any other change goes through. A
name orch already has an adapter for never builds, with or without --build.

A build never merges, under any landing: value. An agreed and green adapter
stays on its branch for a human to read and land, because code orch wrote that
orch will then run as an agent gets a human checkpoint. With landing: pr that
branch is opened as a pull request instead of left bare; it is still yours to
merge.

Options:
  --build                 Scaffold a missing adapter through a cycle.
  --config-file <path>    Read and write this YAML path.
  --dry                   Print the edit and the plan; change nothing.

Only with --build:
  --author <spec>         Author seat as "<agent> [model] [effort]".
  --authors <a,b>         Comma-separated author seats.
  --reviewer <spec>       Reviewer seat as "<agent> [model] [effort]".
  --reviewers <a,b>       Comma-separated reviewer seats.
  --allow-large-scope     Sanction a deliberately large review slice.

Arguments: exactly one <name>, after the `add` subcommand word.

Exit codes: 0 added · 1 error · 2 the build stopped at the attempt cap ·
3 the build is blocked and needs a human · 64 usage error.

Examples:
  orch agent add codex
  orch agent add mynewagent --build --author "claude" --reviewer "codex"
```

The `Only with --build:` group is not decoration — it is the existing rule in
`validateAgentArgs` (`src/schema.js:453-503`), which refuses those flags on an
`add` that will not build. The group's membership is itself derived:
`AGENT_BUILD_ONLY_FLAGS` (`src/schema.js:194-196`) is `agent build`'s flag set
minus `agent add`'s, which today is `--pr` plus the four role overrides plus
`--allow-large-scope`, and becomes those five once `--pr` goes:

```console
$ orch agent add claude --reviewer "codex"
orch: --reviewer is not valid with 'orch agent add claude' — claude already has an adapter, so no build runs …
```

Rendering them as a second group is the first time that rule is visible before
you break it.

The "a build never merges" paragraph is today's behaviour, kept on purpose
rather than harmonised away. `buildAgent` sets `noMerge: !flags.pr`
(`src/cli.js:1816`) with the reason written above it (`src/cli.js:1766-1771`):
"the result sits on its local branch only (no PR, main untouched) so it can be
reviewed before it's trusted". v0.5 deletes `--pr`, and the tempting reading of
that deletion is that the build now follows `landing:` like any other cycle.
It does not: the flag goes, the no-merge default stays, and only the choice
between *a bare branch* and *an open pull request* moves into config.
`landing: pr` survives v0.5 as a legal enum value (`src/config.js:174-175`
validates `ff-only|no-ff|pr`), so a repo that wants the old `--pr` behaviour
sets it there — which is exactly what the migration guide's row for the removed
flag tells the reader to do. This is the one command whose output orch itself
later runs as an agent, so the human checkpoint is a security default, not an
ergonomic accident.

**#528 must rewire one line for that sentence to be true.** `noMerge: !flags.pr`
is an early return in `src/engine.js` that never reaches the code reading
`cfg.landing`, so `--pr` is currently the only thing that makes a build open a
PR at all. Delete the flag and leave the expression alone and the page's
`landing: pr` clause documents a no-op. `noMerge: cfg.landing !== "pr"` keeps
the build off the integration branch in every case while honouring the config
value. Until that lands, the clause is a §2.1 row like any other.

### 4.4 `orch task --help`

> **Not yet landed** (P12, #528): the default is still `--until once`, and
> `--max-attempts` does not exist yet.

```
orch task — run one change through a cycle.

Usage: orch task "<change>" [options]
       orch task --file <work-order.json> [options]

One cycle is: an author agent writes the change on its own branch in an
isolated git worktree (a second checkout of the same repository, so concurrent
runs never fight over one HEAD), a different agent cross-audits the diff, the
test gate runs, a deterministic security scan runs, and the reviewed commit
lands on the integration branch. With --until ready or merged the cycle repeats
under a remedy ladder — rebase + repair, rotate seats, reauthor, ask a human —
offering whichever of those the failure calls for, until the goal is reached or
the attempt cap is spent.

Options:
  --until <goal>          What this run pursues: once, ready or merged.
                          once  = a single cycle, then report.
                          ready = loop until the pull request for this change
                                  is green and mergeable; never merge it.
                          merged = also merge the standing PR.
                          (default: ready)
  --max-attempts <n>      Remedy attempts after the first cycle.
                          (default: automation.maxAttempts, 3)
  --author <spec>         Author seat as "<agent> [model] [effort]".
  --authors <a,b>         Comma-separated author seats; each gets a branch.
  --reviewer <spec>       Reviewer seat as "<agent> [model] [effort]".
  --reviewers <a,b>       Comma-separated reviewer seats.
  --cheap                 Fill both seats from cheap.role in orch.yml.
  --file <path>           Read the work order from a JSON file, treating it as
                          untrusted input; takes no positional text.
  --allow-protected       Run even though the work order names a guardrail
                          path. The intake scan is textual, so this is for an
                          incidental mention; a real guardrail change still
                          escalates at the security floor.
  --allow-large-scope     Sanction a deliberately large review slice.
  --no-tidy               Keep the task branch and worktree after landing.
  --detach                Run in the background; print pid, log and runId.
  --dry                   Plan only: no agent runs, nothing is written.
  --json                  Print one JSON event per line; no prose.
  --config-file <path>    Layer this YAML file over .orch/orch.yml.

Arguments: the change text. Unquoted words are joined with spaces, so
`orch task add input validation` is the same work order as the quoted form.
With --file, no positional text is allowed — the file is the work order.

Exit codes: 0 goal reached · 1 internal error · 2 stopped at the attempt cap ·
3 blocked, a human must decide · 4 asked a human, no answer in time ·
64 usage error.

Examples:
  orch task "add input validation" --until once
  orch task --file work-order.json --cheap
```

Three things that page's rows deliberately compress. None of them adds a row:
§3 rule 6 asks a flag row to say what the flag does, and everything below is
either config (`orch config`'s page) or an interaction between two features that
no single row owns. Each is documented in full in the manual; what matters here
is only that the chosen wording is not accidentally stronger than the code.

**`--allow-large-scope` is advisory**, which is why its row says *sanction*, not
*allow*. Its entire effect is one substitution into the reviewer's prompt
(`src/adapters/cli-adapter.js:587` → `src/prompts/review.md:5`), lifting the
standing instruction that a diff bundling "more than ~3 logical changes" is on
its own grounds to reject. Nothing counts the changes, nothing refuses the run,
and a reviewer remains free to reject a sprawling diff anyway. Do not word the
row as an enforcement flag. It survives v0.5 unchanged, on every page whose
command declares it: §4.3 (build only), §4.4, §4.5, §4.6 and §4.7.

**The remedy list has no single fixed order**, which is why the paragraph says
"whichever of those the failure calls for" rather than naming a sequence.
`automation.remedies` defaults to `null` (`src/config.js:60`), meaning "use the
failure table's order", and that table is keyed by failure class (`REMEDY_TABLE`,
`src/failure.js`) — `TEST_RED` offers all four, `SCOPE_EXCEEDED` offers
`reauthor, ask`, `TEST_MISSING` offers only `ask`. An operator list is a
*priority*, not a sequence, and it is subtractive: a class left with nothing to
try falls to `terminalDecision`, i.e. exit 2, rather than reaching exit 4. The
page must not imply a fixed four-step ladder.

**Pinning a model does not opt a seat out of model rotation**, so no row may
imply that `--author "claude claude-opus-5 high"` freezes the seat. When
`rotate` fires, `automation.rotateModels[claude]` is walked from the entry
*after* the pinned one (`nextModelRole`, `src/remedies.js:175-188`; #567's
wiring landed on `main` in `d8c0c7e`, so this is current behaviour, not
integration-only). One sharp edge, since it turns a config typo into silence:
a pinned model absent from its agent's ladder returns the same `null` as an
exhausted ladder, and the agent is then excluded by name on its next failure —
exactly as if no ladder had been configured.

### 4.5 `orch issue --help`

> **Not yet landed** (P12, #528): the default is still `--until once`, and
> `--max-attempts` does not exist yet.

```
orch issue — run a cycle from a GitHub issue.

Usage: orch issue <number> [options]

Fetches issue <number> with `gh`, uses its body as the work order, and runs the
same cycle as `orch task`. The landing commit carries `Closes #<number>`, so
GitHub closes the issue when the change reaches the base branch. The issue body
is the whole brief an author agent gets — comments on the issue are not read —
so a thin body is the usual reason a cycle escalates. A work order whose text
names a guardrail path is refused at intake, before any agent runs; pass
--allow-protected when the mention is incidental.

Options:
  --until <goal>          What this run pursues: once, ready or merged.
                          once  = a single cycle, then report.
                          ready = loop until the pull request for this change
                                  is green and mergeable; never merge it.
                          merged = also merge the standing PR.
                          (default: ready)
  --max-attempts <n>      Remedy attempts after the first cycle.
                          (default: automation.maxAttempts, 3)
  --author <spec>         Author seat as "<agent> [model] [effort]".
  --authors <a,b>         Comma-separated author seats; each gets a branch.
  --reviewer <spec>       Reviewer seat as "<agent> [model] [effort]".
  --reviewers <a,b>       Comma-separated reviewer seats.
  --cheap                 Fill both seats from cheap.role in orch.yml.
  --allow-protected       Run even though the work order names a guardrail
                          path. The intake scan is textual, so this is for an
                          incidental mention; a real guardrail change still
                          escalates at the security floor.
  --allow-large-scope     Sanction a deliberately large review slice.
  --no-tidy               Keep the task branch and worktree after landing.
  --detach                Run in the background; print pid, log and runId.
  --dry                   Plan only: no agent runs, nothing is written.
  --json                  Print one JSON event per line; no prose.
  --config-file <path>    Layer this YAML file over .orch/orch.yml.

Arguments: exactly one issue number, digits only.

Exit codes: 0 goal reached · 1 internal error · 2 stopped at the attempt cap ·
3 blocked, a human must decide · 4 asked a human, no answer in time ·
64 usage error.

Examples:
  orch issue 42
  orch issue 42 --until merged --reviewer "codex gpt-5.6-sol high"
```

### 4.6 `orch pr --help`

> **Not yet landed** (P12, #528): `orch review <branch>` still exists as a
> separate command, `--merge` is still accepted, the default is still
> `--until once`, and `--max-attempts` does not exist yet.

```
orch pr — audit a pull request or a branch, and repair or merge it.

Usage: orch pr <number|branch> [options]

Takes a GitHub PR number or a local/remote branch name and runs the cycle in
review mode: no author writes a new change first, a reviewer agent audits what
is already there, and the test gate and security scan run on that diff. This
is the command that absorbed `orch review <branch>` — auditing a branch and
auditing a pull request were always the same cycle, so v0.5 spells them the
same way. --until once audits and reports; ready repairs the head until GitHub
says it is green and mergeable; merged also merges it, but only after reading
mergeability and check status back for the exact head being merged. A draft
pull request is not ready by definition, so ready and merged both refuse one —
reporting `pr #<n> is a draft` — instead of marking it ready or undrafting it.

Options:
  --until <goal>          What this run pursues: once, ready or merged.
                          once  = audit once and report; change nothing.
                          ready = repair the head until it is green and
                                  mergeable; never merge it.
                          merged = merge it once readiness is verified.
                          (default: ready)
  --max-attempts <n>      Remedy attempts after the first cycle.
                          (default: automation.maxAttempts, 3)
  --reviewer <spec>       Reviewer seat as "<agent> [model] [effort]".
  --reviewers <a,b>       Comma-separated reviewer seats.
  --allow-large-scope     Sanction a deliberately large review slice.
  --detach                Run in the background; print pid, log and runId.
  --dry                   Plan only: no agent runs, nothing is written.
  --json                  Print one JSON event per line; no prose.
  --config-file <path>    Layer this YAML file over .orch/orch.yml.

Arguments: exactly one PR number or branch name.

There is no --author here: this command audits work that already has an author.
Accepting the flag and ignoring it is exactly the silence the v0.5 schema
exists to remove.

Exit codes: 0 goal reached · 1 internal error · 2 stopped at the attempt cap ·
3 blocked, a human must decide · 4 asked a human, no answer in time ·
64 usage error.

Examples:
  orch pr 42 --until once
  orch pr pr/claude/add-retry --reviewer "codex"
```

The draft sentence is landed behaviour, not a wish, and it is deliberately one
predicate rather than two. `ready` and `merged` read the same readiness
inspector, and its first structural check treats a draft exactly like a closed
PR: `if (data.state !== "OPEN" || data.isDraft)` returns
`{ ready: false, class: "REMOTE_PR_CLOSED", summary: "pr #<n> is a draft" }`
(`src/readiness.js:63-64`), and the merge path repeats the same test before
touching anything (`src/landing.js:136-137`). `REMOTE_PR_CLOSED`'s only remedy
is `ask` (`src/failure.js:133`), so the run stops and puts that sentence in
front of a human rather than retrying a state no remedy can change. A second,
looser predicate for `merged` — "merge it, and mark it ready on the way" —
would have to decide on its own whether to undraft someone else's PR. Refusing
is the smaller claim: a draft means the author is not finished, and orch does
not overrule that.

### 4.7 `orch continue --help`

> **Not yet landed** (P12, #528): `--max-attempts` does not exist yet, and a
> *typed* `--until ready|merged` is refused on `continue` with exit 64
> (`src/schema.js:292-294`) — `orch continue abc123 --until ready` prints
> "`--until ready` is not yet available with 'orch continue' — only `--until
> once` (the default)". Only that override is blocked. Inheritance of the
> recorded goal is already live, so the exit-2 / exit-4 resume paragraph below
> describes today's behaviour; what P12 adds is the ability to *ask* for a
> different goal on the resume line. See §2.1.

```
orch continue — resume an interrupted cycle or a stopped run.

Usage: orch continue <sid> [options]

Every cycle writes a checkpoint keyed by its sid (the run's short id, printed
when the run starts and listed by `orch dashboard`). `continue` reads that
checkpoint and picks the cycle up where it stopped instead of starting over,
so a run killed mid-review does not re-author the change. A run that ended at
the attempt cap (exit 2) or waiting on a human (exit 4) resumes here too, with
a fresh attempt budget. The seats, work order and goal are taken from the
record: a bare `orch continue <sid>` on a run started with --until merged
keeps pursuing merged, not the default a fresh run would get. A flag given
here overrides the recorded value for this resume only.

Options:
  --until <goal>          What this resume pursues: once, ready or merged.
                          (default: the goal recorded for the run)
  --max-attempts <n>      Remedy attempts after the first cycle.
                          (default: automation.maxAttempts, 3)
  --reviewer <spec>       Reviewer seat as "<agent> [model] [effort]".
  --reviewers <a,b>       Comma-separated reviewer seats.
  --allow-large-scope     Sanction a deliberately large review slice.
  --no-tidy               Keep the task branch and worktree after landing.
  --detach                Run in the background; print pid, log and runId.
  --dry                   Plan only: no agent runs, nothing is written.
  --json                  Print one JSON event per line; no prose.
  --config-file <path>    Layer this YAML file over .orch/orch.yml.

Arguments: exactly one sid. A sid never contains '/', '..' or a NUL byte —
it is used directly as a store key, so anything else is refused.

There is no --author here: the commits being resumed were written by a specific
agent, and this command continues that run rather than starting a new one.

Exit codes: 0 goal reached · 1 internal error · 2 stopped at the attempt cap ·
3 blocked, a human must decide · 4 asked a human, no answer in time ·
64 usage error.

Examples:
  orch continue 1a2b3c4d
  orch continue 1a2b3c4d --reviewer "claude claude-opus-5 high"
```

The inherited goal is the whole point of the command, so it is worth being
explicit about which of the two readings v0.5 takes. A resume is a
continuation, not a new run: whatever `--until` the original run was launched
with is what a bare `orch continue <sid>` keeps pursuing, and the global
`ready` default never overrides a recorded `merged` or a recorded `once`. An
explicit `--until` on the continue wins over the record, for that resume only,
and is journaled as a policy change. The landed expression of this reading is
already in the code — `until: flags.until || priorRun?.policy?.until || "once"`
(`src/cli.js:2911`), the flag first, the record second, the constant last — and
`docs/cli-v2-design.md` §5.3's "all other flags are taken from the record" says
the same for the seats. What P12 changes is the constant at the end of that
chain and the fact that a `ready|merged` goal can be *typed* here at all — it is
already reachable by inheritance; the precedence itself does not move. Note the
divergence this settles: for a run started `--until once`, the recorded-goal
reading resumes as `once`, while a "global default" reading would
silently promote a one-shot run into a loop.

### 4.8 `orch release --help`

```
orch release — write the version bump and CHANGELOG entry by hand.

Usage: orch release "<changelog entry>" [options]

A clean cycle does this bookkeeping itself when it lands, but only in repos
that set release.autoBump: true. When such a cycle escalates and a human
merges the branch instead, that step never runs — this command performs it
alone, in the dedicated integration worktree, on the integration branch. It
always bumps and never consults release.autoBump. It writes no git tag:
tagging is CI's job.

Options:
  --dry                   Print the bump and the entry; write nothing.

Arguments: the changelog entry text. Unquoted words are joined with spaces.

Exit codes: 0 written · 1 the worktree was dirty, on the wrong branch, or the
bump failed · 64 usage error.

Examples:
  orch release "hand-landed guardrail fix (closes #123)"
  orch release "hand-landed guardrail fix" --dry
```

### 4.9 `orch dashboard --help`

```
orch dashboard — show live cycle status, run history and metrics.

Usage: orch dashboard [options]

Reads .orch/ — the inflight registry, the run records and runs.jsonl — and
renders what is running now, the tail of the current log, recent runs and their
outcomes. On an interactive terminal it opens a live TUI that repaints on a
timer; anywhere else (piped, redirected, --json, --once) it prints one static
snapshot and exits, so it is safe in a script. It only reads: nothing here
changes a run.

Options:
  --json                  Print one JSON snapshot instead of the TUI.
  --limit <n>             History rows to show. (default: 10)
  --check-history         Show stale red rows as resolved when their branch is
                          gone. View only — runs.jsonl is not rewritten.
  --once, --plain         Print the static one-shot instead of the TUI.
  --refresh-ms <n>        TUI repaint interval in ms. (default: 1000)

Arguments: none.

Exit codes: 0 rendered · 1 .orch/ could not be read · 64 usage error.

Examples:
  orch dashboard
  orch dashboard --json --limit 5
```

### 4.10 `orch mcp --help`

```
orch mcp — serve orch as an MCP server over stdio.

Usage: orch mcp

Speaks the Model Context Protocol on stdin/stdout so an AI client can run
cycles as tools instead of shelling out. Because stdout is the protocol
transport here, nothing else may print on it — this command deliberately
skips the update banner every other command may show. Each cycle the server
spawns authenticates on its own. The server runs until stdin closes.

Options: none.

Arguments: none.

Exit codes: 0 the client disconnected · 1 the transport failed ·
64 usage error.

Example:
  orch mcp
```

### 4.11 `orch upgrade --help`

> **Not yet landed** (P12, #528): `orch update` is still accepted as an alias.

```
orch upgrade — self-update the global npm install.

Usage: orch upgrade [options]

Compares the running version against the published one and reinstalls the
global package when it is behind. --check only reports the comparison and
installs nothing, which is what a scripted or scheduled caller wants. `orch
update` was a second spelling of this command and is removed in v0.5.

Options:
  --check                 Report the latest version; install nothing.
  --dry                   Print the install command; run nothing.

Arguments: none.

Exit codes: 0 up to date or upgraded · 1 the check or the install failed ·
64 usage error.

Examples:
  orch upgrade --check
  orch upgrade
```

### 4.12 `orch completion --help`

> **Not yet landed** (P12, #528): the `1 could not write the script` leg below
> is the v0.5 contract, not today's behaviour. A failed install currently
> reports the reason on **stdout** and exits **0** (`src/cli.js:3283-3290`,
> `src/completion.js:308-321`), so a scripted caller gets no gate. The exit
> code is written as 1 here on purpose: documenting exit 0 would enshrine a
> gate a scripted caller does not get, and put an error on stdout against §3
> rule 9's stream discipline.
> Contrast `upgrade`, which does set `process.exitCode = 1`
> (`src/upgrade.js:73`) — this is a one-command asymmetry, not a house style.
> See §2.1; it is worth a defect issue of its own.

```
orch completion — print or install the bash completion script.

Usage: orch completion [bash]
       orch completion install [--dry]

The completion script is generated from the same command schema that drives
parsing and this help, so tab-completion can never offer a command or flag the
parser would refuse. `orch completion` (or `orch completion bash`) prints the
script to stdout; `orch completion install` writes it to ~/.orch/completion.bash
and tells you the line to add to ~/.bashrc. Because the plain form only writes
to stdout, you can redirect it wherever your shell looks for completions —
`> /etc/bash_completion.d/orch` for a system-wide install.

Options:
  --dry                   With `install`: print the path; write nothing.
                          Refused on the plain form, which never writes.

Arguments: at most one target, `bash` or `install`. Default: bash.

Exit codes: 0 printed or installed · 1 could not write the script ·
64 usage error.

Examples:
  orch completion install
  orch completion bash
```

### 4.13 `orch version --help`

```
orch version — print the version.

Usage: orch version

Prints the installed version, the same string as `orch --version`.

Options: none.

Arguments: none.

Exit codes: 0 printed · 64 usage error.

Example:
  orch version
```

### 4.14 `orch help --help`

```
orch help — show this help.

Usage: orch help [command]

With no argument, prints the command list, the global options and the exit
codes. With a command name, prints that command's page — `orch help task` and
`orch task --help` are the same thing, and print the same bytes.

Options: none.

Arguments: at most one command name.

Exit codes: 0 printed · 64 unknown command name.

Examples:
  orch help
  orch help pr
```

---

## 5. Behavioural rules

### 5.1 `orch help <command>` becomes an alias for `orch <command> --help`

Three spellings, one page, byte-identical output, exit 0:

**Before (v0.4.x)**
```console
$ orch help task
orch: 'orch help' takes no arguments — got 1: task
$ echo $?
64
```

**After (v0.5.0)**
```console
$ orch help task | diff - <(orch task --help) && echo same
same
$ orch help task | diff - <(orch --help task) && echo same
same
```

**Why** — `orch help task` and `orch task --help` are one intent. Today one is a
hard refusal at exit 64 (`POSITIONAL_ARITY.help = [0, 0]` driving
`src/schema.js:399`) and the other a silent no-op at exit 0 (the positional is
dropped by the `flags.help` short-circuit at `src/schema.js:392`). Making all
three routes resolve to the same render function removes the asymmetry and gives
the global page's `help [command]` row something real to point at.

Implementation: `POSITIONAL_ARITY.help` becomes `[0, 1]`, and `orch help <x>`
with an unrecognised `<x>` reuses the existing unknown-command wording verbatim
(`src/cli.js:1892`):

```console
$ orch help taks
orch: unknown command: taks (run 'orch help' for usage)
$ echo $?
64
```

### 5.2 Per-command help replaces the global page

**Before (v0.4.x)**
```console
$ orch pr --help | head -1
orch - Run coding agents in an author, review, test, and merge loop.
```

**After (v0.5.0)**
```console
$ orch pr --help | head -1
orch pr — audit a pull request or a branch, and repair or merge it.
```

**Why** — the mechanism is a one-line routing change at `src/cli.js:1900`, which
today discards the command word before rendering. Passing that word to the
renderer is what turns `COMMANDS[<cmd>].flags` — already declared, already read
by the parser, the validator and bash completion — into documentation instead of
an error message you can only reach by guessing wrong (§1.2).

### 5.3 `--help` still exits 0 and still short-circuits positional validation

Unchanged, and both are load-bearing:

- `orch --help`, `orch help`, `orch <cmd> --help` and bare `orch` all print to
  **stdout** and exit **0**. Help is a successful outcome; a CI step that runs
  `orch --help` as a smoke test must not fail.
- `validatePositionals` keeps its first line (`src/schema.js:392`):

  ```js
  if (flags.help || flags.version) return;
  ```

  so `orch issue --help` prints issue's page rather than dying on the missing
  `<number>`. Asking what a command's arguments are must not require supplying
  them. The one change is that `help` itself may now carry one positional
  (§5.1), which is validated inside the help route, not here.

### 5.4 Unknown commands and unknown help targets

An unrecognised command word is a usage error, not a help request, and the
distinction is what protects scripted callers: exiting 0 for a typo tells cron
the run succeeded when nothing ran.

```console
$ orch taks "x"
orch: unknown command: taks (run 'orch help' for usage)
$ echo $?
64
```

Rules:

- Message and exit are unchanged from the checkout (`src/cli.js:1892`, exit 64
  via `usageError`).
- The text goes to **stderr** (`bin/orch.js:5`), and so does the usage page that
  follows it (`bin/orch.js:9`). Verified today: `orch bogsu 2>/dev/null` prints
  nothing at all.
- What follows the message changes: for an unknown *command* it stays the global
  page; for a flag error on a *known* command it becomes that command's page.
  `usageError` gains a `helpFor` property carrying the command name, and
  `bin/orch.js:9` renders `renderHelp(err.helpFor)`.

### 5.5 `--version`, and `--help` next to other flags

- **`--version` beats `--help`.** `orch --help --version` prints the version and
  exits 0. This is today's precedence (`src/cli.js:1899` runs before `:1900`)
  and is kept rather than reversed, because a version probe is the more
  machine-facing of the two.
- **The `version` command word does not beat `--help`.** `orch version --help`
  prints §4.13, not the version string. Today it prints the version, because
  `command === "version"` is handled before the help route. The rule is:
  `--version` is a flag and wins; `version` is a command word and gets a page
  like every other command word.
- **`--help` wins over an ordinary flag, and is refused next to an
  action-implying one.** `orch task "x" --reviewer "codex" --help` prints task's
  page; the reviewer override is ignored. But `--until merged`, `--detach` and
  `--build` say "do a thing", which contradicts "describe the tool", so they
  exit 64 (`docs/cli-v2-design.md:137`).
- **A flag out of scope for the named command is still refused, and the message
  now names that command.** This is the §1.5 fix: `validate()` computes
  `effective = flags.help ? "help" : …`, which today produces a message about
  `orch help`, a command the user never typed. In v0.5 the named command is used
  for the message and for the scope check:

  **Before (v0.4.x)**

  ```console
  $ orch dashboard --author "codex" --help
  orch: --author is not valid with 'orch help' — only with: orch agent, orch task, orch issue
  ```

  **After (v0.5.0)**

  ```console
  $ orch dashboard --author "codex" --help
  orch: --author is not valid with 'orch dashboard' — only with: orch agent, orch task, orch issue
  ```

  **Why** — the error is right and the name is wrong, which is worse than either
  alone: it sends the reader to look up a command they did not run. Scoping the
  check to the typed command also means `orch dashboard --limit 5 --help` now
  prints dashboard's page instead of failing, which is what a person exploring
  a command they are mid-way through typing actually wants.

---

## 6. Implementation note

### 6.1 Where the flag sets in §4 come from

They are derived, not typed. This is the exact derivation, and #528 should run
it (or its equivalent inside the renderer) rather than transcribing §4:

```js
// remove the commands and flags P12 deletes; add the one it introduces
const REMOVED_CMDS = ["review", "update"];
const REMOVED_FLAGS = ["merge", "pr", "no-banner"];
for (const [name, c] of Object.entries(COMMANDS)) {
  if (REMOVED_CMDS.includes(name)) continue;
  let f = c.flags.filter((x) => !REMOVED_FLAGS.includes(x));
  if (name === "config") f = f.filter((x) => x !== "dry");  // read-only in v0.5
  if (f.includes("until")) f = [...f, "max-attempts"];      // --until implies a cap
}
```

Result — the authority for every `Options:` block in §4:

| Page | Flags (in declaration order) |
|---|---|
| `init` | `--config-file --dry --link` |
| `config` | `--config-file --check --json` |
| `agent add` | `--config-file --dry --build` + build-only `--allow-large-scope --author --authors --reviewer --reviewers` |
| `task` | `--config-file --dry --no-tidy --detach --until --max-attempts --allow-large-scope --author --authors --reviewer --reviewers --file --cheap --allow-protected --json` |
| `issue` | as `task`, minus `--file` |
| `continue` | `--config-file --dry --no-tidy --detach --until --max-attempts --allow-large-scope --reviewer --reviewers --json` |
| `pr` | `--config-file --dry --until --max-attempts --detach --allow-large-scope --reviewer --reviewers --json` |
| `release` | `--dry` |
| `dashboard` | `--json --limit --check-history --once --plain --refresh-ms` |
| `mcp` | none |
| `upgrade` | `--check --dry` |
| `completion` | `--dry` |
| `version` | none |
| `help` | none |
| *(global)* | `-h, --help --version` (`GLOBAL_FLAGS`) |

The `agent add` split comes from `SUBCOMMAND_FLAGS["agent add"]`
(`src/schema.js:72-75`) — `["config-file", "dry", "build"]` — with the remainder of
`COMMANDS.agent.flags` (minus the deleted `--pr`) being the build-only group
that `validateAgentArgs` already refuses on a non-building `add`.

Two rows in that table contradict `docs/cli-v2-proposal.md`. The source is the
authority in both cases, per this document's contract, and the table stands as
written:

**`--json` is command-scoped, not global.** `GLOBAL_FLAGS` is
`["help", "version"]`, and the comment immediately above it says so in as many
words — "`--json` is NOT global … so it is declared on that command's flag list
instead" (`src/schema.js:53-56`). The proposal's "`--json` is global"
(`docs/cli-v2-proposal.md:231`) and `docs/cli-v2-design.md` §3's sketch, which
additionally puts it on `init`, `release` and `upgrade`
(`docs/cli-v2-design.md:105-119`), describe a schema that was never written. So §4.1, §4.8 and §4.11 carry no
`--json` row, and §4.0's `Options (valid on every command):` block stays at two
rows — which is what lets §6.4 test 4 be an absolute assertion rather than one
with an exception carved out of it. That comment's own "only `dashboard` reads
it" clause is stale in the other direction: `COMMANDS` also declares `json` on
`config`, `task`, `issue`, `review`, `continue` and `pr`. The claim the comment
is making — *not global* — is the load-bearing half, and it matches
`GLOBAL_FLAGS` on the next line. One consequence the run pages inherit: on
`task`, `issue` and `pr`, `--json` is refused when `--until` is absent or
`once`, because that path has no event stream to print — unless `--detach` is
also set, since a detached run streams to its log either way
(`src/schema.js:301-305`). With v0.5's `ready` default that refusal is
invisible until someone writes `--until once --json` together.

**`--dry` is legal on `orch completion install` and refused on the plain
form.** `COMMANDS.completion` is `mutates: true, flags: ["dry"]`, with the
reason recorded beside it (`src/schema.js:156-160`): `completion install`
writes `~/.orch/completion.bash`, so it mutates like any other writing command.
`validate()` rejects `--dry` only on a `mutates: false` command
(`src/schema.js:280-282`), and `validatePositionals` rejects it on
`orch completion [bash]` with a message of its own — "`--dry` is only valid
with 'orch completion install' — 'orch completion' on its own only prints, it
never writes" (`src/schema.js:401-407`). The proposal's read-only list
(`docs/cli-v2-proposal.md:224-226`) predates that subcommand split and treats
`completion` as one printing command. §4.12's single `--dry` row, whose text
carries the restriction, is the correct rendering of a flag legal on one of two
subcommand forms.

### 6.2 What `COMMANDS` and `FLAGS` must grow

`renderHelp()` cannot produce §4 from today's data: a `rows` entry is a label
and one description line, with no synopsis, no paragraph, no examples and no
per-command flag wording. Add to each `COMMANDS` entry:

| Field | Type | Used by |
|---|---|---|
| `group` | `"setup" \| "run" \| "review" \| "operate" \| "maintain"` | global page grouping (§3 rule 2) |
| `summary` | string | the command's row in the global page |
| `synopsis` | string[] | the `Usage:` lines on its own page |
| `about` | string | the one-paragraph purpose |
| `args` | string | the `Arguments:` line (arity in words) |
| `exits` | number[] | the per-page exit subset (§3 rule 7) |
| `examples` | string[] | the page's examples |
| `notes` | string[] | free lines after `Arguments:` (e.g. pr's "no --author") |
| `flagHelp` | `{ [flag]: string }` | per-command wording overrides |
| `flagGroups` | `{ [heading]: string[] }` | `agent add`'s `Only with --build:` |

`rows` goes away: `summary` replaces it, and the multi-row commands
(`task`, `agent`, `completion`) express their second form as a second
`synopsis` line on their own page instead of a second row in the global list.

`FLAGS[].help` stays as the **default** wording for a flag. `flagHelp` on a
command overrides it. Only two flags actually need an override today, and both
are from §1.3:

- `--json` — "one JSON event per line" on `task`/`issue`/`pr`/`continue`, "one
  JSON snapshot" on `dashboard`, "one JSON object" on `config`.
- `--check` — "validate; exit 1 on problems" on `config`, "report the latest
  version" on `upgrade`.

Keeping the default in `FLAGS` is what stops fourteen copies of `--config-file`
drifting apart; the override map is what stops `--json` documenting only its
exception.

Add one module-level constant for the exit table so the global page and each
per-page subset render from one source:

```js
export const EXITS = {
  0: "the goal was reached and verified",
  1: "internal error (orch bug, or the environment failed)",
  2: "stopped at the attempt cap — resume with `orch continue <runId>`",
  3: "blocked: a human must decide (guardrail, security floor, protection)",
  4: "asked a human and got no answer in automation.humanWaitHours",
  64: "usage error (unknown command, wrong flag for the command, bad value)",
};
```

These are the codes the run controller emits, from the shared table in
`src/exit-codes.js` (`OK: 0, ERROR: 1, ESCALATED: 2, THROTTLED: 3,
WAIT_TIMEOUT: 4, ACTION_REQUIRED: 5, BLOCKED: 6`), plus `usageError`'s 64.
Note `BLOCKED` is **6**, not 3: 3 is reserved for the concurrency refusal,
where nothing ran and retrying later is safe, while a `BLOCKED` terminal
cannot succeed on a retry.

### 6.3 The code changes, by file and line

| Site | Today | Becomes |
|---|---|---|
| `src/schema.js:521` | `renderHelp()` — one string, two flat blocks | `renderHelp(command)` — no argument renders §4.0; a command name renders that command's page from its `COMMANDS` entry |
| `src/schema.js:522-527` | flatMaps `c.rows`; reads `FLAGS[].help` | reads `c.group`/`c.summary` for the global page, and `c.flags` + `c.flagHelp` for a command page |
| `src/schema.js:517` | `pad(label, width = 24)` called with `22` at both sites | called with `24` at both sites (§3 rule 1); the dead default disappears |
| `src/schema.js:198` | `EXAMPLES` — one flat array | moves onto each command's `examples`; the global page's four lines stay as a module constant |
| `src/schema.js:257` | `effective = flags.help ? "help" : …` | `effective = command` when `flags.help` and a command word was given (§5.5) |
| `src/schema.js:371` | `POSITIONAL_ARITY.help = [0, 0]` | `[0, 1]`, with the target validated against `COMMANDS` in the help route |
| `src/cli.js:1900` | `if (flags.help \|\| command === "help") { printUsage(); return; }` | resolve the target (`command === "help" ? rest[0] : command`), then `console.log(renderHelp(target))` |
| `src/cli.js:1899` | version route ahead of help | unchanged for the `--version` *flag*; the `version` *command* word must fall through when `flags.help` is set (§5.5) |
| `src/cli.js:3370` | `printUsage()` wrapper | takes an optional command name |
| `bin/orch.js:9` | `if (err.showUsage) console.error(renderHelp())` | `console.error(renderHelp(err.helpFor))` — per-command page for a flag error on a known command (§5.4) |
| `src/completion.js` | renders from `COMMANDS`/`FLAGS` | unchanged in behaviour, but must keep compiling once `rows` is gone |

### 6.4 The tests that lock it

New file `test/help.test.js`. Fixtures under `test/fixtures/help/` — one `.txt`
per page, containing exactly the blocks in §4.

1. **One byte-for-byte assertion per page** (15 assertions: 14 commands + the
   global page):

   ```js
   for (const name of [...Object.keys(COMMANDS), null]) {
     const fixture = readFileSync(`test/fixtures/help/${name ?? "orch"}.txt`, "utf8");
     assert.equal(renderHelp(name), fixture.trimEnd(), `help text changed for ${name ?? "orch"}`);
   }
   ```

   A fixture is not busywork here: this document *is* the fixture set, so a
   reviewer diffs a proposed help change against a file instead of reading a
   template literal.

2. **Drift guard, forwards — every declared flag is documented.** This is the
   assertion that keeps §4 from rotting:

   ```js
   for (const [name, c] of Object.entries(COMMANDS)) {
     const page = renderHelp(name);
     for (const flag of c.flags) {
       assert.match(page, new RegExp(`--${flag}(?![\\w-])`), `orch ${name} --help omits --${flag}`);
     }
   }
   ```

   Add a flag to `COMMANDS.task.flags` and forget its row: red.

3. **Drift guard, backwards — every documented flag is declared.** Extract every
   `--token` from a page's `Options:` block and assert it is in that command's
   `flags` (or `GLOBAL_FLAGS`). Delete a flag from the schema and leave its row:
   red. Document a flag on the wrong page: red.

4. **No command-scoped flag leaks into the global page** (§3 rule 3):

   ```js
   const global = renderHelp();
   const scoped = new Set(Object.values(COMMANDS).flatMap((c) => c.flags));
   for (const flag of scoped) {
     if (GLOBAL_FLAGS.includes(flag)) continue;
     assert.doesNotMatch(global, new RegExp(`^\\s+--${flag}(?![\\w-])`, "m"), `global help lists --${flag}`);
   }
   ```

   Note the `^\s+` anchor: the sentence "run `orch <command> --help`" and the
   `--once` mention in dashboard's summary row are prose, not flag rows.

5. **Every command appears exactly once in the global page**, and the set of
   command words in the global page equals `Object.keys(COMMANDS)` — the
   existing bidirectional check in `test/completion.test.js:254` generalised.

6. **Every example parses.** Feed each `examples` line through `parse()` +
   `validate()` + `validatePositionals()` and assert none throws — the
   generalisation of `test/cli.test.js:4257` ("printUsage examples all parse").
   An example that the parser would refuse is worse than no example.

   The assertion is absolute — no line is exempt and nothing is stripped
   first — which is only possible because §3 rule 8 keeps every example a bare
   `orch …` invocation. The tokenizer this test inherits
   (`argvFromHelpExample` in `test/cli.test.js`) splits on whitespace and
   honours quotes only — it does not interpret shell syntax, so a `>` or a
   `|` in an example becomes an ordinary positional. Worked example:
   `orch completion bash > /etc/bash_completion.d/orch` arrives as the three
   positionals `bash > /etc/bash_completion.d/orch` and is refused by
   `POSITIONAL_ARITY.completion = [0, 1]` (`src/schema.js:398-399`) with
   *"'orch completion' takes at most 1 argument — got 3"*. That is why §4.12
   carries its redirection tip in prose and keeps `orch completion bash` as the
   example.

7. **The three help routes agree.** `renderHelp("task")`, the output of
   `main(["task", "--help"])` and the output of `main(["help", "task"])` are the
   same string (§5.1).

8. **Streams and exit codes.** `--help` → stdout, exit 0. Unknown command →
   stderr, exit 64, and stdout empty. The existing tests capture combined
   output, which cannot catch a regression that moves help to stderr.

### 6.5 Two existing tests go red on purpose — rewrite, do not appease

Both assert the *flat* structure this spec removes. #528 must rewrite them, not
restore the flat block to make them pass:

- `test/schema.test.js:402` — *"help renders from the schema: every command and
  every flag"* — asserts that every entry in `FLAGS` appears in the single
  `renderHelp()` string, and parses `Commands:` with `/\nCommands:\n([\s\S]*?)\n\n/`.
  Both break: command-scoped flags leave the global page, and the grouped
  command list contains blank lines, so the non-greedy `\n\n` stops at the first
  group. Replace with tests 2, 3 and 4 above.
- `test/completion.test.js:247` — *"--help documents every flag the parser
  accepts"* — and `test/completion.test.js:254`, the following *"completion
  offers every command listed in --help"* — same two assumptions, same two
  failures. Replace the first with test 2; rewrite the second to read command
  words from the grouped list (test 5).

If either is "fixed" by putting the flags back in the global page, the whole
change is undone and nothing else will notice.
