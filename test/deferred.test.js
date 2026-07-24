import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  record, list, read, remove, markAttempt, eligibleForRedrive, blockedByLand, MAX_REDRIVE_ATTEMPTS,
} from "../src/deferred.js";

test("record/list/remove roundtrip", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-def-"));
  record(d, {
    sid: "s1", branch: "pr/claude/a-1", paths: ["a.js"], testCmd: "npm test",
    peerSids: ["blocker"], rounds: 2, closes: 9,
  });
  const all = list(d);
  assert.equal(all.length, 1);
  assert.equal(all[0].sid, "s1");
  assert.equal(all[0].branch, "pr/claude/a-1");
  assert.deepEqual(all[0].paths, ["a.js"]);
  assert.deepEqual(all[0].peerSids, ["blocker"]);
  assert.equal(all[0].redriveAttempts, 0);
  assert.equal(all[0].closes, 9);
  remove(d, "s1");
  assert.equal(list(d).length, 0);
});

test("markAttempt increments and eligibleForRedrive respects MAX", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-def-"));
  record(d, { sid: "s1", branch: "b", paths: ["x"] });
  assert.equal(eligibleForRedrive(read(d, "s1")), true);
  markAttempt(d, "s1");
  assert.equal(read(d, "s1").redriveAttempts, 1);
  assert.equal(eligibleForRedrive(read(d, "s1")), MAX_REDRIVE_ATTEMPTS > 1);
  assert.equal(eligibleForRedrive(read(d, "s1"), { maxAttempts: 1 }), false);
});

test("blockedByLand matches peerSids or path intersection", () => {
  const entry = { sid: "b", paths: ["shared.js", "only-b.js"], peerSids: ["a"] };
  assert.equal(blockedByLand(entry, { sid: "a", paths: ["other.js"] }), true); // peerSids
  assert.equal(blockedByLand(entry, { sid: "c", paths: ["shared.js"] }), true); // path intersect
  assert.equal(blockedByLand(entry, { sid: "c", paths: ["zzz.js"] }), false);
  assert.equal(blockedByLand(entry, { sid: "b", paths: ["shared.js"] }), false); // self
});

test("record rejects unsafe sids", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-def-"));
  record(d, { sid: "../escape", branch: "b", paths: [] });
  record(d, { sid: "a/b", branch: "b", paths: [] });
  assert.equal(list(d).length, 0);
});
