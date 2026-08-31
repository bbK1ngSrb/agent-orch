// Fault-injection matrix — design docs/cli-v2-design.md §17.
//
// The v2 loop's whole promise is that it terminates SANELY when things go
// wrong: a 409 at merge, a quota-dead agent, a hung gate, a process killed
// mid-run. Every row below breaks something deliberately and asserts three
// things, per §17: the terminal outcome, the exit code, and — for anything
// that touches GitHub — that the fake `gh` saw at most one create/comment/merge
// per idempotency key, however many times the run re-entered. That last clause
// is proposal §7 criterion 3: a loop that retries is only safe if retrying is
// free of duplicate side effects.
//
// "Crash" here means what it means in production: the process disappears. There
// is no unwind, no cleanup — the only thing that survives is what was already
// written to `.orch`. So a crash row persists the run record, throws the
// in-memory state away, and re-enters `runUntil` with nothing but that record.
//
// Rows §17 lists that are already proven elsewhere are mapped here rather than
// duplicated, so the matrix stays checkable against the design in one place:
//
//   base moves between land and readiness → REMOTE_BEHIND → repair → ready
//     cli.test.js "orch task --until ready --json exits 0 after one integration
//     repair of a BEHIND standing PR" (same row as "standing PR BEHIND under
//     --until ready")
//   comment from a read-only user / bot is ignored; the wait continues
//     remedies.test.js "ask skips an unverifiable commenter and accepts a later
//     permitted reply", plus its canWrite() permission table
//   `orch: retry 2` from a write user → maxAttempts +2
//     remedies.test.js "ask accepts a write permission with role_name and
//     grants the requested fresh budget" (3 → 5)
//   quota 403 on the author → rotate excludes the agent → cycle with another
//     remedies.test.js "rotate re-seats a quota-failed author and preserves a
//     diverse reviewer"
//   quota on both pool agents → rotation is not diverse → ask
//     remedies.test.js "rotate excludes every failed reviewer seat and replaces
//     the list" (exclusion bookkeeping) and run-controller.test.js's
//     no-registered-executor path (an unusable remedy stops the run cleanly)
//   repo has no required checks, --until merged → local gate on the exact tip
//     landing.test.js "mergeStanding gates the exact integration head when no
//     checks are required"
//   continue <runId> after exit 2 → fresh attempt budget; run proceeds
//     run-record.test.js "resumeTerminal clears outcome/exit and grants a fresh
//     attempt budget" + the `orch continue` rows in cli.test.js
//   stalemate at roundCap → rotate (pool >= 3 vs the default two-agent pool)
//     remedies.test.js "stalemate rotation replaces, rather than appends, the
//     reviewer" and the rotate-not-diverse rows beside it
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir, cwd } from "node:process";
import { runUntil } from "../src/run-controller.js";
import { runCycle } from "../src/engine.js";
import { mergeStanding } from "../src/landing.js";
import { findPrByHead } from "../src/github.js";
import { chooseRemedy, classify, TRIGGERS } from "../src/failure.js";
import * as runRecord from "../src/run-record.js";
import * as gitDep from "../src/git.js";
import { main } from "../src/cli.js";
import * as notify from "../src/notify.js";
import { isWrite } from "./helpers/fake-gh.js";
import { initGitRepo, addOriginWithPeer, fakeCycleDeps } from "./helpers/system-repo.js";

const HEAD = "a".repeat(40);
const MERGE_SHA = "b".repeat(40);
const POLICY = { until: "ready", pollSeconds: 1, ciWaitMinutes: 1, maxAttempts: 3 };
const LAND = { pr: { number: 9, url: "https://github.com/o/r/pull/9" }, expectedHead: HEAD, landing: "standing", branch: "orch/integration" };

function orchDir(prefix) {
  return join(mkdtempSync(join(tmpdir(), prefix)), ".orch");
}

// A `gh` double that ROUTES rather than replays: a readiness poll calls the
// same endpoint repeatedly, so an ordered script (helpers/fake-gh.js) cannot
// drive it. Records every call so the §17 idempotency clause is assertable.
function routingGh(routes) {
  const calls = [];
  const gh = (args, input) => {
    calls.push({ args, input });
    for (const [match, respond] of routes) {
      if (match(args)) return typeof respond === "function" ? respond(args) : respond;
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  gh.calls = calls;
  gh.writes = () => calls.filter(isWrite);
  return gh;
}

const prView = (fields) => JSON.stringify({
  number: 9, state: "OPEN", isDraft: false, headRefOid: HEAD, baseRefName: "main",
  mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: null, statusCheckRollup: [],
  ...fields,
});

function readinessRoutes(fields) {
  return [
    [(a) => a[0] === "pr" && a[1] === "view", () => prView(fields)],
    [(a) => a[0] === "api", () => "[]"],
  ];
}

function baseDeps(overrides = {}) {
  return {
    runCycle: async () => ({ status: "merged", prUrl: LAND.pr.url }),
    resolveLanded: () => LAND,
    gh: routingGh(readinessRoutes({})),
    git: { git: () => "" },
    repo: "/repo",
    sleep: async () => {},
    ...overrides,
  };
}

// A cycle that failed the way engine.js reports it: a class and a fingerprint,
// which is all the classifier needs to pick a remedy after a restart.
const redCycle = () => ({
  status: "escalated",
  reason: "AGREE but tests are red — not merging",
  ...classify(TRIGGERS.TEST_RED) ? { class: classify(TRIGGERS.TEST_RED) } : {},
  fingerprint: "fp-red",
});

// --- crash rows -------------------------------------------------------------

test("crash after `cycle.end`, before classify → resume classifies from record → same remedy", async () => {
  const dir = orchDir("orch-fault-classify-");
  runRecord.create(dir, { runId: "r1", command: "task", argv: [], policy: POLICY });

  // The crash lands between the cycle ending and the classifier choosing what
  // to do about it, so nothing about the remedy was journaled. All the resumed
  // process has is the failure the cycle reported and the record on disk.
  const crashed = await runUntil(POLICY, runRecord.lookup(dir, "r1"), baseDeps({
    runCycle: async () => redCycle(),
    remedies: {},
  }));
  runRecord.update(dir, "r1", {
    outcome: crashed.outcome, exit: crashed.exit, attempt: crashed.attempt,
    failures: crashed.failures, retries: crashed.retries,
  });

  const persisted = runRecord.lookup(dir, "r1");
  const wouldChoose = chooseRemedy(crashed.failure, persisted, POLICY);

  const ran = [];
  const resumed = await runUntil(POLICY, persisted, baseDeps({
    runCycle: async () => redCycle(),
    remedies: {
      rebase: async ({ record }) => { ran.push("rebase"); return { cycle: { status: "merged", prUrl: LAND.pr.url }, record }; },
      rotate: async ({ record }) => { ran.push("rotate"); return { cycle: { status: "merged", prUrl: LAND.pr.url }, record }; },
    },
  }));

  assert.equal(crashed.failure.class, "TEST_RED");
  assert.equal(wouldChoose.remedy, "rebase");
  // The choice comes from the record, not from anything the dead process held.
  assert.deepEqual(ran, [wouldChoose.remedy]);
  assert.equal(resumed.exit, 0);
});

test("crash after `remedy` journaled, before new cycle → resume starts the cycle once (attempt not double-counted)", async () => {
  const dir = orchDir("orch-fault-journal-");
  runRecord.create(dir, { runId: "r1", command: "task", argv: [], policy: POLICY });
  // The state a crash leaves behind: the remedy was chosen and journaled, and
  // the attempt it consumed was already charged, but its cycle never ran.
  runRecord.update(dir, "r1", {
    attempt: 1,
    failures: [{ attempt: 1, class: "TEST_RED", fingerprint: "fp-red", remedy: "rebase" }],
    outcome: "stopped-at-cap", exit: 2,
  });

  let cycles = 0;
  const resumed = await runUntil(POLICY, runRecord.lookup(dir, "r1"), baseDeps({
    runCycle: async () => redCycle(),
    // The journaled `rebase` is spent, so the ladder moves on — what matters
    // is that exactly one cycle runs and exactly one attempt is charged.
    remedies: {
      rotate: async ({ record }) => {
        cycles += 1;
        return { cycle: { status: "merged", prUrl: LAND.pr.url }, record };
      },
    },
  }));

  assert.equal(resumed.exit, 0);
  assert.equal(cycles, 1, "the journaled remedy must run its cycle exactly once");
  // One more failure was journaled, and it consumed exactly one more attempt —
  // a resume that re-charged the crashed attempt would show 3 here.
  assert.equal(resumed.attempt, 2);
});

test("crash after `createPr` was issued, before the record noted the PR → resume finds it; no second create", async () => {
  // The PR exists on GitHub but not in our record. Query-before-write (design
  // §5.4) is what makes this safe: orch asks GitHub what is there, and only
  // creates when the answer is nothing.
  const gh = routingGh([
    [(a) => a[0] === "pr" && a[1] === "list", JSON.stringify([{ number: 9, url: LAND.pr.url, isDraft: false, headRefOid: HEAD }])],
  ]);

  const found = findPrByHead("pr/claude/x", "main", {}, { gh });

  assert.equal(found.number, 9);
  assert.deepEqual(gh.writes(), [], "the PR already existed — creating a second one is the duplicate this row exists to prevent");
});

test("crash after `merge` requested, GitHub merged → resume verifies ancestry → 0, no second merge", async () => {
  const gh = routingGh([
    [(a) => a[0] === "pr" && a[1] === "view", () => prView({ state: "MERGED", mergeCommit: { oid: MERGE_SHA } })],
    [(a) => a[0] === "api" && String(a[1]).includes("/rules/"), "[]"],
    [(a) => a[0] === "api" && String(a[1]).includes("/protection"), "{}"],
  ]);
  // The record already carries the request the crashed run issued.
  const record = { merge: { requests: [{ ordinal: 1, headSha: HEAD, result: "requested" }] } };

  const result = await mergeStanding({
    record,
    cfg: { baseBranch: "main", integrationBranch: "orch/integration", test: "true" },
    land: LAND,
    readiness: { headSha: HEAD, required: { known: true, contexts: [] } },
  }, {
    repo: "/repo", orchDir: "/orch", gh,
    git: { git: () => HEAD, ensureIntegrationWorktree: () => "/integration" },
    gate: { detect: () => "true", run: () => ({ pass: true }) },
    lock: { acquireBlocking: async () => true, releaseLock: () => true },
  });

  assert.equal(result.result, "merged");
  assert.equal(result.mergeCommit, MERGE_SHA);
  assert.deepEqual(gh.writes(), [], "GitHub had already merged — a second merge request is a duplicate side effect");
});

test("crash after `merge` requested, GitHub did not merge → resume requests again (`merge.requests[1].ordinal == 2`)", async () => {
  let state = "OPEN";
  const gh = routingGh([
    [(a) => a[0] === "pr" && a[1] === "view", () => prView({ state, ...(state === "MERGED" ? { mergeCommit: { oid: MERGE_SHA } } : {}) })],
    [(a) => a[0] === "api" && String(a[1]).includes("/rules/"), "[]"],
    [(a) => a[0] === "api" && String(a[1]).includes("/protection"), "{}"],
    [(a) => a.some((arg) => String(arg).includes("/pulls/9/merge")), () => { state = "MERGED"; return JSON.stringify({ sha: MERGE_SHA }); }],
  ]);
  const record = { merge: { requests: [{ ordinal: 1, headSha: HEAD, result: "requested" }] } };

  const result = await mergeStanding({
    record,
    cfg: { baseBranch: "main", integrationBranch: "orch/integration", test: "true" },
    land: LAND,
    readiness: { headSha: HEAD, required: { known: true, contexts: [] } },
  }, {
    repo: "/repo", orchDir: "/orch", gh,
    git: { git: () => HEAD, ensureIntegrationWorktree: () => "/integration" },
    gate: { detect: () => "true", run: () => ({ pass: true }) },
    lock: { acquireBlocking: async () => true, releaseLock: () => true },
  });

  assert.equal(result.result, "merged");
  // Ordinals are the audit trail: contiguous from 1, one per genuine attempt.
  assert.deepEqual(result.merge.requests.map((r) => r.ordinal), [1, 2]);
  assert.equal(gh.writes().length, 1, "exactly one new merge request, not one per poll");
});

// --- remote rows ------------------------------------------------------------

test("`gh` unavailable mid-run → REMOTE_AUTH → 6, record intact", async () => {
  const deps = baseDeps({
    gh: routingGh([[() => true, () => { const e = new Error("gh: authentication failed (HTTP 401)"); e.stderr = "HTTP 401"; throw e; }]]),
  });
  const result = await runUntil(POLICY, { attempt: 1, retries: {} }, deps);

  assert.equal(result.exit, 6);
  assert.equal(result.outcome, "blocked");
  assert.equal(result.blockedReason, "auth");
  // "Record intact": the run's accounting survives the failure, so `continue`
  // resumes from where it stopped rather than from genesis.
  assert.equal(result.attempt, 1);
  assert.equal(result.failure.class, "REMOTE_AUTH");
});

test("PR closed by human → REMOTE_PR_CLOSED → ask", async () => {
  const asked = [];
  const result = await runUntil(POLICY, {}, baseDeps({
    gh: routingGh(readinessRoutes({ state: "CLOSED" })),
    remedies: {
      ask: async ({ failure }) => {
        asked.push(failure.class);
        return { result: { state: "WAIT_TIMEOUT", outcome: "wait-timeout", exit: 4, failureClass: "HUMAN_TIMEOUT" } };
      },
    },
  }));

  assert.deepEqual(asked, ["REMOTE_PR_CLOSED"], "a human closed it, so only a human can say what happens next");
  assert.equal(result.exit, 4);
});

test("two runs `--until merged` racing → second sees external merge → 0; one merge request total", async () => {
  // The peer merged the standing PR while this run was polling. Nothing here
  // may issue a merge of its own: the goal is already met.
  const gh = routingGh([
    [(a) => a[0] === "pr" && a[1] === "view", () => prView({ state: "MERGED", mergeCommit: { oid: MERGE_SHA } })],
    [(a) => a[0] === "api", "[]"],
  ]);
  let mergeCalls = 0;
  const result = await runUntil({ ...POLICY, until: "merged" }, {}, baseDeps({
    gh,
    git: { git: () => "" }, // isAncestor: no throw == reachable from the base
    mergeStanding: async ({ readiness }) => {
      mergeCalls += 1;
      return {
        result: "merged", mergeCommit: MERGE_SHA, headSha: HEAD, mergedBy: readiness.mergedBy || "orch",
        merge: { mergeCommit: MERGE_SHA, requests: [{ ordinal: 1 }] },
      };
    },
  }));

  assert.equal(result.exit, 0);
  assert.equal(result.mergedBy, "external", "the record must say the peer merged it, not us");
  assert.equal(mergeCalls, 1);
  assert.equal(result.merge.requests.length, 1, "one merge request total across both runs");
});

test("head moves 4 times during merge phase → re-pin cap → ask, no lock held while waiting", async () => {
  let head = HEAD;
  let moves = 0;
  const locks = [];
  const asked = [];
  const result = await runUntil({ ...POLICY, until: "merged" }, {}, baseDeps({
    // Readiness always agrees with wherever the branch currently points, so the
    // ONLY thing moving the head is the peer landing during the merge phase.
    gh: routingGh([
      [(a) => a[0] === "pr" && a[1] === "view", () => prView({ headRefOid: head })],
      [(a) => a[0] === "api", "[]"],
    ]),
    mergeStanding: async () => {
      moves += 1;
      // Each attempt takes merge.lock and gives it back before returning, so
      // the human wait below never happens while holding it.
      locks.push("acquire", "release");
      head = String(moves).repeat(40);
      return { result: "head-moved", headSha: head };
    },
    remedies: {
      ask: async ({ failure }) => {
        asked.push(failure.class);
        return { result: { state: "WAIT_TIMEOUT", outcome: "wait-timeout", exit: 4 } };
      },
    },
  }));

  assert.equal(moves, 4, "three re-pins are allowed; the fourth move hits the cap");
  assert.deepEqual(asked, ["REMOTE_UNKNOWN"]);
  assert.equal(result.exit, 4);
  assert.equal(locks.filter((e) => e === "acquire").length, locks.filter((e) => e === "release").length,
    "every merge attempt released its lock before the run went on to wait");
});

// --- local rows -------------------------------------------------------------

test("gate hangs > `gateTimeout` → TEST_RED, lock released", async () => {
  // gate.js kills the hung command and reports a plain failure (#505); the
  // engine is where that becomes a classified TEST_RED. A timeout and an
  // honestly failing test are indistinguishable at this seam, and deliberately
  // so — both mean "the tree is not provably green".
  const released = [];
  const verdict = { decision: "AGREE", reason: "ok", raw: "" };
  const result = await runCycle({
    task: "hang", branch: "pr/auth/x", authorName: "auth", reviewerName: "rev",
    cfg: { roundCap: 3, merge: "ff-only", test: "auto", scope: { maxLines: 0, ignore: [] }, docs: { paths: [] }, automation: { gateTimeout: 1 } },
    orchDir: "/o", repo: "/r", worktree: "/wt",
  }, {
    adapters: { get: (name) => ({ name, async author() {}, async audit() { return verdict; } }) },
    git: {
      createTaskBranch() {}, attachExistingBranch() {}, pruneWorktree() {},
      git: () => "diff", changedFiles: () => ["src/a.js"],
    },
    gate: {
      detect: () => "sleep 60",
      run: () => { released.push("gate"); return { pass: false, log: "gate: `sleep 60` timed out after 1000ms and was killed" }; },
    },
    scope: { count: () => 0 },
    notify: {
      phase() {}, writeRound: () => "p", writeRoundRaw: () => "rp",
      buildDecisionBrief: () => "brief", escalate: () => "d", recordRun() {}, cleanupReviews() {},
    },
    reviewLog: { record() {} },
    inflight: { setPaths() {} },
    // The merge phase must never be reached: it is what holds merge.lock.
    finalize: async () => { throw new Error("a red gate must not reach the merge phase"); },
  });

  assert.equal(result.status, "escalated");
  assert.equal(result.class, "TEST_RED");
  assert.deepEqual(released, ["gate"]);
});

test("`--until once` + stalemate → exit 2, no remedy events, DECISION.md written", async () => {
  // `once` is the escape hatch from the loop, and it is enforced at the CLI:
  // the run controller is never entered at all, so no remedy — not even the
  // free ones — can run. The cycle's own escalation brief is still written.
  const repo = initGitRepo("orch-fault-once-");
  addOriginWithPeer(repo);
  gitDep.git(["branch", "orch/integration"], repo);
  const gh = routingGh([
    [(a) => a[0] === "--version", "gh 2"],
    [(a) => a[0] === "auth", "Logged in"],
    [(a) => a[0] === "pr" && a[1] === "list", "[]"],
    [(a) => a[0] === "api", "[]"],
  ]);
  const cycleDeps = fakeCycleDeps();
  const stalemate = {
    ...cycleDeps,
    adapters: { get: (name) => ({ name, async author() {}, async audit() { return { decision: "DISAGREE", reason: "no agreement", raw: "" }; } }) },
    // The real escalate, so DECISION.md is written for real rather than stubbed.
    notify: { ...cycleDeps.notify, escalate: notify.escalate, buildDecisionBrief: notify.buildDecisionBrief },
  };

  const previous = cwd();
  const savedExitCode = process.exitCode;
  const log = console.log;
  console.log = () => {};
  chdir(repo);
  let record;
  try {
    await main(["task", "stalemate", "--until", "once", "--no-tidy"], {
      preflight() {}, maybeNotifyUpdate: async () => {},
      cycleDeps: stalemate,
      githubDeps: () => ({ gh, git: gitDep.git }),
    });
    record = JSON.parse(readFileSync(join(repo, ".orch", "run-records", readdirSync(join(repo, ".orch", "run-records"))[0]), "utf8"));
  } finally {
    console.log = log;
    chdir(previous);
    process.exitCode = savedExitCode;
  }

  assert.equal(record.exit, 2);
  assert.equal(record.policy.until, "once");
  assert.deepEqual(record.remedies, [], "`once` means one pass: no remedy may run");
  assert.deepEqual(gh.writes(), [], "nothing may be asked of a human either");
  const decisions = join(repo, ".orch", "reviews", record.branch, "DECISION.md");
  assert.ok(existsSync(decisions), `expected the escalation brief at ${decisions}`);
});

test("`--dry` on every mutating command → zero git/gh writes", async () => {
  const repo = initGitRepo("orch-fault-dry-");
  addOriginWithPeer(repo);
  gitDep.git(["branch", "orch/integration"], repo);
  gitDep.git(["branch", "feature/x"], repo);
  const before = gitDep.git(["rev-parse", "HEAD"], repo);
  const gh = routingGh([
    [(a) => a[0] === "--version", "gh 2"],
    [(a) => a[0] === "auth", "Logged in"],
    [(a) => a[0] === "issue" && a[1] === "view", JSON.stringify({ number: 52, title: "t", body: "b", state: "OPEN" })],
    [(a) => a[0] === "pr" && a[1] === "list", "[]"],
    [(a) => a[0] === "api", "[]"],
  ]);

  const previous = cwd();
  const savedExitCode = process.exitCode;
  const log = console.log;
  console.log = () => {};
  chdir(repo);
  try {
    for (const argv of [["task", "dry task"], ["issue", "52"], ["pr", "feature/x"]]) {
      await main([...argv, "--dry", "--until", "once"], {
        preflight() {}, maybeNotifyUpdate: async () => {},
        githubDeps: () => ({ gh, git: gitDep.git }),
        dryNoTestGate: true,
      });
    }
  } finally {
    console.log = log;
    chdir(previous);
    process.exitCode = savedExitCode;
  }

  assert.deepEqual(gh.writes(), [], "a planned run must not mutate GitHub");
  assert.equal(gitDep.git(["rev-parse", "HEAD"], repo), before, "a planned run must not move the branch it would have worked on");
  assert.equal(existsSync(join(repo, ".orch", "run-records")), false, "--dry writes no run record (design §4)");
});
