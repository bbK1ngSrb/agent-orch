import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// docs/index.html is a build artifact exported from a visual design tool. The
// export is supposed to "bake" the template language away (resolve <sc-if>
// conditionals, substitute {{ mustache }} bindings) into plain HTML. A bad
// re-export can silently leak those constructs back in — issue: unbaked
// designer-template leftovers + dead placeholder links. This guards against it.
const html = readFileSync(
  fileURLToPath(new URL("../docs/index.html", import.meta.url)),
  "utf8",
);

function bundledTemplate() {
  const open = '<script type="__bundler/template">';
  const start = html.indexOf(open) + open.length;
  const end = html.lastIndexOf("\n  </script>");
  return html.slice(start, end).trim();
}

function decodedBundledTemplate() {
  return JSON.parse(bundledTemplate());
}

test("landing page has no unbaked designer-template constructs", () => {
  assert.ok(!html.includes("{{"), "leftover {{ mustache }} binding");
  assert.ok(!html.includes("<sc-"), "leftover <sc-*> template element");
  assert.ok(!html.includes("hint-"), "leftover design-tool hint-* attribute");
});

test("landing page has no dead placeholder links", () => {
  // href="#" (stored escaped as href=\"#\" inside the exported JS string blob)
  // navigates to the top of the same page instead of anywhere useful.
  assert.ok(!html.includes('href=\\"#\\"'), 'dead href="#" placeholder link');
});

test("landing page bundled template survives the browser's script tokenizer", () => {
  const body = bundledTemplate();

  assert.doesNotMatch(
    body,
    /<\/script>/i,
    "template body has an unescaped </script>; browser will truncate it",
  );

  const open = '<script type="__bundler/template">';
  const start = html.indexOf(open) + open.length;
  const firstClose = html.slice(start).search(/<\/script/i);
  const browserText = html.slice(start, start + firstClose).trim();
  const decoded = JSON.parse(browserText);
  assert.match(decoded, /Two agents/);
});

test("landing page bundled template is baked browser-ready HTML", () => {
  const template = decodedBundledTemplate();

  assert.doesNotMatch(template, /<sc-/i, "designer conditional element leaked into bundle");
  assert.doesNotMatch(template, /{{/, "mustache binding leaked into bundle");
  assert.doesNotMatch(template, /href="#"/, "dead placeholder link leaked into bundle");
  assert.match(template, /style="[^"]*font-size:64px/, "expected inline hero styles");
  assert.match(template, /href="https:\/\/github\.com\/bbk1ng\/agent-orch#readme"/);
});

test("landing page privacy claim is not the inaccurate all-local one", () => {
  // Model inference is remote for the default (Claude/Codex/Copilot/Gemini)
  // config; only orch's orchestration is local. The old copy overclaimed.
  assert.ok(
    !html.includes("nothing leaves your machine"),
    "inaccurate 'nothing leaves your machine' privacy claim",
  );
  assert.ok(
    !html.includes("all on your machine"),
    "inaccurate 'all on your machine' meta description",
  );
  // The body copy overclaimed the same way the meta description did. The agents
  // (Claude/Codex/Copilot/Gemini) send code to remote model APIs, so orch's
  // compute is NOT wholly local — only its orchestration is. Guard the two
  // body phrasings that implied otherwise.
  assert.ok(
    !html.includes("No cloud execution"),
    "inaccurate 'No cloud execution' feature-card claim",
  );
  assert.ok(
    !html.includes("runs entirely on your machine"),
    "inaccurate 'runs entirely on your machine' hero claim",
  );
});
