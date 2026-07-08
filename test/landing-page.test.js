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
});
