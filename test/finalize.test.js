import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finalize } from "../src/finalize.js";
import * as gitMod from "../src/git.js";

function baseDeps(over = {}) {
  const recorded = [];
  const deps = {
    git: {
      syncMainFromOrigin: () => ({ ok: true }),
      ensureIntegrationWorktree: () => "/integ",
      syncWorktreeToIntegration: () => {},
      reconcileIntegrationToOrigin: () => ({ ok: true, updated: false }),
      reconcileIntegrationToBase: () => ({ ok: true, updated: false }),
      mergeInWorktree: () => ({ ok: true, reason: "merged" }),
      bumpVersion: () => "0.1.1",
      verifyOriginContains: () => ({ ok: true }),
      git: (args) => (args[0] === "rev-parse" ? "deadbee" : ""),
    },
    gate: { run: () => ({ pass: true, log: "" }) },
    lock: { acquireBlocking: () => true, releaseLock: () => {} },
    inflight: { peerPaths: () => [] },
    github: {
      demote: async () => ({ prUrl: "https://x/pr/1" }),
      openIntegrationPr: async () => ({ prUrl: "https://x/pr/99" }),
    },
    notify: { recordRun: (d, e) => recorded.push(e), cleanupReviews: () => {}, escalate: () => {} },
  };
  return { deps: { ...deps, ...over }, recorded };
}

const ctx = () => ({
  repo: "/r", orchDir: "/r/.orch", branch: "pr/claude/x-1", sid: "1",
  baseSha: "base", paths: ["src/a.js"], testCmd: "npm test", cfg: { merge: "no-ff", integrationBranch: "orch/integration" }, rounds: 1,
});

// ctx with the opt-in release policy enabled — bumpVersion only runs with this.
const bumpCtx = () => ({ ...ctx(), cfg: { ...ctx().cfg, release: { autoBump: true } } });

function newRepo() {
  const d = mkdtempSync(join(tmpdir(), "orch-finalize-"));
  gitMod.git(["init", "-b", "main"], d);
  gitMod.git(["config", "user.email", "t@t"], d);
  gitMod.git(["config", "user.name", "t"], d);
  gitMod.git(["config", "core.autocrlf", "false"], d);
  writeFileSync(join(d, "README.md"), "init\n");
  gitMod.git(["add", "."], d);
  gitMod.git(["commit", "-m", "init"], d);
  return d;
}

function addOrigin(repo) {
  const remote = mkdtempSync(join(tmpdir(), "orch-finalize-remote-"));
  gitMod.git(["init", "--bare", "-b", "main"], remote);
  gitMod.git(["remote", "add", "origin", remote], repo);
  gitMod.git(["push", "-u", "origin", "main"], repo);
  return remote;
}

function cloneRemote(remote) {
  const parent = mkdtempSync(join(tmpdir(), "orch-finalize-peer-"));
  const peer = join(parent, "repo");
  gitMod.git(["clone", remote, peer], parent);
  gitMod.git(["config", "user.email", "t@t"], peer);
  gitMod.git(["config", "user.name", "t"], peer);
  gitMod.git(["config", "core.autocrlf", "false"], peer);
  return peer;
}

function commitFile(repo, file, text, msg) {
  writeFileSync(join(repo, file), text);
  gitMod.git(["add", "."], repo);
  gitMod.git(["commit", "-m", msg], repo);
}

test("clean path → merged + recorded", async () => {
  const { deps, recorded } = baseDeps();
  const r = await finalize(ctx(), deps);
  assert.equal(r.status, "merged");
  assert.equal(recorded[0].sid, "1");
  assert.equal(recorded[0].verdict, "merged");
});

test("#422: unchanged head is checked under merge.lock and the reviewed SHA is merged", async () => {
  const reviewedSha = "1111111111111111111111111111111111111111";
  const integrationSha = "9999999999999999999999999999999999999999";
  let lockHeld = false;
  let checkedUnderLock = false;
  let mergeTarget = null;
  let bridgedCtx = null;
  const g = baseDeps().deps.git;
  const { deps } = baseDeps({
    lock: {
      acquireBlocking: () => { lockHeld = true; return true; },
      releaseLock: () => { lockHeld = false; },
    },
    git: {
      ...g,
      git: (args, cwd) => {
        if (args[0] === "rev-parse" && args[1] === "--verify") {
          checkedUnderLock = lockHeld;
          return reviewedSha;
        }
        if (args[0] === "rev-parse" && args[1] === "--short") return "9999999";
        if (args[0] === "rev-parse" && (cwd === "/integ" || args[1] === "orch/integration")) return integrationSha;
        return g.git(args, cwd);
      },
      mergeInWorktree: (_integration, target) => { mergeTarget = target; return { ok: true, reason: "merged" }; },
    },
    github: {
      ...baseDeps().deps.github,
      openIntegrationPr: async (c) => { bridgedCtx = c; return { prUrl: "https://x/pr/99" }; },
    },
  });

  const r = await finalize({ ...ctx(), reviewedSha }, deps);

  assert.equal(r.status, "merged");
  assert.equal(checkedUnderLock, true);
  assert.equal(lockHeld, false);
  assert.equal(mergeTarget, reviewedSha, "git merge must act on the checked commit, not the branch name");
  assert.equal(bridgedCtx.reviewedSha, reviewedSha);
  assert.equal(bridgedCtx.integrationSha, integrationSha, "reviewedSha and integrationSha remain distinct");
});

test("#422: a moved head causes terminal escalation naming both SHAs and no merge", async () => {
  const reviewedSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const currentSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  let merged = false;
  let escalation = null;
  const g = baseDeps().deps.git;
  const { deps, recorded } = baseDeps({
    git: {
      ...g,
      git: (args, cwd) => args[1] === "--verify" ? currentSha : g.git(args, cwd),
      mergeInWorktree: () => { merged = true; return { ok: true }; },
    },
    notify: {
      recordRun: (_d, e) => recorded.push(e),
      cleanupReviews: () => {},
      escalate: (orchDir, branch, body) => { escalation = { orchDir, branch, body }; },
    },
  });

  const r = await finalize({ ...ctx(), reviewedSha }, deps);

  assert.equal(r.status, "escalated");
  assert.equal(merged, false);
  assert.match(r.reason, new RegExp(reviewedSha));
  assert.match(r.reason, new RegExp(currentSha));
  assert.match(escalation.body, new RegExp(reviewedSha));
  assert.match(escalation.body, new RegExp(currentSha));
  assert.equal(recorded[0].verdict, "escalated");
});

test("#422: an unreadable head at finalize fails closed without merging", async () => {
  const reviewedSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  let merged = false;
  const g = baseDeps().deps.git;
  const { deps, recorded } = baseDeps({
    git: {
      ...g,
      git: (args, cwd) => {
        if (args[1] === "--verify") throw new Error("cannot resolve branch");
        return g.git(args, cwd);
      },
      mergeInWorktree: () => { merged = true; return { ok: true }; },
    },
    notify: {
      recordRun: (_d, e) => recorded.push(e),
      cleanupReviews: () => {},
      escalate: () => {},
    },
  });

  const r = await finalize({ ...ctx(), reviewedSha }, deps);

  assert.equal(r.status, "escalated");
  assert.equal(merged, false);
  assert.match(r.reason, new RegExp(reviewedSha));
  assert.match(r.reason, /current SHA <unreadable>/);
  assert.equal(recorded[0].verdict, "escalated");
});

test("#422: a tip moved on the overlap demote path is not pushed or opened as a PR", async () => {
  const reviewedSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const currentSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  let liveHead = reviewedSha;
  let merged = false;
  let demoted = false;
  const g = baseDeps().deps.git;
  const { deps, recorded } = baseDeps({
    inflight: { peerPaths: () => ["src/a.js"] },
    deferred: { record: () => {}, list: () => [] },
    git: {
      ...g,
      git: (args, cwd) => {
        if (args[1] === "--verify") return liveHead;
        if (args[0] === "rev-parse" && args[1] === "HEAD" && cwd === "/integ") {
          liveHead = currentSha;
          return "deadbee";
        }
        return g.git(args, cwd);
      },
      mergeInWorktree: () => { merged = true; return { ok: true }; },
    },
    github: {
      ...baseDeps().deps.github,
      demote: async () => { demoted = true; return { prUrl: "https://x/pr/1" }; },
    },
    notify: {
      recordRun: (_d, e) => recorded.push(e),
      cleanupReviews: () => {},
      escalate: () => {},
    },
  });

  const r = await finalize({ ...ctx(), reviewedSha }, deps);

  assert.equal(r.status, "escalated");
  assert.equal(merged, false);
  assert.equal(demoted, false, "moved content must not be pushed or opened as a PR");
  assert.match(r.reason, new RegExp(reviewedSha));
  assert.match(r.reason, new RegExp(currentSha));
  assert.equal(recorded[0].verdict, "escalated");
});

test("#422: merge: pr refuses a moved branch before opening the PR", async () => {
  const reviewedSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const currentSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  let opened = false;
  const g = baseDeps().deps.git;
  const { deps } = baseDeps({
    git: { ...g, git: (args, cwd) => args[1] === "--verify" ? currentSha : g.git(args, cwd) },
    github: { openPr: async () => { opened = true; return { prUrl: "https://x/pr/9" }; } },
  });

  const r = await finalize({ ...ctx(), reviewedSha, cfg: { merge: "pr" } }, deps);

  assert.equal(r.status, "escalated");
  assert.equal(opened, false);
  assert.match(r.reason, new RegExp(reviewedSha));
  assert.match(r.reason, new RegExp(currentSha));
});

test("merge commit built but integration branch didn't advance → throws instead of reporting merged", async () => {
  const g = baseDeps().deps.git;
  const { deps } = baseDeps({
    git: {
      ...g,
      // integration's HEAD (merge commit) vs repo's "orch/integration" disagree — this must
      // never be reported as a successful merge.
      git: (args, cwd) => {
        if (args[0] !== "rev-parse") return "";
        return cwd === "/integ" ? "newsha" : "stalesha";
      },
    },
  });
  await assert.rejects(() => finalize(ctx(), deps), /orch\/integration/);
});

test("local merge success → opens or updates the integration PR", async () => {
  let bridged = false;
  let bridgedCtx = null;
  const { deps, recorded } = baseDeps({
    github: {
      ...baseDeps().deps.github,
      openIntegrationPr: async (c) => { bridged = true; bridgedCtx = c; return { prUrl: "https://x/pr/99" }; },
    },
  });
  const r = await finalize(ctx(), deps);
  assert.equal(r.status, "merged");
  assert.equal(r.prUrl, "https://x/pr/99");
  assert.equal(recorded[0].verdict, "merged");
  assert.equal(recorded[0].prUrl, "https://x/pr/99");
  assert.equal(bridged, true);
  // #422 part 4: the tip finalize just verified must reach the bridge so
  // main.autoMerge can pin the direct merge to that commit.
  assert.equal(bridgedCtx.integrationSha, "deadbee");
});

test("integration PR bridge failure after local merge → records merged and escalates locally", async () => {
  let escalated = null;
  let cleaned = false;
  const { deps, recorded } = baseDeps({
    github: {
      ...baseDeps().deps.github,
      openIntegrationPr: async () => { throw new Error("gh failed"); },
    },
    notify: {
      recordRun: (_d, e) => recorded.push(e),
      cleanupReviews: () => { cleaned = true; },
      escalate: (orchDir, branch, body) => { escalated = { orchDir, branch, body }; },
    },
  });
  const r = await finalize(ctx(), deps);
  assert.equal(r.status, "merged");
  assert.equal(r.prUrl, null);
  assert.equal(recorded[0].verdict, "merged");
  assert.equal("prUrl" in recorded[0], false);
  assert.equal(cleaned, true);
  assert.equal(escalated.branch, "orch/integration");
  assert.match(escalated.body, /gh failed/);
});

test("path overlap with a peer → merge-deferred (no merge attempted)", async () => {
  let merged = false;
  const deferredRecords = [];
  const { deps, recorded } = baseDeps({
    inflight: {
      listLive: () => [{ sid: "peer-2", paths: ["src/a.js"] }],
      peerPaths: () => { throw new Error("listLive should provide peer details"); },
    },
    git: { ...baseDeps().deps.git, mergeInWorktree: () => { merged = true; return { ok: true }; } },
    deferred: {
      record: (_d, e) => deferredRecords.push(e),
      list: () => [],
    },
  });
  const r = await finalize(ctx(), deps);
  assert.equal(r.status, "merge-deferred");
  assert.equal(r.trigger, "overlap");
  assert.match(r.reason, /^opened PR https:\/\/x\/pr\/1; collides with peer peer-2 on src\/a\.js\./);
  assert.match(r.reason, /Vetted: agents AGREE, tests green, security clean\./);
  assert.match(r.reason, /trigger \| overlap/);
  assert.match(r.reason, /AGREE after 1 round/);
  assert.match(r.reason, /passed on branch \(npm test\)/);
  assert.match(r.reason, /base base; orch\/integration deadbee/);
  assert.match(r.reason, /peer overlap: peer-2: src\/a\.js/);
  assert.match(r.reason, /next action:/);
  assert.match(r.reason, /## Merge deferred: overlap/); // teaching-toned, not a raw dump
  assert.equal(merged, false);
  assert.equal(recorded[0].sid, "1");
  assert.equal(recorded[0].verdict, "merge-deferred");
  assert.equal(recorded[0].trigger, "overlap");
  assert.match(recorded[0].reason, /peer overlap: peer-2: src\/a\.js/);
  // Overlap demote queues the cycle for post-land redrive (#350).
  assert.equal(deferredRecords.length, 1);
  assert.equal(deferredRecords[0].sid, "1");
  assert.deepEqual(deferredRecords[0].peerSids, ["peer-2"]);
});

test("post-land redrive: deferred peer is rebased + gated + landed under the same lock (#350)", async () => {
  const lockOps = [];
  const rebased = [];
  const mergedBranches = [];
  const removed = [];
  const deferredPeer = {
    sid: "2", branch: "pr/codex/b-2", paths: ["src/a.js"], testCmd: "npm test",
    rounds: 1, peerSids: ["1"], redriveAttempts: 0,
  };
  const { deps, recorded } = baseDeps({
    lock: {
      acquireBlocking: () => { lockOps.push("acquire"); return true; },
      releaseLock: () => { lockOps.push("release"); },
    },
    inflight: { listLive: () => [], peerPaths: () => [] },
    git: {
      ...baseDeps().deps.git,
      rebaseBranchOnto: (_repo, _orch, branch, onto) => {
        rebased.push({ branch, onto });
        return { ok: true };
      },
      mergeInWorktree: (_path, branch) => {
        mergedBranches.push(branch);
        return { ok: true, reason: "merged" };
      },
      // HEAD advances per land so the integration-branch check passes twice.
      git: (args, cwd) => {
        if (args[0] === "rev-parse") {
          if (args[1] === "--short") return "abc1234";
          // worktree HEAD and repo branch tip must agree after each land
          if (cwd === "/integ" || args[1] === "orch/integration") {
            return `sha-${mergedBranches.length || 1}`;
          }
          return "deadbee";
        }
        return "";
      },
    },
    deferred: {
      list: () => (removed.includes(deferredPeer.sid) ? [] : [deferredPeer]),
      eligibleForRedrive: (e) => (e.redriveAttempts || 0) < 1,
      blockedByLand: (e, landed) => e.peerSids?.includes(landed.sid) || e.paths.some((p) => (landed.paths || []).includes(p)),
      markAttempt: () => { deferredPeer.redriveAttempts += 1; },
      remove: (_d, sid) => { removed.push(sid); },
    },
  });
  const r = await finalize(ctx(), deps);
  assert.equal(r.status, "merged");
  assert.deepEqual(mergedBranches, ["pr/claude/x-1", "pr/codex/b-2"]);
  assert.deepEqual(rebased, [{ branch: "pr/codex/b-2", onto: "orch/integration" }]);
  assert.deepEqual(removed, ["2"]);
  // Both lands recorded as merged; lock acquired once (serial under one hold).
  assert.equal(recorded.filter((e) => e.verdict === "merged").length, 2);
  assert.equal(recorded[1].sid, "2");
  assert.deepEqual(lockOps, ["acquire", "release"]);
});

// The landing cycle deregisters from `.orch/inflight` only AFTER finalize() returns
// (cli.js), so during redrive its own record is still live — on exactly the paths
// that caused the peer's deferral. If the live-peer scan counts it, no peer is ever
// redriven in a real run. These two tests pin both halves: the blocker must not
// block, a genuinely live third cycle must.
function redriveDeps(deferredPeer, listLive) {
  const mergedBranches = [];
  const removed = [];
  const { deps, recorded } = baseDeps({
    inflight: { listLive, peerPaths: () => [] },
    git: {
      ...baseDeps().deps.git,
      rebaseBranchOnto: () => ({ ok: true }),
      mergeInWorktree: (_path, branch) => {
        mergedBranches.push(branch);
        return { ok: true, reason: "merged" };
      },
      git: (args, cwd) => {
        if (args[0] === "rev-parse") {
          if (args[1] === "--short") return "abc1234";
          if (cwd === "/integ" || args[1] === "orch/integration") return `sha-${mergedBranches.length || 1}`;
          return "deadbee";
        }
        return "";
      },
    },
    deferred: {
      list: () => (removed.includes(deferredPeer.sid) ? [] : [deferredPeer]),
      eligibleForRedrive: (e) => (e.redriveAttempts || 0) < 1,
      blockedByLand: (e, landed) => e.peerSids?.includes(landed.sid) || e.paths.some((p) => (landed.paths || []).includes(p)),
      markAttempt: () => { deferredPeer.redriveAttempts += 1; },
      remove: (_d, sid) => { removed.push(sid); },
    },
  });
  return { deps, recorded, mergedBranches, removed };
}

test("post-land redrive: the landing cycle's own live inflight record does not block its peer (#350)", async () => {
  const deferredPeer = {
    sid: "2", branch: "pr/codex/b-2", paths: ["src/a.js"], testCmd: "npm test",
    rounds: 1, peerSids: ["1"], redriveAttempts: 0,
  };
  // ctx().sid — still registered, on the overlapping path, exactly as in a real run.
  const { deps, mergedBranches, removed } = redriveDeps(deferredPeer, () => [{ sid: "1", paths: ["src/a.js"] }]);
  const r = await finalize(ctx(), deps);
  assert.equal(r.status, "merged");
  assert.deepEqual(mergedBranches, ["pr/claude/x-1", "pr/codex/b-2"]);
  assert.deepEqual(removed, ["2"]);
});

test("post-land redrive: a third live cycle on the same path still blocks the peer (#350)", async () => {
  const deferredPeer = {
    sid: "2", branch: "pr/codex/b-2", paths: ["src/a.js", "src/b.js"], testCmd: "npm test",
    rounds: 1, peerSids: ["1"], redriveAttempts: 0,
  };
  // sid 3 touches src/b.js only: no overlap with the landing cycle (so the primary
  // land still happens), but it does overlap the deferred peer.
  const { deps, mergedBranches, removed } = redriveDeps(deferredPeer, () => [
    { sid: "1", paths: ["src/a.js"] },  // the landing cycle — must not block
    { sid: "3", paths: ["src/b.js"] },  // a genuinely live peer — must block
  ]);
  const r = await finalize(ctx(), deps);
  assert.equal(r.status, "merged");
  assert.deepEqual(mergedBranches, ["pr/claude/x-1"]);
  assert.deepEqual(removed, []);
  assert.equal(deferredPeer.redriveAttempts, 0); // still queued; no attempt burned
});

// Peer #999 was deferred for overlapping issue #362's cycle. When #362 lands and
// redrives it, the peer's runs.jsonl record must say 999 — priorStagedBranches
// joins on that number, so a wrong one makes `orch issue 362` claim #999's branch.
// `null` is the same bug with a nastier tell: an `orch task` peer has no issue, and
// a stamped 362 is reported as #362's staged work WITHOUT the uncertainty hedge.
for (const peerCloses of [999, null]) {
  test(`post-land redrive: each land records its OWN issue (peer closes=${peerCloses}), not the redriving cycle's`, async () => {
  const deferredPeer = {
    sid: "2", branch: "pr/codex/b-2", paths: ["src/a.js"], testCmd: "npm test",
    rounds: 1, peerSids: ["1"], redriveAttempts: 0, closes: peerCloses,
  };
  const mergedBranches = [];
  const { deps, recorded } = baseDeps({
    inflight: { listLive: () => [], peerPaths: () => [] },
    git: {
      ...baseDeps().deps.git,
      rebaseBranchOnto: () => ({ ok: true }),
      mergeInWorktree: (_path, branch) => { mergedBranches.push(branch); return { ok: true, reason: "merged" }; },
      git: (args, cwd) => {
        if (args[0] === "rev-parse") {
          if (args[1] === "--short") return "abc1234";
          if (cwd === "/integ" || args[1] === "orch/integration") return `sha-${mergedBranches.length || 1}`;
          return "deadbee";
        }
        return "";
      },
    },
    deferred: {
      list: () => (deferredPeer.removed ? [] : [deferredPeer]),
      eligibleForRedrive: (e) => (e.redriveAttempts || 0) < 1,
      blockedByLand: (e, landed) => e.peerSids?.includes(landed.sid),
      markAttempt: () => { deferredPeer.redriveAttempts += 1; },
      remove: () => { deferredPeer.removed = true; },
    },
  });
  // Same stamping realDeps() applies for `orch issue 362`: fallback only.
  const raw = deps.notify.recordRun;
  deps.notify = { ...deps.notify, recordRun: (d, e) => raw(d, "closes" in e ? e : { ...e, closes: 362 }) };

  const r = await finalize({ ...ctx(), closes: 362 }, deps);
  assert.equal(r.status, "merged");
  assert.deepEqual(recorded.filter((e) => e.verdict === "merged").map((e) => [e.sid, e.closes]),
    [["1", 362], ["2", peerCloses]]);
  });
}

test("post-land redrive: rebase conflict leaves peer deferred (no second demote) (#350)", async () => {
  let demoteCalls = 0;
  const deferredPeer = {
    sid: "2", branch: "pr/codex/b-2", paths: ["src/a.js"], testCmd: "npm test",
    rounds: 1, peerSids: ["1"], redriveAttempts: 0,
  };
  const { deps, recorded } = baseDeps({
    inflight: { listLive: () => [], peerPaths: () => [] },
    github: {
      ...baseDeps().deps.github,
      demote: async () => { demoteCalls += 1; return { prUrl: "https://x/pr/1" }; },
    },
    git: {
      ...baseDeps().deps.git,
      rebaseBranchOnto: () => ({ ok: false, reason: "CONFLICT" }),
      mergeInWorktree: (_p, branch) => {
        // Only the primary land should merge; redrive aborts at rebase.
        if (branch !== "pr/claude/x-1") throw new Error("should not merge deferred peer");
        return { ok: true, reason: "merged" };
      },
    },
    deferred: {
      list: () => [deferredPeer],
      eligibleForRedrive: () => true,
      blockedByLand: () => true,
      markAttempt: () => { deferredPeer.redriveAttempts += 1; },
      remove: () => { throw new Error("must not remove on failed redrive"); },
    },
  });
  const r = await finalize(ctx(), deps);
  assert.equal(r.status, "merged");
  assert.equal(recorded.filter((e) => e.verdict === "merged").length, 1);
  assert.equal(demoteCalls, 0); // quietFail — existing demote PR stands
  assert.equal(deferredPeer.redriveAttempts, 1);
});

test("merge conflict → merge-deferred (escalate, no per-change PR against main)", async () => {
  const mergeReason = "Auto-merging src/a.js\nCONFLICT (content): Merge conflict in src/a.js\nAutomatic merge failed";
  let demoteCalls = 0;
  let escalated = null;
  const { deps, recorded } = baseDeps({
    git: {
      ...baseDeps().deps.git,
      mergeInWorktree: () => ({
        ok: false,
        reason: mergeReason,
      }),
    },
    github: {
      ...baseDeps().deps.github,
      demote: async () => { demoteCalls += 1; return { prUrl: "https://x/pr/1" }; },
    },
    notify: {
      recordRun: (d, e) => recorded.push(e),
      cleanupReviews: () => {},
      escalate: (orchDir, branch, brief) => { escalated = { branch, brief }; },
    },
  });
  const r = await finalize(ctx(), deps);
  assert.equal(r.status, "merge-deferred");
  assert.equal(r.trigger, "dirty-merge");
  assert.equal(r.prUrl, null); // never open a per-change agent PR against main
  assert.equal(demoteCalls, 0); // github.demote is the PR-to-main path — must not run
  assert.equal(escalated?.branch, "pr/claude/x-1");
  assert.match(escalated.brief, /Do not open a PR from this branch to main/);
  assert.match(escalated.brief, /hand-merge|Hand-merge/);
  assert.match(escalated.brief, /orch\/integration/);
  assert.match(r.reason, /escalated for hand-merge into orch\/integration/);
  assert.match(r.reason, /trigger \| dirty-merge/);
  assert.ok(r.reason.includes(`merge result:\n\`\`\`\n${mergeReason}\n\`\`\``));
  assert.match(r.reason, /<details><summary>raw merge output<\/summary>/); // dump collapsed, not headline
  assert.match(r.reason, /conflicting paths: src\/a\.js/);
  assert.match(r.reason, /next action: hand-merge this branch into `orch\/integration`/);
  assert.match(r.reason, /do not open a per-change PR against main/);
  assert.equal(recorded[0].trigger, "dirty-merge");
  assert.equal("prUrl" in recorded[0], false);
});

test("demote reason is teaching-toned markdown, not a raw machine dump", async () => {
  const mergeReason = "CONFLICT (content): Merge conflict in CHANGELOG.md";
  const { deps } = baseDeps({
    git: { ...baseDeps().deps.git, mergeInWorktree: () => ({ ok: false, reason: mergeReason }) },
  });
  const r = await finalize(ctx(), deps);
  // Sectioned, professor-tone markdown — the four headings the operator reads.
  assert.match(r.reason, /## Merge deferred: dirty-merge/);
  assert.match(r.reason, /## What blocked the automatic landing/);
  assert.match(r.reason, /## Signals/);
  assert.match(r.reason, /## Next step/);
  // Leads with "approved + green", so a human sees at a glance the work is sound.
  assert.match(r.reason, /\*\*approved\*\*/);
  assert.match(r.reason, /\*\*green\*\*/);
  // The git internals are available but collapsed, not the headline.
  assert.match(r.reason, /<details><summary>raw merge output<\/summary>[\s\S]*<\/details>/);
  // Machine facts survive: the Signals table still carries every value.
  assert.match(r.reason, /\| trigger \| dirty-merge \|/);
  assert.match(r.reason, /\| test gate \| passed on branch \(npm test\) \|/);
});

test("post-merge test failure → reset + merge-deferred", async () => {
  const resets = [];
  const g = baseDeps().deps.git;
  const { deps, recorded } = baseDeps({
    gate: { run: () => ({ pass: false, log: "boom" }) },
    git: { ...g, git: (args) => { if (args[0] === "reset") resets.push(args); return args[0] === "rev-parse" ? "pre" : ""; } },
  });
  const r = await finalize(ctx(), deps);
  assert.equal(r.status, "merge-deferred");
  assert.equal(r.trigger, "integration-test");
  assert.equal(recorded[0].trigger, "integration-test");
  assert.match(r.reason, /trigger \| integration-test/);
  assert.match(r.reason, /integration gate: failed after merge/);
  assert.ok(resets.length === 1); // rolled main back to pre-merge sha
});

test("demote reason is forwarded to github.demote for non-dirty-merge triggers (final-review I2)", async () => {
  // dirty-merge escalates without opening a PR; overlap still uses github.demote.
  let capturedCtx;
  const { deps } = baseDeps({
    inflight: { peerPaths: () => ["src/a.js"] },
    github: { demote: async (c) => { capturedCtx = c; return { prUrl: "https://x/pr/1" }; } },
    deferred: { record: () => {}, list: () => [] },
  });
  const r = await finalize(ctx(), deps);
  assert.equal(r.status, "merge-deferred");
  assert.equal(r.trigger, "overlap");
  assert.match(capturedCtx.reason, /trigger \| overlap/); // reason threaded via { ...ctx, reason }
});

test("dirty-merge escalates with demote reason (no github.demote / no PR to main)", async () => {
  let capturedBrief = null;
  let demoteCalls = 0;
  const { deps } = baseDeps({
    git: { ...baseDeps().deps.git, mergeInWorktree: () => ({ ok: false, reason: "CONFLICT (content): Merge conflict in src/a.js" }) },
    github: { demote: async () => { demoteCalls += 1; return { prUrl: "https://x/pr/1" }; } },
    notify: {
      recordRun: () => {},
      cleanupReviews: () => {},
      escalate: (_o, _b, brief) => { capturedBrief = brief; },
    },
  });
  const r = await finalize(ctx(), deps);
  assert.equal(r.status, "merge-deferred");
  assert.equal(r.trigger, "dirty-merge");
  assert.equal(demoteCalls, 0);
  assert.equal(r.prUrl, null);
  assert.match(capturedBrief, /trigger \| dirty-merge/);
  assert.match(capturedBrief, /Do not open a PR from this branch to main/);
});

test("issue bridge: closes #N is stamped into the no-ff merge commit message", async () => {
  let mergeArgs;
  const { deps } = baseDeps({
    git: { ...baseDeps().deps.git, mergeInWorktree: (path, branch, mode, message) => { mergeArgs = { mode, message }; return { ok: true, reason: "merged" }; } },
  });
  const r = await finalize({ ...ctx(), closes: 53 }, deps);
  assert.equal(r.status, "merged");
  assert.match(mergeArgs.message, /Closes #53/);
});

test("no closes → merge message stays null (plain task path unchanged)", async () => {
  let mergeArgs;
  const { deps } = baseDeps({
    git: { ...baseDeps().deps.git, mergeInWorktree: (path, branch, mode, message) => { mergeArgs = { message }; return { ok: true, reason: "merged" }; } },
  });
  await finalize(ctx(), deps);
  assert.equal(mergeArgs.message, null);
});

test("issue bridge: closes #N reaches github.demote when a non-dirty-merge merge is blocked", async () => {
  // Use overlap (still demotes via PR path); dirty-merge no longer calls github.demote.
  let capturedCtx;
  const { deps } = baseDeps({
    inflight: { peerPaths: () => ["src/a.js"] },
    github: { demote: async (c) => { capturedCtx = c; return { prUrl: "https://x/pr/1" }; } },
    deferred: { record: () => {}, list: () => [] },
  });
  await finalize({ ...ctx(), closes: 52 }, deps);
  assert.equal(capturedCtx.closes, 52);
});

test("release.autoBump off (default) → clean merge never calls bumpVersion", async () => {
  let calls = 0;
  const { deps } = baseDeps({
    git: { ...baseDeps().deps.git, bumpVersion: () => { calls += 1; return "0.1.1"; } },
  });
  const r = await finalize(ctx(), deps);
  assert.equal(r.status, "merged");
  assert.equal(calls, 0);
});

test("release.autoBump on → clean merge runs the version bump exactly once against the integration worktree", async () => {
  let bumpArgs;
  let calls = 0;
  const { deps } = baseDeps({
    git: { ...baseDeps().deps.git, bumpVersion: (path, entry) => { calls += 1; bumpArgs = { path, entry }; return "0.1.1"; } },
  });
  const r = await finalize(bumpCtx(), deps);
  assert.equal(r.status, "merged");
  assert.equal(calls, 1);
  assert.equal(bumpArgs.path, "/integ");
  assert.equal(bumpArgs.entry, "pr/claude/x-1");
});

test("clean merge with task: version bump entry uses the human title", async () => {
  let bumpArgs;
  const { deps } = baseDeps({
    git: { ...baseDeps().deps.git, bumpVersion: (path, entry) => { bumpArgs = { path, entry }; return "0.1.1"; } },
  });
  await finalize({ ...bumpCtx(), task: "Demote escalation output too terse for humans" }, deps);
  assert.equal(bumpArgs.entry, "Demote escalation output too terse for humans");
});

test("clean merge with closes: version bump entry links the issue number", async () => {
  let bumpArgs;
  const { deps } = baseDeps({
    git: { ...baseDeps().deps.git, bumpVersion: (path, entry) => { bumpArgs = { path, entry }; return "0.1.1"; } },
  });
  await finalize({ ...bumpCtx(), task: "Demote escalation output too terse for humans", closes: 53 }, deps);
  assert.equal(
    bumpArgs.entry,
    "Demote escalation output too terse for humans (closes [#53](https://github.com/bbk1ng/agent-orch/issues/53))",
  );
});

test("post-merge test failure → version bump never runs (rolled back first)", async () => {
  let bumped = false;
  const g = baseDeps().deps.git;
  const { deps } = baseDeps({
    gate: { run: () => ({ pass: false, log: "boom" }) },
    git: { ...g, bumpVersion: () => { bumped = true; }, git: (args) => (args[0] === "rev-parse" ? "pre" : "") },
  });
  await finalize(bumpCtx(), deps);
  assert.equal(bumped, false);
});

test("clean merge → recorded run history includes total tokens and estimated cost", async () => {
  const { deps, recorded } = baseDeps();
  const runStats = [
    { role: "author", agent: "claude", model: "claude-opus-4.8", tokens: 1200, costUsd: 0.03 },
    { role: "reviewer", agent: "codex", model: "gpt-5.1", tokens: 800, costUsd: 0.01 },
  ];
  const r = await finalize({ ...ctx(), runStats }, deps);
  assert.equal(r.status, "merged");
  assert.equal(recorded[0].tokens, 2000);
  assert.equal(recorded[0].costUsd, 0.04);
});

test("clean merge → recorded run history omits tokens/cost when nothing was measured", async () => {
  const { deps, recorded } = baseDeps();
  const r = await finalize(ctx(), deps);
  assert.equal(r.status, "merged");
  assert.equal("tokens" in recorded[0], false);
  assert.equal("costUsd" in recorded[0], false);
});

test("merge-deferred (demote) → recorded run history includes total tokens and estimated cost", async () => {
  const { deps, recorded } = baseDeps({
    git: { ...baseDeps().deps.git, mergeInWorktree: () => ({ ok: false, reason: "CONFLICT" }) },
  });
  const runStats = [{ role: "author", agent: "claude", model: "claude-opus-4.8", tokens: 500, costUsd: 0.02 }];
  const r = await finalize({ ...ctx(), runStats }, deps);
  assert.equal(r.status, "merge-deferred");
  assert.equal(recorded[0].trigger, "dirty-merge");
  assert.equal(recorded[0].tokens, 500);
  assert.equal(recorded[0].costUsd, 0.02);
});

test("merge: pr → opens a PR instead of merging locally, no lock taken", async () => {
  let locked = false;
  let mergedInWorktree = false;
  const { deps, recorded } = baseDeps({
    lock: { acquireBlocking: () => { locked = true; return true; }, releaseLock: () => {} },
    git: { ...baseDeps().deps.git, mergeInWorktree: () => { mergedInWorktree = true; return { ok: true }; } },
    github: { openPr: async () => ({ prUrl: "https://x/pr/9" }) },
  });
  const r = await finalize({ ...ctx(), cfg: { merge: "pr" } }, deps);
  assert.equal(r.status, "pr");
  assert.equal(r.prUrl, "https://x/pr/9");
  assert.equal(locked, false);
  assert.equal(mergedInWorktree, false);
  assert.equal(recorded[0].sid, "1");
  assert.equal(recorded[0].verdict, "pr");
});

test("merge: pr with no remote/gh → escalated, no crash", async () => {
  const { deps, recorded } = baseDeps({ github: { openPr: async () => ({ prUrl: null }) } });
  const r = await finalize({ ...ctx(), cfg: { merge: "pr" } }, deps);
  assert.equal(r.status, "escalated");
  assert.equal(recorded[0].sid, "1");
  assert.equal(recorded[0].verdict, "escalated");
});

test("re-syncs local main from origin before touching the integration worktree", async () => {
  const calls = [];
  const g = baseDeps().deps.git;
  const { deps } = baseDeps({
    git: {
      ...g,
      syncMainFromOrigin: () => { calls.push("sync"); return { ok: true }; },
      ensureIntegrationWorktree: (_repo, _orchDir, branch) => { calls.push(`ensure:${branch}`); return "/integ"; },
    },
  });
  const r = await finalize(ctx(), deps);
  assert.equal(r.status, "merged");
  assert.deepEqual(calls, ["sync", "ensure:orch/integration"]);
});

test("passes cfg.baseBranch into syncMainFromOrigin and ensureIntegrationWorktree", async () => {
  const calls = [];
  const g = baseDeps().deps.git;
  const { deps } = baseDeps({
    git: {
      ...g,
      syncMainFromOrigin: (_repo, base) => { calls.push(["sync", base]); return { ok: true }; },
      ensureIntegrationWorktree: (_repo, _orchDir, branch, base) => { calls.push(["ensure", branch, base]); return "/integ"; },
    },
  });

  const r = await finalize({ ...ctx(), cfg: { merge: "no-ff", integrationBranch: "orch/integration", baseBranch: "dev" } }, deps);

  assert.equal(r.status, "merged");
  assert.deepEqual(calls[0], ["sync", "dev"]);
  assert.deepEqual(calls[1], ["ensure", "orch/integration", "dev"]);
});

test("direct-to-main advance followed by finalize leaves integration ahead, not diverged", async () => {
  const repo = newRepo();
  const remote = addOrigin(repo);
  const orchDir = join(repo, ".orch");

  gitMod.git(["checkout", "-b", "pr/claude/x"], repo);
  commitFile(repo, "feature.txt", "feature\n", "feature");
  gitMod.git(["checkout", "main"], repo);
  gitMod.ensureIntegrationWorktree(repo, orchDir);

  const peer = cloneRemote(remote);
  commitFile(peer, "direct.txt", "direct\n", "direct to main");
  gitMod.git(["push", "origin", "main"], peer);

  const recorded = [];
  const r = await finalize({
    repo,
    orchDir,
    branch: "pr/claude/x",
    sid: "direct-main",
    baseSha: "base",
    paths: ["feature.txt"],
    testCmd: "true",
    cfg: { merge: "no-ff", integrationBranch: "orch/integration" },
    rounds: 1,
  }, {
    git: gitMod,
    gate: { run: () => ({ pass: true, log: "" }) },
    lock: { acquireBlocking: () => true, releaseLock: () => {} },
    inflight: { peerPaths: () => [] },
    github: { demote: async () => ({ prUrl: null }), openIntegrationPr: async () => ({ prUrl: null }) },
    notify: { recordRun: (_d, e) => recorded.push(e), cleanupReviews: () => {} },
  });

  assert.equal(r.status, "merged");
  assert.equal(recorded[0].verdict, "merged");
  const counts = gitMod.git(["rev-list", "--left-right", "--count", "origin/main...orch/integration"], repo)
    .split(/\s+/)
    .map(Number);
  assert.equal(counts[0], 0);
  assert.ok(counts[1] > 0);
  assert.doesNotThrow(() => gitMod.git(["merge-base", "--is-ancestor", "origin/main", "orch/integration"], repo));
});

test("main diverged from origin at merge time → merge-deferred (no merge attempted, GitHub main preserved)", async () => {
  let merged = false;
  const { deps, recorded } = baseDeps({
    git: {
      ...baseDeps().deps.git,
      syncMainFromOrigin: () => ({ ok: false, reason: "local main has diverged from origin/main" }),
      mergeInWorktree: () => { merged = true; return { ok: true }; },
    },
  });
  const r = await finalize(ctx(), deps);
  assert.equal(r.status, "merge-deferred");
  assert.equal(r.trigger, "sync");
  assert.match(r.reason, /trigger \| sync/);
  assert.match(r.reason, /diverged from origin/);
  assert.match(r.reason, /next action: inspect local main/);
  assert.equal(merged, false);
  assert.equal(recorded[0].verdict, "merge-deferred");
  assert.equal(recorded[0].trigger, "sync");
});

test("local main ahead of origin at merge time → merge-deferred (orch never pushes main)", async () => {
  let merged = false;
  const { deps, recorded } = baseDeps({
    git: {
      ...baseDeps().deps.git,
      syncMainFromOrigin: () => ({ ok: false, reason: "local main is ahead of origin/main" }),
      mergeInWorktree: () => { merged = true; return { ok: true }; },
    },
  });
  const r = await finalize(ctx(), deps);
  assert.equal(r.status, "merge-deferred");
  assert.equal(r.trigger, "sync");
  assert.match(r.reason, /trigger \| sync/);
  assert.match(r.reason, /ahead of origin/);
  assert.equal(merged, false);
  assert.equal(recorded[0].verdict, "merge-deferred");
  assert.equal(recorded[0].trigger, "sync");
});

test("integration diverged from its own origin at merge time → merge-deferred (no merge on an ambiguous base)", async () => {
  let merged = false;
  const { deps, recorded } = baseDeps({
    git: {
      ...baseDeps().deps.git,
      reconcileIntegrationToOrigin: () => ({ ok: false, reason: "local orch/integration has diverged from origin/orch/integration" }),
      mergeInWorktree: () => { merged = true; return { ok: true }; },
    },
  });
  const r = await finalize(ctx(), deps);
  assert.equal(r.status, "merge-deferred");
  assert.equal(r.trigger, "sync");
  assert.match(r.reason, /diverged from origin\/orch\/integration/);
  assert.equal(merged, false);
  assert.equal(recorded[0].verdict, "merge-deferred");
  assert.equal(recorded[0].trigger, "sync");
});

test("merge-lock timeout → merge-deferred without touching the worktree", async () => {
  let ensured = false;
  let releaseCalls = 0;
  const { deps, recorded } = baseDeps({
    lock: { acquireBlocking: () => false, releaseLock: () => { releaseCalls++; } },
    git: { ...baseDeps().deps.git, ensureIntegrationWorktree: () => { ensured = true; return "/integ"; } },
  });
  const r = await finalize(ctx(), deps);
  assert.equal(r.status, "merge-deferred");
  assert.equal(r.trigger, "lock");
  assert.equal(recorded[0].trigger, "lock");
  assert.match(r.reason, /trigger \| lock/);
  assert.match(r.reason, /next action: retry/);
  assert.equal(ensured, false);
  assert.equal(releaseCalls, 0); // must not release a lock we never acquired
});

test("merged path deletes the cycle's remote pr/* head (#339)", async () => {
  let deleted = null;
  const { deps } = baseDeps({
    git: {
      ...baseDeps().deps.git,
      deleteRemoteBranch: (repo, branch) => { deleted = { repo, branch }; return { ok: true }; },
    },
  });
  const r = await finalize(ctx(), deps);
  assert.equal(r.status, "merged");
  assert.deepEqual(deleted, { repo: "/r", branch: "pr/claude/x-1" });
});

test("PR-bridge failure after local merge leaves the remote head alone — origin/integration is stale, the head is the recovery copy (#339)", async () => {
  let deleted = false;
  const { deps } = baseDeps({
    github: {
      ...baseDeps().deps.github,
      openIntegrationPr: async () => { throw new Error("gh push failed"); },
    },
    notify: { recordRun: () => {}, cleanupReviews: () => {}, escalate: () => {} },
    git: {
      ...baseDeps().deps.git,
      deleteRemoteBranch: () => { deleted = true; return { ok: true }; },
    },
  });
  const r = await finalize(ctx(), deps);
  assert.equal(r.status, "merged");
  assert.equal(r.prUrl, null);
  assert.equal(deleted, false); // must NOT delete: content may live only locally
});

test("demote path leaves the remote head alone — its open PR still needs it (#339)", async () => {
  let deleted = false;
  const { deps } = baseDeps({
    git: {
      ...baseDeps().deps.git,
      mergeInWorktree: () => ({ ok: false, reason: "CONFLICT in src/a.js" }),
      deleteRemoteBranch: () => { deleted = true; return { ok: true }; },
    },
  });
  const r = await finalize(ctx(), deps);
  assert.equal(r.status, "merge-deferred");
  assert.equal(deleted, false);
});

test("merged path never deletes the integration or base branch even if handed as ctx.branch (#339)", async () => {
  let deleted = null;
  const { deps } = baseDeps({
    git: {
      ...baseDeps().deps.git,
      deleteRemoteBranch: (repo, branch) => { deleted = branch; return { ok: true }; },
    },
  });
  // A misconfiguration that names the integration branch as the cycle branch must
  // not turn cleanup into self-destruction.
  const r = await finalize({ ...ctx(), branch: "orch/integration" }, deps);
  assert.equal(r.status, "merged");
  assert.equal(deleted, null);
});
