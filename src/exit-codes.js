// Process exit codes for run outcomes. Keep this table as the single source
// of truth for every module that reports a run outcome to its caller.
export const EXIT_CODES = Object.freeze({
  OK: 0,
  ERROR: 1,
  ESCALATED: 2,
  THROTTLED: 3,
  WAIT_TIMEOUT: 4,
  // 5 is deliberately reserved for ACTION_REQUIRED and emitted by nothing yet:
  // splitting it out needs the orch-pr.yml handler (#619) and a decision on what
  // a merge-deferred cycle reports, so it ships separately.
  BLOCKED: 6,
});
