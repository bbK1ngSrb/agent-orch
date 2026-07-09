import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel) =>
  readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");

const pkg = JSON.parse(read("package.json"));
const readme = read("README.md");
const design = read("docs/design.md");
const landing = read("docs/index.html");
const manual = read("docs/orch-manual.md");
const exampleConfig = read("orch.example.yml");
const coc = read("CODE_OF_CONDUCT.md");
const changelog = read("CHANGELOG.md");

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
  assert.match(readme, /orch agent add <name>/);
});

test("docs list the built-in CLI adapters", () => {
  for (const doc of [readme, design, exampleConfig]) {
    assert.match(doc, /claude/);
    assert.match(doc, /codex/);
    assert.match(doc, /copilot/);
    assert.match(doc, /gemini/);
  }
  assert.doesNotMatch(design, /Ship two adapters/);
  assert.doesNotMatch(design, /claude` and\/or `codex/);
  assert.doesNotMatch(design, /Gemini\/Aider/);
});

test("README documents bash completion install/update behavior", () => {
  assert.match(pkg.scripts.postinstall, /completion install/);
  assert.match(readme, /~\/\.orch\/completion\.bash/);
  assert.match(readme, /orch completion bash/);
  assert.match(readme, /orch completion install/);
});

test("design doc reflects the GitHub PR bridge", () => {
  assert.match(design, /orch pr <n>/);
  assert.match(design, /GitHub PR bridge/);
  assert.doesNotMatch(design, /There is no GitHub PR/);
  assert.doesNotMatch(design, /Three commands/);
  assert.doesNotMatch(design, /Any GitHub PR \/ Actions \/ remote integration/);
});

test("README documents the auto docs-update feature and its loop guard", () => {
  assert.match(readme, /docs.autoUpdate/);
  assert.match(readme, /[Ll]oop guard/);
  assert.match(readme, /no-op/); // guard covers empty-diff merges too
});

test("docs document main.autoMerge for the persistent integration PR", () => {
  for (const doc of [readme, manual, exampleConfig]) {
    assert.match(doc, /main\.autoMerge|autoMerge: false/);
  }
  assert.match(manual, /persistent `orch\/integration → main` PR/);
  assert.match(readme, /direct merge of that\s+persistent PR/);
});

test("landing page is plain static HTML with social metadata", () => {
  assert.match(landing, /<meta property="og:title" content="orch - agents orchestration tool">/);
  assert.match(landing, /<meta property="og:description"/);
  assert.match(landing, /<meta property="og:image"/);
  assert.match(landing, /<meta name="twitter:card" content="summary_large_image">/);
  assert.match(landing, /Run local coding agents[\s\S]*cross-audit loop/);
  assert.match(landing, /npm install -g[\s\S]*@bbk1ng\/agent-orch/);
  assert.doesNotMatch(landing, /__bundler/);
  assert.doesNotMatch(landing, /<x-dc/i);
  assert.doesNotMatch(landing, /This page requires JavaScript to display/);
});

test("landing page includes mobile layout overrides", () => {
  assert.match(landing, /@media \(max-width: 640px\)/);
  assert.match(landing, /\.loop-grid, \.feature-grid \{ grid-template-columns: 1fr; \}/);
  assert.match(landing, /\.hero-actions \{ flex-direction: column; align-items: stretch; \}/);
  assert.match(landing, /\.command \{ grid-template-columns: 1fr; gap: 6px; \}/);
});

test("docs explain stale `orch continue` resume handling", () => {
  for (const doc of [readme, manual]) {
    assert.match(doc, /orch continue <sid>/);
    assert.match(doc, /stale/);
    assert.match(doc, /origin\/<branch>/);
    assert.match(doc, /check it out locally/);
  }
});

test("the GitHub-merge surface (orch-docs Action) exists and is documented", () => {
  const wf = read(".github/workflows/orch-docs.yml");
  assert.match(wf, /pull_request/);
  assert.match(wf, /merged == true/);
  assert.match(wf, /orch task/);
  assert.match(readme, /orch-docs\.yml/);
});

test("CODE_OF_CONDUCT gives an actionable private contact for enforcement", () => {
  const enforcement = coc.slice(coc.indexOf("## Enforcement"));
  assert.match(enforcement, /[\w.+-]+@[\w-]+\.[\w.-]+/); // a real email address
});

test("landing header version span matches package.json and the bump regex still matches it (#192)", () => {
  // The site is a built artifact; the release bump rewrites its header version
  // span in src/git.js. If the design tool re-exports with a different closing-
  // tag escaping, the bump regex silently no-ops and the version freezes — so
  // guard both the current value and that the regex actually matches it.
  assert.match(landing, new RegExp(`>v${pkg.version.replace(/\\./g, "\\.")}</span>`));
  const bumpRe = /v\d+\.\d+\.\d+(?=<(?:\\u002F|\\\/|\/)span>)/;
  assert.match(landing, bumpRe);
});

test("CHANGELOG documents the latest merged fixes", () => {
  const unreleased = changelog.slice(
    changelog.indexOf("## Unreleased"),
    changelog.indexOf("## 0.3.18"),
  );
  assert.match(unreleased, /numeric PR id/);
  assert.match(unreleased, /designer-template leftovers/);
  assert.match(unreleased, /escaping nested `<\/script>` close tags/);
});
