import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Atomic lock via O_EXCL (flag "wx") — fails if the lock already exists. The
// lock holds the owner PID so a crashed cycle (dead PID, or an empty file from
// a death before the PID was written) can be reclaimed instead of wedging every
// future run behind a dead lock. Time-based staleness is unsafe here: a real
// cycle can run well past any timeout, so liveness is the only correct signal.
export function acquireLock(orchDir, retried = false) {
  mkdirSync(orchDir, { recursive: true });
  const lockPath = join(orchDir, "lock");
  try {
    writeFileSync(lockPath, String(process.pid), { flag: "wx" });
    return true;
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    if (!retried && isStale(lockPath)) {
      rmSync(lockPath, { force: true });
      return acquireLock(orchDir, true); // one shot — never recurse on a re-crash
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
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0); // signal 0 = liveness probe, kills nothing
    return false; // alive
  } catch (e) {
    return e.code === "ESRCH"; // ESRCH = no such process = stale; EPERM = alive
  }
}

export function releaseLock(orchDir) {
  rmSync(join(orchDir, "lock"), { force: true });
}

export function isPaused(orchDir) {
  return existsSync(join(orchDir, "pause"));
}
