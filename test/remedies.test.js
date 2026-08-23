// design §12: the lock scheme every remedy builds on (P6 split 1/4). No
// remedy executor exists yet (integration-repair.js lands in a later split),
// so this exercises the real primitives in src/lock.js directly — no
// stubbed git — against real lock files in real temp dirs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, releaseLock, LOCK_NAMES } from "../src/lock.js";

test("§12 lock order: acquiring a righthand lock while holding a lefthand one is legal", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-remedies-"));
  assert.equal(acquireLock(d, LOCK_NAMES.STANDING_PR), true);
  assert.equal(acquireLock(d, LOCK_NAMES.MERGE), true); // standing-pr.lock -> merge.lock: legal
  releaseLock(d, LOCK_NAMES.MERGE);
  releaseLock(d, LOCK_NAMES.STANDING_PR);
});

test("§12 lock order: acquiring a lefthand lock while holding a righthand one throws", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-remedies-"));
  assert.equal(acquireLock(d, LOCK_NAMES.MERGE), true);
  assert.throws(
    () => acquireLock(d, LOCK_NAMES.STANDING_PR),
    /lock order violation/,
    "merge.lock -> standing-pr.lock is the reverse of §12's order and must be rejected, not silently allowed",
  );
  releaseLock(d, LOCK_NAMES.MERGE);
});

test("integration-repair.lock: a losing peer's acquire returns false synchronously, not an acquireBlocking() promise", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-remedies-"));
  assert.equal(acquireLock(d, LOCK_NAMES.INTEGRATION_REPAIR), true); // winner
  const lostRace = acquireLock(d, LOCK_NAMES.INTEGRATION_REPAIR); // loser: plain acquireLock, not acquireBlocking
  assert.equal(lostRace, false); // a Promise (acquireBlocking's return) fails this equality, not just resolves falsy
  releaseLock(d, LOCK_NAMES.INTEGRATION_REPAIR);
});

test("§12 lock order: integration-repair.lock -> merge.lock is legal (the repair ff/push edge, 'not optional')", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-remedies-"));
  assert.equal(acquireLock(d, LOCK_NAMES.INTEGRATION_REPAIR), true);
  assert.equal(acquireLock(d, LOCK_NAMES.MERGE), true); // nested merge.lock while still holding integration-repair.lock
  releaseLock(d, LOCK_NAMES.MERGE);
  releaseLock(d, LOCK_NAMES.INTEGRATION_REPAIR);
});

test("§12 lock order: acquiring integration-repair.lock while holding merge.lock throws (reverse of the 'not optional' edge)", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-remedies-"));
  assert.equal(acquireLock(d, LOCK_NAMES.MERGE), true);
  assert.throws(
    () => acquireLock(d, LOCK_NAMES.INTEGRATION_REPAIR),
    /lock order violation/,
    "merge.lock -> integration-repair.lock reverses §12's order and must be rejected",
  );
  releaseLock(d, LOCK_NAMES.MERGE);
});

test("§12 lock order: holding merge.lock in one orchDir does not block a lock acquire in an unrelated orchDir", () => {
  const a = mkdtempSync(join(tmpdir(), "orch-remedies-a-"));
  const b = mkdtempSync(join(tmpdir(), "orch-remedies-b-"));
  assert.equal(acquireLock(a, LOCK_NAMES.MERGE), true); // held in orchDir a
  assert.doesNotThrow(() => acquireLock(b, LOCK_NAMES.CYCLE)); // unrelated orchDir — independent lock namespace
  releaseLock(b, LOCK_NAMES.CYCLE);
  releaseLock(a, LOCK_NAMES.MERGE);
});

test("§12 lock order: a refused release clears the order-tracking entry too, not just a successful one", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-remedies-"));
  const mergePath = join(d, LOCK_NAMES.MERGE);
  assert.equal(acquireLock(d, LOCK_NAMES.MERGE), true); // we believe we hold merge.lock (idx 3)
  writeFileSync(mergePath, String(process.pid + 1)); // simulate a steal: someone else now owns the file
  assert.equal(releaseLock(d, LOCK_NAMES.MERGE), false); // refused — not our pid
  // A stale idx-3 entry here would make this legitimate lower-order acquire
  // throw a spurious order violation even though we hold nothing.
  assert.doesNotThrow(() => acquireLock(d, LOCK_NAMES.STANDING_PR));
  releaseLock(d, LOCK_NAMES.STANDING_PR);
});

test("releaseLock ownership check: a cycle cannot release a lock it does not hold", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-remedies-"));
  const lockPath = join(d, LOCK_NAMES.INTEGRATION_REPAIR);
  const peerPid = String(process.pid + 1); // not us; staleness is irrelevant since we never call acquireLock here
  writeFileSync(lockPath, peerPid);
  assert.equal(releaseLock(d, LOCK_NAMES.INTEGRATION_REPAIR), false);
  // the peer's lock survives untouched — a losing peer that (incorrectly)
  // tried to release it must not clear the way for a second resolver.
  assert.equal(readFileSync(lockPath, "utf8"), peerPid);
});
