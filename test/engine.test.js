import { test } from "node:test";
import assert from "node:assert/strict";
import { runCycle } from "../src/engine.js";

function makeDeps({ verdicts, reviewerVerdicts = null, authorUsage = null, gatePass = true, mergeOk = true, testCmd = "echo", changed = ["src/a.js"] }) {
  const calls = { authors: 0, audits: 0, revises: 0, auditsBy: {}, prompts: [], rounds: [], rawRounds: [], reviewLog: [] };
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
    async author(prompt) { calls.authors++; calls.prompts.push(prompt); return authorUsage; },
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
      phase() {}, writeRound(_orchDir, _branch, round, content) { calls.rounds.push({ round, content }); return "p"; },
      writeRoundRaw(_orchDir, _branch, round, content) { calls.rawRounds.push({ round, content }); return "rp"; },
      buildDecisionBrief: () => "brief", escalate() { return "d"; },
      recordRun(_dir, entry) { calls.recorded = entry; },
      cleanupReviews(_dir, branch) { calls.cleaned = branch; },
    },
    reviewLog: { record(_orchDir, entries) { calls.reviewLog.push(...entries); } },
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

test("merged result carries author and reviewer run statistics", async () => {
  const deps = makeDeps({
    authorUsage: { usage: { model: "claude-opus-4.8", tokens: 1200 } },
    verdicts: [{ decision: "AGREE", reason: "ok", raw: "", usage: { model: "gpt-5.1", tokens: 800, costUsd: 0.04 } }],
  });
  const r = await runCycle({
    ...opts,
    author: { agent: "auth", model: "claude-opus-4.8" },
    reviewers: [{ agent: "rev", model: "gpt-5.1" }],
  }, deps);
  assert.equal(r.status, "merged");
  assert.deepEqual(r.runStats, [
    { role: "author", agent: "auth", model: "claude-opus-4.8", tokens: 1200 },
    { role: "reviewer", agent: "rev", model: "gpt-5.1", tokens: 800, costUsd: 0.04 },
  ]);
  assert.deepEqual(r.usage, { tokens: 2000, costUsd: 0.04 });
  assert.equal(r.usageSummary, "2,000 tokens, ~$0.04");
  assert.match(deps._calls.rounds[0].content, /Verdict: AGREE\n\nCost: 2,000 tokens, ~\$0\.04/);
});

test("review rounds persist raw reviewer output alongside parsed verdicts", async () => {
  const deps = makeDeps({
    verdicts: [{ decision: "DISAGREE", reason: "unparseable verdict", raw: "soft error on stderr" }],
  });
  await runCycle({ ...opts, cfg: { ...opts.cfg, reviseCap: 1 } }, deps);
  assert.equal(deps._calls.rawRounds.length, 1);
  assert.equal(deps._calls.rawRounds[0].round, 1);
  assert.match(deps._calls.rawRounds[0].content, /## rev/);
  assert.match(deps._calls.rawRounds[0].content, /soft error on stderr/);
});

test("review outcomes are logged with terminal status and defect flag", async () => {
  const deps = makeDeps({
    reviewerVerdicts: {
      rev: [{ decision: "AGREE", reason: "ok", raw: "" }],
      rev2: [{ decision: "DISAGREE", reason: "bug", raw: "" }],
    },
  });
  const r = await runCycle({ ...opts, reviewerNames: ["rev", "rev2"], cfg: { ...opts.cfg, reviseCap: 1 } }, deps);
  assert.equal(r.status, "escalated");
  assert.deepEqual(deps._calls.reviewLog.map((entry) => ({
    branch: entry.branch,
    round: entry.round,
    reviewer: entry.reviewer,
    decision: entry.decision,
    terminalStatus: entry.terminalStatus,
    terminalRounds: entry.terminalRounds,
    defectLaterSurfaced: entry.defectLaterSurfaced,
  })), [
    {
      branch: opts.branch,
      round: 1,
      reviewer: "rev",
      decision: "AGREE",
      terminalStatus: "escalated",
      terminalRounds: 1,
      defectLaterSurfaced: true,
    },
    {
      branch: opts.branch,
      round: 1,
      reviewer: "rev2",
      decision: "DISAGREE",
      terminalStatus: "escalated",
      terminalRounds: 1,
      defectLaterSurfaced: true,
    },
  ]);
  assert.match(deps._calls.reviewLog[0].ts, /^\d{4}-\d{2}-\d{2}T/);
});

test("merged result omits run statistics when adapters report no measured tokens", async () => {
  const deps = makeDeps({
    authorUsage: { usage: { model: "claude-opus-4.8", tokens: 0 } },
    verdicts: [{ decision: "AGREE", reason: "ok", raw: "", usage: { model: "gpt-5.1", tokens: 0 } }],
  });
  const r = await runCycle({
    ...opts,
    author: { agent: "auth", model: "claude-opus-4.8" },
    reviewers: [{ agent: "rev", model: "gpt-5.1" }],
  }, deps);
  assert.equal(r.status, "merged");
  assert.deepEqual(r.runStats, []);
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

test("docsOnly is read BEFORE finalize (ff merge empties main...branch)", async () => {
  // Regression: a ff merge makes `main...branch` empty, so reading changedFiles
  // after finalize always yields [] -> docsOnly=false -> broken loop guard.
  // Assert ordering: changedFiles must be called before finalize runs.
  const deps = makeDeps({ verdicts: [{ decision: "AGREE", reason: "ok", raw: "" }], changed: ["README.md"] });
  let changedFilesCalled = false;
  let changedFilesCalledWhenFinalizeRan = false;
  deps.git.changedFiles = () => { changedFilesCalled = true; return ["README.md"]; };
  deps.finalize = async () => {
    changedFilesCalledWhenFinalizeRan = changedFilesCalled;
    return { status: "merged", reason: "merged", sha: "x" };
  };
  const r = await runCycle(opts, deps);
  assert.equal(r.status, "merged");
  assert.equal(r.docsOnly, true, "changedFiles result must drive docsOnly");
  assert.equal(changedFilesCalledWhenFinalizeRan, true, "changedFiles must run before finalize");
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
  assert.equal(deps._calls.recorded.verdict, "escalated");
  assert.equal(deps._calls.recorded.branch, opts.branch);
  assert.equal(deps._calls.recorded.rounds, 1);
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

test("agentError reviewer escalates on round 1 instead of revising (#33)", async () => {
  // A crashed reviewer is not a code defect: escalate immediately, don't burn
  // the revise loop. The reason carries the reviewer + its (#31) stderr tail.
  const deps = makeDeps({ verdicts: [{ decision: "DISAGREE", reason: "agent exited nonzero: bad model", raw: "", agentError: true }] });
  const r = await runCycle(opts, deps);
  assert.equal(r.status, "escalated");
  assert.equal(r.rounds, 1);
  assert.match(r.reason, /agent error: rev agent exited nonzero: bad model/);
  assert.equal(deps._calls.authors, 1, "only the initial author runs — no revise on a reviewer crash");
  assert.equal(deps._calls.audits, 1);
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

test("noMerge: AGREE + green -> approved, recorded, no merge/clean (PR bridge)", async () => {
  const deps = makeDeps({ verdicts: [{ decision: "AGREE", reason: "ok", raw: "" }] });
  let merged = false;
  deps.git.mergeIntoMain = () => { merged = true; return { ok: true, reason: "merged" }; };
  const r = await runCycle({ ...opts, mode: "review", noMerge: true }, deps);
  assert.equal(r.status, "approved");
  assert.equal(merged, false);
  assert.equal(deps._calls.recorded.verdict, "approved");
  assert.equal(deps._calls.recorded.branch, opts.branch);
  assert.equal(deps._calls.recorded.rounds, 1);
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
  let finalizeCtx;
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
    finalize: async (ctx) => { finalizeCtx = ctx; return { status: "merged", reason: "merged", sha: "abc" }; },
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
  assert.equal(finalizeCtx.task, "do x");
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

test("resume:true attaches the existing branch and skips the initial author (issue #24)", async () => {
  const deps = makeDeps({ verdicts: [{ decision: "AGREE", reason: "ok", raw: "" }] });
  const calls = { create: 0, attach: 0 };
  deps.git.createTaskBranch = () => { calls.create++; };
  deps.git.attachExistingBranch = () => { calls.attach++; };
  const r = await runCycle({ ...opts, resume: true }, deps);
  assert.equal(r.status, "merged");
  assert.equal(calls.attach, 1, "resume must attach the existing branch");
  assert.equal(calls.create, 0, "resume must not create a fresh branch");
  assert.equal(deps._calls.authors, 0, "resume must skip the initial author step (work already committed)");
  assert.equal(deps._calls.audits, 1, "resume proceeds straight to audit");
});

test("resume:true still runs the scope gate on the resumed work", async () => {
  const deps = makeDeps({ verdicts: [{ decision: "AGREE", reason: "ok", raw: "" }] });
  deps.git.attachExistingBranch = () => {};
  deps.scope.count = () => 999; // over cap
  const r = await runCycle(
    { ...opts, resume: true, cfg: { ...opts.cfg, scope: { maxLines: 10, ignore: [] } } },
    deps,
  );
  assert.equal(r.status, "escalated");
  assert.match(r.reason, /scope/);
});

test("§3c: a protected-path diff is blocked at the merge boundary", async () => {
  const deps = makeDeps({ verdicts: [{ decision: "AGREE", reason: "ok", raw: "" }], changed: ["src/gate.js"] });
  const r = await runCycle(opts, deps);
  assert.equal(r.status, "escalated");
  assert.match(r.reason, /protected path/i);
  assert.match(r.reason, /src\/gate\.js/);
  assert.notEqual(deps._calls.finalized, true, "must escalate before finalize merges");
});

test("§3c: a CLEAN round 1 then a protected-path REVISE is still blocked", async () => {
  // The hole the merge-boundary gate closes: an early/first-pass gate would let a
  // dirty revise through. Gating the FINAL diff catches the revise.
  const deps = makeDeps({
    verdicts: [{ decision: "DISAGREE", reason: "nope", raw: "" }, { decision: "AGREE", reason: "ok", raw: "" }],
    changed: ["src/verdict.js"],
  });
  const r = await runCycle(opts, deps);
  assert.equal(r.status, "escalated");
  assert.match(r.reason, /protected path/i);
  assert.equal(deps._calls.authors, 2, "initial author + one revise both ran");
  assert.equal(deps._calls.audits, 2, "gate fires only after the revise round's AGREE");
});

test("§3c: protected-path gate also catches a resumed dangerous diff", async () => {
  const deps = makeDeps({ verdicts: [{ decision: "AGREE", reason: "ok", raw: "" }], changed: ["src/intake/allowlist.js"] });
  deps.git.attachExistingBranch = () => {};
  const r = await runCycle({ ...opts, resume: true }, deps);
  assert.equal(r.status, "escalated");
  assert.match(r.reason, /protected path/i);
  assert.equal(deps._calls.authors, 0, "resume skips authoring; gate still fires on the resumed diff");
});

test("§3c: an `orch review` merge of a protected path is blocked too (any author)", async () => {
  // Intended widening: the gate sits at the merge boundary, so guardrail files
  // never auto-land regardless of who wrote the branch — CODEOWNERS-equivalent.
  const deps = makeDeps({ verdicts: [{ decision: "AGREE", reason: "ok", raw: "" }], changed: ["package.json"] });
  deps.git.attachExistingBranch = () => {};
  const r = await runCycle({ ...opts, mode: "review" }, deps);
  assert.equal(r.status, "escalated");
  assert.match(r.reason, /protected path/i);
  assert.notEqual(deps._calls.finalized, true, "review must not merge a guardrail-file branch");
});

test("§3b: initial author receives opts.authorPrompt verbatim (fenced work order)", async () => {
  const deps = makeDeps({ verdicts: [{ decision: "AGREE", reason: "ok", raw: "" }] });
  const fenced = "BEGIN UNTRUSTED REFERENCE\nproblem: x\nEND UNTRUSTED REFERENCE";
  const r = await runCycle({ ...opts, authorPrompt: fenced }, deps);
  assert.equal(r.status, "merged");
  assert.equal(deps._calls.prompts[0], fenced, "the fenced prompt drives the author, not the bare task");
});

test("crash recovery: a 'tested' checkpoint skips both audit and gate on resume", async () => {
  // Simulates a crash after AGREE + green tests but before merge: the resumed
  // cycle must land the merge without re-auditing or re-running the test gate.
  const deps = makeDeps({ verdicts: [{ decision: "AGREE", reason: "ok", raw: "" }] });
  deps.git.attachExistingBranch = () => {};
  let gateRuns = 0;
  deps.gate.run = () => { gateRuns++; return { pass: true, log: "" }; };
  const stored = { branch: opts.branch, round: 1, stage: "tested", reason: "ok" };
  deps.checkpoint = { lookup: () => stored, record() {}, clear() {} };
  const r = await runCycle({ ...opts, resume: true, sid: "s1" }, deps);
  assert.equal(r.status, "merged");
  assert.equal(deps._calls.audits, 0, "resume from a tested checkpoint must not re-audit");
  assert.equal(gateRuns, 0, "resume from a tested checkpoint must not re-run the test gate");
});

test("crash recovery: a 'reviewed' DISAGREE checkpoint skips that round's audit and revises directly", async () => {
  const deps = makeDeps({
    verdicts: [{ decision: "AGREE", reason: "ok", raw: "" }], // only used for round 2's fresh audit
  });
  deps.git.attachExistingBranch = () => {};
  const stored = { branch: opts.branch, round: 1, stage: "reviewed", decision: "DISAGREE", reason: "needs work" };
  deps.checkpoint = { lookup: () => stored, record() {}, clear() {} };
  const r = await runCycle({ ...opts, resume: true, sid: "s1" }, deps);
  assert.equal(r.status, "merged");
  assert.equal(r.rounds, 2);
  assert.equal(deps._calls.audits, 1, "round 1's audit is skipped; only round 2 audits fresh");
  assert.equal(deps._calls.authors, 1, "resume skips initial authoring; only the checkpoint-driven revise call runs");
  assert.match(deps._calls.prompts[0], /needs work/, "revise prompt uses the checkpointed reason");
});

test("checkpoint.record is called with the round's verdict after each fresh audit", async () => {
  const recorded = [];
  const deps = makeDeps({ verdicts: [{ decision: "AGREE", reason: "ok", raw: "" }] });
  deps.checkpoint = { lookup: () => null, record: (_dir, sid, data) => recorded.push({ sid, ...data }), clear() {} };
  const r = await runCycle({ ...opts, sid: "s1" }, deps);
  assert.equal(r.status, "merged");
  assert.equal(recorded.length, 2, "one 'reviewed' checkpoint + one 'tested' checkpoint");
  assert.equal(recorded[0].stage, "reviewed");
  assert.equal(recorded[0].decision, "AGREE");
  assert.equal(recorded[1].stage, "tested");
});

test("engine threads cfg.stageTimeout (minutes) into author and reviewer opts as ms (#56)", async () => {
  let authorOpts = null;
  let reviewerOpts = null;
  const author = {
    name: "auth",
    async author(_p, _wd, o) { authorOpts = o; return null; },
    async audit() { return { decision: "AGREE", reason: "" }; },
  };
  const reviewer = {
    name: "rev",
    async audit(_b, _wd, o) { reviewerOpts = o; return { decision: "AGREE", reason: "ok", raw: "" }; },
  };
  const deps = {
    adapters: { get: (n) => (n === "auth" ? author : reviewer) },
    git: {
      createTaskBranch() {}, attachExistingBranch() {}, pruneWorktree() {},
      changedFiles() { return ["src/a.js"]; }, git() { return "d"; },
    },
    gate: { detect: () => "echo", run: () => ({ pass: true, log: "" }) },
    scope: { count: () => 0 },
    notify: { phase() {}, writeRound() { return "p"; }, buildDecisionBrief: () => "b", escalate() { return "d"; } },
    inflight: { setPaths() {} },
    finalize: async () => ({ status: "merged", reason: "merged", sha: "x" }),
  };
  await runCycle({ ...opts, cfg: { ...opts.cfg, stageTimeout: 30 } }, deps);
  assert.equal(authorOpts.stageTimeoutMs, 30 * 60_000, "author stage gets the configured timeout in ms");
  assert.equal(reviewerOpts.stageTimeoutMs, 30 * 60_000, "reviewer stage gets the configured timeout in ms");
});
