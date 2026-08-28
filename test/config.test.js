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
  assert.equal(c.merge, "no-ff");
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
  assert.equal(c.merge, "ff-only");
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
  writeFileSync(override, "main:\n  conflictResolutionResolvers: [codex]\n");
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

test("removed config keys remain valid but report exact replacement warnings", () => {
  const d = tmp();
  writeFileSync(join(d, "orch.yml"), "merge: pr\nmain:\n  autoMerge: true\ngithub:\n  autoMergePr: true\n");
  const warnings = [];
  const c = load(d, undefined, { onWarning: (warning) => warnings.push(warning) });
  assert.equal(c.merge, "pr");
  assert.deepEqual(warnings, [
    "orch.yml: 'merge' will be renamed to 'landing' in v0.5.0 (same values). Rename the key.",
    "orch.yml: 'main.autoMerge' will be removed in v0.5.0; use --until merged for per-run merging.",
    "orch.yml: 'github.autoMergePr' will be removed in v0.5.0; use --until merged for per-run merging.",
  ]);
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

test("configReport returns effective values, provenance, and warnings", () => {
  const d = tmp();
  writeFileSync(join(d, "orch.yml"), "stageTimeout: 41\nmerge: no-ff\n");
  const report = configReport(d);
  assert.equal(report.ok, true);
  assert.equal(report.config.gateTimeout, 41);
  assert.equal(report.sources.stageTimeout, "orch.yml");
  assert.equal(report.sources.gateTimeout, "orch.yml");
  assert.equal(report.sources.landing, "orch.yml");
  assert.equal(report.sources.merge, "orch.yml");
  assert.match(report.warnings[0], /'merge' will be renamed to 'landing'/);
});

test("configReport labels only leaves and keeps aliases on the same source", () => {
  const d = tmp();
  writeFileSync(join(d, "orch.yml"), "landing: pr\nmain:\n  autoMerge: true\n");
  const report = configReport(d);
  assert.equal(report.sources.main, undefined);
  assert.equal(report.sources["main.autoMerge"], "orch.yml");
  assert.equal(report.sources.landing, "orch.yml");
  assert.equal(report.sources.merge, "orch.yml");
});

test("configReport uses the .orch config path in warning provenance", () => {
  const d = tmp();
  mkdirSync(join(d, ".orch"), { recursive: true });
  writeFileSync(join(d, ".orch", "orch.yml"), "main:\n  autoMerge: true\n");
  const report = configReport(d);
  assert.equal(report.sources["main.autoMerge"], ".orch/orch.yml");
  assert.match(report.warnings[0], /^\.orch\/orch\.yml:/);
});

test("configReport provenance follows override precedence across renamed keys", () => {
  const d = tmp();
  writeFileSync(join(d, "orch.yml"), "landing: ff-only\n");
  const override = join(d, "custom.yml");
  writeFileSync(override, "merge: pr\n");
  const report = configReport(d, override);
  assert.equal(report.config.landing, "pr");
  assert.equal(report.sources.landing, "--config-file");
  assert.equal(report.sources.merge, "--config-file");
});

test("configReport attributes normalized values to the source that supplied them", () => {
  const d = tmp();
  writeFileSync(join(d, "orch.yml"), [
    "stageTimeout: 5",
    "main:",
    "  conflictResolution: auto",
    "automation:",
    "  conflictResolvers: [claude, codex]",
    "  conflictAutoPaths: [CHANGELOG.md]",
    "",
  ].join("\n"));
  const report = configReport(d);
  assert.equal(report.config.gateTimeout, 5);
  assert.equal(report.config.main.autoResolveConflicts, true);
  assert.equal(report.sources.gateTimeout, "orch.yml");
  assert.equal(report.sources["main.conflictResolution"], "orch.yml");
  assert.equal(report.sources["main.autoResolveConflicts"], "orch.yml");
  assert.equal(report.sources["main.conflictResolutionResolvers"], "orch.yml");
  assert.equal(report.sources["main.autoResolveConflictPaths"], "orch.yml");

  const alias = tmp();
  writeFileSync(join(alias, "orch.yml"), "main:\n  autoResolveConflicts: true\n");
  const aliasReport = configReport(alias);
  assert.equal(aliasReport.config.main.conflictResolution, "auto");
  assert.equal(aliasReport.sources["main.conflictResolution"], "orch.yml");
  assert.equal(aliasReport.sources["main.autoResolveConflicts"], "orch.yml");
});

test("configReport matches loaded conflict resolvers across config layers", () => {
  const d = tmp();
  writeFileSync(join(d, "orch.yml"), "automation:\n  conflictResolvers: [claude]\n");
  const override = join(d, "custom.yml");
  writeFileSync(override, "main:\n  conflictResolutionResolvers: [codex]\n");
  const effective = load(d, override, { onWarning() {} });
  const report = configReport(d, override);
  assert.deepEqual(report.config.main.conflictResolutionResolvers, effective.main.conflictResolutionResolvers);
  assert.equal(report.sources["main.conflictResolutionResolvers"], "--config-file");
});

test("removed-key warnings name --config-file when that layer supplied the key", () => {
  const d = tmp();
  const override = join(d, "custom.yml");
  writeFileSync(override, "main:\n  autoMerge: true\n");
  const warnings = [];
  load(d, override, { onWarning: (warning) => warnings.push(warning) });
  assert.deepEqual(warnings, [
    "--config-file: 'main.autoMerge' will be removed in v0.5.0; use --until merged for per-run merging.",
  ]);
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
  writeFileSync(override, "roundCap: 7\n");
  assert.equal(load(d, override).roundCap, 7);
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

test("validate keeps its direct-call checks for normalized config objects", () => {
  const badAlias = load(tmp());
  badAlias.main.autoResolveConflicts = "yes";
  assert.throws(() => validate(badAlias), /main.autoResolveConflicts must be a boolean/);

  const badResolvers = load(tmp());
  badResolvers.main.conflictResolutionResolvers = [];
  assert.throws(() => validate(badResolvers), /main.conflictResolutionResolvers must be a non-empty list of role specs/);
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

test("security.ignore defaults to [] and deep-merges from orch.yml (#334)", () => {
  assert.deepEqual(load(tmp()).security.ignore, []);
  const d = tmp();
  writeFileSync(join(d, "orch.yml"), "security:\n  ignore:\n    - dist/**\n");
  const c = load(d);
  assert.deepEqual(c.security.ignore, ["dist/**"]);
  assert.equal(c.merge, "no-ff"); // top-level defaults survive the deep-merge
});

test("security.ignore rejects non-list and empty-string globs (#334)", () => {
  const bad = tmp();
  writeFileSync(join(bad, "orch.yml"), "security:\n  ignore: dist/**\n");
  assert.throws(() => load(bad), /security\.ignore must be an array/);
  const empty = tmp();
  writeFileSync(join(empty, "orch.yml"), 'security:\n  ignore:\n    - ""\n');
  assert.throws(() => load(empty), /security\.ignore must be an array/);
});

// --- roundCap / reviseCap alias -------------------------------------------
// `roundCap` counts total review rounds (the initial review is round one).
// `reviseCap` is the old spelling: still honoured so published orch.yml files
// keep working, but normalised onto roundCap with a deprecation warning.
function captureWarnings(fn) {
  const seen = [];
  const original = console.warn;
  console.warn = (...args) => seen.push(args.join(" "));
  try { return { result: fn(), warnings: seen }; } finally { console.warn = original; }
}

test("deprecated reviseCap still sets roundCap, with a warning", () => {
  const d = tmp();
  writeFileSync(join(d, "orch.yml"), "reviseCap: 7\n");
  const { result: c, warnings } = captureWarnings(() => load(d));
  assert.equal(c.roundCap, 7);
  assert.equal(c.reviseCap, undefined); // normalised away: one source of truth
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /orch: orch\.yml uses deprecated reviseCap/);
});

test("both keys in one file: roundCap wins and the conflict is warned about", () => {
  const d = tmp();
  writeFileSync(join(d, "orch.yml"), "roundCap: 4\nreviseCap: 9\n");
  const { result: c, warnings } = captureWarnings(() => load(d));
  assert.equal(c.roundCap, 4);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /orch: orch\.yml sets both roundCap and reviseCap/);
});

test("--config-file reviseCap still overrides an orch.yml roundCap", () => {
  const d = tmp();
  writeFileSync(join(d, "orch.yml"), "roundCap: 4\n");
  const override = join(d, "custom.yml");
  writeFileSync(override, "reviseCap: 2\n");
  const { result: c, warnings } = captureWarnings(() => load(d, override));
  assert.equal(c.roundCap, 2); // the layer the operator passed last wins, alias or not
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /orch: --config-file uses deprecated reviseCap/);
});

test("reviseCap warnings retain both config layer labels", () => {
  const d = tmp();
  writeFileSync(join(d, "orch.yml"), "reviseCap: 4\n");
  const override = join(d, "custom.yml");
  writeFileSync(override, "reviseCap: 2\n");
  const { warnings } = captureWarnings(() => load(d, override));
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /orch: orch\.yml uses deprecated reviseCap/);
  assert.match(warnings[1], /orch: --config-file uses deprecated reviseCap/);
});

test("a bad value is reported under the key the operator actually wrote", () => {
  const old = tmp();
  writeFileSync(join(old, "orch.yml"), "reviseCap: 0\n");
  assert.throws(() => captureWarnings(() => load(old)), /reviseCap must be a positive integer/);
  const now = tmp();
  writeFileSync(join(now, "orch.yml"), "roundCap: 0\n");
  assert.throws(() => load(now), /roundCap must be a positive integer/);
});
