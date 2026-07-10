import { test } from "node:test";
import assert from "node:assert/strict";
import { filterHistory } from "../../src/tui/filter.js";

const ROWS = [
  { branch: "pr/done", verdict: "merged", sid: "sid-done" },
  { branch: "pr/needs-work", verdict: "escalated", sid: "sid-work" },
  { branch: "pr/review", verdict: "pr", sid: "sid-rev" },
];

test("empty or whitespace query returns all rows (identity)", () => {
  assert.equal(filterHistory(ROWS, ""), ROWS);
  assert.equal(filterHistory(ROWS, "   "), ROWS);
});

test("filters by branch, verdict, and sid substring, case-insensitively", () => {
  assert.deepEqual(filterHistory(ROWS, "needs"), [ROWS[1]]);
  assert.deepEqual(filterHistory(ROWS, "MERGED"), [ROWS[0]]);
  assert.deepEqual(filterHistory(ROWS, "sid-rev"), [ROWS[2]]);
  assert.deepEqual(filterHistory(ROWS, "pr/"), ROWS); // branch prefix matches all
});

test("no match yields an empty set", () => {
  assert.deepEqual(filterHistory(ROWS, "nonesuch"), []);
});

test("tolerates non-array rows and missing fields", () => {
  assert.deepEqual(filterHistory(null, "x"), []);
  assert.deepEqual(filterHistory([{}, { branch: "keep" }], "keep"), [{ branch: "keep" }]);
});
