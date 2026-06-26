import { test } from "node:test";
import assert from "node:assert/strict";
import { runCycle } from "../src/engine.js";

function makeDeps({ verdicts, gatePass = true, mergeOk = true, testCmd = "echo", changed = ["src/a.js"] }) {
  const calls = { authors: 0, audits: 0, revises: 0 };
  const reviewer = {
    name: "rev",
    async audit() {
      calls.audits++;
      return verdicts[Math.min(calls.audits - 1, verdicts.length - 1)];
    },
  };
  const author = {
    name: "auth",
    async author() { calls.authors++; },
    async audit() { return { decision: "AGREE", reason: "", raw: "" }; },
  };
  // revise reuses author.author via engine; count via wrapper
  const adapters = { get: (n) => (n === "auth" ? author : reviewer) };
  const deps = {
    adapters,
    git: {
      createTaskBranch() {},
      attachExistingBranch() {},
      pruneWorktree() {},
      mergeIntoMain() { return mergeOk ? { ok: true, reason: "merged" } : { ok: false, reason: "non-ff" }; },
      git() { return "diff summary"; },
      changedFiles() { return changed; },
    },
    gate: { detect: () => testCmd, run: () => ({ pass: gatePass, log: "" }) },
    scope: { count: () => 0 },
    notify: {
      phase() {}, writeRound() { return "p"; },
      buildDecisionBrief: () => "brief", escalate() { return "d"; },
      recordRun(_dir, entry) { calls.recorded = entry; },
      cleanupReviews(_dir, branch) { calls.cleaned = branch; },
    },
    _calls: calls,
  };
  return deps;
}

const opts = {
  task: "do x", branch: "pr/auth/x", authorName: "auth", reviewerName: "rev",
  cfg: { reviseCap: 3, merge: "ff-only", test: "auto", scope: { maxLines: 0, ignore: [] }, docs: { paths: ["*.md", "docs/**", "**/*.md"] } },
  orchDir: "/o", repo: "/r", worktree: "/wt",
};

test("AGREE + green gate -> merged", async () => {
  const deps = makeDeps({ verdicts: [{ decision: "AGREE", reason: "ok", raw: "" }] });
  const r = await runCycle(opts, deps);
  assert.equal(r.status, "merged");
  assert.equal(deps._calls.authors, 1);
});

test("merged result stamps docsOnly=false for a code change", async () => {
  const deps = makeDeps({ verdicts: [{ decision: "AGREE", reason: "ok", raw: "" }], changed: ["src/a.js", "README.md"] });
  const r = await runCycle(opts, deps);
  assert.equal(r.status, "merged");
  assert.equal(r.docsOnly, false);
});

test("merged result stamps docsOnly=true for a docs-only change", async () => {
  const deps = makeDeps({ verdicts: [{ decision: "AGREE", reason: "ok", raw: "" }], changed: ["README.md", "docs/x.md"] });
  const r = await runCycle(opts, deps);
  assert.equal(r.status, "merged");
  assert.equal(r.docsOnly, true);
});

test("docsOnly is read BEFORE merge (ff merge empties main...branch)", async () => {
  // Regression: a ff merge makes `main...branch` empty, so reading changedFiles
  // after the merge always yields [] -> docsOnly=false -> broken loop guard.
  const deps = makeDeps({ verdicts: [{ decision: "AGREE", reason: "ok", raw: "" }], changed: ["README.md"] });
  let mergedYet = false;
  deps.git.mergeIntoMain = () => { mergedYet = true; return { ok: true, reason: "merged" }; };
  deps.git.changedFiles = () => (mergedYet ? [] : ["README.md"]);
  const r = await runCycle(opts, deps);
  assert.equal(r.status, "merged");
  assert.equal(r.docsOnly, true); // would be false if read after merge
});

test("AGREE + red gate -> escalated, no merge", async () => {
  const deps = makeDeps({ verdicts: [{ decision: "AGREE", reason: "ok", raw: "" }], gatePass: false });
  const r = await runCycle(opts, deps);
  assert.equal(r.status, "escalated");
  assert.match(r.reason, /tests/i);
});

test("merge wipes reviews + records the run; escalation keeps them", async () => {
  const merged = makeDeps({ verdicts: [{ decision: "AGREE", reason: "ok", raw: "" }] });
  await runCycle(opts, merged);
  assert.equal(merged._calls.cleaned, opts.branch);
  assert.equal(merged._calls.recorded.verdict, "merged");

  const stalled = makeDeps({ verdicts: [{ decision: "DISAGREE", reason: "no", raw: "" }] });
  await runCycle(opts, stalled);
  assert.equal(stalled._calls.cleaned, undefined); // reviews survive for arbitration
});

test("DISAGREE until cap -> escalated after reviseCap rounds", async () => {
  const deps = makeDeps({ verdicts: [{ decision: "DISAGREE", reason: "no", raw: "" }] });
  const r = await runCycle(opts, deps);
  assert.equal(r.status, "escalated");
  assert.equal(r.rounds, 3);
});

test("DISAGREE then AGREE -> merged on round 2", async () => {
  const deps = makeDeps({
    verdicts: [
      { decision: "DISAGREE", reason: "fix", raw: "" },
      { decision: "AGREE", reason: "ok", raw: "" },
    ],
  });
  const r = await runCycle(opts, deps);
  assert.equal(r.status, "merged");
  assert.equal(r.rounds, 2);
});

test("no test gate + AGREE -> escalated (refuse untested merge)", async () => {
  const deps = makeDeps({ verdicts: [{ decision: "AGREE", reason: "ok", raw: "" }], testCmd: null });
  const r = await runCycle({ ...opts, cfg: { ...opts.cfg, test: "auto" } }, deps);
  assert.equal(r.status, "escalated");
  assert.match(r.reason, /no test gate/i);
});

test("scope cap exceeded -> escalated before review", async () => {
  const deps = makeDeps({ verdicts: [{ decision: "AGREE", reason: "ok", raw: "" }] });
  deps.scope.count = () => 500;
  const r = await runCycle({ ...opts, cfg: { ...opts.cfg, scope: { maxLines: 100, ignore: [] } } }, deps);
  assert.equal(r.status, "escalated");
  assert.match(r.reason, /scope/i);
});

test("noMerge: AGREE + green -> approved, no merge/record/clean (PR bridge)", async () => {
  const deps = makeDeps({ verdicts: [{ decision: "AGREE", reason: "ok", raw: "" }] });
  let merged = false;
  deps.git.mergeIntoMain = () => { merged = true; return { ok: true, reason: "merged" }; };
  const r = await runCycle({ ...opts, mode: "review", noMerge: true }, deps);
  assert.equal(r.status, "approved");
  assert.equal(merged, false);
  assert.equal(deps._calls.recorded, undefined); // no run recorded
  assert.equal(deps._calls.cleaned, undefined); // reviews kept for the PR comment
});

test("review mode never invokes the author (F1)", async () => {
  const deps = makeDeps({ verdicts: [{ decision: "AGREE", reason: "ok", raw: "" }] });
  const r = await runCycle({ ...opts, mode: "review" }, deps);
  assert.equal(r.status, "merged");
  assert.equal(deps._calls.authors, 0); // no author step, no revise
});

test("review mode escalates on first DISAGREE without revising (F1)", async () => {
  const deps = makeDeps({ verdicts: [{ decision: "DISAGREE", reason: "no", raw: "" }] });
  const r = await runCycle({ ...opts, mode: "review" }, deps);
  assert.equal(r.status, "escalated");
  assert.equal(r.rounds, 1);
  assert.equal(deps._calls.authors, 0);
});
