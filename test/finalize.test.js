import { test } from "node:test";
import assert from "node:assert/strict";
import { finalize } from "../src/finalize.js";

function baseDeps(over = {}) {
  const recorded = [];
  const deps = {
    git: {
      syncMainFromOrigin: () => ({ ok: true }),
      ensureIntegrationWorktree: () => "/integ",
      syncWorktreeToIntegration: () => {},
      changedSince: () => [],
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
    notify: { recordRun: (d, e) => recorded.push(e), cleanupReviews: () => {} },
  };
  return { deps: { ...deps, ...over }, recorded };
}

const ctx = () => ({
  repo: "/r", orchDir: "/r/.orch", branch: "pr/claude/x-1", sid: "1",
  baseSha: "base", paths: ["src/a.js"], testCmd: "npm test", cfg: { merge: "no-ff", integrationBranch: "orch/integration" }, rounds: 1,
});

test("clean path → merged + recorded", async () => {
  const { deps, recorded } = baseDeps();
  const r = await finalize(ctx(), deps);
  assert.equal(r.status, "merged");
  assert.equal(recorded[0].verdict, "merged");
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
  const { deps, recorded } = baseDeps({
    github: {
      ...baseDeps().deps.github,
      openIntegrationPr: async () => { bridged = true; return { prUrl: "https://x/pr/99" }; },
    },
  });
  const r = await finalize(ctx(), deps);
  assert.equal(r.status, "merged");
  assert.equal(r.prUrl, "https://x/pr/99");
  assert.equal(recorded[0].verdict, "merged");
  assert.equal(recorded[0].prUrl, "https://x/pr/99");
  assert.equal(bridged, true);
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

test("path overlap with a peer → pr-fallback (no merge attempted)", async () => {
  let merged = false;
  const { deps, recorded } = baseDeps({
    inflight: {
      listLive: () => [{ sid: "peer-2", paths: ["src/a.js"] }],
      peerPaths: () => { throw new Error("listLive should provide peer details"); },
    },
    git: { ...baseDeps().deps.git, mergeInWorktree: () => { merged = true; return { ok: true }; } },
  });
  const r = await finalize(ctx(), deps);
  assert.equal(r.status, "pr-fallback");
  assert.match(r.reason, /trigger: overlap/);
  assert.match(r.reason, /review: AGREE after 1 round/);
  assert.match(r.reason, /test gate: passed on branch \(npm test\)/);
  assert.match(r.reason, /branch state: base base; orch\/integration deadbee/);
  assert.match(r.reason, /peer overlap: peer-2: src\/a\.js/);
  assert.match(r.reason, /next action:/);
  assert.equal(merged, false);
  assert.equal(recorded[0].verdict, "pr-fallback");
  assert.match(recorded[0].reason, /peer overlap: peer-2: src\/a\.js/);
});

test("overlap with a changeset landed since base → pr-fallback", async () => {
  const g = baseDeps().deps.git;
  const { deps } = baseDeps({
    git: {
      ...g,
      changedSince: () => ["src/a.js"],
      git: (args, cwd) => {
        if (args[0] === "log") return "abc123 landed change\n";
        return g.git(args, cwd);
      },
    },
  });
  const r = await finalize(ctx(), deps);
  assert.equal(r.status, "pr-fallback");
  assert.match(r.reason, /landed overlap: src\/a\.js/);
  assert.match(r.reason, /landed commits: abc123 landed change/);
});

test("merge conflict → pr-fallback", async () => {
  const { deps } = baseDeps({
    git: {
      ...baseDeps().deps.git,
      mergeInWorktree: () => ({
        ok: false,
        reason: "CONFLICT (content): Merge conflict in src/a.js\nAutomatic merge failed",
      }),
    },
  });
  const r = await finalize(ctx(), deps);
  assert.equal(r.status, "pr-fallback");
  assert.match(r.reason, /trigger: conflict/);
  assert.match(r.reason, /conflicting paths: src\/a\.js/);
  assert.match(r.reason, /next action: resolve the merge conflict/);
});

test("post-merge test failure → reset + pr-fallback", async () => {
  const resets = [];
  const g = baseDeps().deps.git;
  const { deps } = baseDeps({
    gate: { run: () => ({ pass: false, log: "boom" }) },
    git: { ...g, git: (args) => { if (args[0] === "reset") resets.push(args); return args[0] === "rev-parse" ? "pre" : ""; } },
  });
  const r = await finalize(ctx(), deps);
  assert.equal(r.status, "pr-fallback");
  assert.match(r.reason, /trigger: post-merge-test-fail/);
  assert.match(r.reason, /integration gate: failed after merge/);
  assert.ok(resets.length === 1); // rolled main back to pre-merge sha
});

test("demote reason is forwarded to github.demote (final-review I2)", async () => {
  let capturedCtx;
  const { deps } = baseDeps({
    git: { ...baseDeps().deps.git, mergeInWorktree: () => ({ ok: false, reason: "CONFLICT" }) },
    github: { demote: async (c) => { capturedCtx = c; return { prUrl: "https://x/pr/1" }; } },
  });
  const r = await finalize(ctx(), deps);
  assert.equal(r.status, "pr-fallback");
  assert.match(capturedCtx.reason, /trigger: conflict/); // reason threaded via { ...ctx, reason }
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

test("issue bridge: closes #N reaches github.demote when a merge is blocked", async () => {
  let capturedCtx;
  const { deps } = baseDeps({
    git: { ...baseDeps().deps.git, mergeInWorktree: () => ({ ok: false, reason: "CONFLICT" }) },
    github: { demote: async (c) => { capturedCtx = c; return { prUrl: "https://x/pr/1" }; } },
  });
  await finalize({ ...ctx(), closes: 52 }, deps);
  assert.equal(capturedCtx.closes, 52);
});

test("clean merge → version bump runs against the integration worktree", async () => {
  let bumpArgs;
  const { deps } = baseDeps({
    git: { ...baseDeps().deps.git, bumpVersion: (path, entry) => { bumpArgs = { path, entry }; return "0.1.1"; } },
  });
  const r = await finalize(ctx(), deps);
  assert.equal(r.status, "merged");
  assert.equal(bumpArgs.path, "/integ");
  assert.equal(bumpArgs.entry, "pr/claude/x-1");
});

test("clean merge with closes: version bump entry includes the issue number", async () => {
  let bumpArgs;
  const { deps } = baseDeps({
    git: { ...baseDeps().deps.git, bumpVersion: (path, entry) => { bumpArgs = { path, entry }; return "0.1.1"; } },
  });
  await finalize({ ...ctx(), closes: 53 }, deps);
  assert.match(bumpArgs.entry, /closes #53/);
});

test("post-merge test failure → version bump never runs (rolled back first)", async () => {
  let bumped = false;
  const g = baseDeps().deps.git;
  const { deps } = baseDeps({
    gate: { run: () => ({ pass: false, log: "boom" }) },
    git: { ...g, bumpVersion: () => { bumped = true; }, git: (args) => (args[0] === "rev-parse" ? "pre" : "") },
  });
  await finalize(ctx(), deps);
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

test("pr-fallback (demote) → recorded run history includes total tokens and estimated cost", async () => {
  const { deps, recorded } = baseDeps({
    git: { ...baseDeps().deps.git, mergeInWorktree: () => ({ ok: false, reason: "CONFLICT" }) },
  });
  const runStats = [{ role: "author", agent: "claude", model: "claude-opus-4.8", tokens: 500, costUsd: 0.02 }];
  const r = await finalize({ ...ctx(), runStats }, deps);
  assert.equal(r.status, "pr-fallback");
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
  assert.equal(recorded[0].verdict, "pr");
});

test("merge: pr with no remote/gh → escalated, no crash", async () => {
  const { deps, recorded } = baseDeps({ github: { openPr: async () => ({ prUrl: null }) } });
  const r = await finalize({ ...ctx(), cfg: { merge: "pr" } }, deps);
  assert.equal(r.status, "escalated");
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

test("main diverged from origin at merge time → pr-fallback (no merge attempted, GitHub main preserved)", async () => {
  let merged = false;
  const { deps, recorded } = baseDeps({
    git: {
      ...baseDeps().deps.git,
      syncMainFromOrigin: () => ({ ok: false, reason: "local main has diverged from origin/main" }),
      mergeInWorktree: () => { merged = true; return { ok: true }; },
    },
  });
  const r = await finalize(ctx(), deps);
  assert.equal(r.status, "pr-fallback");
  assert.match(r.reason, /trigger: main-sync-failed/);
  assert.match(r.reason, /diverged from origin/);
  assert.match(r.reason, /next action: inspect local main/);
  assert.equal(merged, false);
  assert.equal(recorded[0].verdict, "pr-fallback");
});

test("local main ahead of origin at merge time → pr-fallback (orch never pushes main)", async () => {
  let merged = false;
  const { deps, recorded } = baseDeps({
    git: {
      ...baseDeps().deps.git,
      syncMainFromOrigin: () => ({ ok: false, reason: "local main is ahead of origin/main" }),
      mergeInWorktree: () => { merged = true; return { ok: true }; },
    },
  });
  const r = await finalize(ctx(), deps);
  assert.equal(r.status, "pr-fallback");
  assert.match(r.reason, /trigger: main-sync-failed/);
  assert.match(r.reason, /ahead of origin/);
  assert.equal(merged, false);
  assert.equal(recorded[0].verdict, "pr-fallback");
});

test("merge-lock timeout → pr-fallback without touching the worktree", async () => {
  let ensured = false;
  let releaseCalls = 0;
  const { deps } = baseDeps({
    lock: { acquireBlocking: () => false, releaseLock: () => { releaseCalls++; } },
    git: { ...baseDeps().deps.git, ensureIntegrationWorktree: () => { ensured = true; return "/integ"; } },
  });
  const r = await finalize(ctx(), deps);
  assert.equal(r.status, "pr-fallback");
  assert.match(r.reason, /trigger: merge-lock timeout/);
  assert.match(r.reason, /next action: retry/);
  assert.equal(ensured, false);
  assert.equal(releaseCalls, 0); // must not release a lock we never acquired
});
