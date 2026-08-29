// Help-page tests for CLI v2 P12a (#605), spec: docs/drafts/help-spec-v0.5.md §6.4.
//
// The drift guards (§6.4 tests 2-5), the "three routes agree" test (7) and the
// stream/exit-code tests (8) already live in test/schema.test.js and
// test/cli.test.js. This file adds the two the spec asks for that had no home:
//
//   1. one byte-for-byte assertion per page, against a fixture file
//   6. every example on every page parses
//
// Why a fixture and not an inline template literal: a help page is prose, and
// prose is reviewed by reading it. A fixture lets a reviewer diff a proposed
// wording change against a file — the whole page, in context — instead of
// squinting at a diff of an escaped string inside a test.
//
// The fixtures are the spec's §4 blocks with three documented classes of
// deviation, because P12a restructures the pages but deletes nothing (§2 and
// §2.1 of the spec; deletions are #528's slice):
//
//   (a) a §2.1 "not yet landed" row — `--until` still defaults to `once`,
//       `--max-attempts` does not exist, `config` still takes `--dry`;
//   (b) a command or flag v0.5 removes that this slice keeps — the `review` and
//       `update` pages, `agent build`, `pr --merge`, `task/issue --no-banner`;
//   (c) a wrap point. The spec's §4 blocks are hand-wrapped at widths that vary
//       between sections (79 in §4.4, 76 in §4.10), so no single algorithmic
//       width reproduces all of them. The renderer wraps every page at one
//       width (79, inside §3 rule 1's 88-column cap). What it does reproduce
//       exactly is the *semantic* layout — the column-27 description start, the
//       aligned `=` in the --until goal list, the hanging indent beneath it.
//
// Regenerating after a deliberate wording change, from the package root:
//   node --input-type=module -e 'import {renderHelp, COMMANDS} from "./src/schema.js";
//   import {writeFileSync} from "node:fs";
//   for (const n of [...Object.keys(COMMANDS), null]) writeFileSync(`test/fixtures/help/${n ?? "orch"}.txt`, renderHelp(n) + "\n");'
// Read the diff before committing it: that is the point of the fixture.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { parse } from "../src/cli.js";
import { COMMANDS, HELP_PAGES, EXAMPLES, renderHelp, validate, validatePositionals } from "../src/schema.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = (name) => readFileSync(join(root, "test/fixtures/help", `${name}.txt`), "utf8");

// §6.4 test 1 — one byte-for-byte assertion per page (16 commands + global).
test("every help page renders byte-for-byte as its fixture", () => {
  for (const name of [...Object.keys(COMMANDS), null]) {
    const file = name ?? "orch";
    assert.equal(
      renderHelp(name),
      fixture(file).trimEnd(),
      `help text changed for ${file} — read test/fixtures/help/${file}.txt and update it deliberately`,
    );
  }
});

// A page that exists for every command is what makes test 1's loop total, and
// what keeps the error funnel from being handed a name it cannot render (see
// the internal-command test below).
test("every command has a help page, and every help page has a command", () => {
  assert.deepEqual(Object.keys(HELP_PAGES).sort(), Object.keys(COMMANDS).sort());
});

// Split a help example into argv the way a shell would for simple quoted
// tokens. Deliberately NOT a shell: it does not interpret `>`, `|` or `&&`, so
// an example carrying shell plumbing arrives as extra positionals and is
// refused below. That is the mechanism behind spec §3 rule 8 — an example is a
// bare `orch …` invocation, and shell tips go in the page's prose instead.
function argvFromHelpExample(line) {
  const body = line.trim().replace(/^orch\s+/, "");
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|\S+/g;
  let m;
  while ((m = re.exec(body))) tokens.push(m[1] ?? m[2] ?? m[0]);
  return tokens;
}

// §6.4 test 6 — every example parses. An example the parser would refuse is
// worse than no example: it is the one line a reader copies verbatim.
test("every example on every page parses, validates and has legal arity", () => {
  const examples = [
    ...EXAMPLES.map((line) => ["orch --help", line]),
    ...Object.entries(HELP_PAGES).flatMap(([name, page]) => page.examples.map((line) => [`orch ${name} --help`, line])),
  ];
  assert.ok(examples.length >= 30, `expected an example set, got ${examples.length}`);
  for (const [page, line] of examples) {
    assert.ok(line.startsWith("orch "), `${page}: example is not a bare orch invocation: ${line}`);
    const argv = argvFromHelpExample(line);
    assert.doesNotThrow(() => {
      const { command, rest, flags } = parse(argv);
      assert.ok(command, `example produced no command: ${line}`);
      validate(command, flags);
      validatePositionals(command, rest, flags);
    }, `${page}: example does not parse: ${line}`);
  }
});

// The tokenizer above is only honest if it really does refuse shell plumbing —
// otherwise test 6 passes for the wrong reason and §3 rule 8 is unenforced.
// This is the spec's own worked example (§6.4 test 6).
test("an example carrying shell redirection is refused, not silently accepted", () => {
  const argv = argvFromHelpExample("orch completion bash > /etc/bash_completion.d/orch");
  assert.deepEqual(argv, ["completion", "bash", ">", "/etc/bash_completion.d/orch"]);
  const { command, rest, flags } = parse(argv);
  assert.throws(
    () => validatePositionals(command, rest, flags),
    (e) => e.exit === 64 && /takes at most 1 argument/.test(e.message),
  );
});

// Regression, P12a finding 1. `helpFor` names the page bin/orch.js renders
// after a usage error. `__update-check-child` is an internal re-exec target: it
// is validated like any command but deliberately has no page, so naming it made
// renderHelp() throw *inside the error funnel itself* — the documented exit 64
// became exit 1 plus a stack trace, on stderr, in front of the user.
//
// A flag error on an internal command must still be exit 64 with its message
// and no page (there is nothing to show), and above all no crash.
test("a usage error on an internal command exits 64 without crashing the error funnel", () => {
  for (const [argv, expected] of [
    [["__update-check-child", "--merge"], /--merge is not valid with 'orch __update-check-child'/],
    [["__update-check-child", "--dry"], /--dry has no effect on 'orch __update-check-child'/],
  ]) {
    const result = spawnSync(process.execPath, ["bin/orch.js", ...argv], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 64, `${argv.join(" ")} exited ${result.status}: ${result.stderr}`);
    assert.equal(result.stdout, "", `${argv.join(" ")} wrote to stdout`);
    assert.match(result.stderr, expected);
    assert.doesNotMatch(result.stderr, /unknown help page/, `${argv.join(" ")} crashed the error funnel`);
    assert.doesNotMatch(result.stderr, /^\s+at /m, `${argv.join(" ")} printed a stack trace`);
    // Not just "did not crash": an internal command has no page, so falling
    // back to the global one would also pass the checks above while putting a
    // command list in front of something no user ever typed.
    assert.doesNotMatch(result.stderr, /^Usage: orch <command>/m, `${argv.join(" ")} printed a help page it has none of`);
  }
});
