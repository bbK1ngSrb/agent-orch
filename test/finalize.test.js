import { test } from "node:test";
import assert from "node:assert/strict";
import { finalize } from "../src/finalize.js";

function baseDeps(over = {}) {
  const recorded = [];
  const deps = {
    git: {
      ensureIntegrationWorktree: () => "/integ",
      syncWorktreeToMain: () => {},
      changedSince: () => [],
      mergeInWorktree: () => ({ ok: true, reason: "merged" }),
      git: (args) => (args[0] === "rev-parse" ? "deadbee" : ""),
    },
    gate: { run: () => ({ pass: true, log: "" }) },
    lock: { acquireBlocking: () => true, releaseLock: () => {} },
    inflight: { peerPaths: () => [] },
    github: { demote: async () => ({ prUrl: "https://x/pr/1" }) },
    notify: { recordRun: (d, e) => recorded.push(e), cleanupReviews: () => {} },
  };
  return { deps: { ...deps, ...over }, recorded };
}

const ctx = () => ({
  repo: "/r", orchDir: "/r/.orch", branch: "pr/claude/x-1", sid: "1",
  baseSha: "base", paths: ["src/a.js"], testCmd: "npm test", cfg: { merge: "no-ff" }, rounds: 1,
});

test("clean path → merged + recorded", async () => {
  const { deps, recorded } = baseDeps();
  const r = await finalize(ctx(), deps);
  assert.equal(r.status, "merged");
  assert.equal(recorded[0].verdict, "merged");
});

test("path overlap with a peer → pr-fallback (no merge attempted)", async () => {
  let merged = false;
  const { deps, recorded } = baseDeps({
    inflight: { peerPaths: () => ["src/a.js"] },
    git: { ...baseDeps().deps.git, mergeInWorktree: () => { merged = true; return { ok: true }; } },
  });
  const r = await finalize(ctx(), deps);
  assert.equal(r.status, "pr-fallback");
  assert.equal(r.reason.includes("overlap"), true);
  assert.equal(merged, false);
  assert.equal(recorded[0].verdict, "pr-fallback");
});

test("overlap with a changeset landed since base → pr-fallback", async () => {
  const { deps } = baseDeps({ git: { ...baseDeps().deps.git, changedSince: () => ["src/a.js"] } });
  const r = await finalize(ctx(), deps);
  assert.equal(r.status, "pr-fallback");
  assert.match(r.reason, /overlap/);
});

test("merge conflict → pr-fallback", async () => {
  const { deps } = baseDeps({ git: { ...baseDeps().deps.git, mergeInWorktree: () => ({ ok: false, reason: "CONFLICT" }) } });
  const r = await finalize(ctx(), deps);
  assert.equal(r.status, "pr-fallback");
  assert.match(r.reason, /conflict/);
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
  assert.match(r.reason, /post-merge-test-fail/);
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
  assert.equal(capturedCtx.reason, "conflict"); // reason threaded via { ...ctx, reason }
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

test("merge-lock timeout → pr-fallback without touching the worktree", async () => {
  let ensured = false;
  let releaseCalls = 0;
  const { deps } = baseDeps({
    lock: { acquireBlocking: () => false, releaseLock: () => { releaseCalls++; } },
    git: { ...baseDeps().deps.git, ensureIntegrationWorktree: () => { ensured = true; return "/integ"; } },
  });
  const r = await finalize(ctx(), deps);
  assert.equal(r.status, "pr-fallback");
  assert.equal(ensured, false);
  assert.equal(releaseCalls, 0); // must not release a lock we never acquired
});
