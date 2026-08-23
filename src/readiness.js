// Remote readiness inspector (design docs/cli-v2-design.md §9): one read of a
// PR (`inspect`) plus a bounded poll loop around it (`waitReady`). Read-only —
// no merge is ever attempted here (that ships in P8). This rule 4 (required
// checks) predicate is deliberately independent of today's github.js
// `prChecksGreen`: that helper backs `orch pr --merge`'s direct-merge path and
// is left untouched by this slice (see the P5 commit message).
import { prView, requiredChecks } from "./github.js";

// CheckRun (GitHub Actions et al — `status`+`conclusion`) vs StatusContext (the
// legacy commit-status API — `state`). Mirrors github.js's own PASSING_CONCLUSIONS.
const PASSING_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

function checkTerminalGreen(entry) {
  if (entry.status) return entry.status === "COMPLETED" && PASSING_CONCLUSIONS.has(entry.conclusion);
  if (entry.state) return entry.state === "SUCCESS";
  return false;
}
function checkPending(entry) {
  if (entry.status) return entry.status !== "COMPLETED";
  if (entry.state) return entry.state === "PENDING" || entry.state === "EXPECTED";
  return false;
}
function contextOf(entry) {
  return entry.context || entry.name;
}

// design §9 rule 4. `required.known === false` (a 403 on both required-checks
// reads) can never be resolved by waiting, so it reports "unknown" rather than
// "pending" — the caller decides what unknown means for its `until` mode.
function checksGreen(rollup, required) {
  const list = rollup || [];
  if (!required.known) return { state: "unknown" };
  const requiredSet = new Set(required.contexts);
  if (list.length === 0) return { state: requiredSet.size === 0 ? "green" : "pending" };
  for (const ctx of requiredSet) {
    if (!list.some((e) => contextOf(e) === ctx)) return { state: "pending" };
  }
  const failing = list.filter((e) => !checkTerminalGreen(e) && !checkPending(e)).map(contextOf);
  if (failing.length) return { state: "red", failing };
  if (list.some(checkPending)) return { state: "pending" };
  return { state: "green" };
}

function safeRevParse(deps, ref) {
  try { return deps.git.git(["rev-parse", ref], deps.repo); } catch { return null; }
}
function isAncestor(deps, ancestor, descendant) {
  try { deps.git.git(["merge-base", "--is-ancestor", ancestor, descendant], deps.repo); return true; }
  catch { return false; }
}

// One read → a ready Readiness object or a definite Failure ({class, summary}).
// `pending: true` (no `class`) means "keep polling" — only `waitReady` acts on it.
// `required` (optional): a `requiredChecks()` result the caller already fetched
// this run ("read the required checks once per run", design §9 rule 4) — when
// omitted, `inspect` fetches it itself so it stays usable standalone (tests).
export function inspect({ pr, expectedHead, landing, cfg = {}, required } = {}, deps) {
  const data = prView(
    pr,
    "number,state,isDraft,headRefOid,baseRefName,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,url",
    deps,
  );

  if (data.state === "MERGED") {
    const base = `origin/${cfg.baseBranch || "main"}`;
    if (isAncestor(deps, expectedHead, base)) {
      return { ready: true, headSha: data.headRefOid, mergedBy: "external", warnings: [] };
    }
    return { ready: false, class: "REMOTE_PR_CLOSED", summary: "PR was merged, but our commit is not reachable from base" };
  }
  if (data.state !== "OPEN" || data.isDraft) {
    return { ready: false, class: "REMOTE_PR_CLOSED", summary: `pr #${pr} is ${data.isDraft ? "a draft" : String(data.state).toLowerCase()}` };
  }

  // rule 2: normally the PR head must be exactly the head we landed. The one
  // exception (standing PR only) is another cycle landing after us and
  // re-tipping the branch while it still carries our commit — re-pin instead
  // of failing. Anything else with a moved head fails closed.
  let headMoved = false;
  if (data.headRefOid !== expectedHead) {
    const integrationTip = safeRevParse(deps, `origin/${cfg.integrationBranch || "orch/integration"}`);
    const repinnable = landing === "standing"
      && isAncestor(deps, expectedHead, data.headRefOid)
      && data.headRefOid === integrationTip;
    if (!repinnable) {
      return { ready: false, class: "REMOTE_UNKNOWN", summary: `head moved: expected ${expectedHead}, found ${data.headRefOid}` };
    }
    headMoved = true;
  }

  if (data.mergeStateStatus === "BEHIND") {
    return { ready: false, class: "REMOTE_BEHIND", summary: "PR is behind its base" };
  }
  if (data.mergeable === "CONFLICTING" || ["CONFLICTING", "DIRTY"].includes(data.mergeStateStatus)) {
    return { ready: false, class: "REMOTE_CONFLICTING", summary: "PR conflicts with its base" };
  }
  if (data.mergeable === "UNKNOWN") {
    return { ready: false, pending: true, summary: "mergeability not yet computed" };
  }

  const req = required || requiredChecks(data.baseRefName, deps);
  const checks = checksGreen(data.statusCheckRollup, req);
  if (checks.state === "red") {
    return { ready: false, class: "REMOTE_CI_RED", summary: `failing checks: ${checks.failing.join(", ")}`, required: req };
  }
  if (checks.state === "pending") {
    return { ready: false, pending: true, summary: "checks pending", required: req };
  }

  if (data.reviewDecision === "CHANGES_REQUESTED") {
    return { ready: false, class: "REMOTE_CHANGES_REQUESTED", summary: "changes requested on review", required: req };
  }

  return {
    ready: true,
    headSha: data.headRefOid,
    headMoved,
    warnings: checks.state === "unknown" ? ["required-checks-unknown"] : [],
    required: req,
  };
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Polls `inspect` with 2x backoff (cap 10 min) until ready, a definite
// failure, or `automation.ciWaitMinutes` elapses (→ REMOTE_CI_TIMEOUT — design
// §10.2: "each expiry consumes an attempt", enforced by run-controller.js, not
// here). ponytail: transient states (mergeable UNKNOWN, a required context
// short of 3 rereads) share this one backoff loop instead of the separate
// short free-retry windows design §7's table lists per class — same end
// state, one loop to reason about.
export async function waitReady({ pr, expectedHead, landing, cfg = {} } = {}, deps) {
  const pollSeconds = cfg.pollSeconds || 30;
  const ciWaitMinutes = cfg.ciWaitMinutes ?? 30;
  const clockNow = () => (deps.now ? deps.now() : Date.now());
  const deadline = clockNow() + ciWaitMinutes * 60_000;
  const sleep = deps.sleep || defaultSleep;
  let interval = pollSeconds;
  let required;
  for (;;) {
    const result = inspect({ pr, expectedHead, landing, cfg, required }, deps);
    if (result.required) required = result.required;
    if (!result.pending) return result;
    if (clockNow() >= deadline) {
      return { ready: false, class: "REMOTE_CI_TIMEOUT", summary: `no green verdict within ${ciWaitMinutes}m` };
    }
    await sleep(interval * 1000);
    interval = Math.min(interval * 2, 600);
  }
}
