import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir, cwd } from "node:process";
import { slugify, nextAuthor, parse, main, preflight, maybeSpawnDocs, applyRoleOverrides } from "../src/cli.js";

const docsCfg = { docs: { autoUpdate: true, prompt: "update docs", paths: ["*.md"] } };
function mockSpawn() {
  const calls = [];
  const spawn = (...args) => { calls.push(args); return { unref() {} }; };
  return { spawn, calls };
}

test("maybeSpawnDocs spawns once when merged + autoUpdate + !docsOnly", () => {
  const m = mockSpawn();
  const ok = maybeSpawnDocs({ status: "merged", docsOnly: false }, docsCfg, { spawn: m.spawn });
  assert.equal(ok, true);
  assert.equal(m.calls.length, 1);
  const argv = m.calls[0][1]; // [scriptPath, "task", prompt]
  assert.equal(argv[1], "task");
  assert.match(argv[2], /update docs$/); // ends with the configured prompt
  assert.match(argv[2], /^auto-docs [0-9a-z]+ /); // leads with a unique stamp
});

test("auto-docs prompts yield unique branch slugs (no existing-branch collision)", () => {
  const m = mockSpawn();
  maybeSpawnDocs({ status: "merged", docsOnly: false }, docsCfg, { spawn: m.spawn });
  maybeSpawnDocs({ status: "merged", docsOnly: false }, docsCfg, { spawn: m.spawn });
  const slug = (a) => slugify(a[1][2]);
  assert.notEqual(slug(m.calls[0]), slug(m.calls[1]));
});

test("maybeSpawnDocs does not spawn for a docs-only merge (loop guard)", () => {
  const m = mockSpawn();
  assert.equal(maybeSpawnDocs({ status: "merged", docsOnly: true }, docsCfg, { spawn: m.spawn }), false);
  assert.equal(m.calls.length, 0);
});

test("maybeSpawnDocs does not spawn for a no-op merge (empty-diff loop guard)", () => {
  const m = mockSpawn();
  assert.equal(maybeSpawnDocs({ status: "merged", docsOnly: false, noop: true }, docsCfg, { spawn: m.spawn }), false);
  assert.equal(m.calls.length, 0);
});

test("maybeSpawnDocs does not spawn when autoUpdate is off", () => {
  const m = mockSpawn();
  const cfg = { docs: { ...docsCfg.docs, autoUpdate: false } };
  assert.equal(maybeSpawnDocs({ status: "merged", docsOnly: false }, cfg, { spawn: m.spawn }), false);
  assert.equal(m.calls.length, 0);
});

test("maybeSpawnDocs does not spawn when not merged", () => {
  const m = mockSpawn();
  assert.equal(maybeSpawnDocs({ status: "escalated" }, docsCfg, { spawn: m.spawn }), false);
  assert.equal(m.calls.length, 0);
});

test("maybeSpawnDocs does not spawn under --dry", () => {
  const m = mockSpawn();
  assert.equal(maybeSpawnDocs({ status: "merged", docsOnly: false }, docsCfg, { spawn: m.spawn, dry: true }), false);
  assert.equal(m.calls.length, 0);
});

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
  const p = parse(["task", "do x", "--dry", "--authors", "claude,codex", "--reviewers", "codex,claude"]);
  assert.equal(p.command, "task");
  assert.deepEqual(p.rest, ["do x"]);
  assert.equal(p.flags.dry, true);
  assert.equal(p.flags.authors, "claude,codex");
  assert.equal(p.flags.reviewers, "codex,claude");
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

test("nextAuthor returns plural fixed roles when configured", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-cli-"));
  const cfg = { agents: ["claude", "codex"], authors: ["claude", "codex"], reviewers: ["codex", "claude"] };
  const a = nextAuthor(cfg, d);
  assert.deepEqual(a.authorNames, ["claude", "codex"]);
  assert.deepEqual(a.reviewerNames, ["codex", "claude"]);
  assert.equal(a.authorName, "claude");
  assert.equal(a.reviewerName, "codex");
});

test("CLI role overrides replace orch.yml fixed roles", () => {
  const cfg = {
    agents: ["claude", "codex"],
    author: "qwen3-coder-30b",
    reviewer: "claude",
    authors: null,
    reviewers: null,
  };
  const overridden = applyRoleOverrides(cfg, { authors: "claude,codex", reviewers: "codex,claude" });
  assert.equal(overridden.author, null);
  assert.equal(overridden.reviewer, null);
  assert.deepEqual(overridden.authors, ["claude", "codex"]);
  assert.deepEqual(overridden.reviewers, ["codex", "claude"]);
});
