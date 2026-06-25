import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir, cwd } from "node:process";
import { slugify, nextAuthor, parse, main, preflight } from "../src/cli.js";

test("slugify produces a branch-safe slug", () => {
  assert.equal(slugify("Fix the flaky test!!"), "fix-the-flaky-test");
});

test("--dry completes without any agent CLI on PATH (F2)", async () => {
  const d = mkdtempSync(join(tmpdir(), "orch-dry-"));
  const prev = cwd();
  chdir(d);
  try {
    process.exitCode = 0;
    await main(["task", "hello world", "--dry"]); // dryDeps: no real git/agent/test
    assert.notEqual(process.exitCode, 2); // not escalated
  } finally {
    chdir(prev);
    process.exitCode = 0;
  }
});

test("parse splits command, rest, and flags", () => {
  const p = parse(["task", "do x", "--dry"]);
  assert.equal(p.command, "task");
  assert.deepEqual(p.rest, ["do x"]);
  assert.equal(p.flags.dry, true);
});

test("nextAuthor alternates and persists last-author", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-cli-"));
  const cfg = { agents: ["claude", "codex"] };
  const a = nextAuthor(cfg, d);
  assert.equal(a.authorName, "claude");
  assert.equal(a.reviewerName, "codex");
  assert.equal(readFileSync(join(d, "last-author"), "utf8").trim(), "claude");
  const b = nextAuthor(cfg, d);
  assert.equal(b.authorName, "codex"); // alternated
});

test("preflight throws a clear error when .orch/ is read-only", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-ro-"));
  chmodSync(d, 0o555); // read-only dir → child .orch write must fail
  const orchDir = join(d, ".orch");
  try {
    assert.throws(
      () => preflight({ agents: [] }, orchDir), // empty agents: skip CLI check, isolate probe
      /not writable/,
    );
  } finally {
    chmodSync(d, 0o755); // restore so tmp cleanup works
  }
});

test("nextAuthor honors explicit fixed roles over rotation", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-cli-"));
  const cfg = { agents: ["claude", "codex"], author: "qwen3-coder-30b", reviewer: "claude" };
  const a = nextAuthor(cfg, d);
  assert.equal(a.authorName, "qwen3-coder-30b");
  assert.equal(a.reviewerName, "claude");
  const b = nextAuthor(cfg, d); // does not rotate
  assert.equal(b.authorName, "qwen3-coder-30b");
});
