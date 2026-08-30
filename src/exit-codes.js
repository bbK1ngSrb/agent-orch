// Process exit codes for run outcomes. Keep this table as the single source
// of truth for every module that reports a run outcome to its caller.
export const EXIT_CODES = Object.freeze({
  OK: 0,
  ERROR: 1,
  ESCALATED: 2,
  THROTTLED: 3,
  WAIT_TIMEOUT: 4,
  ACTION_REQUIRED: 5,
  BLOCKED: 6,
});
