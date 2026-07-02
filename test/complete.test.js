import { test } from "node:test";
import assert from "node:assert/strict";
import { finishRun } from "../src/complete.js";

// A mock git facade + io recorder. Each test overrides only what it cares about.
function mk(over = {}) {
  const calls = { detach: 0, deleted: [], forced: [], confirms: [] };
  const printed = [];
  const git = {
    git: () => "abc123",                       // rev-parse --short main
    pushMain: () => ({ ok: true }),
    currentBranch: () => "orch/x",
    detachToMain: () => { calls.detach++; },
    deleteBranchSafe: (_r, br) => { calls.deleted.push(br); return { ok: true }; },
    forceDeleteBranch: (_r, br) => { calls.forced.push(br); },
    ...over.git,
  };
  const io = {
    print: (m) => printed.push(m),
    confirm: async (q) => { calls.confirms.push(q); return over.confirmAnswer ?? false; },
    ...over.io,
  };
  return { deps: { git, io, notify: over.notify }, calls, printed, summary: () => printed.join("\n") };
}

const ctx = (over = {}) => ({
  repo: "/r", task: "make it nice",
  operatorBranch: "orch/make-it-nice",
  merged: ["pr/claude/make-it-nice-1"],
  interactive: true,
  ...over,
});

test("merged + push ok: pushes, detaches, safe-deletes both branches, summarizes", async () => {
  const { deps, calls, summary } = mk();
  const r = await finishRun(ctx(), deps);
  assert.equal(r.pushed, true);
  assert.equal(calls.detach, 1);
  assert.deepEqual(calls.deleted.sort(), ["orch/make-it-nice", "pr/claude/make-it-nice-1"]);
  assert.equal(calls.forced.length, 0);
  assert.deepEqual(r.deleted.sort(), ["orch/make-it-nice", "pr/claude/make-it-nice-1"]);
  assert.equal(r.leftover.length, 0);
  const s = summary();
  assert.match(s, /All done/i);
  assert.match(s, /GitHub/i);          // mentions it was saved
  assert.match(s, /main/);             // mentions merged main result
});

test("push fails (no remote): reports not-synced with a git push hint, still deletes branches", async () => {
  const { deps, calls, summary } = mk({ git: { pushMain: () => ({ ok: false, reason: "no 'origin' remote configured" }) } });
  const r = await finishRun(ctx(), deps);
  assert.equal(r.pushed, false);
  assert.match(r.pushReason, /origin/);
  assert.equal(calls.deleted.length, 2);     // local cleanup proceeds regardless
  const s = summary();
  assert.match(s, /git push origin main/);   // plain-English manual hint
  assert.match(s, /no 'origin' remote/);
});

test("push rejected after origin advances: resets main and stops before cleanup", async () => {
  let resets = 0;
  const { deps, calls } = mk({
    git: {
      pushMain: () => ({ ok: false, reason: "non-fast-forward" }),
      resetMainToOriginIfDiverged: () => ({ rolledBack: true }),
    },
    notify: { resetKpi: () => { resets++; } },
  });
  await assert.rejects(
    () => finishRun(ctx({ orchDir: "/r/.orch" }), deps),
    /origin\/main has advanced/,
  );
  assert.equal(resets, 1);
  assert.equal(calls.detach, 0);
  assert.equal(calls.deleted.length, 0);
});

test("push reports ok but origin/main never moved: not treated as saved", async () => {
  const { deps, summary } = mk({
    git: {
      pushMain: () => ({ ok: true }),
      // main is at abc123; origin/main disagrees even though push claimed success.
      git: (args) => (args.includes("origin/main") ? "stalesha" : "abc123"),
    },
  });
  const r = await finishRun(ctx(), deps);
  assert.equal(r.pushed, false);
  assert.match(r.pushReason, /origin\/main is stalesha, not abc123/);
  const s = summary();
  assert.match(s, /Not saved to GitHub/i);
});

test("unmerged branch + interactive YES: warns with ❗, force-deletes after consent", async () => {
  const { deps, calls } = mk({
    confirmAnswer: true,
    git: { deleteBranchSafe: (_r, br) => ({ ok: false, unmerged: true }) },
  });
  const r = await finishRun(ctx({ merged: [], operatorBranch: "orch/foo" }), deps);
  assert.equal(calls.confirms.length, 1);
  assert.match(calls.confirms[0], /❗/);
  assert.match(calls.confirms[0], /cannot be undone/i);
  assert.deepEqual(calls.forced, ["orch/foo"]);
  assert.deepEqual(r.deleted, ["orch/foo"]);
  assert.equal(r.leftover.length, 0);
});

test("unmerged branch + interactive NO: skips, lists leftover, never force-deletes", async () => {
  const { deps, calls, summary } = mk({
    confirmAnswer: false,
    git: { deleteBranchSafe: () => ({ ok: false, unmerged: true }) },
  });
  const r = await finishRun(ctx({ merged: [], operatorBranch: "orch/foo" }), deps);
  assert.equal(calls.confirms.length, 1);
  assert.equal(calls.forced.length, 0);
  assert.deepEqual(r.leftover, ["orch/foo"]);
  assert.match(summary(), /attention/i);
});

test("non-interactive + unmerged branch: never prompts, never force-deletes, reports leftover", async () => {
  const { deps, calls } = mk({
    git: { deleteBranchSafe: () => ({ ok: false, unmerged: true }) },
  });
  const r = await finishRun(ctx({ interactive: false, merged: [], operatorBranch: "orch/foo" }), deps);
  assert.equal(calls.confirms.length, 0);
  assert.equal(calls.forced.length, 0);
  assert.deepEqual(r.leftover, ["orch/foo"]);
});

test("operatorBranch null: does not touch the operator's own checkout, still deletes merged cycle branch", async () => {
  const { deps, calls } = mk();
  const r = await finishRun(ctx({ operatorBranch: null }), deps);
  assert.equal(calls.detach, 0);                          // operator was never moved by orch — leave them be
  assert.deepEqual(calls.deleted, ["pr/claude/make-it-nice-1"]);
  assert.ok(!r.deleted.includes("orch/make-it-nice"));
});

// A cleanup step must never turn a *successful merge* into a crash (#44's whole point).
test("detach fails (e.g. uncommitted edits): no crash, operator kept on their branch + told so", async () => {
  const { deps, calls, summary } = mk({
    git: { detachToMain: () => { throw new Error("Your local changes would be overwritten"); } },
  });
  const r = await finishRun(ctx(), deps);                       // must resolve, not reject
  assert.equal(r.parked, "orch/make-it-nice");
  assert.ok(!calls.deleted.includes("orch/make-it-nice"));     // still checked out → not deleted
  assert.deepEqual(calls.deleted, ["pr/claude/make-it-nice-1"]); // cycle branch still tidied
  assert.match(summary(), /still on/i);
  assert.match(summary(), /orch\/make-it-nice/);
  assert.match(summary(), /nothing was lost/i);
});

test("force-delete throws: degrades to leftover, never crashes", async () => {
  const { deps } = mk({
    confirmAnswer: true,
    git: { deleteBranchSafe: () => ({ ok: false, unmerged: true }), forceDeleteBranch: () => { throw new Error("locked"); } },
  });
  const r = await finishRun(ctx({ merged: [], operatorBranch: "orch/foo" }), deps);
  assert.deepEqual(r.leftover, ["orch/foo"]);
});

test("docs update spawned: summary says it's still finishing, not fully done", async () => {
  const { deps, summary } = mk();
  await finishRun(ctx({ docsPending: true }), deps);
  assert.match(summary(), /documentation update is (still )?running/i);
});

test("summary includes aggregated run statistics", async () => {
  const { deps, summary } = mk();
  await finishRun(ctx({
    runStats: [
      { role: "author", agent: "claude", model: "claude-opus-4.8", tokens: 1000 },
      { role: "reviewer", agent: "codex", model: "gpt-5.1", tokens: 500 },
      { role: "reviewer", agent: "codex", model: "gpt-5.1", tokens: 500 },
    ],
  }), deps);
  const s = summary();
  assert.match(s, /Run statistics:/);
  assert.match(s, /author claude used claude-opus-4\.8: 1,000 tokens \(50%\)/);
  assert.match(s, /reviewer codex used gpt-5\.1: 1,000 tokens \(50%\)/);
  assert.match(s, /Total: 2,000 tokens/);
});

test("summary shows estimated $ cost per row and total when adapters report it", async () => {
  const { deps, summary } = mk();
  await finishRun(ctx({
    runStats: [
      { role: "author", agent: "claude", model: "claude-opus-4.8", tokens: 1000, costUsd: 0.03 },
      { role: "reviewer", agent: "codex", model: "gpt-5.1", tokens: 1000, costUsd: 0.01 },
    ],
  }), deps);
  const s = summary();
  assert.match(s, /author claude used claude-opus-4\.8: 1,000 tokens \(~\$0\.03\) \(50%\)/);
  assert.match(s, /reviewer codex used gpt-5\.1: 1,000 tokens \(~\$0\.01\) \(50%\)/);
  assert.match(s, /Total: 2,000 tokens \(~\$0\.04\)/);
});

test("summary omits run statistics when token usage is unmeasured", async () => {
  const { deps, summary } = mk();
  await finishRun(ctx({
    runStats: [
      { role: "author", agent: "claude", model: "claude-opus-4.8", tokens: 0 },
      { role: "reviewer", agent: "codex", model: "gpt-5.1", tokens: 0 },
    ],
  }), deps);
  const s = summary();
  assert.doesNotMatch(s, /Run statistics:/);
  assert.doesNotMatch(s, /Total: 0 tokens/);
});
