import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configReport, load, parseRoleSpec, parseRoleSpecs, validate } from "../src/config.js";

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
  assert.equal(c.roundCap, 3);
  assert.equal(c.landing, "no-ff");
  assert.equal(c.automation.remedies, null);
  assert.equal(c.scope.maxLines, 0);
});

test("stageTimeout defaults to 25 minutes and accepts an override (#56)", () => {
  assert.equal(load(tmp()).stageTimeout, 25);
  const d = tmp();
  writeFileSync(join(d, "orch.yml"), "stageTimeout: 40\n");
  assert.equal(load(d).stageTimeout, 40);
});

test("gateTimeout follows stageTimeout unless explicitly set", () => {
  const inherited = tmp();
  writeFileSync(join(inherited, "orch.yml"), "stageTimeout: 40\n");
  assert.equal(load(inherited).gateTimeout, 40);
  const explicit = tmp();
  writeFileSync(join(explicit, "orch.yml"), "stageTimeout: 40\ngateTimeout: 7\n");
  assert.equal(load(explicit).gateTimeout, 7);
});

test("v2 landing and automation aliases normalize to the runtime config", () => {
  const d = tmp();
  writeFileSync(join(d, "orch.yml"), [
    "landing: ff-only",
    "automation:",
    "  conflictResolvers: [claude opus high, codex]",
    "  conflictAutoPaths: [src/**]",
    "",
  ].join("\n"));
  const c = load(d);
  assert.equal(c.landing, "ff-only");
  assert.equal(c.landing, "ff-only");
  assert.deepEqual(c.main.conflictResolutionResolvers, [
    { agent: "claude", model: "opus", effort: "high" },
    { agent: "codex", model: null, effort: null },
  ]);
  assert.deepEqual(c.main.autoResolveConflictPaths, ["src/**"]);
});

test("--config-file canonical conflict resolvers beat orch.yml v2 aliases", () => {
  const d = tmp();
  writeFileSync(join(d, "orch.yml"), "automation:\n  conflictResolvers: [claude]\n");
  const override = join(d, "custom.yml");
  writeFileSync(override, "automation:\n  conflictResolvers: [codex]\n");
  const c = load(d, override, { onWarning() {} });
  assert.deepEqual(c.main.conflictResolutionResolvers, [{ agent: "codex", model: null, effort: null }]);
});

test("test and author values are validated as non-empty strings", () => {
  const badTest = tmp();
  writeFileSync(join(badTest, "orch.yml"), "test: null\n");
  assert.throws(() => load(badTest), /test must be a non-empty string/);
  const badAuthor = tmp();
  writeFileSync(join(badAuthor, "orch.yml"), "author: 42\nreviewer: codex\n");
  assert.throws(() => load(badAuthor), /author must be a non-empty string/);
});

test("removed config keys are hard errors with exact replacement messages", () => {
  const d = tmp();
  writeFileSync(join(d, "orch.yml"), "merge: pr\nmain:\n  autoMerge: true\ngithub:\n  autoMergePr: true\n");
  assert.throws(() => load(d), /'merge'.*landing/);
});

test("closed config schema rejects unknown keys but accepts inert v2 keys", () => {
  const d = tmp();
  writeFileSync(join(d, "orch.yml"), "landng: pr\nmain:\n  typo: true\n");
  assert.throws(
    () => load(d, undefined, { onWarning() {} }),
    (error) => error.message.includes("orch.yml: unknown key 'landng' (typo? see orch.example.yml).")
      && error.message.includes("orch.yml: unknown key 'main.typo'."),
  );
  const valid = tmp();
  writeFileSync(join(valid, "orch.yml"), "automation:\n  rotateModels:\n    codex: [gpt-5]\nenv:\n  passthrough: [CI]\n");
  assert.doesNotThrow(() => load(valid, undefined, { onWarning() {} }));
});

test("configReport returns effective values and removed-key problems", () => {
  const d = tmp();
  writeFileSync(join(d, "orch.yml"), "stageTimeout: 41\nlanding: no-ff\n");
  const report = configReport(d);
  assert.equal(report.ok, true);
  assert.equal(report.config.gateTimeout, 41);
  assert.equal(report.sources.stageTimeout, "orch.yml");
  assert.equal(report.sources.gateTimeout, "orch.yml");
  assert.equal(report.sources.landing, "orch.yml");
  assert.equal(report.config.merge, undefined);
  assert.equal(report.config.main, undefined);
  assert.deepEqual(report.problems, []);
});

test("configReport labels only canonical leaves", () => {
  const d = tmp();
  writeFileSync(join(d, "orch.yml"), "landing: pr\n");
  const report = configReport(d);
  assert.equal(report.sources.main, undefined);
  assert.equal(report.sources.landing, "orch.yml");
  assert.equal(report.sources.merge, undefined);
});

test("configReport uses the .orch config path in warning provenance", () => {
  const d = tmp();
  mkdirSync(join(d, ".orch"), { recursive: true });
  writeFileSync(join(d, ".orch", "orch.yml"), "landing: pr\n");
  const report = configReport(d);
  assert.equal(report.sources.landing, ".orch/orch.yml");
});

test("configReport provenance follows override precedence across renamed keys", () => {
  const d = tmp();
  writeFileSync(join(d, "orch.yml"), "landing: ff-only\n");
  const override = join(d, "custom.yml");
  writeFileSync(override, "landing: pr\n");
  const report = configReport(d, override);
  assert.equal(report.config.landing, "pr");
  assert.equal(report.sources.landing, "--config-file");
  assert.equal(report.sources.merge, undefined);
});

test("configReport attributes normalized values to the source that supplied them", () => {
  const d = tmp();
  writeFileSync(join(d, "orch.yml"), [
    "stageTimeout: 5",
    "automation:",
      "  conflictResolvers: [claude, codex]",
      "  conflictAutoPaths: [CHANGELOG.md]",
    "",
  ].join("\n"));
  const report = configReport(d);
  assert.equal(report.config.gateTimeout, 5);
  assert.equal(report.sources.gateTimeout, "orch.yml");
  assert.equal(report.sources["automation.conflictResolvers"], "orch.yml");
  assert.equal(report.sources["automation.conflictAutoPaths"], "orch.yml");
});

test("configReport matches loaded conflict resolvers across config layers", () => {
  const d = tmp();
  writeFileSync(join(d, "orch.yml"), "automation:\n  conflictResolvers: [claude]\n");
  const override = join(d, "custom.yml");
  writeFileSync(override, "automation:\n  conflictResolvers: [codex]\n");
  const effective = load(d, override, { onWarning() {} });
  const report = configReport(d, override);
  assert.deepEqual(report.config.automation.conflictResolvers, effective.automation.conflictResolvers);
  assert.equal(report.sources["automation.conflictResolvers"], "--config-file");
});

test("removed-key problems name --config-file when that layer supplied the key", () => {
  const d = tmp();
  const override = join(d, "custom.yml");
  writeFileSync(override, "main:\n  autoMerge: true\n");
  const report = configReport(d, override);
  assert.equal(report.ok, false);
  assert.match(report.problems[0], /--config-file: 'main.autoMerge' was removed/);
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
  writeFileSync(join(d, "orch.yml"), "landing: no-ff\nscope:\n  maxLines: 100\n");
  const c = load(d);
  assert.equal(c.landing, "no-ff");
  assert.equal(c.scope.maxLines, 100);
  assert.deepEqual(c.scope.ignore, ["*.lock", "dist/**", "*.snap"]); // default kept
});

test(".orch/orch.yml is read", () => {
  const d = tmp();
  mkdirSync(join(d, ".orch"));
  writeFileSync(join(d, ".orch", "orch.yml"), "landing: no-ff\n");
  assert.equal(load(d).landing, "no-ff");
});

test(".orch/orch.yml takes precedence over bare orch.yml", () => {
  const d = tmp();
  mkdirSync(join(d, ".orch"));
  writeFileSync(join(d, "orch.yml"), "landing: no-ff\n");
  writeFileSync(join(d, ".orch", "orch.yml"), "landing: ff-only\n");
  assert.equal(load(d).landing, "ff-only");
});

test("load() accepts an override path (--config-file) layered on top of orch.yml", () => {
  const d = tmp();
  writeFileSync(join(d, "orch.yml"), "landing: no-ff\nscope:\n  maxLines: 100\n");
  const override = join(d, "custom.yml");
  writeFileSync(override, "landing: ff-only\nscope:\n  maxLines: 200\n");
  const c = load(d, override);
  assert.equal(c.landing, "ff-only");
  assert.equal(c.scope.maxLines, 200);
  assert.deepEqual(c.scope.ignore, ["*.lock", "dist/**", "*.snap"]); // default kept
});

test("load() override path applies even with no repo orch.yml", () => {
  const d = tmp();
  const override = join(d, "custom.yml");
  writeFileSync(override, "roundCap: 7\n");
  assert.equal(load(d, override).roundCap, 7);
});

test("load() throws when --config-file path does not exist", () => {
  const d = tmp();
  assert.throws(() => load(d, join(d, "missing.yml")), /--config-file not found/);
});

test("invalid landing value throws", () => {
  const d = tmp();
  writeFileSync(join(d, "orch.yml"), "landing: rebase-please\n");
  assert.throws(() => load(d), /landing must be/);
});

test("merge is removed even when its value was valid before v0.5", () => {
  const d = tmp();
  writeFileSync(join(d, "orch.yml"), "merge: pr\n");
  assert.throws(() => load(d), /'merge'.*landing/);
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

test("github.autoMergePr is removed", () => {
  const d = tmp();
  writeFileSync(join(d, "orch.yml"), "github:\n  autoMergePr: true\n");
  assert.throws(() => load(d), /github\.autoMergePr.*removed/);
});

test("automation.mcpMayMerge defaults to false and validates booleans", () => {
  assert.equal(load(tmp()).automation.mcpMayMerge, false);
  const d = tmp();
  writeFileSync(join(d, "orch.yml"), "automation:\n  mcpMayMerge: true\n");
  assert.equal(load(d).automation.mcpMayMerge, true);
  const bad = tmp();
  writeFileSync(join(bad, "orch.yml"), "automation:\n  mcpMayMerge: yes\n");
  assert.throws(() => load(bad), /automation.mcpMayMerge must be a boolean/);
});

test("automation.rotateModels defaults to empty and validates model ladders", () => {
  assert.deepEqual(load(tmp()).automation.rotateModels, {});

  const configured = tmp();
  writeFileSync(join(configured, "orch.yml"), "automation:\n  rotateModels:\n    claude: [sonnet-4, opus-4]\n");
  assert.deepEqual(load(configured).automation.rotateModels, { claude: ["sonnet-4", "opus-4"] });

  for (const value of ["yes", "[]", "{claude: []}", "{claude: [sonnet-4, sonnet-4]}", "{claude: [null]}"]) {
    const bad = tmp();
    writeFileSync(join(bad, "orch.yml"), `automation:\n  rotateModels: ${value}\n`);
    assert.throws(() => load(bad), /automation\.rotateModels must map/);
  }

  const unknown = tmp();
  writeFileSync(join(unknown, "orch.yml"), "automation:\n  rotateModels:\n    not-an-adapter: [model]\n");
  assert.throws(() => load(unknown), /automation\.rotateModels\.not-an-adapter.*unknown adapter/);
});

test("main.autoMerge is removed", () => {
  const d = tmp();
  writeFileSync(join(d, "orch.yml"), "main:\n  autoMerge: true\n");
  assert.throws(() => load(d), /main\.autoMerge.*removed/);
});

test("validate keeps its direct-call checks for normalized config objects", () => {
  const badAlias = load(tmp());
  badAlias.main.autoResolveConflicts = "yes";
  assert.throws(() => validate(badAlias), /main.autoResolveConflicts must be a boolean/);

  const badResolvers = load(tmp());
  badResolvers.main.conflictResolutionResolvers = [];
  assert.throws(() => validate(badResolvers), /main.conflictResolutionResolvers must be a non-empty list of role specs/);
});

test("main conflict-resolution keys are removed", () => {
  for (const key of ["autoResolveConflicts", "conflictResolution", "conflictResolutionResolvers", "autoResolveConflictPaths"]) {
    const d = tmp();
    writeFileSync(join(d, "orch.yml"), `main:\n  ${key}: ${key.endsWith("Paths") ? "[]" : key.endsWith("Resolvers") ? "[claude]" : key === "conflictResolution" ? "manual" : "true"}\n`);
    assert.throws(() => load(d), new RegExp(`main\\.${key}.*removed`));
  }
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

test("plural role pools reject an author with no diverse reviewer", () => {
  const d = tmp();
  writeFileSync(join(d, "orch.yml"), "authors: [claude]\nreviewers: [claude]\n");
  assert.throws(() => load(d), /authors\[0\] \(claude\) has no reviewer with a different agent/);
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

test("security.ignore defaults to [] and deep-merges from orch.yml (#334)", () => {
  assert.deepEqual(load(tmp()).security.ignore, []);
  const d = tmp();
  writeFileSync(join(d, "orch.yml"), "security:\n  ignore:\n    - dist/**\n");
  const c = load(d);
  assert.deepEqual(c.security.ignore, ["dist/**"]);
  assert.equal(c.landing, "no-ff"); // top-level defaults survive the deep-merge
});

test("security.ignore rejects non-list and empty-string globs (#334)", () => {
  const bad = tmp();
  writeFileSync(join(bad, "orch.yml"), "security:\n  ignore: dist/**\n");
  assert.throws(() => load(bad), /security\.ignore must be an array/);
  const empty = tmp();
  writeFileSync(join(empty, "orch.yml"), 'security:\n  ignore:\n    - ""\n');
  assert.throws(() => load(empty), /security\.ignore must be an array/);
});

test("a bad value is reported under the key the operator actually wrote", () => {
  const old = tmp();
  writeFileSync(join(old, "orch.yml"), "reviseCap: 0\n");
  assert.throws(() => load(old), /reviseCap.*removed/);
  const now = tmp();
  writeFileSync(join(now, "orch.yml"), "roundCap: 0\n");
  assert.throws(() => load(now), /roundCap must be a positive integer/);
});
