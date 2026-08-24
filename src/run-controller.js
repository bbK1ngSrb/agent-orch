// Run controller (design docs/cli-v2-design.md §6): drives one cycle through
// CYCLING -> (LANDED -> READINESS) | CLASSIFYING -> a terminal state. Pure
// with respect to `record` (never mutated — callers decide how to persist the
// returned fields); all I/O goes through `deps`.
//
// Remedy executors are supplied by later slices. Until one is registered for a
// selected remedy, the controller terminates cleanly at STOPPED_AT_CAP (2).
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
const MAX_REMEDY_LOOPS = 32;

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function terminal(state, failureClass) {
  return {
    state,
    outcome: OUTCOME_FOR_STATE[state],
    exit: EXIT_FOR_STATE[state],
    ...(failureClass ? { failureClass } : {}),
    ...(state === "BLOCKED" ? { blockedReason: BLOCKED_REASON[failureClass] || null } : {}),
  };
}

function resolveFailure(failure, record, policy, decision = chooseRemedy(failure, record, policy)) {
  if (decision.decision === "terminal") return { ...terminal(decision.outcome, failure.class), failure };
  return { ...terminal("STOPPED_AT_CAP", failure.class), failure };
}

function withRecord(result, record) {
  return { ...result, attempt: record.attempt || 0, retries: { ...record.retries } };
}

async function handleFailure(failure, record, policy, deps, context) {
  const decision = chooseRemedy(failure, record, policy);

  if (decision.decision === "terminal") {
    return { done: true, record, result: resolveFailure(failure, record, policy, decision) };
  }

  if (decision.decision === "free-retry") {
    if (decision.backoffSeconds) await (deps.sleep || defaultSleep)(decision.backoffSeconds * 1000);
    const key = decision.key || failure.class;
    const retries = { ...record.retries, [key]: (record.retries[key] || 0) + 1 };
    const nextRecord = { ...record, retries };
    if (context.land) return { done: false, record: nextRecord };
    return { done: false, record: nextRecord, cycle: await deps.runCycle({ fresh: true }) };
  }

  if (decision.decision === "remedy") {
    const nextRecord = {
      ...record,
      attempt: decision.consumesAttempt ? (record.attempt || 0) + 1 : record.attempt || 0,
      failures: [...(record.failures || []), { fingerprint: failure.fingerprint, remedy: decision.remedy }],
    };
    const executor = deps.remedies?.[decision.remedy] || deps.remedy;
    if (typeof executor !== "function") {
      return { done: true, record: nextRecord, result: resolveFailure(failure, nextRecord, policy, decision) };
    }
    const result = await executor({ name: decision.remedy, failure, record: nextRecord, cycle: context.cycle, policy });
    if (!result?.cycle) {
      return { done: true, record: result?.record || nextRecord, result: result?.result || resolveFailure(failure, nextRecord, policy, decision) };
    }
    return { done: false, record: result.record || nextRecord, cycle: result.cycle };
  }

  return { done: true, record, result: resolveFailure(failure, record, policy, decision) };
}

// design §6 + §9. `record` is read-only (attempt/retries/failures/policy for
// chooseRemedy); `deps.runCycle()` runs (or, for a cycle the caller already
// ran, simply returns) this run's one cycle; `deps.resolveLanded(cycle)` maps
// a landed cycle result to `{ pr:{number,url}, expectedHead, landing, branch }`
// for the standing/per-cycle PR readiness is read against.
export async function runUntil(policy, record = {}, deps) {
  let currentRecord = {
    ...record,
    attempt: record.attempt || 0,
    retries: { ...(record.retries || {}) },
    failures: [...(record.failures || [])],
  };
  let cycle = await deps.runCycle();

  for (let loop = 0; loop < MAX_REMEDY_LOOPS; loop += 1) {
    // "approved" (engine.js's noMerge path) is a success terminal exactly
    // like "merged"/"pr".
    const landed = cycle.status === "merged" || cycle.status === "pr" || cycle.status === "approved";

    if (!landed) {
      const failure = { class: cycle.class, fingerprint: cycle.fingerprint };
      const outcome = await handleFailure(failure, currentRecord, policy, deps, { cycle });
      if (outcome.done) return withRecord({ ...outcome.result, cycle }, outcome.record);
      currentRecord = outcome.record;
      if (outcome.cycle) cycle = outcome.cycle;
      continue;
    }

    const land = deps.resolveLanded(cycle);
    if (!land.pr?.number) {
      // The land landed locally but orch could not find/open its PR.
      const failure = { class: "REMOTE_UNKNOWN", fingerprint: computeFingerprint("REMOTE_UNKNOWN", "no PR found for the landed branch") };
      const outcome = await handleFailure(failure, currentRecord, policy, deps, { cycle });
      if (outcome.done) return withRecord({ ...outcome.result, cycle, land }, outcome.record);
      currentRecord = outcome.record;
      if (outcome.cycle) cycle = outcome.cycle;
      continue;
    }

    const readiness = await waitReady(
      { pr: land.pr.number, expectedHead: land.expectedHead, landing: land.landing, cfg: policy },
      deps,
    );

    if (readiness.ready) {
      let headMovedRepins = currentRecord.headMovedRepins || 0;
      if (readiness.headMoved) {
        headMovedRepins += 1;
        if (headMovedRepins > MAX_HEAD_REPINS) {
          const failure = { class: "REMOTE_UNKNOWN", fingerprint: computeFingerprint("REMOTE_UNKNOWN", "head-moved-repin-cap") };
          const outcome = await handleFailure(failure, currentRecord, policy, deps, { cycle, land });
          if (outcome.done) return withRecord({ ...outcome.result, cycle, land }, outcome.record);
          currentRecord = outcome.record;
          if (outcome.cycle) cycle = outcome.cycle;
          continue;
        }
      }
      currentRecord = { ...currentRecord, headMovedRepins };
      if (policy.until === "merged") {
        return withRecord({
          state: "STOPPED_AT_CAP", outcome: "stopped-at-cap", exit: 2, note: "merge phase ships in P8",
          warnings: readiness.warnings || [], headSha: readiness.headSha, headMovedRepins,
          cycle, land,
        }, currentRecord);
      }
      return withRecord({
        state: "READY", outcome: "reached", exit: 0,
        warnings: readiness.warnings || [], headSha: readiness.headSha, headMovedRepins,
        cycle, land,
      }, currentRecord);
    }

    const failure = { class: readiness.class, fingerprint: computeFingerprint(readiness.class, readiness.summary || "") };
    const outcome = await handleFailure(failure, currentRecord, policy, deps, { cycle, land });
    if (outcome.done) return withRecord({ ...outcome.result, cycle, land }, outcome.record);
    currentRecord = outcome.record;
    if (outcome.cycle) cycle = outcome.cycle;
  }

  return withRecord({ ...terminal("STOPPED_AT_CAP", cycle.class), cycle }, currentRecord);
}
