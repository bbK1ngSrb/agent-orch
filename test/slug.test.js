import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify } from "../src/slug.js";

test("slugify collapses non-alnum runs to hyphens and drops case", () => {
  assert.equal(slugify("Fix the Bug! (again)"), "fix-the-bug-again");
});

test("slugify strips leading/trailing hyphens from the source text", () => {
  assert.equal(slugify("  --already hyphenated--  "), "already-hyphenated");
});

test("slugify falls back to 'task' when nothing alnum survives", () => {
  assert.equal(slugify("!!!"), "task");
});

test("slugify never leaves a trailing hyphen exposed by the 40-char cut", () => {
  // A hyphen that lands exactly at the 40-char boundary must not survive the
  // slice: strip-then-slice can expose a *new* trailing hyphen that the strip
  // already ran past, because slicing happens after stripping instead of
  // before it. 39 alnum chars + a separator puts a hyphen at index 39 (the
  // last character kept by slice(0, 40)).
  const text = "a".repeat(39) + " " + "bbb-more-words-here-padding";
  const result = slugify(text);
  assert.equal(result.length, 39);
  assert.equal(result, "a".repeat(39));
  assert.ok(!result.endsWith("-"), `slug ends with a hyphen: ${JSON.stringify(result)}`);
});
