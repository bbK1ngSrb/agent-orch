import test from "node:test";
import assert from "node:assert/strict";
import { BASH_COMPLETION, installCompletion } from "../src/completion.js";

test("BASH_COMPLETION registers the completion function for orch", () => {
  assert.match(BASH_COMPLETION, /complete -F _orch_completion orch/);
  assert.match(BASH_COMPLETION, /add build/);
});

test("installCompletion writes the script under <home>/.orch and reports the path", () => {
  const written = {};
  const result = installCompletion({
    homedir: () => "/fake/home",
    existsSync: () => false,
    mkdirSync: (dir) => { written.dir = dir; },
    writeFileSync: (path, content) => { written.path = path; written.content = content; },
  });
  assert.equal(result.ok, true);
  assert.equal(result.path, "/fake/home/.orch/completion.bash");
  assert.equal(written.dir, "/fake/home/.orch");
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
