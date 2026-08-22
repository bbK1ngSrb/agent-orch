import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { BASH_COMPLETION, installCompletion } from "../src/completion.js";
import { main } from "../src/cli.js";
import { COMMANDS, FLAGS, SUBCOMMANDS } from "../src/schema.js";

test("BASH_COMPLETION registers the completion function for orch", () => {
  assert.match(BASH_COMPLETION, /complete -F _orch_completion orch/);
  assert.match(BASH_COMPLETION, /add build/);
  assert.match(BASH_COMPLETION, /upgrade update/);
  assert.match(BASH_COMPLETION, /--check/);
  assert.match(BASH_COMPLETION, /--check-history/);
  assert.match(BASH_COMPLETION, /--allow-protected/);
});

// Set parity, not spot checks: a completion list that misses a flag the parser
// accepts hides that flag from <TAB>, which is how users discover a CLI. Both
// the completion script and the parser now render from src/schema.js, so this
// checks the renderer against its source — the spot checks above are the
// backstop that would catch a renderer emitting nothing at all.
test("BASH_COMPLETION offers every flag the parser accepts", () => {
  const flags = BASH_COMPLETION.match(/^\s*local flags="([^"]*)"/m)?.[1].split(/\s+/);
  assert.ok(flags?.length, "could not read the flags list out of BASH_COMPLETION");
  for (const [name, spec] of Object.entries(FLAGS)) {
    assert.ok(flags.includes(`--${name}`), `completion flags missing --${name}`);
    if (spec.short) assert.ok(flags.includes(`-${spec.short}`), `completion flags missing -${spec.short}`);
  }
});

// The subcommand words are positional literals, not flags, so they have their
// own schema entry — and their own way to drift out of the completion script.
test("BASH_COMPLETION offers every subcommand the schema declares", () => {
  for (const [command, words] of Object.entries(SUBCOMMANDS)) {
    const offered = BASH_COMPLETION.match(new RegExp(`${command}\\)[\\s\\S]*?compgen -W "([^"]*)"`))?.[1].split(/\s+/);
    assert.deepEqual(offered, words, `completion subcommands for ${command}`);
  }
});

async function usage() {
  const logs = [];
  const orig = console.log;
  console.log = (m) => logs.push(m);
  try {
    await main(["help"], { preflight() {} });
  } finally {
    console.log = orig;
  }
  return logs.join("\n");
}

test("--help documents every flag the parser accepts", async () => {
  const options = (await usage()).match(/\nOptions:\n([\s\S]*?)\n\n/)[1];
  for (const name of Object.keys(FLAGS)) {
    assert.match(options, new RegExp(`--${name}(?![\\w-])`), `Options section missing --${name}`);
  }
});

test("BASH_COMPLETION offers every command listed in --help", async () => {
  const commands = BASH_COMPLETION.match(/^\s*local commands="([^"]*)"/m)?.[1].split(/\s+/);
  assert.ok(commands?.length, "could not read the commands list out of BASH_COMPLETION");
  // Names come from the Commands: block of printUsage(); "upgrade, update" is two.
  const documented = new Set(
    (await usage()).match(/\nCommands:\n([\s\S]*?)\n\n/)[1]
      .split("\n")
      .flatMap((line) => line.trim().split(/\s{2,}/)[0].split(/,\s*/).map((n) => n.split(/\s+/)[0]))
      .filter(Boolean),
  );
  assert.ok(documented.has("config"), "help text no longer documents config — fix the test's parser");
  for (const name of documented) {
    assert.ok(commands.includes(name), `completion commands missing ${name}`);
  }
  // And the reverse: a command offered by tab-completion but absent from --help is
  // undiscoverable for anyone who reads the help instead of pressing Tab. `version`
  // drifted this way (#461) — completion offered it, printUsage never listed it.
  for (const name of commands) {
    assert.ok(documented.has(name), `--help Commands section missing ${name}`);
  }
  // ...and both lists are the schema's, so a command added there shows up in
  // completion and help together or the parity above fails.
  assert.deepEqual([...commands].sort(), Object.keys(COMMANDS).sort());
});

test("installCompletion writes the script under <home>/.orch and reports the path", () => {
  const written = {};
  const result = installCompletion({
    homedir: () => "/fake/home",
    existsSync: () => false,
    mkdirSync: (dir) => { written.dir = dir; },
    writeFileSync: (path, content) => { written.path = path; written.content = content; },
  });
  // Expected paths built with join(), not hardcoded forward slashes: installCompletion
  // uses the native separator (backslash on Windows), and that's correct — join()
  // is the platform-appropriate way to build a path, not a bug to work around.
  assert.equal(result.ok, true);
  assert.equal(result.path, join("/fake/home", ".orch", "completion.bash"));
  assert.equal(written.dir, join("/fake/home", ".orch"));
  assert.equal(written.content, BASH_COMPLETION);
});

test("installCompletion never throws — reports failure instead", () => {
  const result = installCompletion({
    homedir: () => "/fake/home",
    existsSync: () => false,
    mkdirSync: () => { throw new Error("EACCES"); },
    writeFileSync: () => {},
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /EACCES/);
});
