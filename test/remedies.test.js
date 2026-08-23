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

test("integration-repair.lock: a losing peer's acquire returns false immediately, not after a blocking wait", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-remedies-"));
  assert.equal(acquireLock(d, LOCK_NAMES.INTEGRATION_REPAIR), true); // winner
  const start = Date.now();
  const lostRace = acquireLock(d, LOCK_NAMES.INTEGRATION_REPAIR); // loser: must not block
  const elapsed = Date.now() - start;
  assert.equal(lostRace, false);
  assert.ok(elapsed < 1000, `loser blocked for ${elapsed}ms — integration-repair.lock must be non-blocking, not acquireBlocking's 300s default`);
  releaseLock(d, LOCK_NAMES.INTEGRATION_REPAIR);
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
