import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { parse } from "yaml";
import { DEFAULTS, load, validate } from "../src/config.js";
import { OPTION_CATALOG, applyAnswer, applyChoice, configToYaml, loadTarget, runConfigWizard, validateCatalog } from "../src/config-wizard.js";

function tmp() { return mkdtempSync(join(tmpdir(), "orch-wizard-")); }

test("option catalog is consistent with DEFAULTS and validate()", () => {
  assert.equal(validateCatalog(), true);
  const keys = OPTION_CATALOG.flatMap((entry) => entry.keys);
  assert.deepEqual(keys, [
    "agents", "author", "reviewer", "authors", "reviewers", "test", "roundCap", "stageTimeout",
    "baseBranch", "integrationBranch", "merge", "concurrency", "cheap.role", "cheap.paths",
    "scope.maxLines", "scope.ignore", "security.ignore", "github.mergeMethod", "github.autoMergePr",
    "main.autoMerge", "main.conflictResolution", "main.conflictResolutionResolvers",
    "main.autoResolveConflicts", "main.autoResolveConflictPaths",
    "release.autoBump", "docs.autoUpdate", "docs.prompt", "docs.paths",
  ]);
});

test("applyChoice cycles enum and bool options", () => {
  const merge = OPTION_CATALOG.find((entry) => entry.keys[0] === "merge");
  const autoMerge = OPTION_CATALOG.find((entry) => entry.keys[0] === "github.autoMergePr");
  assert.equal(applyChoice(merge, "no-ff", "right"), "pr");
  assert.equal(applyChoice(merge, "ff-only", "left"), "pr");
  assert.equal(applyChoice(autoMerge, false, "right"), true);
  assert.equal(applyChoice(autoMerge, true, "left"), false);
});

test("answers assemble into a config validate accepts and YAML round-trips", () => {
  let cfg = DEFAULTS;
  cfg = applyAnswer(cfg, OPTION_CATALOG.find((entry) => entry.keys[0] === "merge"), "pr");
  cfg = applyAnswer(cfg, OPTION_CATALOG.find((entry) => entry.keys[0] === "roundCap"), "5");
  cfg = applyAnswer(cfg, OPTION_CATALOG.find((entry) => entry.keys[0] === "cheap.paths"), "*.md, docs/**");
  validate(cfg);
  const roundTrip = parse(configToYaml(cfg));
  assert.equal(roundTrip.merge, "pr");
  assert.equal(roundTrip.roundCap, 5);
  assert.deepEqual(roundTrip.cheap.paths, ["*.md", "docs/**"]);
});

test("invalid answer is rejected before YAML is written", () => {
  const revise = OPTION_CATALOG.find((entry) => entry.keys[0] === "roundCap");
  assert.throws(() => applyAnswer(DEFAULTS, revise, "0"), /roundCap must be a positive integer/);
});

test("non-TTY config wizard exits clearly without hanging", async () => {
  const stdin = new PassThrough();
  stdin.isTTY = false;
  await assert.rejects(() => runConfigWizard({ repo: tmp(), stdin, stdout: new Writable({ write(_c, _e, cb) { cb(); } }) }), /interactive config needs a TTY/);
});

test("configToYaml validates before serializing", () => {
  const cfg = applyAnswer(DEFAULTS, OPTION_CATALOG.find((entry) => entry.keys[0] === "github.autoMergePr"), true);
  const yaml = configToYaml(cfg);
  const saved = parse(yaml);
  assert.equal(saved.github.autoMergePr, true);
  // Serialized form omits the deprecated alias; reload via load() re-derives it.
  assert.equal(Object.hasOwn(saved.main || {}, "autoResolveConflicts"), false);
  const d = tmp();
  mkdirSync(join(d, ".orch"), { recursive: true });
  writeFileSync(join(d, ".orch", "orch.yml"), yaml);
  const reloaded = load(d);
  validate(reloaded);
  assert.equal(reloaded.github.autoMergePr, true);
});

test("alias-only autoResolveConflicts round-trips to canonical conflictResolution: auto", () => {
  // Simulate a user file that only has the deprecated alias (Codex #3 / A4 acceptance).
  const d = tmp();
  mkdirSync(join(d, ".orch"), { recursive: true });
  writeFileSync(join(d, ".orch", "orch.yml"), "main:\n  autoResolveConflicts: true\n");
  const loaded = load(d);
  assert.equal(loaded.main.conflictResolution, "auto");
  assert.equal(loaded.main.autoResolveConflicts, true);

  const yaml = configToYaml(loaded);
  const saved = parse(yaml);
  assert.equal(saved.main.conflictResolution, "auto");
  assert.equal(Object.hasOwn(saved.main, "autoResolveConflicts"), false);

  // Reload of wizard output must keep auto-resolution on.
  writeFileSync(join(d, ".orch", "orch.yml"), yaml);
  const reloaded = load(d);
  assert.equal(reloaded.main.conflictResolution, "auto");
  assert.equal(reloaded.main.autoResolveConflicts, true);
});

test("wizard applyAnswer enforces conflict-resolution business rules, not just types", () => {
  // Single-agent pool + claude resolver + propose requires a distinct reviewer (normalizeMainConfig).
  let cfg = applyAnswer(DEFAULTS, OPTION_CATALOG.find((entry) => entry.keys[0] === "agents"), "claude");
  cfg = applyAnswer(cfg, OPTION_CATALOG.find((entry) => entry.keys[0] === "main.conflictResolutionResolvers"), "claude");
  assert.throws(
    () => applyAnswer(cfg, OPTION_CATALOG.find((entry) => entry.keys[0] === "main.conflictResolution"), "propose"),
    /requires a conflict reviewer/,
  );
});

test("editing the deprecated alias re-drives conflictResolution", () => {
  const mode = OPTION_CATALOG.find((entry) => entry.keys[0] === "main.conflictResolution");
  const alias = OPTION_CATALOG.find((entry) => entry.keys[0] === "main.autoResolveConflicts");
  let cfg = applyAnswer(DEFAULTS, mode, "manual");
  cfg = applyAnswer(cfg, alias, true);
  assert.equal(cfg.main.conflictResolution, "auto");
  assert.equal(cfg.main.autoResolveConflicts, true);
  const saved = parse(configToYaml(cfg));
  assert.equal(saved.main.conflictResolution, "auto");
  assert.equal(Object.hasOwn(saved.main, "autoResolveConflicts"), false);
});

test("alias-only reviseCap keeps its value through a wizard save", () => {
  // Codex: saving an existing reviseCap-only config must not reset the cap to DEFAULTS' 3.
  const d = tmp();
  mkdirSync(join(d, ".orch"), { recursive: true });
  const file = join(d, ".orch", "orch.yml");
  writeFileSync(file, "reviseCap: 7\n");
  const cfg = loadTarget(file);
  assert.equal(cfg.roundCap, 7);
  assert.equal(Object.hasOwn(cfg, "reviseCap"), false);

  const yaml = configToYaml(cfg);
  assert.equal(Object.hasOwn(parse(yaml), "reviseCap"), false);
  writeFileSync(file, yaml);
  assert.equal(load(d).roundCap, 7);
});

test("wizard save keeps roundCap when a file names both keys", () => {
  const d = tmp();
  mkdirSync(join(d, ".orch"), { recursive: true });
  const file = join(d, ".orch", "orch.yml");
  writeFileSync(file, "roundCap: 5\nreviseCap: 7\n");
  const saved = parse(configToYaml(loadTarget(file)));
  assert.equal(saved.roundCap, 5);
  assert.equal(Object.hasOwn(saved, "reviseCap"), false);
});

test("wizard target preserves nested security settings through the shared merge", () => {
  const d = tmp();
  mkdirSync(join(d, ".orch"), { recursive: true });
  const file = join(d, ".orch", "orch.yml");
  writeFileSync(file, "security:\n  ignore:\n    - dist/**\n");

  assert.deepEqual(loadTarget(file).security.ignore, ["dist/**"]);
});

test("a bad alias value is reported under the key the operator typed", () => {
  const d = tmp();
  mkdirSync(join(d, ".orch"), { recursive: true });
  const file = join(d, ".orch", "orch.yml");
  writeFileSync(file, "reviseCap: 0\n");
  assert.throws(() => loadTarget(file), /reviseCap must be a positive integer/);
});
