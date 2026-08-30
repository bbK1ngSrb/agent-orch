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
import { EXIT_CODES } from "./exit-codes.js";

// Flags. `type` is the parseArgs type plus two refinements the parser
// enforces itself: "int" (positive integer unless `min` says otherwise) and
// "enum" (`values`). `label` overrides the left column in the Options block;
// `help: null` hides the flag from help (an alias documented on another line).
export const FLAGS = {
  help: { type: "boolean", short: "h", label: "-h, --help", help: "Show this page, or the named command's page." },
  version: { type: "boolean", help: "Print the version." },
  author: { type: "string", arg: "<spec>", help: 'Author seat as "<agent> [model] [effort]".' },
  authors: { type: "string", arg: "<a,b>", help: "Comma-separated author seats; each gets a branch." },
  from: { type: "string", arg: "<ref>", help: "Start a fresh cycle from <ref>; it starts at round 1, and previous cycle rounds do not count." },
  reviewer: { type: "string", arg: "<spec>", help: 'Reviewer seat as "<agent> [model] [effort]".' },
  reviewers: { type: "string", arg: "<a,b>", help: "Comma-separated reviewer seats." },
  cheap: { type: "boolean", help: "Fill both seats from cheap.role in orch.yml." },
  file: { type: "string", arg: "<path>", help: "Read the work order from a JSON file; takes no positional text." },
  "config-file": { type: "string", arg: "<path>", help: "Layer this YAML file over .orch/orch.yml." },
  "allow-protected": { type: "boolean", help: "Run even though the work order names a guardrail path." },
  "allow-large-scope": { type: "boolean", help: "Sanction a deliberately large review slice." },
  dry: { type: "boolean", help: "Plan only: no agent runs, nothing is written." },
  until: {
    type: "enum", values: ["once", "ready", "merged"], arg: "<goal>",
    help: "What this run pursues: once, ready or merged.",
  },
  check: { type: "boolean", help: "Validate or report the current state." },
  link: { type: "boolean", help: "Link .orch/ORCH.md from the agent doc files." },
  build: { type: "boolean", help: "Scaffold a missing adapter through a cycle." },
  "no-tidy": { type: "boolean", help: "Keep task branches and worktrees after landing." },
  detach: { type: "boolean", help: "Run in the background; print pid, log and runId." },
  json: { type: "boolean", help: "Print one JSON event per line; no prose." },
  limit: { type: "int", arg: "<n>", help: "History rows to show." },
  "check-history": { type: "boolean", help: "Show stale red rows as resolved when their branch is gone." },
  once: { type: "boolean", label: "--once, --plain", help: "Print the static one-shot instead of the TUI." },
  plain: { type: "boolean", help: null },
  "refresh-ms": { type: "int", arg: "<n>", help: "TUI repaint interval in ms." },
  merge: { type: "boolean", help: "Merge the approved PR." },
  pr: { type: "boolean", help: "Open a PR instead of leaving the branch bare." },
};

// Legal on every command: --help/--version describe the tool rather than run
// it. --json is NOT global — only `dashboard` reads it, so it is declared on
// that command's flag list instead.
export const GLOBAL_FLAGS = ["help", "version"];

// Flags shared by the commands that run an author/review/test cycle.
const RUN_FLAGS = [
  "config-file", "dry", "no-tidy", "detach", "until",
  "allow-large-scope", "author", "authors", "reviewer", "reviewers",
];

// `agent add --build` uses one command entry and one positional shape. The
// build-only flags are accepted only when that switch is present.
export const SUBCOMMAND_FLAGS = {
  "agent add": ["config-file", "dry", "build", "pr", "allow-large-scope", "author", "authors", "reviewer", "reviewers"],
};

// Commands. `flags` is what the command actually reads — anything else typed
// on it is a usage error, not a silent no-op. `mutates: false` marks a
// read-only command, which is what makes `--dry` on it meaningless rather than
// merely unsupported. Help text for each command lives in GLOBAL_ROWS and
// HELP_PAGES below, not here.
export const COMMANDS = {
  init: {
    mutates: true, flags: ["config-file", "dry", "link"],
  },
  // Read-only: v0.5 removes the interactive configuration wizard. The command
  // always prints the effective configuration; --check/--json select reports.
  config: {
    mutates: false, flags: ["config-file", "check", "json"],
  },
  agent: {
    mutates: true, flags: [...SUBCOMMAND_FLAGS["agent add"]],
  },
  task: {
    mutates: true, flags: [...RUN_FLAGS, "from", "file", "cheap", "allow-protected", "json"],
  },
  issue: {
    mutates: true, flags: [...RUN_FLAGS, "from", "cheap", "allow-protected", "json"],
  },
  continue: {
    // No --author: the branch's commits were authored by a specific agent
    // already, and `continue` resumes that run rather than starting a new one —
    // accepting the flag and ignoring it is the exact lie this schema removes.
    // --reviewer(s) IS honoured (see the `continue` handler in cli.js).
    mutates: true, flags: [...RUN_FLAGS.filter((f) => !["author", "authors"].includes(f)), "json"],
  },
  // No --author/--authors: pr audits an existing PR/branch, it never assigns
  // an author. applyRoleOverrides is called with allowReviewerOnly, so a
  // passed --author would be silently ignored. Accepting the flag would be
  // the exact "nobody read your flag" lie this schema exists to remove.
  // `--until once|ready|merged` is handled by the unified PR path in cli.js;
  // `--merge` remains a compatibility alias until the P12 clean break.
  pr: {
    mutates: true, flags: ["config-file", "dry", "merge", "until", "detach", "allow-large-scope", "reviewer", "reviewers", "json"],
  },
  release: {
    mutates: true, flags: ["dry"],
  },
  dashboard: {
    mutates: false, flags: ["json", "limit", "check-history", "once", "plain", "refresh-ms"],
  },
  mcp: {
    mutates: false, flags: [],
  },
  upgrade: {
    mutates: true, flags: ["check", "dry"],
  },
  update: { mutates: true, flags: ["check", "dry"] }, // alias, documented on upgrade's row
  completion: {
    // `completion install` writes ~/.orch/completion.bash, so it needs --dry
    // like every other mutating command. `completion [bash]` only prints —
    // validatePositionals below rejects --dry there instead of letting it
    // through as a silent no-op on the one subcommand it doesn't apply to.
    mutates: true, flags: ["dry"],
  },
  version: {
    mutates: false, flags: [],
  },
  help: {
    mutates: false, flags: [],
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
export const SUBCOMMANDS = { agent: ["add"], completion: ["bash", "install"] };

// These flags only make sense when `agent add` is also given `--build`.
const AGENT_BUILD_FLAGS = ["pr", "allow-large-scope", "author", "authors", "reviewer", "reviewers"];

export const EXAMPLES = [
  "orch init --link",
  'orch task "add input validation" --reviewer "codex"',
  "orch issue 42 --until merged",
  "orch pr 42 --until once",
];

// Help presentation lives beside the command schema, but the option rows are
// always selected from COMMANDS[name].flags below. Keeping prose here avoids
// making the parser's declaration carry formatting concerns while preserving a
// single source of truth for command/flag ownership.
const HELP_GROUPS = [
  ["Set up a repo", ["init", "config", "agent"]],
  ["Run a cycle", ["task", "issue"]],
  ["Review and land", ["pr", "continue"]],
  ["Operate", ["dashboard", "mcp"]],
  ["Maintain", ["release", "upgrade", "completion", "version", "help"]],
];

// Wording shared by more than one page. FLAGS[].help stays the default for a
// flag, which is what stops fourteen copies of --config-file drifting apart;
// these are the rows where a page needs to say more than the default does —
// what the flag lifts, and what it does NOT lift. A row that lists a flag
// without saying what it lifts is worse than no row at all.
const ALLOW_PROTECTED_HELP =
  "Run even though the work order names a guardrail path. The intake scan is textual, so this is for an incidental mention; a real guardrail change still escalates at the security floor.";
const FILE_HELP =
  "Read the work order from a JSON file, treating it as untrusted input; takes no positional text.";
const NO_TIDY_HELP = "Keep the task branch and worktree after landing.";
const FROM_HELP = "Start a fresh cycle from <ref>; it starts at round 1, and previous cycle rounds do not count.";

// The goal list aligns its `=` column and hangs the wrapped `ready` line under
// the description, so it reads as three definitions rather than a paragraph.
// wrapWords() emits an already-short line verbatim, which is what preserves it.
const untilHelp = (...lines) => lines.join("\n");

const RUN_EXITS = [
  [EXIT_CODES.OK, "goal reached"],
  [EXIT_CODES.ERROR, "internal error"],
  [EXIT_CODES.ESCALATED, "escalated or stopped at the attempt cap"],
  [EXIT_CODES.THROTTLED, "concurrency cap reached; retry later"],
  [EXIT_CODES.WAIT_TIMEOUT, "asked a human, no answer in time"],
  [EXIT_CODES.ACTION_REQUIRED, "a human action is required"],
  [EXIT_CODES.BLOCKED, "blocked, a human must decide"],
  [64, "usage error"],
];
const AGENT_EXITS = [
  [EXIT_CODES.OK, "added"],
  [EXIT_CODES.ERROR, "error"],
  [EXIT_CODES.ESCALATED, "the build stopped at the attempt cap"],
  [EXIT_CODES.THROTTLED, "the concurrency cap was reached; retry later"],
  [EXIT_CODES.BLOCKED, "the build is blocked and needs a human"],
  [64, "usage error"],
];

export const HELP_PAGES = {
  init: {
    title: "orch init — write .orch/orch.yml and .orch/ORCH.md into this repo.",
    synopsis: ["orch init [options]"],
    about: [
      "Writes a fully commented .orch/orch.yml (every key with its default and a note on what it does) plus .orch/ORCH.md, the short usage file agents and humans read from inside the repo. The config is written only if neither .orch/orch.yml nor a repo-root orch.yml already exists, so your settings survive a re-run; .orch/ORCH.md is rewritten every time, so do not hand-edit it. This is the only setup step: orch reads config from .orch/orch.yml and needs nothing else.",
    ],
    args: "Arguments: none.",
    exits: [[0, "written"], [1, "could not write"], [64, "usage error"]],
    examples: ["orch init", "orch init --link"],
    flagOrder: ["link", "config-file", "dry"],
    flagHelp: {
      link: "Link .orch/ORCH.md from the agent doc files (CLAUDE.md, AGENTS.md) so an agent finds it.",
      "config-file": "Write to this YAML path instead of .orch/orch.yml.",
      dry: "Print what would be written; write nothing.",
    },
  },
  config: {
    title: "orch config — print the effective, validated configuration.",
    synopsis: ["orch config [options]"],
    about: [
      "Prints every setting orch will actually use for a run in this repo, with the source of each value: a built-in default, .orch/orch.yml, or a file layered on with --config-file. Reading it answers \"why did that run pick that reviewer\" without reading the code. --check validates instead of printing, and exits 1 listing every unknown or removed key. The schema is closed — a typo is an error, not silence.",
    ],
    args: "Arguments: none.",
    exits: [[0, "valid"], [1, "invalid config (--check)"], [64, "usage error"]],
    examples: ["orch config", "orch config --check"],
    flagOrder: ["check", "json", "config-file"],
    flagHelp: {
      check: "Validate only; exit 1 and list problems.",
      json: "Print the report as one JSON object.",
      "config-file": "Layer this YAML file over .orch/orch.yml.",
    },
  },
  agent: {
    title: "orch agent add — add an agent to the rotation pool.",
    synopsis: ["orch agent add <name> [options]"],
    about: [
      "Appends <name> to the `agents:` list in .orch/orch.yml, which is the pool the author and reviewer seats rotate through. If orch has no adapter for <name>, `add` alone changes nothing but the config; pass --build to scaffold the adapter through a normal cycle — orch writes its own integration code with the same author, cross-audit and test-gate path any other change goes through. A name orch already has an adapter for never builds, with or without --build.",
      "A build never merges. An agreed and green adapter stays on its branch for a human to read and land, because code orch wrote that orch will then run as an agent gets a human checkpoint. With --pr that branch is opened as a pull request instead of left bare; it is still yours to merge.",
    ],
    args: "Arguments: exactly one <name>, after the add subcommand word.",
    exits: AGENT_EXITS,
    examples: ["orch agent add codex", "orch agent add mynewagent --build --author \"claude\" --reviewer \"codex\""],
    flagOrder: ["build", "config-file", "dry"],
    flagHelp: {
      build: "Scaffold a missing adapter through a cycle.",
      "config-file": "Read and write this YAML path.",
      dry: "Print the edit and the plan; change nothing.",
      authors: "Comma-separated author seats.",
      pr: "Open the finished adapter branch as a pull request.",
    },
    flagGroups: [["Only with --build:", ["author", "authors", "reviewer", "reviewers", "allow-large-scope", "pr"]]],
  },
  task: {
    title: "orch task — run one change through a cycle.",
    synopsis: ["orch task \"<change>\" [options]", "orch task --file <work-order.json> [options]"],
    about: [
      "One cycle is: an author agent writes the change on its own branch in an isolated git worktree (a second checkout of the same repository, so concurrent runs never fight over one HEAD), a different agent cross-audits the diff, the test gate runs, a deterministic security scan runs, and the reviewed commit lands on the integration branch. With --until ready or merged the cycle repeats under a remedy ladder — rebase + repair, rotate seats, reauthor, ask a human — offering whichever of those the failure calls for, until the goal is reached or the attempt cap is spent.",
    ],
    args: "Arguments: the change text. Unquoted words are joined with spaces, so `orch task add input validation` is the same work order as the quoted form. With --file, no positional text is allowed — the file is the work order.",
    exits: RUN_EXITS,
    examples: ["orch task \"add input validation\" --until once", "orch task --file work-order.json --cheap"],
    flagOrder: [
      "until", "from", "author", "authors", "reviewer", "reviewers", "cheap", "file",
      "allow-protected", "allow-large-scope", "no-tidy", "detach",
      "dry", "json", "config-file",
    ],
    flagHelp: {
      until: untilHelp(
        "What this run pursues: once, ready or merged.",
        "once  = a single cycle, then report.",
        "ready = loop until the pull request for this change",
        "        is green and mergeable; never merge it.",
        "merged = also merge the standing PR.",
        "(default: once)",
      ),
      from: FROM_HELP,
      file: FILE_HELP,
      "allow-protected": ALLOW_PROTECTED_HELP,
      "no-tidy": NO_TIDY_HELP,
    },
  },
  issue: {
    title: "orch issue — run a cycle from a GitHub issue.",
    synopsis: ["orch issue <number> [options]"],
    about: [
      "Fetches issue <number> with `gh`, uses its body as the work order, and runs the same cycle as `orch task`. The landing commit carries `Closes #<number>`, so GitHub closes the issue when the change reaches the base branch. The issue body is the whole brief an author agent gets — comments on the issue are not read — so a thin body is the usual reason a cycle escalates. A work order whose text names a guardrail path is refused at intake, before any agent runs; pass --allow-protected when the mention is incidental.",
    ],
    args: "Arguments: exactly one issue number, digits only.",
    exits: RUN_EXITS,
    examples: ["orch issue 42", "orch issue 42 --until merged --reviewer \"codex gpt-5.6-sol high\""],
    flagOrder: [
      "until", "from", "author", "authors", "reviewer", "reviewers", "cheap",
      "allow-protected", "allow-large-scope", "no-tidy", "detach",
      "dry", "json", "config-file",
    ],
    flagHelp: {
      until: untilHelp(
        "What this run pursues: once, ready or merged.",
        "once  = a single cycle, then report.",
        "ready = loop until the pull request for this change",
        "        is green and mergeable; never merge it.",
        "merged = also merge the standing PR.",
        "(default: once)",
      ),
      from: FROM_HELP,
      "allow-protected": ALLOW_PROTECTED_HELP,
      "no-tidy": NO_TIDY_HELP,
    },
  },
  pr: {
    title: "orch pr — audit a pull request or a branch, and repair or merge it.",
    synopsis: ["orch pr <number|branch> [options]"],
    about: [
      "Takes a GitHub PR number or a local/remote branch name and runs the cycle in review mode: no author writes a new change first, a reviewer agent audits what is already there, and the test gate and security scan run on that diff. --until once audits and reports; ready repairs the head until GitHub says it is green and mergeable; merged also merges it, but only after reading mergeability and check status back for the exact head being merged. A draft pull request is not ready by definition, so ready and merged both refuse one — reporting `pr #<n> is a draft` — instead of marking it ready or undrafting it.",
    ],
    notes: ["There is no --author here: this command audits work that already has an author. Accepting the flag and ignoring it is exactly the silence the schema exists to remove."],
    args: "Arguments: exactly one PR number or branch name.",
    exits: RUN_EXITS,
    examples: ["orch pr 42 --until once", "orch pr pr/claude/add-retry --reviewer \"codex\""],
    flagOrder: [
      "until", "merge", "reviewer", "reviewers", "allow-large-scope", "detach",
      "dry", "json", "config-file",
    ],
    flagHelp: {
      until: untilHelp(
        "What this run pursues: once, ready or merged.",
        "once  = audit once and report; change nothing.",
        "ready = repair the head until it is green and",
        "        mergeable; never merge it.",
        "merged = merge it once readiness is verified.",
        "(default: once)",
      ),
      merge: "Alias for --until merged; refused next to a different --until.",
    },
  },
  continue: {
    title: "orch continue — resume an interrupted cycle or a stopped run.",
    synopsis: ["orch continue <sid> [options]"],
    about: [
      "Every cycle writes a checkpoint keyed by its sid (the run's short id, printed when the run starts and listed by `orch dashboard`). `continue` reads that checkpoint and picks the cycle up where it stopped instead of starting over, so a run killed mid-review does not re-author the change. A run that ended at the attempt cap (exit 2) or waiting on a human (exit 4) resumes here too, with a fresh attempt budget. The seats, work order and goal are taken from the record: a bare `orch continue <sid>` on a run started with --until merged keeps pursuing merged, not the default a fresh run would get. A flag given here overrides the recorded value for this resume only.",
    ],
    notes: ["There is no --author here: the commits being resumed were written by a specific agent, and this command continues that run rather than starting a new one."],
    args: "Arguments: exactly one sid. A sid never contains '/', '..' or a NUL byte — it is used directly as a store key, so anything else is refused.",
    exits: RUN_EXITS,
    examples: ["orch continue 1a2b3c4d", "orch continue 1a2b3c4d --reviewer \"claude claude-opus-5 high\""],
    flagOrder: [
      "until", "reviewer", "reviewers", "allow-large-scope", "no-tidy",
      "detach", "dry", "json", "config-file",
    ],
    flagHelp: {
      until: untilHelp(
        "What this resume pursues. Only once can be typed here",
        "today; ready and merged are inherited from the run's",
        "own record, and are refused as an override.",
        "(default: the goal recorded for the run)",
      ),
      "no-tidy": NO_TIDY_HELP,
    },
  },
  release: {
    title: "orch release — write the version bump and CHANGELOG entry by hand.",
    synopsis: ["orch release \"<changelog entry>\" [options]"],
    about: ["A clean cycle does this bookkeeping itself when it lands, but only in repos that set release.autoBump: true. When such a cycle escalates and a human merges the branch instead, that step never runs — this command performs it alone, in the dedicated integration worktree, on the integration branch. It always bumps and never consults release.autoBump. It writes no git tag: tagging is CI's job."],
    args: "Arguments: the changelog entry text. Unquoted words are joined with spaces.",
    exits: [[0, "written"], [1, "the worktree was dirty, on the wrong branch, or the bump failed"], [64, "usage error"]],
    examples: ["orch release \"hand-landed guardrail fix (closes #123)\"", "orch release \"hand-landed guardrail fix\" --dry"],
    flagOrder: ["dry"],
    flagHelp: { dry: "Print the bump and the entry; write nothing." },
  },
  dashboard: {
    title: "orch dashboard — show live cycle status, run history and metrics.",
    synopsis: ["orch dashboard [options]"],
    about: ["Reads .orch/ — the inflight registry, the run records and runs.jsonl — and renders what is running now, the tail of the current log, recent runs and their outcomes. On an interactive terminal it opens a live TUI that repaints on a timer; anywhere else (piped, redirected, --json, --once) it prints one static snapshot and exits, so it is safe in a script. It only reads: nothing here changes a run."],
    args: "Arguments: none.",
    exits: [[0, "rendered"], [1, ".orch/ could not be read"], [64, "usage error"]],
    examples: ["orch dashboard", "orch dashboard --json --limit 5"],
    flagOrder: ["json", "limit", "check-history", "once", "refresh-ms"],
    flagHelp: {
      json: "Print one JSON snapshot instead of the TUI.",
      limit: "History rows to show. (default: 10)",
      "check-history": "Show stale red rows as resolved when their branch is gone. View only — runs.jsonl is not rewritten.",
      once: "Print the static one-shot instead of the TUI.",
      "refresh-ms": "TUI repaint interval in ms. (default: 1000)",
    },
  },
  mcp: {
    title: "orch mcp — serve orch as an MCP server over stdio.",
    synopsis: ["orch mcp"],
    about: ["Speaks the Model Context Protocol on stdin/stdout so an AI client can run cycles as tools instead of shelling out. Because stdout is the protocol transport here, nothing else may print on it — this command deliberately skips the update banner every other command may show. Each cycle the server spawns authenticates on its own. The server runs until stdin closes."],
    args: "Arguments: none.",
    exits: [[0, "the client disconnected"], [1, "the transport failed"], [64, "usage error"]],
    examples: ["orch mcp"],
    flagOrder: [],
  },
  upgrade: {
    title: "orch upgrade — self-update the global npm install.",
    synopsis: ["orch upgrade [options]"],
    about: ["Compares the running version against the published one and reinstalls the global package when it is behind. --check only reports the comparison and installs nothing, which is what a scripted or scheduled caller wants. `orch update` is a second spelling of this command."],
    args: "Arguments: none.",
    exits: [[0, "up to date or upgraded"], [1, "the check or the install failed"], [64, "usage error"]],
    examples: ["orch upgrade --check", "orch upgrade"],
    flagOrder: ["check", "dry"],
    flagHelp: { check: "Report the latest version; install nothing.", dry: "Print the install command; run nothing." },
  },
  update: {
    title: "orch update — self-update the global npm install.",
    synopsis: ["orch update [options]"],
    about: ["A second spelling of `orch upgrade`, kept for compatibility: it compares the running version against the published one and reinstalls the global package when it is behind. --check only reports the comparison and installs nothing, which is what a scripted or scheduled caller wants."],
    args: "Arguments: none.",
    exits: [[0, "up to date or upgraded"], [1, "the check or the install failed"], [64, "usage error"]],
    examples: ["orch update --check", "orch update"],
    flagOrder: ["check", "dry"],
    flagHelp: { check: "Report the latest version; install nothing.", dry: "Print the install command; run nothing." },
  },
  completion: {
    title: "orch completion — print or install the bash completion script.",
    synopsis: ["orch completion [bash]", "orch completion install [--dry]"],
    about: ["The completion script is generated from the same command schema that drives parsing and this help, so tab-completion can never offer a command or flag the parser would refuse. `orch completion` (or `orch completion bash`) prints the script to stdout; `orch completion install` writes it to ~/.orch/completion.bash and tells you the line to add to ~/.bashrc. Because the plain form only writes to stdout, you can redirect it wherever your shell looks for completions — `> /etc/bash_completion.d/orch` for a system-wide install."],
    args: "Arguments: at most one target, `bash` or `install`. Default: bash.",
    exits: [[0, "printed or installed"], [1, "could not write the script"], [64, "usage error"]],
    examples: ["orch completion install", "orch completion bash"],
    flagOrder: ["dry"],
    flagHelp: { dry: "With `install`: print the path; write nothing. Refused on the plain form, which never writes." },
  },
  version: {
    title: "orch version — print the version.",
    synopsis: ["orch version"],
    about: ["Prints the installed version, the same string as `orch --version`."],
    args: "Arguments: none.",
    exits: [[0, "printed"], [64, "usage error"]],
    examples: ["orch version"],
    flagOrder: [],
  },
  help: {
    title: "orch help — show this help.",
    synopsis: ["orch help [command]"],
    about: ["With no argument, prints the command list, the global options and the exit codes. With a command name, prints that command's page — `orch help task` and `orch task --help` are the same thing, and print the same bytes."],
    args: "Arguments: at most one command name.",
    exits: [[0, "printed"], [64, "unknown command name"]],
    examples: ["orch help", "orch help pr"],
    flagOrder: [],
  },
};
export const EXITS = {
  [EXIT_CODES.OK]: "the goal was reached and verified",
  [EXIT_CODES.ERROR]: "internal error (orch bug, or the environment failed)",
  [EXIT_CODES.ESCALATED]: "escalated: agents disagreed or the attempt cap stopped the run",
  [EXIT_CODES.THROTTLED]: "throttled: the concurrency cap was reached; retry later",
  [EXIT_CODES.WAIT_TIMEOUT]: "asked a human and got no answer in automation.humanWaitHours",
  [EXIT_CODES.ACTION_REQUIRED]: "action required: perform the named human gesture",
  [EXIT_CODES.BLOCKED]: "blocked: a human must decide (guardrail, security floor, protection)",
  64: "usage error (unknown command, wrong flag for the command, bad value)",
};

// A usage error: bad flag, bad value, unknown command. Exit 64 (sysexits
// EX_USAGE) instead of the catch-all 1, so a script can tell "you typed it
// wrong" from "the run failed". bin/orch.js reads `.exit`.
export function usageError(message, extra = {}) {
  return Object.assign(new Error(message), { exit: 64, ...extra });
}

// `helpFor` names the page bin/orch.js renders after the message, so it may
// only ever name a command that HAS a page. INTERNAL_COMMANDS entries
// (`__update-check-child`) are re-exec targets deliberately kept out of
// COMMANDS and so out of HELP_PAGES; validate() still checks their flags, and
// naming one here made renderHelp() throw *inside the error funnel* — turning a
// documented exit 64 into exit 1 plus a stack trace. Filter at the site the
// value is created rather than guarding the funnel that consumes it: with no
// page to show, the message alone is the whole (correct) output.
function helpPageFor(command) {
  return command && HELP_PAGES[command] ? command : undefined;
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
// IS legal. --help/--version short-circuit main() before any command runs;
// --help keeps a named command as the effective command for scope checks,
// while --version retains its flag precedence.
// Commands with no schema entry (unknown input, which falls through to usage)
// are not validated here — main()'s fall-through rejects them.
export function validate(command, flags, { detachedChild = false } = {}) {
  // Help describes the command word that was actually typed. This keeps a
  // command-scoped flag next to --help in scope for that command, while the
  // version flag retains its existing precedence over all command words.
  const effective = flags.help && command ? command : flags.version ? "version" : flags.help ? "help" : command;
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
      if (value !== true && value !== false) {
        try { validateValue(name, value); }
        catch (e) {
          if (e.exit === 64) e.helpFor = helpPageFor(command);
          throw e;
        }
      }
      continue;
    }
    if (name === "dry" && spec.mutates === false) {
      throw usageError(`--dry has no effect on 'orch ${effective}' — it changes nothing`, { helpFor: helpPageFor(command) });
    }
    const valid = Object.keys(COMMANDS).filter((c) => COMMANDS[c].flags.includes(name));
    throw usageError(
      `--${name} is not valid with 'orch ${effective}'` +
      (valid.length ? ` — only with: ${valid.map((c) => `orch ${c}`).join(", ")}` : " — it is not a flag of any command"),
      { helpFor: helpPageFor(command) },
    );
  }
  if (flags.help && command) {
    const action = flags.until && flags.until !== "once" ? "until" : flags.detach ? "detach" : flags.build ? "build" : flags.merge ? "merge" : null;
    if (action) throw usageError(`--${action} cannot be combined with --help on 'orch ${command}'`, { helpFor: helpPageFor(command) });
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
  if (flags.json && ["task", "issue", "pr"].includes(effective) && (!flags.until || flags.until === "once")) {
    if (!flags.detach && !detachedChild) {
      throw usageError(`--json on 'orch ${effective}' requires --until ready (or merged) — the once path has no event stream to print`);
    }
  }
  if (flags.detach && flags.dry) {
    throw usageError("--detach cannot be combined with --dry");
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
  upgrade: [0, 0], update: [0, 0], version: [0, 0], help: [0, 1],
  task: [0, Infinity], completion: [0, 1],
  issue: [1, 1, "usage: orch issue <number> [--author ... --reviewer ...]"],
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

function validateAgentArgs(rest, flags) {
  const [sub, name, ...extra] = rest;
  if (sub === undefined || !SUBCOMMANDS.agent.includes(sub)) {
    throw usageError("usage: orch agent add <name> [--build]");
  }
  if (!name) {
    throw usageError("usage: orch agent add <name> [--build]");
  }
  if (extra.length) {
    throw usageError(`'orch agent ${sub}' takes a single <name> argument — got ${extra.length} extra: ${extra.join(" ")}`);
  }
  // A name orch already has adapter code for never builds, `--build` or not
  // (see cli.js's agent-add handler). Build-only flags are legal only for an
  // unregistered name when --build is present.
  let known = true;
  try { getAdapter(name); } catch { known = false; }
  if (known || !flags.build) {
    for (const flagName of AGENT_BUILD_FLAGS) {
      if (flags[flagName] !== undefined && flags[flagName] !== false) {
        throw usageError(
          known
            ? `--${flagName} is not valid with 'orch agent add ${name}' — ${name} already has an adapter, so no build runs`
            : `--${flagName} is not valid with 'orch agent add' without --build — it only affects the build`,
        );
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

const GLOBAL_ROWS = {
  init: ["init", "Write a commented .orch/orch.yml and .orch/ORCH.md."],
  config: ["config", "Print the effective, validated config."],
  agent: ["agent add <name>", "Add an agent to the rotation pool; --build scaffolds its adapter."],
  task: ["task \"change\"", "Author, cross-audit, test-gate and land one change."],
  issue: ["issue <number>", "The same, from a GitHub issue; closes it on landing."],
  pr: ["pr <number|branch>", "Audit a pull request or a branch; repair or merge it."],
  continue: ["continue <sid>", "Resume an interrupted cycle or a stopped run."],
  dashboard: ["dashboard", "Live status TUI; --once prints a static snapshot."],
  mcp: ["mcp", "Serve orch as an MCP server over stdio."],
  release: ["release \"entry\"", "Bump version + CHANGELOG by hand (autoBump repos)."],
  upgrade: ["upgrade, update", "Self-update the global npm install."],
  completion: ["completion", "Print or install the bash completion script."],
  version: ["version", "Print the version."],
  help: ["help [command]", "This page, or one command's page."],
};

// Reflow `text` to `width`, prefixing every line after the first with
// `continuation`. A source line that already fits is emitted verbatim, leading
// whitespace and all: some rows align deliberately — the `=` column down
// --until's three goal lines, and the hanging indent under `ready =` — and
// re-splitting on /\s+/ silently flattens that alignment into one ragged
// paragraph. A line that does NOT fit is word-wrapped, with its own leading
// indent carried onto the wrapped remainder so the alignment survives there too.
function wrapWords(text, width, continuation = "") {
  const lines = [];
  for (const source of String(text).split("\n")) {
    const line = source.replace(/\s+$/, "");
    if (!line.trim()) {
      lines.push("");
      continue;
    }
    if (line.length <= width) {
      lines.push(line);
      continue;
    }
    const indent = line.match(/^ */)[0];
    let current = "";
    for (const word of line.trim().split(/\s+/)) {
      if (current && current.length + word.length + 1 > width) {
        lines.push(current);
        current = indent + word;
      } else {
        current = current ? `${current} ${word}` : indent + word;
      }
    }
    lines.push(current);
  }
  return lines.map((line, index) => index && line ? `${continuation}${line}` : line).join("\n");
}

// §3 rule 1: two-space indent, label padded to 24, description from column 27,
// total line width capped. The spec's own §4 blocks sit just under this cap.
const PAGE_WIDTH = 79;
const DESCRIPTION_WIDTH = PAGE_WIDTH - 26; // continuation column for a flag row

function optionLabel(name) {
  const f = FLAGS[name];
  return `${f.label || `--${name}`}${f.arg ? ` ${f.arg}` : ""}`;
}

function orderedFlags(command, page) {
  const declared = COMMANDS[command].flags;
  const preferred = page.flagOrder || [];
  return [
    ...preferred.filter((name) => declared.includes(name)),
    ...declared.filter((name) => !preferred.includes(name)),
  ];
}

function flagRows(names, page) {
  return names
    .filter((name) => FLAGS[name]?.help)
    .map((name) => {
      const help = page.flagHelp?.[name] || FLAGS[name].help;
      return `  ${pad(optionLabel(name))}${wrapWords(help, DESCRIPTION_WIDTH, " ".repeat(26))}`;
    });
}

// The exit list is packed by whole entry, not by word: a line break inside
// "2 stopped at the attempt cap" reads as the end of one code and the start of
// another, which is the one thing this list must never be ambiguous about.
function renderExits(page) {
  const entries = page.exits.map(([code, description]) => `${code} ${description}`);
  const lines = [];
  let current = "Exit codes:";
  entries.forEach((entry, index) => {
    const tail = index === entries.length - 1 ? "." : " ·";
    const packed = `${current} ${entry}${tail}`;
    if (index && packed.length > PAGE_WIDTH) {
      lines.push(current);
      current = entry + tail;
    } else {
      current = packed;
    }
  });
  lines.push(current);
  return lines.join("\n");
}

function renderGlobal() {
  const groups = HELP_GROUPS.map(([heading, commands]) => {
    const rows = commands.map((name) => {
      const [label, description] = GLOBAL_ROWS[name];
      return `  ${pad(label)}${wrapWords(description, DESCRIPTION_WIDTH, " ".repeat(26))}`;
    });
    return `${heading}:\n${rows.join("\n")}`;
  }).join("\n\n");
  const exits = [...Object.values(EXIT_CODES), 64]
    .map((code) => `  ${String(code).padEnd(4)}${EXITS[code]}`)
    .join("\n");
  return `orch — author, cross-audit, test-gate and land a change with coding agents.

Usage: orch <command> [options]
       orch <command> --help    Flags, arity and examples for one command.

${groups}

Options (valid on every command):
  ${pad("-h, --help")}Show this page, or the named command's page.
  ${pad("--version")}Print the version.

Every other flag belongs to a command: run \`orch <command> --help\` to see it.

Exit codes:
${exits}

Examples:
${EXAMPLES.map((e) => `  ${e}`).join("\n")}

Exit-code table: README.md#exit-codes; manual: docs/orch-manual.md.
Full docs: .orch/ORCH.md in an initialized repo, and the README.`;
}

export function renderHelp(command = null) {
  if (!command) return renderGlobal();
  const page = HELP_PAGES[command];
  if (!page) throw new Error(`unknown help page: ${command}`);
  const allFlags = orderedFlags(command, page);
  const groupFlags = command === "agent" ? new Set(AGENT_BUILD_FLAGS) : new Set();
  const mainFlags = allFlags.filter((name) => !groupFlags.has(name));
  const options = mainFlags.length ? ["Options:", ...flagRows(mainFlags, page)] : ["Options: none."];
  if (page.flagGroups) {
    for (const [heading, preferred] of page.flagGroups) {
      const names = [
        ...preferred.filter((name) => groupFlags.has(name)),
        ...AGENT_BUILD_FLAGS.filter((name) => !preferred.includes(name)),
      ];
      if (names.length) options.push("", heading, ...flagRows(names, page));
    }
  }
  const synopsis = page.synopsis.map((line, index) => index ? `       ${line}` : `Usage: ${line}`);
  const about = page.about.flatMap((paragraph, index) => [
    ...(index ? [""] : []),
    ...wrapWords(paragraph, PAGE_WIDTH).split("\n"),
  ]);
  const notes = page.notes?.flatMap((note, index) => [
    ...(index ? [""] : []),
    ...wrapWords(note, PAGE_WIDTH).split("\n"),
  ]) || [];
  const examples = page.examples.map((example) => `  ${example}`);
  return [
    page.title,
    "",
    ...synopsis,
    "",
    ...about,
    "",
    ...options,
    "",
    ...wrapWords(page.args, PAGE_WIDTH).split("\n"),
    ...(notes.length ? ["", ...notes] : []),
    "",
    renderExits(page),
    "",
    `${page.examples.length === 1 ? "Example" : "Examples"}:`,
    ...examples,
  ].join("\n");
}
