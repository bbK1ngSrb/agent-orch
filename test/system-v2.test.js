// System tests for the v2 loop (design docs/cli-v2-design.md §17, "System"):
// a real temp git repo with a bare origin, a scripted fake `gh`, and `main()`
// driven end to end. Unlike the unit suites these assert what a RUN leaves
// behind — the durable run record — because that record is what `orch
// continue`, the dashboard and scripts/v2-metrics.mjs all read afterwards.
//
// The last block audits that record store with the metrics script itself
// (proposal §7), which is the only way to check the programme's headline
// number end to end: a clean unattended run is not a log line, it is a shape
// on disk.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { chdir, cwd } from "node:process";
import { fileURLToPath } from "node:url";
import { main, realDeps } from "../src/cli.js";
import * as gitDep from "../src/git.js";
import { initGitRepo, addOriginWithPeer, fakeCycleDeps } from "./helpers/system-repo.js";
import { audit } from "../scripts/v2-metrics.mjs";

const FIXTURES = fileURLToPath(new URL("./fixtures/v2-metrics", import.meta.url));

function runRecords(repo) {
  const dir = join(repo, ".orch", "run-records");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
}

async function runMain(repo, argv, deps = {}) {
  const prev = cwd();
  const logs = [];
  const origLog = console.log;
  const savedExitCode = process.exitCode;
  chdir(repo);
  console.log = (...args) => logs.push(args.map(String).join(" "));
  try {
    const result = await main(argv, { preflight() {}, cycleDeps: fakeCycleDeps(), maybeNotifyUpdate: async () => {}, sleep: async () => {}, ...deps });
    return { logs, result };
  } finally {
    console.log = origLog;
    chdir(prev);
    process.exitCode = savedExitCode;
  }
}

// The standing integration→base PR, green: mergeable, no required checks, no
// review blocking. `pr list` is how orch finds the PR for a landed branch
// (design §5.4 — query the remote, never trust a cached number).
function greenGh(head, { state = "OPEN", extra = {}, onCall = () => {} } = {}) {
  return (args) => {
    onCall(args);
    if (args[0] === "--version") return "gh 2";
    if (args[0] === "auth" && args[1] === "status") return "Logged in";
    if (args[0] === "pr" && args[1] === "list") {
      return JSON.stringify([{ number: 9, url: "https://github.com/o/r/pull/9", isDraft: false, headRefOid: head }]);
    }
    if (args[0] === "pr" && args[1] === "view") {
      return JSON.stringify({
        number: 9, state, isDraft: false, headRefOid: head, baseRefName: "main",
        mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: null,
        statusCheckRollup: [], ...extra,
      });
    }
    if (args[0] === "api") return "[]"; // required checks: known, and empty
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
}

// fakeCycleDeps() stubs `notify` and `finalize` wholesale, so a run through it
// writes no runs.jsonl line at all. Keep the stubs, but let the finalize stand-in
// record its merged line through the REAL (telemetry-stamping) writer, which is
// what design §16 changed.
function recordingCycleDeps(real) {
  const fake = fakeCycleDeps();
  return {
    ...fake,
    notify: { ...fake.notify, recordRun: real.notify.recordRun },
    finalize: async (ctx) => {
      real.notify.recordRun(ctx.orchDir, {
        ts: new Date().toISOString(), branch: ctx.branch, sid: ctx.sid,
        verdict: "merged", sha: "abc", rounds: ctx.rounds,
      });
      return { status: "merged", reason: "test", sha: "abc" };
    },
  };
}

test("system: `--until ready` reaches the goal and records the observation that earned it", async () => {
  const repo = initGitRepo("orch-sysv2-ready-");
  gitDep.git(["branch", "orch/integration"], repo);
  addOriginWithPeer(repo);
  const head = gitDep.git(["rev-parse", "orch/integration"], repo);
  const gh = greenGh(head);

  const { logs } = await runMain(repo, ["task", "ready happy path", "--no-tidy", "--until", "ready", "--json"], {
    githubDeps: () => ({ gh, git: gitDep.git }),
    cycleDeps: null,
    // Real deps except the agents and the gate: this run must go through the
    // genuine telemetry-stamping notify wrapper, or the runs.jsonl assertions
    // below would only be testing the fake.
    realDeps: (options) => recordingCycleDeps(realDeps(options)),
  });

  const end = JSON.parse(logs[logs.length - 1]);
  assert.equal(end.event, "run.end");
  assert.equal(end.outcome, "reached");
  assert.equal(end.exit, 0);

  const [record] = runRecords(repo);
  assert.equal(record.outcome, "reached");
  assert.equal(record.exit, 0);
  assert.equal(record.policy.until, "ready");
  // design §16: exit 0 is only trustworthy with the remote read that produced it.
  assert.deepEqual(record.readiness, { ready: true, mergeStateStatus: "CLEAN", checks: "green" });
  // Nobody was asked anything — this is what "clean unattended" means.
  assert.equal(record.human, null);

  // And every cycle line carries the run it belongs to (design §16 telemetry).
  const lines = readFileSync(join(repo, ".orch", "runs.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(lines.length >= 1);
  for (const line of lines) {
    assert.equal(line.runId, record.runId);
    assert.equal(line.until, "ready");
  }
});

test("system: a run with no remote to read is green but marked as ungated", async () => {
  const repo = initGitRepo("orch-sysv2-local-");
  gitDep.git(["branch", "orch/integration"], repo);

  await runMain(repo, ["task", "local only", "--no-tidy", "--until", "ready"], {
    githubDeps: () => ({ gh: () => { throw new Error("gh must not be called without an origin"); }, git: gitDep.git }),
  });

  const [record] = runRecords(repo);
  assert.equal(record.exit, 0);
  // The distinction the metrics audit depends on: "there was nothing to
  // observe" is not the same defect as "we never looked".
  assert.equal(record.readiness.remoteGate, false);
  assert.equal(audit(join(repo, ".orch")).falseReady.length, 0);
  assert.equal(audit(join(repo, ".orch")).localReady, 1);
});

test("system: an externally merged standing PR is verified against the base, not assumed", async () => {
  const repo = initGitRepo("orch-sysv2-merged-");
  gitDep.git(["branch", "orch/integration"], repo);
  addOriginWithPeer(repo);
  // The standing branch must exist on the remote: the ancestry proof is read
  // from `origin/main` after fetching it, not from the local ref.
  gitDep.git(["push", "-u", "origin", "orch/integration"], repo);
  const head = gitDep.git(["rev-parse", "orch/integration"], repo);
  // The PR reads as MERGED and its commit IS reachable from origin/main (they
  // are the same commit here), so the ancestry proof holds and the run is done.
  const gh = greenGh(head, { state: "MERGED", extra: { mergeCommit: { oid: head } } });

  const { logs } = await runMain(repo, ["task", "merged happy path", "--no-tidy", "--until", "merged", "--json"], {
    githubDeps: () => ({ gh, git: gitDep.git }),
  });

  const end = JSON.parse(logs[logs.length - 1]);
  assert.equal(end.outcome, "reached");
  assert.equal(end.exit, 0);
  // The green exit is earned by an explicit ancestry check, not by trusting
  // GitHub's "merged" flag: the merge commit must be reachable from the base.
  const verified = logs.map((l) => JSON.parse(l)).find((e) => e.event === "merge.verified");
  assert.equal(verified.ancestor, true);
  assert.equal(verified.base, "main");
  const [record] = runRecords(repo);
  assert.equal(record.outcome, "reached");
  assert.equal(record.policy.until, "merged");
  assert.equal(record.readiness.ready, true);
});

test("system: `--detach` hands the run to a child and returns its identity", async () => {
  const repo = initGitRepo("orch-sysv2-detach-");
  gitDep.git(["branch", "orch/integration"], repo);
  mkdirSync(join(repo, ".orch"));
  let spawned = null;
  // A fake spawn: `--detach` must be observable from the parent's own state (a
  // registered run plus a log path) without a live child to poll.
  const { result: event } = await runMain(repo, ["task", "detached", "--until", "once", "--detach"], {
    spawn: (bin, argv, options) => {
      spawned = { bin, argv, options };
      return { pid: 424242, unref() {}, on() {}, once() {} };
    },
    detachPollMs: 1,
    detachWaitMs: 20,
  });

  assert.equal(event.event, "run.detached");
  assert.equal(event.pid, 424242);
  assert.match(event.log, /\.log$/);
  // The child is spawned WITHOUT --detach, or it would fork forever.
  assert.equal(spawned.argv.includes("--detach"), false);
  assert.equal(spawned.options.env.ORCH_DETACHED, "1");
  assert.equal(spawned.options.env.ORCH_DETACH_LOG, event.log);
  assert.equal(spawned.options.detached, true);
  // The parent detaches and returns; the RUN belongs to the child, so the
  // parent must not have written a run record of its own for it.
  assert.deepEqual(runRecords(repo), []);
});

// design §17's third system row: `orch pr <branch>` reviews an existing branch
// and reads readiness against that branch's OWN pull request, not the standing
// integration PR — a different target resolution reaching the same terminal.
test("system: `pr <branch>` reaches ready against the branch's own PR", async () => {
  const repo = initGitRepo("orch-sysv2-pr-");
  addOriginWithPeer(repo);
  gitDep.git(["branch", "feature/x"], repo);
  gitDep.git(["push", "-u", "origin", "feature/x"], repo);
  const head = gitDep.git(["rev-parse", "feature/x"], repo);
  const heads = [];
  const gh = greenGh(head, { onCall: (args) => { if (args[1] === "list") heads.push(args[args.indexOf("--head") + 1]); } });

  const { logs } = await runMain(repo, ["pr", "feature/x", "--until", "ready", "--json"], {
    githubDeps: () => ({ gh, git: gitDep.git }),
  });

  const end = JSON.parse(logs[logs.length - 1]);
  assert.equal(end.outcome, "reached");
  assert.equal(end.exit, 0);
  assert.deepEqual(heads, ["feature/x"], "readiness must be read against the reviewed branch's PR");
  const [record] = runRecords(repo);
  assert.equal(record.readiness.ready, true);
});

// --- the success-metric audit (proposal §7, scripts/v2-metrics.mjs) ----------
//
// The fixture set is hand-built so the expected numbers can be derived from the
// definitions rather than read off a run: 7 terminal runs, of which 6 reached
// their goal, 5 of those without a human reply, 4 pursued `--until ready`.

test("metrics: the fixture set reports more than zero clean unattended runs", () => {
  const report = audit(FIXTURES);
  assert.equal(report.runs, 7);
  assert.equal(report.reached, 6);
  assert.ok(report.cleanUnattended > 0, "the programme's headline metric must be measurable");
  assert.equal(report.cleanUnattended, 5);
  // b-1 reached its goal only after a human replied, so it is attended.
  assert.equal(report.readyRuns, 4);
  assert.equal(report.cleanUnattendedReadyRate, 0.75); // 3 of the 4 ready runs
});

test("metrics: a green exit without evidence is reported as a false ready/merged", () => {
  const report = audit(FIXTURES);
  assert.deepEqual(report.falseReady, ["d-1"]); // exit 0, no readiness observation
  assert.deepEqual(report.falseMerged, ["e-1"]); // exit 0 under `merged`, no merge commit
  assert.deepEqual(report.duplicateMergeRequests, ["g-1"]); // ordinals 1,1 — one merge asked twice
  assert.equal(report.localReady, 1); // f-1: no remote gate, not a false ready
  assert.equal(report.redriveCycles, 1);
  assert.equal(report.ok, false, "a violated invariant must fail the audit, not just report it");
});

test("metrics: an empty or missing .orch audits clean instead of throwing", () => {
  const report = audit(join(initGitRepo("orch-sysv2-empty-"), ".orch"));
  assert.deepEqual([report.runs, report.cycles, report.cleanUnattended], [0, 0, 0]);
  assert.equal(report.ok, true);
  assert.equal(report.cleanUnattendedReadyRate, null);
});
