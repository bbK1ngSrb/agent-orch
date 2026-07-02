import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as checkpoint from "../src/checkpoint.js";

function freshDir() {
  return join(mkdtempSync(join(tmpdir(), "orch-checkpoint-")), ".orch");
}

test("lookup returns null before any record exists", () => {
  const d = freshDir();
  assert.equal(checkpoint.lookup(d, "sid-1"), null);
});

test("record then lookup round-trips the checkpoint", () => {
  const d = freshDir();
  checkpoint.record(d, "sid-1", { branch: "b", round: 2, stage: "reviewed", decision: "DISAGREE", reason: "fix x" });
  const got = checkpoint.lookup(d, "sid-1");
  assert.equal(got.branch, "b");
  assert.equal(got.round, 2);
  assert.equal(got.stage, "reviewed");
  assert.equal(got.decision, "DISAGREE");
  assert.equal(got.reason, "fix x");
});

test("record overwrites the prior checkpoint for the same sid", () => {
  const d = freshDir();
  checkpoint.record(d, "sid-1", { branch: "b", round: 1, stage: "reviewed", decision: "DISAGREE" });
  checkpoint.record(d, "sid-1", { branch: "b", round: 1, stage: "tested" });
  assert.equal(checkpoint.lookup(d, "sid-1").stage, "tested");
});

test("checkpoints are isolated per sid", () => {
  const d = freshDir();
  checkpoint.record(d, "sid-1", { branch: "a", round: 1, stage: "tested" });
  checkpoint.record(d, "sid-2", { branch: "b", round: 3, stage: "reviewed", decision: "AGREE" });
  assert.equal(checkpoint.lookup(d, "sid-1").branch, "a");
  assert.equal(checkpoint.lookup(d, "sid-2").branch, "b");
});

test("clear removes the record", () => {
  const d = freshDir();
  checkpoint.record(d, "sid-1", { branch: "b", round: 1, stage: "tested" });
  checkpoint.clear(d, "sid-1");
  assert.equal(checkpoint.lookup(d, "sid-1"), null);
  checkpoint.clear(d, "sid-1"); // idempotent — no throw on missing
});
