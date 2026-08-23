import { test } from "node:test";
import assert from "node:assert/strict";
import { runUntil } from "../src/run-controller.js";

const HEAD = "a".repeat(40);
const POLICY = { until: "ready", pollSeconds: 1, ciWaitMinutes: 1, maxAttempts: 3 };
const LAND = { pr: { number: 9, url: "https://github.com/o/r/pull/9" }, expectedHead: HEAD, landing: "standing", branch: "orch/integration" };

// readiness.js's inspect() also reads required-checks (`gh api .../rules/...`)
// — route both endpoints so requiredChecks() doesn't choke on a PR-view body.
function ghFake(prViewBody) {
  return (a) => {
    if (a[0] === "pr" && a[1] === "view") return JSON.stringify(prViewBody);
    if (a[0] === "api") return "[]"; // known: true, contexts: [] — empty rollup reads green
    throw new Error(`unexpected gh call: ${a.join(" ")}`);
  };
}

function baseDeps(overrides = {}) {
  return {
    runCycle: async () => ({ status: "merged", prUrl: LAND.pr.url }),
    resolveLanded: () => LAND,
    gh: ghFake({
      number: 9, state: "OPEN", isDraft: false, headRefOid: HEAD, baseRefName: "main",
      mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: null, statusCheckRollup: [],
    }),
    git: { git: () => "" },
    repo: "/repo",
    sleep: async () => {},
    ...overrides,
  };
}

test("runUntil: landed cycle, green standing PR -> READY, exit 0", async () => {
  const result = await runUntil(POLICY, {}, baseDeps());
  assert.equal(result.state, "READY");
  assert.equal(result.outcome, "reached");
  assert.equal(result.exit, 0);
});

test("runUntil: landed cycle, BEHIND standing PR -> STOPPED_AT_CAP, exit 2, failureClass REMOTE_BEHIND (acceptance criterion)", async () => {
  const deps = baseDeps({
    gh: ghFake({
      number: 9, state: "OPEN", isDraft: false, headRefOid: HEAD, baseRefName: "main",
      mergeable: "MERGEABLE", mergeStateStatus: "BEHIND", reviewDecision: null, statusCheckRollup: [],
    }),
  });
  const result = await runUntil(POLICY, {}, deps);
  assert.equal(result.exit, 2);
  assert.equal(result.outcome, "stopped-at-cap");
  assert.equal(result.failureClass, "REMOTE_BEHIND");
});

test("runUntil: cycle escalated locally (no landing) -> classified failure, no remedy available in this slice -> STOPPED_AT_CAP", async () => {
  const deps = baseDeps({
    runCycle: async () => ({ status: "escalated", class: "REVIEW_STALEMATE", fingerprint: "fp1", reason: "stalemate after cap" }),
  });
  const result = await runUntil(POLICY, {}, deps);
  assert.equal(result.exit, 2);
  assert.equal(result.outcome, "stopped-at-cap");
  assert.equal(result.failureClass, "REVIEW_STALEMATE");
});

test("runUntil: cycle escalated on a BLOCKED-terminal class (protected path) -> exit 3 with blockedReason", async () => {
  const deps = baseDeps({
    runCycle: async () => ({ status: "escalated", class: "POLICY_PROTECTED_PATH", fingerprint: "fp2", reason: "protected paths touched" }),
  });
  const result = await runUntil(POLICY, {}, deps);
  assert.equal(result.exit, 3);
  assert.equal(result.outcome, "blocked");
  assert.equal(result.blockedReason, "guardrail-path");
});

test("runUntil: --until merged stops at readiness (exit 2) — merge phase ships in P8", async () => {
  const deps = baseDeps();
  const result = await runUntil({ ...POLICY, until: "merged" }, {}, deps);
  assert.equal(result.exit, 2);
  assert.equal(result.state, "STOPPED_AT_CAP");
});

test("runUntil: merge-deferred (demoted) cycle is treated the same as escalated", async () => {
  const deps = baseDeps({
    runCycle: async () => ({ status: "merge-deferred", trigger: "dirty-merge", class: "LAND_DIRTY_MERGE", fingerprint: "fp3" }),
  });
  const result = await runUntil(POLICY, {}, deps);
  assert.equal(result.exit, 2);
  assert.equal(result.failureClass, "LAND_DIRTY_MERGE");
});

test("runUntil: a head-moved re-pin under the cap still reaches READY", async () => {
  const newHead = "c".repeat(40);
  const deps = baseDeps({
    resolveLanded: () => ({ ...LAND, expectedHead: HEAD }),
    gh: ghFake({
      number: 9, state: "OPEN", isDraft: false, headRefOid: newHead, baseRefName: "main",
      mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: null, statusCheckRollup: [],
    }),
    git: { git: (a) => (a[0] === "rev-parse" ? newHead : "") },
  });
  const result = await runUntil(POLICY, { headMovedRepins: 0 }, deps);
  assert.equal(result.state, "READY");
  assert.equal(result.headMovedRepins, 1);
});

test("runUntil: a head-moved re-pin past the cap gives up (STOPPED_AT_CAP)", async () => {
  const newHead = "c".repeat(40);
  const deps = baseDeps({
    resolveLanded: () => ({ ...LAND, expectedHead: HEAD }),
    gh: ghFake({
      number: 9, state: "OPEN", isDraft: false, headRefOid: newHead, baseRefName: "main",
      mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: null, statusCheckRollup: [],
    }),
    git: { git: (a) => (a[0] === "rev-parse" ? newHead : "") },
  });
  const result = await runUntil(POLICY, { headMovedRepins: 3 }, deps);
  assert.equal(result.state, "STOPPED_AT_CAP");
  assert.equal(result.exit, 2);
});

test("runUntil: a CI wait that times out consumes an attempt (attempt >= maxAttempts falls to ask-unavailable -> STOPPED_AT_CAP)", async () => {
  const deps = baseDeps({
    gh: ghFake({
      number: 9, state: "OPEN", isDraft: false, headRefOid: HEAD, baseRefName: "main",
      mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: null,
      statusCheckRollup: [{ context: "test", state: "PENDING" }],
    }),
  });
  let now = 0;
  deps.now = () => now;
  deps.sleep = async (ms) => { now += ms; };
  const record = { attempt: POLICY.maxAttempts }; // already at the cap
  const result = await runUntil(POLICY, record, deps);
  assert.equal(result.failureClass, "REMOTE_CI_TIMEOUT");
  assert.equal(result.exit, 2);
});
