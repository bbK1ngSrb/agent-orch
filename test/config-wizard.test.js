import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { parse } from "yaml";
import { DEFAULTS, validate } from "../src/config.js";
import { OPTION_CATALOG, applyAnswer, applyChoice, configToYaml, runConfigWizard, validateCatalog } from "../src/config-wizard.js";

function tmp() { return mkdtempSync(join(tmpdir(), "orch-wizard-")); }

test("option catalog is consistent with DEFAULTS and validate()", () => {
  assert.equal(validateCatalog(), true);
  const keys = OPTION_CATALOG.flatMap((entry) => entry.keys);
  assert.deepEqual(keys, [
    "agents", "author", "reviewer", "authors", "reviewers", "test", "reviseCap", "stageTimeout",
    "baseBranch", "integrationBranch", "merge", "concurrency", "cheap.role", "cheap.paths",
    "scope.maxLines", "scope.ignore", "github.mergeMethod", "github.autoMergePr",
    "main.autoMerge", "release.autoBump", "docs.autoUpdate", "docs.prompt", "docs.paths",
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
  cfg = applyAnswer(cfg, OPTION_CATALOG.find((entry) => entry.keys[0] === "reviseCap"), "5");
  cfg = applyAnswer(cfg, OPTION_CATALOG.find((entry) => entry.keys[0] === "cheap.paths"), "*.md, docs/**");
  validate(cfg);
  const roundTrip = parse(configToYaml(cfg));
  assert.equal(roundTrip.merge, "pr");
  assert.equal(roundTrip.reviseCap, 5);
  assert.deepEqual(roundTrip.cheap.paths, ["*.md", "docs/**"]);
});

test("invalid answer is rejected before YAML is written", () => {
  const revise = OPTION_CATALOG.find((entry) => entry.keys[0] === "reviseCap");
  assert.throws(() => applyAnswer(DEFAULTS, revise, "0"), /reviseCap must be a positive integer/);
});

test("non-TTY config wizard exits clearly without hanging", async () => {
  const stdin = new PassThrough();
  stdin.isTTY = false;
  await assert.rejects(() => runConfigWizard({ repo: tmp(), stdin, stdout: new Writable({ write(_c, _e, cb) { cb(); } }) }), /interactive config needs a TTY/);
});

test("configToYaml validates before serializing", () => {
  const cfg = applyAnswer(DEFAULTS, OPTION_CATALOG.find((entry) => entry.keys[0] === "github.autoMergePr"), true);
  const saved = parse(configToYaml(cfg));
  validate(saved);
  assert.equal(saved.github.autoMergePr, true);
});
