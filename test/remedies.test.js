// design §12: the lock scheme every remedy builds on (P6 split 1/4). No
// remedy executor exists yet (integration-repair.js lands in a later split),
// so this exercises the real primitives in src/lock.js directly — no
// stubbed git — against real lock files in real temp dirs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, releaseLock, LOCK_NAMES } from "../src/lock.js";
import { chooseRemedy } from "../src/failure.js";
import { runUntil } from "../src/run-controller.js";
import { createRebaseRemedy } from "../src/remedies.js";
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
