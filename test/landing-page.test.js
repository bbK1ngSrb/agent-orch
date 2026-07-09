import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// docs/index.html is intentionally plain static HTML. Earlier generated
// one-file bundles depended on runtime unpacking and custom-element scripts,
// which could fail in browsers and leave a text-only page.
const html = readFileSync(
  fileURLToPath(new URL("../docs/index.html", import.meta.url)),
  "utf8",
);

test("landing page has no unbaked designer-template constructs", () => {
  assert.ok(!html.includes("{{"), "leftover {{ mustache }} binding");
  assert.ok(!html.includes("<sc-"), "leftover <sc-*> template element");
  assert.ok(!html.includes("hint-"), "leftover design-tool hint-* attribute");
});

test("landing page has no dead placeholder links", () => {
  // href="#" navigates to the top of the same page instead of anywhere useful.
  assert.doesNotMatch(html, /\bhref=(["'])#\1/, 'dead href="#" placeholder link');
});

test("landing page does not depend on generated runtime unpacking", () => {
  assert.doesNotMatch(html, /__bundler/i);
  assert.doesNotMatch(html, /DecompressionStream/);
  assert.doesNotMatch(html, /text\/babel/);
  assert.doesNotMatch(html, /<x-dc/i);
  assert.match(html, /<h1>Two agents\./);
  assert.match(html, /href="https:\/\/github\.com\/bbk1ng\/agent-orch#readme"/);
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
