import { test } from "node:test";
import assert from "node:assert/strict";
import { renderTemplate, render } from "../src/prompts.js";

test("renderTemplate substitutes known vars", () => {
  assert.equal(renderTemplate("hi {{name}}", { name: "x" }), "hi x");
});

test("renderTemplate leaves unknown placeholders intact", () => {
  assert.equal(renderTemplate("{{a}} {{b}}", { a: "1" }), "1 {{b}}");
});

test("review template mentions the verdict contract and the branch var", () => {
  const out = render("review", { branch: "pr/claude/x" });
  assert.match(out, /AGREE/);
  assert.match(out, /DISAGREE/);
  assert.match(out, /pr\/claude\/x/);
});
