import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir, cwd } from "node:process";
import { main } from "../src/cli.js";

function tmp() { return mkdtempSync(join(tmpdir(), "orch-config-command-")); }

async function runConfig(repo, args) {
  const previousCwd = cwd();
  const previousExitCode = process.exitCode;
  const previousLog = console.log;
  const output = [];
  chdir(repo);
  process.exitCode = 0;
  console.log = (...parts) => output.push(parts.join(" "));
  try {
    await main(["config", ...args], {
      maybeNotifyUpdate: () => { throw new Error("config inspection must not check for updates"); },
    });
    return { output: output.join("\n"), exitCode: process.exitCode };
  } finally {
    console.log = previousLog;
    chdir(previousCwd);
    process.exitCode = previousExitCode === undefined ? 0 : previousExitCode;
  }
}

test("config --check accepts v0.4 outcome keys and names their replacements", async () => {
  const repo = tmp();
  writeFileSync(join(repo, "orch.yml"), "main:\n  autoMerge: true\n");
  const result = await runConfig(repo, ["--check"]);
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /^orch config: ok/m);
  assert.match(result.output, /--until merged/);
});

test("config --json reports effective config and provenance", async () => {
  const repo = tmp();
  writeFileSync(join(repo, "orch.yml"), "stageTimeout: 41\nlanding: ff-only\n");
  const result = await runConfig(repo, ["--json"]);
  const report = JSON.parse(result.output);
  assert.equal(result.exitCode, 0);
  assert.equal(report.command, "config");
  assert.equal(report.config.landing, "ff-only");
  assert.equal(report.config.gateTimeout, 41);
  assert.equal(report.sources.landing, "orch.yml");
  assert.equal(report.sources.gateTimeout, "orch.yml");
});

test("config --check returns a non-zero status for invalid config", async () => {
  const repo = tmp();
  writeFileSync(join(repo, "orch.yml"), "test: null\n");
  const result = await runConfig(repo, ["--check"]);
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /test must be a non-empty string/);
});
