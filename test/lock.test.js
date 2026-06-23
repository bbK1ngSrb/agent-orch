import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, releaseLock, isPaused } from "../src/lock.js";

test("acquireLock is exclusive until released", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-lock-"));
  assert.equal(acquireLock(d), true);
  assert.equal(acquireLock(d), false); // already held
  releaseLock(d);
  assert.equal(acquireLock(d), true); // free again
  releaseLock(d);
});

test("isPaused reflects the pause file", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-pause-"));
  assert.equal(isPaused(d), false);
  writeFileSync(join(d, "pause"), "");
  assert.equal(isPaused(d), true);
});
