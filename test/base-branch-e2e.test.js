import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
    const command = argv[0];
    const testArgv = ["task", "issue", "pr", "continue"].includes(command) && !argv.includes("--until")
      ? [...argv, "--until", "once"] : argv;
    await main(testArgv, { preflight() {}, cycleDeps: e2eCycleDeps(), ...deps });
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
  writeFileSync(join(repo, ".orch", "orch.yml"), "baseBranch: dev\nlanding: no-ff\ntest: \"true\"\n");

  const logs = await runMainInRepo(repo, ["task", "add a line to a.txt", "--no-tidy"]);

  assert.equal(git.gitTry(["rev-parse", "--verify", "main"], repo).ok, false);
  assert.equal(git.git(["rev-parse", "--abbrev-ref", "HEAD"], repo), "dev");
  assert.match(git.git(["log", "--oneline", "orch/integration"], repo), /add a line to a\.txt/);
  assert.match(logs.join("\n"), /merged \(agreed \+ green \+ integrated locally; PR bridge unavailable\)/);
});

test("a cycle branches from orch/integration while it is ahead of main", async () => {
  const repo = initRepoOn("main");
  mkdirSync(join(repo, ".orch"), { recursive: true });
  writeFileSync(join(repo, ".orch", "orch.yml"), "landing: no-ff\ntest: \"true\"\n");
  // A commit that lives on integration only — the state an open integration PR
  // leaves behind, and exactly what a main-based cycle used to be blind to.
  git.git(["checkout", "-b", "orch/integration"], repo);
  writeFileSync(join(repo, "b.txt"), "b\n");
  git.git(["add", "b.txt"], repo);
  git.git(["commit", "-m", "integrated earlier"], repo);
  git.git(["checkout", "main"], repo);
  const integrationTip = git.git(["rev-parse", "orch/integration"], repo);

  const deps = e2eCycleDeps();
  const getAdapter = deps.adapters.get;
  let sawIntegratedWork = null;
  deps.adapters = {
    get: (name) => {
      const adapter = getAdapter(name);
      return {
        ...adapter,
        async author(prompt, worktree, opts) {
          sawIntegratedWork = existsSync(join(worktree, "b.txt"));
          return adapter.author(prompt, worktree, opts);
        },
      };
    },
  };

  await runMainInRepo(repo, ["task", "add a line to a.txt", "--no-tidy"], { cycleDeps: deps });

  // The author worked on top of the already-integrated commit...
  assert.equal(sawIntegratedWork, true);
  // ...and the cycle's own diff still holds only the new change.
  assert.deepEqual(git.changedFiles(repo, "orch/integration", integrationTip), ["a.txt"]);
  // main is untouched: it stays the PR target, not the landing spot.
  assert.equal(existsSync(join(repo, "b.txt")), false);
  assert.equal(git.git(["log", "--oneline", "main"], repo).split("\n").length, 1);
});

test("--from salvages a branch while reviewing the slice against integration", async () => {
  const repo = initRepoOn("main");
  mkdirSync(join(repo, ".orch"), { recursive: true });
  writeFileSync(join(repo, ".orch", "orch.yml"), "landing: no-ff\ntest: \"true\"\n");
  git.git(["checkout", "-b", "orch/integration"], repo);
  writeFileSync(join(repo, "c.txt"), "already integrated\n");
  git.git(["add", "c.txt"], repo);
  git.git(["commit", "-m", "integrated earlier"], repo);
  const integrationTip = git.git(["rev-parse", "orch/integration"], repo);
  // Cut the salvaged branch from main, NOT from integration: an escalated
  // branch stops descending from the integration branch as soon as any other
  // cycle lands, and that non-descendant shape is the whole reason --from
  // exists. A version of this test that branches off integration would pass
  // against an ancestry guard that rejects every real salvage.
  git.git(["checkout", "main"], repo);
  git.git(["checkout", "-b", "salvaged"], repo);
  writeFileSync(join(repo, "b.txt"), "salvaged\n");
  git.git(["add", "b.txt"], repo);
  git.git(["commit", "-m", "preserve escalated work"], repo);
  const salvagedTip = git.git(["rev-parse", "salvaged"], repo);
  git.git(["checkout", "main"], repo);

  const deps = e2eCycleDeps();
  let created;
  let auditBase;
  const create = deps.git.createTaskBranch;
  deps.git = {
    ...deps.git,
    createTaskBranch(...args) {
      created = { branch: args[2], start: args[3], expected: args[5] };
      return create(...args);
    },
  };
  const getAdapter = deps.adapters.get;
  deps.adapters = {
    get: (name) => {
      const adapter = getAdapter(name);
      return {
        ...adapter,
        async audit(branch, worktree, opts) {
          auditBase = opts.base;
          return adapter.audit(branch, worktree, opts);
        },
      };
    },
  };

  await runMainInRepo(repo, ["task", "add a line to a.txt", "--from", "salvaged", "--no-tidy"], { cycleDeps: deps });

  assert.equal(created.start, "salvaged");
  assert.equal(created.expected, salvagedTip);
  assert.equal(git.git(["merge-base", created.branch, "salvaged"], repo), salvagedTip);
  assert.equal(auditBase, "orch/integration");
  assert.deepEqual(git.changedFiles(repo, created.branch, integrationTip).sort(), ["a.txt", "b.txt"]);
  assert.equal(existsSync(join(repo, "b.txt")), false, "the configured base checkout stays untouched");
});
