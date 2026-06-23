import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVerdict } from "../src/verdict.js";

test("parses trailing AGREE with reason", () => {
  const v = parseVerdict("Looks fine.\nAGREE the change is correct.");
  assert.equal(v.decision, "AGREE");
  assert.equal(v.reason, "the change is correct.");
});

test("parses DISAGREE and does not confuse it with AGREE substring", () => {
  const v = parseVerdict("I DISAGREE because tests are missing.");
  assert.equal(v.decision, "DISAGREE");
  assert.match(v.reason, /tests are missing/);
});

test("uses the LAST verdict token when several appear", () => {
  const v = parseVerdict("First I thought DISAGREE but on review AGREE done.");
  assert.equal(v.decision, "AGREE");
});

test("missing verdict is a fail-safe DISAGREE", () => {
  const v = parseVerdict("no verdict here");
  assert.equal(v.decision, "DISAGREE");
  assert.equal(v.reason, "unparseable verdict");
});
