// Run controller (design docs/cli-v2-design.md §6): drives one cycle through
// CYCLING -> (LANDED -> READINESS) | CLASSIFYING -> a terminal state. Pure
// with respect to `record` (never mutated — callers decide how to persist the
// returned fields); all I/O goes through `deps`.
//
// P5 ships no remedy executor: rebase/rotate/reauthor/ask/wait/integration-
// repair all land in P6/P7. `chooseRemedy` (failure.js, P3) is still called —
// its terminal-state logic (BLOCKED vs STOPPED_AT_CAP vs ERROR) is exactly
// what this slice needs — but any decision that ISN'T already terminal names
// a remedy this slice cannot carry out, so it collapses to STOPPED_AT_CAP (2)
// rather than hanging on a fix that doesn't exist yet.
import { chooseRemedy, fingerprint as computeFingerprint } from "./failure.js";
import { waitReady } from "./readiness.js";

const EXIT_FOR_STATE = { READY: 0, MERGED: 0, ERROR: 1, STOPPED_AT_CAP: 2, BLOCKED: 3, WAIT_TIMEOUT: 4 };
const OUTCOME_FOR_STATE = {
  READY: "reached", MERGED: "reached", ERROR: "error",
  STOPPED_AT_CAP: "stopped-at-cap", BLOCKED: "blocked", WAIT_TIMEOUT: "wait-timeout",
};
// design §13: the blockedReason values this remedy-less slice can actually
// produce (POLICY_PROTECTED_PATH/SECURITY_FINDING/HUMAN_ABANDON from a local
// cycle escalation; REMOTE_AUTH/REMOTE_MERGE_REJECTED from readiness).
// CONCURRENCY_CAP never reaches here — cli.js already exits 3 before a cycle starts.
const BLOCKED_REASON = {
  POLICY_PROTECTED_PATH: "guardrail-path",
  SECURITY_FINDING: "security-finding",
  CONCURRENCY_CAP: "concurrency-cap",
  HUMAN_ABANDON: "human-abandon",
  REMOTE_AUTH: "auth",
  REMOTE_MERGE_REJECTED: "merge-rejected",
};

const MAX_HEAD_REPINS = 3;

function terminal(state, failureClass) {
  return {
    state,
    outcome: OUTCOME_FOR_STATE[state],
    exit: EXIT_FOR_STATE[state],
    ...(failureClass ? { failureClass } : {}),
    ...(state === "BLOCKED" ? { blockedReason: BLOCKED_REASON[failureClass] || null } : {}),
  };
}

function resolveFailure(failure, record, policy) {
  const decision = chooseRemedy(failure, record, { ...policy, remedies: [] });
  if (decision.decision === "terminal") return { ...terminal(decision.outcome, failure.class), failure };
  return { ...terminal("STOPPED_AT_CAP", failure.class), failure };
}

// design §6 + §9. `record` is read-only (attempt/retries/failures/policy for
// chooseRemedy); `deps.runCycle()` runs (or, for a cycle the caller already
// ran, simply returns) this run's one cycle; `deps.resolveLanded(cycle)` maps
// a landed cycle result to `{ pr:{number,url}, expectedHead, landing, branch }`
// for the standing/per-cycle PR readiness is read against.
export async function runUntil(policy, record = {}, deps) {
  const cycle = await deps.runCycle();
  // "approved" (engine.js's noMerge path: agreed + green, no merge attempted
  // — set only by `runPr()`'s audit-only cycle, github.js:337) is a success
  // terminal exactly like "merged"/"pr" (engine.js:515) — omitting it here
  // meant any `runUntil` caller whose cycle lands as "approved" fell into
  // resolveFailure with an empty `failure.class`, and chooseRemedy rejected
  // that as an unknown failure class instead of reading readiness. NOTE: as
  // of this fix `orch review --until ready` cannot actually hit this branch
  // — `orch review`'s cli.js dispatch never sets `noMerge`, so it lands as
  // "merged"/"pr" like `orch task`, never "approved"; the only path that
  // produces "approved" (`orch pr`) doesn't call `runUntil` yet (#546). This
  // is a real internal-consistency fix, not a currently end-to-end-reachable
  // one — kept because the inconsistency with engine.js's own success list
  // is a landmine for whichever caller reaches it next.
  const landed = cycle.status === "merged" || cycle.status === "pr" || cycle.status === "approved";

  if (!landed) {
    const failure = { class: cycle.class, fingerprint: cycle.fingerprint };
    return { ...resolveFailure(failure, record, policy), cycle };
  }

  const land = deps.resolveLanded(cycle);
  if (!land.pr?.number) {
    // The land landed locally but orch could not find/open its PR (e.g. no
    // remote, or the PR bridge failed) — nothing to inspect readiness on.
    const failure = { class: "REMOTE_UNKNOWN", fingerprint: computeFingerprint("REMOTE_UNKNOWN", "no PR found for the landed branch") };
    return { ...resolveFailure(failure, record, policy), cycle, land };
  }
  const readiness = await waitReady(
    { pr: land.pr.number, expectedHead: land.expectedHead, landing: land.landing, cfg: policy },
    deps,
  );

  if (readiness.ready) {
    let headMovedRepins = record.headMovedRepins || 0;
    if (readiness.headMoved) {
      headMovedRepins += 1;
      if (headMovedRepins > MAX_HEAD_REPINS) {
        const failure = { class: "REMOTE_UNKNOWN", fingerprint: computeFingerprint("REMOTE_UNKNOWN", "head-moved-repin-cap") };
        return { ...resolveFailure(failure, record, policy), cycle, land };
      }
    }
    if (policy.until === "merged") {
      // design §10 (MERGING/VERIFYING) ships in P8 — P5 stops at readiness
      // rather than attempting the actual merge.
      return {
        state: "STOPPED_AT_CAP", outcome: "stopped-at-cap", exit: 2, note: "merge phase ships in P8",
        warnings: readiness.warnings || [], headSha: readiness.headSha, headMovedRepins,
        cycle, land,
      };
    }
    return {
      state: "READY", outcome: "reached", exit: 0,
      warnings: readiness.warnings || [], headSha: readiness.headSha, headMovedRepins,
      cycle, land,
    };
  }

  const failure = { class: readiness.class, fingerprint: computeFingerprint(readiness.class, readiness.summary || "") };
  return { ...resolveFailure(failure, record, policy), cycle, land };
}
