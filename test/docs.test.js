import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel) =>
  readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");

const pkg = JSON.parse(read("package.json"));
const readme = read("README.md");
const design = read("docs/design.md");
const coc = read("CODE_OF_CONDUCT.md");

test("the CLI bin is `orch`", () => {
  assert.deepEqual(Object.keys(pkg.bin), ["orch"]);
});

test("README does not promise install commands that resolve to a different npm package", () => {
  // `agent-orch` on npm is an unrelated package, and this CLI's bin is `orch`,
  // so these invocations would not run this project. Guard against regressions.
  assert.doesNotMatch(readme, /npx\s+agent-orch/);
  assert.doesNotMatch(readme, /npm\s+install\s+-g\s+agent-orch/);
});

test("README documents the `orch` CLI", () => {
  assert.match(readme, /orch\s+init/);
});

test("design doc reflects the GitHub PR bridge", () => {
  assert.match(design, /orch pr <n>/);
  assert.match(design, /GitHub PR bridge/);
  assert.doesNotMatch(design, /There is no GitHub PR/);
  assert.doesNotMatch(design, /Three commands/);
  assert.doesNotMatch(design, /Any GitHub PR \/ Actions \/ remote integration/);
});

test("README documents the auto docs-update feature and the Action template", () => {
  assert.match(readme, /docs.autoUpdate/);
  assert.match(readme, /orch-docs\.yml/);
  assert.match(readme, /[Ll]oop guard/);
});

test("orch-docs.yml Action exists and skips docs-only merges", () => {
  const wf = read(".github/workflows/orch-docs.yml");
  assert.match(wf, /pull_request:/);
  assert.match(wf, /merged == true/);
  assert.match(wf, /docs-only/);
});

test("CODE_OF_CONDUCT gives an actionable private contact for enforcement", () => {
  const enforcement = coc.slice(coc.indexOf("## Enforcement"));
  assert.match(enforcement, /[\w.+-]+@[\w-]+\.[\w.-]+/); // a real email address
});
