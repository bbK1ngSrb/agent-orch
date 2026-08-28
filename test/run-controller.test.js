import { test } from "node:test";
import assert from "node:assert/strict";
import { runUntil } from "../src/run-controller.js";
import { rotateRemedy } from "../src/remedies.js";
import { nextAuthor } from "../src/cli.js";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";

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

// Regression: "approved" (engine.js's noMerge path — agreed + green, no
// merge attempted; set today only by `runPr()`, github.js:337) is a success
// terminal same as "merged"/"pr" (engine.js:515), not a failure. Before this
// fix, `landed` only recognized "merged"/"pr", so any `runUntil` caller whose
// cycle landed as "approved" fell into resolveFailure with an empty
// failure.class, and chooseRemedy threw "unknown failure class \"undefined\""
// instead of reading readiness.
test("runUntil: landed cycle with status 'approved' (noMerge) reads readiness -> READY", async () => {
  const result = await runUntil(POLICY, {}, baseDeps({ runCycle: async () => ({ status: "approved" }) }));
  assert.equal(result.state, "READY");
  assert.equal(result.outcome, "reached");
  assert.equal(result.exit, 0);
});

test("runUntil: only an explicit base landing may succeed without a PR", async () => {
  const policy = { ...POLICY, until: "merged", integrationBranch: "main", baseBranch: "main" };
  let mergeCalls = 0;
  const standing = await runUntil(policy, {}, baseDeps({
    resolveLanded: () => ({ ...LAND, pr: null, landing: "standing" }),
    mergeStanding: async () => { mergeCalls += 1; return { result: "merged" }; },
  }));
  assert.equal(standing.state, "STOPPED_AT_CAP");
  assert.equal(standing.failureClass, "REMOTE_UNKNOWN");
  assert.equal(mergeCalls, 0);

  const base = await runUntil(policy, {}, baseDeps({
    resolveLanded: () => ({ ...LAND, pr: null, landing: "base" }),
  }));
  assert.equal(base.state, "MERGED");
  assert.equal(base.exit, 0);
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

test("runUntil: readiness details reach the integration-repair remedy", async () => {
  const seen = [];
  const deps = baseDeps({
    gh: ghFake({
      number: 9, state: "OPEN", isDraft: false, headRefOid: HEAD, baseRefName: "main",
      mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: null,
      statusCheckRollup: [{ context: "lint", status: "COMPLETED", conclusion: "FAILURE" }],
    }),
    remedies: {
      "integration-repair": async ({ failure }) => {
        seen.push(failure);
        return { result: { state: "STOPPED_AT_CAP", outcome: "stopped-at-cap", exit: 2 } };
      },
    },
  });

  const result = await runUntil(POLICY, { retries: { "repair-lock": 3 } }, deps);

  assert.equal(result.exit, 2);
  assert.equal(seen[0].summary, "failing checks: lint");
});

// Regression: `gh pr view` failing mid-poll (revoked token, network hiccup)
// used to escape `waitReady` uncaught and propagate straight out of
// `runUntil`, so a caller landed a real cycle and then crashed on the read
// instead of getting a classified result. `readiness.js` now classifies a
// 401/403 as REMOTE_AUTH; `runUntil` must surface it like any other readiness
// failure, not throw.
test("runUntil: gh pr view 401/403 mid-poll classifies REMOTE_AUTH instead of throwing", async () => {
  const deps = baseDeps({ gh: () => { throw new Error("gh: Bad credentials (HTTP 401)"); } });
  const result = await runUntil(POLICY, {}, deps);
  assert.equal(result.exit, 3);
  assert.equal(result.outcome, "blocked");
  assert.equal(result.failureClass, "REMOTE_AUTH");
  assert.equal(result.retries.REMOTE_AUTH, 1);
  assert.equal(result.attempt, 0);
});

test("runUntil: free retry honors backoff, persists its counter, then dispatches the remedy", async () => {
  const failure = { status: "escalated", class: "LAND_SYNC", fingerprint: "same-failure" };
  let cycles = 0;
  const sleeps = [];
  const dispatched = [];
  const result = await runUntil(POLICY, {}, {
    ...baseDeps({
      runCycle: async () => (++cycles === 1 ? failure : { ...failure }),
      sleep: async (ms) => sleeps.push(ms),
      remedies: {
        rebase: async ({ name, record }) => {
          dispatched.push({ name, attempt: record.attempt });
          return { result: { state: "READY", outcome: "reached", exit: 0 } };
        },
      },
    }),
  });
  assert.equal(cycles, 2);
  assert.deepEqual(sleeps, [30_000]);
  assert.deepEqual(dispatched, [{ name: "rebase", attempt: 1 }]);
  assert.equal(result.retries.LAND_SYNC, 1);
  assert.equal(result.attempt, 1);
  assert.equal(result.state, "READY");
});

test("runUntil: a landed REMOTE_UNKNOWN retry rereads the PR without rerunning the cycle", async () => {
  let cycles = 0;
  let reads = 0;
  const result = await runUntil(POLICY, {}, baseDeps({
    runCycle: async () => { cycles += 1; return { status: "merged" }; },
    resolveLanded: () => { reads += 1; return { pr: null }; },
  }));
  assert.equal(cycles, 1);
  assert.equal(reads, 4);
  assert.equal(result.retries.reread, 3);
  assert.equal(result.failureClass, "REMOTE_UNKNOWN");
});

test("runUntil: an exhausted free retry with no remedies reaches its terminal outcome", async () => {
  const failure = { status: "escalated", class: "LAND_OVERLAP", fingerprint: "same-failure" };
  let cycles = 0;
  const result = await runUntil({ ...POLICY, remedies: [] }, {}, {
    ...baseDeps({ runCycle: async () => (++cycles === 1 ? failure : { ...failure }) }),
  });
  assert.equal(cycles, 2);
  assert.equal(result.outcome, "stopped-at-cap");
  assert.equal(result.exit, 2);
  assert.equal(result.retries.LAND_OVERLAP, 1);
  assert.equal(result.attempt, 0);
});

test("runUntil: an unavailable remedy terminates cleanly without consuming its attempt", async () => {
  const failure = { status: "escalated", class: "LAND_OVERLAP", fingerprint: "same-failure" };
  let cycles = 0;
  const result = await runUntil(POLICY, {}, {
    ...baseDeps({ runCycle: async () => (++cycles === 1 ? failure : { ...failure }) }),
  });
  assert.equal(cycles, 2);
  assert.equal(result.outcome, "stopped-at-cap");
  assert.equal(result.exit, 2);
  assert.equal(result.retries.LAND_OVERLAP, 1);
  assert.equal(result.attempt, 0);
  assert.deepEqual(result.failures, []);
});

// REMOTE_AUTH's free retry (cap 1) is exhausted on the second occurrence in
// the same run, at which point chooseRemedy's decision is terminal and
// run-controller.js's BLOCKED_REASON map turns it into blockedReason "auth"
// (design §7's `REMOTE_AUTH ... none -> BLOCKED (3)` row).
test("runUntil: gh pr view 401/403 after the free retry is exhausted -> BLOCKED, blockedReason auth", async () => {
  const deps = baseDeps({ gh: () => { throw new Error("gh: Bad credentials (HTTP 401)"); } });
  const record = { retries: { REMOTE_AUTH: 1 } };
  const result = await runUntil(POLICY, record, deps);
  assert.equal(result.exit, 3);
  assert.equal(result.outcome, "blocked");
  assert.equal(result.blockedReason, "auth");
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

// The known starting state #570 builds on: detection and classification land
// here, the `rotate` executor does not. chooseRemedy already picks `rotate` for
// AGENT_QUOTA, so the only thing standing between this and a re-seated agent is
// a registered executor — until then the run must stop cleanly, not error.
test("runUntil: AGENT_QUOTA selects `rotate`, finds no executor, and stops at STOPPED_AT_CAP", async () => {
  let cycles = 0;
  const deps = baseDeps({
    runCycle: async () => {
      cycles += 1;
      return { status: "escalated", class: "AGENT_QUOTA", fingerprint: "fpq", reason: "agent error: author claude hit its usage limit" };
    },
  });
  const result = await runUntil(POLICY, {}, deps);
  assert.equal(result.exit, 2, "not exit 1: the quota death is a classified result, not an uncaught throw");
  assert.equal(result.outcome, "stopped-at-cap");
  assert.equal(result.failureClass, "AGENT_QUOTA");
  assert.equal(cycles, 1, "no free retry for AGENT_QUOTA — re-running the exhausted seat would just fail again");
});

test("runUntil: rotate carries the excluded seat into the fresh cycle", async () => {
  let picked;
  const run = {
    author: { agent: "a" }, reviewers: [{ agent: "b" }],
    cfg: { agents: ["a", "b", "c"] }, orchDir: mkdtempSync(join(tmpdir(), "orch-controller-rotate-")),
  };
  const result = await runUntil(POLICY, {}, baseDeps({
    runCycle: async () => ({
      status: "escalated", class: "AGENT_QUOTA", fingerprint: "quota-fp",
      failedRole: "author", failedAgents: [{ agent: "a", quota: true }],
    }),
    remedies: {
      rotate: (context) => rotateRemedy({
        ...context, run, selectRoles: nextAuthor,
        runCycle: async (cycle) => { picked = cycle; return { status: "approved", prUrl: LAND.pr.url }; },
      }),
    },
  }));
  assert.equal(result.state, "READY");
  assert.equal(picked.author.agent, "c");
  assert.deepEqual(result.excludedAgents.map((entry) => entry.name), ["a"]);
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

test("runUntil: --until merged calls the head-bound merge phase and reaches MERGED", async () => {
  let seen;
  const deps = baseDeps({
    mergeStanding: async (args) => {
      seen = args;
      return { result: "merged", headSha: HEAD, mergeCommit: "b".repeat(40), merge: { requests: [] } };
    },
  });
  const result = await runUntil({ ...POLICY, until: "merged" }, {}, deps);
  assert.equal(result.exit, 0);
  assert.equal(result.state, "MERGED");
  assert.equal(result.mergeCommit, "b".repeat(40));
  assert.equal(seen.land.expectedHead, HEAD);
});

test("runUntil: a head-bound 409 rechecks readiness and merges the repinned head", async () => {
  let mergeCalls = 0;
  const result = await runUntil({ ...POLICY, until: "merged" }, {}, baseDeps({
    mergeStanding: async () => (++mergeCalls === 1
      ? { result: "head-moved" }
      : { result: "merged", headSha: HEAD, mergeCommit: "b".repeat(40), merge: { requests: [] } }),
  }));

  assert.equal(result.state, "MERGED");
  assert.equal(result.exit, 0);
  assert.equal(result.headMovedRepins, 1);
  assert.equal(mergeCalls, 2);
});

test("runUntil: a fresh re-landing remedy discards an earlier standing-PR repin", async () => {
  const repinned = "b".repeat(40);
  const newHead = "c".repeat(40);
  let currentHead = repinned;
  let cycleCalls = 0;
  let landCalls = 0;
  const mergeHeads = [];
  const deps = baseDeps({
    runCycle: async () => ({ status: "merged" }),
    resolveLanded: () => {
      landCalls += 1;
      currentHead = landCalls === 1 ? repinned : newHead;
      return { ...LAND, expectedHead: landCalls === 1 ? HEAD : newHead };
    },
    gh: (a) => {
      if (a[0] === "pr" && a[1] === "view") {
        return JSON.stringify({
          number: 9, state: "OPEN", isDraft: false, headRefOid: currentHead, baseRefName: "main",
          mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: null, statusCheckRollup: [],
        });
      }
      if (a[0] === "api") return "[]";
      throw new Error(`unexpected gh call: ${a.join(" ")}`);
    },
    git: { git: (a) => {
      if (a[0] === "rev-parse") return currentHead;
      if (a[0] === "merge-base" && a[2] === HEAD && a[3] === repinned) return "";
      throw new Error("not an ancestor");
    } },
    mergeStanding: async ({ land }) => {
      mergeHeads.push(land.expectedHead);
      if (mergeHeads.length === 1) {
        return { result: "rejected", failure: { class: "LAND_DIRTY_MERGE", summary: "re-land" } };
      }
      return { result: "merged", headSha: land.expectedHead, mergeCommit: "d".repeat(40) };
    },
    remedies: {
      rebase: async () => ({ cycle: { status: "merged", cycle: ++cycleCalls } }),
    },
  });

  const result = await runUntil({ ...POLICY, until: "merged" }, {}, deps);

  assert.equal(result.state, "MERGED");
  assert.deepEqual(mergeHeads, [repinned, newHead]);
  assert.equal(cycleCalls, 1);
});

// Regression: `--until merged` must actually reach readiness before stopping
// short of the merge — not skip the wait entirely and always claim "merge
// ships in P8" regardless of whether the PR is even mergeable yet.
test("runUntil: --until merged still classifies a real readiness failure (waitReady isn't skipped)", async () => {
  const deps = baseDeps({
    gh: ghFake({
      number: 9, state: "OPEN", isDraft: false, headRefOid: HEAD, baseRefName: "main",
      mergeable: "MERGEABLE", mergeStateStatus: "BEHIND", reviewDecision: null, statusCheckRollup: [],
    }),
  });
  const result = await runUntil({ ...POLICY, until: "merged" }, {}, deps);
  assert.equal(result.failureClass, "REMOTE_BEHIND");
  assert.notEqual(result.note, "merge phase ships in P8");
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

// run-controller.js has no attempt counter of its own — record.attempt is
// bumped once per top-level invocation by cli.js regardless of outcome
// (design §10.2's "each expiry consumes an attempt" holds by construction of
// that caller, not by anything runUntil does). This test only covers what
// runUntil DOES own: once chooseRemedy sees the cap already reached, a
// REMOTE_CI_TIMEOUT is terminal (STOPPED_AT_CAP), not a free retry.
test("runUntil: a CI wait that times out is terminal once the attempt cap is already reached -> STOPPED_AT_CAP", async () => {
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
