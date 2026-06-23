import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { buildArgs as claudeArgs } from "../src/adapters/claude.js";
import { buildArgs as codexArgs } from "../src/adapters/codex.js";
import { get } from "../src/adapters/index.js";
import { makeCliAdapter } from "../src/adapters/cli-adapter.js";

test("claude buildArgs uses -p", () => {
  assert.deepEqual(claudeArgs("PROMPT", "/wd"), ["-p", "PROMPT"]);
});

test("audit is fail-safe DISAGREE when the agent exits nonzero (F4)", async () => {
  // Fake agent: prints a partial answer then exits 3. audit() must NOT throw.
  const adapter = makeCliAdapter({
    name: "boom",
    bin: "sh",
    buildArgs: () => ["-c", "echo 'thinking...'; exit 3"],
  });
  const v = await adapter.audit("pr/x/y", tmpdir());
  assert.equal(v.decision, "DISAGREE");
});

test("audit ignores AGREE printed by a crashed agent (F4 fail-safe)", async () => {
  // A nonzero exit must override any verdict the agent printed before dying.
  const adapter = makeCliAdapter({
    name: "boom-agree",
    bin: "sh",
    buildArgs: () => ["-c", "echo AGREE; exit 3"],
  });
  const v = await adapter.audit("pr/x/y", tmpdir());
  assert.equal(v.decision, "DISAGREE");
});

test("codex buildArgs uses exec --cd", () => {
  assert.deepEqual(codexArgs("PROMPT", "/wd"), ["exec", "--cd", "/wd", "PROMPT"]);
});

test("registry resolves known adapters and rejects unknown", () => {
  assert.equal(get("claude").name, "claude");
  assert.equal(get("codex").name, "codex");
  assert.throws(() => get("nope"), /unknown agent/);
});
