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

// --- A1: modern hyphenated provider key shapes ---
// Anthropic and OpenAI keys embed hyphenated segments (sk-ant-api03-..., sk-proj-...)
// that the old /sk-[A-Za-z0-9]{20,}/ pattern could never match: any hyphen inside
// the run reset its 20-char alphanumeric count to zero.
test("detects a modern Anthropic sk-ant-api03- key", () => {
  const secret = "sk-ant-api03-" + "A".repeat(40) + "-" + "B".repeat(10);
  assert.equal(hasSecret(secret), true);
  assert.equal(hasSecret(redact(secret)), false);
});

test("detects a modern OpenAI sk-proj- key", () => {
  const secret = "sk-proj-" + "C".repeat(48);
  assert.equal(hasSecret(secret), true);
  assert.equal(hasSecret(redact(secret)), false);
});

test("redact scrubs a modern sk-ant-api03- key in surrounding prose", () => {
  const secret = "sk-ant-api03-" + "D".repeat(40) + "-" + "E".repeat(10);
  const out = redact(`export ANTHROPIC_API_KEY=${secret}`);
  assert.equal(out.includes(secret), false);
  assert.match(out, /^export ANTHROPIC_API_KEY=«redacted»$/);
});

test("clean prose with a short sk- fragment is not flagged", () => {
  // "sk-" followed by fewer than 10 key-shaped chars stays below the threshold.
  assert.equal(hasSecret("desk-jockey"), false);
  assert.equal(hasSecret("risk-averse"), false);
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
