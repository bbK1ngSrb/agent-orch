import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as git from "../src/git.js";
import { mergeStanding } from "../src/landing.js";

const HEAD = "a".repeat(40);
const MERGE = "b".repeat(40);
const LAND = { pr: { number: 9, url: "https://github.com/o/r/pull/9" }, expectedHead: HEAD, landing: "standing", branch: "orch/integration" };
const CFG = { baseBranch: "main", integrationBranch: "orch/integration", test: "true" };

function lockFake(events = []) {
  return {
    acquireBlocking: async (_orchDir, name) => { events.push(["acquire", name]); return true; },
    releaseLock: (_orchDir, name) => { events.push(["release", name]); return true; },
  };
}

function fakeDeps({ required = ["ci"], reviewDecision = null, mergeResponse = "merged", gate = null, integrationTip = "" } = {}) {
  let state = "OPEN";
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "view") {
      return JSON.stringify({
        number: 9, state, isDraft: false, headRefOid: HEAD, baseRefName: "main",
        mergeable: "MERGEABLE", mergeStateStatus: reviewDecision ? "BLOCKED" : "CLEAN",
        reviewDecision, statusCheckRollup: required.map((context) => ({ context, state: "SUCCESS" })),
      });
    }
    if (args[0] === "api" && String(args[1]).includes("/rules/")) {
      return JSON.stringify(required.length ? [{ type: "required_status_checks", parameters: { required_status_checks: required.map((context) => ({ context })) } }] : []);
    }
    if (args[0] === "api" && String(args[1]).includes("/protection")) return JSON.stringify({ required_status_checks: { contexts: [] } });
    if (args[0] === "api" && args.some((arg) => String(arg).includes("/pulls/9/merge"))) {
      if (mergeResponse === "405") {
        const error = new Error("merge refused");
        error.stderr = "gh: Pull Request is not mergeable (HTTP 405)";
        throw error;
      }
      state = "MERGED";
      return JSON.stringify({ sha: MERGE });
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  const events = [];
  return {
    gh,
    calls,
    repo: "/repo",
    orchDir: "/orch",
    git: {
      git: (args) => args[0] === "rev-parse" && args[1] === "HEAD" ? HEAD
        : args[0] === "rev-parse" && args[1] === "refs/remotes/origin/orch/integration" ? integrationTip : "",
      ensureIntegrationWorktree: () => "/integration",
    },
    gate: gate || { detect: () => "true", run: () => ({ pass: true }) },
    lock: lockFake(events),
    events,
    syncMainFromOrigin: undefined,
  };
}

test("mergeStanding sends the exact head and verifies ancestry in a bare remote", async () => {
  const remote = mkdtempSync(join(tmpdir(), "orch-landing-remote-"));
  const repo = mkdtempSync(join(tmpdir(), "orch-landing-repo-"));
  git.git(["init", "--bare", remote], remote);
  git.git(["init", "-b", "main"], repo);
  git.git(["config", "user.email", "t@t"], repo);
  git.git(["config", "user.name", "t"], repo);
  writeFileSync(join(repo, "file.txt"), "base\n");
  git.git(["add", "."], repo);
  git.git(["commit", "-m", "base"], repo);
  git.git(["remote", "add", "origin", remote], repo);
  git.git(["push", "-u", "origin", "main"], repo);
  git.git(["checkout", "-b", "orch/integration"], repo);
  writeFileSync(join(repo, "file.txt"), "integrated\n");
  git.git(["commit", "-am", "integration"], repo);
  git.git(["push", "-u", "origin", "orch/integration"], repo);
  git.git(["checkout", "main"], repo);
  const head = git.git(["rev-parse", "origin/orch/integration"], repo);
  const mergeCalls = [];
  const requests = [];
  let state = "OPEN";
  let mergeCommit;
  const gh = (args) => {
    if (args[0] === "pr" && args[1] === "view") {
      return JSON.stringify({ number: 9, state, isDraft: false, headRefOid: head, baseRefName: "main", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: null, statusCheckRollup: [{ context: "ci", state: "SUCCESS" }] });
    }
    if (args[0] === "api" && String(args[1]).includes("/rules/")) return JSON.stringify([{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "ci" }] } }]);
    if (args[0] === "api" && args.some((arg) => String(arg).includes("/pulls/9/merge"))) {
      mergeCalls.push(args);
      git.git(["merge", "--no-ff", "origin/orch/integration", "-m", "merge integration"], repo);
      git.git(["push", "origin", "main"], repo);
      mergeCommit = git.git(["rev-parse", "main"], repo);
      state = "MERGED";
      return JSON.stringify({ sha: mergeCommit });
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  const result = await mergeStanding({ record: {}, cfg: CFG, land: { ...LAND, expectedHead: head }, readiness: { headSha: head } }, {
    gh, git, repo, orchDir: join(repo, ".orch"), lock: lockFake(), onMergeRequest: (request) => requests.push(request),
  });

  assert.equal(result.result, "merged");
  assert.equal(result.mergeCommit, mergeCommit);
  assert.equal(git.git(["rev-parse", "refs/remotes/origin/main"], repo), mergeCommit);
  assert.doesNotThrow(() => git.git(["merge-base", "--is-ancestor", head, "refs/remotes/origin/main"], repo));
  assert.deepEqual(mergeCalls[0].slice(-4), ["-f", "merge_method=merge", "-f", `sha=${head}`]);
  assert.deepEqual(requests, [{ pr: 9, head, method: "merge" }]);
});

test("mergeStanding gates the exact integration head when no checks are required", async () => {
  const seen = [];
  const deps = fakeDeps({ required: [], gate: { detect: () => "true", run: (cmd, path) => { seen.push([cmd, path]); return { pass: true }; } } });
  const result = await mergeStanding({ record: {}, cfg: CFG, land: LAND, readiness: { headSha: HEAD, required: { known: true, contexts: [] } } }, deps);

  assert.equal(result.result, "merged");
  assert.deepEqual(seen, [["true", "/integration"]]);
  assert.deepEqual(deps.events, [
    ["acquire", "standing-pr.lock"], ["acquire", "merge.lock"],
    ["release", "merge.lock"], ["release", "standing-pr.lock"],
  ]);
  assert.equal(deps.calls.filter((args) => String(args[1]).includes("/rules/")).length, 0);
  assert.ok(deps.calls.findIndex((a) => a.some((arg) => String(arg).includes("/pulls/9/merge"))) > -1);
});

test("mergeStanding discards the no-checks gate when the integration tip advanced", async () => {
  const advanced = "c".repeat(40);
  const seen = [];
  const deps = fakeDeps({
    required: [],
    integrationTip: advanced,
    gate: { detect: () => "true", run: (...args) => { seen.push(args); return { pass: true }; } },
  });
  const result = await mergeStanding({
    record: {}, cfg: CFG, land: LAND,
    readiness: { headSha: HEAD, required: { known: true, contexts: [] } },
  }, deps);

  assert.equal(result.result, "head-moved");
  assert.equal(result.headSha, advanced);
  assert.deepEqual(seen, []);
  assert.equal(deps.calls.some((args) => args.some((arg) => String(arg).includes("/pulls/9/merge"))), false);
});

test("mergeStanding handles HTTP 405 from status fields, not the error message", async () => {
  const deps = fakeDeps({ mergeResponse: "405", reviewDecision: "REVIEW_REQUIRED" });
  const result = await mergeStanding({ record: {}, cfg: CFG, land: LAND, readiness: { headSha: HEAD } }, deps);

  assert.equal(result.result, "rejected");
  assert.equal(result.failure.class, "REMOTE_REVIEW_REQUIRED");
  assert.equal(result.merge.requests[0].headSha, HEAD);
  assert.equal(result.merge.requests[0].method, "merge");
});

test("mergeStanding supports per-cycle PR landing with its configured merge method", async () => {
  const deps = fakeDeps();
  const result = await mergeStanding({
    record: {},
    cfg: { ...CFG, github: { mergeMethod: "squash" } },
    land: { ...LAND, landing: "pr", paths: ["file.txt"] },
    readiness: { headSha: HEAD },
  }, deps);

  assert.equal(result.result, "merged");
  const mergeCall = deps.calls.find((args) => args.some((arg) => String(arg).includes("/pulls/9/merge")));
  assert.ok(mergeCall.includes("merge_method=squash"));
});
