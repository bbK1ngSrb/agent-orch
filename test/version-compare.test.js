import { test } from "node:test";
import assert from "node:assert/strict";
import { compareVersions } from "../src/version-compare.js";
import { compareVersions as updateCheckCompareVersions } from "../src/update-check.js";

test("compareVersions orders numeric version segments", () => {
  assert.equal(compareVersions("1.10.0", "1.2.0"), 1);
  assert.equal(compareVersions("1.0", "1.0.0"), 0);
  assert.equal(compareVersions("1.0.0", "1.0.1"), -1);
  assert.equal(compareVersions("1.0.0.1", "1.0.0"), 1);
});

test("update-check re-exports the shared version comparator", () => {
  assert.equal(updateCheckCompareVersions, compareVersions);
});
