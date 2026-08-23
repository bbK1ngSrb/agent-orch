import { test } from "node:test";
import assert from "node:assert/strict";
import { inspect, waitReady } from "../src/readiness.js";

const HEAD = "a".repeat(40);
const INTEGRATION_TIP = "b".repeat(40);

function prViewGh(fields) {
  const base = {
    number: 9, state: "OPEN", isDraft: false, headRefOid: HEAD, baseRefName: "main",
    mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: null,
    statusCheckRollup: [],
    ...fields,
  };
  return (args) => {
    if (args[0] === "pr" && args[1] === "view") return JSON.stringify(base);
    if (args[0] === "api" && String(args[1]).includes("/rules/")) return "[]";
    if (args[0] === "api" && String(args[1]).includes("/protection")) return JSON.stringify({});
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
}

function makeDeps(fields, { requiredContexts } = {}) {
  const gh = requiredContexts
    ? (args) => (String(args[1] || "").includes("/rules/")
      ? JSON.stringify([{ type: "required_status_checks", parameters: { required_status_checks: requiredContexts.map((c) => ({ context: c })) } }])
      : prViewGh(fields)(args))
    : prViewGh(fields);
  return {
    gh,
    git: { git: (args, repo) => { throw new Error(`unexpected git call: ${args.join(" ")} in ${repo}`); } },
    repo: "/repo",
  };
}

const args = { pr: 9, expectedHead: HEAD, landing: "standing", cfg: { baseBranch: "main", integrationBranch: "orch/integration" } };

test("inspect: green PR (no required checks known-empty) is ready", () => {
  const result = inspect(args, makeDeps({}, { requiredContexts: [] }));
  assert.equal(result.ready, true);
  assert.equal(result.headSha, HEAD);
  assert.deepEqual(result.warnings, []);
});

test("inspect: draft PR is never ready", () => {
  const result = inspect(args, makeDeps({ isDraft: true }));
  assert.equal(result.ready, false);
  assert.equal(result.class, "REMOTE_PR_CLOSED");
});

test("inspect: closed PR is never ready", () => {
  const result = inspect(args, makeDeps({ state: "CLOSED" }));
  assert.equal(result.ready, false);
  assert.equal(result.class, "REMOTE_PR_CLOSED");
});

test("inspect: BEHIND classifies REMOTE_BEHIND", () => {
  const result = inspect(args, makeDeps({ mergeStateStatus: "BEHIND" }));
  assert.equal(result.ready, false);
  assert.equal(result.class, "REMOTE_BEHIND");
});

test("inspect: CONFLICTING mergeable classifies REMOTE_CONFLICTING", () => {
  const result = inspect(args, makeDeps({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }));
  assert.equal(result.ready, false);
  assert.equal(result.class, "REMOTE_CONFLICTING");
});

test("inspect: UNKNOWN mergeable is a pending (retryable) state, not a definite failure", () => {
  const result = inspect(args, makeDeps({ mergeable: "UNKNOWN" }));
  assert.equal(result.ready, false);
  assert.equal(result.pending, true);
  assert.equal(result.class, undefined);
});

test("inspect: gh pr view 401/403 classifies REMOTE_AUTH instead of throwing", () => {
  const deps = { gh: () => { throw new Error("gh: Bad credentials (HTTP 401)"); }, git: { git: () => "" }, repo: "/repo" };
  const result = inspect(args, deps);
  assert.equal(result.ready, false);
  assert.equal(result.class, "REMOTE_AUTH");
  assert.equal(result.pending, undefined);
});

test("inspect: gh pr view failing with no HTTP status is a pending (transient) read, not a throw", () => {
  const deps = { gh: () => { throw new Error("network unreachable"); }, git: { git: () => "" }, repo: "/repo" };
  const result = inspect(args, deps);
  assert.equal(result.ready, false);
  assert.equal(result.pending, true);
  assert.equal(result.class, undefined);
});

test("inspect: failing required check classifies REMOTE_CI_RED with names", () => {
  const rollup = [{ context: "test", state: "FAILURE" }];
  const result = inspect(args, makeDeps({ statusCheckRollup: rollup }, { requiredContexts: ["test"] }));
  assert.equal(result.ready, false);
  assert.equal(result.class, "REMOTE_CI_RED");
  assert.match(result.summary, /test/);
});

test("inspect: reviewDecision CHANGES_REQUESTED classifies REMOTE_CHANGES_REQUESTED", () => {
  const result = inspect(args, makeDeps({ reviewDecision: "CHANGES_REQUESTED" }, { requiredContexts: [] }));
  assert.equal(result.ready, false);
  assert.equal(result.class, "REMOTE_CHANGES_REQUESTED");
});

test("inspect: PR merged by someone else, our commit reachable from base -> ready (external)", () => {
  const deps = makeDeps({ state: "MERGED" });
  deps.git.git = (a) => { if (a[0] === "merge-base") return ""; throw new Error("unexpected"); };
  const result = inspect(args, deps);
  assert.equal(result.ready, true);
  assert.equal(result.mergedBy, "external");
});

test("inspect: PR merged by someone else, our commit NOT on base -> not ready", () => {
  const deps = makeDeps({ state: "MERGED" });
  deps.git.git = () => { throw new Error("not an ancestor"); };
  const result = inspect(args, deps);
  assert.equal(result.ready, false);
  assert.equal(result.class, "REMOTE_PR_CLOSED");
});

test("inspect: head moved but still an ancestor at the integration tip -> re-pins (standing only)", () => {
  const newHead = "c".repeat(40);
  const deps = makeDeps({ headRefOid: newHead }, { requiredContexts: [] });
  deps.git.git = (a) => {
    if (a[0] === "rev-parse") return INTEGRATION_TIP;
    if (a[0] === "merge-base") return "";
    throw new Error("unexpected");
  };
  // integration tip must equal the new head for the repin rule to hold
  const result = inspect(
    { ...args, expectedHead: HEAD },
    { ...deps, git: { git: (a) => (a[0] === "rev-parse" ? newHead : "") } },
  );
  assert.equal(result.ready, true);
  assert.equal(result.headMoved, true);
  assert.equal(result.headSha, newHead);
});

test("inspect: head moved with no valid repin condition fails closed (REMOTE_UNKNOWN)", () => {
  const newHead = "c".repeat(40);
  const deps = makeDeps({ headRefOid: newHead });
  deps.git.git = () => { throw new Error("not an ancestor"); };
  const result = inspect(args, deps);
  assert.equal(result.ready, false);
  assert.equal(result.class, "REMOTE_UNKNOWN");
});

test("inspect: empty rollup is green only when the required set is known and empty", () => {
  const knownEmpty = inspect(args, makeDeps({}, { requiredContexts: [] }));
  assert.equal(knownEmpty.ready, true);

  const knownNonEmpty = inspect(args, makeDeps({}, { requiredContexts: ["test"] }));
  assert.equal(knownNonEmpty.ready, false);
  assert.equal(knownNonEmpty.pending, true);
});

// An empty rollup is green "only when the required set is known and empty"
// (design §9 rule 4, and the test above) — a 403 on the required-checks read
// means the required set is NOT known, so an empty rollup must stay pending
// rather than fail open to ready.
test("inspect: required-checks-unknown (403) with an empty rollup stays pending, not ready", () => {
  const gh = (a) => {
    if (a[0] === "pr" && a[1] === "view") return JSON.stringify({
      number: 9, state: "OPEN", isDraft: false, headRefOid: HEAD, baseRefName: "main",
      mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: null, statusCheckRollup: [],
    });
    throw new Error("gh: Forbidden (HTTP 403)");
  };
  const result = inspect(args, { gh, git: { git: () => "" }, repo: "/repo" });
  assert.equal(result.ready, false);
  assert.equal(result.pending, true);
});

// With a non-empty, all-green rollup, an unknown required set can't be
// blamed on "no checks exist" — that's the "unknown" downgrade the rule 4
// comment describes: ready, but flagged so the caller knows the required-set
// read failed rather than confirming the rollup covers everything required.
test("inspect: required-checks-unknown (403) with a passing rollup still reports ready, with a warning", () => {
  const gh = (a) => {
    if (a[0] === "pr" && a[1] === "view") return JSON.stringify({
      number: 9, state: "OPEN", isDraft: false, headRefOid: HEAD, baseRefName: "main",
      mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: null,
      statusCheckRollup: [{ context: "test", state: "SUCCESS" }],
    });
    throw new Error("gh: Forbidden (HTTP 403)");
  };
  const result = inspect(args, { gh, git: { git: () => "" }, repo: "/repo" });
  assert.equal(result.ready, true);
  assert.deepEqual(result.warnings, ["required-checks-unknown"]);
});

// design §9 rule 4's rollup-green clause is unconditional: a FAILURE entry in
// statusCheckRollup must fail the PR closed even when the required-checks
// read itself errored (403, or any other non-403/404 status) and reports
// `known: false` — "can't confirm every required context is present" must
// never be read as "skip checking what the rollup actually says".
test("inspect: a FAILURE in the rollup fails closed even when required checks are unknown", () => {
  const gh = (a) => {
    if (a[0] === "pr" && a[1] === "view") return JSON.stringify({
      number: 9, state: "OPEN", isDraft: false, headRefOid: HEAD, baseRefName: "main",
      mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: null,
      statusCheckRollup: [{ context: "test", state: "FAILURE" }],
    });
    throw new Error("gh: Forbidden (HTTP 403)");
  };
  const result = inspect(args, { gh, git: { git: () => "" }, repo: "/repo" });
  assert.equal(result.ready, false);
  assert.equal(result.class, "REMOTE_CI_RED");
  assert.match(result.summary, /test/);
});

test("waitReady: returns immediately on a definite failure (no polling)", async () => {
  let slept = 0;
  const deps = { ...makeDeps({ mergeStateStatus: "BEHIND" }), sleep: async () => { slept += 1; } };
  const result = await waitReady({ ...args, cfg: { ...args.cfg, pollSeconds: 1, ciWaitMinutes: 1 } }, deps);
  assert.equal(result.class, "REMOTE_BEHIND");
  assert.equal(slept, 0);
});

test("waitReady: polls through pending checks, then returns ready once green", async () => {
  let calls = 0;
  const gh = (a) => {
    if (a[0] === "pr" && a[1] === "view") {
      calls += 1;
      return JSON.stringify({
        number: 9, state: "OPEN", isDraft: false, headRefOid: HEAD, baseRefName: "main",
        mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: null,
        statusCheckRollup: calls < 3 ? [{ context: "test", state: "PENDING" }] : [{ context: "test", state: "SUCCESS" }],
      });
    }
    return JSON.stringify([{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "test" }] } }]);
  };
  let slept = 0;
  const deps = { gh, git: { git: () => "" }, repo: "/repo", sleep: async () => { slept += 1; } };
  const result = await waitReady({ ...args, cfg: { ...args.cfg, pollSeconds: 1, ciWaitMinutes: 5 } }, deps);
  assert.equal(result.ready, true);
  assert.equal(calls, 3);
  assert.equal(slept, 2);
});

test("waitReady: times out to REMOTE_CI_TIMEOUT after ciWaitMinutes of pending checks", async () => {
  const gh = (a) => {
    if (a[0] === "pr" && a[1] === "view") return JSON.stringify({
      number: 9, state: "OPEN", isDraft: false, headRefOid: HEAD, baseRefName: "main",
      mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: null,
      statusCheckRollup: [{ context: "test", state: "PENDING" }],
    });
    return JSON.stringify([{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "test" }] } }]);
  };
  let now = 0;
  const deps = {
    gh, git: { git: () => "" }, repo: "/repo",
    now: () => now, sleep: async (ms) => { now += ms; },
  };
  const result = await waitReady({ ...args, cfg: { ...args.cfg, pollSeconds: 60, ciWaitMinutes: 1 } }, deps);
  assert.equal(result.class, "REMOTE_CI_TIMEOUT");
});

// design §9: "Read (after `git fetch origin <base> <integration>` so local
// refs are fresh)" — without this, rule 2's ancestor/repin check
// (`isAncestor`/`safeRevParse` in readiness.js) reads whatever origin/<ref>
// last happened to point to, which can be arbitrarily stale in production.
test("waitReady: fetches base+integration from origin before reading (design §9)", async () => {
  const calls = [];
  const deps = makeDeps({}, { requiredContexts: [] });
  deps.git = { git: (a, r) => { calls.push([a, r]); return ""; } };
  const result = await waitReady({ ...args, cfg: { ...args.cfg, pollSeconds: 1, ciWaitMinutes: 1 } }, deps);
  assert.equal(result.ready, true);
  assert.deepEqual(calls[0], [["fetch", "origin", "main", "orch/integration"], "/repo"]);
});

// A fetch taken once before the loop leaves every later `inspect` reading
// refs as stale as the first poll — including a PR that gets merged (by
// another concurrent cycle re-pinning the standing branch) mid-poll. Refetch
// every iteration so that transition is visible on the very next read.
test("waitReady: refetches before every poll iteration, not just once", async () => {
  let fetches = 0;
  let calls = 0;
  const gh = (a) => {
    if (a[0] === "pr" && a[1] === "view") {
      calls += 1;
      return JSON.stringify({
        number: 9, state: "OPEN", isDraft: false, headRefOid: HEAD, baseRefName: "main",
        mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: null,
        statusCheckRollup: calls < 3 ? [{ context: "test", state: "PENDING" }] : [{ context: "test", state: "SUCCESS" }],
      });
    }
    return JSON.stringify([{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "test" }] } }]);
  };
  const deps = {
    gh,
    git: { git: (a) => { if (a[0] === "fetch") fetches += 1; return ""; } },
    repo: "/repo",
    sleep: async () => {},
  };
  const result = await waitReady({ ...args, cfg: { ...args.cfg, pollSeconds: 1, ciWaitMinutes: 5 } }, deps);
  assert.equal(result.ready, true);
  assert.equal(fetches, 3);
});

test("waitReady: a fetch failure doesn't abort the readiness read", async () => {
  const deps = makeDeps({}, { requiredContexts: [] });
  deps.git = { git: (a) => { if (a[0] === "fetch") throw new Error("network unreachable"); return ""; } };
  const result = await waitReady({ ...args, cfg: { ...args.cfg, pollSeconds: 1, ciWaitMinutes: 1 } }, deps);
  assert.equal(result.ready, true);
});

// A nonzero `gh pr view` exit anywhere in a wait window up to `ciWaitMinutes`
// long must never escape `waitReady` uncaught — that would convert an
// already-merged-and-pushed cycle into a crashed run instead of a classified,
// resumable result (the exact hazard `findPrByHeadSafe` already guards for
// `gh pr list` in cli.js).
test("waitReady: a 401/403 from gh pr view returns REMOTE_AUTH immediately instead of throwing", async () => {
  let slept = 0;
  const deps = {
    gh: () => { throw new Error("gh: Bad credentials (HTTP 401)"); },
    git: { git: () => "" }, repo: "/repo",
    sleep: async () => { slept += 1; },
  };
  const result = await waitReady({ ...args, cfg: { ...args.cfg, pollSeconds: 1, ciWaitMinutes: 1 } }, deps);
  assert.equal(result.ready, false);
  assert.equal(result.class, "REMOTE_AUTH");
  assert.equal(slept, 0);
});

test("waitReady: a transient gh pr view failure is retried, not thrown, and still reaches ready", async () => {
  let calls = 0;
  const gh = (a) => {
    if (a[0] === "pr" && a[1] === "view") {
      calls += 1;
      if (calls === 1) throw new Error("network unreachable");
      return JSON.stringify({
        number: 9, state: "OPEN", isDraft: false, headRefOid: HEAD, baseRefName: "main",
        mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: null,
        statusCheckRollup: [],
      });
    }
    return JSON.stringify([]);
  };
  const deps = { gh, git: { git: () => "" }, repo: "/repo", sleep: async () => {} };
  const result = await waitReady({ ...args, cfg: { ...args.cfg, pollSeconds: 1, ciWaitMinutes: 5 } }, deps);
  assert.equal(result.ready, true);
  assert.equal(calls, 2);
});
