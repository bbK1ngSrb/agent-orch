import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "../src/config.js";

function tmp() { return mkdtempSync(join(tmpdir(), "orch-cfg-")); }

test("empty dir yields defaults", () => {
  const c = load(tmp());
  assert.deepEqual(c.agents, ["claude", "codex"]);
  assert.equal(c.reviseCap, 3);
  assert.equal(c.merge, "ff-only");
  assert.equal(c.scope.maxLines, 0);
});

test("user orch.yml overrides and deep-merges scope", () => {
  const d = tmp();
  writeFileSync(join(d, "orch.yml"), "merge: no-ff\nscope:\n  maxLines: 100\n");
  const c = load(d);
  assert.equal(c.merge, "no-ff");
  assert.equal(c.scope.maxLines, 100);
  assert.deepEqual(c.scope.ignore, ["*.lock", "dist/**", "*.snap"]); // default kept
});

test(".orch/orch.yml is read", () => {
  const d = tmp();
  mkdirSync(join(d, ".orch"));
  writeFileSync(join(d, ".orch", "orch.yml"), "merge: no-ff\n");
  assert.equal(load(d).merge, "no-ff");
});

test(".orch/orch.yml takes precedence over bare orch.yml", () => {
  const d = tmp();
  mkdirSync(join(d, ".orch"));
  writeFileSync(join(d, "orch.yml"), "merge: no-ff\n");
  writeFileSync(join(d, ".orch", "orch.yml"), "merge: ff-only\n");
  assert.equal(load(d).merge, "ff-only");
});

test("invalid merge value throws", () => {
  const d = tmp();
  writeFileSync(join(d, "orch.yml"), "merge: rebase-please\n");
  assert.throws(() => load(d), /merge must be/);
});

test("github.mergeMethod defaults to squash; invalid value throws", () => {
  assert.equal(load(tmp()).github.mergeMethod, "squash");
  const d = tmp();
  writeFileSync(join(d, "orch.yml"), "github:\n  mergeMethod: fast-forward\n");
  assert.throws(() => load(d), /github.mergeMethod must be/);
});

test("docs defaults present; off by default", () => {
  const c = load(tmp());
  assert.equal(c.docs.autoUpdate, false);
  assert.equal(typeof c.docs.prompt, "string");
  assert.deepEqual(c.docs.paths, ["*.md", "docs/**", "**/*.md"]);
});

test("docs user override shallow-merges (keeps default prompt/paths)", () => {
  const d = tmp();
  writeFileSync(join(d, "orch.yml"), "docs:\n  autoUpdate: true\n");
  const c = load(d);
  assert.equal(c.docs.autoUpdate, true);
  assert.equal(c.docs.prompt, "update documentation to reflect the latest merged changes");
  assert.deepEqual(c.docs.paths, ["*.md", "docs/**", "**/*.md"]); // default kept
});

test("invalid docs.autoUpdate throws", () => {
  const d = tmp();
  writeFileSync(join(d, "orch.yml"), "docs:\n  autoUpdate: yes please\n");
  assert.throws(() => load(d), /docs.autoUpdate must be a boolean/);
});

test("empty docs.prompt throws", () => {
  const d = tmp();
  writeFileSync(join(d, "orch.yml"), 'docs:\n  prompt: ""\n');
  assert.throws(() => load(d), /docs.prompt must be a non-empty string/);
});

test("non-array docs.paths throws", () => {
  const d = tmp();
  writeFileSync(join(d, "orch.yml"), "docs:\n  paths: nope\n");
  assert.throws(() => load(d), /docs.paths must be an array of strings/);
});

test("empty agents list throws", () => {
  const d = tmp();
  writeFileSync(join(d, "orch.yml"), "agents: []\n");
  assert.throws(() => load(d), /agents/);
});

test("author/reviewer must be set together", () => {
  const d = tmp();
  writeFileSync(join(d, "orch.yml"), "author: qwen3-coder-30b\n"); // reviewer missing
  assert.throws(() => load(d), /both author and reviewer/);
});

test("explicit author/reviewer load through", () => {
  const d = tmp();
  writeFileSync(join(d, "orch.yml"), "author: qwen3-coder-30b\nreviewer: claude\n");
  const c = load(d);
  assert.equal(c.author, "qwen3-coder-30b");
  assert.equal(c.reviewer, "claude");
});
