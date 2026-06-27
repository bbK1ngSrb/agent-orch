import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load, parseRoleSpec, parseRoleSpecs } from "../src/config.js";

function tmp() { return mkdtempSync(join(tmpdir(), "orch-cfg-")); }

test("parseRoleSpec: bare agent name", () => {
  assert.deepEqual(parseRoleSpec("claude"), { agent: "claude", model: null, effort: null });
});

test("parseRoleSpec: agent + model + effort", () => {
  assert.deepEqual(parseRoleSpec("claude opus-4.8 high"),
    { agent: "claude", model: "opus-4.8", effort: "high" });
});

test("parseRoleSpec: agent + model only", () => {
  assert.deepEqual(parseRoleSpec("codex gpt-5.1"),
    { agent: "codex", model: "gpt-5.1", effort: null });
});

test("parseRoleSpec: agent + effort only (effort keyword, no model)", () => {
  assert.deepEqual(parseRoleSpec("codex high"),
    { agent: "codex", model: null, effort: "high" });
});

test("parseRoleSpec: rejects empty spec", () => {
  assert.throws(() => parseRoleSpec("  "), /must name an agent/);
});

test("parseRoleSpecs: array of specs", () => {
  assert.deepEqual(parseRoleSpecs(["claude opus-4.8 high", "codex"]),
    [{ agent: "claude", model: "opus-4.8", effort: "high" }, { agent: "codex", model: null, effort: null }]);
});

test("parseRoleSpecs: comma-separated string", () => {
  assert.deepEqual(parseRoleSpecs("claude opus high, codex"),
    [{ agent: "claude", model: "opus", effort: "high" }, { agent: "codex", model: null, effort: null }]);
});

test("load() round-trips role specs written in orch.yml", () => {
  const d = tmp();
  writeFileSync(join(d, "orch.yml"),
    "agents: [claude, codex]\nauthor: claude opus-4.8 high\nreviewer: codex gpt-5.1\n");
  const c = load(d);
  // The yaml plain scalar survives load() intact, and validate() accepts it.
  assert.equal(c.author, "claude opus-4.8 high");
  assert.deepEqual(parseRoleSpec(c.author), { agent: "claude", model: "opus-4.8", effort: "high" });
  assert.deepEqual(parseRoleSpec(c.reviewer), { agent: "codex", model: "gpt-5.1", effort: null });
});

test("load() round-trips plural role specs (flow list with internal spaces)", () => {
  const d = tmp();
  writeFileSync(join(d, "orch.yml"),
    "agents: [claude, codex]\nauthors: [claude opus-4.8 high, codex]\nreviewers: [codex, claude sonnet-4.6 low]\n");
  const c = load(d);
  assert.deepEqual(parseRoleSpecs(c.authors),
    [{ agent: "claude", model: "opus-4.8", effort: "high" }, { agent: "codex", model: null, effort: null }]);
  assert.deepEqual(parseRoleSpecs(c.reviewers),
    [{ agent: "codex", model: null, effort: null }, { agent: "claude", model: "sonnet-4.6", effort: "low" }]);
});

test("empty dir yields defaults", () => {
  const c = load(tmp());
  assert.deepEqual(c.agents, ["claude", "codex"]);
  assert.equal(c.reviseCap, 3);
  assert.equal(c.merge, "no-ff");
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

test("plural authors/reviewers load through", () => {
  const d = tmp();
  writeFileSync(join(d, "orch.yml"), "authors: [claude, codex]\nreviewers: [codex, claude]\n");
  const c = load(d);
  assert.deepEqual(c.authors, ["claude", "codex"]);
  assert.deepEqual(c.reviewers, ["codex", "claude"]);
});

test("plural authors/reviewers must be set together", () => {
  const d = tmp();
  writeFileSync(join(d, "orch.yml"), "authors: [claude, codex]\n");
  assert.throws(() => load(d), /both authors and reviewers/);
});

test("concurrency defaults to 4 and must be a positive integer", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-cfg-"));
  assert.equal(load(d).concurrency, 4);

  mkdirSync(join(d, ".orch"), { recursive: true });
  writeFileSync(join(d, ".orch", "orch.yml"), "concurrency: 8\n");
  assert.equal(load(d).concurrency, 8);

  writeFileSync(join(d, ".orch", "orch.yml"), "concurrency: 0\n");
  assert.throws(() => load(d), /concurrency must be a positive integer/);
});
