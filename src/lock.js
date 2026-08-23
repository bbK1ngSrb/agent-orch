import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pidAlive } from "./pid.js";

// design §12: the one total lock-acquisition order. A lock may be taken while
// holding any lock to its left, never one to its right (never the reverse) —
// that's what makes the scheme deadlock-free when two cycles each take more
// than one. Referenced by name everywhere else so there is exactly one place
// that defines them (criterion: LOCK_NAMES must be real, not decorative).
export const LOCK_NAMES = {
  CYCLE: "lock",
  STANDING_PR: "standing-pr.lock",
  INTEGRATION_REPAIR: "integration-repair.lock",
  MERGE: "merge.lock",
};
const LOCK_ORDER = Object.values(LOCK_NAMES);

// Locks this process currently holds, keyed by full path (not just lockName)
// so two different orchDirs using the same lock filename — e.g. two repos, or
// two temp dirs in a test run — never get conflated. acquireLock can then
// refuse an out-of-order acquisition instead of silently allowing a
// deadlock-prone one.
const held = new Map(); // lockPath -> lockName

function assertOrder(lockName, lockPath) {
  const idx = LOCK_ORDER.indexOf(lockName);
  if (idx === -1) return; // not one of the ordered locks — nothing to enforce
  for (const [heldPath, heldName] of held) {
    if (heldPath === lockPath) continue;
    const heldIdx = LOCK_ORDER.indexOf(heldName);
    if (heldIdx > idx) {
      throw new Error(
        `lock order violation: cannot acquire "${lockName}" while holding "${heldName}" ` +
          `(§12 order: ${LOCK_ORDER.join(" -> ")})`,
      );
    }
  }
}

// Atomic lock via O_EXCL (flag "wx") — fails if the lock already exists. The
// lock holds the owner PID so a crashed cycle (dead PID, or an empty file from
// a death before the PID was written) can be reclaimed instead of wedging every
// future run behind a dead lock. Time-based staleness is unsafe here: a real
// cycle can run well past any timeout, so liveness is the only correct signal.
export function acquireLock(orchDir, lockName = "lock", retried = false) {
  const lockPath = join(orchDir, lockName);
  if (!retried) assertOrder(lockName, lockPath); // only on the outer call — steal recurses for the same acquisition
  mkdirSync(orchDir, { recursive: true });
  try {
    writeFileSync(lockPath, String(process.pid), { flag: "wx" });
    held.set(lockPath, lockName); // "wx" guarantees no prior successful acquire without a release between
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

// Ownership check (§12): a cycle must not release a lock it does not hold.
// Only the recorded owner PID may remove the file; missing/unreadable/foreign
// is a no-op rather than "unreadable means ours" — an orphaned garbage lock
// already self-heals via acquireLock's isStale steal path above, so treating
// it as ours here would just race that path instead of helping it.
export function releaseLock(orchDir, lockName = "lock") {
  const lockPath = join(orchDir, lockName);
  // We no longer hold this for ordering purposes the moment we try to give it
  // up, regardless of whether the pid check below finds it was ever ours —
  // otherwise a refused release (steal race: someone else now owns the file)
  // leaves a phantom entry that spuriously blocks a later, legitimate
  // acquisition of a lower-order lock.
  held.delete(lockPath);
  let pid;
  try {
    pid = parseInt(readFileSync(lockPath, "utf8").trim(), 10);
  } catch {
    return false;
  }
  if (pid !== process.pid) return false;
  rmSync(lockPath, { force: true });
  return true;
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
