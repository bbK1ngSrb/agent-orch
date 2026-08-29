# orch CLI reference — v0.5.0

> **Draft — not current documentation.** This document describes agent-orch **v0.5.0**, which has not been released. The behaviour it describes is partly unlanded; passages that are not yet true of any release are marked. For the current release, read `README.md` and `docs/orch-manual.md`. Tracking: #509.

This is the lookup document: every command, every flag, every `orch.yml` key,
every exit code, every environment variable. If you want the narrative
introduction, read the README; if you want to know whether `--cheap` does
anything on `orch pr`, you are in the right place.

---

## 0. How to read this document

### 0.1 What "v0.5.0" means here

v0.5.0 is a **clean break**, not a deprecation window. Commands, flags and
config keys that v0.4.x accepted with a warning are removed outright, and the
default *goal* of a run command changes from "do one pass" to "keep going until
the change is ready to merge."

The release lands in slices. Two of them matter for this document:

- **P12 (issue #528)** — the cutover: it deletes `orch review`, `orch update`,
  `orch agent build`, `--merge`, `--pr`, `--no-banner`, the interactive `config`
  wizard, and the removed config keys; and it flips the `--until` default from
  `once` to `ready`.
- **P13 (issue #529)** — cuts the actual release.

Neither has landed. Wherever a behaviour described below is designed but not yet
implemented, it carries this marker:

> **Not yet landed** (P12, #528).

Everything *without* that marker is verified against `src/` and works today.
"Today" means two branches, and the difference is small but real: `main`
(v0.4.360, HEAD `733760b`) is where the flag and config tables were dumped from,
while `orch/integration` (v0.4.361) is ahead of it and carries the
`automation.rotateModels` wiring described in §6.9. `src/schema.js` is
byte-identical on both, so every marker that depends on the command/flag schema
— the removed commands, `--max-attempts`, the `config` wizard, the `--until`
default flip — holds on either branch. The one place the branches differ is
called out where it occurs.

### 0.2 Vocabulary

These words are used precisely and never interchanged with synonyms.

| Term | Meaning |
|---|---|
| **cycle** | One author → cross-audit → test-gate → security-scan → land pass. |
| **round** | One author/reviewer exchange *inside* a cycle. Capped by `roundCap`. |
| **seat** | A role slot — author seat, reviewer seat — filled by an `<agent> [model] [effort]` spec. |
| **work order** | The task text, `--file` JSON document, or GitHub issue body an author is given. |
| **remedy** | An automated recovery action chosen after a classified failure. Six exist; four are operator-orderable (`rebase`, `rotate`, `reauthor`, `ask`) and two are structural and can never be reordered or disabled (`integration-repair`, `wait`). |
| **escalation** | orch stops and writes `.orch/reviews/<branch>/DECISION.md` for a human. |
| **the standing PR** | The persistent `orch/integration → main` pull request. There is exactly one. |
| **landing** | Merging a reviewed branch onto the integration branch. |

A **role spec** is a whitespace-separated string `"<agent> [model] [effort]"` —
for example `"codex gpt-5.6-luna high"`. The agent name is required and must be
a registered adapter. A trailing token that matches a known effort keyword
(`low`, `medium`, `high`, `xhigh`, `max`, `minimal`) is parsed as the effort, so
`"codex high"` sets effort and leaves the model unset. Parsing lives in
`parseRoleSpec` (`src/config.js`), and it is run at **flag-validation time** —
an unregistered agent name is a usage error before orch makes a single network
call.

---

## 1. Invocation model

```
orch <command> [positional...] [flags...]
```

The parser is a thin wrapper over Node's `parseArgs`, driven entirely by one
declarative object — `FLAGS`, `COMMANDS` and `SUBCOMMAND_FLAGS` in
`src/schema.js`. The same object renders `orch --help` and the bash completion
script, so the three cannot drift apart.

### 1.1 The rule that governs everything else

**A flag the command does not read is a usage error, not a silent no-op.**

Before this schema existed, each command reached into the parsed flags for
whatever it happened to care about; anything else was dropped on the floor.
`orch issue 42 --file work-order.json` ran the cycle and ignored `--file`
entirely — the user believed the work order file was used, and it was not.
That failure mode ("nobody read your flag") is worse than an error, because it
is invisible.

Now every flag is checked against the command's declared flag list and rejected
with exit 64 if it does not belong, and the message tells you where it *does*
belong:

```console
$ orch task --limit 5
orch: --limit is not valid with 'orch task' — only with: orch dashboard
$ orch dashboard --author "codex"
orch: --author is not valid with 'orch dashboard' — only with: orch agent, orch task, orch issue
```

Exit 64 is `EX_USAGE` from BSD's `sysexits.h` — the conventional "you typed it
wrong" code, distinct from the catch-all 1 that means "the run itself failed".
A script can branch on the difference.

### 1.2 The two global flags

`--help` (`-h`) and `--version` are legal on **every** command. They are not in
any command's flag list; they are declared separately in `GLOBAL_FLAGS`
(`src/schema.js`).

They short-circuit `main()` *before* dispatch, and positional validation stands
aside for them (`validatePositionals` returns immediately on `flags.help`).
Both halves of that survive v0.5 unchanged and both are load-bearing: `orch
issue --help` prints help rather than dying on the missing `<number>` — asking
what a command's arguments are must not require supplying them — and help goes
to **stdout** at exit **0**, so a CI smoke test that shells out to `orch --help`
does not fail. `--version` also still beats `--help`: `orch --help --version`
prints the version and exits 0, because a version probe is the more
machine-facing of the two.

#### What `--help` means next to a command word

> **Not yet landed** (P12, #528). This subsection states the v0.5 contract,
> specified in the help spec §5.1–§5.5; the current checkout still behaves as
> the right-hand column below records.

In v0.5, `--help` is scoped to the command you typed. Three spellings are one
intent — `orch pr --help`, `orch help pr` and `orch --help pr` — and all three
print byte-identical output at exit 0:

```console
$ orch pr --help | head -1
orch pr — audit a pull request or a branch, and repair or merge it.
```

Flag validation is scoped to that command too, so what happens to the *other*
flags on the line depends on what they imply:

| Other flags on the line | v0.5 | Today on `733760b` |
|---|---|---|
| all global — `orch pr 42 --help` | prints `pr`'s page, exit 0 | prints the **global** page, exit 0 |
| an ordinary command flag — `orch task "x" --reviewer "codex" --help` | ignored; prints `task`'s page, exit 0 | exit 64, message names `orch help` |
| an action-implying flag — `--until merged`, `--detach`, `--build` | exit 64: "do a thing" contradicts "describe the tool" | exit 64, message names `orch help` |
| a flag out of scope for the typed command — `orch dashboard --author "codex" --help` | exit 64, message names **`orch dashboard`** | exit 64, message names `orch help` |

The last row is the one to read twice, because today's message is right about
the flag and wrong about the command — which is worse than either error alone,
since it sends you to look up a command you never ran:

**Today (v0.4.x)**

```console
$ orch dashboard --author "codex" --help
orch: --author is not valid with 'orch help' — only with: orch agent, orch task, orch issue
```

**v0.5.0**

```console
$ orch dashboard --author "codex" --help
orch: --author is not valid with 'orch dashboard' — only with: orch agent, orch task, orch issue
```

Every row above turns on one line. Flag validation does not stand aside for
`--help` — it *retargets*. `validate()` opens with

```js
const effective = flags.help ? "help" : flags.version ? "version" : command;
```

and then checks every flag on the line against `COMMANDS[effective].flags`.
`COMMANDS.help.flags` is the empty array, so today any non-global flag you also
typed is rejected against `help`. P12 keeps `effective` on the typed command
when `flags.help` is set, and passes that command word to the renderer
(`src/cli.js:1863`) instead of discarding it. The `flags.version` half of the
expression is **not** touched: a non-global flag beside `--version` is still
checked against `version`. The `version` *command word*, though, stops beating
`--help` — `orch version --help` prints `version`'s page in v0.5, where today it
prints the version string.

The `help` command word moves with it. `POSITIONAL_ARITY.help` goes from
`[0, 0]` to `[0, 1]`, so `orch help task` becomes the alias described above, and
an unrecognised target reuses the existing unknown-command wording:

```console
$ orch help taks
orch: unknown command: taks (run 'orch help' for usage)
```

Two asymmetries this replaces, stated so you recognise them on a v0.4.x
checkout:

- There is **no per-command help**. `orch task --help`, `orch pr --help` and
  `orch --help` print the byte-identical global help.
- `orch help task` is refused (`'orch help' takes no arguments — got 1: task`,
  exit 64), while `orch --help task` silently ignores the positional and prints
  the global help with exit 0. Same intent, opposite outcomes.

### 1.3 Parser rules

| Rule | Behaviour |
|---|---|
| Value form | `--flag value` and `--flag=value` are both accepted. |
| Empty value | `--file=` is refused: `--file requires a non-empty value`. An explicit empty string used to read as absent at every call site. |
| Repeated value flag | **Any** non-boolean flag given twice is exit 64: `--until given more than once`. This is stricter than the design's "last one wins for scalars, error only on contradictory `--until`". `parse()` asks `parseArgs` for its token stream and rejects a repeat before values are read, so it does not matter whether the two values agree. Repeated *boolean* flags are harmless and ignored. |
| `int` flags | `--limit`, `--refresh-ms` must be positive integers. A non-integer is exit 64, not a silent `NaN`. |
| `enum` flags | `--until` must be one of `once`, `ready`, `merged`. |
| Boolean `--no-` names | `--no-tidy` is a flag *named* `no-tidy`, not a negation of `--tidy`. |
| Unknown command | Usage text to **stderr**, exit 64. It used to print to stdout and exit 0 — a cron job reported success for a run that never happened. |
| Unknown flag | Exit 64: `orch: unknown option --foo (run 'orch help' for usage)`. `parse()` catches `parseArgs`'s own throw and re-raises it as a usage error, so an unknown option gets 64 rather than the raw-throw fallback of 1. |
| `--dry` on a read-only command | Exit 64: `--dry has no effect on 'orch dashboard' — it changes nothing`. "Read-only" means `mutates: false` in `COMMANDS`, which today is exactly `dashboard`, `mcp`, `version` and `help`. `config` is **not** one of them on this checkout — it declares `mutates: true` and lists `dry`, so `orch config --dry` is exit 0; see §4.1. |

### 1.4 Cross-flag rules

These are checked in `validate()` (`src/schema.js`), which runs **before** the
update-check network call and before the GitHub App token mint. That placement
is the point: a run that was always going to be refused should not phone home
and mint credentials first.

| Rule | Error |
|---|---|
| `--cheap` with any of `--author/--authors/--reviewer/--reviewers` | `--cheap cannot be combined with --author/--authors/--reviewer/--reviewers` |
| `--author` **and** `--authors` | `set --author or --authors, not both` |
| `--reviewer` **and** `--reviewers` | `set --reviewer or --reviewers, not both` |
| On `task`/`issue`: author set but no reviewer | `set both --author(s) and --reviewer(s), or neither` |
| `--detach` with `--dry` | `--detach cannot be combined with --dry` |
| `--json` on `task`/`issue`/`review`/`pr` without `--until ready\|merged` | `--json on 'orch task' requires --until ready (or merged) — the once path has no event stream to print` (waived when `--detach` is present, since the detached parent prints its own JSON handle). The guard names those four commands explicitly (`src/schema.js:301`) and **excludes `continue`**. That exclusion outlives the reason it was written for. Today `continue` refuses `--until ready\|merged` outright, so demanding the flag would make `--json` unusable there; after P12 the flag becomes legal but is still usually absent, because a resume takes its goal from the run record (§3.7). Either way, requiring an `--until` on the command line would refuse resumes that are already streaming events. |
| Unregistered agent in a role spec | `--author: unknown agent: mistral` |

Why "author without reviewer" is refused on `task`/`issue`: reviewer-only is
meaningful ("rotate the author normally, but force *this* auditor"), whereas
author-only would silently leave the reviewer to rotation and could pick the
same model family for both seats. Cross-audit by one model family reviewing
itself is precisely what orch exists to prevent.

---

## 2. The command × flag matrix

> **Not yet landed** (P12, #528) — for the removed rows. On the current
> checkout `orch review`, `orch update`, `orch agent build`, `--merge`, `--pr`
> and `--no-banner` all still work. This section describes the v0.5 shape.

This matrix is the single most useful table in the documentation set, because
orch already computes it internally and only shows it to you inside an error
message. `validate()` builds it on the fly at `src/schema.js:266` and
`src/schema.js:283`:

```js
const valid = Object.keys(COMMANDS).filter((c) => COMMANDS[c].flags.includes(name));
```

In other words, the mapping below can be learned from the tool today only by
typing something wrong. Here it is up front.

### 2.1 One row per flag

The table is derived from the **post-P12** `COMMANDS` — each row lists the
commands whose `flags` array contains that flag, plus the `SUBCOMMAND_FLAGS`
split for `agent add` (§2.3). Three absences are therefore deliberate rather
than oversights, and all three are still declared in `src/schema.js` today:
`review` (which currently holds `config-file, dry, no-banner, detach, until,
allow-large-scope, reviewer, reviewers, cheap, json`) and `update` (`check`,
`dry`) are commands P12 removes, and `config`'s `dry` is the accepted-but-inert
flag P12 turns into a usage error. See §2.4 and §4.1.

| Flag | Type | Commands that honour it | Notes |
|---|---|---|---|
| `-h`, `--help` | boolean | *(every command)* | Global. Short-circuits dispatch. |
| `--version` | boolean | *(every command)* | Global. Short-circuits dispatch. |
| `--author <role>` | string | `task`, `issue`, `agent add --build` | Not on `pr` or `continue` — those audit work that already has an author. |
| `--authors <roles>` | string | `task`, `issue`, `agent add --build` | Comma-separated. See §2.4 for the v0.5 meaning change. |
| `--reviewer <role>` | string | `task`, `issue`, `pr`, `continue`, `agent add --build` | |
| `--reviewers <roles>` | string | `task`, `issue`, `pr`, `continue`, `agent add --build` | Comma-separated; every listed reviewer audits each round and merge requires unanimity. |
| `--cheap` | boolean | `task`, `issue` | Forces `cheap.role` into both seats. |
| `--file <file>` | string | `task` | Untrusted JSON work order. |
| `--config-file <file>` | string | `init`, `config`, `agent add`, `task`, `issue`, `pr`, `continue` | Layers a YAML file on top of `.orch/orch.yml` for one run. |
| `--allow-protected` | boolean | `task`, `issue` | Bypasses the *intake* refusal only — never the review-time guardrail floor. |
| `--allow-large-scope` | boolean | `task`, `issue`, `pr`, `continue`, `agent add --build` | Advisory: reaches the reviewer prompt, gates nothing. See §4.3. |
| `--dry` | boolean | `init`, `agent add`, `task`, `issue`, `pr`, `continue`, `release`, `upgrade`, `completion install` | Rejected on read-only commands. |
| `--until <mode>` | enum `once\|ready\|merged` | `task`, `issue`, `pr`, `continue` | The goal. Default becomes `ready` at P12. |
| `--max-attempts <n>` | int ≥ 0 | `task`, `issue`, `pr`, `continue` | **Not yet landed** (P12, #528). Per-run override of `automation.maxAttempts`. |
| `--check` | boolean | `config`, `upgrade` | Two unrelated meanings; see each command. |
| `--link` | boolean | `init` | |
| `--build` | boolean | `agent add` | |
| `--no-tidy` | boolean | `task`, `issue`, `continue` | Leaves task branches and worktrees in place after a merge. |
| `--detach` | boolean | `task`, `issue`, `pr`, `continue` | Re-execs orch as a background child; parent prints the handle. |
| `--json` | boolean | `config`, `task`, `issue`, `pr`, `continue`, `dashboard` | Event stream on run commands, one snapshot on `dashboard`, one report on `config`. |
| `--limit <n>` | int ≥ 1 | `dashboard` | |
| `--check-history` | boolean | `dashboard` | |
| `--once`, `--plain` | boolean | `dashboard` | Aliases of each other. Unrelated to `--until once`. |
| `--refresh-ms <n>` | int ≥ 1 | `dashboard` | |

`mcp`, `version` and `help` take **no** flags at all beyond the two globals.
`completion` takes only `--dry`, and only on the `install` subcommand.

### 2.2 One row per command

| Command | Positional arity | Flags |
|---|---|---|
| `init` | 0 | `--config-file --dry --link` |
| `config` | 0 | `--config-file --check --json` |
| `agent add <name>` | 1 (exactly) | `--config-file --dry --build` (+ `--pr`-free build flags with `--build`, §2.3) |
| `task ["text"...]` | 0..∞ (all joined with spaces) | `--config-file --dry --no-tidy --detach --until --max-attempts --allow-large-scope --author --authors --reviewer --reviewers --file --cheap --allow-protected --json` |
| `issue <number>` | 1 (exactly, digits only) | as `task`, minus `--file` |
| `pr <number\|branch>` | 1 (exactly) | `--config-file --dry --until --max-attempts --detach --allow-large-scope --reviewer --reviewers --json` |
| `continue <sid>` | 1 (exactly) | `--config-file --dry --no-tidy --detach --until --max-attempts --allow-large-scope --reviewer --reviewers --json` |
| `release "entry"...` | 1..∞ (joined with spaces) | `--dry` |
| `dashboard` | 0 | `--json --limit --check-history --once --plain --refresh-ms` |
| `mcp` | 0 | *(none)* |
| `upgrade` | 0 | `--check --dry` |
| `completion [bash\|install]` | 0..1 | `--dry` (only with `install`) |
| `version` | 0 | *(none)* |
| `help [command]` | 0..1 (P12, #528; `0` today — §1.2) | *(none)* |

Why `task` and `release` have no maximum arity: both build free text by joining
every remaining word with a space. `orch task add input validation` is three
positionals, not one, and capping the maximum would reject exactly the unquoted
phrasing the handler exists to accept.

### 2.3 `agent add` and the union trap

`COMMANDS.agent.flags` in the source is the **union** of both subcommand flag
sets. That union is a validation implementation detail — it exists so a flag
legal on either subcommand still validates against the bare command name — and
it is **not** a user-facing flag set. Reading it as one produces a claim that is
wrong in *both* directions, because `validateAgentArgs` gates the build-only
flags conditionally — `if (known || !flags.build)` (`src/schema.js:493`):

- On `agent add`, the build-only flags (including `--pr`) are rejected when the
  name is **already registered**, or when `--build` is **absent**. That is the
  common case, and it is what makes a naive union-derived matrix wrong.
- But `orch agent add <unregistered> --build --pr` clears validation and reaches
  `buildAgent`, where `--pr` is a live, functional flag: `if (flags.pr) cfg =
  { ...cfg, merge: "pr" }` (`src/cli.js:1744`) and `noMerge: !flags.pr`
  (`src/cli.js:1779`). Verified: `orch agent add mistral --build --pr` exits 1
  with `no CLI named "mistral" found on PATH` — a runtime error from inside the
  build, not a usage error. `orch agent add mistral --pr` (no `--build`) is
  exit 64.

That second bullet matters for §3.3: `--pr` is the *only* escape from
`buildAgent`'s default `noMerge`, and v0.5 removes the flag while keeping the
default. A scaffolded adapter therefore always stays on its local branch — see
§3.3, and the note on the `--pr` row in §2.4.

In v0.5 there is a single `agent add <name>` command, and the build-only flags
(`--author(s)`, `--reviewer(s)`, `--allow-large-scope`) are legal only when
`--build` is present *and* the named agent has no adapter yet:

```console
$ orch agent add claude --build --reviewer "codex"
orch: --reviewer is not valid with 'orch agent add claude' — claude already has an adapter, so no build runs (use 'orch agent build claude --pr' to rebuild it)
$ orch agent add mistral --reviewer "codex"
orch: --reviewer is not valid with 'orch agent add' without --build — it only affects the build
```

The reason is the same "nobody read your flag" rule: a name orch already has
adapter code for never builds, so a flag that only affects a build would be
inert there.

Note the trailing pointer in the first message: it recommends `orch agent build
<name> --pr` — a command *and* a flag P12 deletes, and `--pr` has no per-run
replacement at all once a build always keeps `noMerge` (§3.3). That message needs
rewriting alongside the fold, or v0.5 ships an error that names a command it
removed and a flag that no longer exists.

### 2.4 Removed at P12 (#528)

> **Not yet landed** (P12, #528).

| Removed | Replacement | Why |
|---|---|---|
| `orch review <branch>` | `orch pr <branch>` | `review` and `pr` already ran the same review-mode cycle. One command now takes either a PR number or a branch name. Removed rather than aliased: an alias keeps both vocabularies alive in help, completion, MCP and tests forever. |
| `orch update` | `orch upgrade` | Two spellings of one command doubled the schema, help and completion surface. |
| `orch agent build <name>` | `orch agent add <name> --build` | `agent build` was a specialised `task` with duplicated flag handling (and it silently dropped `--cheap`). |
| `--merge` (on `pr`) | `--until merged` | The boolean flag `--merge` and the config enum `merge:` shared a name and meant unrelated things. |
| `--pr` (on `agent build`) | `landing: pr` in `.orch/orch.yml` | The per-run override becomes a config choice. `landing: pr` survives v0.5 partly to keep this row valid (§6.1). One wiring caveat belongs on the record: `--pr` flips **two** things today — `merge: "pr"` (`src/cli.js:1744`) and `noMerge: false` (`src/cli.js:1779`) — and it is the second that makes a build open a PR at all. A `--build` cycle keeps `noMerge` in v0.5 (§3.3), so unless P12 routes `landing: pr` through the build path's `noMerge`, this replacement is inert for builds and the scaffolded adapter stays on its local branch regardless of the config value. |
| `--no-banner` | *(nothing — the banner is deleted)* | A flag that suppresses a banner that no longer prints has nothing to suppress. |
| MCP tool `orch_review` | MCP tool `orch_pr` with `until: "once"` | The MCP surface mirrors the CLI fold. The removed tool returns JSON-RPC `-32601` naming its replacement. |

Each removed spelling exits 64 with the new spelling in the message. `orch
review x` does not quietly become `orch pr x`.

### 2.5 The `authors:`/`reviewers:` semantic change

This is not a CLI change, but it changes what `--authors`/`--reviewers` and the
matching config keys *do*, and the YAML is byte-identical before and after — a
config diff shows nothing.

**Before (v0.4.x)** — `authors: [a, b]` runs **two complete cycles** per work
order, each author on its own branch with its own worktree and test gate
(roughly double the token spend), and `reviewers: [x, y]` makes both auditors
review every round with merge requiring unanimity.

**After (v0.5.0)** — the pools become **index-paired rotation pools**: one
author and one reviewer per cycle, advancing one step per cycle. Cycle 1 pairs
author[0] with reviewer[0], cycle 2 pairs author[1] with reviewer[1], and so on.
The configured fan-out is dropped outright. The two-independent-auditors panel
survives only as the CLI flag `--reviewers "codex gpt-5.6-sol,claude
claude-opus-5"`.

**Why** — under `--until ready` the old semantics silently multiply spend by the
pool size on every remedy attempt, which is why this could not ship as a v0.4
patch. Two safety rules come with it: the reviewer index advances until its
agent differs from the author's, and a pool pairing with no diverse reviewer is
rejected at config load.

> **Not yet landed** (P12, #528; the pairing change is issue #532, which the
> owner recorded as a prerequisite for P12).

---

## 3. Per-command reference

### 3.1 `orch init`

```
orch init [--link] [--config-file <file>] [--dry]
```

**What it does.** Creates `.orch/`, writes `.orch/orch.yml` (only if neither
`.orch/orch.yml` nor a root `orch.yml` already exists — it never overwrites your
config) and writes `.orch/ORCH.md` (which it *does* overwrite, since that is
generated usage documentation). Then it reports which agent CLIs it can find on
`PATH`.

**When to reach for it.** Once per repository, before your first cycle. Re-run
it after upgrading orch to refresh `.orch/ORCH.md`.

**Positional arity.** Exactly zero.

| Flag | Type | Default | Effect |
|---|---|---|---|
| `--link` | boolean | off | Also appends an `@.orch/ORCH.md` include to the repo's agent files (`CLAUDE.md` / `AGENTS.md` / `GEMINI.md`), chosen from `cfg.agents`. This is the only `init` effect outside `.orch/`. |
| `--config-file <file>` | string | — | Loaded only to read `cfg.agents` for `--link`. It does **not** redirect where `init` writes. See §4.2. |
| `--dry` | boolean | off | Prints what would be written and returns without touching the filesystem. |

**Exit codes.** 0 on success; 1 if `.orch/` is not writable (a preflight probe
runs before any write so you get a clear message rather than a raw `EACCES`);
64 for a usage error.

**Ordinary use**

```console
$ orch init --link
orch: initialized (.orch/orch.yml, .orch/ORCH.md).
orch: detected: claude, codex
orch: linked .orch/ORCH.md into CLAUDE.md
```

The detection line is `formatDetection` (`src/detect.js`) verbatim, so it grows a
`— not found: <agents>` tail listing every adapter whose CLI is absent from
`PATH` (or that orch refuses to use at all), each with its reason in
parentheses. On a machine with most CLIs installed the real line is long:
`orch: detected: claude, codex, copilot, gemini, ... — not found: agy (disabled:
…)`.

**Recovery — you are not sure what it will touch**

```console
$ orch init --link --dry
orch (dry): would write /repo/.orch/orch.yml (only if absent) and /repo/.orch/ORCH.md (overwrites)
orch (dry): would link .orch/ORCH.md into the agent docs (CLAUDE.md / AGENTS.md / GEMINI.md)
```

---

### 3.2 `orch config`

```
orch config [--check] [--json] [--config-file <file>]
```

**What it does in v0.5.** Prints the effective, validated configuration with
each value's source, and exits 1 if the config has problems. It is a read-only
diagnostic.

> **Not yet landed** (P12, #528). On the current checkout, bare `orch config`
> still launches the interactive wizard; only `--check` and `--json` reach the
> report path.

**This is the one break that produces no error message.** The command name does
not change, no flag becomes invalid, and nothing exits 64 — `orch config`
simply does something else. A script that piped answers into `orch config`
expecting a wizard gets a config dump instead.

**Before (v0.4.x)**
```console
$ orch config      # opens the interactive wizard on a TTY; throws without one
```

**After (v0.5.0)**
```console
$ $EDITOR .orch/orch.yml
$ orch config --check
```

**Why** — the wizard threw without a TTY, which made it the last
interactive-only path in a headless-first tool, and there was no scriptable way
to write or validate config at all. `orch init` now writes a fully commented
`orch.yml` (the comments do the wizard's teaching job) and `config` validates
what you edited.

**Positional arity.** Exactly zero.

| Flag | Type | Default | Effect |
|---|---|---|---|
| `--check` | boolean | off | Validate and report. Exit 1 if any problem was found, 0 otherwise. |
| `--json` | boolean | off | Emit the same report as a single JSON object on stdout. |
| `--config-file <file>` | string | — | Include this overlay file in the report, so you can see what a one-run override would actually change. |
| `--dry` | — | — | **Rejected** in v0.5 (`config` is read-only). Accepted-but-inert today; see §4.1. |

**Exit codes.** 0 = config valid; 1 = at least one problem (unknown key, bad
value, removed key after P12); 64 = usage error.

**Ordinary use**

```console
$ orch config --check
```

**Recovery — a run just failed with a config complaint and you want machine-readable detail**

```console
$ orch config --json | jq '.problems, .warnings'
```

---

### 3.3 `orch agent add`

```
orch agent add <name> [--build] [--config-file <file>] [--dry]
                      [--author <role> --reviewer <role>] [--allow-large-scope]
```

**What it does.** Appends `<name>` to the `agents:` rotation pool in `orch.yml`,
preserving the file's comments. "Known" means orch's adapter code has the agent
(`adapters.get(name)` succeeds) — a different question from whether *this* repo's
`orch.yml` already lists it.

With `--build`, and only when the named agent has **no** adapter yet, orch
scaffolds one by running its own author → cross-audit → test-gate cycle against
a generated work order that describes the adapter contract. This is orch
writing code that orch will later execute, which is why it is not automatic.

**When to reach for it.** Adding a second (or third) agent so cross-audit has a
genuinely different model to argue with; or bringing up a brand-new CLI adapter.

**Positional arity.** Exactly one — the agent name. Any extra positional is
refused.

| Flag | Type | Default | Effect |
|---|---|---|---|
| `--build` | boolean | off | Scaffold a missing adapter through a cycle. On an already-registered name it is **silently inert** — control falls straight through to the add, which prints only `orch: added <name> to agents` or `orch: <name> already in agents`. Nothing is reported about the build not running. |
| `--config-file <file>` | string | — | Write the `agents:` entry to this file instead of `.orch/orch.yml`. |
| `--dry` | boolean | off | Plan without writing or shelling out. |
| `--author`/`--authors`, `--reviewer`/`--reviewers` | role spec(s) | rotation | Pick the seats for the build cycle. Both or neither — unlike `task`, reviewer-only is refused here. |
| `--allow-large-scope` | boolean | off | Advisory sanction passed to the reviewer prompt. See §4.3. |

The build-only flags are a usage error when the name is already registered, or
when `--build` is absent. Today's `orch agent build <known>` does acknowledge
the no-op (`orch: <name> already registered`, `src/cli.js:2002`); the P12 fold
into `agent add --build` loses that acknowledgement, since the `add` path stays
quiet. Worth an owner call alongside the fold.

**Exit codes.** 0 on success — and for a build, "success" is the reviewer
agreeing on a green gate, with the branch left unmerged: the cycle returns
`approved` / `agreed + green (no merge)` (`src/engine.js:466`), never
`merge-deferred`, because the `noMerge` return comes before the landing path
that could defer anything. 2 if the build cycle escalated; 3 if the concurrency
cap refused it before anything was attempted; 1 on error (e.g. no CLI named
`<name>` on `PATH`); 64 for a usage error.

**Ordinary use**

```console
$ orch agent add codex
orch: added codex to agents
```

**Recovery — you tried to build an adapter and it escalated**

```console
$ orch agent add mistral --build --author "claude claude-opus-5 high" --reviewer "codex gpt-5.6-sol"
orch agent add mistral: escalated (review-stalemate) on pr/claude/adapter-mistral
$ cat .orch/reviews/pr/claude/adapter-mistral/DECISION.md
```

#### A build never lands on its own

`orch agent add <name> --build` keeps `buildAgent`'s `noMerge` behaviour
(`noMerge: !flags.pr` at `src/cli.js:1779`, with `--pr` gone and nothing left to
clear it). The cycle runs — author, cross-audit, test gate, security scan — and
then **stops**. The scaffolded adapter sits on its local `pr/<agent>/adapter-<name>`
branch, nothing is merged onto `orch/integration`, and no PR is opened. A human
reads the diff and lands it.

The reason is worth stating plainly, because it is the whole point of the
exception: the artefact of this cycle is code that will itself go on to *run
other agents*. Every other cycle produces a change that orch merely merges;
this one produces a new participant in orch's own trust boundary. Machine-written
code with that reach gets a human checkpoint, and the checkpoint is cheapest
when it is the default rather than a flag somebody has to remember.

Two consequences follow. First, no value of `landing:` makes a build merge —
`ff-only`, `no-ff` and `pr` all end with the change waiting for a human. What
`landing: pr` is *meant* to change is only where it waits: an open pull request
instead of a bare local branch. On the current checkout it does not change even
that, because the `noMerge` early return fires before `cfg.landing` is read;
see the caveat on the `--pr` migration row in §2.4. Second,
`docs/cli-v2-design.md` §3's sketch of `agent add` carrying the full run-flag
set (`--until`, `--detach`, `--no-tidy`, `--json`) does not match this command:
`--until` and `--no-tidy` describe landing behaviour a build never reaches, and
the landed `SUBCOMMAND_FLAGS["agent build"]` accepts none of them.

---

### 3.4 `orch task`

```
orch task "<change>" [--until <mode>] [--max-attempts <n>]
                     [--author <role> --reviewer <role>] [--cheap]
                     [--allow-protected] [--allow-large-scope]
                     [--no-tidy] [--detach] [--json] [--dry] [--config-file <file>]
orch task --file <work-order.json> [same flags]
```

**What it does.** Runs a cycle from operator-supplied text: an author agent
implements the change on its own branch in its own worktree, a *different* agent
cross-audits the diff, the test gate runs, a deterministic security scan runs,
and on agreement the branch lands on `orch/integration`. The standing PR is then
opened or updated.

**When to reach for it.** Ad-hoc changes you can describe in a sentence, and
anything not tracked as a GitHub issue.

**Positional arity.** Zero or more, joined with spaces. You need **either** a
positional or `--file`, and never both:

```console
$ orch task
orch: usage: orch task "describe the change" (or --file work-order.json)
$ orch task "add retries" --file wo.json
orch: orch task --file takes no positional task text — put the task in the work-order file
```

| Flag | Type | Default | Effect |
|---|---|---|---|
| `--until <mode>` | `once\|ready\|merged` | `ready` in v0.5 (`once` today) | The goal. See §3.5's table — it means the same on every run command. |
| `--max-attempts <n>` | int ≥ 0 | `automation.maxAttempts` (3) | Remedy attempts after the first cycle. `0` = one pass, but with the v0.5 exit codes. **Not yet landed** (P12, #528). |
| `--file <file>` | string | — | Read the work order from a JSON file. The content is treated as **untrusted**: it is shape-validated and wrapped in a neutralised fence the author reads as reference, not as instructions. |
| `--author`/`--authors` | role spec(s) | rotation over `agents:` | Must be paired with a reviewer flag. |
| `--reviewer`/`--reviewers` | role spec(s) | next agent in rotation | May be given alone ("rotate the author, force this auditor"). |
| `--cheap` | boolean | off | Force `cheap.role` into both seats for this run. Mutually exclusive with the role flags. Without the flag, a work order whose `suspected_paths` all match `cheap.paths` routes the same way automatically. |
| `--allow-protected` | boolean | off | Run even though the work-order text names a path on orch's guardrail denylist. See below. |
| `--allow-large-scope` | boolean | off | Advisory; see §4.3. |
| `--no-tidy` | boolean | off | Leave task branches and worktrees in place after a merge instead of cleaning them up. |
| `--detach` | boolean | off | Re-exec in the background; the parent prints a run handle and a log path under `automation.detachLogDir`. |
| `--json` | boolean | off | One JSON event per line on stdout. Requires `--until ready\|merged` (or `--detach`). |
| `--dry` | boolean | off | Plan without shelling out to an agent or changing git. Under `ready`/`merged`, `--dry` plans the **first cycle only** — it never simulates the loop, and a dry run writes no run record and never polls readiness. *(The design also specifies that a dry `ready`/`merged` run prints the remedy ladder it would apply; nothing in `src/` prints one today.* **Not yet landed** *— P12, #528.)* |
| `--config-file <file>` | string | — | Overlay YAML for this run only. |

**`--allow-protected` in one paragraph.** orch keeps a denylist of its own
guardrail paths (`src/intake/allowlist.js`). A work order whose *text* names one
is refused at intake, before any cycle starts, because the security scan's
`guardrail-touch` floor would escalate the resulting diff on the first otherwise-
agreeing round — the run could only end in stalemate. The check is textual, so
pass `--allow-protected` when the mention is incidental. The flag affects
**intake only**: the review-time guardrail floor still escalates a diff that
actually touches a protected path, no matter what flags you passed.

**Exit codes.** See §5. Briefly: 0 goal reached, 1 error, 2 stopped at cap
(resumable), 3 blocked (a human must decide), 4 asked a human and nobody
answered, 64 usage.

**Ordinary use**

```console
$ orch task "add input validation to the work-order parser" --reviewer "codex gpt-5.6-sol"
```

**Recovery — a headless run stopped at cap and you want to resume it with a stronger author**

```console
$ orch task "add input validation" --until ready --json > run.jsonl; echo $?
2
$ jq -r 'select(.event=="run.end") | .runId' run.jsonl
20260829-1412-a3f1
$ orch continue 20260829-1412-a3f1 --reviewer "claude claude-opus-5 high"
```

#### The `--until` default flip

**Before (v0.4.x)**
```console
$ orch task "add retry"      # one author → cross-audit → gate → land pass, then stop
```

**After (v0.5.0)**
```console
$ orch task "add retry" --until once
```

**Why** — the omitted flag now means `--until ready`. orch keeps working —
rebase + repair, rotate seats, reauthor, ask a human — up to
`automation.maxAttempts` (3) until the standing PR is green for this change.
Every existing script, cron job and habit that assumed one pass must add
`--until once` or budget for up to four cycles of token spend. `--until once` is
strict parity with today's pass apart from the new exit codes and the removed
banner. Usefully, `--until` already exists and already defaults to `once`, so
you can add `--until once` to your scripts **today**, before upgrading, and the
upgrade becomes a no-op for them.

---

### 3.5 `orch issue`

```
orch issue <number> [--until <mode>] [--max-attempts <n>]
                    [--author <role> --reviewer <role>] [--cheap]
                    [--allow-protected] [--allow-large-scope]
                    [--no-tidy] [--detach] [--json] [--dry] [--config-file <file>]
```

**What it does.** Fetches GitHub issue `<number>`, maps it to a validated work
order, and runs the identical cycle `task` runs — plus `Closes #<n>` on the
merge commit, so merging the standing PR closes the issue.

**When to reach for it.** The normal path for agent-generated changes in this
repo: every agent change destined for `main` starts as an issue and runs through
a cycle. Also the path the `@orch-bot` poller uses.

**Positional arity.** Exactly one, and it must be digits only. `orch issue abc`
is exit 64 — checked before the update-check network call and the GitHub App
token mint, so a typo does not phone home and authenticate first.

Flags are identical to `task` minus `--file` (the issue body *is* the work
order).

Before the cycle starts, orch warns — never blocks — if prior staged branches
exist for the same issue, so you can resume or inspect instead of stacking a
second branch on the same work.

#### `--until`, the one flag that names a goal

| Value | Meaning | Merges? |
|---|---|---|
| `once` | Today's single pass. One cycle; escalate or land, then stop. Strict parity with v0.4.x apart from exit codes and the removed banner. | Lands on `orch/integration` on agreement, like any cycle. Never merges the standing PR. |
| `ready` | Keep going until a pull request exists whose head is exactly the commit orch reviewed and tested, and GitHub reports it mergeable with every required check green. Then stop. Exit 0 means "there is nothing left for orch to do; a human can merge with one click." | **Never** merges the standing PR. |
| `merged` | Everything `ready` does, then merge the standing PR bound to the observed head SHA, and prove it landed with `git merge-base --is-ancestor`. | Yes. |

Two properties worth internalising:

- **There is deliberately no config key that sets a default `until`.** A config
  file must never be able to turn a run someone asked for into a merge.
- **`ready` repairs the shared integration branch.** Because `ready`'s goal is
  "the standing PR is green for our landed head", and nothing else can make that
  true, a `ready` run will run GitHub's `update-branch`, resolve conflicts, and
  fix a red check on `orch/integration` — even when another cycle caused the
  redness. That surprises people; it follows directly from the goal.

**Exit codes.** As `task`.

**Ordinary use**

```console
$ orch issue 42 --until ready
```

**Recovery — the run exited 4 because it asked a question nobody answered**

```console
$ orch issue 42 --until ready; echo $?
4
# answer the question orch posted on issue #42, then:
$ orch continue 20260829-1412-a3f1
```

---

### 3.6 `orch pr`

```
orch pr <number|branch> [--until <mode>] [--max-attempts <n>]
                        [--reviewer <role>] [--allow-large-scope]
                        [--detach] [--json] [--dry] [--config-file <file>]
```

**What it does.** Runs a **review-mode** cycle against an existing PR or branch:
no author writes fresh code from a work order; a reviewer audits the diff, the
test gate runs, the security scan runs, and the verdict is posted back as a PR
comment. Under `ready`/`merged` the loop then repairs the head until GitHub
reports it green and mergeable.

In v0.5 this command absorbs `orch review`. The positional accepts either a PR
number (digits only) or a branch name that exists locally or as
`origin/<branch>`.

**When to reach for it.** Auditing someone else's PR; auditing a branch you
staged by hand after an escalation; getting a second opinion before merging.

**Positional arity.** Exactly one. It is validated *before* dispatch:

```console
$ orch pr nope
orch: usage: orch pr <number> or <branch> [--until once|ready|merged]
orch pr nope: branch does not exist locally or as origin/nope
```

| Flag | Type | Default | Effect |
|---|---|---|---|
| `--until <mode>` | `once\|ready\|merged` | `ready` in v0.5 (`once` today) | Same meanings as §3.5. |
| `--max-attempts <n>` | int ≥ 0 | `automation.maxAttempts` | **Not yet landed** (P12, #528). |
| `--reviewer`/`--reviewers` | role spec(s) | rotation | Who audits. |
| `--allow-large-scope` | boolean | off | Advisory; see §4.3. |
| `--detach`, `--json`, `--dry`, `--config-file` | | | As `task`. |
| `--author`/`--authors` | — | — | **Not accepted.** `pr` audits an existing PR; it never assigns an author. Passing it is exit 64. |
| `--cheap` | — | — | **Not accepted** on `pr`. |
| `--no-tidy` | — | — | **Not accepted** on `pr` — a review-mode cycle creates no task branch to tidy. |

#### `--merge` is gone

**Before (v0.4.x)**
```console
$ orch pr 42 --merge
```

**After (v0.5.0)**
```console
$ orch pr 42 --until merged
```

**Why** — the boolean flag `--merge` and the config enum `merge:`
(`ff-only|no-ff|pr`) shared a name and meant unrelated things, which is a
genuine source of misconfiguration. `--until merged` is also strictly stronger:
it must read `mergeable`, `mergeStateStatus` and `statusCheckRollup` back from
GitHub before merging, and it binds the merge request to the head SHA orch
actually reviewed (`sha=<headSha>`), so GitHub returns 409 rather than merging a
head the local gate never ran on. On the current checkout `--merge` is already a
pure alias — `const until = flags.until || (command === "pr" && flags.merge ?
"merged" : "once")` — and combining it with a contradictory `--until` is exit 64.

#### Bare `orch pr <n>` stops being audit-only

**Before (v0.4.x)**
```console
$ orch pr 42      # audits the PR, posts one comment, stops
```

**After (v0.5.0)**
```console
$ orch pr 42 --until once
```

**Why** — bare means `--until ready` on every run command from v0.5.0. Anyone
who scripted `orch pr <n>` as a read-only reviewer must add `--until once`, or
they will start spending agent attempts and pushing repair commits to somebody
else's branch.

#### A draft PR is refused, not promoted

Under `--until ready` or `--until merged`, a draft PR is **not ready** — that is
the definition, not a heuristic, and orch never flips the draft to ready on your
behalf. There is one readiness predicate, not one for drafts and one for
everything else: `readiness.js:63-64` and `landing.js:136-137` test
`data.state !== "OPEN" || data.isDraft` and return the failure class
`REMOTE_PR_CLOSED` with the summary `pr #42 is a draft`.

That predicate is live. What is **not** live is the disposition beside it:

> **Not yet landed** (P12, #528). Today a draft does not refuse — it *stalls*.
> `REMOTE_PR_CLOSED`'s only remedy is `ask` (`src/failure.js:133`), so orch posts
> the question on the PR, polls for a reply from someone with verified write
> access, and — if `automation.humanWaitHours` elapses unanswered — exits 4; an
> `orch: abandon` reply ends it at exit 3 instead. Mark the PR ready for review
> and `orch continue <runId>` resumes from there. If the operator has removed
> `ask` from `automation.remedies`, the row has no remedy left and the run stops
> at cap (exit 2) instead; see §6.9. v0.5.0 gives the class a draft-specific
> disposition so the run refuses immediately rather than waiting a day for
> somebody to confirm what orch already knows. That is a one-row change in the
> failure table, not a change to readiness.

This clause binds only under `ready`/`merged`. `orch pr 42 --until once` audits
a draft exactly like any other PR and posts its verdict — reviewing work in
progress is a legitimate thing to ask for; *merging* it is not.

**Exit codes.** As `task`.

**Ordinary use**

```console
$ orch pr 512 --until once --reviewer "codex gpt-5.6-sol high"
```

**Recovery — a branch escalated and you staged it by hand; get a fresh audit before merging**

```console
$ orch pr pr/claude/fix-lock-ordering --until once --allow-large-scope
```

---

### 3.7 `orch continue`

```
orch continue <sid> [--until <mode>] [--max-attempts <n>]
                    [--reviewer <role>] [--allow-large-scope]
                    [--no-tidy] [--detach] [--json] [--dry] [--config-file <file>]
```

**What it does.** Resumes an interrupted or stalled cycle from its checkpoint.
The positional resolves by run id **or** by any cycle sid recorded under a run.
A terminal `stopped-at-cap` or `wait-timeout` record gets a **fresh attempt
budget** — that is what makes exit 2 and exit 4 resumable states rather than
dead ends.

Before reattaching, `continue` reclaims any orphaned worktree left under
`.orch/wt` by a hard-killed prior attempt, sparing worktrees whose owner process
is still alive. A sid that already has a live, alive-pid inflight record is
refused rather than raced.

**When to reach for it.** After exit 2 (cap), after exit 4 (nobody answered),
after a machine reboot mid-cycle, or after you have answered the question orch
posted on the issue.

**Positional arity.** Exactly one, and it is path-validated:

```console
$ orch continue ../../etc/passwd
orch: invalid sid '../../etc/passwd' — a sid never contains '/', '..', or a NUL byte
```

That check is not decoration. The sid is used directly as a key into the
checkpoint store (`join(dir, key + ".json")`), and the store self-heals corrupt
files by deleting them — an unchecked operator-typed sid could therefore read or
delete a file outside `.orch/checkpoints`.

| Flag | Type | Default | Effect |
|---|---|---|---|
| `--until <mode>` | `once\|ready\|merged` | the goal recorded on the original run, else `once` | A bare `continue` inherits the run's own goal — resuming a run launched `--until merged` continues toward `merged`. An explicit `--until` here overrides it for this resume. See below. |
| `--reviewer`/`--reviewers` | role spec(s) | the persisted roles | Applies **for this run only**. If the resume dies mid-run, orch writes the *original* persisted roles back into the checkpoint, so a killed override cannot quietly become permanent. It also forces a re-audit: a checkpoint already at `reviewed`/`tested` caches the old verdict, and without an explicit override flag the overridden reviewer would never actually run. |
| `--author`/`--authors` | — | — | **Not accepted.** The branch's commits were authored by a specific agent already; `continue` resumes that run rather than starting a new one. |
| `--no-tidy`, `--detach`, `--dry`, `--allow-large-scope`, `--config-file` | | | As `task`. |
| `--json` | boolean | off | One JSON event per line, as on `task` — but **without** `task`'s `--until ready\|merged` precondition. The cross-flag guard in §1.4 names `task`, `issue`, `review` and `pr` and omits `continue`, so `orch continue <sid> --json` on its own is a legal command line whatever goal the resume inherits. |
| `--no-banner`, `--cheap` | — | — | Not accepted. |

#### What a bare `orch continue` is aiming at

A resume inherits the goal of the run it is resuming. `orch continue
20260829-1412-a3f1` on a run that was launched `--until merged` keeps going
toward `merged`; on a run launched `--until once` it does one more pass. The
resolution is `flags.until || priorRun?.policy?.until || "once"`
(`src/cli.js:2911`) — the flag first, then the recorded goal, then `once` for a
checkpoint too old to carry a policy.

The new global `ready` default deliberately does **not** apply here, and the
distinction is the whole reason `continue` has its own rule. `--until` on a
fresh command says what you want *now*; on a resume, the run already has a
stated goal, and quietly upgrading a `--until once` run to `ready` would make
`continue` start spending agent attempts and pushing repair commits that the
original invocation never asked for. Overriding is one word away when you do
want it: `orch continue <sid> --until merged`.

Only half of this is new. **Inheritance already works** on the current
checkout: a resume of a run whose record carries `policy.until` of `ready` or
`merged` takes the run-controller path with that goal
(`src/cli.js:2992-3003`), which is exactly how exit 2 and exit 4 stay
resumable. What P12 adds is the *override*:

> **Not yet landed** (P12, #528). `--until ready|merged` typed on `continue` is
> refused today, before dispatch — `--until ready is not yet available with
> 'orch continue' — only --until once (the default)` (`src/schema.js:292-294`).
> Until that guard goes, you can inherit a `ready`/`merged` goal but you cannot
> ask for one on the resume line.

**Exit codes.** As `task`.

**Ordinary use**

```console
$ orch continue 20260829-1412-a3f1
```

**Recovery — the same stalemate keeps recurring; swap the reviewer seat**

```console
$ orch continue 20260829-1412-a3f1 --reviewer "claude claude-opus-5 high"
```

---

### 3.8 `orch release`

```
orch release "<changelog entry>" [--dry]
```

**What it does.** Runs the version bump and CHANGELOG write by hand, in the
dedicated integration worktree, under `merge.lock`. It writes no git tag —
tagging is CI's job.

**When to reach for it.** Only in repos with `release.autoBump: true`, and only
after a **hand-landed** change. When a cycle escalates (say, on
`guardrail-touch`) and a human merges the branch onto `orch/integration`
manually, `finalize()` never runs, so the version and CHANGELOG stay frozen.
`orch release` does that bookkeeping alone. With the default
`release.autoBump: false` a clean merge writes neither, so there is nothing to
recover and you should not run this at all.

**Positional arity.** One or more, joined with spaces. An empty entry is exit 64.

| Flag | Type | Default | Effect |
|---|---|---|---|
| `--dry` | boolean | off | Print the intended bump and return without touching git. |

**Preconditions, each a distinct error.** The integration worktree must be
checked out on the integration branch; the working tree must be clean (ignoring
`.orch/merge.lock`); the branch must reconcile with `origin`; `merge.lock` must
be acquirable. Failure recovery restores only the files the bump wrote — never
a whole-tree reset.

**Exit codes.** 0 on success; 1 on any precondition failure; 64 for a missing
entry.

**Ordinary use**

```console
$ orch release "hand-landed guardrail fix (closes #528)"
orch release: chore(release): v0.5.1 committed on orch/integration in /repo/.orch/integration (a1b2c3d)
```

**Recovery — you are not sure whether the tree is clean enough**

```console
$ orch release "hand-landed guardrail fix" --dry
orch (dry): would bump version + CHANGELOG with "hand-landed guardrail fix"
```

---

### 3.9 `orch dashboard`

```
orch dashboard [--json] [--limit <n>] [--check-history] [--once|--plain] [--refresh-ms <n>]
```

**What it does.** Shows live cycle status, a log tail, run history and metrics.
On a genuine interactive terminal it runs a live TUI; every scriptable path
(`--json`, `--once`/`--plain`, piped or redirected stdout, non-TTY stdin) falls
back to a byte-identical one-shot render.

**When to reach for it.** Watching a detached or long `--until ready` run; and
after the fact, to see why a run ended the way it did.

`dashboard` is read-only (`mutates: false`), which is why `--dry` on it is exit
64 rather than an accepted no-op.

**Positional arity.** Exactly zero. `orch dashboard extra` is exit 64.

| Flag | Type | Default | Effect |
|---|---|---|---|
| `--json` | boolean | off | One JSON snapshot object on stdout; forces the non-TTY path. |
| `--limit <n>` | int ≥ 1 | 10 | Cap history rows. |
| `--check-history` | boolean | off | Show stale red history rows as resolved when their branches are gone. **View only** — `runs.jsonl` is not rewritten. |
| `--once`, `--plain` | boolean | off | Force the static one-shot print. Aliases of each other; unrelated to `--until once`. |
| `--refresh-ms <n>` | int ≥ 1 | 1000 | Live TUI poll interval, in milliseconds. Ignored on the one-shot path. |

**Exit codes.** 0, or 64 for a usage error.

**Ordinary use**

```console
$ orch dashboard
```

**Diagnostic use — feed status to a script**

```console
$ orch dashboard --json --limit 5 | jq '.live[] | {branch, stage, agent}'
```

---

### 3.10 `orch mcp`

```
orch mcp
```

**What it does.** Serves orch as an MCP (Model Context Protocol) server over
stdio, so an AI client can invoke orch as a tool. The tool surface is a fixed
table — `orch_status`, `orch_plan`, `orch_task`, `orch_issue`, `orch_review`,
`orch_pr`, `orch_continue` — not an arbitrary-command escape hatch. Each tool
builds a concrete argv; there is no way for a client to inject flags.

> **Not yet landed** (P12, #528) — `orch_review` is live on the current checkout
> and is the seventh tool. P12 folds it into `orch_pr` with `until: "once"`,
> leaving six; the removed tool then answers JSON-RPC `-32601` naming its
> replacement. See §2.4. Its shipped tool description — "Audit an existing branch
> with the reviewer agents **without merging it**" — is **false**, for the reason
> §3.15 gives: `noMerge` is set for `pr` alone (`src/cli.js:2348`), so a `review`
> run lands. An MCP client that trusts that description will land a branch it
> meant only to audit.

**Positional arity.** Exactly zero. **Flags.** None (beyond the two globals).
`orch mcp --help` prints usage and exits rather than hanging as a JSON-RPC
server, because `--help` routes ahead of the `mcp` dispatch.

**Exit codes.** 0 when the client closes or ends the stream — `serve()` resolves
once every in-flight request settles. Protocol and handler errors are reported
*in band* as JSON-RPC error objects (`-32700` parse error, `-32601` method not
found, `-32603` internal error) and do not end the process. 64 for a usage error
on the command line itself.

#### MCP defaults flip too

**Before (v0.4.x)**
```json
{"name":"orch_task","arguments":{"task":"add input validation"}}
```

**After (v0.5.0)**
```json
{"name":"orch_task","arguments":{"task":"add input validation","until":"once"}}
```

**Why** — the same default flip as the CLI, and the same trap: nothing about the
spelling changes, the call just does more. An MCP client that treated
`orch_task` as a cheap single pass now triggers a bounded solver run that lands
on `orch/integration`.

#### The "MCP can never merge" promise is narrowed

The README used to state that an MCP client cannot merge a pull request, because
there was no `orch pr` tool and no way to emit `--merge`. That is being
deliberately narrowed rather than quietly reworded. From v0.5, an MCP client may
request `until: "merged"` **only** when the repo owner sets
`automation.mcpMayMerge: true`, and even then only through the same head-bound,
CI-checked path a hand-typed `--until merged` uses. The default is `false`, and
the check is live today (`src/mcp.js:217`):

```console
# with automation.mcpMayMerge: false (the default)
{"name":"orch_pr","arguments":{"number":42,"until":"merged"}}
→ error: until: merged requires automation.mcpMayMerge: true
```

**Ordinary use** — registered in a client's MCP server config, launched as
`orch mcp` with the repo as its working directory.

**Diagnostic use — probe the tool list by hand**

```console
$ echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | orch mcp
```

---

### 3.11 `orch upgrade`

```
orch upgrade [--check] [--dry]
```

**What it does.** Self-updates the global npm install of orch. It first resolves
where orch is installed; if that resolution finds a **linked dev install** (an
`npm link` to a working checkout), it refuses to touch it and tells you to `git
pull` there instead — overwriting a developer's checkout with a published
tarball would be destructive and silent.

> **Not yet landed** (P12, #528) — the `orch update` spelling is removed. Use
> `orch upgrade`.

**Positional arity.** Exactly zero.

| Flag | Type | Default | Effect |
|---|---|---|---|
| `--check` | boolean | off | Report whether an upgrade is available and stop. Does not install. |
| `--dry` | boolean | off | Print the exact install command that would run. |

**Exit codes.** 0 in every normal outcome — including "upgrade available" under
`--check`, which reports but does not fail. 1 when the global install cannot be
resolved, when the latest version cannot be fetched, or when the install command
itself fails. 64 for a usage error.

**Ordinary use**

```console
$ orch upgrade
orch upgrade: 0.4.360 -> 0.5.0
orch upgrade: updated to latest
```

**Recovery — you are running a linked dev checkout and want to know it**

```console
$ orch upgrade --check
orch upgrade: linked dev install detected at /repo
Run `git pull` in /repo instead.
```

---

### 3.12 `orch completion`

```
orch completion [bash]
orch completion install [--dry]
```

**What it does.** Prints (or installs) a bash completion script generated from
the same `COMMANDS`/`FLAGS`/`SUBCOMMAND_FLAGS` objects that drive the parser, so
completion offers exactly the flags each command actually accepts — including
the `agent add` / `agent build` split.

**Positional arity.** Zero or one, and the one must be `bash` or `install`:

```console
$ orch completion zsh
orch: unknown 'orch completion' target 'zsh' (expected bash or install)
```

| Flag | Type | Default | Effect |
|---|---|---|---|
| `--dry` | boolean | off | Only valid with `install`. On bare `orch completion` it is exit 64, because that form only prints and never writes: `--dry is only valid with 'orch completion install' — 'orch completion' on its own only prints, it never writes`. |

**Exit codes.** 0 on success (including a failed install, which reports its
reason on stdout); 64 for a usage error.

**Ordinary use**

```console
$ orch completion install
orch: wrote completion script to /home/you/.orch/completion.bash
orch: add this line to your ~/.bashrc to enable it:
  source "/home/you/.orch/completion.bash"
```

**Diagnostic use — inspect the script without writing anything**

```console
$ orch completion bash | less
```

---

### 3.13 `orch version`

```
orch version
```

Prints the version string. Identical to `orch --version`. Zero positionals, no
flags, `mutates: false` (so `--dry` is exit 64). Exit 0, or 64 for a usage
error.

```console
$ orch version
0.5.0
$ orch version extra
orch: 'orch version' takes no arguments — got 1: extra
```

---

### 3.14 `orch help`

```
orch help [command]
```

Bare `orch help` prints the global help — the same text `orch --help` prints,
and the same text an unknown command prints to **stderr** before exiting 64. No
flags.

> **Not yet landed** (P12, #528) — for the optional positional. On the current
> checkout `help` takes zero positionals and there is no per-command help.

With a command name, `orch help <cmd>` is an alias for `orch <cmd> --help` and
prints that command's page; the two are byte-identical. An unrecognised name
reuses the unknown-command wording. See §1.2 for the scoping rules `--help`
follows, and the help spec §5.1 for the alias itself.

```console
$ orch help
orch - Run coding agents in an author, review, test, and merge loop.
...
$ orch help task
orch task — run one change through a cycle.
...                       (byte-identical to `orch task --help`)
$ orch help taks
orch: unknown command: taks (run 'orch help' for usage)
```

Today, `orch help task` is instead refused outright:

```console
$ orch help task
orch: 'orch help' takes no arguments — got 1: task
```

---

### 3.15 Removed commands

> **Not yet landed** (P12, #528). All three still work on the current checkout.

#### `orch review <branch>` → `orch pr <target>`

**Before (v0.4.x)**
```console
$ orch review pr/claude/some-branch
```

**After (v0.5.0)**
```console
$ orch pr pr/claude/some-branch --until once
```

**Why** — `review <branch>` and `pr <number>` already ran the same review-mode
cycle through the same code path; v0.5 folds them into one command that takes
either shape of target. `--until once` is what stops the bare command looping
and repairing. Removed rather than aliased, so `orch review x` exits 64 naming
the replacement — an alias would keep both vocabularies alive in help,
completion, MCP and tests forever.

Do not read "After" as a strict parity swap. Today's `orch review` **lands** —
`noMerge` is set for `pr` alone (`src/cli.js:2348`), so a `review` run that gets
agreement, a green gate and a clean scan merges its branch onto the integration
branch exactly as `orch task` would. `orch pr <branch> --until once` is
therefore the first spelling that genuinely audits without any possibility of a
local merge, not a preservation of what `review` did.

Note this is a behaviour change stacked on a rename. The **repair** form
changes meaning too:

**Before (v0.4.x)**
```console
$ orch review my-feature-branch --reviewer "codex"   # audits once, reports a DISAGREE, stops
```

**After (v0.5.0)**
```console
$ orch pr my-feature-branch --reviewer "codex"   # repairs until its PR is green and mergeable
```

**One capability has no destination in the fold.** `--cheap` is legal on
`review` today and is absent from `pr` in both the landed schema and the v0.5
design. So `orch review <branch> --cheap` — "audit this branch with the cheap
role" — has nowhere to go: the migrated command exits 64 with no pointer. Until
that is resolved, force the cheap role explicitly instead:

```console
$ orch pr my-feature-branch --until once --reviewer "<whatever cheap.role names>"
```

#### `orch agent build <name>` → `orch agent add <name> --build`

**Before (v0.4.x)**
```console
$ orch agent build mynewagent --pr
```

**After (v0.5.0)**
```console
$ orch agent add mynewagent --build      # with `landing: pr` in .orch/orch.yml
```

**Why** — `agent build` was a specialised `task` with its own duplicated flag
handling, and it silently dropped `--cheap`. Folding it into `agent add --build`
leaves one command that registers an agent and, when the adapter file is
missing, scaffolds it through a normal cycle. `--pr` existed only to force
`merge: "pr"` for one run, so the per-run override becomes a config choice.

#### `orch update` → `orch upgrade`

**Before (v0.4.x)**
```console
$ orch update --check
```

**After (v0.5.0)**
```console
$ orch upgrade --check
```

**Why** — two spellings of one command doubled the schema, help and completion
surface for no benefit.

---

## 4. Flags that are accepted but do not do what their name implies

A flag the parser takes and the command then ignores is the most expensive
documentation gap there is, because the user believes it worked. Every entry
below was verified in `src/` on the current checkout.

### 4.1 `--dry` on `orch config --check` / `--json` — fully inert

`COMMANDS.config` declares `mutates: true` and lists `dry` in its flags, so
`orch config --check --dry` parses cleanly. But the config-report branch
(`src/cli.js:1903`) returns **before** the `dryRun` variable is ever consulted:

```js
if (command === "config" && (flags.check || flags.json)) {
  const report = configReport(repo, flags["config-file"]);
  printConfigReport(report, Boolean(flags.json));
  process.exitCode = report.ok ? 0 : 1;
  return report;
}
```

Nothing changes. The flag is silently absorbed.

> **Not yet landed** (P12, #528). Once the wizard is removed, `config` becomes
> `mutates: false` and `--dry` on it becomes exit 64 — the correct outcome for a
> read-only command.

`--dry` on bare `orch config` (the wizard path) *is* honoured today: it prints
what the wizard would write and returns without opening a TTY.

### 4.2 `--config-file` on `orch init` without `--link` — near-inert

The flag's own help text reads "Config YAML path; with config / agent add, write
there," which invites the reading that `init` will scaffold into that path. It
does not. `init` always writes `.orch/orch.yml` and `.orch/ORCH.md`. The only
use of the flag is:

```js
const cfg = load(repo, flags["config-file"]);
...
if (flags.link) { const touched = linkOrchDoc(repo, cfg.agents); ... }
```

So without `--link`, `cfg` is loaded and then never read. Be precise about
"inert", though: `load()` still **validates**, so a malformed overlay file
throws. The flag can therefore fail your `init`; it just cannot redirect where
`init` writes.

### 4.3 `--allow-large-scope` — advisory only, on every command that accepts it

This flag sounds like a gate override. It is not one. Its entire runtime effect
is a substitution in the reviewer's prompt template
(`src/adapters/cli-adapter.js:587`):

```js
allowLargeScope: opts.allowLargeScope ? "GRANTED by the operator" : "NOT GRANTED",
```

which renders into `src/prompts/review.md` as "Trusted run control: the
operator's large-scope sanction is **GRANTED by the operator**." That is a hint
to a language model, nothing more.

Critically, it does **not** raise or bypass `scope.maxLines`. The scope gate in
`src/engine.js:232-238` never consults it:

```js
if (cfg.scope.maxLines > 0) {
  const n = scope.count(branch, worktree, cfg.scope.ignore, cycleBase);
  if (n > cfg.scope.maxLines) { /* escalate: split the PR */ }
}
```

If you want a larger diff to pass the hard gate, raise `scope.maxLines` or add
paths to `scope.ignore`. `--allow-large-scope` will not do it.

The flag survives v0.5.0 unchanged, on the same commands it has today: `task`,
`issue`, `pr`, `continue` and `agent add --build`. It is absent from the v2
proposal's flag list, from the per-command matrix and from the design's `SCHEMA`
sketch — a reference generated from the design documents alone would drop it —
but the design set is silent about it, not against it, and nothing in the
bounded loop replaces what it does.

What it does is one substitution and no more. It is interpolated into the
reviewer's prompt as `GRANTED by the operator`, which lifts the reviewer's
standing instruction to reject a diff that bundles more than roughly three
logical changes. That instruction is prose addressed to a language model, and
the model is free to reject the diff anyway. Read the flag as "I know this diff
is wide; here is why it is deliberate" — a note to the auditor, not a permission
bit. It gates nothing mechanically, and no exit code, config key or gate changes
behaviour because it was passed.

### 4.4 `--check` on `orch upgrade` never fails

`orch upgrade --check` reports "upgrade available" and exits **0**. If you are
writing a CI step that should fail when orch is out of date, `$?` will not tell
you — parse the output, or compare `orch version` against the registry yourself.

### 4.5 What is *not* on this list any more

`--merge` used to be honoured only by `orch pr` and silently ignored everywhere
else. That is no longer true: the schema now **rejects** it on every other
command with exit 64. It is a usage error, not an inert flag. The same applies
to `--file` on `issue`, `--author` on `review`/`continue`/`pr`, and every other
flag/command pair that used to no-op — see §1.1.

---

## 5. Exit codes

One contract, five run codes plus the usage code.

| Code | Name | Meaning | Produced by |
|---|---|---|---|
| `0` | reached | The `--until` goal was reached and **verified**: for `ready`, readiness read back from GitHub; for `merged`, the merge commit proven an ancestor of `origin/<base>`. Also the normal success of every non-run command. | every command |
| `1` | error | An orch bug or an environment failure: `gh` missing, unreadable repo, unexpected throw. Also `config --check` reporting an invalid config, and `upgrade` failing to resolve/fetch/install. | every command |
| `2` | stopped-at-cap | The goal was not reached and nothing is left to try: `automation.maxAttempts` is exhausted, or `--until once` gave the run no ladder in the first place. A report and a durable run record exist. **Resumable**: `orch continue <runId>` grants a fresh attempt budget. | `task`, `issue`, `pr`, `continue`, `agent add --build` |
| `3` | blocked | A human must decide. `run.end` always carries a `blockedReason`. | `task`, `issue`, `pr`, `continue`, `agent add --build` |
| `4` | wait-timeout | orch asked a human on the issue or PR and `automation.humanWaitHours` elapsed with no authorised reply. **Resumable** after you answer. | `task`, `issue`, `pr`, `continue` — only under `--until ready\|merged` |
| `64` | usage | Unknown command, a flag not valid for this command, `--dry` on a read-only command, a bad numeric or enum value, a bad positional. | every command |

### 5.1 `blockedReason` values (exit 3)

A closed set of eight. Six come from `BLOCKED_REASON` in
`src/run-controller.js`; the remaining two are emitted by the `ask` remedy
itself (`src/remedies/ask.js`), which is why they are absent from that map:

| Value | Cause |
|---|---|
| `guardrail-path` | The diff touches a path on orch's protected denylist. Never overridable by a flag. |
| `security-finding` | The deterministic security floor found something. |
| `concurrency-cap` | `cfg.concurrency` cycles are already live in this repo; nothing was attempted. |
| `human-abandon` | A human with write access replied `orch: abandon`. |
| `auth` | GitHub authentication failed during readiness or merge. |
| `merge-rejected` | Branch protection refused the merge and there is no bypass. |
| `no-channel` | `ask` had nowhere to post the question, or GitHub returned no comment id for it. |
| `cannot-verify-authorization` | `ask` posted the question but could not confirm the replier's write access through GitHub's collaborator API. |

### 5.2 Why 2 split into 2 and 3

**Before (v0.4.x)**
```console
$ orch issue 42; case $? in 0) ok;; 2) needs_a_human;; esac
```

**After (v0.5.0)**
```console
$ orch issue 42 --until once; case $? in 0) ok;; 2) resumable_retry;; 3) needs_a_human;; esac
```

**Why** — `process.exitCode = 2` was set from five places meaning four different
things: escalated, merge-deferred, "concurrency cap reached, nothing was
attempted", `agent build` escalated, and `pr` not-approved. A caller checking
`$? -eq 2` could not tell "nothing ran, retry later" from "a cycle ran and needs
a human". Splitting them is what lets a wrapper script — including this repo's
own `harness/orch-loop.sh` — retry the resumable states and stop on the blocked
ones.

> **Not yet landed** (P12, #528) for one leg of the `once` path. Exit 2 for a
> `once` run that simply did not agree is correct and permanent — with no ladder
> to run, there is nothing left to try. What is not yet right is the *blocked*
> leg. `once` never enters the run controller at all (`if (until !== "once")`
> gates the `runUntil` call), so it never classifies the failure and never
> reaches a `BLOCKED` terminal; its only exit-code source is a flat
> `raiseExitCode(2)`. On the current checkout a security finding or a
> guardrail touch under `--until once` therefore exits 2 where the contract says
> 3, because the contract is goal-independent: a terminal class blocks at 3 at
> any goal and under any config (manual §4.5). Until the cutover, script a `once`
> run as if 2 could mean either.

### 5.3 How a fan-out picks its exit code

One invocation can produce several cycles, each with its own outcome. Rather
than last-write-wins, orch raises the *most actionable* code
(`raiseExitCode`, `src/cli.js:1387`):

```js
const EXIT_CODE_PRIORITY = { 1: 4, 2: 3, 4: 2, 3: 1 };
```

Read it as a ranking, not as values: **1 beats 2 beats 4 beats 3.** Something
broke (1) must survive everything; needs-review (2) outranks a mere capacity
refusal (3); a readiness timeout (4) is more actionable than a capacity refusal
too. Without this, a peer process pushing a later cycle over the concurrency cap
could overwrite an earlier escalation's 2 with a 3 — reporting "safe to retry"
and hiding the escalation somebody actually needs to go read.

A usage error (64) never participates: it aborts before any run record is
written, so 64 never appears inside a record.

---

## 6. `orch.yml` key reference

Config lives at `.orch/orch.yml`. A bare `orch.yml` at the repo root still works
for backward compatibility; `.orch/orch.yml` wins if both exist.

`--config-file <path>` layers a second YAML file **on top** of the repo's file
with the same deep-merge rules, for one run.

**The schema is closed.** An unknown key is an error, not a shrug:

```console
$ orch config --check
orch config: invalid
Problems:
- .orch/orch.yml: unknown key 'roudCap' (typo? see orch.example.yml).
```

`printConfigReport` always prints the `orch config: <ok|invalid>` header, then a
bulleted `Warnings:` and/or `Problems:` list — never a bare line. The prefix on
each problem names **the file the offending value came from**: `.orch/orch.yml`,
a root `orch.yml`, or `--config-file` for the overlay layer (`orch.yml:` is only
the fallback label when neither repo file exists). With config in the documented
location the prefix is `.orch/orch.yml:`, as above.

A closed schema is what makes the migration messages reachable at all: an
unknown key can only produce a helpful hint if unknown keys are noticed.

**Counts.** `load()` on an empty repo produces **41** value-bearing leaves.
Adding the deprecated alias `reviseCap` — which is in `CONFIG_KEYS` but not in
`DEFAULTS`, because it resolves through a separate code path — gives the 42
dotted paths documented below. Nine keys (`cheap`, `scope`, `security`,
`github`, `main`, `docs`, `release`, `automation`, `env`) are pure containers
holding no value of their own.

### 6.1 Top level

| Key | Type | Default | Meaning | v0.5 |
|---|---|---|---|---|
| `agents` | list of bare adapter names | `[claude, codex]` | The rotation pool. With no explicit author/reviewer, orch rotates this list for the author and takes the next entry as reviewer. Entries must be bare names with no whitespace — model and effort belong in role specs, and orch rejects `"claude claude-opus-5"` here. | current |
| `author` | role spec or `null` | `null` | Fixed author seat. Must be set together with `reviewer`. | current |
| `reviewer` | role spec or `null` | `null` | Fixed reviewer seat. Pairs with `author`. | current |
| `authors` | list of role specs or `null` | `null` | Author pool. Must be set together with `reviewers`. **Meaning changes in v0.5** — see §2.5. | current (semantics change) |
| `reviewers` | list of role specs or `null` | `null` | Reviewer pool. Pairs with `authors`. **Meaning changes in v0.5** — see §2.5. | current (semantics change) |
| `test` | string | `"auto"` | The test command the gate runs. `"auto"` detects the project's own (`npm test` and friends). | current |
| `roundCap` | int ≥ 1 | `3` | Total review **rounds** per cycle, counting the initial review as round 1 — so `3` buys 3 reviews and 2 revisions. | current |
| `reviseCap` | int ≥ 1 | *(alias)* | Deprecated spelling of `roundCap`. Warns today; **error from v0.5.0**. Resolved per source, not across the merged config: a `--config-file` that says `reviseCap` still beats an `orch.yml` that says `roundCap`, or the override would be silently dropped. Setting both warns and uses `roundCap`. | **removed** → `roundCap` |
| `stageTimeout` | int ≥ 0 (minutes) | `25` | Per-stage wall-clock cap. A stalled author or reviewer stage is killed and the cycle fails with a nonzero exit instead of hanging forever on a "still running" heartbeat. `0` disables. | current |
| `gateTimeout` | int ≥ 0 (minutes) | `25`, **inheriting `stageTimeout`** | Test-gate wall-clock cap. The resolution rule is `cfg.gateTimeout ?? cfg.stageTimeout ?? 0`, so a repo that sets `stageTimeout: 90` and never mentions `gateTimeout` gets a 90-minute gate, not 25. Fixes the case where a hung gate held `merge.lock` and pinned every other cycle in the repo. | current |
| `baseBranch` | string | `"main"` | The trunk orch reads from, diffs against, and opens the standing PR to. orch never pushes to it directly. | current |
| `integrationBranch` | string | `"orch/integration"` | The local landing target. `baseBranch` advances only via the standing PR plus a fast-forward-only fetch — a fast-forward being a merge that just moves the branch pointer, with no merge commit, which is only possible when nothing diverged. | current |
| `merge` | enum | `"no-ff"` | Old spelling of `landing`. Warns today; **hard error from v0.5.0**. | **renamed** → `landing` |
| `landing` | `ff-only \| no-ff \| pr` | `"no-ff"` | How an agreed, green cycle lands. `no-ff` and `ff-only` merge locally onto `integrationBranch`; `pr` skips local integration and opens a per-cycle PR instead. | current |
| `concurrency` | int ≥ 1 | `4` | Maximum concurrent cycles per repo directory. Over the cap a cycle **exits** (blocked, exit 3) rather than blocking — nothing was attempted, so retrying later is safe. | current |

`merge` is worth one extra sentence, because it explains why removal is cheap:
it is in `DEFAULTS` and in the deprecation map, but **not** in `CONFIG_KEYS`. It
survives today only because `collectConfigIssues` consults the removed-key map
*before* the known-key check and `continue`s past it. Delete the map entry at
v0.5 and `merge:` becomes a hard unknown-key error with no further work.

`landing:` keeps all three values in v0.5.0. `pr` is the documented, supported
opt-out: instead of merging an agreed, green cycle onto `integrationBranch`, orch
stages the branch and opens a per-cycle PR, and the change waits there for a
human. Two things kept it. It is the only way to say "audit and stage, but let me
be the one who merges" as standing policy rather than per invocation — the
proposal listed dropping it as a possible simplification, but the simplification
would have removed a governance choice, not a redundancy. And the `--pr` →
`landing: pr` migration row in §2.4 tells users to set exactly this value;
deleting it would strand that row (with the build-path caveat noted there).

### 6.2 `cheap:` — cheap-agent routing

| Key | Type | Default | Meaning | v0.5 |
|---|---|---|---|---|
| `cheap.role` | role spec or `null` | `null` | The role spec used for **both** seats when cheap routing triggers. | current |
| `cheap.paths` | list of globs | `[]` | A `--file` or `issue` work order whose `suspected_paths` **all** match one of these auto-routes to `cheap.role` without `--cheap`. | current |

Resolution happens after the work order is built and before preflight, so the
agent CLI that preflight checks for is the one the run will actually use.

### 6.3 `scope:` — diff-size gate

| Key | Type | Default | Meaning | v0.5 |
|---|---|---|---|---|
| `scope.maxLines` | int ≥ 0 | `0` (disabled) | Escalate a cycle whose diff exceeds this many changed lines, with "split the PR". | current |
| `scope.ignore` | list of globs | `["*.lock", "dist/**", "*.snap"]` | Paths excluded from the line **count**. | current |

### 6.4 `security:` — the security floor

| Key | Type | Default | Meaning | v0.5 |
|---|---|---|---|---|
| `security.ignore` | list of non-empty globs | `[]` | Paths exempt from the deterministic security scan. | current |

This is deliberately **not** `scope.ignore`. Excluding a file from a line count
is routine hygiene; excluding it from the security floor is a security decision.
Coupling them would silently widen the exemption every time somebody tuned
scope.

### 6.5 `github:`

| Key | Type | Default | Meaning | v0.5 |
|---|---|---|---|---|
| `github.mergeMethod` | `squash \| merge \| rebase` | `"squash"` | The `gh pr merge` strategy for PRs orch merges. **Scope narrows in v0.5**: per-cycle (`landing: pr`) and foreign PRs only. | current (scope narrows) |
| `github.autoMergePr` | boolean | `false` | Arm GitHub's native auto-merge on PRs orch opens or updates. | **removed** → `--until merged` |

`mergeMethod` narrowing deserves its own note. The standing PR is **always**
merged with a merge commit in v0.5 — never squash, never rebase. A squash lands
content without ancestry, and `git merge-base --is-ancestor
origin/orch/integration origin/main` is exactly the check `--until merged`
verifies with. Squashing breaks that check, and historically it also broke
branch cleanup: every `pr/*` branch became content-in-`main`-but-not-an-ancestor,
so `git branch --merged` listed none of them.

`github.autoMergePr` is removed because native auto-merge is documented in
orch's own source as not firing under ruleset `bypass_actors`, and because it
arms a merge that outlives the invocation — nobody is left watching when it
fires. It is also already partially neutered: every consumer is guarded by `&&
!v2Until`, so any run with `--until ready|merged` ignores it today. Like
`merge`, it is in `DEFAULTS` but absent from `CONFIG_CHILDREN.github`, so
deleting its deprecation-map entry turns it into a hard error for free.

### 6.6 `main:` — the whole block is removed

> **Not yet landed** (P12, #528). All five keys warn today and still work.

| Key | Type | Default | Meaning | v0.5 |
|---|---|---|---|---|
| `main.autoMerge` | boolean | `false` | Standing-config opt-in to merging the standing PR. | **removed** → `--until merged` |
| `main.autoResolveConflicts` | boolean | `false` | Opt-in agent reconciliation when the standing PR is dirty. | **removed** → the `integration-repair` remedy |
| `main.conflictResolution` | `manual \| propose \| auto` | `"manual"` | Conflict-repair mode. | **removed** → the `integration-repair` remedy |
| `main.conflictResolutionResolvers` | list of role specs or `null` | `null` | Who resolves conflicts. | **moved** → `automation.conflictResolvers` |
| `main.autoResolveConflictPaths` | list of globs | `[CHANGELOG.md, docs/index.html, package-lock.json, package.json]` | Generated paths whose conflict resolution may skip a reviewer round. | **moved** → `automation.conflictAutoPaths` |

Delete the `main:` block entirely. `CONFIG_CHILDREN.main` is already an **empty
`Set`** — every legal `main.*` key lives in the deprecation map instead — so
after v0.5 the whole block is unknown keys while `main:` itself remains in
`CONFIG_KEYS`. That has a user-visible consequence worth knowing: an unrelated
leftover such as `main: {foo: 1}` reports the terser `- .orch/orch.yml: unknown
key 'main.foo'.` with no "(typo? see orch.example.yml)" hint, because the hint
is suppressed for `main.*`.

`main.autoMerge` is removed for the same reason there is no `automation.until`
key: **a config file must never be able to turn a run the operator asked for
into a merge.** A repo that set it had opted every cycle out of the human trunk
checkpoint; under v0.5 that opt-out is spelled once per invocation.

The two conflict-mode keys have no one-to-one replacement, and the row above is
the shortest true answer rather than the whole one. What they governed is
*standing-PR* conflict auto-resolution — `src/github.js` gates it on exactly
`cfg.main.autoResolveConflicts || (cfg.main.conflictResolution &&
cfg.main.conflictResolution !== "manual")` — which becomes the
`integration-repair` remedy, and that remedy is **not** operator-orderable and
cannot be removed through `automation.remedies` (§6.9). Dropping `rebase` from
that list switches off repair of *the cycle's own branch*, a different thing.
The only complete off switch for standing-PR repair is `--until once`. The
migration guide's "`main.conflictResolution` and `main.autoResolveConflicts` are
removed" section carries the full reasoning.

### 6.7 `docs:` — post-merge documentation refresh

| Key | Type | Default | Meaning | v0.5 |
|---|---|---|---|---|
| `docs.autoUpdate` | boolean | `false` | After a successful merge, spawn a detached `orch task` to refresh documentation. Opt-in per repo. | current |
| `docs.prompt` | non-empty string | `"update documentation to reflect the latest merged changes"` | The work order that detached run receives. | current |
| `docs.paths` | list of globs | `["*.md", "docs/**", "**/*.md"]` | Docs-only globs. This is the **loop guard**: a merge whose diff is entirely within these paths does not itself trigger another docs run. | current |

### 6.8 `release:`

| Key | Type | Default | Meaning | v0.5 |
|---|---|---|---|---|
| `release.autoBump` | boolean | `false` | Patch version bump plus a CHANGELOG entry after each integrated merge. Opt-in per repo. | current |

With the default `false`, a clean merge writes neither a bump nor a CHANGELOG
line — which is why `orch release` is only relevant in repos that set this true.

### 6.9 `automation:` — the bounded loop

New block in v0.5, and the one every migrating config must add. Everything here
governs `--until ready|merged`; under `--until once` the remedy list is forced
empty and `maxAttempts` is forced to 0.

| Key | Type | Default | Meaning | v0.5 |
|---|---|---|---|---|
| `automation.maxAttempts` | int ≥ 0 | `3` | Remedy attempts **after** the first cycle. `0` means one pass with the new exit codes. Each expiry of a bounded CI wait consumes one attempt, so a run cannot wait forever even while doing nothing; an `ask` consumes none. | current (new) |
| `automation.humanWaitHours` | number, `0 < n ≤ 720` | `24` | How long the `ask` remedy waits for an authorised reply before exiting 4. | current (new) |
| `automation.mcpMayMerge` | boolean | `false` | Allow an MCP client to request `until: "merged"`. | current (new) |
| `automation.remedies` | `null` or a duplicate-free subset of `[rebase, rotate, reauthor, ask]` | `null` | Ordered remedy priority. `null` — the default — means "use the failure table's own order". Setting a list both **reorders** and **filters**: a remedy you leave out is disabled. See below. | current (new) |
| `automation.rotateModels` | map of agent → non-empty, duplicate-free list of model strings | `{}` | Model escalation ladders for the `rotate` remedy. **Live** — the remedy consumes them (see below). Keys must be whitespace-free names of adapters orch actually has, or config load throws `automation.rotateModels.<agent> names an unknown adapter`. | current (new) |
| `automation.pollSeconds` | int ≥ 1 | `30` | Initial readiness poll interval. Backs off ×2 per attempt, capped at 10 minutes. | current (new) |
| `automation.ciWaitMinutes` | int ≥ 1 | `30` | Bound on one readiness wait window before it counts as an attempt. | current (new) |
| `automation.conflictResolvers` | list of role specs or `null` | `null` | Who resolves conflicts. `null` falls back to the historical single-resolver behaviour. | replaces `main.conflictResolutionResolvers` |
| `automation.conflictAutoPaths` | list of globs | `[CHANGELOG.md, docs/index.html, package-lock.json, package.json]` | Generated paths whose conflict resolution may skip a reviewer audit round. The gate and the security scan still always run on the resolution diff. | replaces `main.autoResolveConflictPaths` |
| `automation.detachLogDir` | non-empty string | `".orch/logs"` | Where `--detach` writes a run's log. Relative paths resolve against the repo root. | current (new) |

The four **operator-orderable** remedies, listed in the order the richest
failure row offers them (`TEST_RED`). Other rows offer fewer, in their own order
— there is no single global sequence; see `automation.remedies` below. Two more
remedies exist and are outside this list entirely: `integration-repair` and
`wait` are structural, never reorderable and never disableable (§0.2).

1. **`rebase`** — the base moved, the standing PR is `BEHIND` or `CONFLICTING`,
   or a check went red. Rebase the branch under a compare-and-swap guard (read
   the current ref, then write only if it still matches — so a concurrent push
   makes the write fail loudly instead of clobbering), have the *author* fix the
   specific named failure ("fix only this; do not widen scope"), then re-audit
   and re-gate.
2. **`rotate`** — a seat crashed or hit a provider quota, or the same stalemate
   finding repeats. The exhausted agent is excluded for the rest of the run, and
   orch looks for a *different adapter* to take the seat. A rotation that would
   pick the same agent *and* model is not a rotation and is skipped. If no
   diverse adapter seat remains, the model ladder is the second chance: see
   "Model ladders" below. With the default two-agent pool and no ladder
   configured, reviewer rotation is deliberately declined and the run stops at
   cap rather than staging a fake audit.
3. **`reauthor`** — empty diff, scope exceeded, or two diverse attempts
   converging on the same failing assertion. A fresh branch from the original
   work order plus the structured failure history. It never splits into child
   runs; a human splits the issue.
4. **`ask`** — post a question on the issue (or the PR, or a draft PR opened for
   a `task` run's branch), poll for a reply from a user whose write access is
   verified through GitHub's collaborator API, honour `orch: retry [n]` /
   `orch: abandon` / free text as an addendum, and time out after
   `humanWaitHours` into exit 4.

Nothing is ever done autonomously at any goal or config setting: touching a
guardrail path, bypassing branch protection, force-pushing any ref, merging with
red or pending checks, merging without binding to the observed head SHA, taking
merge authority from a chat comment (`orch: merge` is not a command), or editing
a diff to evade the security scanner.

#### `automation.remedies` — the default is `null`, and what that means

The shipped default is `null` (`src/config.js:60`), not a list. `null` does not
mean "no remedies"; it means **"use the failure table's own order"** — and that
order is per failure class, not one global sequence. `TEST_RED` offers `rebase,
rotate, reauthor, ask`; `SCOPE_EXCEEDED` offers only `reauthor, ask`;
`REMOTE_REVIEW_REQUIRED` offers only `ask`. There is no single list that could
be the default without flattening those rows into a lie.

Setting a list does two things at once, and both matter:

- **It reorders.** Your order wins over the row's hard-coded order, for the four
  operator-orderable remedies only. `integration-repair` and `wait` are not in
  the orderable set and keep their fixed position in the row — `ready` has no
  other path to its goal, so they can never be reordered away or disabled.
- **It filters.** A remedy you leave out is removed from every row that offered
  it.

Which answers the obvious follow-up: **`ask` is not a floor.** Omit it and the
loop simply runs out of options sooner. (All of this is scoped to `--until
ready|merged`. Under `--until once` the remedy list is forced empty and
`maxAttempts` to 0 regardless of what you configured, so there is no ladder to
remove `ask` from.) `chooseRemedy` filters `allowed` down to
your list, and `if (!allowed.length) return terminalDecision(row)` yields the
row's terminal outcome — `STOPPED_AT_CAP` for every row that had no explicit
`terminal:` — so the run exits **2** where it would have exited 4. The same
substitution happens at the two places that otherwise reach for `ask` as a
backstop: three consecutive identical failure fingerprints, and exhausting
`maxAttempts`. Rows whose *only* remedy is `ask` (`TEST_MISSING`,
`REMOTE_REVIEW_REQUIRED`, `REMOTE_PR_CLOSED`, `REMOTE_UNKNOWN`,
`LAND_PR_OPEN_FAILED`) become immediately terminal.

That is a legitimate configuration — it is how you say "never post a question on
my repo's issues; stop and let me poll `orch dashboard` instead" — but exit 2 is
resumable and silent, where exit 4 arrives with a question already asked. Drop
`ask` only if something else is watching for the stop.

One document disagrees with the code here and should be corrected at its own
source, not by changing this page: `docs/cli-v2-design.md` §15 prints the literal
`[rebase, rotate, reauthor, ask]` as the default. `src/config.js:60` is what
runs. (`orch.example.yml:128` is **not** part of that problem — it already reads
`remedies: null  # … default: fallback order` and needs no fix.) The difference
is not cosmetic: writing that list out changes behaviour on at least one row.
`DIFF_EMPTY` offers `reauthor, rotate, ask`, deliberately — an empty diff wants a
fresh attempt at the same work before it wants a different agent. Set the literal
list and the operator's order wins, so `rotate` is tried first instead. Anyone
who copies that "default" out of the design doc into their own config silently
changes what orch does on an empty diff.

#### Model ladders — `automation.rotateModels`, and how pinning composes

A ladder is a per-agent list of model ids that `rotate` climbs when it cannot
find a different adapter to hand the seat to:

```yaml
automation:
  rotateModels:
    claude: [claude-sonnet-5, claude-opus-5]
    codex: [gpt-5.6-luna, gpt-5.6-sol]
```

It is the **second-tier** fallback, not a peer of agent rotation. `rotate` first
tries to give the failed seat to a different adapter; only when no diverse seat
remains does it keep the failed agent and advance that agent's model one rung.
When the ladder is exhausted, the agent itself is excluded and the run takes the
ordinary degraded-terminal path — so a ladder buys extra attempts, it does not
make a run unstoppable.

**Pinning a model does not opt a seat out of rotation.** A seat that names its
model — `--author "claude claude-sonnet-5"`, or a fixed `author:` in config —
still escalates, and the ladder resumes **at the entry after the pinned one**.
Pin `claude-sonnet-5` in the ladder above and the first escalation moves to
`claude-opus-5`; pin `claude-opus-5` and there is no rung left, so the seat
rotates by adapter or the run degrades. The two features compose: the pin
chooses where you start, the ladder chooses where you go from there.

Two conditions silently produce no model rotation, and both are worth checking
before concluding a ladder is broken. The adapter must declare
`capabilities.model` — an adapter whose CLI takes no model argument cannot be
rotated by model. And **a pinned model absent from that agent's ladder yields
nothing**: orch will not guess where in the list you meant to be, so it returns
no next rung at all. If you pin models, pin ones the ladder contains.

> Landed on `orch/integration`, not on `main`: `d8c0c7e` ("fix(rotate): use
> configured model ladders"), merged as `4850610` (Closes #567), plus five
> follow-up fixes making exclusions model-scoped. On `main` (v0.4.360) the key
> is still validated and inert.

### 6.10 `env:`

| Key | Type | Default | Meaning | v0.5 |
|---|---|---|---|---|
| `env.passthrough` | list of valid environment-variable names (`^[A-Z_][A-Z0-9_]*$`) | `[]` | Extra environment variables to forward to adapter subprocesses. **Validated but inert** — nothing wires it into `allowlistEnv` yet. | current (new, inert) |

Validation refuses `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN` and
anything starting with `ORCH_APP_`, so the key cannot be used to hand an agent
orch's own GitHub credentials.

### 6.11 Migration summary

| Old | New |
|---|---|
| `merge:` | `landing:` (same values) |
| `reviseCap:` | `roundCap:` (same meaning) |
| `main.autoMerge:` | `--until merged` per run |
| `github.autoMergePr:` | `--until merged` per run |
| `main.conflictResolution:` / `main.autoResolveConflicts:` | the `integration-repair` remedy — no config off switch; `--until once` is the only one (§6.6) |
| `main.conflictResolutionResolvers:` | `automation.conflictResolvers:` |
| `main.autoResolveConflictPaths:` | `automation.conflictAutoPaths:` |
| the `main:` block | delete it |

The three renames are safe to do **today**: v0.4.360 already carries both
spellings in `DEFAULTS` with identical defaults, and the new spelling already
wins at load time. Rename now and the 0.5.0 upgrade is a no-op for those keys.

---

## 7. Environment variables

Two separate lists. They answer different questions, and conflating them is how
"my agent cannot authenticate" turns into an afternoon.

### 7.1 Variables orch itself reads

| Variable | Effect |
|---|---|
| `ORCH_DRYRUN` | `=1` behaves exactly like `--dry` on every command that honours the flag. Read as `Boolean(flags.dry) \|\| process.env.ORCH_DRYRUN === "1"`, so it composes with the flag rather than fighting it. |
| `ORCH_STAGE_TIMEOUT_MS` | Overrides the per-stage wall-clock cap in **milliseconds**, winning over `stageTimeout`. |
| `ORCH_PROGRESS_INTERVAL_MS` | How often the "still running" heartbeat prints while an agent stage is in flight. |
| `ORCH_APP_ID` | GitHub App id. With `ORCH_APP_PRIVATE_KEY`, orch mints a repo-scoped installation token into `GH_TOKEN` for its own `gh` shell-outs. |
| `ORCH_APP_PRIVATE_KEY` | The App private key (PEM, or a path to one). |
| `ORCH_NO_UPDATE_CHECK` | Any truthy value suppresses the background update check. `NO_UPDATE_NOTIFIER`, `CI` and a non-TTY stdout under `--json` suppress it too. |
| `GH_TOKEN` | Used by `gh` for orch's own GitHub calls. If orch mints an App token it sets this itself. **Never forwarded to an agent.** |
| `NO_COLOR` | Any value disables ANSI colour in orch's own output. |

Two more are **orch-internal**: `ORCH_DETACHED` and `ORCH_DETACH_LOG` are set by
the `--detach` parent on the child it spawns. Do not set them by hand — a
process that claims to be a detached child but is not will skip the detach
branch and misreport its handle.

### 7.2 Variables orch forwards to adapter subprocesses

Adapter subprocesses run **untrusted** code. The security scan inspects the diff
an agent *writes*; it never sees what an agent can *read* from its own
environment. So the child gets a freshly built, allowlisted environment rather
than a copy of `process.env`. Allowlist, not blocklist — a blocklist covers only
the one credential whoever wrote it thought of, and leaves every other ambient
secret exposed.

**Exact names forwarded** (`ENV_ALLOW`, `src/adapters/cli-adapter.js`):

```
PATH HOME USER LOGNAME SHELL LANG TERM TMPDIR TMP TEMP TZ
SSH_AUTH_SOCK SSL_CERT_FILE SSL_CERT_DIR NODE_EXTRA_CA_CERTS
HTTP_PROXY HTTPS_PROXY NO_PROXY ALL_PROXY
SYSTEMROOT WINDIR SYSTEMDRIVE PATHEXT COMSPEC USERPROFILE
HOMEDRIVE HOMEPATH APPDATA LOCALAPPDATA PROGRAMDATA PROGRAMFILES
PROGRAMFILES(X86) PROCESSOR_ARCHITECTURE NUMBER_OF_PROCESSORS
```

**Prefixes forwarded** (`ENV_ALLOW_PREFIXES`):

```
LC_ XDG_ GIT_AUTHOR_ GIT_COMMITTER_
ANTHROPIC_ CLAUDE_ OPENAI_ CODEX_ GEMINI_ GOOGLE_
XAI_ GROK_ KIMI_ MOONSHOT_ COPILOT_ ZAI_ CCR_
```

Names are matched case-insensitively (uppercased for the test, original casing
preserved), because Windows environment names are case-insensitive in
`process.env` but not in a plain object copy.

**Deliberately absent, and why:**

| Excluded | Reason |
|---|---|
| `GH_TOKEN`, `GITHUB_TOKEN` | orch mints a repo-scoped GitHub App installation token into `GH_TOKEN` for its own `gh` calls. An author agent executing an untrusted work order could otherwise `printenv` and exfiltrate it, and the diff-based security floor would never see it. |
| `NODE_OPTIONS` | Code injection into the Node-based agent CLIs. |
| `ORCH_*` | Only ever read in the parent process. |

This is least privilege, not a sandbox. The agent still has `HOME` and `PATH`
and can invoke the operator's own logged-in `gh`.

**Practical consequence.** An adapter that relied on some other ambient variable
stops working, and a GitHub Copilot setup that authenticated via `GH_TOKEN` must
either use `copilot login` (which persists under `HOME`) or export a separate
Copilot-scoped `COPILOT_GITHUB_TOKEN`.

An adapter may still add or delete specific variables for its own child
(`mergeAdapterEnv` runs after the allowlist, so an adapter setting
`ANTHROPIC_API_KEY: undefined` deletes a key that survived the filter).

---
