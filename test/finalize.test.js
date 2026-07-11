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
    notify: { recordRun: (d, e) => recorded.push(e), cleanupReviews: () => {} },
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
  assert.match(r.reason, /trigger \| overlap/);
  assert.match(r.reason, /AGREE after 1 round/);
  assert.match(r.reason, /passed on branch \(npm test\)/);
  assert.match(r.reason, /base base; orch\/integration deadbee/);
  assert.match(r.reason, /peer overlap: peer-2: src\/a\.js/);
  assert.match(r.reason, /next action:/);
  assert.match(r.reason, /## Why this PR exists/); // teaching-toned, not a raw dump
  assert.equal(merged, false);
  assert.equal(recorded[0].sid, "1");
  assert.equal(recorded[0].verdict, "pr-fallback");
  assert.match(recorded[0].reason, /peer overlap: peer-2: src\/a\.js/);
});

test("merge conflict → pr-fallback", async () => {
  const mergeReason = "Auto-merging src/a.js\nCONFLICT (content): Merge conflict in src/a.js\nAutomatic merge failed";
  const { deps } = baseDeps({
    git: {
      ...baseDeps().deps.git,
      mergeInWorktree: () => ({
        ok: false,
        reason: mergeReason,
      }),
    },
  });
  const r = await finalize(ctx(), deps);
  assert.equal(r.status, "pr-fallback");
  assert.match(r.reason, /trigger \| conflict/);
  assert.ok(r.reason.includes(`merge result:\n\`\`\`\n${mergeReason}\n\`\`\``));
  assert.match(r.reason, /<details><summary>raw merge output<\/summary>/); // dump collapsed, not headline
  assert.match(r.reason, /conflicting paths: src\/a\.js/);
  assert.match(r.reason, /next action: resolve the merge conflict/);
});

test("demote reason is teaching-toned markdown, not a raw machine dump", async () => {
  const mergeReason = "CONFLICT (content): Merge conflict in CHANGELOG.md";
  const { deps } = baseDeps({
    git: { ...baseDeps().deps.git, mergeInWorktree: () => ({ ok: false, reason: mergeReason }) },
  });
  const r = await finalize(ctx(), deps);
  // Sectioned, professor-tone markdown — the four headings the operator reads.
  assert.match(r.reason, /## Why this PR exists/);
  assert.match(r.reason, /## What blocked the automatic landing/);
  assert.match(r.reason, /## Signals/);
  assert.match(r.reason, /## Next step/);
  // Leads with "approved + green", so a human sees at a glance the work is sound.
  assert.match(r.reason, /\*\*approved\*\*/);
  assert.match(r.reason, /\*\*green\*\*/);
  // The git internals are available but collapsed, not the headline.
  assert.match(r.reason, /<details><summary>raw merge output<\/summary>[\s\S]*<\/details>/);
  // Machine facts survive: the Signals table still carries every value.
  assert.match(r.reason, /\| trigger \| conflict \|/);
  assert.match(r.reason, /\| test gate \| passed on branch \(npm test\) \|/);
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
  assert.match(r.reason, /trigger \| post-merge-test-fail/);
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
  assert.match(capturedCtx.reason, /trigger \| conflict/); // reason threaded via { ...ctx, reason }
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
  assert.match(r.reason, /trigger \| main-sync-failed/);
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
  assert.match(r.reason, /trigger \| main-sync-failed/);
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
  assert.match(r.reason, /trigger \| merge-lock timeout/);
  assert.match(r.reason, /next action: retry/);
  assert.equal(ensured, false);
  assert.equal(releaseCalls, 0); // must not release a lock we never acquired
});
