import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as inflight from "../src/inflight.js";
import * as checkpoint from "../src/checkpoint.js";
import * as notify from "../src/notify.js";
import * as dashboard from "../src/dashboard.js";
import { visWidth } from "../src/tui/theme.js";

function freshDir() {
  return join(mkdtempSync(join(tmpdir(), "orch-dashboard-")), ".orch");
}

// Real repo with one branch, so branchExists(repo, ...) has something true
// and false to say — freshDir()'s .orch dirs aren't git repos at all.
function freshRepo() {
  const repo = mkdtempSync(join(tmpdir(), "orch-dashboard-repo-"));
  const g = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8" });
  g("init", "-b", "main");
  g("config", "user.email", "t@t");
  g("config", "user.name", "t");
  g("commit", "--allow-empty", "-m", "init");
  g("branch", "pr/codex/still-here");
  return repo;
}

test("liveCycles is empty with no inflight entries", () => {
  const d = freshDir();
  assert.deepEqual(dashboard.liveCycles(d), []);
});

test("liveCycles reports authoring stage before any checkpoint", () => {
  const d = freshDir();
  inflight.register(d, "sid-1", { branch: "b1", pid: process.pid, baseSha: "abc" });
  const [c] = dashboard.liveCycles(d);
  assert.equal(c.branch, "b1");
  assert.equal(c.stage, "authoring");
  assert.equal(c.round, null);
});

test("liveCycles reflects the latest checkpoint stage", () => {
  const d = freshDir();
  inflight.register(d, "sid-1", { branch: "b1", pid: process.pid, baseSha: "abc" });
  checkpoint.record(d, "sid-1", { branch: "b1", round: 2, stage: "reviewed" });
  const [c] = dashboard.liveCycles(d);
  assert.equal(c.stage, "review");
  assert.equal(c.round, 2);
});

test("liveCycles excludes entries whose owner pid is dead", () => {
  const d = freshDir();
  inflight.register(d, "sid-dead", { branch: "gone", pid: 999999, baseSha: "abc" });
  assert.deepEqual(dashboard.liveCycles(d), []);
});

test("interruptedCycles reports checkpoints without a live owner", () => {
  const d = freshDir();
  checkpoint.record(d, "sid-dead", { branch: "pr/codex/crashed", round: 2, stage: "reviewed" });
  inflight.register(d, "sid-live", { branch: "pr/codex/live", pid: process.pid, baseSha: "abc" });
  checkpoint.record(d, "sid-live", { branch: "pr/codex/live", round: 1, stage: "tested" });

  const interrupted = dashboard.interruptedCycles(d);
  assert.equal(interrupted.length, 1);
  assert.equal(interrupted[0].sid, "sid-dead");
  assert.equal(interrupted[0].branch, "pr/codex/crashed");
  assert.equal(interrupted[0].stage, "review");
  assert.equal(interrupted[0].round, 2);
});

test("interruptedCycles keeps every ownerless checkpoint when no repo is given", () => {
  const d = freshDir();
  checkpoint.record(d, "sid-dead", { branch: "gone-branch", round: 1, stage: "reviewed" });
  const interrupted = dashboard.interruptedCycles(d);
  assert.equal(interrupted.length, 1);
});

test("interruptedCycles drops checkpoints whose branch is missing from the repo", () => {
  const d = freshDir();
  const repo = freshRepo();
  checkpoint.record(d, "sid-merged", { branch: "already-merged-and-gone", round: 2, stage: "reviewed" });
  checkpoint.record(d, "sid-crashed", { branch: "pr/codex/still-here", round: 1, stage: "tested" });

  const interrupted = dashboard.interruptedCycles(d, dashboard.liveCycles(d), repo);
  assert.equal(interrupted.length, 1);
  assert.equal(interrupted[0].sid, "sid-crashed");
});

test("runHistory reads runs.jsonl, newest first, capped at limit", () => {
  const d = freshDir();
  notify.recordRun(d, { ts: "1", branch: "b1", sid: "sid-1", verdict: "merged", rounds: 1 });
  notify.recordRun(d, { ts: "2", branch: "b2", sid: "sid-2", verdict: "pr-fallback", rounds: 2 });
  notify.recordRun(d, { ts: "3", branch: "b3", sid: "sid-3", verdict: "merged", rounds: 1 });
  const h = dashboard.runHistory(d, 2);
  assert.equal(h.length, 2);
  assert.equal(h[0].ts, "3");
  assert.equal(h[0].sid, "sid-3");
  assert.equal(h[1].ts, "2");
  assert.equal(h[1].sid, "sid-2");
});

test("runHistory can mark stale red verdicts resolved when their branch is gone", () => {
  const d = freshDir();
  const repo = freshRepo();
  notify.recordRun(d, { ts: "1", branch: "already-merged-and-gone", sid: "sid-1", verdict: "escalated", rounds: 3 });
  notify.recordRun(d, { ts: "2", branch: "pr/codex/still-here", sid: "sid-2", verdict: "pr-fallback", rounds: 2 });
  notify.recordRun(d, { ts: "3", branch: "done-and-gone", sid: "sid-3", verdict: "merged", rounds: 1 });

  const unchecked = dashboard.runHistory(d, 3, { repo });
  assert.equal(unchecked[2].resolved, undefined);

  const checked = dashboard.runHistory(d, 3, { repo, checkHistory: true });
  assert.equal(checked[0].resolved, undefined);
  assert.equal(checked[1].resolved, undefined);
  assert.equal(checked[2].resolved, true);
});

test("metrics computes success rate and usage totals", () => {
  const d = freshDir();
  notify.recordRun(d, { ts: "1", branch: "b1", verdict: "merged", rounds: 1, tokens: 100, costUsd: 0.01 });
  notify.recordRun(d, { ts: "2", branch: "b2", verdict: "pr-fallback", rounds: 2, tokens: 50 });
  const m = dashboard.metrics(d);
  assert.equal(m.total, 2);
  assert.equal(m.merged, 1);
  assert.equal(m.successRate, 0.5);
  assert.equal(m.totalTokens, 150);
  assert.equal(m.totalCostUsd, 0.01);
  assert.equal(m.cleanUnattendedCycles, 0);
});

test("metrics on an empty history reports nulls, not NaN", () => {
  const d = freshDir();
  const m = dashboard.metrics(d);
  assert.equal(m.total, 0);
  assert.equal(m.successRate, null);
  assert.equal(m.totalCostUsd, null);
  assert.equal(m.cleanUnattendedCycles, 0);
});

test("latestLog returns the tail of the highest-numbered round file", () => {
  const d = freshDir();
  notify.writeRound(d, "b1", 1, "round one content\n");
  notify.writeRound(d, "b1", 2, "round two content\nlast line\n");
  const log = dashboard.latestLog(d, "b1");
  assert.equal(log.file, "round-2.md");
  assert.match(log.tail, /last line/);
});

test("latestLog returns null when a branch has no reviews yet", () => {
  const d = freshDir();
  assert.equal(dashboard.latestLog(d, "no-such-branch"), null);
});

test("render produces a readable text summary with live cycles, history, and metrics", () => {
  const d = freshDir();
  inflight.register(d, "sid-1", { branch: "b1", pid: process.pid, baseSha: "abc" });
  checkpoint.record(d, "sid-1", { branch: "b1", round: 1, stage: "tested" });
  notify.recordRun(d, { ts: "1", branch: "b0", verdict: "merged", rounds: 1, tokens: 10 });
  const text = dashboard.render(d);
  assert.match(text, /Live cycles \(1\)/);
  assert.match(text, /b1/);
  assert.match(text, /\[test round 1\]/);
  assert.match(text, /sid=sid-1/);
  assert.match(text, /Interrupted cycles \(0\)/);
  assert.match(text, /Run history/);
  assert.match(text, /Metrics/);
  assert.match(text, /success rate: 100%/);
  assert.match(text, /clean unattended cycles: 1/);
});

test("render clamps history table lines to opts.columns", () => {
  const d = freshDir();
  notify.recordRun(d, {
    ts: "2026-07-10T00:00:00Z",
    branch: "pr/claude/extremely-long-branch-name-overflowing-narrow-terminals",
    verdict: "merged", rounds: 1, tokens: 10,
  });
  const text = dashboard.render(d, { columns: 60 });
  const lines = text.split("\n");
  const start = lines.indexOf("Run history (last 1)");
  const tableLines = lines.slice(start + 1, start + 3);
  assert.match(tableLines[1], /…$/);
  for (const l of tableLines) assert.ok(visWidth(l) <= 60, `line too wide: ${JSON.stringify(l)}`);
  // without columns the full branch name still renders untruncated
  assert.match(dashboard.render(d), /extremely-long-branch-name-overflowing-narrow-terminals/);
});

test("render colorizes verdict words when opts.color is true", () => {
  const d = freshDir();
  notify.recordRun(d, { ts: "1", branch: "b0", verdict: "merged", rounds: 1, tokens: 10 });
  const text = dashboard.render(d, { color: true });
  assert.match(text, /\x1b\[38;5;71mmerged\x1b\[0m/);
});

test("render adds status for resolved stale red history rows only when requested", () => {
  const d = freshDir();
  const repo = freshRepo();
  notify.recordRun(d, { ts: "1", branch: "already-merged-and-gone", verdict: "escalated", rounds: 3 });

  assert.doesNotMatch(dashboard.render(d, { repo }), /STATUS|resolved/);
  const text = dashboard.render(d, { repo, checkHistory: true });
  assert.match(text, /STATUS/);
  assert.match(text, /resolved/);
});

test("render handles a fully empty .orch/ without throwing", () => {
  const d = freshDir();
  const text = dashboard.render(d);
  assert.match(text, /Live cycles \(0\)/);
  assert.match(text, /Interrupted cycles \(0\)/);
  assert.match(text, /\(none\)/);
});

test("render surfaces checkpoint-only interrupted cycles", () => {
  const d = freshDir();
  checkpoint.record(d, "sid-crash", { branch: "pr/codex/crashed", round: 1, stage: "reviewed" });
  const text = dashboard.render(d);
  assert.match(text, /Interrupted cycles \(1\)/);
  assert.match(text, /pr\/codex\/crashed/);
  assert.match(text, /\[review round 1\]/);
  assert.match(text, /sid=sid-crash/);
});

test("snapshot includes sid for live, interrupted, and history entries", () => {
  const d = freshDir();
  inflight.register(d, "sid-live", { branch: "pr/codex/live", pid: process.pid, baseSha: "abc" });
  checkpoint.record(d, "sid-live", { branch: "pr/codex/live", round: 1, stage: "tested" });
  checkpoint.record(d, "sid-dead", { branch: "pr/codex/crashed", round: 2, stage: "reviewed" });
  notify.recordRun(d, { ts: "1", branch: "pr/codex/done", sid: "sid-hist", verdict: "merged", rounds: 1 });

  const snap = dashboard.snapshot(d);
  assert.equal(snap.live[0].sid, "sid-live");
  assert.equal(snap.interrupted[0].sid, "sid-dead");
  assert.equal(snap.history[0].sid, "sid-hist");
});
