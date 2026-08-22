import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { BASH_COMPLETION, installCompletion } from "../src/completion.js";
import { main } from "../src/cli.js";
import { COMMANDS, FLAGS, GLOBAL_FLAGS, SUBCOMMANDS, SUBCOMMAND_FLAGS } from "../src/schema.js";

// complete() below shells out to a real `bash` to exercise the generated
// script end to end (see its own comment). That binary isn't guaranteed on
// Windows CI, unlike the POSIX shell stubs the rest of the suite relies on —
// so every test that calls it is skipped there, same pattern as
// tag-release-errexit.test.js.
const BASH_SKIP = { skip: process.platform === "win32" ? "requires a real bash" : false };

test("BASH_COMPLETION registers the completion function for orch", () => {
  assert.match(BASH_COMPLETION, /complete -F _orch_completion orch/);
});

// Asserting on the generated script's TEXT (a flat "local flags=..." line) is
// how the previous version of this file passed while the completion actively
// offered flags the parser rejects (`orch dashboard --merge`) — the text
// looked right; the behaviour did not. This sources the real script into a
// real bash, sets COMP_WORDS/COMP_CWORD exactly as bash-completion would, and
// reads back the COMPREPLY array _orch_completion actually produced.
function complete(words, cword) {
  const quoted = words.map((w) => `'${w.replace(/'/g, `'\\''`)}'`).join(" ");
  const script = `${BASH_COMPLETION}
COMP_WORDS=(${quoted})
COMP_CWORD=${cword}
_orch_completion
printf '%s\\n' "\${COMPREPLY[@]}"
`;
  return execFileSync("bash", ["-c", script], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

test("completion offers exactly the flags each command's schema declares", BASH_SKIP, () => {
  // `agent` is excluded: its COMMANDS.flags is the add∪build union (needed by
  // the generic parser matrix test, which has no subcommand to key off), but
  // completion must not offer that union — see the dedicated test below.
  for (const [command, spec] of Object.entries(COMMANDS)) {
    if (command === "agent") continue;
    // A command with a mandatory subcommand slot (SUBCOMMANDS) offers only
    // that slot's words right after the command — flags come one position
    // later, once the subcommand itself is typed.
    const words = SUBCOMMANDS[command]
      ? ["orch", command, SUBCOMMANDS[command][0], ""]
      : ["orch", command, ""];
    const offered = new Set(complete(words, words.length - 1));
    for (const name of [...GLOBAL_FLAGS, ...spec.flags]) {
      assert.ok(offered.has(`--${name}`), `orch ${command} completion missing --${name}`);
    }
    // The negative case: a flag legal elsewhere but not on this command must
    // be absent, not merely "also offered" alongside the right ones — this is
    // what would have caught `dashboard` offering `--merge`.
    for (const name of Object.keys(FLAGS)) {
      if (spec.flags.includes(name) || GLOBAL_FLAGS.includes(name)) continue;
      assert.ok(!offered.has(`--${name}`), `orch ${command} completion should not offer --${name}`);
    }
  }
});

// `agent add` and `agent build` don't share a flag set (schema.js
// SUBCOMMAND_FLAGS) — completion used to render `agent`'s flag list as one
// union, so `orch agent add <TAB>` offered `--pr`/`--author`/etc, all of
// which the parser refuses on `add` without `--build`. This is finding 8 for
// the one command the generic per-command test above can't cover, because
// `agent`'s own COMMANDS.flags entry is deliberately that same union.
test("agent add and agent build completion do not offer each other's flags", BASH_SKIP, () => {
  for (const [key, flags] of Object.entries(SUBCOMMAND_FLAGS)) {
    const sub = key.split(" ")[1];
    const offered = new Set(complete(["orch", "agent", sub, ""], 3));
    for (const name of [...GLOBAL_FLAGS, ...flags]) {
      assert.ok(offered.has(`--${name}`), `orch agent ${sub} completion missing --${name}`);
    }
    for (const name of Object.keys(FLAGS)) {
      if (flags.includes(name) || GLOBAL_FLAGS.includes(name)) continue;
      assert.ok(!offered.has(`--${name}`), `orch agent ${sub} completion should not offer --${name}`);
    }
  }
});

test("completion offers every subcommand the schema declares", BASH_SKIP, () => {
  for (const [command, words] of Object.entries(SUBCOMMANDS)) {
    assert.deepEqual(complete(["orch", command, ""], 2).sort(), [...words].sort());
  }
});

test("completion offers nothing right after a value-taking flag", BASH_SKIP, () => {
  assert.deepEqual(complete(["orch", "task", "--author", ""], 3), []);
  assert.deepEqual(complete(["orch", "dashboard", "--limit", ""], 3), []);
});

test("completion finds the command word even when a flag precedes it", BASH_SKIP, () => {
  // parseArgs (and so orch itself) accepts options before positionals; the
  // completion script used to assume COMP_WORDS[1] was always the command.
  const offered = new Set(complete(["orch", "--dry", "pr", ""], 3));
  assert.ok(offered.has("--merge"), "flag-before-command should still resolve to pr's flags");
  assert.ok(!offered.has("--file"), "flag-before-command should not fall back to the global flag union");
});

test("completion at the command position offers every command and the global flags", BASH_SKIP, () => {
  const offered = complete(["orch", ""], 1);
  for (const command of Object.keys(COMMANDS)) assert.ok(offered.includes(command), command);
  for (const name of GLOBAL_FLAGS) assert.ok(offered.includes(`--${name}`), name);
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

test("completion offers every command listed in --help", BASH_SKIP, async () => {
  // Names come from the Commands: block of printUsage(); "upgrade, update" is two.
  const documented = new Set(
    (await usage()).match(/\nCommands:\n([\s\S]*?)\n\n/)[1]
      .split("\n")
      .flatMap((line) => line.trim().split(/\s{2,}/)[0].split(/,\s*/).map((n) => n.split(/\s+/)[0]))
      .filter(Boolean),
  );
  assert.ok(documented.has("config"), "help text no longer documents config — fix the test's parser");
  const commands = complete(["orch", ""], 1).filter((w) => !w.startsWith("-"));
  for (const name of documented) assert.ok(commands.includes(name), `completion commands missing ${name}`);
  // And the reverse: a command offered by tab-completion but absent from --help is
  // undiscoverable for anyone who reads the help instead of pressing Tab.
  for (const name of commands) assert.ok(documented.has(name), `--help Commands section missing ${name}`);
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
