// The command schema: one declaration of every command and flag, consumed by
// the parser (src/cli.js), the help renderer, and bash completion
// (src/completion.js). Before this file each command read whatever flags it
// happened to care about, so a flag that did not apply was silently dropped
// rather than refused — "nobody read your flag" instead of "your flag was
// rejected". Declaring the flag set makes that a parse-time error (exit 64,
// the BSD/sysexits convention for a usage error).
//
// Order matters: FLAGS and COMMANDS are rendered into `orch --help` in
// declaration order, so `help` comes first.

import { get as getAdapter } from "./adapters/index.js";
import { parseRoleSpec, parseRoleSpecs } from "./config.js";
import { isSafeSid } from "./sid-store.js";

// Flags. `type` is the parseArgs type plus two refinements the parser
// enforces itself: "int" (positive integer unless `min` says otherwise) and
// "enum" (`values`). `label` overrides the left column in the Options block;
// `help: null` hides the flag from help (an alias documented on another line).
export const FLAGS = {
  help: { type: "boolean", short: "h", label: "-h, --help", help: "Show this help." },
  version: { type: "boolean", help: "Print the version." },
  author: { type: "string", arg: "<role>", help: 'Set author as "<agent> [model] [effort]".' },
  authors: { type: "string", arg: "<roles>", help: "Set comma-separated authors; each gets a branch." },
  reviewer: { type: "string", arg: "<role>", help: 'Set reviewer as "<agent> [model] [effort]".' },
  reviewers: { type: "string", arg: "<roles>", help: "Set comma-separated reviewers." },
  cheap: { type: "boolean", help: "Use cheap.role; cheap.paths can auto-route work orders." },
  file: { type: "string", arg: "<file>", help: "With task, read the work order from a JSON file." },
  "config-file": { type: "string", arg: "<file>", help: "Config YAML path; with config / agent add, write there." },
  "allow-protected": { type: "boolean", help: "Run even if the work order names a protected path." },
  "allow-large-scope": { type: "boolean", help: "Sanction a deliberately large review slice for this run." },
  dry: { type: "boolean", help: "Plan without shelling out or changing git." },
  until: {
    type: "enum", values: ["once", "ready", "merged"], arg: "<mode>",
    help: "once (default); ready waits on PR; merged: readiness.",
  },
  check: { type: "boolean", help: "With upgrade, check latest version without installing." },
  link: { type: "boolean", help: "With init, link .orch/ORCH.md from agent docs." },
  build: { type: "boolean", help: "With agent add, build the adapter without asking." },
  "no-banner": { type: "boolean", help: "Hide the run banner." },
  "no-tidy": { type: "boolean", help: "Leave task branches and checkouts after merge." },
  json: { type: "boolean", help: "Print JSON events (dashboard: a snapshot)." },
  limit: { type: "int", arg: "<n>", help: "With dashboard, limit history rows." },
  "check-history": { type: "boolean", help: "Dashboard: show stale red rows resolved (view only)." },
  once: { type: "boolean", label: "--once, --plain", help: "Dashboard: force the static one-shot print." },
  plain: { type: "boolean", help: null },
  "refresh-ms": { type: "int", arg: "<n>", help: "Dashboard: live TUI poll interval ms (default 1000)." },
  merge: { type: "boolean", help: "With pr, merge approved PRs." },
  pr: { type: "boolean", help: "With agent build, open a PR instead." },
};

// Legal on every command: --help/--version describe the tool rather than run
// it. --json is NOT global — only `dashboard` reads it, so it is declared on
// that command's flag list instead.
export const GLOBAL_FLAGS = ["help", "version"];

// Flags shared by the commands that run an author/review/test cycle.
const RUN_FLAGS = [
  "config-file", "dry", "no-tidy", "no-banner", "until",
  "allow-large-scope", "author", "authors", "reviewer", "reviewers",
];

// `agent add` and `agent build` are one COMMANDS entry (one positional shape,
// one help block) but NOT one flag set: --build on `agent build` is redundant
// (the subcommand already says so), and --pr/author/reviewer overrides only
// mean something when a build actually happens, which a plain `agent add`
// never does. This is the declaration `validateAgentArgs` and the completion
// renderer both read; `COMMANDS.agent.flags` is their union so a flag legal on
// either subcommand still validates on the bare command name (needed by the
// generic per-command matrix test, which has no subcommand to key off).
export const SUBCOMMAND_FLAGS = {
  "agent add": ["config-file", "dry", "build"],
  "agent build": ["config-file", "dry", "pr", "allow-large-scope", "author", "authors", "reviewer", "reviewers"],
};

// Commands. `flags` is what the command actually reads — anything else typed
// on it is a usage error, not a silent no-op. `mutates: false` marks a
// read-only command, which is what makes `--dry` on it meaningless rather than
// merely unsupported. `rows` is the command's help text (a command can render
// more than one row, e.g. `agent add` / `agent build`).
export const COMMANDS = {
  init: {
    mutates: true, flags: ["config-file", "dry", "link"],
    rows: [["init", "Scaffold .orch/orch.yml and .orch/ORCH.md."]],
  },
  // Mutating: runConfigWizard creates .orch/ and writes orch.yml. cli.js
  // already has a --dry handler for it (prints what it would write instead of
  // running the wizard) — --dry belongs in this command's own flags so that
  // handler is reachable instead of being rejected before it ever runs.
  config: {
    mutates: true, flags: ["config-file", "dry"],
    rows: [["config", "Interactively create or edit an orch YAML config."]],
  },
  agent: {
    mutates: true, flags: [...new Set([...SUBCOMMAND_FLAGS["agent add"], ...SUBCOMMAND_FLAGS["agent build"]])],
    rows: [
      ["agent add <name>", "Add a registered agent to the rotation pool."],
      ["agent build <name>", "Scaffold an adapter via orch's author/audit/test loop."],
    ],
  },
  task: {
    mutates: true, flags: [...RUN_FLAGS, "file", "cheap", "allow-protected", "json"],
    rows: [
      ['task "change"', "Run a cycle and update orch/integration on merge."],
      ["task --file <file>", "Run a cycle from an untrusted JSON work order."],
    ],
  },
  issue: {
    mutates: true, flags: [...RUN_FLAGS, "cheap", "allow-protected", "json"],
    rows: [["issue <number>", "Run from a GitHub issue and close it on merge."]],
  },
  review: {
    // No --author/--authors or --no-tidy: review audits an existing branch's
    // author (read off the branch name) and never merges, so nothing reads
    // them — accepting and ignoring them is the exact lie this schema exists
    // to remove. --reviewer(s)/--cheap ARE honoured (they pick who audits).
    mutates: true, flags: [...RUN_FLAGS.filter((f) => !["no-tidy", "author", "authors"].includes(f)), "cheap", "json"],
    rows: [["review <branch>", "Audit an existing branch without merging."]],
  },
  continue: {
    // No --author: the branch's commits were authored by a specific agent
    // already, and `continue` resumes that run rather than starting a new one —
    // accepting the flag and ignoring it is the exact lie this schema removes.
    // --reviewer(s) IS honoured (see the `continue` handler in cli.js).
    mutates: true, flags: [...RUN_FLAGS.filter((f) => !["no-banner", "author", "authors"].includes(f)), "json"],
    rows: [["continue <sid>", "Resume an interrupted/stalled cycle from its checkpoint."]],
  },
  // No --author/--authors: pr audits an existing PR/branch, it never assigns
  // an author. applyRoleOverrides is called with allowReviewerOnly, so a
  // passed --author would be silently ignored. Accepting the flag would be
  // the exact "nobody read your flag" lie this schema exists to remove.
  // `--until once|ready|merged` is handled by the unified PR path in cli.js;
  // `--merge` remains a compatibility alias until the P12 clean break.
  pr: {
    mutates: true, flags: ["config-file", "dry", "merge", "until", "allow-large-scope", "reviewer", "reviewers", "json"],
    rows: [["pr <number|branch>", "Review a PR/branch; --until controls readiness."]],
  },
  release: {
    mutates: true, flags: ["dry"],
    rows: [['release "entry"', "Bump version + CHANGELOG by hand (autoBump repos only)."]],
  },
  dashboard: {
    mutates: false, flags: ["json", "limit", "check-history", "once", "plain", "refresh-ms"],
    rows: [["dashboard", "Live status TUI; --once prints the static one-shot."]],
  },
  mcp: {
    mutates: false, flags: [],
    rows: [["mcp", "Serve orch as an MCP server over stdio (for AI clients)."]],
  },
  upgrade: {
    mutates: true, flags: ["check", "dry"],
    rows: [["upgrade, update", "Self-update the global npm install."]],
  },
  update: { mutates: true, flags: ["check", "dry"], rows: [] }, // alias, documented on upgrade's row
  completion: {
    // `completion install` writes ~/.orch/completion.bash, so it needs --dry
    // like every other mutating command. `completion [bash]` only prints —
    // validatePositionals below rejects --dry there instead of letting it
    // through as a silent no-op on the one subcommand it doesn't apply to.
    mutates: true, flags: ["dry"],
    rows: [
      ["completion [bash]", "Print the bash completion script (default: bash)."],
      ["completion install", "Write the completion script to ~/.orch/completion.bash."],
    ],
  },
  version: {
    mutates: false, flags: [],
    rows: [["version", "Print the version (same as --version)."]],
  },
  help: {
    mutates: false, flags: [],
    rows: [["help", "Show this help."]],
  },
};

// Internal re-exec target (see cli.js's update-check spawn) — never typed by a
// user. Kept OUT of COMMANDS deliberately: COMMANDS feeds --help and tab
// completion (Object.keys(COMMANDS)), and this command has nothing to
// document or complete. But "not in COMMANDS" used to also mean "not
// validated" — a command with no schema at all skipped validate() entirely,
// so a stray flag on its argv (there never should be one) would have been
// silently accepted rather than refused like every real command.
const INTERNAL_COMMANDS = { "__update-check-child": { mutates: false, flags: [] } };

// Subcommand words, for completion. Derived nowhere else: these are positional
// literals, not flags.
export const SUBCOMMANDS = { agent: ["add", "build"], completion: ["bash", "install"] };

// Build-only flags: legal on `agent build` (SUBCOMMAND_FLAGS above) but not on
// `agent add`. They mean something on `add` only while `--build` is about to
// scaffold a genuinely unregistered adapter; a name orch already has code for
// never builds regardless of `--build` (see cli.js), so they are always inert
// there too.
const AGENT_BUILD_ONLY_FLAGS = SUBCOMMAND_FLAGS["agent build"].filter(
  (f) => !SUBCOMMAND_FLAGS["agent add"].includes(f),
);

const EXAMPLES = [
  "orch init --link",
  'orch task "add input validation" --reviewer "codex"',
  "orch task --file work-order.json --cheap",
  "orch issue 42",
  'orch release "hand-landed guardrail fix (closes #N)"',
  "orch dashboard --json --limit 5",
];

// A usage error: bad flag, bad value, unknown command. Exit 64 (sysexits
// EX_USAGE) instead of the catch-all 1, so a script can tell "you typed it
// wrong" from "the run failed". bin/orch.js reads `.exit`.
export function usageError(message, extra = {}) {
  return Object.assign(new Error(message), { exit: 64, ...extra });
}

// parseArgs options, derived: "int"/"enum" are our refinements, and parseArgs
// only knows boolean/string.
export const PARSE_OPTIONS = Object.fromEntries(
  Object.entries(FLAGS).map(([name, f]) => [
    name,
    { type: f.type === "boolean" ? "boolean" : "string", ...(f.short ? { short: f.short } : {}) },
  ]),
);

// Per-command flag lists, derived (what each command reads).
export const COMMAND_FLAGS = Object.fromEntries(
  Object.entries(COMMANDS).map(([name, c]) => [name, c.flags]),
);

function validateValue(name, raw) {
  const spec = FLAGS[name];
  // `--file=` / `--config-file=` parse to an empty string, which every caller
  // then reads with a truthiness check (`if (flags.file)`) — so an explicitly
  // empty value was silently treated the same as an absent one instead of
  // being refused. An empty value is never meaningful for any flag that takes
  // one, so reject it here once instead of per-flag at each call site.
  if (raw === "") {
    throw usageError(`--${name} requires a non-empty value`);
  }
  if (spec.type === "int") {
    const min = spec.min ?? 1;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min) {
      throw usageError(`--${name} must be a ${min > 0 ? "positive" : "non-negative"} integer`);
    }
  }
  if (spec.type === "enum" && !spec.values.includes(raw)) {
    throw usageError(`--${name} must be one of: ${spec.values.join(", ")}`);
  }
}

// Every flag the command does not read is rejected, with a pointer to where it
// IS legal. --help/--version short-circuit main() before any command runs, so
// they are the *effective* command whenever present: `orch pr 42 --merge
// --help` would otherwise print usage and exit 0 having merged nothing.
// Commands with no schema entry (unknown input, which falls through to usage)
// are not validated here — main()'s fall-through rejects them.
export function validate(command, flags) {
  const effective = flags.help ? "help" : flags.version ? "version" : command;
  const spec = COMMANDS[effective] || INTERNAL_COMMANDS[effective];
  if (!spec) {
    // No command at all (bare `orch --merge`) used to fall through main()'s
    // no-command branch and print usage with exit 0 — the flag was silently
    // dropped rather than refused. A flag needs a command to be legal on.
    if (!effective) {
      for (const name of Object.keys(flags)) {
        if (GLOBAL_FLAGS.includes(name)) continue;
        const valid = Object.keys(COMMANDS).filter((c) => COMMANDS[c].flags.includes(name));
        throw usageError(
          `--${name} requires a command` +
          (valid.length ? ` — only with: ${valid.map((c) => `orch ${c}`).join(", ")}` : " — it is not a flag of any command"),
        );
      }
    }
    return;
  }
  for (const [name, value] of Object.entries(flags)) {
    if (GLOBAL_FLAGS.includes(name) || spec.flags.includes(name)) {
      if (value !== true && value !== false) validateValue(name, value);
      continue;
    }
    if (name === "dry" && spec.mutates === false) {
      throw usageError(`--dry has no effect on 'orch ${effective}' — it changes nothing`);
    }
    const valid = Object.keys(COMMANDS).filter((c) => COMMANDS[c].flags.includes(name));
    throw usageError(
      `--${name} is not valid with 'orch ${effective}'` +
      (valid.length ? ` — only with: ${valid.map((c) => `orch ${c}`).join(", ")}` : " — it is not a flag of any command"),
    );
  }
  // --until ready|merged (design docs/cli-v2-design.md §6/§9) drives the run
  // controller. `continue` is still on the legacy path; PRs now share the
  // controller with task/issue/review.
  if (flags.until && flags.until !== "once" && effective === "continue") {
    throw usageError(`--until ${flags.until} is not yet available with 'orch ${effective}' — only --until once (the default)`);
  }
  if (effective === "pr" && flags.merge && flags.until && flags.until !== "merged") {
    throw usageError(`--merge is an alias for --until merged and cannot be combined with --until ${flags.until}`);
  }
  // --json on a run command only makes sense once `--until` puts the run
  // through the controller's event stream (P5); on the bare/`once` path
  // there is nothing to stream, so accepting it would be another silent no-op.
  if (flags.json && ["task", "issue", "review", "pr"].includes(effective) && (!flags.until || flags.until === "once")) {
    throw usageError(`--json on 'orch ${effective}' requires --until ready (or merged) — the once path has no event stream to print`);
  }
  // `--cheap` picks cfg.cheap.role for both roles; combined with an explicit
  // --author/--reviewer it's ambiguous which one wins. cli.js's
  // applyCheapOverride already rejected this, but only after the command had
  // already fetched a GitHub issue / minted an app token — a real side effect
  // paid for before a usage error that was always coming. Flag-only, so it
  // belongs here, ahead of every side effect main() runs.
  if (flags.cheap && (flags.author != null || flags.authors != null || flags.reviewer != null || flags.reviewers != null)) {
    throw usageError("--cheap cannot be combined with --author/--authors/--reviewer/--reviewers");
  }
  // --author + --authors (or --reviewer + --reviewers) together used to pick
  // the plural silently and drop the singular, only caught deep inside
  // cli.js's applyRoleOverrides — after the update-check network call and the
  // GitHub App token mint had already run. Flag-only, so it belongs here too.
  if (flags.author != null && flags.authors != null) {
    throw usageError("set --author or --authors, not both");
  }
  if (flags.reviewer != null && flags.reviewers != null) {
    throw usageError("set --reviewer or --reviewers, not both");
  }
  // An unregistered/misspelled agent in --author(s)/--reviewer(s) used to
  // surface deep inside preflight() — after the same update-check network
  // call and GitHub App token mint above had already run for a run that was
  // always going to be refused. parseRoleSpec/parseRoleSpecs already call
  // getAdapter and throw for an unknown agent; run them here too, flag-only,
  // ahead of every side effect.
  for (const [name, parser] of [["author", parseRoleSpec], ["reviewer", parseRoleSpec], ["authors", parseRoleSpecs], ["reviewers", parseRoleSpecs]]) {
    if (flags[name] == null) continue;
    try { parser(flags[name]); }
    catch (e) { throw usageError(`--${name}: ${e.message}`); }
  }
  // `task`/`issue` are the only commands whose schema legally carries all
  // four role flags (see COMMANDS above): --reviewer(s) alone is meaningful
  // there ("rotate author, force this reviewer" — cli.js's
  // applyRoleOverrides passes allowReviewerOnly for these), but --author(s)
  // alone is not — cli.js used to reject it only once applyRoleOverrides ran,
  // deep inside the command handler, after the same update-check/token-mint
  // side effects above.
  if (["task", "issue"].includes(effective)) {
    const authorSet = flags.author != null || flags.authors != null;
    const reviewerSet = flags.reviewer != null || flags.reviewers != null;
    if (authorSet && !reviewerSet) {
      throw usageError("set both --author(s) and --reviewer(s), or neither");
    }
  }
}

// [min, max, usageOnMissing] non-flag arguments after the command word. The
// third element is the same "usage: ..." message main() used to throw itself,
// deep inside each command's own handler — moved up here so a missing
// required positional fails before the GitHub App token mint and preflight
// checks main() runs ahead of every command, not after them. `agent` is
// handled separately below (its shape depends on the subcommand). Commands
// absent here (unknown input) are left to main()'s unknown-command
// fall-through. `task` has no min: its positional is optional (--file
// supplies the task instead), and that's a cross-flag rule main()'s own
// handler still checks. `task` and `release` have no max either: both
// build free text by joining every remaining word with a space (cli.js does
// `rest.join(" ")` for each), so an unquoted `orch task add input
// validation` is three positionals, not one — capping the max here would
// reject exactly the un-quoted phrasing the handler exists to accept.
const POSITIONAL_ARITY = {
  init: [0, 0], config: [0, 0], dashboard: [0, 0], mcp: [0, 0],
  upgrade: [0, 0], update: [0, 0], version: [0, 0], help: [0, 0],
  task: [0, Infinity], completion: [0, 1],
  issue: [1, 1, "usage: orch issue <number> [--author ... --reviewer ...]"],
  review: [1, 1, "usage: orch review <branch>"],
  continue: [1, 1, "usage: orch continue <sid>"],
  pr: [1, 1, "usage: orch pr <number> or <branch> [--until once|ready|merged]"],
  release: [1, Infinity, 'usage: orch release "<changelog entry>"'],
  // Internal re-exec target, never typed by a user (see cli.js) — but it still
  // only reads rest[0] (current version) and rest[1] (cache dir); a stray
  // third positional used to pass through unchecked instead of being refused
  // like every other command's excess argument.
  "__update-check-child": [0, 2],
};

// Positional/subcommand grammar was previously unchecked: `completion typo`,
// `dashboard extra`, `help extra`, and `version extra` all ran the command and
// ignored the junk argument instead of refusing it. This runs before any
// command dispatch, alongside `validate()`, so a malformed invocation never
// reaches a handler. --help/--version short-circuit main() before dispatch
// regardless of the command's own arity, so they are exempt here.
export function validatePositionals(command, rest, flags) {
  if (flags.help || flags.version) return;
  if (command === "agent") return validateAgentArgs(rest, flags);
  const arity = POSITIONAL_ARITY[command];
  if (!arity) return;
  const [min, max, usage] = arity;
  if (rest.length < min) throw usageError(usage);
  if (rest.length > max) {
    throw usageError(`'orch ${command}' takes ${max === 0 ? "no arguments" : `at most ${max} argument${max === 1 ? "" : "s"}`} — got ${rest.length}: ${rest.join(" ")}`);
  }
  if (command === "completion") {
    if (rest[0] && !SUBCOMMANDS.completion.includes(rest[0])) {
      throw usageError(`unknown 'orch completion' target '${rest[0]}' (expected ${SUBCOMMANDS.completion.join(" or ")})`);
    }
    if (flags.dry && rest[0] !== "install") {
      throw usageError("--dry is only valid with 'orch completion install' — 'orch completion' on its own only prints, it never writes");
    }
  }
  // `continue <sid>` uses the positional directly as a sid-store key
  // (checkpoint.js/inflight.js, via sid-store.js's `join(dir, key + ".json")`)
  // — a sid is always CLI-generated (sid.js), but this positional is
  // operator-typed and used unchecked, so `orch continue ../../etc/passwd`
  // could `join()` outside .orch/checkpoints and (via sid-store.js's
  // corrupt-file self-heal) delete or read a file it was never meant to
  // touch. Reject anything that isn't a plausible sid before it ever reaches
  // a store, same "before any side effect" placement as every other check
  // in this function.
  if (command === "continue" && !isSafeSid(rest[0])) {
    throw usageError(`invalid sid '${rest[0]}' — a sid never contains '/', '..', or a NUL byte`);
  }
  // `issue`/`pr` take a numeric ID. This used to be checked deep in each
  // handler, after main() had already fired the update-check network call
  // and minted a GitHub App token — so `orch issue abc` phoned home and
  // authed before being refused. Checking it here, alongside arity, rejects
  // it before any of that runs.
  if (command === "issue" && !/^\d+$/.test(String(rest[0]))) {
    throw usageError(usage);
  }
  // `task --file` plus a positional is ambiguous (two task sources) and used
  // to be rejected deep inside the `task` handler, after the same GitHub App
  // auth mint above had already fired. Checking it here, before dispatch,
  // rejects it before any of that runs.
  if (command === "task" && flags.file && rest.length) {
    throw usageError("orch task --file takes no positional task text — put the task in the work-order file");
  }
  // `task` has no minimum positional count in POSITIONAL_ARITY (--file supplies
  // the text instead), but it still needs ONE of the two sources. This used to
  // be checked deep in the `task` handler, after main() had already fired the
  // update-check network call and minted a GitHub App token for a command that
  // was always going to be refused.
  if (command === "task" && !flags.file && rest.length === 0) {
    throw usageError('usage: orch task "describe the change" (or --file work-order.json)');
  }
}

// `agent add` and `agent build` share a positional shape (<name>) but not a
// flag set (SUBCOMMAND_FLAGS above): --build on `agent build` is redundant
// (the subcommand already says so), and the flags that only matter for
// building an adapter (--pr and the author/reviewer overrides — everything
// "agent build" reads that "agent add" doesn't) are meaningless on a plain
// `agent add` that never builds anything — accepting them there would
// silently ignore them, the exact defect this schema exists to remove.
function validateAgentArgs(rest, flags) {
  const [sub, name, ...extra] = rest;
  if (sub === undefined || !SUBCOMMANDS.agent.includes(sub)) {
    throw usageError("usage: orch agent add <name> | orch agent build <name> [--pr]");
  }
  if (!name) {
    throw usageError(sub === "build" ? "usage: orch agent build <name> [--pr]" : "usage: orch agent add <name> | orch agent build <name> [--pr]");
  }
  if (extra.length) {
    throw usageError(`'orch agent ${sub}' takes a single <name> argument — got ${extra.length} extra: ${extra.join(" ")}`);
  }
  if (sub === "build" && flags.build) {
    throw usageError("--build is not valid with 'orch agent build' — building is what the subcommand already does");
  }
  if (sub === "build") {
    // A name orch already has adapter code for never builds (cli.js's
    // buildAgent returns "already-registered" before it reads any flag) — so
    // --pr/the role overrides/--allow-large-scope are inert there, same as on
    // `agent add`. Plain `orch agent build <known>` (no build-only flags)
    // stays legal; it just reports "already registered".
    let known = true;
    try { getAdapter(name); } catch { known = false; }
    if (known) {
      for (const flagName of AGENT_BUILD_ONLY_FLAGS) {
        if (flags[flagName] !== undefined && flags[flagName] !== false) {
          throw usageError(`--${flagName} is not valid with 'orch agent build ${name}' — ${name} already has an adapter, so no build runs`);
        }
      }
    }
  }
  if (sub === "add") {
    // A name orch already has adapter code for never builds, `--build` or not
    // (see cli.js's agent-add handler) — so the build-only flags are invalid
    // there unconditionally. A genuinely unregistered name only makes them
    // legal once `--build` is present. Checking this here, before
    // validatePositionals returns to main(), is what stops `agent add
    // <known> --build --pr` from minting a GitHub App token and firing the
    // update-check network call before being refused.
    let known = true;
    try { getAdapter(name); } catch { known = false; }
    if (known || !flags.build) {
      for (const flagName of AGENT_BUILD_ONLY_FLAGS) {
        if (flags[flagName] !== undefined && flags[flagName] !== false) {
          throw usageError(
            known
              ? `--${flagName} is not valid with 'orch agent add ${name}' — ${name} already has an adapter, so no build runs (use 'orch agent build ${name} --pr' to rebuild it)`
              : `--${flagName} is not valid with 'orch agent add' without --build — it only affects the build`,
          );
        }
      }
    }
  }
  // Unlike task/issue, buildAgent's applyRoleOverrides call (cli.js) is NOT
  // given allowReviewerOnly — a build's author/reviewer are either both
  // overridden or both left to rotation, never just one. That rule used to
  // surface only once buildAgent ran, after the update-check network call
  // and GitHub App token mint main() fires ahead of every command.
  const authorSet = flags.author != null || flags.authors != null;
  const reviewerSet = flags.reviewer != null || flags.reviewers != null;
  if (authorSet !== reviewerSet) {
    throw usageError("set both --author(s) and --reviewer(s), or neither");
  }
}

function pad(label, width = 24) {
  return label.length >= width ? `${label}\n${" ".repeat(width)}` : label.padEnd(width);
}

export function renderHelp() {
  const commands = Object.values(COMMANDS)
    .flatMap((c) => c.rows)
    .map(([label, desc]) => `  ${pad(label, 22)}${desc}`);
  const options = Object.entries(FLAGS)
    .filter(([, f]) => f.help)
    .map(([name, f]) => `  ${pad(`${f.label || `--${name}`}${f.arg ? ` ${f.arg}` : ""}`, 22)}${f.help}`);
  return `orch - Run coding agents in an author, review, test, and merge loop.

Usage: orch <command> [options]

Commands:
${commands.join("\n")}

Options:
${options.join("\n")}

Examples:
${EXAMPLES.map((e) => `  ${e}`).join("\n")}

Full docs: see .orch/ORCH.md in initialized repos and the README.`;
}
