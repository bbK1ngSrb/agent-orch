import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeRound, writeRoundRaw, buildDecisionBrief, reviewsDir, recordRun, kpi, escalate } from "../src/notify.js";

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
  assert.match(p, /reviews\/pr\/claude\/x\/round-2-raw\.md$/);
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
