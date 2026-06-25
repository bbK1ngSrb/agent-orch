import { existsSync, mkdirSync, openSync, closeSync, rmSync } from "node:fs";
import { join } from "node:path";

// Atomic lock via O_EXCL file creation — fails if the lock already exists.
export function acquireLock(orchDir) {
  mkdirSync(orchDir, { recursive: true });
  try {
    closeSync(openSync(join(orchDir, "lock"), "wx")); // wx = create, fail if exists
    return true;
  } catch (e) {
    if (e.code === "EEXIST") return false;
    throw e;
  }
}

// Release the cycle lock (idempotent — safe if it was never held).
export function releaseLock(orchDir) {
  rmSync(join(orchDir, "lock"), { force: true });
}

// Operator kill switch: a .orch/pause file blocks new cycles.
export function isPaused(orchDir) {
  return existsSync(join(orchDir, "pause"));
}
