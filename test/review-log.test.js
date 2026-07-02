import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { record, REVIEW_OUTCOMES_FILE } from "../src/review-log.js";

test("review outcomes are persisted as append-only JSONL", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-review-log-"));
  record(d, [
    { ts: "2026-07-03T00:00:00.000Z", branch: "pr/a/x", round: 1, reviewer: "codex", decision: "AGREE", defectLaterSurfaced: false },
    { ts: "2026-07-03T00:01:00.000Z", branch: "pr/a/x", round: 2, reviewer: "claude", decision: "DISAGREE", defectLaterSurfaced: true },
  ]);

  const rows = readFileSync(join(d, REVIEW_OUTCOMES_FILE), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(rows.map((row) => [row.reviewer, row.decision, row.defectLaterSurfaced]), [
    ["codex", "AGREE", false],
    ["claude", "DISAGREE", true],
  ]);
});
