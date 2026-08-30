import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMANDS, FLAGS, validatePositionals } from "../src/schema.js";
import { parse } from "../src/cli.js";
import { load } from "../src/config.js";
import { TOOLS, handle } from "../src/mcp.js";

test("v0.5 removes the legacy CLI commands and flags", () => {
  for (const command of ["review", "update"]) assert.equal(COMMANDS[command], undefined);
  for (const flag of ["merge", "pr", "no-banner"]) assert.equal(FLAGS[flag], undefined);
  for (const argv of [
    ["task", "x", "--merge"],
    ["task", "x", "--pr"],
    ["task", "x", "--no-banner"],
  ]) assert.throws(() => parse(argv), /unknown option/);
  assert.throws(() => validatePositionals("agent", ["build", "name"], {}), /usage: orch agent add/);
});

test("bare cycle tools use the ready goal and removed MCP review points to orch_pr", async () => {
  for (const name of ["orch_task", "orch_issue", "orch_pr", "orch_continue"]) {
    const tool = TOOLS.find((candidate) => candidate.name === name);
    const args = name === "orch_task" ? { task: "x" }
      : name === "orch_issue" ? { number: 1 }
        : name === "orch_pr" ? { number: 1 }
          : { sid: "1-a" };
    assert.equal(tool.argv(args).at(-1), name === "orch_task" ? "x" : "ready");
  }
  assert.equal(TOOLS.some((tool) => tool.name === "orch_review"), false);
  const removed = await handle({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "orch_review", arguments: { branch: "feature/x" } },
  }, {});
  assert.deepEqual(removed.error, { code: -32601, message: "method not found: orch_review (use orch_pr)" });
});

test("removed config keys are hard errors and landing is the surviving route", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-v05-config-"));
  mkdirSync(join(dir, ".orch"), { recursive: true });
  writeFileSync(join(dir, ".orch", "orch.yml"), "landing: pr\n");
  assert.equal(load(dir).landing, "pr");
  for (const key of ["merge: pr", "reviseCap: 3", "github:\n  autoMergePr: true", "main:\n  autoMerge: true"]) {
    writeFileSync(join(dir, ".orch", "orch.yml"), `${key}\n`);
    assert.throws(() => load(dir), new RegExp(key.split(":")[0].replace(".", "\\.")));
  }
});

test("package version is the v0.5 cutover", async () => {
  const pkg = await import("../package.json", { with: { type: "json" } });
  assert.equal(pkg.default.version, "0.5.0");
});
