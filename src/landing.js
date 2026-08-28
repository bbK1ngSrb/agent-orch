import { inspect } from "./readiness.js";
import {
  checksGreen,
  mergePrHeadBound,
  prView,
  requiredChecks,
} from "./github.js";
import { originRef } from "./git.js";
import * as lockDefault from "./lock.js";
import { LOCK_NAMES } from "./lock.js";

const READ_FIELDS = "number,state,isDraft,headRefOid,baseRefName,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,mergeCommit,url";

function failure(cls, summary, extra = {}) {
  return { class: cls, summary, ...extra };
}

function rejected(f, extra = {}) {
  return { result: "rejected", failure: f, ...extra };
}

function gitDeps(deps, repo) {
  return { ...deps, repo, git: deps.git };
}

function fetchRefs(deps, repo, base, integration) {
  const refs = [...new Set([integration, base].filter(Boolean))];
  deps.git.git(["fetch", "origin", ...refs], repo);
}

function gateTimeoutMs(cfg) {
  const minutes = cfg.gateTimeout ?? cfg.stageTimeout ?? 0;
  return Number(minutes) > 0 ? Number(minutes) * 60_000 : 0;
}

function mergeWithRequest(record, headSha, result, method) {
  const requests = [...(record.merge?.requests || [])];
  requests.push({
    ordinal: requests.length + 1,
    at: new Date().toISOString(),
    headSha,
    ...(method ? { method } : {}),
    result: result.result,
  });
  return { ...(record.merge || {}), requests };
}

function readinessFailure(readiness) {
  if (readiness?.class) return failure(readiness.class, readiness.summary || "remote readiness rejected");
  if (readiness?.required && !readiness.required.known) {
    return failure("REMOTE_REVIEW_REQUIRED", "required checks could not be determined");
  }
  return failure("REMOTE_UNKNOWN", readiness?.summary || "remote readiness is not settled");
}

function isHeadMoved(readiness, headSha) {
  return Boolean(readiness?.headMoved || (readiness?.headSha && readiness.headSha !== headSha));
}

function mergeFailure(result, headSha, record, method) {
  return {
    ...rejected(
      failure(
        result.result === "not-found" ? "REMOTE_PR_CLOSED"
          : result.status === 401 || result.status === 403 ? "REMOTE_AUTH"
            : "REMOTE_MERGE_REJECTED",
        result.message || `GitHub refused the merge (HTTP ${result.status ?? "?"})`,
      ),
    ),
    merge: mergeWithRequest(record, headSha, result, method),
  };
}

function verifyMerged({ pr, expectedHead, mergeSha, cfg, record, landing = "standing", paths = [], mergedBy = "orch" }, deps) {
  let view;
  try {
    view = prView(pr, ["state", "mergeCommit"], deps);
  } catch (e) {
    return rejected(failure("REMOTE_MERGE_REJECTED", `could not read merged PR state: ${e.message}`));
  }
  const mergeCommit = view.mergeCommit?.oid || mergeSha;
  if (view.state !== "MERGED" || !mergeCommit) {
    return rejected(failure("REMOTE_MERGE_REJECTED", "GitHub did not confirm a merge commit"));
  }

  const base = cfg.baseBranch || "main";
  try {
    deps.git.git(["fetch", "origin", base], deps.repo);
    deps.git.git(["merge-base", "--is-ancestor", mergeCommit, originRef(base)], deps.repo);
    if (landing === "pr") {
      // Squash/rebase merges mint a new commit, so the reviewed PR head is not
      // necessarily an ancestor. Its changed paths must still have the same
      // content on the base branch.
      deps.git.git(["diff", "--quiet", expectedHead, originRef(base), "--", ...paths], deps.repo);
    } else {
      deps.git.git(["merge-base", "--is-ancestor", expectedHead, originRef(base)], deps.repo);
    }
  } catch (e) {
    return rejected(failure(
      "REMOTE_MERGE_REJECTED",
      `merged PR is not an ancestor of origin/${base}: ${e.message}`,
    ));
  }

  if (typeof deps.git.syncMainFromOrigin === "function") {
    const synced = deps.git.syncMainFromOrigin(deps.repo, base);
    if (!synced?.ok) return rejected(failure("REMOTE_MERGE_REJECTED", synced?.reason || `could not fast-forward ${base}`));
  }

  const verifiedAt = new Date().toISOString();
  return {
    result: "merged",
    mergeCommit,
    headSha: expectedHead,
    mergedBy,
    verifiedAncestorAt: verifiedAt,
    merge: {
      ...(record.merge || {}),
      mergeCommit,
      mergedBy,
      verifiedAncestorAt: verifiedAt,
    },
  };
}

function rereadAfter405({ pr, expectedHead, cfg, record, landing, paths, required: cachedRequired }, deps) {
  let data;
  let required;
  try {
    data = prView(pr, READ_FIELDS, deps);
    required = cachedRequired || requiredChecks(data.baseRefName || cfg.baseBranch || "main", deps);
  } catch (e) {
    return rejected(failure("REMOTE_MERGE_REJECTED", `could not re-read PR after HTTP 405: ${e.message}`));
  }

  if (data.state === "MERGED") return verifyMerged({ pr, expectedHead, cfg, record, landing, paths, mergedBy: "external" }, deps);
  if (data.headRefOid && data.headRefOid !== expectedHead) {
    return { result: "head-moved", headSha: data.headRefOid };
  }
  if (data.state !== "OPEN" || data.isDraft) {
    return rejected(failure("REMOTE_PR_CLOSED", `pr #${pr} is ${data.isDraft ? "a draft" : String(data.state).toLowerCase()}`));
  }

  const checks = checksGreen(data.statusCheckRollup, required);
  if (!required.known || checks.state === "unknown") {
    return rejected(failure("REMOTE_REVIEW_REQUIRED", "required checks could not be determined"));
  }
  if (checks.state === "red") return rejected(failure("REMOTE_CI_RED", `failing checks: ${checks.failing.join(", ")}`));
  if (checks.state === "pending") return rejected(failure("REMOTE_UNKNOWN", "checks are still pending after HTTP 405"));
  if (data.reviewDecision === "REVIEW_REQUIRED" || (data.mergeStateStatus === "BLOCKED" && checks.state === "green")) {
    return rejected(failure("REMOTE_REVIEW_REQUIRED", "PR is ready to merge; approval is required"));
  }
  return rejected(failure("REMOTE_MERGE_REJECTED", "GitHub refused a ready merge"));
}

async function gateExactHead({ headSha, pr, cfg, record, landing, required }, deps) {
  const base = cfg.baseBranch || "main";
  const integration = cfg.integrationBranch || "orch/integration";
  const lock = deps.lock || lockDefault;
  if (!(await lock.acquireBlocking(deps.orchDir, LOCK_NAMES.MERGE))) {
    return rejected(failure("LAND_LOCK", "could not acquire merge.lock"));
  }

  let integrationPath;
  try {
    integrationPath = deps.git.ensureIntegrationWorktree(deps.repo, deps.orchDir, integration, base);
    if (landing === "standing") {
      deps.git.git(["fetch", "origin", integration], deps.repo);
      const integrationTip = deps.git.git(["rev-parse", originRef(integration)], deps.repo);
      if (integrationTip && integrationTip !== headSha) return { result: "head-moved", headSha: integrationTip };
    }
    deps.git.git(["checkout", "--detach", headSha], integrationPath);
    const actual = deps.git.git(["rev-parse", "HEAD"], integrationPath);
    if (actual !== headSha) return rejected(failure("REMOTE_UNKNOWN", `could not pin integration to ${headSha}`));

    const testCmd = cfg.test === "auto" ? deps.gate.detect(integrationPath) : cfg.test;
    if (!testCmd) return rejected(failure("TEST_MISSING", "no test gate detected"));
    if (!deps.gate.run(testCmd, integrationPath, gateTimeoutMs(cfg)).pass) {
      return rejected(failure("LAND_INTEGRATION_TEST", "integration gate failed"));
    }

    // The gate is valid only for the exact head it ran on. A peer push during
    // the gate invalidates it and sends the controller back through readiness.
    const reread = inspect(
      { pr, expectedHead: headSha, landing, cfg, ...(required ? { required } : {}) },
      gitDeps(deps, deps.repo),
    );
    if (!reread.ready) return rejected(readinessFailure(reread));
    if (isHeadMoved(reread, headSha)) return { result: "head-moved", headSha: reread.headSha };
    if (reread.required && !reread.required.known) {
      return rejected(failure("REMOTE_REVIEW_REQUIRED", "required checks could not be determined"));
    }
    return { result: "ready", headSha, record };
  } catch (e) {
    return rejected(failure("REMOTE_UNKNOWN", `could not gate integration at ${headSha}: ${e.message}`));
  } finally {
    if (integrationPath) {
      try { deps.git.git(["checkout", integration], integrationPath); } catch { /* lock release is still required */ }
    }
    lock.releaseLock(deps.orchDir, LOCK_NAMES.MERGE);
  }
}

async function mergePhase({ pr, expectedHead, landing, paths, cfg, record, readiness: priorReadiness }, deps) {
  const base = cfg.baseBranch || "main";
  const integration = cfg.integrationBranch || "orch/integration";
  let readiness;
  try {
    fetchRefs(deps, deps.repo, base, landing === "standing" ? integration : null);
    readiness = inspect(
      { pr, expectedHead, landing, cfg, ...(priorReadiness?.required ? { required: priorReadiness.required } : {}) },
      gitDeps(deps, deps.repo),
    );
  } catch (e) {
    return rejected(failure("REMOTE_UNKNOWN", `could not perform final readiness read: ${e.message}`));
  }
  if (!readiness.ready) return rejected(readinessFailure(readiness));
  if (readiness.required && !readiness.required.known) {
    return rejected(failure("REMOTE_REVIEW_REQUIRED", "required checks could not be determined"));
  }
  const headSha = readiness.headSha || expectedHead;
  if (isHeadMoved(readiness, expectedHead)) return { result: "head-moved", headSha };
  if (readiness.mergedBy === "external") return verifyMerged({ pr, expectedHead, cfg, record, landing, paths, mergedBy: "external" }, deps);

  const noRequiredChecks = readiness.required?.known && readiness.required.contexts.length === 0;
  if (noRequiredChecks) {
    const gated = await gateExactHead({ headSha, pr, cfg, record, landing, required: priorReadiness?.required }, deps);
    if (gated.result !== "ready") return gated;
  }

  const method = landing === "pr" ? (cfg.github?.mergeMethod || "squash") : "merge";
  deps.onMergeRequest?.({ pr: Number(pr) || pr, head: headSha, method });
  const result = mergePrHeadBound(String(pr), headSha, method, { gh: deps.gh });
  const merge = mergeWithRequest(record, headSha, result, method);
  if (result.result === "head-moved") {
    return { result: "head-moved", headSha: null, merge };
  }
  if (result.result === "merged") {
    const verified = verifyMerged({ pr, expectedHead: headSha, mergeSha: result.sha, cfg, record: { ...record, merge }, landing, paths }, deps);
    return { ...verified, merge: verified.merge || merge };
  }
  if (result.status === 405) {
    // The status-only follow-up is deliberately outside standing-pr.lock. A
    // 405 may be a review wait, and holding the merge lock while asking the
    // human would block another controller from observing a completed merge.
    return { result: "recheck-405", pr, expectedHead: headSha, landing, paths, cfg, record: { ...record, merge }, merge };
  }
  return mergeFailure(result, headSha, record, method);
}

// Merge a landed PR only after a fresh exact-head readiness read. The caller
// owns retry/ask policy; this function returns one bounded merge-phase result.
export async function mergeStanding({ record = {}, cfg = {}, land, readiness } = {}, deps = {}) {
  const base = cfg.baseBranch || "main";
  const integration = cfg.integrationBranch || "orch/integration";
  const pr = land?.pr?.number ?? record.pr?.number;
  const expectedHead = readiness?.mergedBy === "external"
    ? (land?.expectedHead || record.expectedHead || readiness.headSha)
    : (readiness?.headSha || land?.expectedHead || record.expectedHead);
  const landing = land?.landing || record.landing || cfg.landing || (cfg.merge === "pr" ? "pr" : integration === base ? "base" : "standing");
  const paths = land?.paths || record.paths || [];

  if (integration === base && landing === "base") return { result: "merged", headSha: expectedHead, mergedBy: "orch" };
  if (!pr || !expectedHead) return rejected(failure("REMOTE_UNKNOWN", "landed PR or exact head is missing"));
  if (!deps.repo || !deps.orchDir || !deps.git || !deps.gh) {
    return rejected(failure("REMOTE_UNKNOWN", "merge-phase dependencies are unavailable"));
  }

  const lock = deps.lock || lockDefault;
  const gateMinutes = cfg.gateTimeout ?? cfg.stageTimeout ?? 0;
  const timeoutMs = Number(gateMinutes) > 0 ? Number(gateMinutes) * 60_000 + 300_000 : 300_000;
  if (!(await lock.acquireBlocking(deps.orchDir, LOCK_NAMES.STANDING_PR, { timeoutMs }))) {
    return rejected(failure("LAND_LOCK", "could not acquire standing-pr.lock"));
  }
  let result;
  try {
    result = await mergePhase({ pr, expectedHead, landing, paths, cfg, record, readiness }, deps);
  } finally {
    lock.releaseLock(deps.orchDir, LOCK_NAMES.STANDING_PR);
  }
  if (result.result === "recheck-405") {
    const reread = rereadAfter405(result, deps);
    return { ...reread, merge: reread.merge || result.merge };
  }
  return result;
}
