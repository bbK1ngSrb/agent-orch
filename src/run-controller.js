// Run controller (design docs/cli-v2-design.md §6): drives one cycle through
// CYCLING -> (LANDED -> READINESS) | CLASSIFYING -> a terminal state. Pure
// with respect to `record` (never mutated — callers decide how to persist the
// returned fields); all I/O goes through `deps`.
//
// Remedy executors are supplied by later slices. Until one is registered for a
// selected remedy, the controller terminates cleanly at STOPPED_AT_CAP (2).
import { chooseRemedy, fingerprint as computeFingerprint } from "./failure.js";
import { waitReady } from "./readiness.js";
import { EXIT_CODES } from "./exit-codes.js";

const STATE_EXIT = {
  READY: EXIT_CODES.OK,
  MERGED: EXIT_CODES.OK,
  ERROR: EXIT_CODES.ERROR,
  STOPPED_AT_CAP: EXIT_CODES.ESCALATED,
  BLOCKED: EXIT_CODES.BLOCKED,
  WAIT_TIMEOUT: EXIT_CODES.WAIT_TIMEOUT,
};
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
  REMOTE_UNKNOWN: "remote-unknown",
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
    exit: STATE_EXIT[state],
    ...(failureClass ? { failureClass } : {}),
    ...(state === "BLOCKED" ? { blockedReason: BLOCKED_REASON[failureClass] || null } : {}),
  };
}

function resolveFailure(failure, record, policy, decision = chooseRemedy(failure, record, policy)) {
  if (decision.decision === "terminal") return { ...terminal(decision.outcome, failure.class), failure };
  return { ...terminal("STOPPED_AT_CAP", failure.class), failure };
}

function withRecord(result, record, cycleResults) {
  return {
    ...result,
    attempt: record.attempt || 0,
    retries: { ...record.retries },
    failures: [...(record.failures || [])],
    ...(record.policy ? { policy: { ...record.policy } } : {}),
    ...(record.human ? { human: record.human } : {}),
    ...(record.excludedAgents ? { excludedAgents: [...record.excludedAgents] } : {}),
    ...(record.merge ? { merge: record.merge } : {}),
    ...(cycleResults?.length > 1 ? { cycleResults: [...cycleResults] } : {}),
  };
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

  if (decision.decision === "remedy" || decision.decision === "ask") {
    const remedy = decision.remedy || "ask";
    const executor = deps.remedies?.[remedy] || deps.remedy;
    if (typeof executor !== "function") {
      return { done: true, record, result: resolveFailure(failure, record, policy, decision) };
    }
    const nextRecord = {
      ...record,
      attempt: decision.consumesAttempt ? (record.attempt || 0) + 1 : record.attempt || 0,
      failures: [...(record.failures || []), {
        attempt: (record.attempt || 0) + (decision.consumesAttempt ? 1 : 0),
        class: failure.class,
        summary: failure.summary || failure.reason || null,
        fingerprint: failure.fingerprint,
        remedy,
      }],
    };
    // `ask` owns its bounded humanWaitHours poll; it is intentionally outside
    // the stage watchdog, and persists that deadline so `continue` is bounded
    // too (or starts a fresh bounded window after a timeout).
    const result = await executor({ name: remedy, failure, record: nextRecord, cycle: context.cycle, policy });
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
  const cycleResults = [cycle];
  let repinnedHead = null;
  let repinPending = false;
  // A remedy that changed nothing (integration-repair losing its lock to a
  // peer) hands the SAME cycle back so the loop re-polls readiness. Recording
  // it again would write one phantom cycle result per contention round into the
  // run record; only a genuinely fresh cycle is a new result.
  const pushCycle = (next) => {
    if (next === cycle) return;
    cycle = next;
    cycleResults.push(next);
    repinnedHead = null;
    repinPending = false;
  };
  for (let loop = 0; loop < MAX_REMEDY_LOOPS; loop += 1) {
    // "approved" (engine.js's noMerge path) is a success terminal exactly
    // like "merged"/"pr".
    const landed = cycle.status === "merged" || cycle.status === "pr" || cycle.status === "approved";

    if (!landed) {
      const failure = {
        class: cycle.class,
        fingerprint: cycle.fingerprint,
        ...(cycle.reason ? { summary: cycle.reason } : {}),
        ...(cycle.failedRole ? { failedRole: cycle.failedRole } : {}),
        ...(cycle.failedAgents ? { failedAgents: cycle.failedAgents } : {}),
        ...(cycle.meta ? { meta: cycle.meta } : {}),
      };
      const outcome = await handleFailure(failure, currentRecord, policy, deps, { cycle });
      if (outcome.done) return withRecord({ ...outcome.result, cycle }, outcome.record, cycleResults);
      currentRecord = outcome.record;
      if (outcome.cycle) pushCycle(outcome.cycle);
      continue;
    }

    let land = deps.resolveLanded(cycle);
    if (repinnedHead && land.landing === "standing") land = { ...land, expectedHead: repinnedHead };
    if (land.landing === "base") {
      return withRecord({
        state: policy.until === "merged" ? "MERGED" : "READY", outcome: "reached", exit: EXIT_CODES.OK,
        headSha: land.expectedHead, cycle, land,
      }, currentRecord, cycleResults);
    }
    if (land.remoteGate === false) {
      if (policy.until === "merged") {
        const failure = {
          class: "REMOTE_UNKNOWN",
          summary: "--until merged requires a git remote and the gh CLI to verify the merge",
          fingerprint: computeFingerprint("REMOTE_UNKNOWN", "--until merged requires a git remote and the gh CLI to verify the merge"),
        };
        return withRecord({ ...terminal("BLOCKED", failure.class), failure, cycle, land }, currentRecord, cycleResults);
      }
      return withRecord({
        // With no remote gate, a local landing is READY. `merged` is handled
        // above because it requires remote proof rather than a local success.
        state: "READY",
        outcome: "reached", exit: EXIT_CODES.OK,
        headSha: land.expectedHead, cycle, land,
      }, currentRecord, cycleResults);
    }
    if (!land.pr?.number) {
      // The land landed locally but orch could not find/open its PR.
      const failure = {
        class: "REMOTE_UNKNOWN",
        summary: "could not resolve a PR for the landed branch",
        fingerprint: computeFingerprint("REMOTE_UNKNOWN", "no PR found for the landed branch"),
      };
      const outcome = await handleFailure(failure, currentRecord, policy, deps, { cycle, land });
      if (outcome.done) return withRecord({ ...outcome.result, cycle, land }, outcome.record, cycleResults);
      currentRecord = outcome.record;
      if (outcome.cycle) pushCycle(outcome.cycle);
      continue;
    }

    const readiness = await waitReady(
      { pr: land.pr.number, expectedHead: land.expectedHead, landing: land.landing, cfg: policy },
      deps,
    );

    if (readiness.ready) {
      let headMovedRepins = currentRecord.headMovedRepins || 0;
      const alreadyChargedRepin = readiness.headMoved && repinPending;
      repinPending = false;
      if (readiness.headMoved && !alreadyChargedRepin) {
        headMovedRepins += 1;
        if (headMovedRepins > MAX_HEAD_REPINS) {
          const failure = { class: "REMOTE_UNKNOWN", fingerprint: computeFingerprint("REMOTE_UNKNOWN", "head-moved-repin-cap") };
          const outcome = await handleFailure(failure, currentRecord, policy, deps, { cycle, land });
          if (outcome.done) return withRecord({ ...outcome.result, cycle, land }, outcome.record, cycleResults);
          currentRecord = outcome.record;
          if (outcome.cycle) pushCycle(outcome.cycle);
          continue;
        }
      }
      currentRecord = { ...currentRecord, headMovedRepins };
      if (readiness.headMoved && readiness.headSha) repinnedHead = readiness.headSha;
      if (policy.until === "merged") {
        const mergeLand = {
          ...land,
          expectedHead: readiness.mergedBy === "external" ? land.expectedHead : readiness.headSha || land.expectedHead,
        };
        const mergeResult = typeof deps.mergeStanding === "function"
          ? await deps.mergeStanding({
            record: { ...currentRecord, expectedHead: mergeLand.expectedHead, pr: mergeLand.pr, landing: mergeLand.landing },
            cfg: policy,
            land: mergeLand,
            readiness,
          }, deps)
          : {
            result: "rejected",
            failure: { class: "REMOTE_MERGE_REJECTED", summary: "merge phase is unavailable" },
          };
        if (mergeResult.merge) currentRecord = { ...currentRecord, merge: mergeResult.merge };
        if (mergeResult.result === "head-moved" && mergeLand.landing === "standing") {
          headMovedRepins += 1;
          if (headMovedRepins > MAX_HEAD_REPINS) {
            const failure = { class: "REMOTE_UNKNOWN", fingerprint: computeFingerprint("REMOTE_UNKNOWN", "head-moved-repin-cap") };
            const outcome = await handleFailure(failure, currentRecord, policy, deps, { cycle, land: mergeLand });
            if (outcome.done) return withRecord({ ...outcome.result, cycle, land: mergeLand }, outcome.record, cycleResults);
            currentRecord = { ...outcome.record, headMovedRepins };
            if (outcome.cycle) pushCycle(outcome.cycle);
            continue;
          }
          repinnedHead = mergeResult.headSha || repinnedHead;
          repinPending = !mergeResult.headSha;
          currentRecord = { ...currentRecord, headMovedRepins };
          continue;
        }
        if (mergeResult.result === "merged") {
          return withRecord({
            state: "MERGED", outcome: "reached", exit: EXIT_CODES.OK,
            warnings: readiness.warnings || [], headSha: mergeResult.headSha || mergeLand.expectedHead,
            headMovedRepins, mergeCommit: mergeResult.mergeCommit,
            merge: mergeResult.merge, cycle, land: mergeLand,
          }, currentRecord, cycleResults);
        }
        const mergeFailure = mergeResult.failure || {
          class: "REMOTE_MERGE_REJECTED",
          summary: "merge phase did not complete",
        };
        const failure = {
          ...mergeFailure,
          fingerprint: mergeFailure.fingerprint || computeFingerprint(mergeFailure.class, mergeFailure.summary || ""),
        };
        const outcome = await handleFailure(failure, currentRecord, policy, deps, { cycle, land: mergeLand });
        if (outcome.done) return withRecord({ ...outcome.result, cycle, land: mergeLand }, outcome.record, cycleResults);
        currentRecord = outcome.record;
        if (outcome.cycle) pushCycle(outcome.cycle);
        continue;
      }
      return withRecord({
        state: "READY", outcome: "reached", exit: EXIT_CODES.OK,
        warnings: readiness.warnings || [], headSha: readiness.headSha, headMovedRepins,
        cycle, land,
      }, currentRecord, cycleResults);
    }

    const failure = {
      class: readiness.class,
      fingerprint: computeFingerprint(readiness.class, readiness.summary || ""),
      summary: readiness.summary,
    };
    const outcome = await handleFailure(failure, currentRecord, policy, deps, { cycle, land });
    if (outcome.done) return withRecord({ ...outcome.result, cycle, land }, outcome.record, cycleResults);
    currentRecord = outcome.record;
    if (outcome.cycle) pushCycle(outcome.cycle);
  }

  return withRecord({ ...terminal("STOPPED_AT_CAP", cycle.class), cycle }, currentRecord, cycleResults);
}
