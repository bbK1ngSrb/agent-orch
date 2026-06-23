import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNumstat } from "../src/scope.js";

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
