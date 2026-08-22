import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReviewPromptReference, renderTemplate, render } from "../src/prompts.js";

test("renderTemplate substitutes known vars", () => {
  assert.equal(renderTemplate("hi {{name}}", { name: "x" }), "hi x");
});

test("renderTemplate leaves unknown placeholders intact", () => {
  assert.equal(renderTemplate("{{a}} {{b}}", { a: "1" }), "1 {{b}}");
});

test("review template mentions the verdict contract and the branch var", () => {
  const task = buildReviewPromptReference({ title: "requested change", problem: "fix it", repro_steps: [], suspected_paths: [], acceptance_criteria: [] });
  const out = render("review", { branch: "pr/claude/x", task, allowLargeScope: "NOT GRANTED" });
  assert.match(out, /AGREE/);
  assert.match(out, /DISAGREE/);
  assert.match(out, /pr\/claude\/x/);
  assert.match(out, /has not sanctioned that scope/);
  assert.match(out, /cannot waive this rule/);
  const referenceEnd = out.indexOf("END UNTRUSTED REFERENCE ");
  const trustedControl = out.indexOf("Trusted run control:");
  assert.ok(referenceEnd >= 0 && referenceEnd < trustedControl, "trusted sanction must follow the untrusted fence");
  assert.match(render("review", { branch: "pr/claude/x", task, allowLargeScope: "GRANTED by the operator" }), /GRANTED by the operator/);
  assert.match(out, /Compare the diff against the supplied work order\./);
});
