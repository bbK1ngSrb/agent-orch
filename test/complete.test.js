import { test } from "node:test";
import assert from "node:assert/strict";
import { finishRun } from "../src/complete.js";

// A mock git facade + io recorder. Each test overrides only what it cares about.
function mk(over = {}) {
  const calls = { deleted: [], forced: [], confirms: [] };
  const printed = [];
  const git = {
    git: () => "abc123",                       // rev-parse --short integrationBranch
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
  merged: ["pr/claude/make-it-nice-1"],
  interactive: true,
  integrationBranch: "orch/integration",
  prUrls: ["https://x/pr/99"],
  ...over,
});

test("integrated + PR bridge: safe-deletes merged branches and summarizes", async () => {
  const { deps, calls, summary } = mk();
  const r = await finishRun(ctx({ integrationBranch: undefined }), deps);
  assert.deepEqual(calls.deleted, ["pr/claude/make-it-nice-1"]);
  assert.equal(calls.forced.length, 0);
  assert.deepEqual(r.deleted, ["pr/claude/make-it-nice-1"]);
  assert.equal(r.leftover.length, 0);
  const s = summary();
  assert.match(s, /All done/i);
  assert.match(s, /orch\/integration \(abc123\)/);
  assert.match(s, /https:\/\/x\/pr\/99/);
  assert.match(s, /advance main/);
});

test("unmerged branch + interactive YES: warns with ❗, force-deletes after consent", async () => {
  const { deps, calls } = mk({
    confirmAnswer: true,
    git: { deleteBranchSafe: (_r, br) => ({ ok: false, unmerged: true }) },
  });
  const r = await finishRun(ctx({ merged: ["orch/foo"], integrationBranch: "orch/integration" }), deps);
  assert.equal(calls.confirms.length, 1);
  assert.match(calls.confirms[0], /❗/);
  assert.match(calls.confirms[0], /merged into orch\/integration/);
  assert.doesNotMatch(calls.confirms[0], /into main/);
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
  const r = await finishRun(ctx({ merged: ["orch/foo"] }), deps);
  assert.equal(calls.confirms.length, 1);
  assert.equal(calls.forced.length, 0);
  assert.deepEqual(r.leftover, ["orch/foo"]);
  assert.match(summary(), /attention/i);
});

test("non-interactive + unmerged branch: never prompts, never force-deletes, reports leftover", async () => {
  const { deps, calls } = mk({
    git: { deleteBranchSafe: () => ({ ok: false, unmerged: true }) },
  });
  const r = await finishRun(ctx({ interactive: false, merged: ["orch/foo"] }), deps);
  assert.equal(calls.confirms.length, 0);
  assert.equal(calls.forced.length, 0);
  assert.deepEqual(r.leftover, ["orch/foo"]);
});

test("force-delete throws: degrades to leftover, never crashes", async () => {
  const { deps } = mk({
    confirmAnswer: true,
    git: { deleteBranchSafe: () => ({ ok: false, unmerged: true }), forceDeleteBranch: () => { throw new Error("locked"); } },
  });
  const r = await finishRun(ctx({ merged: ["orch/foo"] }), deps);
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
