import { test } from "node:test";
import assert from "node:assert/strict";
import { runCycle } from "../src/engine.js";

function makeDeps({ verdicts, reviewerVerdicts = null, gatePass = true, mergeOk = true, testCmd = "echo", changed = ["src/a.js"] }) {
  const calls = { authors: 0, audits: 0, revises: 0, auditsBy: {}, prompts: [] };
  const reviewerCache = new Map();
  const reviewerFor = (name) => {
    if (!reviewerCache.has(name)) {
      reviewerCache.set(name, {
        name,
        async audit() {
          calls.audits++;
          calls.auditsBy[name] = (calls.auditsBy[name] || 0) + 1;
          const list = reviewerVerdicts?.[name] || verdicts;
          const verdict = list[Math.min(calls.auditsBy[name] - 1, list.length - 1)];
          return typeof verdict === "function" ? verdict() : verdict;
        },
      });
    }
    return reviewerCache.get(name);
  };
  const author = {
    name: "auth",
    async author(prompt) { calls.authors++; calls.prompts.push(prompt); },
    async audit() { return { decision: "AGREE", reason: "", raw: "" }; },
  };
  // revise reuses author.author via engine; count via wrapper
  const adapters = { get: (n) => (n === "auth" ? author : reviewerFor(n)) };
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
    inflight: { setPaths() {} },
    finalize: async () => { calls.finalized = true; return { status: "merged", reason: "merged", sha: "x" }; },
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

test("merged result stamps noop=true for an empty diff (loop-guard for no-op merges)", async () => {
  // A no-op merge yields changedFiles=[] -> isDocsOnly returns false. Without the
  // noop flag the guard would re-spawn a docs-update forever on an empty diff.
  const deps = makeDeps({ verdicts: [{ decision: "AGREE", reason: "ok", raw: "" }], changed: [] });
  const r = await runCycle(opts, deps);
  assert.equal(r.status, "merged");
  assert.equal(r.noop, true);
  assert.equal(r.docsOnly, false);
});

test("AGREE + red gate -> escalated, no merge", async () => {
  const deps = makeDeps({ verdicts: [{ decision: "AGREE", reason: "ok", raw: "" }], gatePass: false });
  const r = await runCycle(opts, deps);
  assert.equal(r.status, "escalated");
  assert.match(r.reason, /tests/i);
});

test("merge wipes reviews + records the run; escalation keeps them", async () => {
  const merged = makeDeps({ verdicts: [{ decision: "AGREE", reason: "ok", raw: "" }] });
  const r1 = await runCycle(opts, merged);
  assert.equal(r1.status, "merged");
  assert.equal(merged._calls.finalized, true); // finalize now owns recording + cleanup

  const stalled = makeDeps({ verdicts: [{ decision: "DISAGREE", reason: "no", raw: "" }] });
  const r2 = await runCycle(opts, stalled);
  assert.equal(r2.status, "escalated");
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

test("all parallel reviewers must agree before merge", async () => {
  let rev2Started = false;
  const deps = makeDeps({
    verdicts: [{ decision: "AGREE", reason: "ok", raw: "" }],
    reviewerVerdicts: {
      rev: [async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(rev2Started, true);
        return { decision: "AGREE", reason: "ok", raw: "" };
      }],
      rev2: [async () => {
        rev2Started = true;
        return { decision: "AGREE", reason: "also ok", raw: "" };
      }],
    },
  });
  const r = await runCycle({ ...opts, reviewerNames: ["rev", "rev2"] }, deps);
  assert.equal(r.status, "merged");
  assert.equal(deps._calls.auditsBy.rev, 1);
  assert.equal(deps._calls.auditsBy.rev2, 1);
});

test("one parallel reviewer disagreement drives a combined revision", async () => {
  const deps = makeDeps({
    verdicts: [{ decision: "AGREE", reason: "ok", raw: "" }],
    reviewerVerdicts: {
      rev: [
        { decision: "AGREE", reason: "ok", raw: "" },
        { decision: "AGREE", reason: "ok", raw: "" },
      ],
      rev2: [
        { decision: "DISAGREE", reason: "needs fix", raw: "" },
        { decision: "AGREE", reason: "fixed", raw: "" },
      ],
    },
  });
  const r = await runCycle({ ...opts, reviewerNames: ["rev", "rev2"] }, deps);
  assert.equal(r.status, "merged");
  assert.equal(r.rounds, 2);
  assert.match(deps._calls.prompts[1], /rev2/);
  assert.match(deps._calls.prompts[1], /needs fix/);
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

test("AGREE + green → finalize lands the merge (status merged)", async () => {
  const calls = [];
  const deps = {
    adapters: { get: () => ({ name: "claude", async author() {}, async audit() { return { decision: "AGREE", reason: "ok" }; } }) },
    git: {
      createTaskBranch() {}, attachExistingBranch() {}, pruneWorktree() {},
      changedFiles: () => ["src/a.js"],
      git: (args) => (args[0] === "rev-parse" ? "base" : ""),
    },
    gate: { detect: () => "npm test", run: () => ({ pass: true }) },
    scope: { count: () => 0 },
    inflight: { setPaths: (...a) => calls.push(["setPaths", ...a]) },
    finalize: async () => ({ status: "merged", reason: "merged", sha: "abc" }),
    notify: {
      phase() {}, writeRound() { return "p"; },
      buildDecisionBrief: () => "brief", escalate() {},
      recordRun() {}, cleanupReviews() {},
    },
  };
  const res = await runCycle({
    mode: "task", task: "do x", branch: "pr/claude/x-1", sid: "1",
    authorName: "claude", reviewerName: "claude",
    cfg: { reviseCap: 3, merge: "ff-only", test: "auto", scope: { maxLines: 0, ignore: [] }, docs: { paths: ["*.md", "docs/**", "**/*.md"] } },
    orchDir: "/o", repo: "/r", worktree: "/o/wt/x",
  }, deps);
  assert.equal(res.status, "merged");
  assert.ok(calls.some((c) => c[0] === "setPaths"));
});

test("AGREE + green but finalize demotes → status pr-fallback", async () => {
  const deps = {
    adapters: { get: () => ({ name: "claude", async author() {}, async audit() { return { decision: "AGREE", reason: "ok" }; } }) },
    git: {
      createTaskBranch() {}, attachExistingBranch() {}, pruneWorktree() {},
      changedFiles: () => ["src/a.js"],
      git: (args) => (args[0] === "rev-parse" ? "base" : ""),
    },
    gate: { detect: () => "npm test", run: () => ({ pass: true }) },
    scope: { count: () => 0 },
    inflight: { setPaths() {} },
    finalize: async () => ({ status: "pr-fallback", reason: "overlap → PR https://x/1", prUrl: "https://x/1" }),
    notify: {
      phase() {}, writeRound() { return "p"; },
      buildDecisionBrief: () => "brief", escalate() {},
      recordRun() {}, cleanupReviews() {},
    },
  };
  const res = await runCycle({
    mode: "task", task: "do x", branch: "pr/claude/x-1", sid: "1",
    authorName: "claude", reviewerName: "claude",
    cfg: { reviseCap: 3, merge: "ff-only", test: "auto", scope: { maxLines: 0, ignore: [] }, docs: { paths: ["*.md", "docs/**", "**/*.md"] } },
    orchDir: "/o", repo: "/r", worktree: "/o/wt/x",
  }, deps);
  assert.equal(res.status, "pr-fallback");
});
