# Proposal: interactive `orch config` wizard (`--config-file <file.yml>`)

> Status: **proposal / issue spec** — no implementation in this change. This file is
> the body of the tracking issue so the design has a durable, reviewable home in-repo.

## 1. Problem

Today the only way to create an `orch.yml` is to hand-write it. A new user has to
read `docs/orch-manual.md`, copy `orch.example.yml`, and remember which of ~22 keys
are enums (and what the legal values are), which are booleans, which pair up
(`author`+`reviewer`, `authors`+`reviewers`), and what each default means. Get one
value wrong and the *only* feedback is a hard error at run time from `validate()` in
`src/config.js` (`Error("orch.yml: ...")`), which aborts the whole run.

That is a poor first-run experience for an educational tool whose whole point is to be
approachable. We want the same "just answer the prompts" feel that `claude`'s own
setup flow has: an arrow-key picker where each choice is explained as you land on it,
and you commit with Enter.

## 2. What already exists (so we build the *minimum*)

Three pieces are already in the tree and should be **reused, not rebuilt**:

- **`--config-file <file.yml>` flag** — already parsed in `src/cli.js` (`parseArgs`,
  `"config-file": { type: "string" }`). Today it is *passive*: it layers an existing
  YAML file on top of `orch.yml` for one run. The wizard should use this same flag to
  name the file it **writes**, so the surface stays consistent: the flag always means
  "the config file this invocation is about."
- **Raw-mode keypress engine** — `src/tui/input.js` (shipped in #222). `normalizeKey()`
  already turns Node readline keypress events into `{type:"up"|"down"|"enter"|"esc"|...}`,
  handles arrows, Enter, Esc, Ctrl-C, and is a **no-op on non-TTY**. `start(stdin, onKey)`
  enters/leaves raw mode and returns a `stop()`. This is exactly the arrow-key + Enter
  primitive the task asks for — it exists but is **not yet wired to any command**. The
  wizard is its first real consumer.
- **`validate(cfg)`** — `src/config.js`. The error gate. The wizard must run every
  candidate config through it before writing, so an invalid file can never be saved.
- **theme** — `src/tui/theme.js` (`paint`, `C`, `box`) for consistent coloring, and
  `yaml`'s `stringify` (already a dep) to serialize the result.

Nothing new needs adding to `package.json` (single dep `yaml` stays single).

## 3. Proposed UX

New command: **`orch config`** (alias verb; `orch init` may map to the same wizard).

```
orch config [--config-file <path>]   # default path: .orch/orch.yml
```

Flow, one option per screen, Claude-Code style:

```
┌─ orch config ─────────────────────────────── 4/22 ─┐
│ merge strategy                                      │
│                                                     │
│   ‹ ff-only    [ no-ff ]    pr ›                     │
│                                                     │
│ How each green cycle lands on the integration       │
│ branch. no-ff (default) keeps a merge commit per    │
│ cycle so history shows what orch did; ff-only is    │
│ linear but fails if the branch moved; pr opens one  │
│ PR per cycle and skips local integration entirely.  │
└─────────────────────────────────────────────────────┘
  ← → change   ⏎ confirm   esc back   q quit
```

Interaction rules (all via `src/tui/input.js` events):

- **Enum options** (`merge`, `github.mergeMethod`): Left/Right arrow cycles the
  candidate values; the current value is bracketed; **Enter** confirms and advances.
- **Boolean options** (`github.autoMergePr`, `main.autoMerge`, `docs.autoUpdate`):
  same Left/Right toggles `false`/`true`.
- **Numeric / text / list options** (`reviseCap`, `stageTimeout`, `test`,
  `baseBranch`, `agents`, `cheap.paths`, ...): fall back to a **cooked-mode line
  prompt** (the existing `readline.question` path used by `realIo().confirm` in
  `src/cli.js`) pre-filled with the default; Enter keeps the default. Arrow keys are
  only claimed to make sense for discrete choices — don't fake a picker over free text.
- **Per-option explanation** is mandatory and updates live as the selection changes —
  this is the core ask: *"each option change need to have explanation."* Text comes
  from an option catalog (below), not scattered strings.
- **Esc** = back one option, **Ctrl-C / q** = quit without writing.

## 4. Error gate

Before writing anything:

1. Assemble the answered values into a candidate config object (merged over `DEFAULTS`).
2. Run it through `validate(cfg)`.
3. If it throws, show the message in the box and re-prompt the offending option instead
   of crashing. **A file is only written when `validate` passes** — the wizard can never
   produce an `orch.yml` that a normal run would reject.

This reuses the *exact* validator the runtime uses, so the wizard and the engine can
never disagree about what "valid" means.

## 5. Save

- Serialize with `yaml.stringify(cfg)`.
- Write to `--config-file` path, default `.orch/orch.yml`.
- If the target exists, **load it first** so the wizard pre-selects the user's current
  values (edit, don't clobber), and confirm before overwrite.
- Emit only keys that differ from `DEFAULTS`, so the saved file stays small and readable
  (optional nicety; full-dump is acceptable for v1).

## 6. Option catalog (drives the prompts)

The wizard iterates a single ordered list. Each entry: key, widget, choices/validator,
default, and the explanation string. Source of truth for defaults/types is `DEFAULTS`
and `validate()` in `src/config.js`.

| Key | Widget | Choices / type | Default |
|---|---|---|---|
| `agents` | list | comma string → string[] (non-empty) | `claude,codex` |
| `author` / `reviewer` | text pair | role spec or blank (both-or-neither) | `null` |
| `authors` / `reviewers` | list pair | role-spec list (both-or-neither) | `null` |
| `test` | text | command or `auto` | `auto` |
| `reviseCap` | number | int ≥1 | `3` |
| `stageTimeout` | number | int ≥0 (minutes, 0=off) | `25` |
| `baseBranch` | text | non-empty | `main` |
| `integrationBranch` | text | non-empty | `orch/integration` |
| `merge` | **enum** | `ff-only` / `no-ff` / `pr` | `no-ff` |
| `concurrency` | number | int ≥1 | `4` |
| `cheap.role` | text | role spec or blank | `null` |
| `cheap.paths` | list | glob list | `[]` |
| `scope.maxLines` | number | int ≥0 (0=off) | `0` |
| `scope.ignore` | list | glob list | `*.lock,dist/**,*.snap` |
| `github.mergeMethod` | **enum** | `squash` / `merge` / `rebase` | `squash` |
| `github.autoMergePr` | **bool** | true / false | `false` |
| `main.autoMerge` | **bool** | true / false | `false` |
| `docs.autoUpdate` | **bool** | true / false | `false` |
| `docs.prompt` | text | non-empty | `update documentation to reflect the latest merged changes` |
| `docs.paths` | list | glob list | `*.md,docs/**,**/*.md` |

Each row also carries a 1–3 sentence explanation (see the `merge` mock above for the
tone) — teaching *why*, not just restating the key name. These strings can live next to
`DEFAULTS` so they stay in sync when options change.

## 7. Non-TTY fallback

`src/tui/input.js.start()` is already a no-op when stdin isn't a TTY. If `orch config`
runs without a TTY (CI, piped), it must **not** hang waiting for arrows: either error
out with "interactive config needs a TTY" or accept `--yes`/piped answers. v1 can simply
require a TTY and exit non-zero with a clear message otherwise.

## 8. Scope

**In scope (v1):** the `orch config` command; enum + boolean arrow pickers wired to
`src/tui/input.js`; text/list fallbacks; live per-option explanations; `validate()` gate;
write to `--config-file`/`.orch/orch.yml`; edit-existing pre-fill; non-TTY guard.

**Out of scope:** editing role-spec model/effort with its own sub-picker (plain text is
fine); a full-screen TUI with scrolling/mouse; validating `agents` element types beyond
non-empty (matches current `validate` behavior); changing what `--config-file` does for
normal runs.

## 9. Acceptance criteria

- `orch config` walks every key in §6; arrows change enum/bool values and the explanation
  updates on each change; Enter advances; Esc goes back; Ctrl-C/q aborts without writing.
- A completed run writes a YAML file that `validate()` accepts and that a normal
  `orch run` loads without error.
- Feeding an invalid value re-prompts that option instead of crashing, and no file is
  written until the whole config passes `validate()`.
- Re-running against an existing file pre-selects current values and confirms before
  overwrite.
- Non-TTY invocation exits with a clear message, never hangs.

## 10. Testing notes

- Unit-test the option catalog ↔ `DEFAULTS`/`validate` consistency (every catalog key
  exists in `DEFAULTS`; every enum's choices match what `validate` accepts).
- Unit-test the pure "apply keypress to selection" reducer for enum/bool widgets (given
  current value + `left`/`right`, returns next value) — no TTY needed, mirrors how
  `src/tui/input.test.js` tests `normalizeKey` in isolation.
- Test that assembling answers + `validate` rejects a known-bad combo and that a good
  combo round-trips through `yaml.stringify` → `load()`.
