import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir, cwd } from "node:process";
import { COMMANDS, FLAGS, GLOBAL_FLAGS, validate, validatePositionals, renderHelp } from "../src/schema.js";
import { parse, main } from "../src/cli.js";
import { mkGh } from "./helpers/fake-gh.js";

// A plausible value for a flag, so the matrix below can type every flag on
// every command it belongs to.
function sample(name) {
  const f = FLAGS[name];
  if (f.type === "boolean") return [`--${name}`];
  if (f.type === "int") return [`--${name}`, "1"];
  if (f.type === "enum") return [`--${name}`, f.values[0]];
  // author/authors/reviewer/reviewers are role specs — validate() now parses
  // them (parseRoleSpec/parseRoleSpecs, schema.js) and rejects an unregistered
  // agent, so the generic "x" placeholder every other string flag uses would
  // fail here for a reason unrelated to what this matrix actually checks.
  if (["author", "authors", "reviewer", "reviewers"].includes(name)) return [`--${name}`, "claude"];
  return [`--${name}`, "x"];
}

// The matrix: every flag a command declares must survive validation on that
// command, and every flag it does not declare must be refused. Hand-written
// per-command guards used to cover only --merge, so `orch issue 42 --file f`
// parsed fine and then did nothing with the file.
test("every declared flag validates on its command, every other flag is refused", () => {
  const all = Object.keys(FLAGS);
  for (const [command, spec] of Object.entries(COMMANDS)) {
    for (const name of spec.flags) {
      // task/issue reject --author(s) without a paired --reviewer(s) (schema.js:
      // reviewer-only is meaningful there, author-only isn't) — sampling --author
      // alone would otherwise trip that pairing rule for a reason unrelated to
      // what this matrix checks (does the command accept the flag at all).
      // --json on task/issue/review only validates paired with --until ready
      // (schema.js: there's no event stream to print on the bare/once path) —
      // sampling --json alone would otherwise trip that pairing rule for a
      // reason unrelated to what this matrix checks.
      const extra = ["task", "issue"].includes(command) && ["author", "authors"].includes(name)
        ? sample("reviewer")
        : ["task", "issue", "review", "pr"].includes(command) && name === "json" ? ["--until", "ready"] : [];
      const { flags } = parse([command, ...sample(name), ...extra]);
      assert.doesNotThrow(() => validate(command, flags), `orch ${command} --${name}`);
    }
    for (const name of all) {
      if (spec.flags.includes(name) || GLOBAL_FLAGS.includes(name)) continue;
      const { flags } = parse([command, ...sample(name)]);
      assert.throws(
        () => validate(command, flags),
        (e) => e.exit === 64 && /is not valid with|has no effect on/.test(e.message),
        `orch ${command} --${name} should be a usage error`,
      );
    }
  }
});

// runConfigWizard (src/config-wizard.js) creates .orch/ and writes orch.yml —
// `config` is a mutating command. Classifying it `mutates: false` made the
// generic "--dry has no effect on 'orch config' — it changes nothing"
// message a lie about a command that does change something.
test("config is classified as a mutating command", () => {
  assert.equal(COMMANDS.config.mutates, true);
});

// `completion install` writes ~/.orch/completion.bash, so it needs --dry like
// every other mutating command — but `completion` (bare, or `completion
// bash`) only prints, and --dry there would be a silent no-op accepted by
// validate() alone (it only checks flag membership, not which subcommand).
// validatePositionals is where completion's subcommand shape is known, so the
// install-only restriction lives there.
test("--dry on 'orch completion' is only legal alongside install", () => {
  assert.doesNotThrow(() => validatePositionals("completion", ["install"], { dry: true }));
  assert.doesNotThrow(() => validatePositionals("completion", [], {}));
  assert.throws(
    () => validatePositionals("completion", [], { dry: true }),
    (e) => e.exit === 64 && /--dry is only valid with 'orch completion install'/.test(e.message),
  );
  assert.throws(
    () => validatePositionals("completion", ["bash"], { dry: true }),
    (e) => e.exit === 64 && /--dry is only valid with 'orch completion install'/.test(e.message),
  );
});

// `completion typo`, `dashboard extra`, `help extra`, `version extra` used to
// run the command and ignore the extra argument. And a required positional
// (a number, a branch, a name) used to be checked deep inside each command's
// own handler, after main() had already reached the GitHub App auth and
// preflight setup that runs ahead of every command — validatePositionals runs
// immediately after parsing, before any of that.
test("positional grammar is enforced before dispatch, not silently accepted", () => {
  assert.throws(() => validatePositionals("completion", ["typo"], {}), (e) => e.exit === 64);
  assert.throws(() => validatePositionals("dashboard", ["extra"], {}), (e) => e.exit === 64);
  assert.throws(() => validatePositionals("version", ["extra"], {}), (e) => e.exit === 64);
  assert.doesNotThrow(() => validatePositionals("help", ["task"], {}));
  assert.doesNotThrow(() => validatePositionals("dashboard", [], {}));
  for (const [command, message, validArg] of [
    ["issue", /usage: orch issue <number>/, "42"],
    ["review", /usage: orch review <branch>/, "x"],
    ["continue", /usage: orch continue <sid>/, "x"],
    ["pr", /usage: orch pr <number>/, "42"],
    ["release", /usage: orch release/, "x"],
  ]) {
    assert.throws(() => validatePositionals(command, [], {}), (e) => e.exit === 64 && message.test(e.message), command);
    assert.doesNotThrow(() => validatePositionals(command, [validArg], {}), command);
  }
});

// `issue` takes a numeric ID, but that used to be checked deep inside its
// handler — after main() had already fired the update-check network call and
// minted a GitHub App token (see cli.js's main()). A non-numeric ID now fails
// right here, before any of that runs. PR accepts either a number or branch.
test("issue rejects a non-numeric ID and pr accepts a branch", () => {
  assert.throws(
    () => validatePositionals("issue", ["abc"], {}),
    (e) => e.exit === 64 && /usage: orch issue <number>/.test(e.message),
  );
  assert.doesNotThrow(() => validatePositionals("pr", ["feature/x"], {}));
});

// `task` and `release` build their free text with `rest.join(" ")` in
// cli.js, so an unquoted `orch task add input validation` arrives as three
// positionals, not one. Capping the max here once rejected that as "too
// many arguments" before the handler ever got to join them back together.
test("task and release accept unquoted multi-word text", () => {
  assert.doesNotThrow(() => validatePositionals("task", ["add", "input", "validation"], {}));
  assert.doesNotThrow(() => validatePositionals("release", ["hand-landed", "fix", "(closes", "#5)"], {}));
});

test("--help and --version are legal on every command", () => {
  for (const command of Object.keys(COMMANDS)) {
    for (const name of GLOBAL_FLAGS) {
      const { flags } = parse([command, `--${name}`]);
      // --help/--version make themselves the effective command, which accepts
      // no other flags — so validate them one at a time.
      assert.doesNotThrow(() => validate(command, flags), `orch ${command} --${name}`);
    }
  }
});

test("--json is scoped to dashboard, config, and run-controller commands", () => {
  assert.doesNotThrow(() => validate("dashboard", { json: true }));
  assert.doesNotThrow(() => validate("config", { json: true }));
  const RUN_CONTROLLED = new Set(["task", "issue", "review", "pr"]);
  for (const command of Object.keys(COMMANDS).filter((c) => c !== "dashboard" && c !== "config")) {
    if (command === "continue") {
      assert.doesNotThrow(() => validate(command, { json: true }), "orch continue --json");
      continue;
    }
    if (RUN_CONTROLLED.has(command)) {
      assert.throws(
        () => validate(command, { json: true }),
        (e) => e.exit === 64 && /--json on .* requires --until ready/.test(e.message),
        `orch ${command} --json (no --until)`,
      );
      assert.doesNotThrow(() => validate(command, { json: true, until: "ready" }), `orch ${command} --json --until ready`);
      continue;
    }
    assert.throws(
      () => validate(command, { json: true }),
      (e) => e.exit === 64 && /--json is not valid with/.test(e.message),
      `orch ${command} --json`,
    );
  }
});

test("an out-of-scope flag names the commands where it IS legal", () => {
  assert.throws(() => validate("issue", { file: "f" }), /--file is not valid with 'orch issue' — only with: orch task/);
  assert.throws(() => validate("issue", { merge: true }), /only with: orch pr/);
});

test("--dry on a read-only command is refused as meaningless, not as unknown", () => {
  for (const command of Object.keys(COMMANDS).filter((c) => COMMANDS[c].mutates === false)) {
    assert.throws(
      () => validate(command, { dry: true }),
      (e) => e.exit === 64 && e.message === `--dry has no effect on 'orch ${command}' — it changes nothing`,
      command,
    );
  }
  // ...and it stays legal on the mutating commands that plan with it.
  for (const command of ["task", "issue", "pr", "release", "init", "agent", "upgrade"]) {
    assert.doesNotThrow(() => validate(command, { dry: true }), command);
  }
});

test("numeric flags are validated, not silently NaN", () => {
  for (const argv of [["dashboard", "--limit", "nope"], ["dashboard", "--limit", "0"], ["dashboard", "--limit", "1.5"]]) {
    const { command, flags } = parse(argv);
    assert.throws(() => validate(command, flags), (e) => e.exit === 64 && /--limit must be a positive integer/.test(e.message), argv.join(" "));
  }
  // --refresh-ms used to reach Number() unchecked: `--refresh-ms abc` became a
  // NaN poll interval inside the live TUI instead of a usage error.
  const { flags } = parse(["dashboard", "--refresh-ms", "abc"]);
  assert.throws(() => validate("dashboard", flags), /--refresh-ms must be a positive integer/);
});

test("--max-attempts is not declared — it would be a silent no-op, nothing reads it yet", () => {
  assert.equal(FLAGS["max-attempts"], undefined);
  assert.throws(
    () => validate("task", { "max-attempts": "1" }),
    (e) => e.exit === 64 && /--max-attempts is not valid with 'orch task'/.test(e.message),
  );
});

test("--until ready|merged is available on task/issue/review/pr; continue is not", () => {
  for (const command of ["task", "issue", "review", "pr"]) {
    assert.doesNotThrow(() => validate(command, { until: "once" }), `${command} once`);
  }
  for (const mode of ["ready", "merged"]) {
    for (const command of ["task", "issue", "review", "pr"]) {
      assert.doesNotThrow(() => validate(command, { until: mode }), `${command} ${mode}`);
    }
    assert.throws(
      () => validate("continue", { until: mode }),
      (e) => e.exit === 64 && /is not yet available/.test(e.message),
      `continue ${mode}`,
    );
  }
  assert.throws(() => validate("task", { until: "forever" }), /--until must be one of: once, ready, merged/);
});

// `orch review` audits an existing branch: the reviewed author is read off
// the branch name and review never merges, so --author/--authors (who
// authors) and --no-tidy (post-merge cleanup) have nothing to act on. RUN_FLAGS
// used to be shared verbatim across task/issue/review/continue, so these
// validated on review and silently did nothing — the same "declared but
// inert" defect the schema exists to remove.
test("orch review rejects --author/--authors/--no-tidy, which it cannot honour", () => {
  for (const name of ["author", "authors", "no-tidy"]) {
    const { flags } = parse(["review", ...sample(name)]);
    assert.throws(() => validate("review", flags), (e) => e.exit === 64, `orch review --${name}`);
  }
  // --reviewer(s)/--cheap ARE honoured (they pick who audits) — still legal.
  for (const name of ["reviewer", "reviewers", "cheap"]) {
    const { flags } = parse(["review", ...sample(name)]);
    assert.doesNotThrow(() => validate("review", flags), `orch review --${name}`);
  }
});

// `orch pr` audits an existing GitHub PR's author — applyRoleOverrides is
// called with allowReviewerOnly, so runPr only ever reads --reviewer(s). A
// passed --author was silently ignored while runPr assigned the reviewer as
// authorName, which reads to a human as "I set the author" doing nothing.
test("orch pr rejects --author/--authors, which it cannot honour", () => {
  for (const name of ["author", "authors"]) {
    const { flags } = parse(["pr", ...sample(name)]);
    assert.throws(() => validate("pr", flags), (e) => e.exit === 64, `orch pr --${name}`);
  }
  for (const name of ["reviewer", "reviewers"]) {
    const { flags } = parse(["pr", ...sample(name)]);
    assert.doesNotThrow(() => validate("pr", flags), `orch pr --${name}`);
  }
});

// `task --file` intake is untrusted (§3a/§3b) and used to be cross-validated
// deep inside the `task` handler, after main() had already minted a GitHub
// App token for a run that was about to be refused anyway. validatePositionals
// runs before any of that.
test("orch task --file plus a positional is rejected before dispatch", () => {
  assert.throws(
    () => validatePositionals("task", ["stray"], { file: "wo.json" }),
    (e) => e.exit === 64 && /takes no positional task text/.test(e.message),
  );
});

test("an unknown option is a usage error, not a raw parseArgs crash", () => {
  assert.throws(
    () => parse(["task", "x", "--nope"]),
    (e) => e.exit === 64 && /unknown option --nope \(run 'orch help' for usage\)/.test(e.message),
  );
});

test("an unknown command exits 64 and asks for the usage text", async () => {
  const prev = cwd();
  chdir(mkdtempSync(join(tmpdir(), "orch-schema-")));
  try {
    await assert.rejects(
      () => main(["tsk", "x"], { preflight() {} }),
      (e) => e.exit === 64 && e.showUsage === true && /unknown command: tsk/.test(e.message),
    );
  } finally {
    chdir(prev);
  }
});

// A flag with no command at all (`orch --merge`) used to fall through
// main()'s no-command branch, print the usage text, and exit 0 — the flag
// was silently dropped rather than refused, same "declared but inert" family
// as every other finding in this file.
test("a flag with no command is a usage error, not a silent no-op", async () => {
  const prev = cwd();
  chdir(mkdtempSync(join(tmpdir(), "orch-schema-bare-flag-")));
  try {
    await assert.rejects(
      () => main(["--merge"], { preflight() {} }),
      (e) => e.exit === 64 && /--merge requires a command/.test(e.message),
    );
  } finally {
    chdir(prev);
  }
});

test("orch pr --dry performs zero gh calls (real merge stays impossible)", async () => {
  const prev = cwd();
  chdir(mkdtempSync(join(tmpdir(), "orch-schema-pr-")));
  const gh = mkGh();
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => logs.push(a.map(String).join(" "));
  try {
    await main(["pr", "42", "--merge", "--dry"], {
      preflight() { assert.fail("preflight ran on a dry run"); },
      githubDeps: () => ({ gh, git: () => "" }),
    });
  } finally {
    console.log = origLog;
    chdir(prev);
  }
  assert.equal(gh.calls.length, 0, `gh was called: ${JSON.stringify(gh.calls)}`);
  assert.match(logs.join("\n"), /orch \(dry\): would review PR #42 and merge it if approved/);
});

// `--file=` / `--config-file=` parse to an empty string via parseArgs, and
// every reader checks `if (flags.file)` — so an explicitly empty value used
// to be treated exactly like an absent one instead of a usage error.
test("an empty flag value is a usage error, not silently treated as absent", () => {
  assert.throws(
    () => validate("task", parse(["task", "hello", "--file="]).flags),
    (e) => e.exit === 64 && /--file requires a non-empty value/.test(e.message),
  );
  assert.throws(
    () => validate("config", parse(["config", "--config-file="]).flags),
    (e) => e.exit === 64 && /--config-file requires a non-empty value/.test(e.message),
  );
});

// --cheap forces both roles to cfg.cheap.role; combined with an explicit
// --author/--reviewer it's ambiguous which one wins. This used to be checked
// deep inside applyCheapOverride (cli.js), after the command had already
// fetched a GitHub issue / minted a GitHub App token for a run that was
// always going to be refused. It is flag-only, so validate() can catch it
// before any of that runs.
test("--cheap combined with an explicit role override is a usage error", () => {
  assert.throws(
    () => validate("issue", { cheap: true, reviewer: "codex" }),
    (e) => e.exit === 64 && /--cheap cannot be combined with/.test(e.message),
  );
  assert.throws(
    () => validate("task", { cheap: true, authors: "claude,codex" }),
    (e) => e.exit === 64 && /--cheap cannot be combined with/.test(e.message),
  );
  assert.doesNotThrow(() => validate("issue", { cheap: true }));
  assert.doesNotThrow(() => validate("issue", { reviewer: "codex" }));
});

// `task` has no minimum in POSITIONAL_ARITY (--file supplies the text
// instead), but it still needs ONE of the two sources. This used to be
// checked deep inside the `task` handler (cli.js), after main() had already
// fired the update-check network call and minted a GitHub App token for a
// bare `orch task` that was always going to be refused.
test("a bare 'orch task' with neither text nor --file is a usage error before dispatch", () => {
  assert.throws(
    () => validatePositionals("task", [], {}),
    (e) => e.exit === 64 && /usage: orch task/.test(e.message),
  );
  assert.doesNotThrow(() => validatePositionals("task", ["do", "x"], {}));
  assert.doesNotThrow(() => validatePositionals("task", [], { file: "wo.json" }));
});

// The internal update-check re-exec target ("__update-check-child", spawned
// by cli.js's own update-check code) had no schema entry at all, so it was
// exempt from validate() entirely — a stray flag on it would have been
// silently accepted, unlike every real command.
test("the internal update-check re-exec command rejects a stray flag", () => {
  assert.throws(
    () => validate("__update-check-child", { merge: true }),
    (e) => e.exit === 64,
  );
  assert.doesNotThrow(() => validate("__update-check-child", {}));
  // Not a real command: absent from --help and tab completion.
  assert.ok(!Object.keys(COMMANDS).includes("__update-check-child"));
});

// parseArgs silently keeps only the LAST occurrence of a repeated non-boolean
// flag, so "--until ready --until once" parsed to just {until: "once"} — the
// first value the user typed was discarded with no error at all.
test("repeating a single-value flag is a usage error", () => {
  assert.throws(
    () => parse(["task", "x", "--until", "ready", "--until", "once"]),
    (e) => e.exit === 64 && /--until given more than once/.test(e.message),
  );
  assert.throws(
    () => parse(["task", "x", "--file", "a.json", "--file", "a.json"]),
    (e) => e.exit === 64 && /--file given more than once/.test(e.message),
  );
  // Boolean flags aren't affected — "--dry --dry" is redundant, not conflicting.
  assert.doesNotThrow(() => parse(["task", "x", "--dry", "--dry"]));
});

test("help renders grouped pages from the schema without leaking scoped flags", () => {
  const global = renderHelp();
  for (const name of Object.keys(COMMANDS)) {
    assert.match(global, new RegExp(`\\b${name}\\b`), `global help missing command ${name}`);
    const page = renderHelp(name);
    for (const flag of COMMANDS[name].flags) {
      assert.match(page, new RegExp(`--${flag}(?![\\w-])`), `orch ${name} --help omits --${flag}`);
    }
  }
  assert.match(global, /Set up a repo:\n/);
  assert.match(global, /Run a cycle:\n/);
  assert.match(global, /Review and land:\n/);
  assert.match(global, /Operate:\n/);
  assert.match(global, /Maintain:\n/);
  const scoped = new Set(Object.values(COMMANDS).flatMap((command) => command.flags));
  for (const flag of scoped) {
    if (GLOBAL_FLAGS.includes(flag)) continue;
    assert.doesNotMatch(global, new RegExp(`^\\s+--${flag}(?![\\w-])`, "m"), `global help lists --${flag}`);
  }
});

test("the help option rows stay bidirectionally aligned with command flags", () => {
  for (const [command, spec] of Object.entries(COMMANDS)) {
    const page = renderHelp(command);
    const optionsStart = page.indexOf("\nOptions:");
    if (optionsStart < 0) continue;
    const optionsEnd = page.indexOf("\n\nArguments:", optionsStart);
    const options = page.slice(optionsStart, optionsEnd < 0 ? page.length : optionsEnd);
    // A row starts with exactly a 2-space indent; its label occupies columns
    // 2-26 (pad() pads to 24) before the description prose begins. Matching
    // "--flag" anywhere in the blob is fooled by a description that mentions
    // another flag by name (e.g. --merge's row says "Alias for --until
    // merged"), which wraps onto its own 26-space-indented continuation line
    // and would otherwise read as a row for a flag that has none. Restricting
    // the match to each real row's label zone catches a dropped row even when
    // another row's prose happens to name the same flag.
    const documented = new Set(
      options
        .split("\n")
        .filter((line) => /^ {2}--/.test(line))
        .flatMap((line) => [...line.slice(0, 26).matchAll(/--([\w-]+)/g)].map((match) => match[1])),
    );
    for (const flag of documented) {
      assert.ok(spec.flags.includes(flag) || GLOBAL_FLAGS.includes(flag), `orch ${command} help has undeclared --${flag}`);
    }
    for (const flag of spec.flags) {
      assert.ok(documented.has(flag), `orch ${command} help omits --${flag}`);
    }
  }
});

// `orch continue <sid>` uses the positional directly as a sid-store key
// (checkpoint.js/inflight.js via sid-store.js's `join(dir, key + ".json")`).
// A sid is always CLI-generated, but this positional is operator-typed and
// used unchecked — `orch continue ../../etc/passwd` could `join()` outside
// .orch/checkpoints and (via sid-store.js's corrupt-file self-heal) delete a
// file it was never meant to touch.
test("orch continue rejects a sid that could path-traverse out of the store", () => {
  for (const sid of ["../../etc/passwd", "a/b", "..", "a/../../b", "\0"]) {
    assert.throws(
      () => validatePositionals("continue", [sid], {}),
      (e) => e.exit === 64 && /invalid sid/.test(e.message),
      sid,
    );
  }
  assert.doesNotThrow(() => validatePositionals("continue", ["12345-a"], {}));
});

// `--author`/`--authors`/`--reviewer`/`--reviewers` name an agent; an
// unregistered one used to surface deep inside preflight() (cli.js) — after
// the update-check network call and GitHub App token mint main() fires ahead
// of every command. parseRoleSpec/parseRoleSpecs (config.js) already throw
// for an unknown agent; validate() now runs them before any side effect.
test("an unregistered agent in a role flag is a usage error before dispatch", () => {
  for (const name of ["author", "reviewer"]) {
    assert.throws(
      () => validate("task", { [name]: "not-a-real-agent", ...(name === "author" ? { reviewer: "claude" } : { author: "claude" }) }),
      (e) => e.exit === 64 && /unknown agent/.test(e.message),
      `orch task --${name}`,
    );
  }
  for (const name of ["authors", "reviewers"]) {
    assert.throws(
      () => validate("task", { [name]: "not-a-real-agent", ...(name === "authors" ? { reviewers: "claude" } : { authors: "claude" }) }),
      (e) => e.exit === 64 && /unknown agent/.test(e.message),
      `orch task --${name}`,
    );
  }
  assert.doesNotThrow(() => validate("task", { author: "claude", reviewer: "codex" }));
});

// `task`/`issue` are the only commands whose schema carries all four role
// flags: --reviewer(s) alone is meaningful (rotate author, force reviewer —
// cli.js's applyRoleOverrides passes allowReviewerOnly for these), but
// --author(s) alone is not. That rejection used to surface only once
// applyRoleOverrides ran, deep inside the command handler, after main()'s
// update-check/token-mint side effects.
test("orch task/issue reject --author(s) without a paired --reviewer(s)", () => {
  for (const command of ["task", "issue"]) {
    assert.throws(
      () => validate(command, { author: "claude" }),
      (e) => e.exit === 64 && /set both --author\(s\) and --reviewer\(s\), or neither/.test(e.message),
      `orch ${command} --author`,
    );
    assert.doesNotThrow(() => validate(command, { reviewer: "claude" }), `orch ${command} --reviewer`);
    assert.doesNotThrow(() => validate(command, { author: "claude", reviewer: "codex" }), `orch ${command} both`);
  }
});

// buildAgent's applyRoleOverrides call (cli.js) is NOT given allowReviewerOnly
// — a build's author/reviewer are either both overridden or both left to
// rotation, never just one. That rule used to surface only once buildAgent
// ran, after main()'s update-check/token-mint side effects.
test("orch agent build rejects a lone --author or --reviewer", () => {
  assert.throws(
    () => validatePositionals("agent", ["build", "newagent"], { author: "claude" }),
    (e) => e.exit === 64 && /set both --author\(s\) and --reviewer\(s\), or neither/.test(e.message),
  );
  assert.throws(
    () => validatePositionals("agent", ["build", "newagent"], { reviewer: "claude" }),
    (e) => e.exit === 64 && /set both --author\(s\) and --reviewer\(s\), or neither/.test(e.message),
  );
  assert.doesNotThrow(() =>
    validatePositionals("agent", ["build", "newagent"], { author: "claude", reviewer: "codex" }));
  assert.doesNotThrow(() => validatePositionals("agent", ["build", "newagent"], {}));
});

// `orch task "   "` (whitespace-only) used to pass main()'s `if (!task)`
// check — a string of only spaces is truthy — and run a cycle with a blank
// task label. This lives in cli.js (the join happens there), not
// validatePositionals, so it's exercised through main() below in cli.test.js;
// this test only pins the positional-arity contract that whitespace-only
// text is still ONE positional, not zero.
test("a whitespace-only task positional still satisfies POSITIONAL_ARITY (cli.js rejects the content)", () => {
  assert.doesNotThrow(() => validatePositionals("task", ["   "], {}));
});
