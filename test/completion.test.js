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
  // `completion` is excluded too: its COMMANDS.flags includes --dry, but
  // --dry is only legal on the `install` subcommand, not `bash` (the first
  // subcommand this loop would probe) — see the dedicated test below.
  for (const [command, spec] of Object.entries(COMMANDS)) {
    if (command === "agent" || command === "completion") continue;
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

// `agent add` has one optional build workflow; without --build it only offers
// registration flags, while --build widens the set for an unregistered name.
test("agent add and agent build completion do not offer each other's flags", BASH_SKIP, () => {
  const offered = new Set(complete(["orch", "agent", "add", ""], 3));
  assert.ok(offered.has("--build"));
  assert.ok(!offered.has("--author"));
  assert.ok(!offered.has("--reviewer"));
});

// `orch agent --dry <TAB>` used to fall through to the global-flag fallback:
// the subcommand-flag lookup assumed "add"/"build" always sat immediately
// after "agent", so a global flag typed first (legal — parseArgs allows
// options before positionals) hid it from the lookup entirely.
test("orch agent --dry completion still offers add/build, not just global flags", BASH_SKIP, () => {
  const offered = complete(["orch", "agent", "--dry", ""], 3);
  assert.deepEqual(offered.sort(), [...SUBCOMMANDS.agent].sort());
});

// `orch agent add --build` legally accepts the build-only flags too
// (validateAgentArgs, schema.js) — completion used to always render `agent
// add`'s narrower static flag set regardless of whether --build had already
// been typed, so `--pr` never appeared even though the parser would accept it.
test("orch agent add --build completion offers the build-only flags", BASH_SKIP, () => {
  const offered = new Set(complete(["orch", "agent", "add", "--build", ""], 4));
  for (const name of ["allow-large-scope", "author", "authors", "reviewer", "reviewers"]) {
    assert.ok(offered.has(`--${name}`), `orch agent add --build completion missing --${name}`);
  }
});

// `agent add <name> --build` only legally accepts the build-only flags when
// <name> is NOT already an adapter orch ships code for — validateAgentArgs
// (schema.js) refuses them unconditionally for a known name, since a known
// name never builds regardless of --build. Completion used to widen the flag
// set on --build alone, without checking <name>, so `orch agent add claude
// --build --p<TAB>` suggested `--pr` for an invocation the parser refuses.
test("orch agent add <known-adapter> --build completion does not offer the build-only flags", BASH_SKIP, () => {
  const offered = new Set(complete(["orch", "agent", "add", "claude", "--build", ""], 5));
  for (const name of ["allow-large-scope", "author", "authors", "reviewer", "reviewers"]) {
    assert.ok(!offered.has(`--${name}`), `orch agent add claude --build should not offer --${name}`);
  }
  // An unregistered name right next to it still gets the full build-only set.
  const unknown = new Set(complete(["orch", "agent", "add", "totally-new-agent", "--build", ""], 5));
  for (const name of ["allow-large-scope", "author", "authors", "reviewer", "reviewers"]) {
    assert.ok(unknown.has(`--${name}`), `orch agent add totally-new-agent --build missing --${name}`);
  }
});

// `orch completion bash --dry` used to be offered by tab-completion and then
// refused by the parser (schema.js's validatePositionals: --dry only applies
// to `completion install`, since `completion [bash]` only prints). This is
// finding 9: the plain, subcommand-agnostic per-command flag list completion
// used before was flat, so it couldn't tell `bash` and `install` apart.
test("completion offers --dry only for 'completion install', not 'completion bash'", BASH_SKIP, () => {
  const bash = new Set(complete(["orch", "completion", "bash", ""], 3));
  assert.ok(!bash.has("--dry"), "orch completion bash should not offer --dry");
  const install = new Set(complete(["orch", "completion", "install", ""], 3));
  assert.ok(install.has("--dry"), "orch completion install should offer --dry");
});

// Right after the command word, before any subcommand is typed, a flag can
// still legally come next too ("orch agent --dry add ...", "orch completion
// --dry install") — so completion offers the subcommand words plus whatever
// flags are common to every one of that command's subcommands (GLOBAL_FLAGS
// always included), not the subcommand words alone.
test("completion offers every subcommand the schema declares, plus flags legal before any subcommand", BASH_SKIP, () => {
  for (const [command, words] of Object.entries(SUBCOMMANDS)) {
    const subKeys = Object.keys(SUBCOMMAND_FLAGS).filter((k) => k.startsWith(`${command} `));
    const flagSets = subKeys.map((k) => new Set(SUBCOMMAND_FLAGS[k]));
    const commonFlags = command === "agent"
      ? ["config-file", "dry", "build"]
      : flagSets.length
      ? [...flagSets[0]].filter((f) => flagSets.every((s) => s.has(f)))
      : COMMANDS[command].flags.filter((f) => f !== "dry"); // completion: --dry only legal once "install" is known
    const expectedFlags = [...new Set([...GLOBAL_FLAGS, ...commonFlags])].flatMap(
      (name) => (FLAGS[name].short ? [`-${FLAGS[name].short}`] : []).concat(`--${name}`),
    );
    const offered = complete(["orch", command, ""], 2);
    assert.deepEqual(offered.sort(), [...words, ...expectedFlags].sort());
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
  assert.ok(offered.has("--until"), "flag-before-command should still resolve to pr's flags");
  assert.ok(!offered.has("--file"), "flag-before-command should not fall back to the global flag union");
});

test("completion at the command position offers every command and the global flags", BASH_SKIP, () => {
  const offered = complete(["orch", ""], 1);
  for (const command of Object.keys(COMMANDS)) assert.ok(offered.includes(command), command);
  for (const name of GLOBAL_FLAGS) assert.ok(offered.includes(`--${name}`), name);
});

// A bare "--" is parseArgs' end-of-options marker (same convention as
// getopt): nothing typed after it is ever read as a flag. Completion used to
// ignore it and keep suggesting flags past it, actively recommending input
// the parser would only ever treat as a plain positional.
test("completion offers nothing after a bare --", BASH_SKIP, () => {
  assert.deepEqual(complete(["orch", "task", "--", ""], 3), []);
  assert.deepEqual(complete(["orch", "--", ""], 2), []);
});

// A flag already typed but illegal for the command/subcommand it precedes —
// "--merge" isn't legal on `dashboard`, "--build" isn't legal on `agent
// build` (it's redundant there) — used to be skipped over as though it might
// be legal for whatever command followed, so completion kept suggesting
// input for an invocation the parser had already refused.
test("completion offers nothing once an already-typed flag is illegal for the resolved command", BASH_SKIP, () => {
  assert.deepEqual(complete(["orch", "--merge", "dashboard", ""], 3), []);
  assert.deepEqual(complete(["orch", "agent", "--build", "build", ""], 4), []);
});

// "install" and "--build" are legal anywhere after the command word, not
// just in the one literal position each of these used to check — completion
// used to under-offer --dry / --pr when the flag or the subcommand word
// appeared in the other order.
test("completion finds 'install' and '--build' regardless of where they sit in the arguments", BASH_SKIP, () => {
  const dry = new Set(complete(["orch", "completion", "--dry", "install", ""], 4));
  assert.ok(dry.has("--dry"), "orch completion --dry install should still offer --dry");
  const pr = new Set(complete(["orch", "agent", "--build", "add", ""], 4));
  assert.ok(pr.has("--author"), "orch agent --build add should offer --author");
});

async function usage(argv = ["help"]) {
  const logs = [];
  const orig = console.log;
  console.log = (m) => logs.push(m);
  try {
    await main(argv, { preflight() {} });
  } finally {
    console.log = orig;
  }
  return logs.join("\n");
}

test("each command help page documents its declared flags", async () => {
  for (const [command, spec] of Object.entries(COMMANDS)) {
    const page = await usage([command, "--help"]);
    for (const name of spec.flags) {
      assert.match(page, new RegExp(`--${name}(?![\\w-])`), `orch ${command} --help omits --${name}`);
    }
  }
});

test("completion offers every command listed in --help", BASH_SKIP, async () => {
  const global = await usage();
  const commands = complete(["orch", ""], 1).filter((w) => !w.startsWith("-"));
  for (const name of Object.keys(COMMANDS)) {
    assert.match(global, new RegExp(`\\b${name}\\b`), `--help missing command ${name}`);
  }
  for (const name of commands) assert.match(global, new RegExp(`\\b${name}\\b`), `--help missing command ${name}`);
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

// parseArgs also accepts "--flag=value" as one word, not just "--flag value"
// as two. The already-typed-flag legality recheck only ever matched the bare
// flag name against `flags`, so a perfectly legal "orch task --author=claude
// <TAB>" was wrongly treated as an illegal already-typed flag and returned
// nothing, same as an actually-illegal flag would.
test("completion still offers flags after a legal --flag=value", BASH_SKIP, () => {
  const offered = new Set(complete(["orch", "task", "--author=claude", ""], 3));
  assert.ok(offered.has("--reviewer"), "orch task --author=claude should still offer --reviewer");
});

// "orch completion --dry <TAB>" (subcommand not typed yet) used to return
// nothing at all: SUBCOMMAND_CASES only offers "bash install" for the single
// word right after "completion", and the already-typed-flag recheck loop
// treated --dry as illegal until "install" had ALSO already been typed —
// even though --dry legally precedes "install".
test("orch completion --dry offers install/bash and keeps --dry legal before the subcommand lands", BASH_SKIP, () => {
  const offered = new Set(complete(["orch", "completion", "--dry", ""], 3));
  assert.ok(offered.has("install"), "orch completion --dry should still offer install");
  assert.ok(offered.has("bash"), "orch completion --dry should still offer bash");
  assert.ok(offered.has("--dry"), "orch completion --dry should not treat --dry as already-illegal");
});

// A command-specific flag typed BEFORE the command word used to leave every
// command on offer, even ones the parser refuses it on: `orch --merge <TAB>`
// offered `dashboard`, `init`, etc., though `--merge` (schema.js) is only
// legal on `pr` — completion never narrowed the command list by an
// already-typed flag's actual owners.
test("a command-specific flag typed before the command word narrows the offered commands", BASH_SKIP, () => {
  // --until takes a value, so the completion position immediately after it is
  // intentionally empty until enum-value completion is added.
  assert.deepEqual(complete(["orch", "--until", ""], 2), []);
  const build = complete(["orch", "--build", ""], 2).filter((w) => !w.startsWith("-"));
  assert.deepEqual(build, ["agent"]);
  // A flag legal on nearly every command (--dry) must not over-narrow.
  const dry = complete(["orch", "--dry", ""], 2).filter((w) => !w.startsWith("-"));
  assert.ok(dry.includes("task") && dry.includes("pr") && dry.length > 5, "dry-eligible commands should stay broad");
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
