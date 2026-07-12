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

test("keeps the reason when the reviewer ends WITH the verdict token", () => {
  // Reasoning-before-verdict: the reason precedes the token, nothing follows it.
  const v = parseVerdict("Tests are missing and scope is too wide.\nDISAGREE");
  assert.equal(v.decision, "DISAGREE");
  assert.match(v.reason, /Tests are missing/);
  assert.notEqual(v.reason, "(no reason given)");
});

test("prefers the after-token reason over before-token text", () => {
  const v = parseVerdict("preamble\nDISAGREE the real reason is here");
  assert.equal(v.reason, "the real reason is here");
});

test("missing verdict is a fail-safe DISAGREE", () => {
  const v = parseVerdict("no verdict here");
  assert.equal(v.decision, "DISAGREE");
  assert.equal(v.reason, "unparseable verdict");
});

test("ignores mid-prose DISAGREE after a line-leading AGREE", () => {
  // Reviewers often mention the AGREE/DISAGREE vocabulary while reasoning.
  // Those mentions must not override a real line-leading speech-act.
  const v = parseVerdict("AGREE looks good.\nMentions AGREE/DISAGREE enum later.");
  assert.equal(v.decision, "AGREE");
  assert.match(v.reason, /looks good/);
});

test("last line-leading token wins over earlier line-leading ones", () => {
  const v = parseVerdict("DISAGREE missing tests\nAGREE tests added now");
  assert.equal(v.decision, "AGREE");
  assert.match(v.reason, /tests added/);
});
