// design §12: the lock scheme every remedy builds on (P6 split 1/4). No
// remedy executor exists yet (integration-repair.js lands in a later split),
// so this exercises the real primitives in src/lock.js directly — no
// stubbed git — against real lock files in real temp dirs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, releaseLock, LOCK_NAMES } from "../src/lock.js";
import { chooseRemedy } from "../src/failure.js";
import { runUntil } from "../src/run-controller.js";
import { inspect } from "../src/readiness.js";
import { createRebaseRemedy, rotateRemedy } from "../src/remedies.js";
import { buildReauthorPrompt, failureHistory, reauthorRemedy } from "../src/remedies/reauthor.js";
import { askRemedy, canWrite, parseReply } from "../src/remedies/ask.js";
import { runCycle as executeCycle } from "../src/engine.js";
import { nextAuthor } from "../src/cli.js";
import { integrationRepairRemedy, createIntegrationRepairRemedy } from "../src/integration-repair.js";
import * as git from "../src/git.js";
import * as runRecord from "../src/run-record.js";

const READY_POLICY = { until: "ready", pollSeconds: 1, ciWaitMinutes: 1, maxAttempts: 3 };
const HEAD = "a".repeat(40);

function newRepo() {
  const repo = mkdtempSync(join(tmpdir(), "orch-remedy-git-"));
  git.git(["init", "-b", "main"], repo);
  git.git(["config", "user.email", "t@t"], repo);
  git.git(["config", "user.name", "t"], repo);
  writeFileSync(join(repo, "base.txt"), "base\n");
  git.git(["add", "."], repo);
  git.git(["commit", "-m", "base"], repo);
  mkdirSync(join(repo, ".orch", "wt"), { recursive: true });
  return repo;
}

function commitFile(repo, file, text, message) {
  writeFileSync(join(repo, file), text);
  git.git(["add", "."], repo);
  git.git(["commit", "-m", message], repo);
}

function addOrigin(repo) {
  const remote = mkdtempSync(join(tmpdir(), "orch-remedy-remote-"));
  git.git(["init", "--bare", "-b", "main"], remote);
  git.git(["remote", "add", "origin", remote], repo);
  git.git(["push", "-u", "origin", "main"], repo);
  return remote;
}

function cloneRemote(remote) {
  const parent = mkdtempSync(join(tmpdir(), "orch-remedy-peer-"));
  const peer = join(parent, "repo");
  git.git(["clone", remote, peer], parent);
  git.git(["config", "user.email", "t@t"], peer);
  git.git(["config", "user.name", "t"], peer);
  return peer;
}

function readyDeps(repo, failure, remedy) {
  return {
    runCycle: async () => failure,
    resolveLanded: () => ({
      pr: { number: 9, url: "https://github.com/o/r/pull/9" },
      expectedHead: HEAD,
      landing: "standing",
      branch: "orch/integration",
    }),
    gh: (args) => {
      if (args[0] === "pr" && args[1] === "view") {
        return JSON.stringify({
          number: 9, state: "OPEN", isDraft: false, headRefOid: HEAD,
          baseRefName: "main", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
          reviewDecision: null, statusCheckRollup: [],
        });
      }
      if (args[0] === "api") return "[]";
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    },
    git,
    repo,
    remedies: { rebase: remedy },
  };
}

function remedyFor(repo, { branch = "feature", author = null, cycle = { status: "merged" }, gitOverrides = {}, lock = null } = {}) {
  const orchDir = join(repo, ".orch");
  const run = {
    repo,
    orchDir,
    branch,
    author: { agent: "author" },
    authorName: "author",
    cfg: { baseBranch: "main", integrationBranch: "orch/integration" },
    worktree: join(orchDir, "wt", "cycle-feature"),
  };
  const deps = {
    git: { ...git, ...gitOverrides },
    adapters: { get: () => author || { author: async () => {} } },
    ...(lock ? { lock } : {}),
  };
  return createRebaseRemedy({ run, deps, runCycle: async () => cycle });
}

test("rebase is the first dispatched remedy for all four landing/test classes", () => {
  for (const cls of ["LAND_DIRTY_MERGE", "LAND_OVERLAP", "LAND_HEAD_MOVED", "TEST_RED"]) {
    const retries = ["LAND_OVERLAP", "LAND_HEAD_MOVED"].includes(cls) ? { [cls]: 1 } : {};
    const decision = chooseRemedy(
      { class: cls, fingerprint: `${cls}-fp` },
      { attempt: 0, retries, failures: [] },
      READY_POLICY,
    );
    assert.equal(decision.remedy, "rebase", cls);
  }
});

test("rotate re-seats a quota-failed author and preserves a diverse reviewer", async () => {
  let picked;
  let authorCalls = 0;
  const run = {
    author: { agent: "a" },
    reviewers: [{ agent: "b" }],
    cfg: { agents: ["a", "b", "c"] },
    orchDir: mkdtempSync(join(tmpdir(), "orch-rotate-author-")),
  };
  const result = await rotateRemedy({
    failure: { class: "AGENT_QUOTA" },
    cycle: { failedRole: "author", failedAgents: [{ agent: "a", quota: true }] },
    record: { attempt: 1, excludedAgents: [] },
    run,
    selectRoles: nextAuthor,
    runCycle: async (cycle) => { picked = cycle; authorCalls += 1; return { status: "merged" }; },
  });
  assert.equal(picked.author.agent, "c");
  assert.deepEqual(picked.reviewers.map((reviewer) => reviewer.agent), ["b"]);
  assert.deepEqual(result.record.excludedAgents.map((entry) => entry.name), ["a"]);
  assert.equal(result.record.excludedAgents[0].reason, "quota");
  assert.equal(authorCalls, 1);
});

test("rotate excludes every failed reviewer seat and replaces the list", async () => {
  let picked;
  const result = await rotateRemedy({
    failure: { class: "AGENT_ERROR" },
    cycle: { failedRole: "reviewer", failedAgents: [{ agent: "b" }, { agent: "c" }] },
    record: { attempt: 1, excludedAgents: [] },
    run: {
      author: { agent: "a" }, reviewers: [{ agent: "b" }, { agent: "c" }],
      cfg: { agents: ["a", "b", "c", "d", "e"] },
      orchDir: mkdtempSync(join(tmpdir(), "orch-rotate-reviewers-")),
    },
    selectRoles: nextAuthor,
    runCycle: async (cycle) => { picked = cycle; return { status: "merged" }; },
  });
  assert.deepEqual(result.record.excludedAgents.map((entry) => entry.name), ["b", "c"]);
  assert.deepEqual(picked.reviewers.map((reviewer) => reviewer.agent), ["d", "e"]);
  assert.notEqual(picked.author.agent, picked.reviewers[0].agent);
});

test("stalemate rotation replaces, rather than appends, the reviewer", async () => {
  let picked;
  await rotateRemedy({
    failure: { class: "REVIEW_STALEMATE" },
    cycle: { failedRole: "reviewer" },
    record: { attempt: 1, excludedAgents: [] },
    run: {
      author: { agent: "a" }, reviewers: [{ agent: "b" }],
      cfg: { agents: ["a", "b", "c"] },
      orchDir: mkdtempSync(join(tmpdir(), "orch-rotate-stalemate-")),
    },
    selectRoles: nextAuthor,
    runCycle: async (cycle) => { picked = cycle; return { status: "merged" }; },
  });
  assert.deepEqual(picked.reviewers.map((reviewer) => reviewer.agent), ["c"]);
  assert.equal(picked.reviewers.some((reviewer) => reviewer.agent === "b"), false);
});

test("rotation starts the replacement cycle at round 1", async () => {
  const rounds = [];
  const run = {
    mode: "task", task: "rotate me", branch: "pr/a/rotate-me", author: { agent: "a" }, authorName: "a",
    reviewers: [{ agent: "b" }], reviewerName: "b", reviewerNames: ["b"],
    cfg: {
      agents: ["a", "b", "c"], roundCap: 3, baseBranch: "main", test: "auto",
      scope: { maxLines: 0, ignore: [] }, docs: { paths: ["*.md"] },
    }, orchDir: "/orch", repo: "/repo", worktree: "/wt",
  };
  const deps = {
    adapters: { get: (name) => ({
      name,
      async author() { throw new Error("replacement must not re-author"); },
      async audit(_branch, _worktree, options) {
        rounds.push({ name, round: options.round });
        return { decision: "AGREE", reason: "ok", raw: "" };
      },
    }) },
    git: {
      attachExistingBranch() {}, pruneWorktree() {}, changedFiles: () => ["src/a.js"],
      git: (args) => args[0] === "rev-parse" ? "head" : "diff summary",
    },
    gate: { detect: () => "true", run: () => ({ pass: true }) },
    scope: { count: () => 0 },
    notify: { phase() {}, writeRound() {}, buildDecisionBrief: () => "", escalate() {}, recordRun() {} },
    finalize: async () => ({ status: "merged", reason: "ok" }),
  };
  const result = await rotateRemedy({
    failure: { class: "REVIEW_STALEMATE", fingerprint: "stalemate" },
    cycle: { failedRole: "reviewer" }, record: { attempt: 1, excludedAgents: [] }, run,
    selectRoles: nextAuthor,
    runCycle: (cycle) => executeCycle({ ...run, ...cycle, resume: true }, deps),
  });
  assert.equal(result.cycle.rounds, 1);
  assert.deepEqual(rounds, [{ name: "c", round: 1 }]);
});

test("two-agent author rotation reports the blocked reviewer seat", async () => {
  const result = await rotateRemedy({
    failure: { class: "AGENT_QUOTA" },
    cycle: { failedRole: "author", failedAgents: [{ agent: "a", quota: true }] },
    record: { attempt: 1, excludedAgents: [] },
    run: {
      author: { agent: "a" }, reviewers: [{ agent: "b" }], cfg: { agents: ["a", "b"] },
      orchDir: mkdtempSync(join(tmpdir(), "orch-rotate-two-agent-")),
    },
    selectRoles: nextAuthor,
    runCycle: async () => assert.fail("a two-agent pool has no diverse replacement"),
  });
  assert.match(result.result.reason, /blocked by reviewer b/);
  assert.match(result.result.reason, /excluded a/);
});

test("rebase remedy uses the real integration branch and returns a fresh cycle", async () => {
  const repo = newRepo();
  git.git(["switch", "-c", "feature"], repo);
  commitFile(repo, "feature.txt", "feature\n", "feature change");
  git.git(["switch", "main"], repo);
  git.git(["switch", "-c", "orch/integration"], repo);
  commitFile(repo, "landed.txt", "landed\n", "landed on integration");
  git.git(["switch", "main"], repo);

  const failure = { status: "merge-deferred", class: "TEST_RED", fingerprint: "test-red-fp" };
  const result = await runUntil(
    READY_POLICY,
    {},
    readyDeps(repo, failure, remedyFor(repo)),
  );

  assert.equal(result.state, "READY");
  assert.equal(result.attempt, 1);
  assert.equal(git.git(["merge-base", "--is-ancestor", "orch/integration", "feature"], repo), "");
  assert.equal(git.git(["show", "feature:landed.txt"], repo), "landed");
  assert.equal(result.cycleResults.length, 2);
});

test("TEST_RED rebase runs the repair author even without a merge conflict", async () => {
  const repo = newRepo();
  git.git(["switch", "-c", "feature"], repo);
  commitFile(repo, "feature.txt", "feature\n", "feature change");
  git.git(["switch", "main"], repo);
  git.git(["switch", "-c", "orch/integration"], repo);
  commitFile(repo, "landed.txt", "landed\n", "landed on integration");
  git.git(["switch", "main"], repo);

  const author = {
    async author(_prompt, worktree) {
      writeFileSync(join(worktree, "repair.txt"), "repaired\n");
      git.git(["add", "repair.txt"], worktree);
      git.git(["commit", "-m", "repair failing test"], worktree);
    },
  };
  const failure = { status: "merge-deferred", class: "TEST_RED", fingerprint: "test-red-fp" };
  const result = await runUntil(
    READY_POLICY,
    {},
    readyDeps(repo, failure, remedyFor(repo, { author })),
  );

  assert.equal(result.state, "READY");
  assert.equal(git.git(["show", "feature:repair.txt"], repo), "repaired");
  assert.equal(result.cycleResults.length, 2);
});

test("rebase remedy refreshes a stale integration branch from origin", async () => {
  const repo = newRepo();
  const remote = addOrigin(repo);
  git.git(["switch", "-c", "feature"], repo);
  commitFile(repo, "feature.txt", "feature\n", "feature change");
  git.git(["switch", "main"], repo);
  git.git(["switch", "-c", "orch/integration"], repo);
  commitFile(repo, "landed.txt", "landed\n", "landed on integration");
  git.git(["push", "-u", "origin", "orch/integration"], repo);
  git.git(["switch", "main"], repo);

  const peer = cloneRemote(remote);
  git.git(["switch", "orch/integration"], peer);
  commitFile(peer, "remote-landed.txt", "remote\n", "remote integration change");
  git.git(["push", "origin", "orch/integration"], peer);

  const failure = { status: "merge-deferred", class: "LAND_DIRTY_MERGE", fingerprint: "origin-fp" };
  const result = await runUntil(
    READY_POLICY,
    {},
    readyDeps(repo, failure, remedyFor(repo)),
  );

  assert.equal(result.state, "READY");
  assert.equal(git.git(["show", "feature:remote-landed.txt"], repo), "remote");
});

test("rebase refreshes integration under merge.lock before rebasing", async () => {
  const repo = newRepo();
  git.git(["switch", "-c", "feature"], repo);
  commitFile(repo, "feature.txt", "feature\n", "feature change");
  git.git(["switch", "main"], repo);
  git.git(["switch", "-c", "orch/integration"], repo);
  commitFile(repo, "landed.txt", "landed\n", "landed on integration");
  git.git(["switch", "main"], repo);

  const calls = [];
  const lock = {
    async acquireBlocking(_dir, name) { calls.push(["acquire", name]); return true; },
    releaseLock(_dir, name) { calls.push(["release", name]); },
  };
  const failure = { status: "merge-deferred", class: "LAND_DIRTY_MERGE", fingerprint: "lock-fp" };
  await runUntil(
    READY_POLICY,
    {},
    readyDeps(repo, failure, remedyFor(repo, {
      lock,
      gitOverrides: {
        ensureIntegrationWorktree(...args) {
          calls.push(["ensure", calls.at(-1)?.[1]]);
          return git.ensureIntegrationWorktree(...args);
        },
        reconcileIntegrationToOrigin(...args) {
          calls.push(["reconcile", calls.at(-1)?.[1]]);
          return git.reconcileIntegrationToOrigin(...args);
        },
      },
    })),
  );
  assert.deepEqual(calls.slice(0, 4), [
    ["acquire", "merge.lock"],
    ["ensure", "merge.lock"],
    ["reconcile", "merge.lock"],
    ["release", "merge.lock"],
  ]);
});

test("an executed rebase failure keeps the consumed attempt", async () => {
  const repo = newRepo();
  git.git(["switch", "-c", "feature"], repo);
  commitFile(repo, "feature.txt", "feature\n", "feature change");
  git.git(["switch", "main"], repo);
  git.git(["switch", "-c", "orch/integration"], repo);
  git.git(["switch", "main"], repo);

  const failure = { status: "merge-deferred", class: "LAND_DIRTY_MERGE", fingerprint: "executed-fp" };
  const result = await runUntil(
    READY_POLICY,
    {},
    readyDeps(repo, failure, remedyFor(repo, {
      gitOverrides: { rebaseBranchOnto: () => ({ ok: false, reason: "unmerged paths unreadable", executed: true }) },
    })),
  );
  assert.equal(result.attempt, 1);
  assert.match(result.reason, /unmerged paths unreadable/);
});

test("rebase remedy preserves a conflict for the author, then finishes the real rebase", async () => {
  const repo = newRepo();
  git.git(["switch", "-c", "feature"], repo);
  commitFile(repo, "a.txt", "feature\n", "feature change");
  git.git(["switch", "main"], repo);
  git.git(["switch", "-c", "orch/integration"], repo);
  commitFile(repo, "a.txt", "integration\n", "landed conflicting change");
  git.git(["switch", "main"], repo);

  const prompts = [];
  const author = {
    async author(prompt, worktree) {
      prompts.push({ prompt, worktree });
      assert.equal(existsSync(worktree), true);
      writeFileSync(join(worktree, "a.txt"), "repaired\n");
      git.git(["add", "-A"], worktree);
      git.git(["commit", "-m", "repair rebase conflict"], worktree);
    },
  };
  const failure = { status: "merge-deferred", class: "LAND_DIRTY_MERGE", fingerprint: "dirty-fp" };
  const result = await runUntil(
    READY_POLICY,
    {},
    readyDeps(repo, failure, remedyFor(repo, { author })),
  );

  assert.equal(result.state, "READY");
  assert.equal(result.attempt, 1);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0].prompt, /Failure class: LAND_DIRTY_MERGE/);
  assert.match(prompts[0].prompt, /a\.txt/);
  assert.match(prompts[0].prompt, /run the relevant tests yourself/i);
  assert.match(prompts[0].prompt, /do not widen scope/i);
  assert.equal(git.git(["show", "feature:a.txt"], repo), "repaired");
  assert.equal(git.git(["merge-base", "--is-ancestor", "orch/integration", "feature"], repo), "");
  assert.equal(existsSync(join(repo, ".orch", "wt", "rebase-feature")), false);
});

test("rebase remedy reports a missing branch and restores the consumed attempt", async () => {
  const repo = newRepo();
  const failure = { status: "merge-deferred", class: "LAND_DIRTY_MERGE", fingerprint: "missing-fp" };
  const result = await runUntil(
    READY_POLICY,
    {},
    readyDeps(repo, failure, remedyFor(repo, { branch: "missing" })),
  );

  assert.equal(result.state, "STOPPED_AT_CAP");
  assert.equal(result.attempt, 0);
  assert.match(result.reason, /branch missing does not exist/);
  assert.equal(existsSync(join(repo, ".orch", "wt", "rebase-missing")), false);
});

test("§12 lock order: acquiring a righthand lock while holding a lefthand one is legal", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-remedies-"));
  assert.equal(acquireLock(d, LOCK_NAMES.STANDING_PR), true);
  assert.equal(acquireLock(d, LOCK_NAMES.MERGE), true); // standing-pr.lock -> merge.lock: legal
  releaseLock(d, LOCK_NAMES.MERGE);
  releaseLock(d, LOCK_NAMES.STANDING_PR);
});

test("§12 lock order: acquiring a lefthand lock while holding a righthand one throws", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-remedies-"));
  assert.equal(acquireLock(d, LOCK_NAMES.MERGE), true);
  assert.throws(
    () => acquireLock(d, LOCK_NAMES.STANDING_PR),
    /lock order violation/,
    "merge.lock -> standing-pr.lock is the reverse of §12's order and must be rejected, not silently allowed",
  );
  releaseLock(d, LOCK_NAMES.MERGE);
});

test("integration-repair.lock: a losing peer's acquire returns false synchronously, not an acquireBlocking() promise", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-remedies-"));
  assert.equal(acquireLock(d, LOCK_NAMES.INTEGRATION_REPAIR), true); // winner
  const lostRace = acquireLock(d, LOCK_NAMES.INTEGRATION_REPAIR); // loser: plain acquireLock, not acquireBlocking
  assert.equal(lostRace, false); // a Promise (acquireBlocking's return) fails this equality, not just resolves falsy
  releaseLock(d, LOCK_NAMES.INTEGRATION_REPAIR);
});

test("§12 lock order: integration-repair.lock -> merge.lock is legal (the repair ff/push edge, 'not optional')", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-remedies-"));
  assert.equal(acquireLock(d, LOCK_NAMES.INTEGRATION_REPAIR), true);
  assert.equal(acquireLock(d, LOCK_NAMES.MERGE), true); // nested merge.lock while still holding integration-repair.lock
  releaseLock(d, LOCK_NAMES.MERGE);
  releaseLock(d, LOCK_NAMES.INTEGRATION_REPAIR);
});

test("§12 lock order: acquiring integration-repair.lock while holding merge.lock throws (reverse of the 'not optional' edge)", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-remedies-"));
  assert.equal(acquireLock(d, LOCK_NAMES.MERGE), true);
  assert.throws(
    () => acquireLock(d, LOCK_NAMES.INTEGRATION_REPAIR),
    /lock order violation/,
    "merge.lock -> integration-repair.lock reverses §12's order and must be rejected",
  );
  releaseLock(d, LOCK_NAMES.MERGE);
});

test("§12 lock order: holding merge.lock in one orchDir does not block a lock acquire in an unrelated orchDir", () => {
  const a = mkdtempSync(join(tmpdir(), "orch-remedies-a-"));
  const b = mkdtempSync(join(tmpdir(), "orch-remedies-b-"));
  assert.equal(acquireLock(a, LOCK_NAMES.MERGE), true); // held in orchDir a
  assert.doesNotThrow(() => acquireLock(b, LOCK_NAMES.CYCLE)); // unrelated orchDir — independent lock namespace
  releaseLock(b, LOCK_NAMES.CYCLE);
  releaseLock(a, LOCK_NAMES.MERGE);
});

test("§12 lock order: a refused release clears the order-tracking entry too, not just a successful one", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-remedies-"));
  const mergePath = join(d, LOCK_NAMES.MERGE);
  assert.equal(acquireLock(d, LOCK_NAMES.MERGE), true); // we believe we hold merge.lock (idx 3)
  writeFileSync(mergePath, String(process.pid + 1)); // simulate a steal: someone else now owns the file
  assert.equal(releaseLock(d, LOCK_NAMES.MERGE), false); // refused — not our pid
  // A stale idx-3 entry here would make this legitimate lower-order acquire
  // throw a spurious order violation even though we hold nothing.
  assert.doesNotThrow(() => acquireLock(d, LOCK_NAMES.STANDING_PR));
  releaseLock(d, LOCK_NAMES.STANDING_PR);
});

test("releaseLock ownership check: a cycle cannot release a lock it does not hold", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-remedies-"));
  const lockPath = join(d, LOCK_NAMES.INTEGRATION_REPAIR);
  const peerPid = String(process.pid + 1); // not us; staleness is irrelevant since we never call acquireLock here
  writeFileSync(lockPath, peerPid);
  assert.equal(releaseLock(d, LOCK_NAMES.INTEGRATION_REPAIR), false);
  // the peer's lock survives untouched — a losing peer that (incorrectly)
  // tried to release it must not clear the way for a second resolver.
  assert.equal(readFileSync(lockPath, "utf8"), peerPid);
});


// ---------------------------------------------------------------------------
// Integration repair (design §10A, P6 split 4a/4). This slice repairs
// REMOTE_BEHIND only — no resolver, no security scan, no audit, so nothing
// below runs an agent. The resolver paths are #569.
//
// Every case runs against a REAL temporary repository with a real origin. A
// stubbed `git` cannot see the failures that matter here (a merge that is not a
// fast-forward, a rolled-back worktree, a lost push race), which is why the
// suite is shaped this way and must stay that way.

function repairFixture() {
  const repo = newRepo();
  const remote = addOrigin(repo);
  git.git(["switch", "-c", "orch/integration"], repo);
  commitFile(repo, "shared.txt", "integration side\n", "integration change");
  git.git(["push", "-u", "origin", "orch/integration"], repo);
  git.git(["switch", "main"], repo);
  commitFile(repo, "shared.txt", "base side\n", "base change");
  commitFile(repo, "package.json", '{"version":"9.9.9"}\n', "base version bump");
  git.git(["push", "origin", "main"], repo);
  // Drop the remote-tracking refs the pushes left behind: the repair must
  // fetch `origin/<branch>` itself (criterion 7), not ride a stale snapshot.
  git.gitTry(["update-ref", "-d", "refs/remotes/origin/orch/integration"], repo);
  return { repo, remote };
}

// Plays GitHub's server-side update-branch for real: a peer clone merges base
// into the PR branch and pushes it, which is exactly what the `gh api
// .../update-branch` call the repair makes does remotely. Returns the `gh` stub
// that performs it.
function peerUpdateBranch(remote, branch) {
  const peer = cloneRemote(remote);
  git.git(["switch", branch], peer);
  git.git(["merge", "--no-edit", "-X", "theirs", "origin/main"], peer);
  return (args) => {
    if (args[0] === "api") { git.git(["push", "origin", branch], peer); return "{}"; }
    return "";
  };
}

function repairCfg(overrides = {}) {
  const { main: mainOverrides, ...rest } = overrides;
  return {
    baseBranch: "main",
    integrationBranch: "orch/integration",
    test: "auto",
    stageTimeout: 7,
    main: { autoResolveConflictPaths: ["package.json"], ...(mainOverrides || {}) },
    ...rest,
  };
}

function runRepair(repo, { cfg = repairCfg(), gh = () => "{}", branch = "orch/integration", landing = "standing", failureClass = "REMOTE_BEHIND", failureSummary, prNumber = 9, gitDep = git, sleep = async () => {}, lock = null, record = { attempt: 1, failures: [] }, gate = { detect: () => "true", run: () => ({ pass: true, log: "" }) }, adapters = null } = {}) {
  return integrationRepairRemedy({
    name: "integration-repair",
    failure: { class: failureClass, fingerprint: "fp", ...(failureSummary !== undefined ? { summary: failureSummary } : {}) },
    record,
    cycle: { status: "merged" },
    run: { repo, orchDir: join(repo, ".orch"), sid: "sidtest", cfg },
    deps: { git: gitDep, gate, sleep, ...(lock ? { lock } : {}), ...(adapters ? { adapters } : {}) },
    resolveLanded: () => ({ pr: { number: prNumber }, landing, branch }),
    gh,
  });
}

// A clean-merge counterpart to `repairFixture()`: base and integration touch
// disjoint files, so `git merge` never conflicts. REMOTE_CI_RED's "checks were
// red on an otherwise clean merge" branch (`repairConflictOrRed`) is only
// reachable through a fixture shaped this way — `repairFixture()`'s shared.txt
// add/add always conflicts, which exercises the OTHER branch regardless of
// `cls`.
function cleanRepairFixture() {
  const repo = newRepo();
  const remote = addOrigin(repo);
  git.git(["switch", "-c", "orch/integration"], repo);
  commitFile(repo, "integration-only.txt", "integration\n", "integration change");
  git.git(["push", "-u", "origin", "orch/integration"], repo);
  git.git(["switch", "main"], repo);
  commitFile(repo, "base-only.txt", "base\n", "base change");
  git.git(["push", "origin", "main"], repo);
  git.gitTry(["update-ref", "-d", "refs/remotes/origin/orch/integration"], repo);
  return { repo, remote };
}

// A resolver stub in the shape `repairConflictOrRed` expects from
// `adapters.get(agent).author`/`.audit`: it stages and commits its own work
// (the way the real CLI adapter's `captureAuthorWork` does), so the harness's
// "commit if MERGE_HEAD is still open" fallback never has to run.
function fakeAdapters(byAgent) {
  return {
    get(name) {
      const entry = byAgent[name];
      if (!entry) throw new Error(`no agent may start for ${name}`);
      return entry;
    },
  };
}

const originSha = (remote, branch) => git.git(["rev-parse", branch], remote);

test("integration repair: REMOTE_BEHIND updates the PR branch, gates the new tip and reconciles locally", async () => {
  const { repo, remote } = repairFixture();
  const ghCalls = [];
  const peer = peerUpdateBranch(remote, "orch/integration");
  const gh = (args) => { ghCalls.push(args); return peer(args); };

  const out = await runRepair(repo, { gh });

  assert.equal(out.cycle?.status, "merged", out.result?.reason);
  assert.ok(ghCalls.some((a) => a.join(" ").includes("update-branch")));
  assert.equal(
    git.git(["rev-parse", "orch/integration"], repo),
    originSha(remote, "orch/integration"),
    "the local integration branch must be fast-forwarded onto the repaired tip",
  );
});

// §10A acceptance criterion 2: "manual means manual" — the default, and the
// only mode a repo gets without an explicit opt-in. Checked BEFORE a resolver
// is constructed, so `fakeAdapters({})` (every `.get()` throws) proves no
// agent process starts at all.
test("integration repair: conflictResolution manual refuses a merge conflict before starting any agent", async () => {
  const { repo, remote } = repairFixture();
  const before = originSha(remote, "orch/integration");

  for (const cls of ["REMOTE_CONFLICTING", "REMOTE_CI_RED"]) {
    const out = await runRepair(repo, { failureClass: cls, adapters: fakeAdapters({}) });
    assert.equal(out.cycle, undefined);
    assert.match(out.result.reason, /conflictResolution is manual/);
    assert.equal(originSha(remote, "orch/integration"), before);
  }
});

// The other manual-gated branch: a clean merge with red checks (REMOTE_CI_RED
// only), reached exclusively through `cleanRepairFixture()` since
// `repairFixture()`'s add/add conflict always takes the other branch above.
test("integration repair: conflictResolution manual refuses a red check on a clean merge before starting any agent", async () => {
  const { repo, remote } = cleanRepairFixture();
  const before = originSha(remote, "orch/integration");

  const out = await runRepair(repo, { failureClass: "REMOTE_CI_RED", adapters: fakeAdapters({}) });
  assert.equal(out.cycle, undefined);
  assert.match(out.result.reason, /conflictResolution is manual/);
  assert.equal(originSha(remote, "orch/integration"), before);
});

// §10A acceptance criterion 1: auto resolve, happy path. A two-agent rotation
// pool so the reviewer differs from the resolver (criterion 4 covers the
// single-agent self-review refusal separately), the resolver keeps an ordinary
// non-allowlisted path as "ours", the reviewer AGREEs, and the repair lands.
test("integration repair: REMOTE_CONFLICTING audits an ordinary ours resolution and lands", async () => {
  const { repo, remote } = repairFixture();
  const cfg = repairCfg({
    main: {
      conflictResolution: "auto",
      conflictResolutionResolvers: [{ agent: "resolver", model: null, effort: null }, { agent: "reviewer", model: null, effort: null }],
    },
  });
  const calls = [];
  const adapters = fakeAdapters({
    resolver: {
      async author(prompt, wd) {
        calls.push("author");
        writeFileSync(join(wd, "shared.txt"), "integration side\n");
        git.git(["add", "-A"], wd);
        git.git(["commit", "-m", "resolve conflict"], wd);
      },
    },
    reviewer: {
      async audit(branch, wd) {
        calls.push("audit");
        return { decision: "AGREE", reason: "reconstructs both sides" };
      },
    },
  });

  const out = await runRepair(repo, { cfg, failureClass: "REMOTE_CONFLICTING", adapters });

  assert.equal(out.cycle?.status, "merged", out.result?.reason);
  assert.deepEqual(calls, ["author", "audit"]);
  assert.equal(git.git(["show", "orch/integration:shared.txt"], repo), "integration side");
  assert.equal(originSha(remote, "orch/integration"), git.git(["rev-parse", "orch/integration"], repo));
  const baseTip = originSha(remote, "main");
  const integrationTip = originSha(remote, "orch/integration");
  assert.ok(
    git.gitTry(["merge-base", "--is-ancestor", baseTip, integrationTip], remote).ok,
    "the landed integration tip must contain the base tip",
  );
});

test("integration repair: a timed-out resolver gets the stage timeout and releases integration-repair.lock", async () => {
  const { repo } = repairFixture();
  const cfg = repairCfg({ main: { conflictResolution: "auto" } });
  let timeoutMs;
  const adapters = fakeAdapters({
    claude: {
      async author(_prompt, _wd, options) {
        timeoutMs = options.stageTimeoutMs;
        throw new Error("resolver stage timed out");
      },
    },
  });

  const out = await runRepair(repo, { cfg, adapters, failureClass: "REMOTE_CONFLICTING" });

  assert.equal(timeoutMs, 420_000);
  assert.match(out.result.reason, /resolver failed: resolver stage timed out/);
  assert.equal(existsSync(join(repo, ".orch", LOCK_NAMES.INTEGRATION_REPAIR)), false);
});

test("integration repair: a resolver preservation request keeps its recovery worktree and branch", async () => {
  const { repo } = repairFixture();
  const cfg = repairCfg({ main: { conflictResolution: "auto" } });
  const scratch = join(repo, ".orch", "wt", "orch-repair-sidtest");
  const preserved = Object.assign(new Error("resolver stage timed out"), { preserveWorktree: true });
  const adapters = fakeAdapters({
    claude: {
      async author(_prompt, wd) {
        writeFileSync(join(wd, "recovery.txt"), "inspect me\n");
        throw preserved;
      },
    },
  });

  const out = await runRepair(repo, { cfg, adapters, failureClass: "REMOTE_CONFLICTING" });

  assert.equal(out.cycle, undefined);
  assert.match(out.result.reason, /worktree preserved at .*orch-repair-sidtest/);
  assert.equal(existsSync(scratch), true, "the failed resolver worktree must remain available");
  assert.equal(
    git.git(["rev-parse", "--verify", "refs/heads/orch-repair-sidtest"], repo),
    git.git(["rev-parse", "HEAD"], scratch),
    "the recovery branch must remain attached to the preserved worktree",
  );
  assert.notEqual(git.git(["status", "--porcelain"], scratch), "", "the merge state must remain inspectable");
});

test("integration repair: an abort-then-commit resolver cannot land a tip without base ancestry", async () => {
  const { repo, remote } = repairFixture();
  const before = originSha(remote, "orch/integration");
  const cfg = repairCfg({
    main: {
      conflictResolution: "auto",
      conflictResolutionResolvers: [{ agent: "resolver", model: null, effort: null }, { agent: "reviewer", model: null, effort: null }],
    },
  });
  const calls = [];
  const adapters = fakeAdapters({
    resolver: {
      async author(prompt, wd) {
        calls.push("author");
        git.git(["merge", "--abort"], wd);
        writeFileSync(join(wd, "shared.txt"), "resolution without base\n");
        git.git(["add", "-A"], wd);
        git.git(["commit", "-m", "abort merge then commit"], wd);
      },
    },
    reviewer: { async audit() { calls.push("audit"); return { decision: "AGREE" }; } },
  });

  const out = await runRepair(repo, { cfg, failureClass: "REMOTE_CONFLICTING", adapters });

  assert.equal(out.cycle, undefined);
  assert.match(out.result.reason, /does not contain origin\/main in its ancestry/);
  assert.deepEqual(calls, ["author"], "ancestry must be checked before gate or audit");
  assert.equal(originSha(remote, "orch/integration"), before, "a candidate without base ancestry must not be pushed");
});

// §10A acceptance criterion 3: markers never land. `git add -A` + `git commit`
// (what a resolver's `author()` does) succeeds mid-merge even with raw
// `<<<<<<<` markers still in the file, which is why this floor exists.
test("integration repair: a resolution that leaves conflict markers is refused, nothing lands", async () => {
  const { repo, remote } = repairFixture();
  const before = originSha(remote, "orch/integration");
  const cfg = repairCfg({
    main: {
      conflictResolution: "auto",
      conflictResolutionResolvers: [{ agent: "resolver", model: null, effort: null }, { agent: "reviewer", model: null, effort: null }],
    },
  });
  const calls = [];
  const adapters = fakeAdapters({
    resolver: {
      async author(prompt, wd) {
        calls.push("author");
        writeFileSync(join(wd, "shared.txt"), "<<<<<<< ours\nmine\n=======\ntheirs\n>>>>>>> theirs\n");
        git.git(["add", "-A"], wd);
        git.git(["commit", "-m", "left markers behind"], wd);
      },
    },
    reviewer: { async audit() { calls.push("audit"); return { decision: "AGREE" }; } },
  });

  const out = await runRepair(repo, { cfg, failureClass: "REMOTE_CONFLICTING", adapters });

  assert.equal(out.cycle, undefined);
  assert.match(out.result.reason, /left conflict markers/);
  assert.deepEqual(calls, ["author"], "the marker floor must refuse before the reviewer is ever asked");
  assert.equal(originSha(remote, "orch/integration"), before);
});

// Same floor, on the clean REMOTE_CI_RED path where no merge conflict ever
// existed — the harness has nothing else that would ever look at this file.
test("integration repair: a REMOTE_CI_RED resolution that leaves conflict markers is refused on a clean merge too", async () => {
  const { repo, remote } = cleanRepairFixture();
  const before = originSha(remote, "orch/integration");
  const cfg = repairCfg({ main: { conflictResolution: "auto" } });
  const adapters = fakeAdapters({
    claude: {
      async author(prompt, wd) {
        writeFileSync(join(wd, "notes.txt"), "<<<<<<< ours\nmine\n=======\ntheirs\n>>>>>>> theirs\n");
        git.git(["add", "-A"], wd);
        git.git(["commit", "-m", "red-check repair leaves markers"], wd);
      },
    },
  });

  const out = await runRepair(repo, { cfg, failureClass: "REMOTE_CI_RED", adapters });

  assert.equal(out.cycle, undefined);
  assert.match(out.result.reason, /left conflict markers/);
  assert.equal(originSha(remote, "orch/integration"), before);
});

// The marker floor greps the WORKING TREE (git.js:79's `git grep` with no
// revision argument reads files on disk); the pushed `candidateSha` is
// whatever got committed. A resolver that edits the conflicted file on disk
// without ever running `git add` (every other fixture in this file stages and
// commits itself, so this is the one path that reaches the harness's own
// "commit if MERGE_HEAD is still open" fallback) used to leave the INDEX at
// whatever `git add -A` staged BEFORE the resolver ran — raw conflict markers,
// since that add only exists to let `write-tree` pin `resolverBase`. Without
// re-staging before that fallback commit, the floor greps the resolver's
// clean disk edit while `candidateSha` pins the stale, still-conflicted tree
// underneath it — the floor passes, and the markers are what land.
test("integration repair: a resolver that edits the conflict on disk without staging still lands its actual edit, not the stale pre-resolution index", async () => {
  const { repo, remote } = repairFixture();
  const cfg = repairCfg({
    main: {
      conflictResolution: "auto",
      conflictResolutionResolvers: [{ agent: "resolver", model: null, effort: null }, { agent: "reviewer", model: null, effort: null }],
    },
  });
  const calls = [];
  const adapters = fakeAdapters({
    resolver: {
      async author(prompt, wd) {
        calls.push("author");
        // No `git add`, no `git commit` — the way a real CLI agent leaves the
        // worktree (see `captureAuthorWork`'s own comment: "cannot be trusted
        // to commit"), simulated directly rather than through that adapter.
        writeFileSync(join(wd, "shared.txt"), "resolved on disk only\n");
      },
    },
    reviewer: {
      async audit(branch, wd) {
        calls.push("audit");
        return { decision: "AGREE", reason: "reconstructs both sides" };
      },
    },
  });

  const out = await runRepair(repo, { cfg, failureClass: "REMOTE_CONFLICTING", adapters });

  assert.equal(out.cycle?.status, "merged", out.result?.reason);
  assert.deepEqual(calls, ["author", "audit"]);
  assert.equal(git.git(["show", "orch/integration:shared.txt"], repo), "resolved on disk only");
  assert.equal(originSha(remote, "orch/integration"), git.git(["rev-parse", "orch/integration"], repo));
});

// §10A acceptance criterion 4: self-review is refused. A single-agent pool
// (the DEFAULT_RESOLVERS fallback: just "claude") can resolve the conflict,
// but nothing differs from it to audit the result, so the repair fails closed
// instead of letting the resolver bless its own work.
test("integration repair: a single-agent pool cannot audit its own resolution and the repair fails closed", async () => {
  const { repo, remote } = repairFixture();
  const before = originSha(remote, "orch/integration");
  const cfg = repairCfg({ main: { conflictResolution: "auto" } });
  const calls = [];
  const adapters = fakeAdapters({
    claude: {
      async author(prompt, wd) {
        calls.push("author");
        writeFileSync(join(wd, "shared.txt"), "resolved solo\n");
        git.git(["add", "-A"], wd);
        git.git(["commit", "-m", "resolve conflict solo"], wd);
      },
      async audit() { calls.push("self-audit"); return { decision: "AGREE" }; },
    },
  });

  const out = await runRepair(repo, { cfg, failureClass: "REMOTE_CONFLICTING", adapters });

  assert.equal(out.cycle, undefined);
  assert.match(out.result.reason, /no conflict reviewer configured/);
  assert.deepEqual(calls, ["author"], "the resolver ran, but its own audit method must never be called");
  assert.equal(originSha(remote, "orch/integration"), before);
});

// The clean REMOTE_CI_RED path has no MERGE_HEAD, so it has no equivalent of
// the conflict branch's post-resolver commit fallback — and does not need
// one, PROVIDED it refuses instead of reporting success when the resolver
// leaves HEAD exactly where it found it. A resolver that reports success
// without moving HEAD (the default pool, a fully compliant adapter, an agent
// that judges there is nothing to change) must not reach `landRepairedTip`:
// `resolverPaths` would come back empty, which skips the marker floor, the
// security scan AND the audit, and the untouched merge tip would be reported
// merged without ever having repaired the red check.
test("integration repair: a REMOTE_CI_RED resolver that commits nothing is refused, not reported merged", async () => {
  const { repo, remote } = cleanRepairFixture();
  const before = originSha(remote, "orch/integration");
  const cfg = repairCfg({ main: { conflictResolution: "auto" } });
  const calls = [];
  const adapters = fakeAdapters({
    claude: {
      async author(prompt) {
        calls.push("author");
        assert.match(prompt, /Details: failing checks: lint/);
        // Reports success without touching the worktree at all.
      },
    },
  });

  const out = await runRepair(repo, {
    cfg,
    failureClass: "REMOTE_CI_RED",
    failureSummary: "failing checks: lint",
    adapters,
  });

  assert.equal(out.cycle, undefined);
  assert.match(out.result.reason, /resolver committed nothing/);
  assert.deepEqual(calls, ["author"]);
  assert.equal(originSha(remote, "orch/integration"), before);
});

test("integration repair: a red resolution gate is refused before the reviewer and landing", async () => {
  const { repo, remote } = repairFixture();
  const before = originSha(remote, "orch/integration");
  const cfg = repairCfg({
    main: {
      conflictResolution: "auto",
      conflictResolutionResolvers: [{ agent: "resolver", model: null, effort: null }, { agent: "reviewer", model: null, effort: null }],
    },
  });
  const calls = [];
  const adapters = fakeAdapters({
    resolver: {
      async author(prompt, wd) {
        calls.push("author");
        writeFileSync(join(wd, "shared.txt"), "resolved together\n");
        git.git(["add", "-A"], wd);
        git.git(["commit", "-m", "resolve conflict"], wd);
      },
    },
    reviewer: { async audit() { calls.push("audit"); return { decision: "AGREE" }; } },
  });
  const gate = { detect: () => "true", run: () => ({ pass: false, log: "red" }) };

  const out = await runRepair(repo, { cfg, failureClass: "REMOTE_CONFLICTING", adapters, gate });

  assert.equal(out.cycle, undefined);
  assert.match(out.result.reason, /gate red on the resolution/);
  assert.deepEqual(calls, ["author"], "a red resolution must not reach review");
  assert.equal(originSha(remote, "orch/integration"), before);
});

test("integration repair: a security finding blocks the resolution before review", async () => {
  const { repo, remote } = repairFixture();
  const before = originSha(remote, "orch/integration");
  const cfg = repairCfg({
    main: {
      conflictResolution: "auto",
      conflictResolutionResolvers: [{ agent: "resolver", model: null, effort: null }, { agent: "reviewer", model: null, effort: null }],
    },
  });
  const calls = [];
  const adapters = fakeAdapters({
    resolver: {
      async author(prompt, wd) {
        calls.push("author");
        writeFileSync(join(wd, "shared.txt"), "resolved together\n");
        writeFileSync(join(wd, "network.js"), 'fetch("https://example.test");\n');
        git.git(["add", "-A"], wd);
        git.git(["commit", "-m", "unsafe resolution"], wd);
      },
    },
    reviewer: { async audit() { calls.push("audit"); return { decision: "AGREE" }; } },
  });

  const out = await runRepair(repo, { cfg, failureClass: "REMOTE_CONFLICTING", adapters });

  assert.equal(out.cycle, undefined);
  assert.equal(out.result.failureClass, "SECURITY_FINDING");
  assert.equal(out.result.exit, 3);
  assert.deepEqual(calls, ["author"], "a security finding must block before review");
  assert.equal(originSha(remote, "orch/integration"), before);
});

test("integration repair: a reviewer DISAGREE refuses the resolution", async () => {
  const { repo, remote } = repairFixture();
  const before = originSha(remote, "orch/integration");
  const cfg = repairCfg({
    main: {
      conflictResolution: "auto",
      conflictResolutionResolvers: [{ agent: "resolver", model: null, effort: null }, { agent: "reviewer", model: null, effort: null }],
    },
  });
  const calls = [];
  const adapters = fakeAdapters({
    resolver: {
      async author(prompt, wd) {
        calls.push("author");
        writeFileSync(join(wd, "shared.txt"), "resolved together\n");
        git.git(["add", "-A"], wd);
        git.git(["commit", "-m", "resolve conflict"], wd);
      },
    },
    reviewer: {
      async audit() {
        calls.push("audit");
        return { decision: "DISAGREE", reason: "the resolution drops base behavior" };
      },
    },
  });

  const out = await runRepair(repo, { cfg, failureClass: "REMOTE_CONFLICTING", adapters });

  assert.equal(out.cycle, undefined);
  assert.match(out.result.reason, /drops base behavior/);
  assert.deepEqual(calls, ["author", "audit"]);
  assert.equal(originSha(remote, "orch/integration"), before);
});

test("integration repair: a failed resolver retries with the next rotation seat", async () => {
  const { repo, remote } = repairFixture();
  const before = originSha(remote, "orch/integration");
  const cfg = repairCfg({
    main: {
      conflictResolution: "auto",
      conflictResolutionResolvers: [{ agent: "dead", model: null, effort: null }, { agent: "good", model: null, effort: null }],
    },
  });
  const calls = [];
  const adapters = fakeAdapters({
    dead: {
      async author() {
        calls.push("dead-author");
        throw new Error("seat unavailable");
      },
      async audit() {
        calls.push("dead-audit");
        return { decision: "AGREE" };
      },
    },
    good: {
      async author(prompt, wd) {
        calls.push("good-author");
        writeFileSync(join(wd, "shared.txt"), "resolved by next seat\n");
        git.git(["add", "-A"], wd);
        git.git(["commit", "-m", "resolve with next seat"], wd);
      },
    },
  });

  const first = await runRepair(repo, { cfg, failureClass: "REMOTE_CONFLICTING", adapters });
  assert.equal(first.cycle?.status, "merged");
  assert.deepEqual(first.record.failures, []);
  assert.deepEqual(calls, ["dead-author"]);
  assert.equal(originSha(remote, "orch/integration"), before);

  const second = await runRepair(repo, { cfg, failureClass: "REMOTE_CONFLICTING", adapters, record: first.record });
  assert.equal(second.cycle?.status, "merged", second.result?.reason);
  assert.deepEqual(calls, ["dead-author", "good-author", "dead-audit"]);
  assert.notEqual(originSha(remote, "orch/integration"), before);
});

// The gate runs the repository's own test command — arbitrary code — inside
// the writable scratch worktree that holds the pinned `candidateSha`. If that
// command commits anything, the tree that would be pushed is no longer the
// tree the marker floor, the security scan and `candidateSha` itself all
// described. `unmoved("gate")` is the only thing that catches this, and had
// no test.
test("integration repair: a gate command that commits into the scratch worktree is refused, not landed", async () => {
  const { repo, remote } = repairFixture();
  const before = originSha(remote, "orch/integration");
  const cfg = repairCfg({
    main: {
      conflictResolution: "auto",
      conflictResolutionResolvers: [{ agent: "resolver", model: null, effort: null }, { agent: "reviewer", model: null, effort: null }],
    },
  });
  const calls = [];
  const adapters = fakeAdapters({
    resolver: {
      async author(prompt, wd) {
        calls.push("author");
        writeFileSync(join(wd, "shared.txt"), "resolved together\n");
        git.git(["add", "-A"], wd);
        git.git(["commit", "-m", "resolve conflict"], wd);
      },
    },
    reviewer: { async audit() { calls.push("audit"); return { decision: "AGREE" }; } },
  });
  const gate = {
    detect: () => "true",
    run: (cmd, wd) => {
      writeFileSync(join(wd, "gate-wrote-this.txt"), "not part of the resolution\n");
      git.git(["add", "-A"], wd);
      git.git(["commit", "-m", "the test command committed"], wd);
      return { pass: true, log: "" };
    },
  };

  const out = await runRepair(repo, { cfg, failureClass: "REMOTE_CONFLICTING", adapters, gate });

  assert.equal(out.cycle, undefined);
  assert.match(out.result.reason, /moved the resolution/);
  assert.deepEqual(calls, ["author"], "a gate-stage commit must be caught before the audit ever runs");
  assert.equal(originSha(remote, "orch/integration"), before);
});

// Same guard, the audit side: the reviewer is an agent WITH TOOLS running in
// the same writable worktree, and is EXPECTED to read and not write.
// `unmoved("audit")` is what stands between an audit-stage commit and pushing
// content the audit never actually reviewed, and had no test either.
test("integration repair: an auditor that commits into the scratch worktree is refused, not landed", async () => {
  const { repo, remote } = repairFixture();
  const before = originSha(remote, "orch/integration");
  const cfg = repairCfg({
    main: {
      conflictResolution: "auto",
      conflictResolutionResolvers: [{ agent: "resolver", model: null, effort: null }, { agent: "reviewer", model: null, effort: null }],
    },
  });
  const calls = [];
  const adapters = fakeAdapters({
    resolver: {
      async author(prompt, wd) {
        calls.push("author");
        writeFileSync(join(wd, "shared.txt"), "resolved together\n");
        git.git(["add", "-A"], wd);
        git.git(["commit", "-m", "resolve conflict"], wd);
      },
    },
    reviewer: {
      async audit(branch, wd) {
        calls.push("audit");
        writeFileSync(join(wd, "audit-wrote-this.txt"), "not part of the resolution\n");
        git.git(["add", "-A"], wd);
        git.git(["commit", "-m", "the auditor committed"], wd);
        return { decision: "AGREE" };
      },
    },
  });

  const out = await runRepair(repo, { cfg, failureClass: "REMOTE_CONFLICTING", adapters });

  assert.equal(out.cycle, undefined);
  assert.match(out.result.reason, /moved the resolution/);
  assert.deepEqual(calls, ["author", "audit"]);
  assert.equal(originSha(remote, "orch/integration"), before);
});

// An allowlisted metadata path may be resolved as "ours" without becoming a
// terminal protected-path failure. This also exercises the guardrail-touch
// waiver after the content scan.
test("integration repair: an allowlisted package.json \"ours\" resolution is not terminal", async () => {
  const repo = newRepo();
  const remote = addOrigin(repo);
  git.git(["switch", "-c", "orch/integration"], repo);
  commitFile(repo, "package.json", '{"version":"1.0.0"}\n', "integration version");
  git.git(["push", "-u", "origin", "orch/integration"], repo);
  git.git(["switch", "main"], repo);
  commitFile(repo, "package.json", '{"version":"2.0.0"}\n', "base version bump");
  git.git(["push", "origin", "main"], repo);
  git.gitTry(["update-ref", "-d", "refs/remotes/origin/orch/integration"], repo);
  const before = originSha(remote, "orch/integration");
  const cfg = repairCfg({
    main: {
      conflictResolution: "auto",
      conflictResolutionResolvers: [{ agent: "resolver", model: null, effort: null }, { agent: "reviewer", model: null, effort: null }],
    },
  });
  const calls = [];
  const adapters = fakeAdapters({
    resolver: {
      async author(prompt, wd) {
        calls.push("author");
        // "ours": keep the integration side's content exactly, discarding
        // base's incoming version bump.
        writeFileSync(join(wd, "package.json"), '{"version":"1.0.0"}\n');
        git.git(["add", "-A"], wd);
        git.git(["commit", "-m", "keep our version"], wd);
      },
    },
    reviewer: { async audit() { calls.push("audit"); return { decision: "AGREE" }; } },
  });

  const out = await runRepair(repo, { cfg, failureClass: "REMOTE_CONFLICTING", adapters });

  assert.equal(out.cycle?.status, "merged", out.result?.reason);
  assert.deepEqual(calls, ["author"], "an allowlisted resolution skips the reviewer");
  assert.equal(git.git(["show", "orch/integration:package.json"], repo), '{"version":"1.0.0"}');
  assert.notEqual(originSha(remote, "orch/integration"), before);
});

test("integration repair: content-derived guardrail findings are not waived on allowlisted paths", async () => {
  const { repo, remote } = repairFixture();
  const before = originSha(remote, "orch/integration");
  const cfg = repairCfg({
    main: {
      conflictResolution: "auto",
      conflictResolutionResolvers: [{ agent: "resolver", model: null, effort: null }, { agent: "reviewer", model: null, effort: null }],
    },
  });
  const calls = [];
  const adapters = fakeAdapters({
    resolver: {
      async author(prompt, wd) {
        calls.push("author");
        writeFileSync(join(wd, "shared.txt"), "resolved together\n");
        writeFileSync(join(wd, "package.json"), '{"version":"9.9.9","name":"CODEOWNERS"}\n');
        git.git(["add", "-A"], wd);
        git.git(["commit", "-m", "unsafe metadata resolution"], wd);
      },
    },
    reviewer: { async audit() { calls.push("audit"); return { decision: "AGREE" }; } },
  });

  const out = await runRepair(repo, { cfg, failureClass: "REMOTE_CONFLICTING", adapters });

  assert.equal(out.cycle, undefined);
  assert.equal(out.result.failureClass, "SECURITY_FINDING");
  assert.equal(out.result.exit, 3);
  assert.deepEqual(calls, ["author"], "content-derived guardrail findings must block before review");
  assert.equal(originSha(remote, "orch/integration"), before);
});

test("integration repair: a non-allowlisted \"ours\" resolution is refused before any audit", async () => {
  const repo = newRepo();
  const remote = addOrigin(repo);
  git.git(["switch", "-c", "orch/integration"], repo);
  commitFile(repo, "CODEOWNERS", "integration owners\n", "integration owners");
  git.git(["push", "-u", "origin", "orch/integration"], repo);
  git.git(["switch", "main"], repo);
  commitFile(repo, "CODEOWNERS", "base owners\n", "base owners");
  git.git(["push", "origin", "main"], repo);
  git.gitTry(["update-ref", "-d", "refs/remotes/origin/orch/integration"], repo);
  const before = originSha(remote, "orch/integration");
  const cfg = repairCfg({
    main: {
      conflictResolution: "auto",
      conflictResolutionResolvers: [{ agent: "resolver", model: null, effort: null }, { agent: "reviewer", model: null, effort: null }],
    },
  });
  const calls = [];
  const adapters = fakeAdapters({
    resolver: {
      async author(prompt, wd) {
        calls.push("author");
        writeFileSync(join(wd, "CODEOWNERS"), "integration owners\n");
        git.git(["add", "-A"], wd);
        git.git(["commit", "-m", "keep our owners"], wd);
      },
    },
    reviewer: { async audit() { calls.push("audit"); return { decision: "AGREE" }; } },
  });

  const out = await runRepair(repo, { cfg, failureClass: "REMOTE_CONFLICTING", adapters });

  assert.equal(out.cycle, undefined);
  assert.equal(out.result.failureClass, "POLICY_PROTECTED_PATH");
  assert.match(out.result.reason, /CODEOWNERS/);
  assert.deepEqual(calls, ["author"], "the protected-path floor must refuse before the reviewer is ever asked");
  assert.equal(originSha(remote, "orch/integration"), before);
});

test("integration repair: conflictResolution propose publishes the resolution and pushes nothing", async () => {
  const { repo, remote } = repairFixture();
  const before = originSha(remote, "orch/integration");
  const cfg = repairCfg({
    main: {
      conflictResolution: "propose",
      conflictResolutionResolvers: [{ agent: "resolver", model: null, effort: null }, { agent: "reviewer", model: null, effort: null }],
    },
  });
  const comments = [];
  const adapters = fakeAdapters({
    resolver: {
      async author(prompt, wd) {
        writeFileSync(join(wd, "shared.txt"), "integration side\nbase side\n");
        git.git(["add", "-A"], wd);
        git.git(["commit", "-m", "propose resolution"], wd);
      },
    },
    reviewer: { async audit() { return { decision: "AGREE", reason: "ready for human review" }; } },
  });
  const gh = (args) => { comments.push(args); return ""; };

  const out = await runRepair(repo, { cfg, failureClass: "REMOTE_CONFLICTING", adapters, gh });

  assert.equal(out.result.failureClass, "REMOTE_REVIEW_REQUIRED", out.result?.reason);
  assert.equal(out.result.exit, 2);
  const comment = comments.find((args) => args[0] === "pr" && args[1] === "comment");
  assert.ok(comment);
  assert.match(comment.join(" "), /Class: REMOTE_CONFLICTING/);
  assert.match(comment.join(" "), /Files: shared\.txt/);
  assert.match(comment.join(" "), /Resolver: resolver/);
  assert.match(comment.join(" "), /Resolution branch: orch-repair-sidtest/);
  const proposedSha = comment.join(" ").match(/Resolution: ([0-9a-f]{40})/)?.[1];
  assert.ok(proposedSha);
  assert.equal(git.git(["rev-parse", "refs/heads/orch-repair-sidtest"], repo), proposedSha);
  assert.equal(git.git(["show", `${proposedSha}:shared.txt`], repo), "integration side\nbase side");
  assert.equal(originSha(remote, "orch/integration"), before);
});

test("integration repair: propose preserves its resolution when publication fails", async () => {
  const { repo, remote } = repairFixture();
  const before = originSha(remote, "orch/integration");
  const cfg = repairCfg({
    main: {
      conflictResolution: "propose",
      conflictResolutionResolvers: [{ agent: "claude", model: null, effort: null }, { agent: "reviewer", model: null, effort: null }],
    },
  });
  const adapters = fakeAdapters({
    claude: {
      async author(prompt, wd) {
        writeFileSync(join(wd, "shared.txt"), "preserved proposal\n");
        git.git(["add", "-A"], wd);
        git.git(["commit", "-m", "preserve proposal"], wd);
      },
    },
    reviewer: { async audit() { return { decision: "AGREE" }; } },
  });

  const out = await runRepair(repo, {
    cfg, failureClass: "REMOTE_CONFLICTING", adapters,
    gh: () => { throw new Error("gh: 403 Forbidden"); },
  });

  assert.notEqual(out.result.failureClass, "REMOTE_REVIEW_REQUIRED");
  assert.match(out.result.reason, /could not post the proposed resolution to PR #9: gh: 403 Forbidden/);
  assert.equal(git.git(["show", "orch-repair-sidtest:shared.txt"], repo), "preserved proposal");
  assert.equal(originSha(remote, "orch/integration"), before);
});

test("integration repair: propose without a PR preserves the resolution and explains the missing publication target", async () => {
  const { repo, remote } = repairFixture();
  const before = originSha(remote, "orch/integration");
  const cfg = repairCfg({
    main: {
      conflictResolution: "propose",
      conflictResolutionResolvers: [{ agent: "claude", model: null, effort: null }, { agent: "reviewer", model: null, effort: null }],
    },
  });
  const adapters = fakeAdapters({
    claude: {
      async author(prompt, wd) {
        writeFileSync(join(wd, "shared.txt"), "no PR proposal\n");
        git.git(["add", "-A"], wd);
        git.git(["commit", "-m", "no PR proposal"], wd);
      },
    },
    reviewer: { async audit() { return { decision: "AGREE" }; } },
  });

  const out = await runRepair(repo, {
    cfg, failureClass: "REMOTE_CONFLICTING", adapters, prNumber: null,
  });

  assert.notEqual(out.result.failureClass, "REMOTE_REVIEW_REQUIRED");
  assert.match(out.result.reason, /no PR to post the proposed resolution to/);
  assert.equal(git.git(["show", "orch-repair-sidtest:shared.txt"], repo), "no PR proposal");
  assert.equal(originSha(remote, "orch/integration"), before);
});

test("integration repair: a per-cycle PR repairs its own branch, not the integration branch", async () => {
  const { repo, remote } = repairFixture();
  git.git(["switch", "-c", "feature", "orch/integration"], repo);
  git.git(["push", "-u", "origin", "feature"], repo);
  git.git(["switch", "main"], repo);
  const integrationBefore = originSha(remote, "orch/integration");
  const featureBefore = originSha(remote, "feature");

  const out = await runRepair(repo, { branch: "feature", landing: "pr", gh: peerUpdateBranch(remote, "feature") });

  assert.equal(out.cycle?.status, "merged", out.result?.reason);
  assert.notEqual(originSha(remote, "feature"), featureBefore, "the per-cycle branch is the one repaired");
  assert.equal(originSha(remote, "orch/integration"), integrationBefore, "the integration branch must not be touched for a per-cycle PR");
});

// `resolveLanded` (cli.js) reads the LOCAL branch for readiness's
// `expectedHead`, and readiness rule 2 only re-pins a moved head for
// `landing: "standing"` — so a per-cycle repair that moves only origin comes
// back REMOTE_UNKNOWN forever. Driven with `landing: "pr"`, the only pairing
// `resolveLanded` actually produces for a per-cycle branch.
test("integration repair: a per-cycle repair leaves readiness ready, not REMOTE_UNKNOWN", async () => {
  const { repo, remote } = repairFixture();
  git.git(["switch", "-c", "feature", "orch/integration"], repo);
  git.git(["push", "-u", "origin", "feature"], repo);
  git.git(["switch", "main"], repo);

  const out = await runRepair(repo, { branch: "feature", landing: "pr", gh: peerUpdateBranch(remote, "feature") });
  assert.equal(out.cycle?.status, "merged", out.result?.reason);

  const repaired = originSha(remote, "feature");
  const expectedHead = git.git(["rev-parse", "feature"], repo);
  assert.equal(expectedHead, repaired, "the local branch must follow the repaired tip");

  // What run-controller.js does next with that `expectedHead`.
  const gh = (args) => {
    if (args[0] === "pr" && args[1] === "view") {
      return JSON.stringify({
        number: 9, state: "OPEN", isDraft: false, headRefOid: repaired, baseRefName: "main",
        mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: null, statusCheckRollup: [],
      });
    }
    if (args[0] === "api") return "[]";
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  const readiness = inspect(
    { pr: 9, expectedHead, landing: "pr", cfg: { baseBranch: "main", integrationBranch: "orch/integration" } },
    { gh, git, repo },
  );
  assert.equal(readiness.class, undefined, readiness.summary);
  assert.equal(readiness.ready, true);
});

test("integration repair: a per-cycle branch carrying local-only commits is not rewound, and nothing is pushed", async () => {
  // The divergence used to be reported after the push, so origin had already
  // taken the repaired tip and the local-only commits hung off a ref that could
  // never fast-forward again. Ask first, push second.
  const { repo, remote } = repairFixture();
  git.git(["switch", "-c", "feature", "orch/integration"], repo);
  git.git(["push", "-u", "origin", "feature"], repo);
  commitFile(repo, "local-only.txt", "not pushed\n", "local-only work");
  const diverged = git.git(["rev-parse", "feature"], repo);
  git.git(["switch", "main"], repo);
  const pushes = [];
  const gitDep = {
    ...git,
    gitTry: (args, wd) => {
      if (args[0] === "push") pushes.push(args);
      return git.gitTry(args, wd);
    },
  };

  const out = await runRepair(repo, { branch: "feature", landing: "pr", gitDep, gh: peerUpdateBranch(remote, "feature") });

  assert.match(out.result.reason, /diverged from the repaired tip/);
  assert.deepEqual(pushes, [], "nothing may be pushed once the local ref is known to have diverged");
  assert.equal(git.git(["rev-parse", "feature"], repo), diverged, "local commits must not be orphaned");
});

test("integration repair: a red gate after update-branch still advances the local ref", async () => {
  // `updateBranch` moves ORIGIN before anything is gated, so the local ref is
  // stale from that moment on. Left there, `resolveLanded`'s `expectedHead`
  // points at the pre-update sha and the next readiness read is REMOTE_UNKNOWN
  // — a class with no repair path, so the branch can never be repaired again.
  const { repo, remote } = repairFixture();
  git.git(["switch", "-c", "feature", "orch/integration"], repo);
  git.git(["push", "-u", "origin", "feature"], repo);
  git.git(["switch", "main"], repo);
  const stale = git.git(["rev-parse", "feature"], repo);

  const out = await runRepair(repo, {
    branch: "feature",
    landing: "pr",
    gh: peerUpdateBranch(remote, "feature"),
    gate: { detect: () => "true", run: () => ({ pass: false, log: "red" }) },
  });

  assert.equal(out.cycle, undefined);
  assert.match(out.result.reason, /gate red on the updated branch tip/);
  assert.notEqual(git.git(["rev-parse", "feature"], repo), stale, "the local ref must follow the already-moved origin");
  assert.equal(git.git(["rev-parse", "feature"], repo), originSha(remote, "feature"));
});

test("integration repair: the REMOTE_BEHIND gate carries the stageTimeout watchdog (#56/#58)", async () => {
  const { repo, remote } = repairFixture();
  const timeouts = [];
  const gate = { detect: () => "true", run: (_cmd, _cwd, timeoutMs) => { timeouts.push(timeoutMs); return { pass: true, log: "" }; } };

  await runRepair(repo, { gh: peerUpdateBranch(remote, "orch/integration"), gate });

  // Hand-computed from `repairCfg`'s `stageTimeout: 7` — 7 * 60_000. An
  // uncapped run would hold `integration-repair.lock` forever.
  assert.deepEqual(timeouts, [420_000]);
});

// --- landRepairedTip: the shared landing sequence (§10A) -------------------
// One landing function, so these cases pin the contract #569's resolver path
// will call: fast-forward, real merge, red re-gate, lost race.

test("integration repair: a fast-forward landing pushes the gated tree itself, so it is not re-gated", async () => {
  // `repairFixture` leaves the local integration branch exactly at origin's
  // tip, so merging the repaired tip in is a genuine fast-forward: the tree
  // that reaches origin IS the tree the gate already ran on.
  const { repo, remote } = repairFixture();
  const before = originSha(remote, "orch/integration");
  const cwds = [];
  const gate = { detect: () => "true", run: (_cmd, cwd) => { cwds.push(cwd); return { pass: true, log: "" }; } };

  const out = await runRepair(repo, { gate, gh: peerUpdateBranch(remote, "orch/integration") });

  assert.equal(out.cycle?.status, "merged", out.result?.reason);
  assert.equal(cwds.length, 1, "a fast-forward needs no second gate run");
  assert.ok(cwds[0].endsWith("orch-repair-sidtest"), "the one gate run is the scratch-tree one");
  assert.notEqual(originSha(remote, "orch/integration"), before, "the repair still landed");
});

test("integration repair: a landing whose pushed tree is not the gated tree re-gates it first", async () => {
  // The re-gate keys on `pushSha !== sha` — "the tree about to reach origin is
  // not the tree the gate ran on" — not on the merge's shape. A commit that
  // landed locally and has not been pushed produces exactly that: the merge
  // itself reports already-up-to-date, and the pushed tree is local's, which
  // neither the scratch gate nor CI has seen. `finalize` re-gates at exactly this point (src/finalize.js:233) and so
  // does this. It is also the positive half of the ordering: `repairBehind` used
  // to stop at the local reconcile and never push, stranding that commit.
  const { repo, remote } = repairFixture();
  const integration = git.ensureIntegrationWorktree(repo, join(repo, ".orch"), "orch/integration", "main");
  commitFile(integration, "local-only.txt", "landed locally, not pushed yet\n", "local land");
  const localOnly = git.git(["rev-parse", "HEAD"], integration);
  const calls = [];
  const gate = { detect: () => "true", run: (_cmd, cwd, timeoutMs) => { calls.push({ cwd, timeoutMs }); return { pass: true, log: "" }; } };

  // `gh` reports the update succeeded without origin's tip moving. What makes
  // the landing merge REAL here is the local side: the persistent integration
  // worktree carries a commit that has not been pushed, so the tree that
  // reaches origin is a combination no gate has run on yet.
  const out = await runRepair(repo, { gate });

  assert.equal(out.cycle?.status, "merged", out.result?.reason);
  assert.equal(calls.length, 2, "the merged tree is not the gated tip, so it gets its own gate run");
  assert.equal(calls[1].cwd, integration, "the re-gate runs on the tree that is about to be pushed");
  // Hand-computed from `repairCfg`'s `stageTimeout: 7` — 7 * 60_000 (#56/#58).
  // This run holds `merge.lock`, so an uncapped one would hold it forever.
  assert.equal(calls[1].timeoutMs, 420_000);
  assert.ok(
    git.gitTry(["merge-base", "--is-ancestor", localOnly, "orch/integration"], remote).ok,
    "the local-only commit must be an ancestor of the pushed integration tip",
  );
  assert.equal(git.git(["rev-parse", "HEAD"], integration), originSha(remote, "orch/integration"));
});

test("integration repair: a red re-gate rolls the integration worktree back and pushes nothing", async () => {
  const { repo, remote } = repairFixture();
  const integration = git.ensureIntegrationWorktree(repo, join(repo, ".orch"), "orch/integration", "main");
  commitFile(integration, "local-only.txt", "landed locally, not pushed yet\n", "local land");
  const localTip = git.git(["rev-parse", "HEAD"], integration);
  const before = originSha(remote, "orch/integration");
  // Green on the updated tip, red on the merged tree — the exact case a
  // scratch-only gate cannot see.
  let runs = 0;
  const gate = { detect: () => "true", run: () => { runs += 1; return { pass: runs === 1, log: "" }; } };

  const out = await runRepair(repo, { gate });

  assert.equal(out.cycle, undefined);
  assert.match(out.result.reason, /gate red on orch\/integration/);
  assert.equal(originSha(remote, "orch/integration"), before, "a tree the gate failed must never reach origin");
  assert.equal(git.git(["rev-parse", "HEAD"], integration), localTip, "the failed merge must be rolled back");
});

test("integration repair: a landing that loses the push race is re-polled, not terminal", async () => {
  // Nothing but a gate run is spent on the REMOTE_BEHIND path — no agent — so
  // losing the race to a peer costs this repair no attempt AND no convergence
  // entry: the peer's landing is on origin, so the next readiness poll may well
  // read the PR clean. Ending the run here instead threw away a repair that had
  // already succeeded, just not by our push. (#569's resolver path keeps its
  // attempt: it has already paid for a stage.)
  const { repo, remote } = repairFixture();
  const integration = git.ensureIntegrationWorktree(repo, join(repo, ".orch"), "orch/integration", "main");
  commitFile(integration, "local-only.txt", "landed locally, not pushed yet\n", "local land");
  const localTip = git.git(["rev-parse", "HEAD"], integration);
  // A real peer, not a hand-written rejection string: it lands its own commit on
  // origin/orch/integration in the window between this repair's fetch and its
  // push, so git itself produces the non-fast-forward wording `PUSH_RACE_RE` has
  // to recognise. A faked `out` would pass even if that wording never matched.
  const peer = cloneRemote(remote);
  git.git(["switch", "orch/integration"], peer);
  const gitDep = {
    ...git,
    gitTry: (args, wd) => {
      if (args[0] === "push" && wd === repo) {
        commitFile(peer, "peer.txt", "peer landed first\n", "peer land");
        git.git(["push", "origin", "orch/integration"], peer);
      }
      return git.gitTry(args, wd);
    },
  };

  // What run-controller.js appends before dispatching — the entry design §7's
  // convergence check reads.
  const entry = { class: "REMOTE_BEHIND", fingerprint: "fp", remedy: "integration-repair" };
  const out = await runRepair(repo, { gitDep, record: { attempt: 1, failures: [entry] } });

  assert.equal(out.result, undefined, "a race that changed nothing must not end the run");
  assert.equal(out.cycle?.status, "merged", "the same cycle goes back so the controller re-polls readiness");
  assert.equal(out.record.attempt, 0, "an agent-free repair that landed nothing must not burn an attempt");
  assert.deepEqual(out.record.failures, [], "a repair that never landed must leave no convergence entry");
  assert.equal(
    originSha(remote, "orch/integration"),
    git.git(["rev-parse", "HEAD"], peer),
    "origin must still be exactly what the peer landed — the losing repair changed nothing",
  );
  assert.equal(git.git(["rev-parse", "HEAD"], integration), localTip, "the lost race must leave local exactly as it was");
});

test("integration repair: a push rejected for auth, not for a race, keeps the attempt", async () => {
  // `raced` buys the caller a free attempt back because a race clears on the
  // next poll. Auth (or branch protection, or a pre-receive hook) does not: the
  // same push fails identically forever, so refunding there would spend the
  // controller's remedy loops re-running a repair that cannot land.
  const { repo, remote } = repairFixture();
  const before = originSha(remote, "orch/integration");
  const gitDep = {
    ...git,
    gitTry: (args, wd) => (args[0] === "push"
      ? { ok: false, out: "remote: Permission to o/r.git denied to nobody.\nfatal: unable to access ...: 403" }
      : git.gitTry(args, wd)),
  };

  const entry = { class: "REMOTE_BEHIND", fingerprint: "fp", remedy: "integration-repair" };
  const out = await runRepair(repo, { gitDep, record: { attempt: 1, failures: [entry] } });

  assert.match(out.result.reason, /push rejected/);
  assert.match(out.result.reason, /403/, "the real error must survive into the reason");
  assert.equal(out.record.attempt, 1, "a push that can never succeed must not be refunded as a race");
  // The negative control for dropping the convergence entry: only a no-op
  // precondition gives it back. A repair that really failed keeps it, so the
  // streak still converges instead of retrying forever.
  assert.deepEqual(out.record.failures, [entry], "a genuine failure must keep its convergence entry");
  assert.equal(originSha(remote, "orch/integration"), before);
});

test("integration repair: unpushed local commits merge into the moved origin, re-gate and land", async () => {
  // The real REMOTE_BEHIND shape, and the one an ff-only reconcile in front of
  // the merge could never repair: the server-side update has moved origin, and
  // the persistent worktree carries a commit that was landed locally but never
  // pushed. Local and origin have therefore diverged by construction, so the
  // merge below is a REAL merge — not a fast-forward — and it has to happen:
  // origin has already moved irreversibly, nothing else in the run merges those
  // local commits, and refusing here strands them for good.
  const { repo, remote } = repairFixture();
  const integration = git.ensureIntegrationWorktree(repo, join(repo, ".orch"), "orch/integration", "main");
  commitFile(integration, "local-only.txt", "landed locally, not pushed yet\n", "local land");
  const localOnly = git.git(["rev-parse", "HEAD"], integration);
  const calls = [];
  // The scratch gate runs after the server-side update and before the push, so
  // it is where origin still holds exactly what update-branch left: the tip the
  // gate ran on, which the pushed merge has to contain AND not be.
  let updatedTip = null;
  const gate = {
    detect: () => "true",
    run: (_cmd, cwd) => {
      if (!updatedTip) updatedTip = originSha(remote, "orch/integration");
      calls.push(cwd);
      return { pass: true, log: "" };
    },
  };

  const out = await runRepair(repo, { gate, gh: peerUpdateBranch(remote, "orch/integration") });

  assert.equal(out.cycle?.status, "merged", out.result?.reason);
  assert.equal(calls.length, 2, "the merged tree is not the gated tip, so it gets its own gate run");
  assert.equal(calls[1], integration, "the re-gate runs on the tree that is about to be pushed");
  const originTip = originSha(remote, "orch/integration");
  assert.ok(
    git.gitTry(["merge-base", "--is-ancestor", updatedTip, originTip], repo).ok
      && updatedTip !== originTip,
    "the pushed tip must be a real merge of the updated origin, not that tip itself",
  );
  assert.ok(
    git.gitTry(["merge-base", "--is-ancestor", localOnly, originTip], repo).ok,
    "the unpushed local commit must reach origin, not be stranded",
  );
  assert.equal(git.git(["rev-parse", "HEAD"], integration), originTip, "local must end up at exactly what was pushed");
});

test("integration repair: a dirty integration worktree is cleaned, so the re-gate sees the tree that reaches origin", async () => {
  // The re-gate only proves anything if the tree it runs on is the tree `git
  // push` publishes. Untracked/modified files in the persistent worktree break
  // exactly that: they survive the merge and the gate sees them, while the push
  // carries only the commit tree. Plant one, force a real (non-fast-forward)
  // landing, and assert the gate never saw it.
  const { repo, remote } = repairFixture();
  const integration = git.ensureIntegrationWorktree(repo, join(repo, ".orch"), "orch/integration", "main");
  commitFile(integration, "local-only.txt", "landed locally, not pushed yet\n", "local land");
  writeFileSync(join(integration, "dirty-leak.txt"), "left behind by an interrupted landing\n");
  const seen = [];
  const gate = {
    detect: () => "true",
    run: (_cmd, cwd) => {
      seen.push({ cwd, dirty: existsSync(join(cwd, "dirty-leak.txt")) });
      return { pass: true, log: "" };
    },
  };

  const out = await runRepair(repo, { gate, gh: peerUpdateBranch(remote, "orch/integration") });

  assert.equal(out.cycle?.status, "merged", out.result?.reason);
  assert.equal(seen.length, 2, "a real merge still gets its own gate run");
  assert.equal(seen[1].cwd, integration, "the re-gate runs on the persistent worktree");
  assert.equal(seen[1].dirty, false, "the re-gate must not see a file the push cannot carry");
  const originTip = originSha(remote, "orch/integration");
  assert.equal(
    git.gitTry(["cat-file", "-e", `${originTip}:dirty-leak.txt`], repo).ok,
    false,
    "the pushed tree must be the tree the re-gate ran on",
  );
  // The clean discards working-tree dirt, not history: a commit that only
  // exists locally still has to reach origin.
  assert.ok(git.gitTry(["cat-file", "-e", `${originTip}:local-only.txt`], repo).ok);
});

test("integration repair: a merge that conflicts with the updated origin rolls back and pushes nothing", async () => {
  // The other half of dropping the ff-only guard: the merge-conflict arm of
  // `landRepairedTip` is now reachable on the REMOTE_BEHIND path. A local
  // commit touching the same file the server-side update rewrote conflicts, and
  // the worktree must come back exactly as it was — a half-merged integration
  // tree is what `finalize` would trip over next.
  const { repo, remote } = repairFixture();
  const integration = git.ensureIntegrationWorktree(repo, join(repo, ".orch"), "orch/integration", "main");
  commitFile(integration, "shared.txt", "third value\n", "local land on the contested file");
  const localTip = git.git(["rev-parse", "HEAD"], integration);
  const pushes = [];
  const gitDep = {
    ...git,
    gitTry: (args, wd) => {
      if (args[0] === "push") pushes.push(args);
      return git.gitTry(args, wd);
    },
  };

  const out = await runRepair(repo, { gitDep, gh: peerUpdateBranch(remote, "orch/integration") });

  assert.equal(out.cycle, undefined);
  assert.match(out.result.reason, /could not merge the repaired tip into local orch\/integration/);
  assert.deepEqual(pushes, [], "a conflicted merge must never be pushed");
  assert.equal(git.git(["rev-parse", "HEAD"], integration), localTip, "the aborted merge must leave local untouched");
  assert.equal(git.git(["status", "--porcelain"], integration), "", "no conflict markers may be left behind");
});

test("integration repair: a merge.lock timeout refunds the attempt and pushes nothing", async () => {
  // `landRepairedTip` takes `merge.lock` before it touches anything shared, so a
  // timeout there means the repair spent a gate run and nothing else. Handing
  // the attempt back is the whole point of the `precondition` arm of its
  // contract: #569's caller, which HAS spent an agent stage by this point, is
  // what has to tell "nothing happened, retry is free" from "this repair is
  // over".
  const { repo, remote } = repairFixture();
  const before = originSha(remote, "orch/integration");
  const pushes = [];
  const gitDep = {
    ...git,
    gitTry: (args, wd) => {
      if (args[0] === "push") pushes.push(args);
      return git.gitTry(args, wd);
    },
  };
  const lock = { acquireLock, releaseLock, acquireBlocking: async () => false };

  const entry = { class: "REMOTE_BEHIND", fingerprint: "fp", remedy: "integration-repair" };
  const out = await runRepair(repo, { gitDep, lock, record: { attempt: 1, failures: [entry] } });

  assert.equal(out.cycle, undefined);
  assert.match(out.result.reason, /merge\.lock timed out/);
  assert.equal(out.record.attempt, 0, "a repair stopped before it touched anything must not burn an attempt");
  // The attempt alone is not enough. `resumeTerminal` clears `retries` but not
  // `failures`, so a retained entry makes `orch continue` see a two-long
  // equal-fingerprint streak, filter out `integration-repair` (failure.js:203)
  // and resolve terminal — and §10A gives REMOTE_BEHIND no other remedy, so the
  // still-behind PR could never be repaired.
  assert.deepEqual(out.record.failures, [], "a repair that changed nothing must not leave a convergence entry");
  assert.equal(chooseRemedy({ class: "REMOTE_BEHIND", fingerprint: "fp" }, { ...out.record, retries: { "repair-lock": 3 } }, {}).remedy, "integration-repair");
  assert.deepEqual(pushes, []);
  assert.equal(originSha(remote, "orch/integration"), before);
});

test("integration repair: a merge.lock timeout after resolver work keeps the attempt", async () => {
  const { repo, remote } = repairFixture();
  const cfg = repairCfg({
    main: {
      conflictResolution: "auto",
      conflictResolutionResolvers: [{ agent: "resolver", model: null, effort: null }, { agent: "reviewer", model: null, effort: null }],
    },
  });
  const adapters = fakeAdapters({
    resolver: {
      async author(_prompt, wd) {
        writeFileSync(join(wd, "shared.txt"), "resolved before lock timeout\n");
        git.git(["add", "-A"], wd);
        git.git(["commit", "-m", "resolve before lock timeout"], wd);
      },
    },
    reviewer: { async audit() { return { decision: "AGREE" }; } },
  });
  const lock = { acquireLock, releaseLock, acquireBlocking: async () => false };
  const entry = { class: "REMOTE_CONFLICTING", fingerprint: "fp", remedy: "integration-repair" };

  const out = await runRepair(repo, {
    cfg, adapters, lock, failureClass: "REMOTE_CONFLICTING",
    record: { attempt: 1, failures: [entry] },
  });

  assert.equal(out.cycle, undefined);
  assert.match(out.result.reason, /merge\.lock timed out/);
  assert.equal(out.record.attempt, 1, "resolver work has already consumed the attempt");
  assert.deepEqual(out.record.failures, [entry], "paid resolver work must retain its convergence entry");
  assert.equal(originSha(remote, "orch/integration"), git.git(["rev-parse", "orch/integration"], repo));
});

test("integration repair: the race loser re-polls and the run reaches READY on the winner's landing", async () => {
  // End to end through the REAL remedy and the REAL controller, the same shape
  // as the lock-loser test below. The unit test above proves the return shape;
  // this proves what that shape BUYS — the controller goes back to readiness
  // and reads the branch the winner repaired, instead of the run ending at
  // STOPPED_AT_CAP on a repair that had already been done for it.
  const { repo, remote } = repairFixture();
  const orchDir = join(repo, ".orch");
  const cfg = repairCfg();
  const run = { repo, orchDir, sid: "sidtest", cfg };
  const land = { pr: { number: 9, url: "u" }, expectedHead: HEAD, landing: "standing", branch: "orch/integration" };
  const update = peerUpdateBranch(remote, "orch/integration");
  let repaired = false;
  let raced = false;
  let polls = 0;
  const gh = (args) => {
    if (args[0] === "api" && args.some((a) => String(a).endsWith("/update-branch"))) {
      repaired = true;
      return update(args);
    }
    if (args[0] === "api") return "[]";
    polls += 1;
    return JSON.stringify({
      number: 9, state: "OPEN", isDraft: false, headRefOid: HEAD,
      baseRefName: "main", mergeable: "MERGEABLE",
      // BEHIND until the branch has been updated; the peer that WON the push
      // race is what makes it CLEAN, not our own landing.
      mergeStateStatus: repaired && raced ? "CLEAN" : "BEHIND",
      reviewDecision: null, statusCheckRollup: [],
    });
  };
  // A real peer landing in the window between this repair's fetch and its push,
  // once — so git itself writes the non-fast-forward rejection, and the retry
  // this fix enables is not raced again.
  const gitDep = {
    ...git,
    gitTry: (args, wd) => {
      if (args[0] === "push" && wd === repo && !raced) {
        raced = true;
        const peer = cloneRemote(remote);
        git.git(["switch", "orch/integration"], peer);
        commitFile(peer, "peer.txt", "peer landed first\n", "peer land");
        git.git(["push", "origin", "orch/integration"], peer);
      }
      return git.gitTry(args, wd);
    },
  };
  const deps = { git: gitDep, gate: { detect: () => "true", run: () => ({ pass: true, log: "" }) }, sleep: async () => {} };

  const out = await runUntil(
    { ...READY_POLICY, integrationBranch: "orch/integration" },
    {},
    {
      runCycle: async () => ({ status: "merged" }),
      resolveLanded: () => land,
      gh,
      git: gitDep,
      repo,
      remedies: { "integration-repair": createIntegrationRepairRemedy({ run, deps, gh, resolveLanded: () => land }) },
      sleep: async () => {},
    },
  );

  assert.equal(out.state, "READY", JSON.stringify(out));
  assert.ok(raced, "the push must actually have lost a race — otherwise this tests the happy path");
  assert.equal(out.attempt, 0, "the repair landed nothing, so the run keeps its whole attempt budget");
  assert.deepEqual(out.failures, [], "a repair that landed nothing must leave no convergence entry");
  // `repair-lock` (failure.js) grants 3 free re-polls before the remedy is
  // dispatched at all (polls 1-4); poll 5 is the one this fix buys, and it is
  // the one that reads CLEAN.
  assert.ok(polls >= 5, `a lost race must add a readiness poll, not end the run (saw ${polls})`);
  assert.equal(out.cycleResults, undefined, "the handed-back cycle is the same cycle, not a new result");
});

// --- integration-repair.lock contention -----------------------------------

test("integration repair: a peer holding integration-repair.lock refunds the attempt and hands the cycle back to re-poll", async () => {
  const { repo } = repairFixture();
  const orchDir = join(repo, ".orch");
  mkdirSync(orchDir, { recursive: true });
  writeFileSync(join(orchDir, LOCK_NAMES.INTEGRATION_REPAIR), String(process.pid + 0));
  const slept = [];
  const gates = [];
  // A live PID (our own) makes the lock genuinely held, not stale.
  const out = await runRepair(repo, {
    sleep: async (ms) => slept.push(ms),
    gate: { detect: () => "true", run: () => { gates.push(1); return { pass: true, log: "" }; } },
    gh: () => { throw new Error("no repair may start while a peer holds the lock"); },
  });

  // The cycle coming back (and no terminal `result`) is what makes
  // run-controller.js loop round and read readiness again after the peer
  // finishes, instead of ending the run on mere contention.
  assert.equal(out.cycle?.status, "merged");
  assert.equal(out.result, undefined);
  assert.equal(out.record.attempt, 0, "a repair that started nothing must not burn an attempt");
  assert.deepEqual(gates, []);
  assert.ok(slept[0] > 0, "back off before the re-poll so the peer's repair can land");
});

test("integration repair: the lock loser re-polls and repairs for real once the peer releases", async () => {
  // End to end through the REAL remedy and the REAL controller: contention must
  // put the controller back on the readiness path, and the retry must then
  // repair instead of ending the run. The lock is released during the backoff,
  // standing in for the peer finishing its own repair.
  const { repo, remote } = repairFixture();
  const orchDir = join(repo, ".orch");
  const lockFile = join(orchDir, LOCK_NAMES.INTEGRATION_REPAIR);
  writeFileSync(lockFile, String(process.pid));
  const before = originSha(remote, "orch/integration");

  const cfg = repairCfg();
  const run = { repo, orchDir, sid: "sidtest", cfg };
  const land = { pr: { number: 9, url: "u" }, expectedHead: HEAD, landing: "standing", branch: "orch/integration" };
  const update = peerUpdateBranch(remote, "orch/integration");
  let repaired = false;
  let polls = 0;
  const gh = (args) => {
    if (args[0] === "api" && args.some((a) => String(a).endsWith("/update-branch"))) {
      repaired = true;
      return update(args);
    }
    if (args[0] === "api") return "[]";
    polls += 1;
    return JSON.stringify({
      number: 9, state: "OPEN", isDraft: false, headRefOid: HEAD,
      baseRefName: "main", mergeable: "MERGEABLE",
      // BEHIND until the repair has actually updated the branch.
      mergeStateStatus: repaired ? "CLEAN" : "BEHIND",
      reviewDecision: null, statusCheckRollup: [],
    });
  };
  const deps = {
    git,
    gate: { detect: () => "true", run: () => ({ pass: true, log: "" }) },
    sleep: async () => rmSync(lockFile),
  };

  const out = await runUntil(
    { ...READY_POLICY, integrationBranch: "orch/integration" },
    {},
    {
      runCycle: async () => ({ status: "merged" }),
      resolveLanded: () => land,
      gh,
      git,
      repo,
      remedies: { "integration-repair": createIntegrationRepairRemedy({ run, deps, gh, resolveLanded: () => land }) },
      sleep: async () => {},
    },
  );

  assert.equal(out.state, "READY", JSON.stringify(out));
  assert.equal(out.attempt, 1, "only the repair that ran burns an attempt");
  // `repair-lock` (failure.js) already grants 3 free re-polls before the remedy
  // is dispatched at all (polls 1-4); poll 5 follows the contended dispatch and
  // is the one this fix buys, poll 6 reads the repaired branch clean.
  assert.ok(polls >= 5, `contention must add a readiness poll, not end the run (saw ${polls})`);
  assert.deepEqual(out.failures.map((f) => f.remedy), ["integration-repair"], "contention must not leave a convergence entry behind");
  assert.equal(out.cycleResults, undefined, "a handed-back cycle is not a new cycle result");
  assert.notEqual(originSha(remote, "orch/integration"), before, "the retry must actually repair");
});

test("integration repair: the lock-contention cap outlasts every stage a peer runs under the lock", async () => {
  // The regression the cap keeps having: a new `stageTimeoutMs(cfg)` call lands
  // inside `integration-repair.lock` and nobody resizes the wait, so contenders
  // give up mid-peer-repair. Count the windows a REAL worst-case repair spends
  // under the lock instead of re-deriving the arithmetic the cap already uses.
  const { repo, remote } = repairFixture();
  // A local-only commit on the integration branch forces a real merge in
  // `landRepairedTip`, which is the only shape that reaches the second window.
  const integration = git.ensureIntegrationWorktree(repo, join(repo, ".orch"), "orch/integration", "main");
  commitFile(integration, "local-only.txt", "landed locally, not pushed yet\n", "local land");

  const windows = [];
  const gate = {
    detect: () => "true",
    run: (_cmd, _cwd, timeoutMs) => { windows.push(timeoutMs); return { pass: true, log: "" }; },
  };

  const out = await runRepair(repo, { gate });
  assert.equal(out.cycle?.status, "merged", out.result?.reason);

  // `repairCfg`'s `stageTimeout: 7` — every window carries the same watchdog.
  assert.deepEqual(windows, [420_000, 420_000]);
  // Hand-computed cap (see the test below): 19 rounds of LOCK_RETRY_MS. The
  // peer can also sit in `acquireBlocking(merge.lock)` for its 5-minute default
  // (src/lock.js:117) between these two windows, so that is added, not assumed
  // to fit in the slack. A third gate window — #569's resolver and audit are
  // next — makes this fail rather than silently shortening the wait.
  const capMs = 19 * 60_000;
  assert.ok(
    capMs >= windows.reduce((sum, ms) => sum + ms, 0) + 300_000,
    "a contender must be able to wait out every stage the lock holder can run",
  );
});

test("integration repair: lock contention stops at the retry cap instead of spinning the controller", async () => {
  const { repo } = repairFixture();
  const orchDir = join(repo, ".orch");
  mkdirSync(orchDir, { recursive: true });
  writeFileSync(join(orchDir, LOCK_NAMES.INTEGRATION_REPAIR), String(process.pid));
  const slept = [];

  // Hand-computed from the requirement, not read off the code: the peer can
  // hold the lock across four stages — the resolver `author()`, the gate run
  // on the resolution, the reviewer `audit()`, and the re-gate on the merged
  // tree — each capped at `repairCfg()`'s `stageTimeout: 7` minutes, plus the
  // 5-minute `merge.lock` wait in the middle (src/lock.js:117): 4*7 + 5 = 33
  // minutes, one round per LOCK_RETRY_MS (60s), plus one explicit slack round
  // before the final poll, so 34 rounds.
  const cap = 34;
  let lockPolls = 0;
  const lock = {
    acquireLock: () => { lockPolls += 1; return false; },
    releaseLock: () => true,
    acquireBlocking: async () => false,
  };

  // The last round under the cap: still handed back, and the wait is counted.
  const last = await runRepair(repo, {
    record: { attempt: 1, failures: [], retries: { "repair-lock-wait": cap - 1 } },
    sleep: async (ms) => slept.push(ms),
    lock,
  });
  assert.equal(last.cycle?.status, "merged");
  assert.equal(last.result, undefined);
  assert.equal(last.record.retries["repair-lock-wait"], cap);
  assert.equal(last.record.attempt, 0);

  // One past it: terminal, naming the peer — not another refund that leaves
  // run-controller.js to burn its 32 loops on contention alone.
  const past = await runRepair(repo, {
    record: { attempt: 1, failures: [], retries: { "repair-lock-wait": cap } },
    sleep: async (ms) => slept.push(ms),
    lock,
  });
  assert.equal(past.cycle, undefined);
  assert.equal(past.result.state, "STOPPED_AT_CAP");
  assert.match(past.result.reason, /a peer is already repairing/);
  assert.equal(lockPolls, 2, "the exhausted budget must still perform its final lock poll");
  assert.deepEqual(slept, [60_000], "the exhausted round must not back off again");
});

test("integration repair: an exhausted contention cap leaves no convergence entry, so a resumed run can repair", async () => {
  // The cap terminalizes the run, and `resumeTerminal` (run-record.js:86) hands
  // `orch continue` a fresh attempt budget — but it clears `retries`, not
  // `failures`. A retained entry makes `chooseRemedy` see a two-long
  // equal-fingerprint streak ending in this remedy, filter it out
  // (failure.js:203) and resolve terminal; §10A gives REMOTE_BEHIND no other
  // remedy, so a PR that is STILL behind could never be repaired at all.
  const { repo } = repairFixture();
  const orchDir = join(repo, ".orch");
  mkdirSync(orchDir, { recursive: true });
  writeFileSync(join(orchDir, LOCK_NAMES.INTEGRATION_REPAIR), String(process.pid));
  const failure = { class: "REMOTE_BEHIND", fingerprint: "fp" };
  // What run-controller.js appends before dispatching.
  const record = { attempt: 1, failures: [{ ...failure, remedy: "integration-repair" }], retries: { "repair-lock-wait": 34 } };

  const out = await runRepair(repo, { record });

  assert.equal(out.result.state, "STOPPED_AT_CAP");
  assert.deepEqual(out.record.failures, [], "the entry for a repair that never ran must not survive the cap");
  // The resumed run, re-reading a PR that is still BEHIND — through the real
  // durable record rather than a hand-built object, so what `chooseRemedy` sees
  // is what actually survives a write/read round trip and `resumeTerminal`'s
  // own field clearing. `repair-lock` is pinned so the free re-polls are out of
  // the way and the choice under test is the remedy one.
  runRecord.create(orchDir, { runId: "sidtest", command: "task", policy: { maxAttempts: 1 } });
  runRecord.update(orchDir, "sidtest", {
    ...out.record,
    outcome: out.result.outcome,
    exit: out.result.exit,
    retries: { ...out.record.retries, "repair-lock": 3 },
  });
  // The same budget grant cli.js:2066 makes on `orch continue`.
  const prior = runRecord.lookup(orchDir, "sidtest");
  runRecord.resumeTerminal(orchDir, "sidtest", { maxAttempts: prior.attempt + (prior.policy?.maxAttempts ?? 1) });
  const resumed = { ...runRecord.lookup(orchDir, "sidtest"), retries: { "repair-lock": 3 } };
  assert.equal(resumed.outcome, null, "the resumed run must no longer be terminal");
  assert.deepEqual(resumed.failures, [], "the dropped convergence entry must stay dropped across the resume");
  assert.equal(chooseRemedy(failure, resumed, {}).remedy, "integration-repair", "a still-behind PR must be able to retry the only remedy it has");
  // The regression itself, hand-computed from failure.js: with the entry
  // retained the streak is 2, `integration-repair` is filtered out of the row
  // and REMOTE_BEHIND falls to `ask`.
  const retained = { ...resumed, failures: record.failures };
  assert.equal(chooseRemedy(failure, retained, {}).decision, "ask");
});

test("reauthor rewrites the same work order with only the latest three failures", async () => {
  const run = {
    task: "narrow fix", sid: "old-cycle", branch: "pr/codex/narrow-fix-old",
    author: { agent: "codex" },
    workOrder: {
      title: "narrow fix", problem: "make the failing behavior correct",
      repro_steps: ["run the failing case"], suspected_paths: ["src/bug.js"],
      acceptance_criteria: ["the case passes"],
    },
  };
  const record = {
    failures: [
      { class: "TEST_RED", summary: "one", fingerprint: "one" },
      { class: "TEST_RED", summary: "two", fingerprint: "two" },
      { class: "TEST_RED", summary: "three", fingerprint: "three" },
      { class: "SCOPE_EXCEEDED", summary: "four", fingerprint: "four" },
    ],
  };
  let options;
  const result = await reauthorRemedy({
    run, record, failure: { class: "SCOPE_EXCEEDED", summary: "too broad", fingerprint: "five" },
    createCycle: async (next) => { options = next; return { status: "escalated" }; },
  });
  assert.deepEqual(failureHistory(record, { class: "SCOPE_EXCEEDED", summary: "too broad", fingerprint: "five" }).map((entry) => entry.fingerprint), ["three", "four", "five"]);
  assert.notEqual(options.sid, run.sid);
  assert.match(options.branch, /^pr\/codex\/narrow-fix-/);
  assert.equal(options.resume, false);
  assert.equal(options.freshAuthor, true);
  assert.match(options.workOrder.problem, /smallest change/);
  assert.match(options.workOrder.problem, /What failed before/);
  assert.match(options.authorPrompt, /BEGIN UNTRUSTED REFERENCE/);
  assert.equal(result.record.reauthorizedFrom, run.branch);
});

test("reauthor applies a human addendum in place", async () => {
  const run = {
    task: "fix", sid: "same-cycle", branch: "pr/codex/fix-same",
    author: { agent: "codex" },
    workOrder: { title: "fix", problem: "repair it", repro_steps: [], suspected_paths: [], acceptance_criteria: [] },
  };
  let options;
  await reauthorRemedy({
    run, record: { policy: { source: { text: "original" } } },
    failure: { class: "REMOTE_CHANGES_REQUESTED", summary: "address review" },
    addendum: "also cover the empty input", revise: true,
    createCycle: async (next) => { options = next; return { status: "merged" }; },
  });
  assert.equal(options.sid, run.sid);
  assert.equal(options.branch, run.branch);
  assert.equal(options.resume, true);
  assert.match(options.workOrder.problem, /also cover the empty input/);
});

test("ask accepts a write permission with role_name and grants the requested fresh budget", async () => {
  const calls = [];
  const run = { sid: "ask-run", task: "ask task", branch: "pr/codex/ask-task", cfg: { baseBranch: "main" } };
  const policy = { until: "ready", maxAttempts: 3, baseMaxAttempts: 3, pollSeconds: 1, humanWaitHours: 1 };
  const gh = (args, input) => {
    calls.push({ args, input });
    if (args[0] === "pr" && args[1] === "list") return "[]";
    if (args[0] === "pr" && args[1] === "create") return "https://github.com/o/r/pull/12\n";
    if (args[0] === "api" && args[1]?.includes("comments") && args.includes("--paginate")) {
      return args.some((arg) => arg.startsWith("since=")) ? JSON.stringify([
        { id: 10, body: "<!-- orch:result -->\nESCALATED", user: { login: "orch-bot", type: "User" } },
        { id: 11, body: "orch: retry 2", user: { login: "maintainer", type: "User" } },
      ]) : "[]";
    }
    if (args[0] === "api" && args[1]?.includes("collaborators")) return JSON.stringify({ permission: "write", role_name: "maintain" });
    if (args[0] === "api" && args.includes("-X") && args.includes("POST")) return JSON.stringify({ id: 10 });
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  const result = await askRemedy({
    run, policy, failure: { class: "REVIEW_STALEMATE", summary: "no agreement" },
    record: { runId: run.sid, attempt: 1, failures: [{ class: "REVIEW_STALEMATE", remedy: "rotate" }] },
    deps: { gh, now: () => 0, sleep: async () => {} },
    runCycle: async () => ({ status: "merged" }),
  });
  assert.equal(result.cycle.status, "merged");
  assert.equal(result.record.policy.maxAttempts, 5);
  assert.equal(result.record.policy.grantedExtra, 2);
  assert.ok(calls.some(({ input }) => String(input || "").includes("orch:ask-run:ask:1")));
  assert.deepEqual(parseReply("note\nOrch: RETRY 9"), { command: "retry", count: 3 });
  assert.equal(canWrite({ permission: "write", roleName: "read" }), true);
  assert.equal(canWrite({ ok: false, permission: "write", roleName: "write" }), false);
  assert.equal(canWrite({ ok: true, permission: "none", roleName: "maintain" }), false);
});

test("ask reuses an unanswered question after a resumed attempt advances", async () => {
  let now = 0;
  let posts = 0;
  const gh = (args) => {
    if (args[0] === "api" && args[1]?.includes("comments") && args.includes("--paginate")) return JSON.stringify([
      { id: 21, body: "orch: abandon", user: { login: "maintainer", type: "User" } },
    ]);
    if (args[0] === "api" && args.includes("-X") && args.includes("POST")) {
      posts += 1;
      return JSON.stringify({ id: 30 });
    }
    if (args[0] === "api" && args[1]?.includes("collaborators")) return JSON.stringify({ permission: "write" });
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  const result = await askRemedy({
    run: { sid: "resumed-ask", task: "wait", branch: "pr/codex/wait" },
    policy: { until: "ready", maxAttempts: 3, pollSeconds: 1, humanWaitHours: 1 },
    failure: { class: "TEST_MISSING", summary: "no test" },
    record: {
      attempt: 1,
      human: {
        channel: "issue", target: 9, askCommentId: 20,
        askedAt: "1970-01-01T00:00:00.000Z", deadline: "1970-01-01T01:00:00.000Z",
        attempt: 0, replies: [{ id: 15, command: "retry" }],
      },
    },
    deps: { gh, now: () => now, sleep: async () => { now = 4_000_000; } },
  });
  assert.equal(result.result.blockedReason, "human-abandon");
  assert.equal(posts, 0);
});

test("ask times out with exit 4 and a continuation command", async () => {
  let now = 0;
  const gh = (args) => {
    if (args[0] === "api" && args[1]?.includes("comments") && args.includes("--paginate")) return "[]";
    if (args[0] === "api" && args.includes("-X") && args.includes("POST")) return JSON.stringify({ id: 20 });
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  const result = await askRemedy({
    run: { sid: "timeout-run", task: "wait", branch: "pr/codex/wait", closes: 8 },
    policy: { until: "ready", maxAttempts: 3, pollSeconds: 1, humanWaitHours: 0.000001 },
    failure: { class: "TEST_MISSING", summary: "no test" }, record: { attempt: 0 },
    deps: { gh, now: () => now, sleep: async () => { now = 10_000; } },
  });
  assert.equal(result.result.exit, 4);
  assert.equal(result.result.outcome, "wait-timeout");
  assert.match(result.result.resumeCommand, /orch continue timeout-run/);
  assert.equal(result.record.human.askCommentId, 20);
});

test("ask resumes with its saved human deadline and times out without a reply", async () => {
  let now = 0;
  const deadline = new Date(100).toISOString();
  const gh = (args) => {
    if (args[0] === "api" && args[1]?.includes("comments") && args.includes("--paginate")) return "[]";
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  const result = await askRemedy({
    run: { sid: "resumed-timeout", task: "wait", branch: "pr/codex/wait" },
    policy: { until: "ready", maxAttempts: 3, pollSeconds: 1, humanWaitHours: 24 },
    failure: { class: "TEST_MISSING", summary: "no test" },
    record: {
      attempt: 1,
      human: {
        channel: "issue", target: 9, askCommentId: 20,
        askedAt: "1970-01-01T00:00:00.000Z", deadline,
        attempt: 0, replies: [],
      },
    },
    deps: { gh, now: () => now, sleep: async (ms) => { now = ms; } },
  });
  assert.equal(result.result.exit, 4);
  assert.equal(result.result.outcome, "wait-timeout");
  assert.equal(result.record.human.deadline, deadline, "resume must not extend an unanswered question");
});

test("ask skips an unverifiable commenter and accepts a later permitted reply", async () => {
  const gh = (args) => {
    if (args[0] === "api" && args[1]?.includes("comments") && args.includes("--paginate")) return JSON.stringify([
      { id: 31, body: "orch: retry", user: { login: "unknown" } },
      { id: 32, body: "orch: retry", user: { login: "maintainer" } },
    ]);
    if (args[0] === "api" && args.includes("-X") && args.includes("POST")) return JSON.stringify({ id: 30 });
    if (args[0] === "api" && args[1]?.includes("collaborators/unknown")) throw new Error("HTTP 403");
    if (args[0] === "api" && args[1]?.includes("collaborators/maintainer")) return JSON.stringify({ permission: "write" });
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  const result = await askRemedy({
    run: { sid: "auth-run", task: "auth", branch: "pr/codex/auth", closes: 9 },
    policy: { until: "ready", maxAttempts: 3, pollSeconds: 1, humanWaitHours: 1 },
    failure: { class: "TEST_MISSING" }, record: {}, deps: { gh, now: () => 0 },
    runCycle: async () => ({ status: "merged" }),
  });
  assert.equal(result.cycle.status, "merged");
});
