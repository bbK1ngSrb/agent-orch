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

test("publicSummary constrains fallback field values", () => {
  const s = publicSummary({ decision: "MAYBE", green: 0, branch: "pr/x", rounds: "bad" });
  assert.equal(s, [
    "orch verdict: DISAGREE",
    "tests: red",
    "branch: pr/x",
    "rounds: 0",
    "Full reviewer notes were sent to the maintainer's private channel.",
  ].join("\n"));
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

// --- FIX 5: additional secret pattern coverage ---
test("detects a github_pat_ fine-grained PAT", () => {
  const secret = "github_pat_" + "A".repeat(20);
  assert.equal(hasSecret(secret), true);
  assert.equal(hasSecret(redact(secret)), false);
});

test("detects an sk- prefixed provider key", () => {
  const secret = "sk-" + "A".repeat(20);
  assert.equal(hasSecret(secret), true);
  assert.equal(hasSecret(redact(secret)), false);
});

test("detects an AKIA AWS access key id", () => {
  const secret = "AKIA" + "0123456789ABCDEF";
  assert.equal(hasSecret(secret), true);
  assert.equal(hasSecret(redact(secret)), false);
});

test("detects a JWT token", () => {
  const secret =
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VySWQifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
  assert.equal(hasSecret(secret), true);
  assert.equal(hasSecret(redact(secret)), false);
});

// --- FIX 6: branch sanitization ---
test("publicSummary strips unsafe chars from branch", () => {
  const s = publicSummary({
    decision: "AGREE",
    green: true,
    branch: "pr/x $() \nevil",
    rounds: 1,
  });
  const branchLine = s.split("\n").find((l) => l.startsWith("branch:"));
  assert.equal(branchLine, "branch: pr/xevil");
});
