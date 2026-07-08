import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir, cwd } from "node:process";
import { main } from "../src/cli.js";
import { finalize } from "../src/finalize.js";
import * as checkpoint from "../src/checkpoint.js";
import * as git from "../src/git.js";
import * as inflight from "../src/inflight.js";
import * as lock from "../src/lock.js";
import * as scope from "../src/scope.js";

function initRepoOn(branch) {
  const repo = mkdtempSync(join(tmpdir(), "orch-basebranch-"));
  git.git(["init", "-b", branch], repo);
  git.git(["config", "user.email", "t@t"], repo);
  git.git(["config", "user.name", "t"], repo);
  git.git(["config", "core.autocrlf", "false"], repo);
  writeFileSync(join(repo, "a.txt"), "1\n");
  writeFileSync(join(repo, "package.json"), `${JSON.stringify({ name: "x", version: "0.0.1" }, null, 2)}\n`);
  git.git(["add", "."], repo);
  git.git(["commit", "-m", "init"], repo);
  return repo;
}

function noOpNotify() {
  return {
    phase() {},
    writeRound() {},
    writeRoundRaw() {},
    buildDecisionBrief() { return ""; },
    recordRun() {},
    cleanupReviews() {},
    resetKpi() {},
    escalate() {},
  };
}

function e2eCycleDeps() {
  const notify = noOpNotify();
  const gate = { detect: () => "true", run: () => ({ pass: true, log: "" }) };
  return {
    adapters: {
      get: (name) => ({
        name,
        async author(_prompt, worktree) {
          writeFileSync(join(worktree, "a.txt"), "1\n2\n");
          git.git(["add", "a.txt"], worktree);
          git.git(["commit", "-m", "add a line to a.txt"], worktree);
          return {};
        },
        async audit() {
          return { decision: "AGREE", reason: "ok", raw: "" };
        },
      }),
    },
    git,
    gate,
    scope,
    notify,
    inflight,
    checkpoint,
    finalize: (ctx, deps) => finalize(ctx, {
      ...deps,
      lock,
      github: {
        openIntegrationPr: async () => ({ prUrl: null }),
        openPr: async () => ({ prUrl: null }),
        demote: async () => ({ prUrl: null }),
      },
    }),
  };
}

async function runMainInRepo(repo, argv, deps = {}) {
  const prev = cwd();
  const savedExitCode = process.exitCode;
  const logs = [];
  const origLog = console.log;
  chdir(repo);
  console.log = (...args) => logs.push(args.map(String).join(" "));
  try {
    process.exitCode = 0;
    await main(argv, { preflight() {}, cycleDeps: e2eCycleDeps(), ...deps });
    return logs;
  } finally {
    console.log = origLog;
    chdir(prev);
    process.exitCode = savedExitCode;
  }
}

test("orch task end-to-end on a repo whose trunk is dev, not main", async () => {
  const repo = initRepoOn("dev");
  mkdirSync(join(repo, ".orch"), { recursive: true });
  writeFileSync(join(repo, ".orch", "orch.yml"), "baseBranch: dev\nmerge: no-ff\ntest: \"true\"\n");

  const logs = await runMainInRepo(repo, ["task", "add a line to a.txt", "--no-tidy"]);

  assert.equal(git.gitTry(["rev-parse", "--verify", "main"], repo).ok, false);
  assert.equal(git.git(["rev-parse", "--abbrev-ref", "HEAD"], repo), "dev");
  assert.match(git.git(["log", "--oneline", "orch/integration"], repo), /add a line to a\.txt/);
  assert.match(logs.join("\n"), /merged \(agreed \+ green \+ integrated locally; PR bridge unavailable\)/);
});
