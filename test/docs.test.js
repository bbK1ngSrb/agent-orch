import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ORCH_DOC } from "../src/cli.js";

const rootUrl = new URL("../", import.meta.url);
const rootDir = fileURLToPath(rootUrl);
const read = (rel) =>
  readFileSync(fileURLToPath(new URL(rel, rootUrl)), "utf8");

const pkg = JSON.parse(read("package.json"));
const claude = read("CLAUDE.md");
const readme = read("README.md");
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
  for (const doc of [readme, exampleConfig]) {
    assert.match(doc, /claude/);
    assert.match(doc, /codex/);
    assert.match(doc, /copilot/);
    assert.match(doc, /gemini/);
  }
});

test("docs document the dashboard --check-history flag", () => {
  // Shipped with `orch dashboard --check-history`; guard the prose docs against
  // drift from the CLI help/completion where the flag already lives.
  for (const doc of [readme, manual]) {
    assert.match(doc, /--check-history/);
  }
  // `--check-history` reconciles history at *display* time only: dashboard.js's
  // reconcileHistory returns fresh `{ ...e, resolved: true }` objects for the
  // render and never writes back to runs.jsonl. The docs must not imply an
  // on-disk rewrite/repair, or users will expect the history file to change.
  assert.doesNotMatch(manual, /rewrites stale red history/);
  assert.match(manual, /runs\.jsonl.*(untouched|unchanged)|(untouched|unchanged).*runs\.jsonl/i);
  assert.match(readme, /view-only|view only/i);
});

test("the generated per-repo ORCH.md template documents all dashboard flags", () => {
  // `orch init` writes ORCH_DOC verbatim to .orch/ORCH.md and overwrites it on
  // every init, so it must track the CLI. The prose-docs test above only covers
  // README/manual and would miss the template drifting out of sync (it once
  // advertised only `--json`).
  assert.match(ORCH_DOC, /--json/);
  assert.match(ORCH_DOC, /--limit/);
  assert.match(ORCH_DOC, /--check-history/);
});

test("README documents bash completion install/update behavior", () => {
  assert.match(pkg.scripts.postinstall, /completion install/);
  assert.match(readme, /~\/\.orch\/completion\.bash/);
  assert.match(readme, /orch completion bash/);
  assert.match(readme, /orch completion install/);
});

test("npm pack dry-run excludes test files from the package", () => {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: rootDir,
    encoding: "utf8",
    env: {
      ...process.env,
      npm_config_cache: "/tmp/npm-cache-agent-orch",
      npm_config_loglevel: "silent",
      npm_config_update_notifier: "false",
    },
  });
  const [{ files }] = JSON.parse(out);
  assert.deepEqual(files.map((f) => f.path).filter((p) => p.endsWith(".test.js")), []);
});

test("README documents the auto docs-update feature and its loop guard", () => {
  assert.match(readme, /docs.autoUpdate/);
  assert.match(readme, /[Ll]oop guard/);
  assert.match(readme, /no-op/); // guard covers empty-diff merges too
});

test("docs document that the version bump on merge is opt-in via release.autoBump", () => {
  // finalize() only calls bumpVersion() when release.autoBump is true (default
  // off), so the prose must not promise an unconditional post-merge bump.
  for (const doc of [readme, manual, exampleConfig]) {
    assert.match(doc, /release\.autoBump|autoBump: false/);
  }
  for (const doc of [readme, manual]) {
    assert.match(doc, /release\.autoBump/);
    assert.match(doc, /[Oo]pt-in|off by default/);
  }
  // the FAQ answer must point at the flag, not just at merge modes
  assert.match(manual, /"Why didn't my version get bumped\?"[\s\S]{0,200}release\.autoBump/);
});

test("docs document main.autoMerge for the persistent integration PR", () => {
  for (const doc of [readme, manual, exampleConfig]) {
    assert.match(doc, /main\.autoMerge|autoMerge: false/);
  }
  assert.match(manual, /persistent `orch\/integration → main` PR/);
  assert.match(readme, /direct merge of that\s+persistent PR/);
});

test("docs explain headless self-merge needs bypass or a second reviewer identity", () => {
  for (const doc of [readme, manual, ORCH_DOC]) {
    assert.match(doc, /approve its own PR|self-approval/);
    assert.match(doc, /bypass_actors/);
    assert.match(doc, /cross-audit/);
  }
  assert.match(manual, /GitHub approval is bypassed, not recorded/);
});

test("CLAUDE routes agent changes through the persistent integration PR", () => {
  assert.match(claude, /Agent-generated changes destined for `main` must start as a GitHub Issue/);
  assert.match(claude, /Never hand-author a direct agent PR to `main`/);
  assert.match(claude, /ambient\s+`gh` identity—the repo owner—not `orch\[bot\]`/);
  assert.match(claude, /does not allow a PR author\s+to approve its own PR/);
  assert.match(claude, /single persistent `orch\/integration → main` PR/);
  assert.match(claude, /trivial human\/owner chore or\s+documentation change may still use a direct owner PR/);
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
