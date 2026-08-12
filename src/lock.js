import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pidAlive } from "./pid.js";

// Atomic lock via O_EXCL (flag "wx") — fails if the lock already exists. The
// lock holds the owner PID so a crashed cycle (dead PID, or an empty file from
// a death before the PID was written) can be reclaimed instead of wedging every
// future run behind a dead lock. Time-based staleness is unsafe here: a real
// cycle can run well past any timeout, so liveness is the only correct signal.
export function acquireLock(orchDir, lockName = "lock", retried = false) {
  mkdirSync(orchDir, { recursive: true });
  const lockPath = join(orchDir, lockName);
  try {
    writeFileSync(lockPath, String(process.pid), { flag: "wx" });
    return true;
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    if (!retried && isStale(lockPath)) {
      // Atomic steal: rename the stale lock to a private name. Exactly one racer
      // wins the rename; the rest get ENOENT (file already moved) and retry. Only
      // the winner removes the stolen file, then recreates via wx. rm-then-create
      // was a non-atomic CAS — two racers could each delete the other's fresh lock
      // and both acquire. (final-review C1)
      const steal = `${lockPath}.steal.${process.pid}`;
      try {
        renameSync(lockPath, steal);
      } catch (re) {
        if (re.code === "ENOENT") return acquireLock(orchDir, lockName, true); // lost the steal; one retry
        throw re;
      }
      rmSync(steal, { force: true });
      return acquireLock(orchDir, lockName, true); // won the steal; create fresh
    }
    return false;
  }
}

// Stale = the owner process is gone. Empty/garbage contents mean a cycle died
// before writing its PID — also stale.
function isStale(lockPath) {
  let pid;
  try {
    pid = parseInt(readFileSync(lockPath, "utf8").trim(), 10);
  } catch {
    return true; // unreadable
  }
  return !pidAlive(pid);
}

export function releaseLock(orchDir, lockName = "lock") {
  rmSync(join(orchDir, lockName), { force: true });
}

// Block until the named lock is acquired or the timeout elapses. Used for the
// merge-lock: finalize must serialize (wait its turn), not skip its merge.
// Async on purpose: the wait can run for minutes, and a synchronous poll would
// freeze the whole event loop (signals, timers) for that entire span.
export async function acquireBlocking(orchDir, lockName = "lock", { intervalMs = 200, timeoutMs = 300000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (acquireLock(orchDir, lockName)) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise((r) => setTimeout(r, Math.min(intervalMs, remaining)));
    // A late timer or an event-loop stall can wake us past the deadline. Re-check
    // before retrying: acquiring after timeoutMs would break the caller's timeout.
    if (Date.now() >= deadline) return false;
  }
}

// Synchronous sleep with no busy-spin and no dependencies.
export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function isPaused(orchDir) {
  return existsSync(join(orchDir, "pause"));
}
