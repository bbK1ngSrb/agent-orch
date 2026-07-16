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

test("parseRoleSpec: rejects unsupported model/effort options for an adapter", () => {
  assert.throws(() => parseRoleSpec("gemini high"), /agent gemini does not support effort/);
  assert.throws(() => parseRoleSpec("qwen3-coder-30b gpt-5"), /agent qwen3-coder-30b does not support model/);
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

test("stageTimeout defaults to 25 minutes and accepts an override (#56)", () => {
  assert.equal(load(tmp()).stageTimeout, 25);
  const d = tmp();
  writeFileSync(join(d, "orch.yml"), "stageTimeout: 40\n");
  assert.equal(load(d).stageTimeout, 40);
});

test("stageTimeout of 0 disables the watchdog; negative/non-integer throws (#56)", () => {
  const off = tmp();
  writeFileSync(join(off, "orch.yml"), "stageTimeout: 0\n");
  assert.equal(load(off).stageTimeout, 0);
  const bad = tmp();
  writeFileSync(join(bad, "orch.yml"), "stageTimeout: -5\n");
  assert.throws(() => load(bad), /stageTimeout must be a non-negative integer/);
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

test("load() accepts an override path (--config-file) layered on top of orch.yml", () => {
  const d = tmp();
  writeFileSync(join(d, "orch.yml"), "merge: no-ff\nscope:\n  maxLines: 100\n");
  const override = join(d, "custom.yml");
  writeFileSync(override, "merge: ff-only\nscope:\n  maxLines: 200\n");
  const c = load(d, override);
  assert.equal(c.merge, "ff-only");
  assert.equal(c.scope.maxLines, 200);
  assert.deepEqual(c.scope.ignore, ["*.lock", "dist/**", "*.snap"]); // default kept
});

test("load() override path applies even with no repo orch.yml", () => {
  const d = tmp();
  const override = join(d, "custom.yml");
  writeFileSync(override, "reviseCap: 7\n");
  assert.equal(load(d, override).reviseCap, 7);
});

test("load() throws when --config-file path does not exist", () => {
  const d = tmp();
  assert.throws(() => load(d, join(d, "missing.yml")), /--config-file not found/);
});

test("invalid merge value throws", () => {
  const d = tmp();
  writeFileSync(join(d, "orch.yml"), "merge: rebase-please\n");
  assert.throws(() => load(d), /merge must be/);
});

test("merge: pr is a valid opt-in for PR-gated merges", () => {
  const d = tmp();
  writeFileSync(join(d, "orch.yml"), "merge: pr\n");
  assert.equal(load(d).merge, "pr");
});

test("integrationBranch defaults to orch/integration; blank value throws", () => {
  assert.equal(load(tmp()).integrationBranch, "orch/integration");
  const d = tmp();
  writeFileSync(join(d, "orch.yml"), "integrationBranch: custom/integration\n");
  assert.equal(load(d).integrationBranch, "custom/integration");
  const bad = tmp();
  writeFileSync(join(bad, "orch.yml"), "integrationBranch: ''\n");
  assert.throws(() => load(bad), /integrationBranch must be a non-empty string/);
});

test("load() defaults baseBranch to main", () => {
  const c = load(tmp());
  assert.equal(c.baseBranch, "main");
});

test("load() honors a custom baseBranch", () => {
  const d = tmp();
  writeFileSync(join(d, "orch.yml"), "baseBranch: dev\n");
  const c = load(d);
  assert.equal(c.baseBranch, "dev");
});

test("validate() rejects an empty baseBranch", () => {
  const d = tmp();
  writeFileSync(join(d, "orch.yml"), "baseBranch: ''\n");
  assert.throws(() => load(d), /baseBranch must be a non-empty string/);
});

test("github.mergeMethod defaults to squash; invalid value throws", () => {
  assert.equal(load(tmp()).github.mergeMethod, "squash");
  const d = tmp();
  writeFileSync(join(d, "orch.yml"), "github:\n  mergeMethod: fast-forward\n");
  assert.throws(() => load(d), /github.mergeMethod must be/);
});

test("github.autoMergePr defaults to false; non-boolean throws", () => {
  assert.equal(load(tmp()).github.autoMergePr, false);
  const d = tmp();
  writeFileSync(join(d, "orch.yml"), "github:\n  autoMergePr: true\n");
  assert.equal(load(d).github.autoMergePr, true);
  const bad = tmp();
  writeFileSync(join(bad, "orch.yml"), "github:\n  autoMergePr: yes\n");
  assert.throws(() => load(bad), /github.autoMergePr must be a boolean/);
});

test("main.autoMerge defaults to false; non-boolean throws", () => {
  assert.equal(load(tmp()).main.autoMerge, false);
  const d = tmp();
  writeFileSync(join(d, "orch.yml"), "main:\n  autoMerge: true\n");
  assert.equal(load(d).main.autoMerge, true);
  const bad = tmp();
  writeFileSync(join(bad, "orch.yml"), "main:\n  autoMerge: yes\n");
  assert.throws(() => load(bad), /main.autoMerge must be a boolean/);
});

test("main.autoResolveConflicts defaults off and validates its scope", () => {
  const defaults = load(tmp());
  assert.equal(defaults.main.autoResolveConflicts, false);
  assert.equal(defaults.main.conflictResolution, "manual");
  assert.ok(defaults.main.autoResolveConflictPaths.includes("CHANGELOG.md"));

  const d = tmp();
  writeFileSync(join(d, "orch.yml"), "main:\n  autoResolveConflicts: true\n  autoResolveConflictPaths: [CHANGELOG.md]\n");
  const c = load(d);
  assert.equal(c.main.autoResolveConflicts, true);
  assert.equal(c.main.conflictResolution, "auto");
  assert.deepEqual(c.main.autoResolveConflictPaths, ["CHANGELOG.md"]);

  const badFlag = tmp();
  writeFileSync(join(badFlag, "orch.yml"), "main:\n  autoResolveConflicts: yes\n");
  assert.throws(() => load(badFlag), /main.autoResolveConflicts must be a boolean/);

  const badPaths = tmp();
  writeFileSync(join(badPaths, "orch.yml"), "main:\n  autoResolveConflictPaths: CHANGELOG.md\n");
  assert.throws(() => load(badPaths), /main.autoResolveConflictPaths must be an array of strings/);
});

test("main.conflictResolution overrides the deprecated boolean alias", () => {
  const d = tmp();
  writeFileSync(join(d, "orch.yml"), "main:\n  autoResolveConflicts: false\n  conflictResolution: propose\n  conflictResolutionResolvers: [claude opus high, codex gpt-5 xhigh]\n");
  const c = load(d);
  assert.equal(c.main.conflictResolution, "propose");
  assert.equal(c.main.autoResolveConflicts, true);
  assert.deepEqual(c.main.conflictResolutionResolvers, [
    { agent: "claude", model: "opus", effort: "high" },
    { agent: "codex", model: "gpt-5", effort: "xhigh" },
  ]);

  const badMode = tmp();
  writeFileSync(join(badMode, "orch.yml"), "main:\n  conflictResolution: maybe\n");
  assert.throws(() => load(badMode), /main.conflictResolution must be manual, propose, or auto/);

  const badResolvers = tmp();
  writeFileSync(join(badResolvers, "orch.yml"), "main:\n  conflictResolutionResolvers: []\n");
  assert.throws(() => load(badResolvers), /main.conflictResolutionResolvers must be a non-empty list of role specs/);
});

test("reviewer-backed conflict resolution requires a distinct reviewer at config load", () => {
  const propose = tmp();
  writeFileSync(join(propose, "orch.yml"), "agents: [claude]\nmain:\n  conflictResolution: propose\n  conflictResolutionResolvers: [claude]\n");
  assert.throws(() => load(propose), /requires a conflict reviewer/);

  const metadataAuto = tmp();
  writeFileSync(join(metadataAuto, "orch.yml"), "agents: [claude]\nmain:\n  conflictResolution: auto\n  conflictResolutionResolvers: [claude]\n  autoResolveConflictPaths: [CHANGELOG.md]\n");
  assert.equal(load(metadataAuto).main.conflictResolution, "auto");

  const broadAuto = tmp();
  writeFileSync(join(broadAuto, "orch.yml"), "agents: [claude]\nmain:\n  conflictResolution: auto\n  conflictResolutionResolvers: [claude]\n  autoResolveConflictPaths: []\n");
  assert.throws(() => load(broadAuto), /requires a conflict reviewer/);
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

test("release.autoBump off by default", () => {
  const c = load(tmp());
  assert.equal(c.release.autoBump, false);
});

test("release.autoBump user override enables the bump", () => {
  const d = tmp();
  writeFileSync(join(d, "orch.yml"), "release:\n  autoBump: true\n");
  assert.equal(load(d).release.autoBump, true);
});

test("invalid release.autoBump throws", () => {
  const d = tmp();
  writeFileSync(join(d, "orch.yml"), "release:\n  autoBump: yes please\n");
  assert.throws(() => load(d), /release.autoBump must be a boolean/);
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

test("rotation pool rejects model/effort role specs during config load", () => {
  const d = tmp();
  writeFileSync(join(d, "orch.yml"), "agents: [codex gpt-5.6-sol high, grok grok-4.5 high]\n");
  assert.throws(
    () => load(d),
    /agents entries must be bare adapter names; put model\/effort in author\/reviewer or use CLI overrides/,
  );
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

test("cheap defaults to disabled (role null, no paths)", () => {
  const c = load(tmp());
  assert.equal(c.cheap.role, null);
  assert.deepEqual(c.cheap.paths, []);
});

test("cheap.role and cheap.paths round-trip", () => {
  const d = tmp();
  writeFileSync(join(d, "orch.yml"), "cheap:\n  role: qwen3-coder-30b\n  paths: [\"*.md\", \"docs/**\"]\n");
  const c = load(d);
  assert.equal(c.cheap.role, "qwen3-coder-30b");
  assert.deepEqual(c.cheap.paths, ["*.md", "docs/**"]);
});

test("cheap user override shallow-merges (keeps default paths)", () => {
  const d = tmp();
  writeFileSync(join(d, "orch.yml"), "cheap:\n  role: qwen3-coder-30b\n");
  const c = load(d);
  assert.equal(c.cheap.role, "qwen3-coder-30b");
  assert.deepEqual(c.cheap.paths, []);
});

test("empty cheap.role throws", () => {
  const d = tmp();
  writeFileSync(join(d, "orch.yml"), 'cheap:\n  role: ""\n');
  assert.throws(() => load(d), /cheap.role must be a non-empty string/);
});

test("non-array cheap.paths throws", () => {
  const d = tmp();
  writeFileSync(join(d, "orch.yml"), "cheap:\n  paths: nope\n");
  assert.throws(() => load(d), /cheap.paths must be an array of strings/);
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
