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
      const { flags } = parse([command, ...sample(name)]);
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

// `completion typo`, `dashboard extra`, `help extra`, `version extra` used to
// run the command and ignore the extra argument. And a required positional
// (a number, a branch, a name) used to be checked deep inside each command's
// own handler, after main() had already reached the GitHub App auth and
// preflight setup that runs ahead of every command — validatePositionals runs
// immediately after parsing, before any of that.
test("positional grammar is enforced before dispatch, not silently accepted", () => {
  assert.throws(() => validatePositionals("completion", ["typo"], {}), (e) => e.exit === 64);
  assert.throws(() => validatePositionals("dashboard", ["extra"], {}), (e) => e.exit === 64);
  assert.throws(() => validatePositionals("help", ["extra"], {}), (e) => e.exit === 64);
  assert.throws(() => validatePositionals("version", ["extra"], {}), (e) => e.exit === 64);
  assert.doesNotThrow(() => validatePositionals("dashboard", [], {}));
  for (const [command, message] of [
    ["issue", /usage: orch issue <number>/],
    ["review", /usage: orch review <branch>/],
    ["continue", /usage: orch continue <sid>/],
    ["pr", /usage: orch pr <number>/],
    ["release", /usage: orch release/],
  ]) {
    assert.throws(() => validatePositionals(command, [], {}), (e) => e.exit === 64 && message.test(e.message), command);
    assert.doesNotThrow(() => validatePositionals(command, ["x"], {}), command);
  }
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

test("--json is scoped to dashboard, not global", () => {
  assert.doesNotThrow(() => validate("dashboard", { json: true }));
  for (const command of Object.keys(COMMANDS).filter((c) => c !== "dashboard")) {
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

test("--until accepts only the mode that exists today", () => {
  assert.doesNotThrow(() => validate("task", { until: "once" }));
  for (const mode of ["ready", "merged"]) {
    assert.throws(
      () => validate("task", { until: mode }),
      (e) => e.exit === 64 && /is not yet available/.test(e.message),
      mode,
    );
  }
  assert.throws(() => validate("task", { until: "forever" }), /--until must be one of: once, ready, merged/);
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

test("help renders from the schema: every command and every flag", () => {
  const help = renderHelp();
  // `update` shares upgrade's row ("upgrade, update"), so match the name inside
  // the Commands block rather than only at the start of a row.
  const commandBlock = help.match(/\nCommands:\n([\s\S]*?)\n\n/)[1];
  for (const name of Object.keys(COMMANDS)) {
    assert.match(commandBlock, new RegExp(`\\b${name}\\b`), `help missing command ${name}`);
  }
  for (const [name, f] of Object.entries(FLAGS)) {
    if (!f.help && name !== "plain") continue;
    assert.match(help, new RegExp(`--${name}(?![\\w-])`), `help missing --${name}`);
  }
});
