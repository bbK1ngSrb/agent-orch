// test/redact.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { hasSecret, redact, publicSummary } from "../src/redact.js";

test("detects a GitHub token shape", () => {
  assert.equal(hasSecret("token ghp_" + "A".repeat(36)), true);
});

test("detects a private key header", () => {
  assert.equal(hasSecret("-----BEGIN OPENSSH PRIVATE KEY-----"), true);
});

test("clean text has no secret", () => {
  assert.equal(hasSecret("all green, merged main"), false);
});

test("redact replaces the secret, keeps surrounding text", () => {
  const out = redact("here is ghp_" + "B".repeat(36) + " ok");
  assert.match(out, /^here is «redacted» ok$/);
  assert.equal(hasSecret(out), false);
});

test("publicSummary is a fixed template with only machine fields", () => {
  const s = publicSummary({ decision: "AGREE", green: true, branch: "pr/x", rounds: 2 });
  assert.match(s, /AGREE/);
  assert.match(s, /tests: green/);
  assert.match(s, /branch: pr\/x/);
  assert.match(s, /rounds: 2/);
});

test("publicSummary ignores any free-form prose passed in", () => {
  const s = publicSummary({
    decision: "DISAGREE",
    green: false,
    branch: "pr/x",
    rounds: 1,
    reason: "ghp_" + "C".repeat(36) + " leaked here",
  });
  assert.equal(hasSecret(s), false);
  assert.equal(s.includes("leaked"), false);
});
