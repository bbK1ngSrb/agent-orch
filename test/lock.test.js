import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, releaseLock, isPaused } from "../src/lock.js";

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
