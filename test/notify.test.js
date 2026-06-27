import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeRound, buildDecisionBrief, reviewsDir } from "../src/notify.js";

test("writeRound creates nested round file", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-notify-"));
  const p = writeRound(d, "pr/claude/x", 2, "hello");
  assert.match(p, /reviews\/pr\/claude\/x\/round-2\.md$/);
  assert.equal(readFileSync(p, "utf8"), "hello");
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
