// Single source of truth for process-liveness probes. Three subsystems (task
// worktree reclaim in git.js, the concurrency cap in inflight.js, the repo
// lock in lock.js) all ask "is this PID alive?" — they must agree, or one
// subsystem reclaims state another still considers owned.
export function pidAlive(pid) {
  // Signal 0 probes without killing. On POSIX, pid 0 / negative pids signal
  // whole process groups — never a valid "is this one process alive" query.
  if (!Number.isInteger(pid) || pid <= 0) return false;
  // process.kill(pid, 0) either succeeds (process exists, we can signal it)
  // or throws. EPERM means the process exists but we lack permission — still
  // alive. Any other code (ESRCH, or Windows' error for an out-of-range/bogus
  // pid) means dead: treating unrecognized errors as "alive" left huge test
  // pids (e.g. 999999999) wrongly protected from reclaim on Windows.
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}
