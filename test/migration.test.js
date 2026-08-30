import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TOOLS } from "../src/mcp.js";
import { renderHelp, validate } from "../src/schema.js";
import { load } from "../src/config.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const bin = join(root, "bin", "orch.js");
const migration = readFileSync(join(root, "docs", "MIGRATION-0.5.md"), "utf8");
const readme = readFileSync(join(root, "README.md"), "utf8");
const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");

function cli(argv) {
  return spawnSync(process.execPath, [bin, ...argv], { cwd: root, encoding: "utf8" });
}

test("v0.5 removed CLI spellings exit 64 and name their replacements", () => {
  const cases = [
    [["review", "feature/x"], /orch pr feature\/x --until once/],
    [["update"], /orch upgrade/],
    [["pr", "42", "--merge"], /--until merged/],
    [["continue", "sid-1", "--until", "merged"], /only --until once \(an explicit one-pass override\)/],
    [["agent", "add", "widget", "--build", "--pr"], /open a PR by hand/],
    [["task", "x", "--no-banner"], /unknown option --no-banner/],
    [["agent", "build", "widget"], /orch agent add/],
  ];
  for (const [argv, expected] of cases) {
    const result = cli(argv);
    assert.equal(result.status, 64, `${argv.join(" ")} exited ${result.status}: ${result.stderr}`);
    assert.match(result.stderr, expected, argv.join(" "));
  }
});

test("new cycle tools default to ready and continue inherits its recorded goal", () => {
  assert.deepEqual(TOOLS.find((tool) => tool.name === "orch_task").argv({ task: "x" }), [
    "task", "--until", "ready", "--", "x",
  ]);
  assert.deepEqual(TOOLS.find((tool) => tool.name === "orch_issue").argv({ number: 1 }), [
    "issue", "1", "--until", "ready",
  ]);
  const pr = TOOLS.find((tool) => tool.name === "orch_pr");
  assert.deepEqual(pr.argv({ number: 1 }), ["pr", "1", "--until", "ready"]);
  const continuation = TOOLS.find((tool) => tool.name === "orch_continue");
  assert.deepEqual(continuation.argv({ sid: "sid-1" }), ["continue", "sid-1"]);
  assert.equal(continuation.inputSchema.properties.until, undefined);
  assert.match(renderHelp("task"), /\(default: ready\)/);
  assert.throws(() => validate("continue", { until: "merged" }), (error) =>
    error.exit === 64 && /only --until once/.test(error.message));
});

test("removed config keys stop every command and landing is the surviving route", () => {
  const repo = mkdtempSync(join(tmpdir(), "orch-migration-config-"));
  writeFileSync(join(repo, "orch.yml"), "merge: no-ff\n");
  assert.throws(() => load(repo), /'merge'.*landing/);

  writeFileSync(join(repo, "orch.yml"), "landing: no-ff\n");
  assert.equal(load(repo).landing, "no-ff");

  const check = execFileSync(process.execPath, [bin, "config", "--check"], {
    cwd: repo, encoding: "utf8",
  });
  assert.match(check, /orch config: ok/);
});

test("v0.5 migration guide is linked and covers the bare-run change", () => {
  assert.match(readme, /\]\(docs\/MIGRATION-0\.5\.md\)/);
  assert.match(changelog, /\]\(docs\/MIGRATION-0\.5\.md\)/);
  assert.match(migration, /bare `task`, `issue`, and `pr` mean `--until ready`/);
  assert.match(migration, /continue.*recorded goal/i);
});
