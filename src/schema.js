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
    help: "One cycle only (once); other modes not yet available.",
  },
  check: { type: "boolean", help: "With upgrade, check latest version without installing." },
  link: { type: "boolean", help: "With init, link .orch/ORCH.md from agent docs." },
  build: { type: "boolean", help: "With agent add, build the adapter without asking." },
  "no-banner": { type: "boolean", help: "Hide the run banner." },
  "no-tidy": { type: "boolean", help: "Leave task branches and checkouts after merge." },
  json: { type: "boolean", help: "With dashboard, print JSON." },
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
  "agent add": ["config-file", "dry", "build", "pr", "allow-large-scope", "author", "authors", "reviewer", "reviewers"],
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
  // Mutating: runConfigWizard creates .orch/ and writes orch.yml. It is not
  // read-only, so --dry cannot be waved off with the generic "changes
  // nothing" message that `mutates: false` produces — that message would be a
  // lie for this command. --dry isn't in this command's own flags either, so
  // typing it still fails, just with the honest "not valid with" message.
  config: {
    mutates: true, flags: ["config-file"],
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
    mutates: true, flags: [...RUN_FLAGS, "file", "cheap", "allow-protected"],
    rows: [
      ['task "change"', "Run a cycle and update orch/integration on merge."],
      ["task --file <file>", "Run a cycle from an untrusted JSON work order."],
    ],
  },
  issue: {
    mutates: true, flags: [...RUN_FLAGS, "cheap", "allow-protected"],
    rows: [["issue <number>", "Run from a GitHub issue and close it on merge."]],
  },
  review: {
    // No --author/--authors or --no-tidy: review audits an existing branch's
    // author (read off the branch name) and never merges, so nothing reads
    // them — accepting and ignoring them is the exact lie this schema exists
    // to remove. --reviewer(s)/--cheap ARE honoured (they pick who audits).
    mutates: true, flags: [...RUN_FLAGS.filter((f) => !["no-tidy", "author", "authors"].includes(f)), "cheap"],
    rows: [["review <branch>", "Audit an existing branch without merging."]],
  },
  continue: {
    // No --author: the branch's commits were authored by a specific agent
    // already, and `continue` resumes that run rather than starting a new one —
    // accepting the flag and ignoring it is the exact lie this schema removes.
    // --reviewer(s) IS honoured (see the `continue` handler in cli.js).
    mutates: true, flags: RUN_FLAGS.filter((f) => !["no-banner", "author", "authors"].includes(f)),
    rows: [["continue <sid>", "Resume an interrupted/stalled cycle from its checkpoint."]],
  },
  pr: {
    mutates: true, flags: ["config-file", "dry", "merge", "until", "allow-large-scope", "author", "authors", "reviewer", "reviewers"],
    rows: [["pr <number>", "Review a GitHub PR; add --merge to merge if approved."]],
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
    mutates: true, flags: [],
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

// Subcommand words, for completion. Derived nowhere else: these are positional
// literals, not flags.
export const SUBCOMMANDS = { agent: ["add", "build"], completion: ["bash", "install"] };

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
  const spec = COMMANDS[effective];
  if (!spec) return;
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
  // --until is declared now so scripts can be written against it, but only the
  // single-cycle mode exists; the loop lands in a later slice of the CLI v2
  // plan. Rejecting is honest, defaulting to `once` would be a lie.
  if (flags.until && flags.until !== "once") {
    throw usageError(`--until ${flags.until} is not yet available — only --until once (the default)`);
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
// handler still checks.
const POSITIONAL_ARITY = {
  init: [0, 0], config: [0, 0], dashboard: [0, 0], mcp: [0, 0],
  upgrade: [0, 0], update: [0, 0], version: [0, 0], help: [0, 0],
  task: [0, 1], completion: [0, 1],
  issue: [1, 1, "usage: orch issue <number> [--author ... --reviewer ...]"],
  review: [1, 1, "usage: orch review <branch>"],
  continue: [1, 1, "usage: orch continue <sid>"],
  pr: [1, 1, "usage: orch pr <number> [--merge]"],
  release: [1, 1, 'usage: orch release "<changelog entry>"'],
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
  if (command === "completion" && rest[0] && !SUBCOMMANDS.completion.includes(rest[0])) {
    throw usageError(`unknown 'orch completion' target '${rest[0]}' (expected ${SUBCOMMANDS.completion.join(" or ")})`);
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
  if (sub === "add" && !flags.build) {
    const buildOnlyFlags = SUBCOMMAND_FLAGS["agent build"].filter((f) => !SUBCOMMAND_FLAGS["agent add"].includes(f));
    for (const flagName of buildOnlyFlags) {
      if (flags[flagName] !== undefined && flags[flagName] !== false) {
        throw usageError(`--${flagName} is not valid with 'orch agent add' without --build — it only affects the build`);
      }
    }
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
