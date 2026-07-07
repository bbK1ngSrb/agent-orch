import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeRound, writeRoundRaw, buildDecisionBrief, reviewsDir, recordRun, kpi, escalate, phase } from "../src/notify.js";

test("phase writes a colored bullet + label + detail to the given stream when color is on", () => {
  const chunks = [];
  const fakeStream = { write: (s) => chunks.push(s) };
  phase("author", "claude authoring", null, fakeStream, true);
  assert.equal(chunks.length, 1);
  assert.match(chunks[0], /\x1b\[.*mauthor\x1b\[0m/);
  assert.match(chunks[0], /claude authoring/);
});

test("phase colors status ok green and fail red", () => {
  const chunks = [];
  const fakeStream = { write: (s) => chunks.push(s) };
  phase("gate", "npm test", "ok", fakeStream, true);
  phase("review", "DISAGREE", "fail", fakeStream, true);
  assert.match(chunks[0], /\x1b\[38;5;71m/);
  assert.match(chunks[1], /\x1b\[38;5;167m/);
});

test("phase emits plain text with no ANSI when color is off", () => {
  const chunks = [];
  const fakeStream = { write: (s) => chunks.push(s) };
  phase("worktree", "pr/claude/x (task)", null, fakeStream, false);
  assert.equal(chunks[0], "▸ worktree  pr/claude/x (task)\n");
});

test("writeRound creates nested round file", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-notify-"));
  const p = writeRound(d, "pr/claude/x", 2, "hello");
  // Path separator is platform-dependent (join() uses \ on Windows); match either.
  assert.match(p, /reviews[\\/]pr[\\/]claude[\\/]x[\\/]round-2\.md$/);
  assert.equal(readFileSync(p, "utf8"), "hello");
});

test("writeRoundRaw creates nested raw round file", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-notify-"));
  const p = writeRoundRaw(d, "pr/claude/x", 2, "raw hello");
  assert.match(p, /reviews[\\/]pr[\\/]claude[\\/]x[\\/]round-2-raw\.md$/);
  assert.equal(readFileSync(p, "utf8"), "raw hello");
});

test("reviewsDir keeps the path under .orch/reviews for normal branches", () => {
  const dir = reviewsDir("/orch", "pr/claude/x");
  assert.equal(dir, join("/orch", "reviews", "pr/claude/x"));
});

test("reviewsDir rejects traversal and absolute branch names", () => {
  for (const bad of ["../../etc", "a/../../b", "..", "/abs/path", "", "x\0y"]) {
    assert.throws(() => reviewsDir("/orch", bad), /unsafe branch name/);
  }
});

test("decision brief contains both cases and the branch", () => {
  const md = buildDecisionBrief({
    branch: "pr/claude/x",
    reviewerCase: "missing tests",
    authorCase: "tests exist elsewhere",
    diffSummary: "1 file, +10 -2",
    rounds: 3,
  });
  assert.match(md, /pr\/claude\/x/);
  assert.match(md, /missing tests/);
  assert.match(md, /tests exist elsewhere/);
  assert.match(md, /3 rounds/);
});

test("recordRun persists the clean unattended cycle streak", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-notify-"));
  recordRun(d, { ts: "1", branch: "b1", verdict: "merged", rounds: 1 });
  recordRun(d, { ts: "2", branch: "b2", verdict: "pr", rounds: 1 });
  assert.equal(kpi(d).cleanUnattendedCycles, 2);

  recordRun(d, { ts: "3", branch: "b3", verdict: "pr-fallback", rounds: 1 });
  assert.equal(kpi(d).cleanUnattendedCycles, 0);
});

test("escalate resets the clean unattended cycle streak", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-notify-"));
  recordRun(d, { ts: "1", branch: "b1", verdict: "merged", rounds: 1 });
  escalate(d, "pr/claude/x", "# Escalation\n");
  assert.equal(kpi(d).cleanUnattendedCycles, 0);
});

test("escalate writes plain markdown to DECISION.md but colorizes the stderr echo", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-notify-"));
  const chunks = [];
  const fakeStream = { write: (s) => chunks.push(s), isTTY: true };
  const brief = buildDecisionBrief({
    branch: "pr/codex/cache-invalidation",
    reviewerCase: "stampedes the DB",
    authorCase: "global flush is intentional",
    diffSummary: "2 files",
    rounds: 3,
  });
  const p = escalate(d, "pr/codex/cache-invalidation", brief, fakeStream);
  const onDisk = readFileSync(p, "utf8");
  assert.equal(onDisk, brief); // file stays exactly the plain brief, no ANSI
  assert.doesNotMatch(onDisk, /\x1b\[/);
  assert.match(chunks.join(""), /\x1b\[/); // stderr echo is colorized
  assert.match(chunks.join(""), /pr\/codex\/cache-invalidation/);
});
