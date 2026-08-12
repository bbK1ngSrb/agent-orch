import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, releaseLock, acquireBlocking, isPaused, sleepSync } from "../src/lock.js";

test("acquireLock is exclusive until released", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-lock-"));
  assert.equal(acquireLock(d), true);
  assert.equal(acquireLock(d), false); // already held — our own live PID
  releaseLock(d);
  assert.equal(acquireLock(d), true); // free again
  releaseLock(d);
});

test("acquireLock writes the owner PID", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-lock-"));
  acquireLock(d);
  assert.equal(readFileSync(join(d, "lock"), "utf8").trim(), String(process.pid));
  releaseLock(d);
});

test("a live owner is never reclaimed", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-lock-"));
  writeFileSync(join(d, "lock"), String(process.pid)); // us — alive
  assert.equal(acquireLock(d), false);
});

test("an empty lock (cycle died before writing PID) is reclaimed", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-lock-"));
  writeFileSync(join(d, "lock"), ""); // the actual incident: 0B lock
  assert.equal(acquireLock(d), true);
  assert.equal(readFileSync(join(d, "lock"), "utf8").trim(), String(process.pid));
  releaseLock(d);
});

test("a dead owner's lock is reclaimed", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-lock-"));
  writeFileSync(join(d, "lock"), "999999999"); // PID that cannot be running
  assert.equal(acquireLock(d), true);
  releaseLock(d);
  assert.equal(existsSync(join(d, "lock")), false);
});

test("isPaused reflects the pause file", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-pause-"));
  assert.equal(isPaused(d), false);
  writeFileSync(join(d, "pause"), "");
  assert.equal(isPaused(d), true);
});

test("a named lock is independent of the default lock", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-lock-"));
  assert.equal(acquireLock(d, "merge.lock"), true);
  assert.equal(acquireLock(d, "lock"), true); // different file, not blocked
  assert.equal(acquireLock(d, "merge.lock"), false); // same file, held
  releaseLock(d, "merge.lock");
  releaseLock(d, "lock");
  assert.equal(existsSync(join(d, "merge.lock")), false);
});

test("stale-lock atomic steal: dead-owner lock is stolen, reacquired with our pid, then returns false (live holder)", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-lock-"));
  writeFileSync(join(d, "lock"), "999999999"); // dead PID — stale lock
  // steal succeeds
  assert.equal(acquireLock(d), true);
  // winner's lock now holds our PID
  assert.equal(readFileSync(join(d, "lock"), "utf8").trim(), String(process.pid));
  // second acquire must return false — we're alive, not a stale entry
  assert.equal(acquireLock(d), false);
  releaseLock(d);
});

test("acquireBlocking returns true when free, false on timeout when held by a live owner", async () => {
  const d = mkdtempSync(join(tmpdir(), "orch-lock-"));
  assert.equal(await acquireBlocking(d, "merge.lock", { intervalMs: 5, timeoutMs: 100 }), true);
  // still held by us (live PID) → a second blocking acquire must time out, not hang
  assert.equal(await acquireBlocking(d, "merge.lock", { intervalMs: 5, timeoutMs: 50 }), false);
  releaseLock(d, "merge.lock");
});

test("acquireBlocking does not acquire after the deadline when a stall delays the retry", async () => {
  const d = mkdtempSync(join(tmpdir(), "orch-lock-"));
  assert.equal(await acquireBlocking(d, "merge.lock", { intervalMs: 5, timeoutMs: 20 }), true);
  // Stall the event loop well past the deadline, then free the lock: the pending
  // retry wakes up late and must refuse to take a lock it is no longer entitled to.
  setTimeout(() => { sleepSync(100); releaseLock(d, "merge.lock"); }, 1);
  assert.equal(await acquireBlocking(d, "merge.lock", { intervalMs: 5, timeoutMs: 20 }), false);
  assert.equal(existsSync(join(d, "merge.lock")), false); // timed-out waiter must not hold it
});

test("acquireBlocking leaves the event loop alive while it waits", async () => {
  const d = mkdtempSync(join(tmpdir(), "orch-lock-"));
  assert.equal(await acquireBlocking(d, "merge.lock", { intervalMs: 5, timeoutMs: 100 }), true);
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 5);
  // contended wait: a synchronous poll would starve the interval entirely
  assert.equal(await acquireBlocking(d, "merge.lock", { intervalMs: 5, timeoutMs: 100 }), false);
  clearInterval(timer);
  assert.ok(ticks > 0, `timer never fired during the wait (ticks=${ticks})`);
  releaseLock(d, "merge.lock");
});
