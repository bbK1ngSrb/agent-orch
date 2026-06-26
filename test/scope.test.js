import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNumstat, isDocsOnly } from "../src/scope.js";

const DOCS = ["*.md", "docs/**", "**/*.md"];

test("isDocsOnly: all docs paths -> true", () => {
  assert.equal(isDocsOnly(["README.md", "docs/x.md", "src/nested/y.md"], DOCS), true);
});

test("isDocsOnly: any non-docs path -> false", () => {
  assert.equal(isDocsOnly(["README.md", "src/a.js"], DOCS), false);
});

test("isDocsOnly: empty list -> false", () => {
  assert.equal(isDocsOnly([], DOCS), false);
});

const NUMSTAT = [
  "10\t5\tsrc/a.js",
  "3\t0\tpkg.lock",
  "-\t-\tbin/blob.png",   // binary -> skipped
  "2\t2\tdist/bundle.js",
].join("\n");

test("sums added+deleted, ignores binary", () => {
  assert.equal(parseNumstat(NUMSTAT, []), 10 + 5 + 3 + 0 + 2 + 2);
});

test("honors ignore globs including ** ", () => {
  assert.equal(parseNumstat(NUMSTAT, ["*.lock", "dist/**"]), 15);
});
