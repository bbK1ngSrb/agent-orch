import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, mkdirSync, readdirSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, delimiter } from "node:path";
import { chdir, cwd } from "node:process";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import { slugify, nextAuthor, parse, main, preflight, resolveAgentBin, maybeSpawnDocs, spawnDocsTask, applyRoleOverrides, applyCheapOverride, maybePrintRunBanner, runBanner, visWidth, linkOrchDoc, realDeps, buildAgent, summaryLine, appendAgentToBlockList, priorStagedBranches, formatPriorStagedBranches, registerWithConcurrencyCap, raiseExitCode, mergeForRun, resolvePrTarget, resolveLanded, preparePrRepairRun, ghShell, COMMAND_FLAGS, PARSE_OPTIONS } from "../src/cli.js";
import { existsSync } from "node:fs";
import * as inflight from "../src/inflight.js";
import * as adapters from "../src/adapters/index.js";
import * as gitDep from "../src/git.js";
import * as notify from "../src/notify.js";
import * as checkpointDep from "../src/checkpoint.js";
import * as runRecordDep from "../src/run-record.js";
import * as resume from "../src/resume.js";
import { makeCliAdapter } from "../src/adapters/cli-adapter.js";
import { IS_WINDOWS } from "../src/platform.js";

const docsCfg = { docs: { autoUpdate: true, prompt: "update docs", paths: ["*.md"] } };

test("ghShell retries one authentication failure and keeps stdin non-interactive", () => {
  const calls = [];
  const sleeps = [];
  let attempts = 0;
  const result = ghShell(["auth", "status"], undefined, {
    exec: (_bin, args, options) => {
      calls.push({ args, options });
      attempts++;
      if (attempts === 1) {
        const error = new Error("HTTP 401: Bad credentials");
        error.status = 401;
        throw error;
      }
      return "Logged in";
    },
    sleep: (ms) => sleeps.push(ms),
  });

  assert.equal(result, "Logged in");
  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [100]);
  assert.deepEqual(calls[0].options.stdio, ["ignore", "pipe", "pipe"]);
});

test("ghShell does not retry a non-authentication failure", () => {
  let attempts = 0;
  const sleeps = [];
  assert.throws(() => ghShell(["pr", "view", "1"], undefined, {
    exec: () => {
      attempts++;
      const error = new Error("HTTP 500: Server error");
      error.status = 500;
      throw error;
    },
    sleep: (ms) => sleeps.push(ms),
  }), /HTTP 500/);
  assert.equal(attempts, 1);
  assert.deepEqual(sleeps, []);
});

function mockSpawn() {
  const calls = [];
  const spawn = (...args) => { calls.push(args); return { unref() {} }; };
  return { spawn, calls };
}

test("maybeSpawnDocs spawns once when merged + autoUpdate + !docsOnly", () => {
  const m = mockSpawn();
  const ok = maybeSpawnDocs({ status: "merged", docsOnly: false }, docsCfg, { spawn: m.spawn });
  assert.equal(ok, true);
  assert.equal(m.calls.length, 1);
  const argv = m.calls[0][1]; // [scriptPath, "task", prompt]
  assert.equal(argv[1], "task");
  assert.match(argv[2], /update docs$/); // ends with the configured prompt
  assert.match(argv[2], /^auto-docs [0-9a-z]+ /); // leads with a unique stamp
});

test("auto-docs prompts yield unique branch slugs (no existing-branch collision)", () => {
  const m = mockSpawn();
  maybeSpawnDocs({ status: "merged", docsOnly: false }, docsCfg, { spawn: m.spawn });
  maybeSpawnDocs({ status: "merged", docsOnly: false }, docsCfg, { spawn: m.spawn });
  const slug = (a) => slugify(a[1][2]);
  assert.notEqual(slug(m.calls[0]), slug(m.calls[1]));
});

test("maybeSpawnDocs does not spawn for a docs-only merge (loop guard)", () => {
  const m = mockSpawn();
  assert.equal(maybeSpawnDocs({ status: "merged", docsOnly: true }, docsCfg, { spawn: m.spawn }), false);
  assert.equal(m.calls.length, 0);
});

test("maybeSpawnDocs does not spawn for a no-op merge (empty-diff loop guard)", () => {
  const m = mockSpawn();
  assert.equal(maybeSpawnDocs({ status: "merged", docsOnly: false, noop: true }, docsCfg, { spawn: m.spawn }), false);
  assert.equal(m.calls.length, 0);
});

test("maybeSpawnDocs does not spawn when autoUpdate is off", () => {
  const m = mockSpawn();
  const cfg = { docs: { ...docsCfg.docs, autoUpdate: false } };
  assert.equal(maybeSpawnDocs({ status: "merged", docsOnly: false }, cfg, { spawn: m.spawn }), false);
  assert.equal(m.calls.length, 0);
});

test("maybeSpawnDocs does not spawn when not merged", () => {
  const m = mockSpawn();
  assert.equal(maybeSpawnDocs({ status: "escalated" }, docsCfg, { spawn: m.spawn }), false);
  assert.equal(m.calls.length, 0);
});

test("maybeSpawnDocs does not spawn under --dry", () => {
  const m = mockSpawn();
  assert.equal(maybeSpawnDocs({ status: "merged", docsOnly: false }, docsCfg, { spawn: m.spawn, dry: true }), false);
  assert.equal(m.calls.length, 0);
});

test("spawnDocsTask closes the parent docs log fd after spawn", () => {
  const closed = [];
  const calls = [];
  spawnDocsTask("update docs", {
    spawn: (...args) => { calls.push(args); return { unref() {} }; },
    openSync: () => 42,
    closeSync: (fd) => closed.push(fd),
  }, "/tmp/orch");
  assert.deepEqual(calls[0][2].stdio, ["ignore", 42, 42]);
  assert.deepEqual(closed, [42]);
});

test("spawnDocsTask closes the parent docs log fd when spawn throws", () => {
  const closed = [];
  assert.throws(() => spawnDocsTask("update docs", {
    spawn: () => { throw new Error("spawn failed"); },
    openSync: () => 43,
    closeSync: (fd) => closed.push(fd),
  }, "/tmp/orch"), /spawn failed/);
  assert.deepEqual(closed, [43]);
});

test("--detach refuses an uninitialized repository before logging or spawning", async () => {
  const repo = mkdtempSync(join(tmpdir(), "orch-detach-uninitialized-"));
  const previousCwd = cwd();
  let spawnCalls = 0;
  chdir(repo);
  try {
    await assert.rejects(
      () => main(["task", "detached work", "--detach"], {
        spawn: () => { spawnCalls += 1; },
      }),
      (error) => error.exit === 64 && /orch init/.test(error.message),
    );
    assert.equal(spawnCalls, 0);
    assert.deepEqual(readdirSync(repo), []);
  } finally {
    chdir(previousCwd);
  }
});

test("--detach waits for the child run record and reports its handle", async () => {
  const repo = mkdtempSync(join(tmpdir(), "orch-detach-"));
  mkdirSync(join(repo, ".orch"));
  const child = new EventEmitter();
  child.pid = 424242;
  child.unref = () => {};
  let spawnArgs;
  const logs = [];
  const previousLog = console.log;
  const previousCwd = cwd();
  chdir(repo);
  console.log = (...args) => logs.push(args.map(String).join(" "));
  try {
    const event = await main(["task", "detached work", "--detach", "--json"], {
      spawn: (...args) => {
        spawnArgs = args;
        setImmediate(() => {
          const rawLog = args[2].env.ORCH_DETACH_LOG;
          runRecordDep.create(join(repo, ".orch"), {
            runId: "526-0",
            command: "task",
            argv: ["task", "detached work"],
            detached: { pid: child.pid, detachedLog: rawLog, startedAt: new Date().toISOString(), runId: "526-0" },
          });
        });
        return child;
      },
      detachPollMs: 1,
      detachWaitMs: 100,
    });
    assert.deepEqual(event, {
      event: "run.detached",
      pid: child.pid,
      log: event.log,
      runId: "526-0",
    });
    assert.equal(spawnArgs[1].includes("--detach"), false);
    assert.equal(spawnArgs[2].detached, true);
    assert.equal(spawnArgs[2].env.ORCH_DETACHED, "1");
    assert.match(spawnArgs[2].env.ORCH_DETACH_LOG, /\d{8}-\d{6}-\d+\.log$/);
    assert.equal(JSON.parse(logs[0]).runId, "526-0");
  } finally {
    console.log = previousLog;
    chdir(previousCwd);
  }
});

test("--detach child registers a live run visible to dashboard JSON", async () => {
  const repo = mkdtempSync(join(tmpdir(), "orch-detach-e2e-"));
  mkdirSync(join(repo, ".orch"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=orch-test", "-c", "user.email=orch-test@example.invalid", "commit", "--allow-empty", "-m", "test"], { cwd: repo, stdio: "ignore" });
  const cliUrl = new URL("../src/cli.js", import.meta.url).href;
  const script = join(repo, "detached-child.mjs");
  writeFileSync(script, [
    `import { main } from ${JSON.stringify(cliUrl)};`,
    "const wait = new Promise(() => {});",
    "setInterval(() => {}, 1000);",
    "await main(process.argv.slice(2), {",
    "  preflight: () => {},",
    "  maybeNotifyUpdate: () => Promise.resolve(),",
    "  cycleDeps: {",
    "    adapters: { get: () => ({ audit: async () => wait }) },",
    "    git: { git: () => \"base\", attachExistingBranch() {}, changedFiles() { return []; } },",
    "    gate: { detect: () => \"true\" },",
    "    notify: { phase() {} },",
    "  },",
    "});",
  ].join("\n"));
  let childProcess;
  const parentLogs = [];
  const previousLog = console.log;
  const previousCwd = cwd();
  chdir(repo);
  console.log = (...args) => parentLogs.push(args.map(String).join(" "));
  try {
    const event = await main(["review", "main", "--detach"], {
      script,
      spawn: (...args) => {
        childProcess = spawn(...args);
        return childProcess;
      },
      detachPollMs: 1,
      detachWaitMs: 1000,
    });
    assert.equal(event.event, "run.detached");
    const record = inflight.lookup(join(repo, ".orch"), event.runId);
    assert.equal(record.detached, true);
    assert.equal(record.detachedLog, event.log);
    assert.equal(record.runId, event.runId);

    const dashboardLogs = [];
    console.log = (...args) => dashboardLogs.push(args.map(String).join(" "));
    await main(["dashboard", "--once", "--json"], { maybeNotifyUpdate: () => Promise.resolve() });
    const snapshot = JSON.parse(dashboardLogs[0]);
    const live = snapshot.live.find((entry) => entry.runId === event.runId);
    assert.ok(live);
    assert.equal(live.detached, true);
    assert.equal(live.detachedLog, event.log);
    assert.equal(live.runId, event.runId);
    assert.equal(parentLogs.length, 1);
  } finally {
    if (childProcess && childProcess.exitCode === null && childProcess.signalCode === null) {
      await new Promise((resolve) => {
        childProcess.once("exit", resolve);
        childProcess.kill("SIGTERM");
      });
    }
    console.log = previousLog;
    chdir(previousCwd);
  }
});

test("--detach ignores a stale recycled-PID record while the child is still starting", async () => {
  const repo = mkdtempSync(join(tmpdir(), "orch-detach-starting-"));
  runRecordDep.create(join(repo, ".orch"), {
    runId: "stale-526-0",
    command: "task",
    argv: ["task", "old detached work"],
    detached: { pid: 424244, detachedLog: "stale.log", startedAt: "2000-01-01T00:00:00.000Z", runId: "stale-526-0" },
  });
  const child = new EventEmitter();
  child.pid = 424244;
  child.unref = () => {};
  let rawLog;
  const previousLog = console.log;
  const previousCwd = cwd();
  chdir(repo);
  console.log = () => {};
  try {
    const event = await main(["task", "slow detached work", "--detach"], {
      spawn: (...args) => {
        rawLog = args[2].env.ORCH_DETACH_LOG;
        return child;
      },
      detachPollMs: 1,
      detachWaitMs: 5,
    });
    assert.deepEqual(event, { event: "run.detached", pid: child.pid, log: rawLog, runId: null, starting: true });
    assert.equal(existsSync(rawLog), true);
  } finally {
    console.log = previousLog;
    chdir(previousCwd);
  }
});

test("--detach propagates an early child exit and prints the log tail", async () => {
  const repo = mkdtempSync(join(tmpdir(), "orch-detach-early-"));
  mkdirSync(join(repo, ".orch"));
  const child = new EventEmitter();
  child.pid = 424243;
  child.unref = () => {};
  let stderr = "";
  let spawned = false;
  const previousWrite = process.stderr.write;
  const previousCwd = cwd();
  chdir(repo);
  process.stderr.write = (chunk) => { stderr += String(chunk); return true; };
  try {
    let error;
    await assert.rejects(
      () => main(["tsk", "detached work", "--detach"], {
        spawn: (...args) => {
          spawned = true;
          setImmediate(() => {
            const rawLog = args[2].env.ORCH_DETACH_LOG;
            writeFileSync(rawLog, `${Array.from({ length: 21 }, (_, i) => `line-${i + 1}`).join("\n")}\n`);
            child.emit("exit", 64, null);
          });
          return child;
        },
        detachPollMs: 1,
        detachWaitMs: 100,
      }).catch((caught) => {
        error = caught;
        throw caught;
      }),
      (error) => error.exit === 64 && /line-21/.test(error.message),
    );
    assert.equal(spawned, true);
    assert.equal((error.message.match(/line-21/g) || []).length, 1);
    assert.doesNotMatch(stderr, /line-21/);
    assert.doesNotMatch(stderr, /line-1\n/);
  } finally {
    process.stderr.write = previousWrite;
    chdir(previousCwd);
  }
});

test("orch tsk --detach refuses an uninitialized repository", () => {
  const repo = mkdtempSync(join(tmpdir(), "orch-detach-usage-"));
  const result = spawnSync(
    process.execPath,
    [new URL("../bin/orch.js", import.meta.url).pathname, "tsk", "detached work", "--detach"],
    { cwd: repo, encoding: "utf8" },
  );
  assert.equal(result.status, 64, result.stderr);
  assert.equal(result.stderr, "orch: detached runs require .orch — run `orch init` first\n");
  assert.deepEqual(readdirSync(repo), []);
});

test("SIGTERM marks a detached run interrupted and releases its lock", { skip: process.platform === "win32" }, async () => {
  const orchDir = join(mkdtempSync(join(tmpdir(), "orch-detach-signal-")), ".orch");
  const cliUrl = new URL("../src/cli.js", import.meta.url).href;
  const lockUrl = new URL("../src/lock.js", import.meta.url).href;
  const recordUrl = new URL("../src/run-record.js", import.meta.url).href;
  const script = [
    "import { installDetachedSignalCleanup } from " + JSON.stringify(cliUrl),
    "import { acquireLock } from " + JSON.stringify(lockUrl),
    "import { create } from " + JSON.stringify(recordUrl),
    "const orchDir = " + JSON.stringify(orchDir),
    "create(orchDir, { runId: \"signal-run\", command: \"task\", argv: [], detached: { pid: process.pid, detachedLog: \"run.log\" } })",
    "acquireLock(orchDir, \"lock\")",
    "installDetachedSignalCleanup(orchDir, \"signal-run\", { pid: process.pid, detachedLog: \"run.log\" })",
    "if (process.send) process.send(\"ready\")",
    "setInterval(() => {}, 1000)",
  ].join("\n");
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  await new Promise((resolve) => child.once("message", resolve));
  child.kill("SIGTERM");
  const result = await new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  assert.equal(result.signal, "SIGTERM");
  const record = runRecordDep.lookup(orchDir, "signal-run");
  assert.equal(record.state, "ERROR");
  assert.equal(record.outcome, "error");
  assert.equal(record.interrupted.signal, "SIGTERM");
  assert.equal(existsSync(join(orchDir, "lock")), false);
});

test("--config-file layers a custom yml onto orch.yml for the run (F: config override)", async () => {
  const d = mkdtempSync(join(tmpdir(), "orch-cfgfile-"));
  const override = join(d, "custom.yml");
  writeFileSync(override, "merge: ff-only\n");
  const prev = cwd();
  chdir(d);
  let out = "";
  try {
    process.exitCode = 0;
    await main(["task", "hello world", "--dry", "--config-file", override], {
      stdout: { isTTY: true, write: (chunk) => { out += chunk; } },
    });
  } finally {
    chdir(prev);
    process.exitCode = 0;
  }
  const plain = out.replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(plain, /merge\s+ff-only/); // orch.yml default is no-ff; --config-file overrode it
});

test("slugify produces a branch-safe slug", () => {
  assert.equal(slugify("Fix the flaky test!!"), "fix-the-flaky-test");
});

test("--dry completes without any agent CLI on PATH (F2)", async () => {
  const d = mkdtempSync(join(tmpdir(), "orch-dry-"));
  const prev = cwd();
  chdir(d);
  try {
    process.exitCode = 0;
    await main(["task", "hello world", "--dry"]); // dryDeps: no real git/agent/test
    assert.notEqual(process.exitCode, 2); // not escalated
    assert.equal(existsSync(join(d, ".orch")), false);
  } finally {
    chdir(prev);
    process.exitCode = 0;
  }
});

// Pairs with the test above: that one pins the clean path (no `.orch/` at all),
// this one pins the documented exception. dryDeps() stubs the round/run writers
// but leaves notify.escalate real — escalating is how orch reports that a cycle
// cannot proceed, so a plan that hits it still writes its brief. With `test:`
// unset there is no gate command, so the AGREE branch escalates instead.
test("--dry that escalates still writes its brief under .orch (#471 wording)", async () => {
  const d = mkdtempSync(join(tmpdir(), "orch-dry-esc-"));
  const override = join(d, "custom.yml");
  writeFileSync(override, "test: null\n");
  const prev = cwd();
  chdir(d);
  try {
    process.exitCode = 0;
    await main(["task", "hello world", "--dry", "--config-file", override, "--no-banner"], {
      stdout: { write() {} },
    });
    assert.equal(process.exitCode, 2); // escalated
    assert.equal(existsSync(join(d, ".orch", "kpi.json")), true);
    // Branch name carries a random suffix, so walk for the brief instead of
    // spelling its path (readdirSync recursive: true needs Node >= 20).
    const hasBrief = (dir) => readdirSync(dir, { withFileTypes: true })
      .some((e) => (e.isDirectory() ? hasBrief(join(dir, e.name)) : e.name === "DECISION.md"));
    assert.ok(hasBrief(join(d, ".orch", "reviews")), "escalated dry run wrote no DECISION.md");
  } finally {
    chdir(prev);
    process.exitCode = 0;
  }
});

test("GitHub App auth is silent when repo has no origin remote", async () => {
  const repo = initGitRepo("orch-no-origin-");
  const prev = cwd();
  const prevEnv = {
    GH_TOKEN: process.env.GH_TOKEN,
    ORCH_APP_ID: process.env.ORCH_APP_ID,
    ORCH_APP_PRIVATE_KEY: process.env.ORCH_APP_PRIVATE_KEY,
  };
  const prevStderrWrite = process.stderr.write;
  let stderr = "";
  chdir(repo);
  delete process.env.GH_TOKEN;
  process.env.ORCH_APP_ID = "1";
  process.env.ORCH_APP_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----\nx";
  process.stderr.write = (chunk, ...args) => {
    stderr += String(chunk);
    if (typeof args[args.length - 1] === "function") args[args.length - 1]();
    return true;
  };
  try {
    await main(["init"], { preflight() {} });
    assert.equal(stderr, "");
  } finally {
    process.stderr.write = prevStderrWrite;
    chdir(prev);
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

// An unrecognised command used to fall through past the GitHub App auth mint
// (main() reached it before the unknown-command check, which lived at the very
// bottom of the function) — so a typo'd command still tried to mint a token
// before being refused. Prove the mint no longer runs by putting it somewhere
// it WOULD fail loudly: a plain (non-git) directory, where `git remote get-url
// origin` errors with something other than "no such remote" and the catch
// writes to stderr. No stderr output means the mint was never attempted.
test("unknown command is rejected before the GitHub App auth mint runs", async () => {
  const d = mkdtempSync(join(tmpdir(), "orch-unknown-cmd-"));
  const prev = cwd();
  const prevEnv = {
    GH_TOKEN: process.env.GH_TOKEN,
    ORCH_APP_ID: process.env.ORCH_APP_ID,
    ORCH_APP_PRIVATE_KEY: process.env.ORCH_APP_PRIVATE_KEY,
  };
  const prevStderrWrite = process.stderr.write;
  let stderr = "";
  chdir(d);
  delete process.env.GH_TOKEN;
  process.env.ORCH_APP_ID = "1";
  process.env.ORCH_APP_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----\nx";
  process.stderr.write = (chunk, ...args) => {
    stderr += String(chunk);
    if (typeof args[args.length - 1] === "function") args[args.length - 1]();
    return true;
  };
  try {
    await assert.rejects(
      () => main(["bogus-command"], { preflight() {} }),
      /unknown command: bogus-command/,
    );
    assert.equal(stderr, "", "GitHub App auth must not be attempted for an unrecognised command");
  } finally {
    process.stderr.write = prevStderrWrite;
    chdir(prev);
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

// --dry promises to "plan without shelling out or changing git" (schema.js),
// but the GitHub App auth mint used to run unconditionally ahead of every
// command — even a dry run shelled out to `git remote get-url origin` and
// phoned GitHub for an installation token. Same non-git-dir probe as the
// unknown-command test above: no stderr means the mint was never attempted.
test("--dry skips the GitHub App auth mint", async () => {
  const d = mkdtempSync(join(tmpdir(), "orch-dry-no-auth-"));
  const prev = cwd();
  const prevEnv = {
    GH_TOKEN: process.env.GH_TOKEN,
    ORCH_APP_ID: process.env.ORCH_APP_ID,
    ORCH_APP_PRIVATE_KEY: process.env.ORCH_APP_PRIVATE_KEY,
  };
  const prevStderrWrite = process.stderr.write;
  let stderr = "";
  chdir(d);
  delete process.env.GH_TOKEN;
  process.env.ORCH_APP_ID = "1";
  process.env.ORCH_APP_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----\nx";
  process.stderr.write = (chunk, ...args) => {
    stderr += String(chunk);
    if (typeof args[args.length - 1] === "function") args[args.length - 1]();
    return true;
  };
  try {
    await main(["init", "--dry"], { preflight() {} });
    assert.equal(stderr, "", "GitHub App auth must not be attempted on a dry run");
  } finally {
    process.stderr.write = prevStderrWrite;
    chdir(prev);
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("main prints startup banner for task runs on TTY", async () => {
  let out = "";
  await runMainCapture(["task", "hello world", "--dry"], {
    stdout: { isTTY: true, write: (chunk) => { out += chunk; } },
  });
  const plain = out.replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(plain, /agent-orch v\d+\.\d+\.\d+/);
  assert.match(plain, /author\s+claude/);
  assert.match(plain, /review\s+codex/);
  assert.match(plain, /test\s+auto/);
  assert.match(plain, /merge\s+no-ff/);

  out = "";
  await runMainCapture(["task", "hello world", "--dry", "--no-banner"], {
    stdout: { isTTY: true, write: (chunk) => { out += chunk; } },
  });
  assert.equal(out, "");
});

test("parse splits command, rest, and flags", () => {
  const p = parse(["task", "do x", "--dry", "--authors", "claude,codex", "--reviewers", "codex,claude"]);
  assert.equal(p.command, "task");
  assert.deepEqual(p.rest, ["do x"]);
  assert.equal(p.flags.dry, true);
  assert.equal(p.flags.authors, "claude,codex");
  assert.equal(p.flags.reviewers, "codex,claude");
});

test("parse captures --file flag", () => {
  const p = parse(["task", "--file", "task.md", "--dry"]);
  assert.equal(p.command, "task");
  assert.equal(p.flags.file, "task.md");
});

test("parse captures --config-file flag", () => {
  const p = parse(["task", "do x", "--config-file", "custom.yml", "--dry"]);
  assert.equal(p.flags["config-file"], "custom.yml");
});

test("parse captures --no-banner flag", () => {
  const p = parse(["task", "do x", "--no-banner"]);
  assert.equal(p.flags["no-banner"], true);
});

test("parse captures dashboard --check-history flag", () => {
  const p = parse(["dashboard", "--check-history"]);
  assert.equal(p.command, "dashboard");
  assert.equal(p.flags["check-history"], true);
});

test("parse captures dashboard --once/--plain/--refresh-ms flags", () => {
  const p = parse(["dashboard", "--once", "--refresh-ms", "500"]);
  assert.equal(p.flags.once, true);
  assert.equal(p.flags["refresh-ms"], "500");
  assert.equal(parse(["dashboard", "--plain"]).flags.plain, true);
});

test("orch upgrade --check routes through the self-update runner", async () => {
  let out = "";
  const calls = [];
  await main(["upgrade", "--check"], {
    stdout: { isTTY: false, write: (chunk) => { out += chunk; } },
    upgradeDeps: {
      current: "1.0.0",
      resolveInstall: () => ({ type: "registry" }),
      exec: (cmd, args = []) => {
        calls.push([cmd, ...args]);
        return "1.1.0";
      },
    },
  });
  assert.deepEqual(calls, [["npm", "view", "@bbk1ng/agent-orch", "version"]]);
  assert.match(out, /upgrade available/);
});

test("orch upgrade --dry reaches the runner and installs nothing", async () => {
  // --dry is consumed by runUpgrade, so the per-command flag guard must allow it
  // on upgrade/update; a missing table entry would reject a working invocation.
  let out = "";
  const calls = [];
  const deps = {
    stdout: { isTTY: false, write: (chunk) => { out += chunk; } },
    upgradeDeps: {
      current: "1.0.0",
      resolveInstall: () => ({ type: "registry" }),
      exec: (cmd, args = []) => {
        calls.push([cmd, ...args]);
        return "1.1.0";
      },
    },
  };
  await main(["upgrade", "--dry"], deps);
  assert.deepEqual(calls, [["npm", "view", "@bbk1ng/agent-orch", "version"]]);
  assert.match(out, /would run `npm install -g @bbk1ng\/agent-orch@latest`/);

  out = "";
  calls.length = 0;
  await main(["update", "--dry"], deps);
  assert.deepEqual(calls, [["npm", "view", "@bbk1ng/agent-orch", "version"]]);
  assert.match(out, /would run/);
});

// ORCH_DRYRUN=1 is the env-var equivalent of --dry every other write command
// honors (see the `dryRun` computation in main()). `upgrade` used to check
// only `flags.dry`, so ORCH_DRYRUN=1 alone still ran `npm install -g` for
// real; `config` used to skip the check entirely and always launch the
// interactive wizard, since --dry isn't even a legal flag on it.
test("ORCH_DRYRUN=1 is honored by upgrade and config, not just --dry", async () => {
  const prev = process.env.ORCH_DRYRUN;
  process.env.ORCH_DRYRUN = "1";
  try {
    let out = "";
    await main(["upgrade"], {
      stdout: { isTTY: false, write: (chunk) => { out += chunk; } },
      upgradeDeps: {
        current: "1.0.0",
        resolveInstall: () => ({ type: "registry" }),
        exec: (cmd, args = []) => {
          if (cmd === "npm" && args[0] === "install") assert.fail("upgrade installed despite ORCH_DRYRUN=1");
          return "1.1.0";
        },
      },
    });
    assert.match(out, /would run `npm install -g @bbk1ng\/agent-orch@latest`/);

    // `config`'s dry-run guard is what stops this from launching the real,
    // interactive wizard — if it ever regresses, runConfigWizard would run
    // against process.cwd() for real, which must never be the developer's
    // actual checkout. A temp dir makes a guard regression merely fail loud
    // (ENOENT / a hanging prompt in CI) instead of writing the real repo's
    // own .orch/orch.yml.
    const d = mkdtempSync(join(tmpdir(), "orch-dryrun-config-"));
    const prevCwd = cwd();
    chdir(d);
    let logged = "";
    const prevLog = console.log;
    console.log = (chunk = "") => { logged += `${chunk}\n`; };
    try {
      await main(["config"], {
        preflight() {},
        inputStart: () => assert.fail("config wizard ran despite ORCH_DRYRUN=1"),
      });
    } finally {
      console.log = prevLog;
      chdir(prevCwd);
    }
    assert.match(logged, /orch \(dry\): would run the interactive config wizard/);
  } finally {
    if (prev === undefined) delete process.env.ORCH_DRYRUN;
    else process.env.ORCH_DRYRUN = prev;
  }
});

// The background update check only checked `flags.dry`, so ORCH_DRYRUN=1
// alone still fired a real network call before every command — the same gap
// `upgrade` and `config` had, just one level up in main().
test("ORCH_DRYRUN=1 suppresses the background update check", async () => {
  const prev = process.env.ORCH_DRYRUN;
  process.env.ORCH_DRYRUN = "1";
  const d = mkdtempSync(join(tmpdir(), "orch-dryrun-updater-"));
  try {
    await runMainInRepo(d, ["init"], {
      detectAgents: () => ({ found: [], missing: [] }),
      maybeNotifyUpdate: () => { throw new Error("update check ran despite ORCH_DRYRUN=1"); },
    });
  } finally {
    if (prev === undefined) delete process.env.ORCH_DRYRUN;
    else process.env.ORCH_DRYRUN = prev;
  }
});

// "__update-check-child" (the detached re-exec target spawnChecker spawns) is
// declared read-only in INTERNAL_COMMANDS and has no --dry flag of its own —
// but it unconditionally wrote ~/.orch/update-check.json regardless of
// ORCH_DRYRUN=1, because main() returned from this branch before `dryRun` was
// even computed. A real invocation would also make a real network call
// (fetchLatestFromNpm), so this only asserts the cache file: if the fix
// regresses, this test either fails on the missing-file assertion or hangs
// on a real npm registry request instead of finishing instantly.
test("ORCH_DRYRUN=1 stops the update-check re-exec child from writing its cache", async () => {
  const prev = process.env.ORCH_DRYRUN;
  process.env.ORCH_DRYRUN = "1";
  const cacheDir = mkdtempSync(join(tmpdir(), "orch-dryrun-child-"));
  try {
    await main(["__update-check-child", "1.0.0", cacheDir]);
    assert.ok(!existsSync(join(cacheDir, "update-check.json")));
  } finally {
    if (prev === undefined) delete process.env.ORCH_DRYRUN;
    else process.env.ORCH_DRYRUN = prev;
  }
});

// `orch task "   "` (whitespace-only) passed the old `if (!task)` check — a
// string of only spaces is truthy — and would have gone on to run a cycle
// with a blank task label/branch slug.
test("orch task rejects a whitespace-only task text", async () => {
  const repo = initGitRepo();
  await assert.rejects(
    () => runMainInRepo(repo, ["task", "   "]),
    (e) => e.exit === 64 && /usage: orch task/.test(e.message),
  );
});

// `config` mutates (runConfigWizard writes orch.yml), so --dry belongs on it
// like every other write command — it used to be rejected as "not valid with
// 'orch config'" even though cli.js already had a dry handler for it.
test("orch config --dry prints the plan and never runs the wizard", async () => {
  let logged = "";
  const prevLog = console.log;
  console.log = (chunk = "") => { logged += `${chunk}\n`; };
  try {
    await main(["config", "--dry"], {
      preflight() {},
      stdin: {}, stdout: {},
      inputStart: () => assert.fail("config wizard ran despite --dry"),
    });
  } finally {
    console.log = prevLog;
  }
  assert.match(logged, /orch \(dry\): would run the interactive config wizard/);
});

test("help documents upgrade command and check flag", async () => {
  const prevLog = console.log;
  let out = "";
  console.log = (chunk = "") => { out += `${chunk}\n`; };
  try {
    await main(["help"]);
  } finally {
    console.log = prevLog;
  }
  assert.match(out, /upgrade, update/);
  assert.match(out, /--check\s+With upgrade/);
});

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("runBanner shows version, agents, per-agent model+effort, test, merge", () => {
  const cfg = { agents: ["claude", "codex"], test: "npm test", merge: "ff-only" };
  const banner = stripAnsi(runBanner(cfg, [{
    author: { agent: "claude", model: "opus", effort: "high" },
    reviewers: [{ agent: "codex", model: "gpt-5", effort: null }],
  }]));
  assert.match(banner, /agent-orch v\d+\.\d+\.\d+/);
  assert.match(banner, /claude, codex/);            // agents row
  assert.match(banner, /claude.*opus.*high/);       // author with model + effort
  assert.match(banner, /codex.*gpt-5/);             // reviewer with model
  assert.match(banner, /npm test/);
  assert.match(banner, /ff-only/);
});

test("runBanner lists each author run and deduplicates reviewers", () => {
  const cfg = { agents: ["claude", "codex"], test: "auto", merge: "no-ff" };
  const banner = stripAnsi(runBanner(cfg, [
    {
      author: { agent: "claude", model: "opus" },
      reviewers: [{ agent: "codex", model: "gpt-5" }],
    },
    {
      author: { agent: "codex", model: "gpt-5", effort: "medium" },
      reviewers: [{ agent: "codex", model: "gpt-5" }, { agent: "claude", model: "opus" }],
    },
  ]));
  const lines = banner.split("\n");
  const authorLines = lines.filter((l) => /\bauthor\b/.test(l));
  assert.equal(authorLines.length, 2);
  assert.match(authorLines[0], /claude.*opus/);
  assert.match(authorLines[1], /codex.*gpt-5.*medium/);

  const reviewLine = lines.find((l) => /\breview\b/.test(l));
  assert.ok(reviewLine);
  assert.equal((reviewLine.match(/codex/g) || []).length, 1);
  assert.equal((reviewLine.match(/claude/g) || []).length, 1);
});

test("runBanner shows the resume marker only when a run resumes", () => {
  const cfg = { agents: ["claude"], test: "auto", merge: "no-ff" };
  const author = { agent: "claude", model: "opus", effort: "high" };
  const reviewers = [{ agent: "codex" }];
  const resuming = stripAnsi(runBanner(cfg, [{ author, reviewers, resume: true }]));
  const fresh = stripAnsi(runBanner(cfg, [{ author, reviewers, resume: false }]));
  assert.match(resuming, /resume/);
  assert.doesNotMatch(fresh, /resume/);
});

test("runBanner emits ANSI color only when color is on", () => {
  const cfg = { agents: ["claude"], test: "auto", merge: "no-ff" };
  const runs = [{ author: { agent: "claude" }, reviewers: [{ agent: "codex" }] }];
  assert.match(runBanner(cfg, runs, { color: true }), /\x1b\[/);
  assert.doesNotMatch(runBanner(cfg, runs, { color: false }), /\x1b\[/);
});

test("runBanner rows stay display-width aligned even with wide glyphs", () => {
  // U+23F3 (⏳) renders 2 columns; .length-based padding would misalign the
  // resume row's right border. visWidth must keep every line the same width.
  const cfg = { agents: ["claude", "codex"], test: "auto", merge: "no-ff" };
  const lines = runBanner(cfg, [{
    author: { agent: "claude", model: "opus", effort: "high" },
    reviewers: [{ agent: "codex", model: "gpt-5" }],
    resume: true,
  }]).split("\n");
  const widths = new Set(lines.map((l) => visWidth(l)));
  assert.equal(widths.size, 1, `lines misaligned: ${[...widths].join(",")}`);
});

test("runBanner clamps responsive width and never throws on tiny terminals", () => {
  const cfg = { agents: ["claude"], test: "auto", merge: "no-ff" };
  const runs = [{ author: { agent: "claude", model: "opus" }, reviewers: [{ agent: "codex" }] }];
  const wide = runBanner(cfg, runs, { columns: 400 }).split("\n");
  assert.ok(visWidth(wide[0]) <= 100, `width not capped: ${visWidth(wide[0])}`);
  const tiny = runBanner(cfg, runs, { columns: 10 }).split("\n");
  assert.equal(new Set(tiny.map(visWidth)).size, 1); // still aligned
});

test("run banner prints only on TTY and respects --no-banner", () => {
  const cfg = { agents: ["claude"], test: "auto", merge: "no-ff" };
  const runs = [{ author: { agent: "claude" }, reviewers: [{ agent: "codex" }] }];
  let out = "";
  const tty = { isTTY: true, write: (chunk) => { out += chunk; } };
  assert.equal(maybePrintRunBanner(cfg, runs, {}, tty), true);
  assert.match(stripAnsi(out), /agent-orch v\d+\.\d+\.\d+/);

  out = "";
  assert.equal(maybePrintRunBanner(cfg, runs, { "no-banner": true }, tty), false);
  assert.equal(out, "");

  const notTty = { isTTY: false, write: (chunk) => { out += chunk; } };
  assert.equal(maybePrintRunBanner(cfg, runs, {}, notTty), false);
  assert.equal(out, "");
});

test("runBanner colors the agents row when color is on", () => {
  const cfg = { agents: ["claude", "codex"], test: "npm test", merge: "no-ff" };
  const runs = [{ author: "claude", reviewers: ["codex"] }];
  const out = runBanner(cfg, runs, { color: true, columns: 80 });
  assert.match(out, /\x1b\[38;5;214mclaude, codex\x1b\[0m/);
});

test("runBanner emits no ANSI codes when color is off", () => {
  const cfg = { agents: ["claude"], test: "npm test", merge: "no-ff" };
  const runs = [{ author: "claude", reviewers: [] }];
  const out = runBanner(cfg, runs, { color: false, columns: 80 });
  assert.doesNotMatch(out, /\x1b\[/);
  assert.match(out, /agent-orch/);
});

const WORK_ORDER = JSON.stringify({
  title: "fix the flaky retry",
  problem: "retries double-fire under load",
  repro_steps: ["hammer the endpoint"],
  suspected_paths: ["src/retry.js"],
  acceptance_criteria: ["no double-fire"],
});

test("--file loads an untrusted JSON work order (dry)", async () => {
  const d = mkdtempSync(join(tmpdir(), "orch-file-"));
  const f = join(d, "work-order.json");
  writeFileSync(f, WORK_ORDER);
  const prev = cwd();
  chdir(d);
  try {
    process.exitCode = 0;
    await main(["task", "--file", f, "--dry"]);
    assert.notEqual(process.exitCode, 2);
  } finally {
    chdir(prev);
    process.exitCode = 0;
  }
});

test("--file rejects a stray positional task argument instead of dropping it", async () => {
  const d = mkdtempSync(join(tmpdir(), "orch-file-"));
  const f = join(d, "work-order.json");
  writeFileSync(f, WORK_ORDER); // valid order, so the rejection is about the positional
  await assert.rejects(
    () => main(["task", "stray text", "--file", f, "--dry"]),
    (e) => e.exit === 64 && /--file takes no positional task text/.test(e.message),
  );
});

test("--file rejects non-JSON content", async () => {
  const d = mkdtempSync(join(tmpdir(), "orch-file-"));
  const f = join(d, "task.md");
  writeFileSync(f, "do the thing from a file\n");
  await assert.rejects(() => main(["task", "--file", f, "--dry"]), /JSON work order/);
});

test("--file rejects a JSON object that fails work-order shape", async () => {
  const d = mkdtempSync(join(tmpdir(), "orch-file-"));
  const f = join(d, "bad.json");
  writeFileSync(f, JSON.stringify({ title: "", problem: "x" })); // empty title + missing arrays
  await assert.rejects(() => main(["task", "--file", f, "--dry"]), /work order/i);
});

// #394: a work order that names a protected path is unsatisfiable — the guard
// rejects the diff every round — so intake refuses before any agent runs.
test("task refuses at intake when the text names a protected path", async () => {
  const d = mkdtempSync(join(tmpdir(), "orch-protected-"));
  const prev = cwd();
  chdir(d);
  try {
    await assert.rejects(
      () => main(["task", "remove .github/workflows/version-bump.yml and tidy the docs", "--dry"]),
      /refusing to run: the task names protected path\(s\): \.github\/workflows\/version-bump\.yml/,
    );
  } finally {
    chdir(prev);
  }
});

test("task --file refuses at intake when the work order names a protected path", async () => {
  const d = mkdtempSync(join(tmpdir(), "orch-protected-"));
  const f = join(d, "wo.json");
  writeFileSync(f, JSON.stringify({
    title: "stop the merge-bump automation",
    problem: "Delete `.github/workflows/version-bump.yml` and clean up its tests.",
    repro_steps: [],
    suspected_paths: [".github/workflows/version-bump.yml"],
    acceptance_criteria: ["workflow gone"],
  }));
  const prev = cwd();
  chdir(d);
  try {
    await assert.rejects(
      () => main(["task", "--file", f, "--dry"]),
      /refusing to run.*hand-land/s,
    );
  } finally {
    chdir(prev);
  }
});

test("issue refuses at intake when the issue body names a protected path", async () => {
  const d = mkdtempSync(join(tmpdir(), "orch-protected-"));
  const prev = cwd();
  chdir(d);
  try {
    const gh = (args) => args[0] === "--version" ? "gh 2"
      : JSON.stringify({ number: 394, title: "remove stale workflow", body: "Please delete .github/workflows/version-bump.yml", state: "OPEN" });
    await assert.rejects(
      () => main(["issue", "394", "--dry"], { githubDeps: () => ({ gh }) }),
      /refusing to run: the task names protected path\(s\)/,
    );
  } finally {
    chdir(prev);
  }
});

// #395: the intake scan is literal, so an incidental mention of a protected
// path (package.json is on the list and is named by ordinary work orders)
// would otherwise be an unappealable lockout. --allow-protected is the
// operator's explicit acknowledgement; the merge-time guard still applies.
test("--allow-protected runs past the intake refusal", async () => {
  const d = mkdtempSync(join(tmpdir(), "orch-protected-"));
  const prev = cwd();
  chdir(d);
  try {
    let err = null;
    try {
      await main(["task", "orch reads the version from package.json at startup — the log line is wrong", "--dry", "--allow-protected"]);
    } catch (e) {
      err = e;
    }
    // It may still fail for unrelated reasons in a bare tmpdir; what must NOT
    // survive the override is the intake refusal itself.
    assert.doesNotMatch(String(err?.message || ""), /refusing to run/);
  } finally {
    chdir(prev);
  }
});

test("without the override the same incidental mention still refuses", async () => {
  const d = mkdtempSync(join(tmpdir(), "orch-protected-"));
  const prev = cwd();
  chdir(d);
  try {
    await assert.rejects(
      () => main(["task", "orch reads the version from package.json at startup — the log line is wrong", "--dry"]),
      /refusing to run: the task names protected path\(s\): package\.json/,
    );
  } finally {
    chdir(prev);
  }
});

import { fetchIssueWorkOrder, requireGhAuth } from "../src/cli.js";

test("requireGhAuth fails fast with a clear error when gh is not authenticated", () => {
  const gh = () => { throw new Error("HTTP 401: Bad credentials"); };
  assert.throws(() => requireGhAuth(gh), /gh CLI is not authenticated.*gh auth login.*401/);
});

test("fetchIssueWorkOrder fails fast when gh auth status fails, before shelling out to issue view", () => {
  const gh = (args) => {
    if (args[0] === "--version") return "gh 2";
    if (args[0] === "auth" && args[1] === "status") throw new Error("not logged in");
    throw new Error(`unexpected call: ${args.join(" ")}`);
  };
  assert.throws(() => fetchIssueWorkOrder(9, gh), /gh CLI is not authenticated/);
});

test("fetchIssueWorkOrder maps an open issue to a validated work order", () => {
  const gh = (args) => args[0] === "--version" ? "gh 2"
    : JSON.stringify({ number: 9, title: "Bug", body: "it crashes", state: "OPEN" });
  const wo = fetchIssueWorkOrder(9, gh);
  assert.equal(wo.title, "Bug");
  assert.equal(wo.problem, "it crashes");
  assert.deepEqual(wo.repro_steps, []);
});

test("fetchIssueWorkOrder refuses a non-open issue", () => {
  const gh = (args) => args[0] === "--version" ? "gh 2"
    : JSON.stringify({ number: 9, title: "Bug", body: "x", state: "CLOSED" });
  assert.throws(() => fetchIssueWorkOrder(9, gh), /not open/);
});

test("orch issue <n> routes a fetched issue through the task cycle (dry)", async () => {
  const d = mkdtempSync(join(tmpdir(), "orch-issue-"));
  const prev = cwd();
  chdir(d);
  try {
    process.exitCode = 0;
    const gh = (args) => args[0] === "--version" ? "gh 2"
      : JSON.stringify({ number: 52, title: "stale base", body: "orch bases cycles on local main", state: "OPEN" });
    await main(["issue", "52", "--dry"], { githubDeps: () => ({ gh }) });
    assert.notEqual(process.exitCode, 2);
  } finally {
    chdir(prev);
    process.exitCode = 0;
  }
});

test("orch issue rejects a non-numeric argument", async () => {
  await assert.rejects(
    () => main(["issue", "abc", "--dry"], { githubDeps: () => ({ gh: () => "gh 2" }) }),
    /usage: orch issue/,
  );
});

// --cheap + an explicit --reviewer is ambiguous (which role wins?) and used
// to be rejected deep inside applyCheapOverride — after `issue` had already
// shelled out to `gh issue view` and fetched the issue for a run that was
// always going to be refused. schema.js's validate() now catches this before
// main() does anything, so the fetch must never happen.
test("orch issue --cheap --reviewer is refused before the issue is fetched", async () => {
  await assert.rejects(
    () => main(["issue", "1", "--dry", "--cheap", "--reviewer", "codex"], {
      preflight() {},
      githubDeps: () => ({ gh: () => { throw new Error("gh ran — issue fetched before validation"); } }),
    }),
    (e) => e.exit === 64 && /--cheap cannot be combined with/.test(e.message),
  );
});

// --author + --authors (or --reviewer + --reviewers) together used to pick
// the plural silently and drop the singular, caught only deep inside
// applyRoleOverrides (cli.js) — after `issue` had already fetched the issue.
// This is a flag-only combination, same as --cheap above, so schema.js's
// validate() now catches it before main() does anything.
test("orch issue --author and --authors together is refused before the issue is fetched", async () => {
  await assert.rejects(
    () => main(["issue", "1", "--dry", "--author", "claude", "--authors", "claude,codex", "--reviewer", "codex"], {
      preflight() {},
      githubDeps: () => ({ gh: () => { throw new Error("gh ran — issue fetched before validation"); } }),
    }),
    (e) => e.exit === 64 && /set --author or --authors, not both/.test(e.message),
  );
});

test("orch issue --reviewer and --reviewers together is refused before the issue is fetched", async () => {
  await assert.rejects(
    () => main(["issue", "1", "--dry", "--author", "claude", "--reviewer", "codex", "--reviewers", "codex,claude"], {
      preflight() {},
      githubDeps: () => ({ gh: () => { throw new Error("gh ran — issue fetched before validation"); } }),
    }),
    (e) => e.exit === 64 && /set --reviewer or --reviewers, not both/.test(e.message),
  );
});

// `task` has no positional minimum (--file supplies the text instead), so a
// bare `orch task` used to sail past parsing and reach main()'s update-check
// network call and GitHub App auth mint before the handler itself finally
// noticed there was no task text.
test("a bare 'orch task' is refused before the update check or auth run", async () => {
  await assert.rejects(
    () => main(["task"], {
      preflight() {},
      maybeNotifyUpdate: () => { throw new Error("update check ran before validation"); },
    }),
    (e) => e.exit === 64 && /usage: orch task/.test(e.message),
  );
});

test("orch issue posts a gh issue comment on escalation", async () => {
  const savedExitCode = process.exitCode;
  const repo = initGitRepo();
  const calls = [];
  const gh = (args, input) => {
    if (args[0] === "--version") return "gh 2";
    if (args[0] === "auth" && args[1] === "status") return "Logged in";
    if (args[0] === "issue" && args[1] === "view") {
      return JSON.stringify({ number: 52, title: "stale base", body: "orch bases cycles on local main", state: "OPEN" });
    }
    if (args[0] === "issue" && args[1] === "comment") {
      calls.push({ args, input });
      return "";
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  const escalating = { ...fakeCycleDeps(), finalize: async () => ({ status: "escalated", reason: "stalemate after cap", sha: "x" }) };
  try {
    await runMainInRepo(repo, ["issue", "52"], { cycleDeps: escalating, githubDeps: () => ({ gh }) });
    assert.equal(process.exitCode, 2);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args[2], "52");
    assert.match(calls[0].input, /<!-- orch:result -->/);
    assert.match(calls[0].input, /ESCALATED/);
    assert.match(calls[0].input, /stalemate after cap/);
  } finally {
    process.exitCode = savedExitCode;
  }
});

test("orch issue saves an escalation comment when GitHub rejects both attempts", async () => {
  const savedExitCode = process.exitCode;
  const repo = initGitRepo("orch-issue-comment-fallback-");
  const commentPath = join(repo, ".orch", "issue-52-comment.md");
  let commentAttempts = 0;
  let stderr = "";
  const previousWrite = process.stderr.write;
  process.stderr.write = (chunk) => { stderr += String(chunk); return true; };
  const exec = (_bin, args) => {
    if (args[0] === "--version") return "gh 2";
    if (args[0] === "auth" && args[1] === "status") return "Logged in";
    if (args[0] === "issue" && args[1] === "view") {
      return JSON.stringify({ number: 52, title: "stale base", body: "orch bases cycles on local main", state: "OPEN" });
    }
    if (args[0] === "issue" && args[1] === "comment") {
      commentAttempts++;
      const error = new Error("HTTP 401: Bad credentials");
      error.status = 401;
      throw error;
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  const gh = (args, input) => ghShell(args, input, { exec, sleep() {} });
  const escalating = { ...fakeCycleDeps(), finalize: async () => ({ status: "escalated", reason: "stalemate after cap", sha: "x" }) };
  try {
    await runMainInRepo(repo, ["issue", "52"], { cycleDeps: escalating, githubDeps: () => ({ gh }) });
    assert.equal(commentAttempts, 2);
    assert.ok(existsSync(commentPath));
    assert.match(readFileSync(commentPath, "utf8"), /<!-- orch:result -->[\s\S]*ESCALATED[\s\S]*stalemate after cap/);
    assert.match(stderr, new RegExp(`comment saved to ${commentPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  } finally {
    process.stderr.write = previousWrite;
    process.exitCode = savedExitCode;
  }
});

test("orch task escalation does not touch GitHub (no closes)", async () => {
  const savedExitCode = process.exitCode;
  const repo = initGitRepo();
  const gh = () => { throw new Error("gh should not be called for a plain task"); };
  const escalating = { ...fakeCycleDeps(), finalize: async () => ({ status: "escalated", reason: "stalemate after cap", sha: "x" }) };
  try {
    await runMainInRepo(repo, ["task", "some task"], { cycleDeps: escalating, githubDeps: () => ({ gh }) });
    assert.equal(process.exitCode, 2);
  } finally {
    process.exitCode = savedExitCode;
  }
});

// #136 round 2 (codex review): the ORIGINAL fix only gated on cfg.merge ===
// "pr" / autoMergePr / an issue closes-comment — but finalize.js's
// openIntegrationPr runs on every successful merge in the DEFAULT no-ff/
// ff-only path too, so a plain `orch task` with a broken gh session could
// still reach a late gh failure after a full author→review→test→merge cycle.
// A repo WITH a remote configured must now fail fast before that cycle runs
// at all, regardless of merge mode.
test("#136: orch task with a configured remote fails fast on broken gh auth, before running the cycle", async () => {
  const repo = initGitRepo();
  gitDep.git(["remote", "add", "origin", "https://example.invalid/x/y.git"], repo);
  const gh = (args) => {
    if (args[0] === "--version") return "gh 2";
    if (args[0] === "auth" && args[1] === "status") throw new Error("not logged in");
    throw new Error(`cycle must not run before the auth gate: unexpected gh call ${args.join(" ")}`);
  };
  const cycleRan = { called: false };
  const cycleDeps = { ...fakeCycleDeps(), cycle: async () => { cycleRan.called = true; return { status: "merged" }; } };
  await assert.rejects(
    () => runMainInRepo(repo, ["task", "some task"], { cycleDeps, githubDeps: () => ({ gh, git: gitDep.git }) }),
    /gh CLI is not authenticated/,
  );
  assert.equal(cycleRan.called, false, "the author/review/test/merge cycle must not run when gh auth is broken");
});

// The flip side: no remote configured at all means there's no PR bridge to
// protect (openIntegrationPr's own hasRemote/ghAvailable guard already skips
// itself gracefully in this case) — so a fully local repo isn't forced to
// have a gh session just because it happens to have gh installed.
test("#136: orch task with no remote configured never calls gh, even if gh is installed", async () => {
  const repo = initGitRepo();
  const gh = () => { throw new Error("gh should not be called when no remote is configured"); };
  await runMainInRepo(repo, ["task", "some task", "--no-tidy"], { githubDeps: () => ({ gh, git: gitDep.git }) });
});

// P5 acceptance (docs/cli-v2-implementation-plan.md P5): `--until ready --json`
// waits on the standing integration→base PR after landing and reports the
// outcome as the last stdout line; bare `orch task` (tested above) is untouched.
function readinessGh(prView) {
  return (args) => {
    if (args[0] === "--version") return "gh 2";
    if (args[0] === "auth" && args[1] === "status") return "Logged in";
    if (args[0] === "pr" && args[1] === "list") return JSON.stringify([{ number: 9, url: "https://github.com/o/r/pull/9", isDraft: false, headRefOid: prView.headRefOid }]);
    if (args[0] === "pr" && args[1] === "view") return JSON.stringify(prView);
    if (args[0] === "api") return "[]"; // required checks: known, empty
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
}

test("orch task --until ready --json exits 0 on a green standing PR", async () => {
  const savedExitCode = process.exitCode;
  const repo = initGitRepo();
  gitDep.git(["branch", "orch/integration"], repo);
  addOriginWithPeer(repo);
  const head = gitDep.git(["rev-parse", "orch/integration"], repo);
  const gh = readinessGh({
    number: 9, state: "OPEN", isDraft: false, headRefOid: head, baseRefName: "main",
    mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: null, statusCheckRollup: [],
  });
  try {
    const logs = await runMainInRepo(repo, ["task", "some task", "--no-tidy", "--until", "ready", "--json"], { githubDeps: () => ({ gh, git: gitDep.git }) });
    const last = JSON.parse(logs[logs.length - 1]);
    assert.equal(last.event, "run.end");
    assert.equal(last.exit, 0);
    assert.equal(last.outcome, "reached");
    assert.equal(process.exitCode || 0, 0);
  } finally {
    process.exitCode = savedExitCode;
  }
});

test("mergeForRun forwards cfg, GitHub deps, and the run identity to the landing phase", async () => {
  const repo = initGitRepo("orch-merge-for-run-");
  gitDep.git(["branch", "orch/integration"], repo);
  addOriginWithPeer(repo);
  gitDep.git(["push", "-u", "origin", "orch/integration"], repo);
  const head = gitDep.git(["rev-parse", "orch/integration"], repo);
  const run = { sid: "merge-for-run", repo, orchDir: join(repo, ".orch") };
  const cfg = { baseBranch: "main", integrationBranch: "orch/integration", test: "true" };
  const events = [];
  const calls = [];
  let merged = false;
  const gh = (args) => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "view") return JSON.stringify({
      number: 9, state: merged ? "MERGED" : "OPEN", isDraft: false, headRefOid: head,
      baseRefName: "main", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
      reviewDecision: null, statusCheckRollup: [],
      ...(merged ? { mergeCommit: { oid: head } } : {}),
    });
    if (args[0] === "api" && String(args[1]).includes("/rules/")) return "[]";
    if (args[0] === "api" && args.some((arg) => String(arg).includes("/pulls/9/merge"))) {
      merged = true;
      return JSON.stringify({ sha: head });
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };

  const result = await mergeForRun({
    record: {},
    land: { pr: { number: 9 }, expectedHead: head, landing: "standing" },
    readiness: { headSha: head, required: { known: true, contexts: [] } },
  }, run, cfg, { gh, log() {} }, (event) => events.push(event));

  assert.equal(result.result, "merged");
  assert.deepEqual(events, [{ event: "merge.request", runId: run.sid, pr: 9, head, method: "merge" }]);
  assert.equal(calls.filter((args) => args.some((arg) => String(arg).includes("/pulls/9/merge"))).length, 1);
});

test("orch task --until ready --json exits 2 with failureClass REMOTE_BEHIND on a BEHIND standing PR", async () => {
  const savedExitCode = process.exitCode;
  const repo = initGitRepo();
  gitDep.git(["branch", "orch/integration"], repo);
  addOriginWithPeer(repo);
  const head = gitDep.git(["rev-parse", "orch/integration"], repo);
  const gh = readinessGh({
    number: 9, state: "OPEN", isDraft: false, headRefOid: head, baseRefName: "main",
    mergeable: "MERGEABLE", mergeStateStatus: "BEHIND", reviewDecision: null, statusCheckRollup: [],
  });
  try {
    const logs = await runMainInRepo(repo, ["task", "some task", "--no-tidy", "--until", "ready", "--json"], { githubDeps: () => ({ gh, git: gitDep.git }) });
    const last = JSON.parse(logs[logs.length - 1]);
    assert.equal(last.event, "run.end");
    assert.equal(last.exit, 2);
    assert.equal(last.failureClass, "REMOTE_BEHIND");
    assert.equal(process.exitCode, 2);
  } finally {
    process.exitCode = savedExitCode;
  }
});

// P6 split 4/4 acceptance (docs/cli-v2-design.md §10A, closes #551): a standing
// PR reported BEHIND is no longer a terminal failure — `integration-repair` is
// registered in cli.js's `remedies` map, so the run repairs the branch and
// reaches READY. Before registration the lookup in run-controller.js missed,
// the `typeof executor !== "function"` guard fired, and this exited 2.
test("orch task --until ready --json exits 0 after one integration repair of a BEHIND standing PR", async () => {
  const savedExitCode = process.exitCode;
  const repo = initGitRepo();
  gitDep.git(["branch", "orch/integration"], repo);
  addOriginWithPeer(repo);
  gitDep.git(["push", "-u", "origin", "orch/integration"], repo);
  const head = gitDep.git(["rev-parse", "orch/integration"], repo);
  // The fixture models only what the criterion is about: GitHub reports BEHIND
  // until `update-branch` runs, then CLEAN. The head stays pinned — readiness
  // rule 2's head-move handling is a separate concern with its own tests.
  let repaired = false;
  const ghCalls = [];
  const gh = (args) => {
    ghCalls.push(args.join(" "));
    if (args[0] === "--version") return "gh 2";
    if (args[0] === "auth" && args[1] === "status") return "Logged in";
    if (args[0] === "pr" && args[1] === "list") return JSON.stringify([{ number: 9, url: "https://github.com/o/r/pull/9", isDraft: false, headRefOid: head }]);
    if (args[0] === "pr" && args[1] === "view") {
      return JSON.stringify({
        number: 9, state: "OPEN", isDraft: false, headRefOid: head, baseRefName: "main",
        mergeable: "MERGEABLE", mergeStateStatus: repaired ? "CLEAN" : "BEHIND",
        reviewDecision: null, statusCheckRollup: [],
      });
    }
    if (args[0] === "api" && args.some((a) => a.endsWith("/update-branch"))) { repaired = true; return "{}"; }
    if (args[0] === "api") return "[]"; // required checks: known, empty
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  try {
    const logs = await runMainInRepo(repo, ["task", "some task", "--no-tidy", "--until", "ready", "--json"], { githubDeps: () => ({ gh, git: gitDep.git }) });
    const last = JSON.parse(logs[logs.length - 1]);
    assert.equal(last.event, "run.end");
    assert.equal(last.exit, 0);
    assert.equal(last.outcome, "reached");
    assert.equal(process.exitCode || 0, 0);
    assert.equal(ghCalls.filter((c) => c.includes("update-branch")).length, 1, "exactly one repair");
  } finally {
    process.exitCode = savedExitCode;
  }
});

test("orch task wires the rebase remedy with the active run context", async () => {
  const savedExitCode = process.exitCode;
  const repo = initGitRepo("orch-rebase-wiring-");
  gitDep.git(["branch", "orch/integration"], repo);
  const integrationHead = gitDep.git(["rev-parse", "orch/integration"], repo);
  const gh = readinessGh({
    number: 9, state: "OPEN", isDraft: false, headRefOid: integrationHead, baseRefName: "main",
    mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: null, statusCheckRollup: [],
  });
  let gateRuns = 0;
  const authorCalls = [];
  const cycleDeps = {
    ...fakeCycleDeps(),
    adapters: {
      get: (name) => ({
        name,
        async author(_prompt, worktree) {
          const file = authorCalls.length === 0 ? "feature.txt" : "repair.txt";
          authorCalls.push(name);
          writeFileSync(join(worktree, file), `${file}\n`);
          gitDep.git(["add", file], worktree);
          gitDep.git(["commit", "-m", `author ${file}`], worktree);
          return { usage: {} };
        },
        async audit() { return { decision: "AGREE", reason: "ok", raw: "", usage: {} }; },
      }),
    },
    gate: {
      detect: () => "true",
      run: () => ({ pass: ++gateRuns > 1, log: "" }),
    },
  };
  try {
    await runMainInRepo(repo, ["task", "rebase wiring", "--until", "ready", "--no-tidy"], {
      cycleDeps,
      githubDeps: () => ({ gh, git: gitDep.git }),
      sleep: async () => {},
    });
    assert.equal(gateRuns, 2, "the rebase remedy must run a fresh gated cycle");
    assert.equal(authorCalls.length, 2, "the wired remedy must reach its repair author");
  } finally {
    process.exitCode = savedExitCode;
  }
});

test("orch continue re-runs a fresh cycle for a free retry", async () => {
  const savedExitCode = process.exitCode;
  const repo = initGitRepo("orch-continue-fresh-cycle-");
  const sid = "freshcycle";
  const branch = `pr/claude/some-fix-${sid}`;
  gitDep.git(["checkout", "-b", branch], repo);
  writeFileSync(join(repo, "a.txt"), "2\n");
  gitDep.git(["commit", "-am", "authored fix"], repo);
  gitDep.git(["checkout", "main"], repo);
  gitDep.git(["branch", "orch/integration"], repo);

  const orchDir = join(repo, ".orch");
  checkpointDep.record(orchDir, sid, {
    branch, round: 1, stage: "reviewed", decision: "AGREE", reason: "looks good",
    author: { agent: "claude" }, reviewers: [{ agent: "codex" }],
  });
  runRecordDep.create(orchDir, {
    runId: sid, command: "task", argv: [], policy: { until: "ready", maxAttempts: 3 },
  });

  let finalizeCalls = 0;
  const cycleDeps = {
    ...fakeCycleDeps(),
    finalize: async () => ++finalizeCalls === 1
      ? { status: "escalated", class: "REMOTE_AUTH", fingerprint: "auth-fp", reason: "temporary auth failure" }
      : { status: "merged", reason: "fixed", sha: "abc" },
  };
  const head = gitDep.git(["rev-parse", "orch/integration"], repo);
  const gh = readinessGh({
    number: 9, state: "OPEN", isDraft: false, headRefOid: head, baseRefName: "main",
    mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: null, statusCheckRollup: [],
  });
  try {
    await runMainInRepo(repo, ["continue", sid, "--no-tidy"], {
      cycleDeps,
      githubDeps: () => ({ gh, git: gitDep.git }),
      sleep: async () => {},
    });
    assert.equal(finalizeCalls, 2, "a free retry must invoke the fresh cycle callback");
    assert.equal(process.exitCode || 0, 0);
  } finally {
    process.exitCode = savedExitCode;
  }
});

test("orch continue wires the rebase remedy", async () => {
  const savedExitCode = process.exitCode;
  const repo = initGitRepo("orch-continue-rebase-wiring-");
  const sid = "contrebase";
  const branch = `pr/claude/some-fix-${sid}`;
  gitDep.git(["checkout", "-b", branch], repo);
  writeFileSync(join(repo, "a.txt"), "2\n");
  gitDep.git(["commit", "-am", "authored fix"], repo);
  gitDep.git(["checkout", "main"], repo);
  gitDep.git(["branch", "orch/integration"], repo);

  const orchDir = join(repo, ".orch");
  checkpointDep.record(orchDir, sid, {
    branch, round: 1, stage: "reviewed", decision: "AGREE", reason: "looks good",
    author: { agent: "claude" }, reviewers: [{ agent: "codex" }],
  });
  runRecordDep.create(orchDir, {
    runId: sid, command: "task", argv: [], policy: { until: "ready", maxAttempts: 3 },
  });

  let finalizeCalls = 0;
  let repairAuthorCalls = 0;
  const cycleDeps = {
    ...fakeCycleDeps(),
    adapters: {
      get: (name) => ({
        name,
        async author(_prompt, worktree) {
          repairAuthorCalls += 1;
          writeFileSync(join(worktree, "repair.txt"), "repaired\n");
          gitDep.git(["add", "repair.txt"], worktree);
          gitDep.git(["commit", "-m", "repair rebase"], worktree);
          return { usage: {} };
        },
        async audit() { return { decision: "AGREE", reason: "ok", raw: "", usage: {} }; },
      }),
    },
    finalize: async () => ++finalizeCalls === 1
      ? { status: "escalated", class: "TEST_RED", fingerprint: "red-fp", reason: "tests are red" }
      : { status: "merged", reason: "fixed", sha: "abc" },
  };
  const head = gitDep.git(["rev-parse", "orch/integration"], repo);
  const gh = readinessGh({
    number: 9, state: "OPEN", isDraft: false, headRefOid: head, baseRefName: "main",
    mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: null, statusCheckRollup: [],
  });
  try {
    await runMainInRepo(repo, ["continue", sid, "--no-tidy"], {
      cycleDeps,
      githubDeps: () => ({ gh, git: gitDep.git }),
      sleep: async () => {},
    });
    assert.equal(finalizeCalls, 2, "the rebase remedy must run a fresh cycle");
    assert.equal(repairAuthorCalls, 1, "continue must register and execute rebase");
  } finally {
    process.exitCode = savedExitCode;
  }
});

test("orch continue wires the rotate remedy", async () => {
  const savedExitCode = process.exitCode;
  const repo = initGitRepo("orch-continue-rotate-wiring-");
  const sid = "controrotate";
  const branch = `pr/claude/some-fix-${sid}`;
  gitDep.git(["checkout", "-b", branch], repo);
  writeFileSync(join(repo, "a.txt"), "2\n");
  gitDep.git(["commit", "-am", "authored fix"], repo);
  gitDep.git(["checkout", "main"], repo);
  gitDep.git(["branch", "orch/integration"], repo);

  const orchDir = join(repo, ".orch");
  mkdirSync(orchDir, { recursive: true });
  writeFileSync(join(orchDir, "orch.yml"), "agents: [claude, codex, gemini]\n");
  checkpointDep.record(orchDir, sid, {
    branch, round: 1, stage: "reviewed", decision: "AGREE", reason: "looks good",
    author: { agent: "claude" }, reviewers: [{ agent: "codex" }],
  });
  runRecordDep.create(orchDir, {
    runId: sid, command: "task", argv: [], policy: { until: "ready", maxAttempts: 3 },
  });

  const audits = [];
  const cycleDeps = {
    ...fakeCycleDeps(),
    adapters: {
      get: (name) => ({
        name,
        async author() { return { usage: {} }; },
        async audit() {
          audits.push(name);
          return name === "codex"
            ? { decision: "DISAGREE", reason: "quota", raw: "", agentError: true, quota: true }
            : { decision: "AGREE", reason: "ok", raw: "", usage: {} };
        },
      }),
    },
  };
  const head = gitDep.git(["rev-parse", "orch/integration"], repo);
  const gh = readinessGh({
    number: 9, state: "OPEN", isDraft: false, headRefOid: head, baseRefName: "main",
    mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: null, statusCheckRollup: [],
  });
  try {
    await runMainInRepo(repo, ["continue", sid, "--no-tidy"], {
      cycleDeps,
      githubDeps: () => ({ gh, git: gitDep.git }),
      sleep: async () => {},
    });
    assert.deepEqual(audits, ["codex", "gemini"], "rotate must re-seat the failed reviewer and run a fresh cycle");
  } finally {
    process.exitCode = savedExitCode;
  }
});

test("orch task --until ready reauthors a classified failure on a fresh branch", async () => {
  const savedExitCode = process.exitCode;
  const repo = initGitRepo("orch-reauthor-wiring-");
  gitDep.git(["branch", "orch/integration"], repo);
  const head = gitDep.git(["rev-parse", "orch/integration"], repo);
  const gh = readinessGh({
    number: 9, state: "OPEN", isDraft: false, headRefOid: head, baseRefName: "main",
    mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: null, statusCheckRollup: [],
  });
  let cycles = 0;
  try {
    await runMainInRepo(repo, ["task", "reauthor wiring", "--until", "ready", "--no-tidy"], {
      cycleDeps: {
        ...fakeCycleDeps(),
        finalize: async () => ++cycles === 1
          ? { status: "escalated", class: "SCOPE_EXCEEDED", fingerprint: "scope-fp", reason: "scope exceeded" }
          : { status: "merged", reason: "fixed", sha: "abc" },
      },
      githubDeps: () => ({ gh, git: gitDep.git }),
      sleep: async () => {},
    });
    assert.equal(cycles, 2);
    const dir = join(repo, ".orch", "run-records");
    const record = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]), "utf8"));
    assert.equal(record.cycles.length, 2);
    assert.notEqual(record.cycles[0].branch, record.cycles[1].branch);
    assert.equal(record.outcome, "reached");
  } finally {
    process.exitCode = savedExitCode;
  }
});

test("orch continue registers a fresh reauthor cycle as authoring", async () => {
  const savedExitCode = process.exitCode;
  const repo = initGitRepo("orch-continue-reauthor-stage-");
  const sid = "contre-author-stage";
  const branch = `pr/claude/reauthor-stage-${sid}`;
  gitDep.git(["checkout", "-b", branch], repo);
  writeFileSync(join(repo, "a.txt"), "2\n");
  gitDep.git(["commit", "-am", "authored fix"], repo);
  gitDep.git(["checkout", "main"], repo);
  gitDep.git(["branch", "orch/integration"], repo);

  const orchDir = join(repo, ".orch");
  const workOrder = { title: "reauthor stage", problem: "repair it", repro_steps: [], suspected_paths: [], acceptance_criteria: [] };
  checkpointDep.record(orchDir, sid, {
    branch, round: 1, stage: "reviewed", decision: "AGREE", reason: "looks good",
    author: { agent: "claude" }, reviewers: [{ agent: "codex" }], task: "reauthor stage",
    authorPrompt: "reauthor stage", workOrder,
  });
  inflight.register(orchDir, sid, {
    branch, pid: 999999999, baseSha: gitDep.git(["rev-parse", "main"], repo),
    author: { agent: "claude" }, reviewers: [{ agent: "codex" }], rotationStage: "authored",
  });
  runRecordDep.create(orchDir, {
    runId: sid, command: "task", argv: [], policy: { until: "ready", maxAttempts: 3 },
  });

  let seen = null;
  let finalizeCalls = 0;
  const cycleDeps = {
    ...fakeCycleDeps(),
    checkpoint: checkpointDep,
    adapters: {
      get: (name) => ({
        name,
        async author(_prompt, worktree) {
          const [file] = readdirSync(join(orchDir, "inflight"));
          seen = JSON.parse(readFileSync(join(orchDir, "inflight", file), "utf8"));
          writeFileSync(join(worktree, "reauthor.txt"), "reauthor\n");
          gitDep.git(["add", "reauthor.txt"], worktree);
          gitDep.git(["commit", "-m", "reauthor fix"], worktree);
          return { usage: {} };
        },
        async audit() { return { decision: "AGREE", reason: "ok", raw: "", usage: {} }; },
      }),
    },
    finalize: async () => ++finalizeCalls === 1
      ? { status: "escalated", class: "SCOPE_EXCEEDED", fingerprint: "scope-fp", reason: "scope exceeded" }
      : { status: "merged", reason: "fixed", sha: "abc" },
  };
  const head = gitDep.git(["rev-parse", "orch/integration"], repo);
  const gh = readinessGh({
    number: 9, state: "OPEN", isDraft: false, headRefOid: head, baseRefName: "main",
    mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: null, statusCheckRollup: [],
  });
  try {
    await runMainInRepo(repo, ["continue", sid, "--no-tidy"], {
      cycleDeps,
      githubDeps: () => ({ gh, git: gitDep.git }),
      sleep: async () => {},
    });
    assert.equal(finalizeCalls, 2);
    assert.equal(seen.rotationStage, "started", "a fresh reauthor must be recoverable as an authoring cycle");
  } finally {
    process.exitCode = savedExitCode;
  }
});

test("orch task --until ready keeps the ask window open for a late retry", async () => {
  const savedExitCode = process.exitCode;
  const repo = initGitRepo("orch-ask-timeout-");
  mkdirSync(join(repo, ".orch"), { recursive: true });
  writeFileSync(join(repo, ".orch", "orch.yml"), "automation:\n  humanWaitHours: 0.000001\n");
  gitDep.git(["branch", "orch/integration"], repo);
  const calls = [];
  let now = 0;
  const questionBodies = [];
  let cycleCalls = 0;
  const gh = (args, input) => {
    calls.push({ args, input });
    if (args[0] === "pr" && args[1] === "list") {
      return args.includes("orch/integration")
        ? JSON.stringify([{ number: 9, url: "https://github.com/o/r/pull/9", isDraft: false, headRefOid: gitDep.git(["rev-parse", "orch/integration"], repo) }])
        : "[]";
    }
    if (args[0] === "pr" && args[1] === "create") return "https://github.com/o/r/pull/12\n";
    if (args[0] === "pr" && args[1] === "view") return JSON.stringify({
      number: 9, state: cycleCalls >= 3 ? "OPEN" : "CLOSED", isDraft: false, headRefOid: gitDep.git(["rev-parse", "orch/integration"], repo),
      baseRefName: "main", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
      reviewDecision: null, statusCheckRollup: [],
    });
    if (args[0] === "api" && args.includes("-X") && args.includes("POST")) {
      if (String(input || "").includes("orch needs a decision")) questionBodies.push(String(input));
      return JSON.stringify({ id: 20 });
    }
    if (args[0] === "api" && args[1]?.includes("comments") && args.includes("--paginate")) {
      return cycleCalls >= 2 ? JSON.stringify([{ id: 21, body: "orch: retry", created_at: "1970-01-01T00:00:01.000Z", user: { login: "maintainer", type: "User" } }]) : "[]";
    }
    if (args[0] === "api" && args[1]?.includes("collaborators")) return JSON.stringify({ permission: "write" });
    if (args[0] === "api") return "[]";
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  const cycleDeps = {
    ...fakeCycleDeps(),
    adapters: {
      get: (name) => ({
        name,
        async author(_prompt, worktree) {
          writeFileSync(join(worktree, "a.txt"), "2\n");
          gitDep.git(["add", "a.txt"], worktree);
          gitDep.git(["commit", "-m", "test change"], worktree);
          return { usage: { model: "gpt-test-author", tokens: 40 } };
        },
        async audit() { return { decision: "AGREE", reason: "ok", raw: "", usage: {} }; },
      }),
    },
    finalize: async () => ++cycleCalls === 1
      ? { status: "escalated", class: "TEST_MISSING", fingerprint: "test-missing", reason: "no test" }
      : cycleCalls === 2
        ? { status: "escalated", class: "TEST_MISSING", fingerprint: "test-missing", reason: "no test" }
        : { status: "merged", reason: "test", sha: "abc" },
  };
  try {
    const logs = await runMainInRepo(repo, ["task", "ask timeout", "--until", "ready", "--no-tidy", "--json"], {
      cycleDeps: { ...cycleDeps, checkpoint: checkpointDep },
      githubDeps: () => ({ gh, git: gitDep.git }),
      now: () => now,
      sleep: async () => { now = 10_000; },
    });
    const end = JSON.parse(logs[logs.length - 1]);
    assert.equal(end.exit, 4, logs.join("\n"));
    assert.equal(end.outcome, "wait-timeout");
    assert.match(end.resumeCommand, /orch continue /);
    assert.ok(calls.some(({ input }) => String(input || "").includes("orch:")));
    assert.ok(calls.some(({ input }) => String(input || "").includes("late reply will still be checked")));
    const dir = join(repo, ".orch", "run-records");
    const record = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]), "utf8"));
    assert.equal(record.outcome, "wait-timeout");
    assert.equal(record.state, "WAIT_TIMEOUT");
    assert.equal(record.exit, 4);
    assert.equal(record.human.askCommentId, 20);

    process.exitCode = 0;
    const resumeLogs = await runMainInRepo(repo, ["task", "ask timeout", "--until", "ready", "--no-tidy", "--json"], {
      cycleDeps,
      githubDeps: () => ({ gh, git: gitDep.git }),
      now: () => now,
      sleep: async () => { now += 10_000; },
    });
    const resumeEvents = resumeLogs.map((line) => JSON.parse(line));
    assert.deepEqual(resumeEvents.map((event) => event.event), ["run.start", "run.end"]);
    assert.equal(resumeEvents[1].outcome, "reached");
    assert.equal(resumeEvents[1].exit, 0);
    assert.equal(cycleCalls, 3, "the late retry must start a fresh cycle");
    assert.equal(questionBodies.length, 1, "same-task retry must keep the original question");
    const resumed = JSON.parse(readFileSync(join(dir, `${record.runId}.json`), "utf8"));
    assert.equal(resumed.outcome, "reached");
    assert.equal(resumed.state, "READY");
    assert.equal(resumed.exit, 0);
    assert.equal(resumed.human.askCommentId, 20, "same-task retry must preserve the original question ID");
    assert.ok(new Date(resumed.human.deadline) > new Date(record.human.deadline), "same-task retry must renew an expired ask window");
    assert.equal(process.exitCode, 0, "same-task retry must apply the retry's reached exit code");
  } finally {
    process.exitCode = savedExitCode;
  }
});

test("orch task --until ready lets a write-permissioned user abandon the run", async () => {
  const savedExitCode = process.exitCode;
  const repo = initGitRepo("orch-ask-abandon-");
  gitDep.git(["branch", "orch/integration"], repo);
  const gh = (args) => {
    if (args[0] === "pr" && args[1] === "list") return JSON.stringify([{ number: 9, url: "https://github.com/o/r/pull/9", isDraft: false }]);
    if (args[0] === "pr" && args[1] === "view") return JSON.stringify({
      number: 9, state: "CLOSED", isDraft: false, headRefOid: gitDep.git(["rev-parse", "orch/integration"], repo),
      baseRefName: "main", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
      reviewDecision: null, statusCheckRollup: [],
    });
    if (args[0] === "api" && args.includes("-X") && args.includes("POST")) return JSON.stringify({ id: 20 });
    if (args[0] === "api" && args[1]?.includes("comments") && args.includes("--paginate")) {
      return JSON.stringify([{ id: 21, body: "orch: abandon", user: { login: "maintainer", type: "User" } }]);
    }
    if (args[0] === "api" && args[1]?.includes("collaborators")) return JSON.stringify({ permission: "write" });
    if (args[0] === "api") return "[]";
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  try {
    const logs = await runMainInRepo(repo, ["task", "ask abandon", "--until", "ready", "--no-tidy", "--json"], {
      cycleDeps: { ...fakeCycleDeps(), finalize: async () => ({ status: "merged", reason: "test", sha: "abc" }) },
      githubDeps: () => ({ gh, git: gitDep.git }),
    });
    const end = JSON.parse(logs[logs.length - 1]);
    assert.equal(end.outcome, "blocked");
    assert.equal(end.exit, 3);
    assert.equal(end.blockedReason, "human-abandon");
    const dir = join(repo, ".orch", "run-records");
    const record = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]), "utf8"));
    assert.equal(record.state, "BLOCKED");
    assert.equal(record.outcome, "blocked");
    assert.equal(record.exit, 3);
    assert.equal(process.exitCode, 3);
  } finally {
    process.exitCode = savedExitCode;
  }
});

test("orch task --until ready re-runs a non-landed free retry cycle", async () => {
  const savedExitCode = process.exitCode;
  const repo = initGitRepo();
  gitDep.git(["branch", "orch/integration"], repo);
  addOriginWithPeer(repo);
  const head = gitDep.git(["rev-parse", "orch/integration"], repo);
  const gh = readinessGh({
    number: 9, state: "OPEN", isDraft: false, headRefOid: head, baseRefName: "main",
    mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: null, statusCheckRollup: [],
  });
  let cycles = 0;
  const cycleDeps = {
    ...fakeCycleDeps(),
    finalize: async () => ++cycles === 1
      ? { status: "merge-deferred", class: "LAND_SYNC", fingerprint: "same-failure", reason: "transient sync" }
      : { status: "merged", reason: "test", sha: "abc" },
  };
  try {
    const logs = await runMainInRepo(repo, ["task", "some task", "--no-tidy", "--until", "ready", "--json"], {
      cycleDeps,
      githubDeps: () => ({ gh, git: gitDep.git }),
      sleep: async () => {},
    });
    const last = JSON.parse(logs[logs.length - 1]);
    assert.equal(cycles, 2);
    assert.equal(last.event, "run.end");
    assert.equal(last.exit, 0);
    assert.equal(last.outcome, "reached");
    assert.equal(last.usage.tokens, 80, "run.end usage includes both cycle runs");
    const recordPath = join(repo, ".orch", "run-records", readdirSync(join(repo, ".orch", "run-records"))[0]);
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    assert.deepEqual(record.cycles.map((cycle) => cycle.status), ["merge-deferred", "merged"]);
    assert.equal(checkpointDep.lookup(join(repo, ".orch"), record.runId), null, "retry checkpoints are cleared after the controller finishes");
    assert.equal(process.exitCode || 0, 0);
  } finally {
    process.exitCode = savedExitCode;
  }
});

// findPrByHead's `gh pr list` throws on any nonzero exit (no GitHub remote,
// bad auth, network hiccup) — the human channel cannot be established, so the
// ask remedy must fail closed as BLOCKED/exit 3 with a full --json stream.
test("orch task --until ready --json exits 3 when the ask channel cannot be created", async () => {
  const savedExitCode = process.exitCode;
  const repo = initGitRepo();
  gitDep.git(["branch", "orch/integration"], repo);
  addOriginWithPeer(repo);
  const gh = (args) => {
    if (args[0] === "--version") return "gh 2";
    if (args[0] === "auth" && args[1] === "status") return "Logged in";
    if (args[0] === "pr" && args[1] === "list") throw new Error("gh: could not find any pull requests");
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  try {
    const logs = await runMainInRepo(repo, ["task", "some task", "--no-tidy", "--until", "ready", "--json"], { githubDeps: () => ({ gh, git: gitDep.git }), sleep: async () => {} });
    for (const line of logs) assert.doesNotThrow(() => JSON.parse(line), `non-JSON stdout line under --json: ${line}`);
    const last = JSON.parse(logs[logs.length - 1]);
    assert.equal(last.event, "run.end");
    assert.equal(last.exit, 3);
    assert.equal(last.failureClass, "REMOTE_UNKNOWN");
    assert.equal(last.blockedReason, "no-channel");
    assert.equal(process.exitCode, 3);
  } finally {
    process.exitCode = savedExitCode;
  }
});

// readiness.js's `prView` (`gh pr view`) throws on any nonzero exit the same
// way `findPrByHead`'s `gh pr list` does above — a revoked token or network
// hiccup mid-poll must spend its free retry, then resolve to REMOTE_AUTH/exit 3 with a full --json
// stream, not an uncaught throw that skips run-controller's own error
// handling and truncates the stream after run.start.
test("orch task --until ready --json exits 3 with failureClass REMOTE_AUTH when gh pr view throws 401", async () => {
  const savedExitCode = process.exitCode;
  const repo = initGitRepo();
  gitDep.git(["branch", "orch/integration"], repo);
  addOriginWithPeer(repo);
  const gh = (args) => {
    if (args[0] === "--version") return "gh 2";
    if (args[0] === "auth" && args[1] === "status") return "Logged in";
    if (args[0] === "pr" && args[1] === "list") return JSON.stringify([{ number: 9, url: "https://github.com/o/r/pull/9", isDraft: false, headRefOid: gitDep.git(["rev-parse", "orch/integration"], repo) }]);
    if (args[0] === "pr" && args[1] === "view") throw new Error("gh: Bad credentials (HTTP 401)");
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  try {
    const logs = await runMainInRepo(repo, ["task", "some task", "--no-tidy", "--until", "ready", "--json"], { githubDeps: () => ({ gh, git: gitDep.git }), sleep: async () => {} });
    for (const line of logs) assert.doesNotThrow(() => JSON.parse(line), `non-JSON stdout line under --json: ${line}`);
    const last = JSON.parse(logs[logs.length - 1]);
    assert.equal(last.event, "run.end");
    assert.equal(last.exit, 3);
    assert.equal(last.failureClass, "REMOTE_AUTH");
    assert.equal(process.exitCode, 3);
    const recordPath = join(repo, ".orch", "run-records", readdirSync(join(repo, ".orch", "run-records"))[0]);
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    assert.equal(record.retries.REMOTE_AUTH, 1);
    assert.equal(record.attempt, 0);
  } finally {
    process.exitCode = savedExitCode;
  }
});

// Re-review finding 1: an uncaught throw anywhere between run.start and the
// run.end emit (not just the two gh call sites already fail-closed above)
// used to skip straight to bin/orch.js's outer catch, truncating the --json
// stream after run.start — a caller doing `... --json | tail -1 | jq .exit`
// would parse run.start instead of getting a clean error signal. Force a
// throw the loop doesn't already guard (the cycle itself failing) to prove
// the catch block now closes the stream out with a run.end before rethrowing.
test("orch task --until ready --json: an uncaught cycle failure still emits run.end (exit 1) before rethrowing", async () => {
  const repo = initGitRepo();
  gitDep.git(["branch", "orch/integration"], repo);
  addOriginWithPeer(repo);
  const head = gitDep.git(["rev-parse", "orch/integration"], repo);
  const gh = readinessGh({
    number: 9, state: "OPEN", isDraft: false, headRefOid: head, baseRefName: "main",
    mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: null, statusCheckRollup: [],
  });
  const prev = cwd();
  chdir(repo);
  const logs = [];
  const origLog = console.log;
  console.log = (...args) => logs.push(args.map(String).join(" "));
  try {
    await assert.rejects(
      () => main(["task", "some task", "--no-tidy", "--until", "ready", "--json"], {
        preflight() {},
        cycleDeps: { ...fakeCycleDeps(), finalize: async () => { throw new Error("cycle boom"); } },
        githubDeps: () => ({ gh, git: gitDep.git }),
      }),
      /cycle boom/,
    );
  } finally {
    console.log = origLog;
    chdir(prev);
  }
  for (const line of logs) assert.doesNotThrow(() => JSON.parse(line), `non-JSON stdout line under --json: ${line}`);
  const events = logs.map((l) => JSON.parse(l));
  assert.equal(events[0].event, "run.start");
  const end = events.find((e) => e.event === "run.end");
  assert.ok(end, "run.end must still be emitted when the cycle throws");
  assert.equal(end.outcome, "error");
  assert.equal(end.exit, 1);
});

// design §3: `run.start` declares `policy` mandatory, `run.end` declares
// `usage` mandatory — both were silently omitted before this fix.
test("orch task --until ready --json: run.start carries policy, run.end carries usage (design §3)", async () => {
  const savedExitCode = process.exitCode;
  const repo = initGitRepo();
  gitDep.git(["branch", "orch/integration"], repo);
  addOriginWithPeer(repo);
  const head = gitDep.git(["rev-parse", "orch/integration"], repo);
  const gh = readinessGh({
    number: 9, state: "OPEN", isDraft: false, headRefOid: head, baseRefName: "main",
    mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: null, statusCheckRollup: [],
  });
  try {
    const logs = await runMainInRepo(repo, ["task", "some task", "--no-tidy", "--until", "ready", "--json"], { githubDeps: () => ({ gh, git: gitDep.git }) });
    const events = logs.map((l) => JSON.parse(l));
    const start = events.find((e) => e.event === "run.start");
    const end = events.find((e) => e.event === "run.end");
    assert.equal(start.policy?.until, "ready");
    assert.ok(end.usage && typeof end.usage === "object");
  } finally {
    process.exitCode = savedExitCode;
  }
});

// Without --no-tidy, a real merge also runs finishRun's tidy-up afterward
// (see "#44: a merged task run hands cycle branches to finishRun for
// tidy-up" above) — under --json that print must not land after run.end and
// break "the last line is the JSON outcome" (design §13, acceptance criterion
// is literally `... --json | tail -1 | jq .exit`).
test("orch task --until ready --json: run.end stays the last line even when post-merge tidy also runs", async () => {
  const savedExitCode = process.exitCode;
  const repo = initGitRepo();
  gitDep.git(["branch", "orch/integration"], repo);
  addOriginWithPeer(repo);
  const head = gitDep.git(["rev-parse", "orch/integration"], repo);
  const gh = readinessGh({
    number: 9, state: "OPEN", isDraft: false, headRefOid: head, baseRefName: "main",
    mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: null, statusCheckRollup: [],
  });
  try {
    const logs = await runMainInRepo(repo, ["task", "some task", "--until", "ready", "--json"], { githubDeps: () => ({ gh, git: gitDep.git }) });
    assert.ok(logs.length >= 2, "expected at least run.start and run.end");
    for (const line of logs) assert.doesNotThrow(() => JSON.parse(line), `non-JSON stdout line under --json: ${line}`);
    const last = JSON.parse(logs[logs.length - 1]);
    assert.equal(last.event, "run.end");
    assert.equal(last.exit, 0);
  } finally {
    process.exitCode = savedExitCode;
  }
});

// design §13: stdout under --json is one JSON object per line, nothing else.
// The local-main fast-forward notice (`git.syncMainFromOrigin`) used to print
// unconditionally, which would have broken `... --json | tail -1 | jq .exit`
// on any run that happened to fast-forward — force that path with a peer push.
test("orch task --until ready --json: the local-main fast-forward notice stays out of the JSON stream", async () => {
  const savedExitCode = process.exitCode;
  const repo = initGitRepo();
  gitDep.git(["branch", "orch/integration"], repo);
  const { peer } = addOriginWithPeer(repo);
  writeFileSync(join(peer, "b.txt"), "1\n");
  gitDep.git(["add", "."], peer);
  gitDep.git(["commit", "-m", "peer commit"], peer);
  gitDep.git(["push", "origin", "main"], peer);
  const head = gitDep.git(["rev-parse", "orch/integration"], repo);
  const gh = readinessGh({
    number: 9, state: "OPEN", isDraft: false, headRefOid: head, baseRefName: "main",
    mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: null, statusCheckRollup: [],
  });
  try {
    const logs = await runMainInRepo(repo, ["task", "some task", "--until", "ready", "--json"], { githubDeps: () => ({ gh, git: gitDep.git }) });
    for (const line of logs) assert.doesNotThrow(() => JSON.parse(line), `non-JSON stdout line under --json: ${line}`);
  } finally {
    process.exitCode = savedExitCode;
  }
});

// Re-review finding 1: `spawnDocsTask`'s "▶ post-merge: docs-update spawned"
// print fires AFTER run.end (it's spawned once the whole cycle loop is done,
// cli.js's maybeSpawnDocs call) — under --json + docs.autoUpdate that broke
// the same "stdout is one JSON object per line" contract as the fast-forward
// notice above, and specifically broke `... --json | tail -1 | jq .exit`
// since the plain-text line, not run.end, would be last.
test("orch task --until ready --json: the docs-update spawn notice stays out of the JSON stream", async () => {
  const savedExitCode = process.exitCode;
  const repo = initGitRepo();
  gitDep.git(["branch", "orch/integration"], repo);
  addOriginWithPeer(repo);
  mkdirSync(join(repo, ".orch"), { recursive: true });
  writeFileSync(join(repo, ".orch", "orch.yml"), "docs:\n  autoUpdate: true\n");
  const head = gitDep.git(["rev-parse", "orch/integration"], repo);
  const gh = readinessGh({
    number: 9, state: "OPEN", isDraft: false, headRefOid: head, baseRefName: "main",
    mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: null, statusCheckRollup: [],
  });
  const spawnCalls = [];
  try {
    const logs = await runMainInRepo(repo, ["task", "some task", "--until", "ready", "--json"], {
      githubDeps: () => ({ gh, git: gitDep.git }),
      spawn: (...args) => { spawnCalls.push(args); return { unref() {} }; },
    });
    assert.equal(spawnCalls.length, 1, "docs-update task should have spawned");
    for (const line of logs) assert.doesNotThrow(() => JSON.parse(line), `non-JSON stdout line under --json: ${line}`);
    const last = JSON.parse(logs[logs.length - 1]);
    assert.equal(last.event, "run.end", "run.end must stay the last stdout line");
  } finally {
    process.exitCode = savedExitCode;
  }
});

// design §13: `run.end` always carries `blockedReason` when exit == 3
// (values include "concurrency-cap") — the skipped run must close out the
// event stream, not just print a bare human line while --json is active.
test("orch task --until ready --json: a concurrency-cap skip still emits run.start/run.end with blockedReason", async () => {
  const savedExitCode = process.exitCode;
  const repo = initGitRepo();
  gitDep.git(["branch", "orch/integration"], repo);
  addOriginWithPeer(repo);
  const orchDir = join(repo, ".orch");
  mkdirSync(orchDir, { recursive: true });
  writeFileSync(join(orchDir, "orch.yml"), "concurrency: 1\n");
  inflight.register(orchDir, "cap-seed", { branch: "pr/test/seed", pid: process.pid, baseSha: "abc" });
  process.exitCode = 0;
  const head = gitDep.git(["rev-parse", "orch/integration"], repo);
  const gh = readinessGh({
    number: 9, state: "OPEN", isDraft: false, headRefOid: head, baseRefName: "main",
    mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: null, statusCheckRollup: [],
  });
  try {
    const logs = await runMainInRepo(repo, ["task", "some task", "--until", "ready", "--json"], { githubDeps: () => ({ gh, git: gitDep.git }) });
    for (const line of logs) assert.doesNotThrow(() => JSON.parse(line), `non-JSON stdout line under --json: ${line}`);
    const events = logs.map((l) => JSON.parse(l));
    assert.deepEqual(events.map((e) => e.event), ["run.start", "run.end"]);
    assert.equal(events[1].blockedReason, "concurrency-cap");
    assert.equal(events[1].exit, 3);
    assert.equal(process.exitCode, 3);
  } finally {
    process.exitCode = savedExitCode;
  }
});

// Regression guard for #547: the P5 slice shipped two tests that omitted
// githubDeps, so `--until ready` fell through to the real `gh` binary — green
// on a machine with authenticated gh, red everywhere else (CI included). This
// proves the *wiring*, not the readiness logic: with no githubDeps override,
// the code must still attempt a real `gh` shell-out (never a silent no-op) —
// verified with PATH cleared so the attempt deterministically fails to find
// `gh` before it could ever touch a network or credential, on any machine.
test("orch task --until ready --json: no githubDeps override still shells out to gh (not a silent no-op)", { skip: IS_WINDOWS && "PATH-shim relies on a POSIX shell script" }, async () => {
  const savedExitCode = process.exitCode;
  const savedPath = process.env.PATH;
  const repo = initGitRepo();
  gitDep.git(["branch", "orch/integration"], repo);
  addOriginWithPeer(repo);
  const gitPath = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const shimDir = mkdtempSync(join(tmpdir(), "orch-no-gh-"));
  symlinkSync(gitPath, join(shimDir, "git"));
  // Fake `gh`: answers --version (so ghAvailable() sees a real CLI) but fails
  // `auth status` — this reproduces #547's actual CI shape (gh installed, not
  // logged in) without ever invoking the real binary or touching a network.
  writeFileSync(
    join(shimDir, "gh"),
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "gh version 2.0.0"; exit 0; fi\necho "gh: not logged in to any GitHub hosts" >&2\nexit 1\n',
  );
  chmodSync(join(shimDir, "gh"), 0o755);
  process.env.PATH = shimDir;
  try {
    await assert.rejects(
      () => runMainInRepo(repo, ["task", "some task", "--until", "ready", "--json"]),
      /gh CLI is not authenticated/,
    );
  } finally {
    process.env.PATH = savedPath;
    process.exitCode = savedExitCode;
  }
});

test("nextAuthor alternates and persists last-author", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-cli-"));
  const cfg = { agents: ["claude", "codex"] };
  const a = nextAuthor(cfg, d);
  assert.equal(a.authorName, "claude");
  assert.equal(a.reviewerName, "codex");
  assert.equal(readFileSync(join(d, "last-author"), "utf8").trim(), "claude");
  const b = nextAuthor(cfg, d);
  assert.equal(b.authorName, "codex"); // alternated
});

test("nextAuthor computes dry rotation without persisting state", () => {
  const repo = mkdtempSync(join(tmpdir(), "orch-cli-dry-"));
  const orchDir = join(repo, ".orch");
  mkdirSync(orchDir);
  const f = join(orchDir, "last-author");
  writeFileSync(f, "codex\n");
  const before = readFileSync(f);
  const result = nextAuthor({ agents: ["claude", "codex"] }, orchDir, null, true);
  assert.equal(result.authorName, "claude");
  assert.equal(result.reviewerName, "codex");
  assert.deepEqual(readFileSync(f), before);

  const freshOrchDir = join(mkdtempSync(join(tmpdir(), "orch-cli-dry-fresh-")), ".orch");
  nextAuthor({ agents: ["claude", "codex"] }, freshOrchDir, null, true);
  assert.equal(existsSync(freshOrchDir), false);
});

test("nextAuthor pins a resumed author without advancing rotation (#27)", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-cli-"));
  const cfg = { agents: ["claude", "codex"] };
  nextAuthor(cfg, d); // last-author = claude
  const r = nextAuthor(cfg, d, "claude"); // resume claude's branch, don't rotate to codex
  assert.equal(r.authorName, "claude");
  assert.equal(r.reviewerName, "codex"); // reviewer is the next agent, excludes the author
  assert.equal(readFileSync(join(d, "last-author"), "utf8").trim(), "claude"); // pointer untouched
  assert.equal(nextAuthor(cfg, d).authorName, "codex"); // normal rotation still resumes from claude
});

test("nextAuthor ignores a pin not in the agents pool (#27)", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-cli-"));
  const cfg = { agents: ["claude", "codex"] };
  const r = nextAuthor(cfg, d, "ghost"); // unknown agent → fall back to rotation
  assert.equal(r.authorName, "claude");
});

test("nextAuthor does not re-seat a pinned excluded author", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-cli-exclude-"));
  const r = nextAuthor({ agents: ["claude", "codex", "copilot"] }, d, "claude", true, {
    exclude: ["claude"], persist: false,
  });
  assert.equal(r.authorName, "codex");
  assert.deepEqual(r.reviewerNames, ["copilot"]);
});

test("nextAuthor rotates the author away from a forced reviewer collision", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-cli-reviewer-collision-"));
  const r = nextAuthor({ agents: ["claude", "codex"], reviewers: ["claude"] }, d, null, true, {
    blockedAuthors: ["claude"], persist: false,
  });
  assert.equal(r.authorName, "codex");
  assert.deepEqual(r.reviewerNames, ["claude"]);
});

test("a one-agent pool keeps task and review role selection usable", async () => {
  const taskRepo = initGitRepo("orch-one-agent-task-");
  writeFileSync(join(taskRepo, "orch.yml"), "agents: [claude]\n");
  const taskLogs = await runMainInRepo(taskRepo, ["task", "one agent task", "--no-tidy"]);
  assert.match(taskLogs.join("\n"), /pr\/claude\/.*: merged/);

  const reviewRepo = initGitRepo("orch-one-agent-review-");
  const branch = "pr/claude/one-agent-review";
  gitDep.git(["branch", branch], reviewRepo);
  writeFileSync(join(reviewRepo, "orch.yml"), "agents: [claude]\n");
  const reviewLogs = await runMainInRepo(reviewRepo, ["review", branch], { finishRun: async () => {} });
  assert.match(reviewLogs.join("\n"), new RegExp(`${branch}: merged`));
});

test("task --reviewer rotates away from the requested reviewer end to end", async () => {
  const repo = initGitRepo("orch-reviewer-task-e2e-");
  writeFileSync(join(repo, "orch.yml"), "agents: [claude, codex]\n");
  const auditCalls = [];
  const cycleDeps = fakeCycleDeps();
  cycleDeps.adapters = {
    get: (name) => ({
      name,
      async author() {},
      async audit() { auditCalls.push(name); return { decision: "AGREE", reason: "ok", raw: "" }; },
    }),
  };
  const logs = await runMainInRepo(repo, ["task", "reviewer collision", "--reviewer", "claude", "--no-tidy"], { cycleDeps });
  assert.deepEqual(auditCalls, ["claude"]);
  assert.match(logs.join("\n"), /pr\/codex\/.*: merged/);
});

test("review --reviewer uses the requested reviewer end to end", async () => {
  const repo = initGitRepo("orch-reviewer-review-e2e-");
  const branch = "pr/codex/reviewer-regression";
  gitDep.git(["branch", branch], repo);
  writeFileSync(join(repo, "orch.yml"), "agents: [claude, codex]\n");
  const auditCalls = [];
  const cycleDeps = fakeCycleDeps();
  cycleDeps.adapters = {
    get: (name) => ({
      name,
      async author() {},
      async audit() { auditCalls.push(name); return { decision: "AGREE", reason: "ok", raw: "" }; },
    }),
  };
  const logs = await runMainInRepo(repo, ["review", branch, "--reviewer", "claude"], { cycleDeps, finishRun: async () => {} });
  assert.deepEqual(auditCalls, ["claude"]);
  assert.match(logs.join("\n"), new RegExp(`${branch}: merged`));
});

test("orch continue re-seats an excluded author from the inflight record", async () => {
  const repo = initGitRepo("orch-continue-rotate-");
  const orchDir = join(repo, ".orch");
  const sid = "rotate1";
  const branch = `pr/claude/some-fix-${sid}`;
  gitDep.git(["checkout", "-b", branch], repo);
  writeFileSync(join(repo, "a.txt"), "2\n");
  gitDep.git(["commit", "-am", "authored fix"], repo);
  gitDep.git(["checkout", "main"], repo);
  writeFileSync(join(repo, "orch.yml"), "agents: [claude, codex, copilot]\n");
  inflight.register(orchDir, sid, {
    branch, pid: 999999999, baseSha: gitDep.git(["rev-parse", "main"], repo),
    author: { agent: "claude" }, reviewers: [{ agent: "codex" }],
    excludedAgents: [{ name: "claude", reason: "quota", at: "2026-08-27T00:00:00.000Z" }],
    rotationStage: "started",
  });

  const authorCalls = [];
  const cycleDeps = {
    ...fakeCycleDeps(),
    checkpoint: checkpointDep,
  };
  // The fake author needs the actual worktree path; capture it from the call.
  cycleDeps.adapters.get = (name) => ({
    name,
    async author(_prompt, worktree) {
      authorCalls.push(name);
      if (name === "codex") {
        writeFileSync(join(worktree, "replacement.txt"), "replacement\n");
        gitDep.git(["add", "replacement.txt"], worktree);
        gitDep.git(["commit", "-m", "replacement author work"], worktree);
      }
      return { usage: {} };
    },
    async audit() { return { decision: "AGREE", reason: "ok", raw: "", usage: {} }; },
  });
  await runMainInRepo(repo, ["continue", sid], { cycleDeps, finishRun: async () => {} });
  assert.deepEqual(authorCalls, ["codex"]);
  assert.equal(inflight.lookup(orchDir, sid), null);
});

test("orch continue preserves a reviewer rotation if killed before its checkpoint", async () => {
  const repo = initGitRepo("orch-continue-reviewer-rotate-");
  const orchDir = join(repo, ".orch");
  const sid = "reviewrotate";
  const branch = `pr/claude/reviewer-rotate-${sid}`;
  gitDep.git(["checkout", "-b", branch], repo);
  writeFileSync(join(repo, "a.txt"), "2\n");
  gitDep.git(["commit", "-am", "authored fix"], repo);
  gitDep.git(["checkout", "main"], repo);
  writeFileSync(join(repo, "orch.yml"), "agents: [claude, codex, copilot]\n");
  inflight.register(orchDir, sid, {
    branch, pid: 999999999, baseSha: gitDep.git(["rev-parse", "main"], repo),
    author: { agent: "claude" }, reviewers: [{ agent: "copilot" }],
    excludedAgents: [{ name: "codex", reason: "quota", at: "2026-08-27T00:00:00.000Z" }],
    rotationStage: "authored",
  });

  let authorCalls = 0;
  let auditCalls = 0;
  const cycleDeps = {
    ...fakeCycleDeps(),
    checkpoint: checkpointDep,
    adapters: {
      get: (name) => ({
        name,
        async author() { authorCalls += 1; throw new Error("reviewer rotation must not re-author"); },
        async audit() { auditCalls += 1; return { decision: "AGREE", reason: "ok", raw: "" }; },
      }),
    },
  };
  const logs = await runMainInRepo(repo, ["continue", sid], { cycleDeps, finishRun: async () => {} });

  assert.equal(authorCalls, 0);
  assert.equal(auditCalls, 1);
  assert.match(logs.join("\n"), new RegExp(`${branch}: merged`));
});

test("orch continue persists a rotated reviewer before a crash", async () => {
  const savedExitCode = process.exitCode;
  const repo = initGitRepo("orch-continue-rotate-crash-");
  const orchDir = join(repo, ".orch");
  const sid = "rotatecrash";
  const branch = `pr/claude/rotate-crash-${sid}`;
  gitDep.git(["checkout", "-b", branch], repo);
  writeFileSync(join(repo, "a.txt"), "2\n");
  gitDep.git(["commit", "-am", "authored fix"], repo);
  gitDep.git(["checkout", "main"], repo);
  writeFileSync(join(repo, "orch.yml"), "agents: [claude, codex, gemini]\n");
  checkpointDep.record(orchDir, sid, {
    branch, round: 1, stage: "reviewed", decision: "AGREE", reason: "looks good",
    author: { agent: "claude" }, reviewers: [{ agent: "codex" }],
  });
  runRecordDep.create(orchDir, {
    runId: sid, command: "task", argv: [], policy: { until: "ready", maxAttempts: 3 },
  });

  const audits = [];
  let attachCalls = 0;
  const baseCycleDeps = fakeCycleDeps();
  const cycleDeps = {
    ...baseCycleDeps,
    git: {
      ...baseCycleDeps.git,
      attachExistingBranch(...args) {
        attachCalls += 1;
        if (attachCalls === 2) throw new Error("crash after rotated cycle");
        return gitDep.attachExistingBranch(...args);
      },
    },
    checkpoint: checkpointDep,
    adapters: {
      get: (name) => ({
        name,
        async author() { throw new Error("reviewer rotation must not re-author"); },
        async audit() {
          audits.push(name);
          return name === "codex"
            ? { decision: "DISAGREE", reason: "quota", raw: "", agentError: true, quota: true }
            : { decision: "AGREE", reason: "ok", raw: "", usage: {} };
        },
      }),
    },
    finalize: async () => { throw new Error("crash after rotated cycle"); },
  };
  try {
    await assert.rejects(
      () => runMainInRepo(repo, ["continue", sid, "--no-tidy"], { cycleDeps }),
      /crash after rotated cycle/,
    );
    const checkpoint = checkpointDep.lookup(orchDir, sid);
    assert.equal(checkpoint.stage, "authored");
    assert.equal(checkpoint.reviewers[0].agent, "gemini");
    assert.deepEqual(checkpoint.excludedAgents.map((entry) => entry.name), ["codex"]);

    audits.length = 0;
    await assert.rejects(
      () => runMainInRepo(repo, ["continue", sid, "--no-tidy"], { cycleDeps }),
      /crash after rotated cycle/,
    );
    assert.deepEqual(audits, ["gemini"], "a later continue must not re-seat the excluded reviewer");
  } finally {
    process.exitCode = savedExitCode;
  }
});

test("a rotated author keeps the partial-WIP guard active", { skip: IS_WINDOWS && "POSIX fixture scripts are not executable on Windows" }, async () => {
  const repo = initGitRepo("orch-rotate-partial-wip-");
  writeFileSync(join(repo, "orch.yml"), "agents: [claude, codex, copilot]\nroundCap: 3\n");
  const quotaCli = join(repo, "quota-cli.sh");
  const noopCli = join(repo, "noop-cli.sh");
  const reviewCli = join(repo, "review-cli.sh");
  writeFileSync(quotaCli, "#!/bin/sh\nprintf 'provider usage limit reached\\n'\nprintf 'partial\\n' > partial.txt\nexit 1\n");
  writeFileSync(noopCli, "#!/bin/sh\nexit 0\n");
  writeFileSync(reviewCli, "#!/bin/sh\nprintf 'AGREE\\n'\n");
  for (const script of [quotaCli, noopCli, reviewCli]) chmodSync(script, 0o755);

  const calls = [];
  const rotationEvents = [];
  const rotationState = {
    inflight: { setRoles: (...args) => { rotationEvents.push(["inflight", args[2].excludedAgents]); return inflight.setRoles(...args); } },
    runRecord: { update: (...args) => { rotationEvents.push(["run-record", args[2].excludedAgents]); return runRecordDep.update(...args); } },
    resume: {
      clear: (...args) => { rotationEvents.push(["resume-clear"]); return resume.clear(...args); },
      record: (...args) => { rotationEvents.push(["resume-record"]); return resume.record(...args); },
    },
    checkpoint: { clear: (...args) => { rotationEvents.push(["checkpoint-clear"]); return checkpointDep.clear(...args); } },
  };
  const cli = (name, bin) => {
    const adapter = makeCliAdapter({ name, bin, buildArgs: () => [] });
    const original = adapter.author;
    adapter.author = async (...args) => { calls.push(name); return original(...args); };
    return adapter;
  };
  const cycleDeps = {
    ...fakeCycleDeps(),
    checkpoint: checkpointDep,
    adapters: {
      get(name) {
        if (name === "claude") return cli(name, quotaCli);
        if (name === "copilot") return cli(name, noopCli);
        return cli(name, reviewCli);
      },
    },
  };
  await assert.rejects(
    runMainInRepo(repo, ["task", "partial quota task", "--until", "ready", "--no-tidy"], { cycleDeps, rotationState }),
    /partial WIP unchanged/,
  );
  assert.deepEqual(calls, ["claude", "copilot"]);
  assert.deepEqual(rotationEvents.map(([kind]) => kind), ["inflight", "run-record", "resume-clear", "resume-record", "checkpoint-clear"]);
  assert.deepEqual(rotationEvents[0][1].map((entry) => entry.name), ["claude"]);
  assert.deepEqual(rotationEvents[1][1].map((entry) => entry.name), ["claude"]);
  assert.equal(gitDep.git(["log", "-1", "--format=%s", "HEAD"], repo), "init");
});

test("preflight throws a clear error when .orch/ is read-only", { skip: IS_WINDOWS && "chmod doesn't restrict directory writes on Windows" }, () => {
  const d = mkdtempSync(join(tmpdir(), "orch-ro-"));
  chmodSync(d, 0o555); // read-only dir → child .orch write must fail
  const orchDir = join(d, ".orch");
  try {
    assert.throws(
      () => preflight({ agents: [] }, orchDir), // empty agents: skip CLI check, isolate probe
      /not writable/,
    );
  } finally {
    chmodSync(d, 0o755); // restore so tmp cleanup works
  }
});

test("resolveAgentBin returns the bare name when the CLI is on PATH (default envPath arg)", () => {
  // A self-created fixture, not a real system binary (e.g. `ls`) — a plain
  // Windows install has no POSIX tools on PATH at all (only Git for Windows'
  // bundled CI runner image does, which is what let this test hide behind a
  // false pass before). Temporarily extend the REAL process.env.PATH so the
  // default (unpassed) envPath argument is what's actually under test.
  const d = mkdtempSync(join(tmpdir(), "orch-onpath-"));
  const p = join(d, "fake-onpath-cli");
  writeFileSync(p, "#!/bin/sh\n");
  chmodSync(p, 0o755);
  const priorPath = process.env.PATH;
  process.env.PATH = `${d}${delimiter}${priorPath || ""}`;
  try {
    // win32 PATH hits deliberately return the absolute path (see platform.js:
    // callers need to see the real .cmd/.exe extension to route it correctly).
    if (IS_WINDOWS) {
      assert.equal(resolveAgentBin("fake-onpath-cli"), p);
    } else {
      assert.equal(resolveAgentBin("fake-onpath-cli"), "fake-onpath-cli"); // PATH hit → spawn by name as before
    }
  } finally {
    process.env.PATH = priorPath;
  }
});

test("resolveAgentBin searches the given PATH itself, without external which", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-bin-"));
  const p = join(d, "fake-path-cli-xyz");
  writeFileSync(p, "#!/bin/sh\n");
  chmodSync(p, 0o755);
  // PATH holds only d — a PATH too degraded to find `which` itself. The CLI
  // still resolves by name, and empty PATH entries are skipped, not treated as cwd.
  // Use the platform's own delimiter (";" on Windows) — a hardcoded ":" never
  // splits a Windows PATH string.
  assert.equal(resolveAgentBin("fake-path-cli-xyz", [], `${delimiter}${d}${delimiter}`), IS_WINDOWS ? p : "fake-path-cli-xyz");
  assert.equal(resolveAgentBin("fake-path-cli-xyz", [], ""), null); // empty PATH, no fallbacks
});

test("resolveAgentBin falls back to a known install dir when PATH misses", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-bin-"));
  const p = join(d, "fake-agent-cli-xyz");
  writeFileSync(p, "#!/bin/sh\n");
  chmodSync(p, 0o755);
  assert.equal(resolveAgentBin("fake-agent-cli-xyz", [d]), p); // off-PATH → absolute path
  assert.equal(resolveAgentBin("truly-missing-cli-xyz", [d]), null); // nowhere → null
});

test("resolveAgentBin ignores a non-executable file in a fallback dir", { skip: IS_WINDOWS && "no exec-bit concept for extensionless files on Windows" }, () => {
  const d = mkdtempSync(join(tmpdir(), "orch-bin-"));
  writeFileSync(join(d, "not-exec-xyz"), "");
  chmodSync(join(d, "not-exec-xyz"), 0o644);
  assert.equal(resolveAgentBin("not-exec-xyz", [d]), null);
});

test("resolveAgentBin verifies an already-absolute path instead of PATH-searching it", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-bin-"));
  const p = join(d, "abs-cli-xyz");
  writeFileSync(p, "#!/bin/sh\n");
  chmodSync(p, 0o755);
  assert.equal(resolveAgentBin(p, [], ""), p); // absolute + executable → itself
  assert.equal(resolveAgentBin(join(d, "missing-xyz"), [], ""), null); // absolute + gone → null
});

test("preflight stays green when a prior preflight rewrote adapter.bin to an absolute path", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-bin-"));
  const p = join(d, "claude");
  writeFileSync(p, "#!/bin/sh\n");
  chmodSync(p, 0o755);
  const a = adapters.get("claude");
  const orig = a.bin;
  try {
    a.bin = p; // simulate an earlier preflight's off-PATH absolute-path rewrite
    preflight({ agents: ["claude"] }); // second preflight in the same process
    preflight({ agents: ["claude"] }); // and a third — must stay idempotent
    assert.equal(a.bin, p);
  } finally {
    a.bin = orig;
  }
});

test("preflight warns when claude inherits an ambient Anthropic base URL", () => {
  const adapter = adapters.get("claude");
  const originalBin = adapter.bin;
  const originalUrl = process.env.ANTHROPIC_BASE_URL;
  const originalWarn = console.warn;
  const warnings = [];
  adapter.bin = process.execPath;
  process.env.ANTHROPIC_BASE_URL = "https://ambient.example/anthropic";
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    preflight({ agents: ["claude"] });
  } finally {
    console.warn = originalWarn;
    adapter.bin = originalBin;
    if (originalUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = originalUrl;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ANTHROPIC_BASE_URL/);
  assert.match(warnings[0], /https:\/\/ambient\.example\/anthropic/);
});

test("preflight does not warn about ambient Anthropic routing without claude", () => {
  const adapter = adapters.get("codex");
  const originalBin = adapter.bin;
  const originalUrl = process.env.ANTHROPIC_BASE_URL;
  const originalWarn = console.warn;
  const warnings = [];
  adapter.bin = process.execPath;
  process.env.ANTHROPIC_BASE_URL = "https://ambient.example/anthropic";
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    preflight({ agents: ["codex"] });
  } finally {
    console.warn = originalWarn;
    adapter.bin = originalBin;
    if (originalUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = originalUrl;
  }
  assert.deepEqual(warnings, []);
});

test("preflight rejects a config naming agy as author or reviewer (#272, #296)", () => {
  assert.throws(() => preflight({ agents: [], author: "agy" }), /agent "agy" is disabled/);
  assert.throws(() => preflight({ agents: [], reviewer: "agy" }), /agent "agy" is disabled/);
});

test("nextAuthor honors explicit fixed roles over rotation", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-cli-"));
  const cfg = { agents: ["claude", "codex"], author: "qwen3-coder-30b", reviewer: "claude" };
  const a = nextAuthor(cfg, d);
  assert.equal(a.authorName, "qwen3-coder-30b");
  assert.equal(a.reviewerName, "claude");
  const b = nextAuthor(cfg, d); // does not rotate
  assert.equal(b.authorName, "qwen3-coder-30b");
});

test("nextAuthor returns plural fixed roles when configured", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-cli-"));
  const cfg = { agents: ["claude", "codex"], authors: ["claude", "codex"], reviewers: ["codex", "claude"] };
  const a = nextAuthor(cfg, d);
  assert.deepEqual(a.authorNames, ["claude", "codex"]);
  assert.deepEqual(a.reviewerNames, ["codex", "claude"]);
  assert.equal(a.authorName, "claude");
  assert.equal(a.reviewerName, "codex");
});

test("nextAuthor parses model/effort from fixed role specs", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-cli-"));
  const cfg = { agents: ["claude", "codex"], author: "claude opus-4.8 high", reviewer: "codex gpt-5.1" };
  const a = nextAuthor(cfg, d);
  assert.deepEqual(a.authors, [{ agent: "claude", model: "opus-4.8", effort: "high" }]);
  assert.deepEqual(a.reviewers, [{ agent: "codex", model: "gpt-5.1", effort: null }]);
  assert.equal(a.authorName, "claude"); // back-compat name still exposed
  assert.deepEqual(a.reviewerNames, ["codex"]);
});

test("rotation specs carry null model/effort", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-cli-"));
  const a = nextAuthor({ agents: ["claude", "codex"] }, d);
  assert.deepEqual(a.authors, [{ agent: "claude", model: null, effort: null }]);
});

test("--author flag accepts an agent/model/effort spec", () => {
  const cfg = { agents: ["claude", "codex"], author: null, reviewer: null, authors: null, reviewers: null };
  const overridden = applyRoleOverrides(cfg, { author: "claude opus-4.8 high", reviewer: "codex" });
  assert.deepEqual(overridden.authors, ["claude opus-4.8 high"]);
  assert.deepEqual(overridden.reviewers, ["codex"]);
});

test("--cheap forces author+reviewer to cfg.cheap.role", () => {
  const cfg = { author: null, reviewer: null, authors: null, reviewers: null, cheap: { role: "qwen3-coder-30b", paths: [] } };
  const overridden = applyCheapOverride(cfg, { cheap: true });
  assert.deepEqual(overridden.authors, ["qwen3-coder-30b"]);
  assert.deepEqual(overridden.reviewers, ["qwen3-coder-30b"]);
});

test("--cheap without cheap.role configured throws", () => {
  const cfg = { author: null, reviewer: null, authors: null, reviewers: null, cheap: { role: null, paths: [] } };
  assert.throws(() => applyCheapOverride(cfg, { cheap: true }), /cheap.role must be set/);
});

test("--cheap combined with --author throws a usage error (exit 64), not a bare Error (exit 1)", () => {
  const cfg = { cheap: { role: "qwen3-coder-30b", paths: [] } };
  assert.throws(
    () => applyCheapOverride(cfg, { cheap: true, author: "claude", reviewer: "codex" }),
    (e) => e.exit === 64 && /cannot be combined/.test(e.message),
  );
});

test("--author and --authors together throws instead of silently dropping --author", () => {
  const cfg = { agents: ["claude", "codex"] };
  assert.throws(
    () => applyRoleOverrides(cfg, { author: "claude", authors: "claude,codex", reviewer: "codex" }),
    (e) => e.exit === 64 && /--author or --authors, not both/.test(e.message),
  );
});

test("--reviewer and --reviewers together throws instead of silently dropping --reviewer", () => {
  const cfg = { agents: ["claude", "codex"] };
  assert.throws(
    () => applyRoleOverrides(cfg, { author: "claude", reviewer: "codex", reviewers: "codex,claude" }),
    (e) => e.exit === 64 && /--reviewer or --reviewers, not both/.test(e.message),
  );
});

test("cheap auto-routes when a work order's suspected_paths all match cheap.paths", () => {
  const cfg = { author: null, reviewer: null, authors: null, reviewers: null, cheap: { role: "qwen3-coder-30b", paths: ["docs/**", "*.md"] } };
  const wo = { suspected_paths: ["docs/guide.md", "README.md"] };
  const overridden = applyCheapOverride(cfg, {}, wo);
  assert.deepEqual(overridden.authors, ["qwen3-coder-30b"]);
  assert.deepEqual(overridden.reviewers, ["qwen3-coder-30b"]);
});

test("cheap auto-route skipped when any suspected_path misses cheap.paths", () => {
  const cfg = { author: null, reviewer: null, authors: null, reviewers: null, cheap: { role: "qwen3-coder-30b", paths: ["docs/**"] } };
  const wo = { suspected_paths: ["docs/guide.md", "src/engine.js"] };
  const overridden = applyCheapOverride(cfg, {}, wo);
  assert.equal(overridden, cfg);
});

test("cheap auto-route skipped when --author/--reviewer already given explicitly", () => {
  const cfg = { cheap: { role: "qwen3-coder-30b", paths: ["docs/**"] } };
  const wo = { suspected_paths: ["docs/guide.md"] };
  const overridden = applyCheapOverride(cfg, { author: "codex", reviewer: "claude" }, wo);
  assert.equal(overridden, cfg);
});

test("cheap auto-route no-ops without cheap.role/paths configured", () => {
  const cfg = { cheap: { role: null, paths: [] } };
  const overridden = applyCheapOverride(cfg, {}, { suspected_paths: ["docs/guide.md"] });
  assert.equal(overridden, cfg);
});

test("agent add appends a known agent to the pool, preserving comments", async () => {
  const d = mkdtempSync(join(tmpdir(), "orch-add-"));
  const prev = cwd();
  chdir(d);
  try {
    await main(["init"], { preflight() {}, detectAgents: () => ({ found: [], missing: [] }) }); // stub: no real agent CLIs needed in tests
    await main(["agent", "add", "qwen3-coder-30b"]);
    const text = readFileSync(join(d, ".orch", "orch.yml"), "utf8");
    // Scaffold ships a block sequence; add appends a `  - <name>` item.
    assert.match(text, /agents:\n {2}- claude\n {2}- codex\n {2}- qwen3-coder-30b/);
    assert.match(text, /# Agents — rotation pool/); // comments survived
    // idempotent: a second add is a no-op
    await main(["agent", "add", "qwen3-coder-30b"]);
    const again = readFileSync(join(d, ".orch", "orch.yml"), "utf8");
    assert.equal((again.match(/qwen3-coder-30b/g) || []).length, text.match(/qwen3-coder-30b/g).length);
  } finally {
    chdir(prev);
  }
});

test("agent add appends copilot to the pool", async () => {
  const d = mkdtempSync(join(tmpdir(), "orch-add-"));
  const prev = cwd();
  chdir(d);
  try {
    await main(["init"], { preflight() {}, detectAgents: () => ({ found: [], missing: [] }) });
    await main(["agent", "add", "copilot"]);
    const text = readFileSync(join(d, ".orch", "orch.yml"), "utf8");
    assert.match(text, /agents:\n {2}- claude\n {2}- codex\n {2}- copilot/);
  } finally {
    chdir(prev);
  }
});

test("appendAgentToBlockList appends after the last item even with interspersed comments (codex #326)", () => {
  // Contiguous scaffold list.
  assert.equal(
    appendAgentToBlockList("agents:\n  - claude\n  - codex\ntest: auto\n", "grok"),
    "agents:\n  - claude\n  - codex\n  - grok\ntest: auto\n"
  );
  // Comment between entries → still appends at the END, not mid-list.
  assert.equal(
    appendAgentToBlockList("agents:\n  - claude\n  # fave\n  - codex\ntest: auto\n", "grok"),
    "agents:\n  - claude\n  # fave\n  - codex\n  - grok\ntest: auto\n"
  );
  // Comment immediately after `agents:` (previously prevented any match).
  assert.equal(
    appendAgentToBlockList("agents:\n  # pool\n  - claude\ntest: auto\n", "grok"),
    "agents:\n  # pool\n  - claude\n  - grok\ntest: auto\n"
  );
  // Trailing blank + next-section comment must not be mistaken for block members.
  assert.equal(
    appendAgentToBlockList("agents:\n  - claude\n\n# === Roles ===\nauthor: x\n", "grok"),
    "agents:\n  - claude\n  - grok\n\n# === Roles ===\nauthor: x\n"
  );
  // No block list present.
  assert.equal(appendAgentToBlockList("author: claude\n", "grok"), null);
});

test("agent add still appends to a legacy inline `agents: [...]` config", async () => {
  // The scaffold ships block-form, but hand-written / older configs use inline
  // flow style — add must keep editing those in place too.
  const d = mkdtempSync(join(tmpdir(), "orch-add-inline-"));
  const prev = cwd();
  chdir(d);
  try {
    mkdirSync(join(d, ".orch"));
    writeFileSync(join(d, ".orch", "orch.yml"), "agents: [claude, codex]\ntest: auto\n");
    await main(["agent", "add", "copilot"]);
    const text = readFileSync(join(d, ".orch", "orch.yml"), "utf8");
    assert.match(text, /agents: \[claude, codex, copilot\]/);
  } finally {
    chdir(prev);
  }
});

test("agent add honors --config-file and --dry", async () => {
  const d = mkdtempSync(join(tmpdir(), "orch-add-flags-"));
  const prev = cwd();
  chdir(d);
  try {
    mkdirSync(join(d, ".orch"));
    const dflt = "agents: [claude, codex]\ntest: auto\n";
    writeFileSync(join(d, ".orch", "orch.yml"), dflt);
    writeFileSync(join(d, "custom.yml"), "agents:\n  - claude\n");

    // --dry alone leaves the default config untouched.
    await main(["agent", "add", "copilot", "--dry"]);
    assert.equal(readFileSync(join(d, ".orch", "orch.yml"), "utf8"), dflt);

    // --dry writes nothing at all.
    await main(["agent", "add", "copilot", "--config-file", "custom.yml", "--dry"]);
    assert.equal(readFileSync(join(d, "custom.yml"), "utf8"), "agents:\n  - claude\n");
    assert.equal(readFileSync(join(d, ".orch", "orch.yml"), "utf8"), dflt);

    // without --dry the named file is edited, the default one is left alone.
    await main(["agent", "add", "copilot", "--config-file", "custom.yml"]);
    assert.equal(readFileSync(join(d, "custom.yml"), "utf8"), "agents:\n  - claude\n  - copilot\n");

    // --dry on a file with no `agents:` list fails the same way a real run would.
    writeFileSync(join(d, "no-list.yml"), "test: auto\n");
    await assert.rejects(
      () => main(["agent", "add", "qwen3-coder-30b", "--config-file", "no-list.yml", "--dry"]),
      /could not find `agents:` list in no-list\.yml/,
    );
    assert.equal(readFileSync(join(d, ".orch", "orch.yml"), "utf8"), dflt);
  } finally {
    chdir(prev);
  }
});

test("agent add validates orch.yml before editing it", async () => {
  const d = mkdtempSync(join(tmpdir(), "orch-add-invalid-"));
  const prev = cwd();
  const file = join(d, ".orch", "orch.yml");
  const invalid = "agents: [claude]\nmerge: unsafe\n";
  chdir(d);
  try {
    mkdirSync(join(d, ".orch"));
    writeFileSync(file, invalid);

    await assert.rejects(
      () => main(["agent", "add", "copilot"]),
      /orch\.yml: merge must be ff-only, no-ff, or pr/,
    );
    assert.equal(readFileSync(file, "utf8"), invalid);
  } finally {
    chdir(prev);
  }
});

test("agent add rejects an unknown agent", async () => {
  const d = mkdtempSync(join(tmpdir(), "orch-add-"));
  const prev = cwd();
  chdir(d);
  try {
    await main(["init"], { preflight() {}, detectAgents: () => ({ found: [], missing: [] }) }); // stub: no real agent CLIs needed in tests
    await assert.rejects(() => main(["agent", "add", "nope"]), /unknown agent/);
  } finally {
    chdir(prev);
  }
});

test("agent build feeds an adapter work order through the task pipeline (noMerge by default)", async () => {
  const d = initGitRepo("orch-agentbuild-");
  const logs = await runMainInRepo(d, ["agent", "build", "widget"], { resolveAgentBin: () => "/usr/bin/widget" });
  assert.match(
    logs.join("\n"),
    /agent build widget: approved .* on pr\/[a-z0-9-]+\/add-widget-adapter-for-orch-\d+-[0-9a-z]+/,
  );
});

test("agent build --pr routes the cycle through merge: pr instead of a local-only branch", async () => {
  const d = initGitRepo("orch-agentbuild-pr-");
  let seenMerge = null;
  const deps = {
    preflight() {},
    resolveAgentBin: () => "/usr/bin/widget",
    cycleDeps: {
      ...fakeCycleDeps(),
      finalize: async (ctx) => { seenMerge = ctx.cfg.merge; return { status: "pr", reason: "test", prUrl: "https://example/pr/1" }; },
    },
  };
  const logs = await runMainInRepo(d, ["agent", "build", "widget", "--pr"], deps);
  assert.equal(seenMerge, "pr");
  assert.match(logs.join("\n"), /agent build widget: pr /);
});

// buildAgent's dry path is a real stubbed cycle (dryDeps()), not the
// print-and-return short-circuit most other write commands use for --dry —
// nothing exercised that end-to-end before: preflight/git-sync/inflight
// registration must all be skipped, and the run must still report a result.
test("agent build --dry runs a stubbed dry cycle without preflight, sync, or registration side effects", async () => {
  const d = initGitRepo("orch-agentbuild-dry-");
  const logs = await runMainInRepo(d, ["agent", "build", "widget", "--dry"], {
    resolveAgentBin: () => "/usr/bin/widget",
    preflight() { assert.fail("preflight ran despite --dry"); },
  });
  assert.match(logs.join("\n"), /agent build widget: approved .* on pr\/[a-z0-9-]+\/add-widget-adapter-for-orch-\d+-[0-9a-z]+/);
  assert.equal(existsSync(join(d, ".orch", "inflight")), false, "dry run must not register an inflight cycle");
});

test("agent build honors --author/--reviewer role overrides instead of the configured/rotated author", async () => {
  const d = initGitRepo("orch-agentbuild-roles-");
  const authoredBy = [];
  const auditedBy = [];
  const deps = {
    preflight() {},
    resolveAgentBin: () => "/usr/bin/widget",
    cycleDeps: {
      ...fakeCycleDeps(),
      adapters: {
        get: (name) => ({
          name,
          async author() { authoredBy.push(name); return { usage: { model: "gpt-test-author", tokens: 40 } }; },
          async audit() { auditedBy.push(name); return { decision: "AGREE", reason: "ok", raw: "", usage: { model: "gpt-test-review", tokens: 20 } }; },
        }),
      },
    },
  };
  const logs = await runMainInRepo(d, ["agent", "build", "widget", "--author", "codex", "--reviewer", "copilot"], deps);
  assert.deepEqual(authoredBy, ["codex"]);
  assert.deepEqual(auditedBy, ["copilot"]);
  assert.match(logs.join("\n"), /on pr\/codex\/add-widget-adapter-for-orch-\d+-[0-9a-z]+/);
});

// Regression (codex review of #130's persist-roles PR): `orch task`/`orch pr`
// pass the resolved author/reviewer specs into inflight.register() so a run
// that dies before its first checkpoint can still be resumed with the exact
// same agents/models. `orch agent build` runs its own task-mode cycle through
// the same runCycle()/inflight machinery but was missing this — a died
// mid-build recovery would silently re-resolve roles from current rotation
// instead of reusing what actually authored/reviewed the in-progress build.
test("agent build persists resolved author/reviewer role specs into the inflight record", async () => {
  const d = initGitRepo("orch-agentbuild-inflight-");
  const orchDir = join(d, ".orch");
  let seen = null;
  const deps = {
    preflight() {},
    resolveAgentBin: () => "/usr/bin/widget",
    cycleDeps: {
      ...fakeCycleDeps(),
      adapters: {
        get: (name) => ({
          name,
          async author() {
            const [f] = readdirSync(join(orchDir, "inflight"));
            seen = JSON.parse(readFileSync(join(orchDir, "inflight", f), "utf8"));
            return { usage: { model: "gpt-test-author", tokens: 40 } };
          },
          async audit() { return { decision: "AGREE", reason: "ok", raw: "", usage: {} }; },
        }),
      },
    },
  };
  await runMainInRepo(d, ["agent", "build", "widget"], deps);
  assert.ok(seen, "expected an inflight record to exist while the cycle was running");
  assert.equal(seen.author.agent, "claude");
  assert.ok(Array.isArray(seen.reviewers) && seen.reviewers.length > 0);
});

test("agent build no-ops when the agent is already registered", async () => {
  const d = initGitRepo("orch-agentbuild-known-");
  const logs = await runMainInRepo(d, ["agent", "build", "claude"]);
  assert.match(logs.join("\n"), /already registered/);
});

// `orch agent build <known-adapter>` shares the exact same "nothing left to
// build" fate as `agent add <known-adapter> --build` above — buildAgent()
// returns "already-registered" before it ever reads flags.pr/author/reviewer/
// allow-large-scope, so those flags used to validate, run the full dispatch,
// and get silently dropped instead of refused.
test("agent build <known-adapter> --pr is a usage error, not a silent drop", async () => {
  const d = initGitRepo("orch-build-known-pr-");
  await assert.rejects(
    () => runMainInRepo(d, ["agent", "build", "claude", "--pr"], {
      buildAgent: async () => assert.fail("buildAgent ran — claude's adapter code already exists, nothing to build"),
    }),
    (e) => e.exit === 64 && /--pr is not valid with 'orch agent build claude'/.test(e.message),
  );
});

test("agent build <known-adapter> --allow-large-scope is a usage error, not a silent drop", async () => {
  const d = initGitRepo("orch-build-known-scope-");
  await assert.rejects(
    () => runMainInRepo(d, ["agent", "build", "claude", "--allow-large-scope"], {
      buildAgent: async () => assert.fail("buildAgent ran — claude's adapter code already exists, nothing to build"),
    }),
    (e) => e.exit === 64 && /--allow-large-scope is not valid with 'orch agent build claude'/.test(e.message),
  );
});

// Same "validate before every side effect" property as the `agent add`
// variant: the known-adapter check runs in validatePositionals (schema.js),
// which main() calls immediately after parse() — before the update-check
// network call.
test("agent build <known-adapter> --pr is refused before the update-check side effect fires", async () => {
  const d = initGitRepo("orch-build-known-noupdate-");
  let updateChecked = false;
  await assert.rejects(
    () => runMainInRepo(d, ["agent", "build", "claude", "--pr"], {
      maybeNotifyUpdate: () => { updateChecked = true; return Promise.resolve(); },
      buildAgent: async () => assert.fail("buildAgent ran — claude's adapter code already exists, nothing to build"),
    }),
    (e) => e.exit === 64,
  );
  assert.equal(updateChecked, false, "update-check must not fire before a usage error is refused");
});

test("agent build rejects a missing CLI before starting the pipeline", async () => {
  let preflightCalled = false;
  await assert.rejects(
    () => buildAgent("widget", {
      repo: "/repo",
      orchDir: "/repo/.orch",
      deps: {
        resolveAgentBin: () => null,
        preflight() { preflightCalled = true; },
      },
    }),
    /orch: no CLI named "widget" found on PATH .* typo/,
  );
  assert.equal(preflightCalled, false);
});

test("agent add offers to build an unregistered agent; accepting delegates to buildAgent", async () => {
  const d = mkdtempSync(join(tmpdir(), "orch-add-build-"));
  const prev = cwd();
  chdir(d);
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => logs.push(a.map(String).join(" "));
  try {
    await main(["init"], { preflight() {}, detectAgents: () => ({ found: [], missing: [] }) });
    let calledWith = null;
    await main(["agent", "add", "widget"], {
      io: { confirm: async () => true },
      buildAgent: async (name) => { calledWith = name; return { status: "approved", branch: "pr/claude/add-widget-adapter-for-orch-1-abc" }; },
    });
    assert.equal(calledWith, "widget");
    assert.match(logs.join("\n"), /agent build widget: approved/);
  } finally {
    console.log = origLog;
    chdir(prev);
  }
});

// The interactive prompt above is a dead end for a headless caller (a poller, a
// CI job, another agent): there is no one to answer it. `--build` is the same
// path with the question skipped.
test("agent add --build skips the confirm prompt and builds", async () => {
  const d = mkdtempSync(join(tmpdir(), "orch-add-build-flag-"));
  const prev = cwd();
  chdir(d);
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => logs.push(a.map(String).join(" "));
  try {
    await main(["init"], { preflight() {}, detectAgents: () => ({ found: [], missing: [] }) });
    let calledWith = null;
    await main(["agent", "add", "widget", "--build"], {
      io: { confirm: async () => assert.fail("asked for confirmation despite --build") },
      buildAgent: async (name) => { calledWith = name; return { status: "approved", branch: "pr/claude/add-widget-adapter-for-orch-1-abc" }; },
    });
    assert.equal(calledWith, "widget");
    assert.match(logs.join("\n"), /agent build widget: approved/);
  } finally {
    console.log = origLog;
    chdir(prev);
  }
});

// `--build` used to trigger on its own, so `orch agent <typo> <name> --build`
// ran a real build instead of reporting the malformed subcommand.
test("agent <typo> <name> --build is a usage error, not a build", async () => {
  const d = mkdtempSync(join(tmpdir(), "orch-agent-typo-build-"));
  const prev = cwd();
  chdir(d);
  try {
    await main(["init"], { preflight() {}, detectAgents: () => ({ found: [], missing: [] }) });
    let built = false;
    await assert.rejects(
      () => main(["agent", "typo", "widget", "--build"], {
        buildAgent: async () => { built = true; return { status: "approved" }; },
      }),
      /usage: orch agent add <name> \| orch agent build <name>/,
    );
    assert.equal(built, false);
  } finally {
    chdir(prev);
  }
});

// A6+B4: the confirm path used to hardcode `flags: {}`, silently discarding
// `--dry`/`--config-file` — a confirmed `--dry` build would run a REAL build
// (real worktree/branch/merge) because the flag never reached buildAgent. It
// also never set the escalation exit code the direct `agent build <name>`
// sibling sets. Both are asserted here against the same confirm path.
test("agent add confirm path forwards real flags to buildAgent (A6)", async () => {
  const d = mkdtempSync(join(tmpdir(), "orch-add-build-flags-"));
  const prev = cwd();
  chdir(d);
  try {
    await main(["init"], { preflight() {}, detectAgents: () => ({ found: [], missing: [] }) });
    let receivedFlags = null;
    await main(["agent", "add", "widget", "--dry", "--config-file", "custom.yml"], {
      io: { confirm: async () => true },
      buildAgent: async (name, ctx) => { receivedFlags = ctx.flags; return { status: "approved", branch: "pr/claude/add-widget-adapter-for-orch-1-abc" }; },
    });
    assert.equal(receivedFlags.dry, true);
    assert.equal(receivedFlags["config-file"], "custom.yml");
  } finally {
    chdir(prev);
  }
});

test("agent add confirm path sets exit code 2 on an escalated build (B4)", async () => {
  const d = mkdtempSync(join(tmpdir(), "orch-add-build-escalated-"));
  const prev = cwd();
  const savedExitCode = process.exitCode;
  chdir(d);
  try {
    await main(["init"], { preflight() {}, detectAgents: () => ({ found: [], missing: [] }) });
    await main(["agent", "add", "widget"], {
      io: { confirm: async () => true },
      buildAgent: async () => ({ status: "escalated", reason: "stalemate after cap", branch: "pr/claude/add-widget-adapter-for-orch-1-abc" }),
    });
    assert.equal(process.exitCode, 2);
  } finally {
    process.exitCode = savedExitCode;
    chdir(prev);
  }
});

test("agent add confirm path sets exit code 2 on a merge-deferred build (B4)", async () => {
  const d = mkdtempSync(join(tmpdir(), "orch-add-build-prfallback-"));
  const prev = cwd();
  const savedExitCode = process.exitCode;
  chdir(d);
  try {
    await main(["init"], { preflight() {}, detectAgents: () => ({ found: [], missing: [] }) });
    await main(["agent", "add", "widget"], {
      io: { confirm: async () => true },
      buildAgent: async () => ({ status: "merge-deferred", reason: "conflict", branch: "pr/claude/add-widget-adapter-for-orch-1-abc" }),
    });
    assert.equal(process.exitCode, 2);
  } finally {
    process.exitCode = savedExitCode;
    chdir(prev);
  }
});

test("agent add declines the build offer and still throws unknown agent", async () => {
  const d = mkdtempSync(join(tmpdir(), "orch-add-decline-"));
  const prev = cwd();
  chdir(d);
  try {
    await main(["init"], { preflight() {}, detectAgents: () => ({ found: [], missing: [] }) });
    await assert.rejects(
      () => main(["agent", "add", "widget"], { io: { confirm: async () => false } }),
      /unknown agent/,
    );
  } finally {
    chdir(prev);
  }
});

test("init prints an agent-detection summary using the injected detectAgents", async () => {
  const d = mkdtempSync(join(tmpdir(), "orch-detect-"));
  const prev = cwd();
  chdir(d);
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => logs.push(a.map(String).join(" "));
  try {
    await main(["init"], {
      preflight() {},
      detectAgents: () => ({ found: ["claude", "glm-4.5-air"], missing: ["codex (CLI not found: PATH + fallback dirs)"] }),
    });
    assert.ok(logs.some((l) => l.includes("detected: claude, glm-4.5-air")));
    assert.ok(logs.some((l) => l.includes("not found: codex (CLI not found: PATH + fallback dirs)")));
  } finally {
    console.log = origLog;
    chdir(prev);
  }
});

test("init succeeds via the real (unstubbed) preflight regardless of installed agent CLIs", async () => {
  const d = mkdtempSync(join(tmpdir(), "orch-init-real-"));
  const prev = cwd();
  chdir(d);
  try {
    // No preflight stub here — exercises the real preflight(). It must only
    // check .orch/ writability for init, not require claude/codex on PATH,
    // otherwise a clean machine would throw before ever seeing the
    // detectAgents() "not found" summary this command exists to print.
    // detectAgents IS stubbed: the real one probes PATH/fallback dirs and reads
    // ~/.claude-code-router, which is environment-dependent and irrelevant to
    // what this test checks.
    await main(["init"], { detectAgents: () => ({ found: [], missing: [] }) });
    assert.ok(existsSync(join(d, ".orch", "orch.yml")));
  } finally {
    chdir(prev);
  }
});

test("scaffolded orch.yml documents every built-in agent detectAgents() probes", async () => {
  const d = mkdtempSync(join(tmpdir(), "orch-init-scaffold-"));
  const prev = cwd();
  chdir(d);
  try {
    await main(["init"], { preflight() {}, detectAgents: () => ({ found: [], missing: [] }) });
    const text = readFileSync(join(d, ".orch", "orch.yml"), "utf8");
    // Keep the "Built-in: ..." doc comment in sync with the CLI names
    // detectAgents() (src/detect.js) actually probes. Derive the expected set
    // from the adapter registry (adapters.nativeAgents) rather than a hand-kept
    // list — a hard-coded loop drifted stale for gemini once, then again for agy
    // and grok, without failing this test. Sourcing it from the registry means
    // any newly added native adapter is checked automatically.
    assert.ok(adapters.nativeAgents.length >= 4, "expected the native adapter set to be non-trivial");
    for (const name of adapters.nativeAgents) {
      assert.match(text, new RegExp(`Built-in:.*\\b${name}\\b`));
    }
  } finally {
    chdir(prev);
  }
});

test("init writes .orch/ORCH.md and prints a link tip (no --link)", async () => {
  const d = mkdtempSync(join(tmpdir(), "orch-doc-"));
  const prev = cwd();
  chdir(d);
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => logs.push(a.map(String).join(" "));
  try {
    await main(["init"], { preflight() {}, detectAgents: () => ({ found: [], missing: [] }) });
    const doc = readFileSync(join(d, ".orch", "ORCH.md"), "utf8");
    assert.match(doc, /Using orch in this repo/);
    assert.match(doc, /orch task/);
    assert.equal(existsSync(join(d, "CLAUDE.md")), false); // no --link = no file touched
    assert.ok(logs.some((l) => /orch init --link/.test(l)), "prints the link tip");
  } finally {
    console.log = origLog;
    chdir(prev);
  }
});

test("init --link appends a fenced pointer to CLAUDE.md, idempotently", async () => {
  const d = mkdtempSync(join(tmpdir(), "orch-link-"));
  const prev = cwd();
  chdir(d);
  writeFileSync(join(d, "CLAUDE.md"), "# My repo\n\nExisting notes.\n");
  try {
    const detectAgents = () => ({ found: [], missing: [] });
    await main(["init", "--link"], { preflight() {}, detectAgents });
    const md = readFileSync(join(d, "CLAUDE.md"), "utf8");
    assert.match(md, /# My repo/);            // original content preserved
    assert.match(md, /@\.orch\/ORCH\.md/);    // pointer added
    assert.equal((md.match(/orch:begin/g) || []).length, 1);
    // re-run: replaces in place, never duplicates
    await main(["init", "--link"], { preflight() {}, detectAgents });
    const again = readFileSync(join(d, "CLAUDE.md"), "utf8");
    assert.equal((again.match(/orch:begin/g) || []).length, 1);
    assert.equal((again.match(/# My repo/g) || []).length, 1);
  } finally {
    chdir(prev);
  }
});

test("linkOrchDoc targets every present agent file; fallback follows the primary agent", () => {
  // none present, no agents → default CLAUDE.md
  const d1 = mkdtempSync(join(tmpdir(), "orch-link1-"));
  assert.deepEqual(linkOrchDoc(d1), ["CLAUDE.md"]);
  assert.match(readFileSync(join(d1, "CLAUDE.md"), "utf8"), /orch:begin/);
  // none present, codex primary → AGENTS.md (not a blind CLAUDE.md the agent never reads)
  const d1b = mkdtempSync(join(tmpdir(), "orch-link1b-"));
  assert.deepEqual(linkOrchDoc(d1b, ["codex", "claude"]), ["AGENTS.md"]);
  assert.equal(existsSync(join(d1b, "CLAUDE.md")), false);
  // local-llm primary (no convention) falls through to CLAUDE.md
  const d1c = mkdtempSync(join(tmpdir(), "orch-link1c-"));
  assert.deepEqual(linkOrchDoc(d1c, ["qwen3-coder-30b"]), ["CLAUDE.md"]);
  // AGENTS.md + GEMINI.md present → both targeted regardless of agents, CLAUDE.md left alone
  const d2 = mkdtempSync(join(tmpdir(), "orch-link2-"));
  writeFileSync(join(d2, "AGENTS.md"), "agents\n");
  writeFileSync(join(d2, "GEMINI.md"), "gemini\n");
  assert.deepEqual(linkOrchDoc(d2, ["claude"]), ["AGENTS.md", "GEMINI.md"]);
  assert.equal(existsSync(join(d2, "CLAUDE.md")), false);
  assert.match(readFileSync(join(d2, "AGENTS.md"), "utf8"), /@\.orch\/ORCH\.md/);
});

test("CLI role overrides replace orch.yml fixed roles", () => {
  const cfg = {
    agents: ["claude", "codex"],
    author: "qwen3-coder-30b",
    reviewer: "claude",
    authors: null,
    reviewers: null,
  };
  const overridden = applyRoleOverrides(cfg, { authors: "claude,codex", reviewers: "codex,claude" });
  assert.equal(overridden.author, null);
  assert.equal(overridden.reviewer, null);
  assert.deepEqual(overridden.authors, ["claude", "codex"]);
  assert.deepEqual(overridden.reviewers, ["codex", "claude"]);
});

test("pr accepts a branch target and rejects a missing branch", async () => {
  const repo = initGitRepo("orch-pr-branch-target-");
  gitDep.git(["branch", "feature/x"], repo);
  assert.doesNotThrow(() => resolvePrTarget({
    target: "feature/x", repo, orchDir: join(repo, ".orch"),
  }));
  await assert.rejects(() => runMainCapture(["pr", "abc"]), /branch does not exist/);
  await assert.rejects(() => runMainCapture(["pr"]), /usage: orch pr <number>/);
});

test("pr target resolution keeps colleague branches off the push path", () => {
  const repo = initGitRepo("orch-pr-authority-");
  gitDep.git(["branch", "feature/colleague"], repo);
  const calls = [];
  const pr = {
    number: 17, state: "OPEN", headRefName: "feature/colleague", headRefOid: "head17",
    baseRefName: "main", isCrossRepository: false, maintainerCanModify: true, isDraft: false,
    url: "https://example.invalid/pull/17",
  };
  const gh = (args) => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "list") return JSON.stringify([{ number: 17, url: pr.url, isDraft: false, headRefOid: pr.headRefOid }]);
    if (args[0] === "pr" && args[1] === "view") return JSON.stringify(pr);
    if (args[0] === "api") return JSON.stringify({ permissions: { push: true } });
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  const target = resolvePrTarget({
    target: pr.headRefName, repo, orchDir: join(repo, ".orch"), baseBranch: "main", until: "ready", gh,
  });
  assert.equal(target.canPushHead, false);
  assert.equal(target.needsRepairBranch, true);
  assert.equal(calls.filter((args) => args[0] === "api").length, 1);
});

test("failed PR lookup prepares and pushes an owned repair branch", () => {
  const repo = initGitRepo("orch-pr-lookup-failure-");
  const { remote } = addOriginWithPeer(repo);
  const sourceBranch = "feature/colleague";
  gitDep.git(["checkout", "-b", sourceBranch], repo);
  writeFileSync(join(repo, "pr.txt"), "PR head\n");
  gitDep.git(["add", "pr.txt"], repo);
  gitDep.git(["commit", "-m", "PR head"], repo);
  gitDep.git(["push", "origin", sourceBranch], repo);
  gitDep.git(["checkout", "main"], repo);
  const original = gitDep.git(["rev-parse", sourceBranch], remote);
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "list") {
      if (args.includes(sourceBranch)) throw new Error("HTTP 401: Bad credentials");
      return "[]";
    }
    if (args[0] === "pr" && args[1] === "create") return "https://github.com/o/r/pull/42\n";
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  const target = resolvePrTarget({
    target: sourceBranch, repo, orchDir: join(repo, ".orch"), baseBranch: "main", until: "ready", gh,
  });

  assert.equal(target.canPushHead, false);
  assert.equal(target.needsRepairBranch, true);
  const repair = preparePrRepairRun({
    repo,
    orchDir: join(repo, ".orch"),
    sid: "lookup-failed",
    branch: sourceBranch,
    prTarget: target,
  }, { baseBranch: "main" }, { gh });

  const repairBranch = "pr/repair/feature-colleague-lookup-failed";
  assert.equal(repair.branch, repairBranch);
  assert.equal(gitDep.git(["rev-parse", repairBranch], remote), original);
  assert.equal(gitDep.git(["rev-parse", sourceBranch], remote), original, "the contributor branch must remain untouched");
  assert.ok(calls.some((args) => args[0] === "pr" && args[1] === "create" && args.includes(repairBranch)));
});

test("PR landing derives changed paths when the review cycle omits them", () => {
  const repo = initGitRepo("orch-pr-paths-");
  gitDep.git(["checkout", "-b", "pr-17"], repo);
  writeFileSync(join(repo, "pr.txt"), "PR head\n");
  gitDep.git(["add", "pr.txt"], repo);
  gitDep.git(["commit", "-m", "PR head"], repo);
  gitDep.git(["checkout", "main"], repo);

  const landed = resolveLanded(
    { status: "approved" },
    { branch: "pr-17", prTarget: { number: 17, branch: "pr-17" } },
    { baseBranch: "main" },
    {},
    repo,
  );
  assert.deepEqual(landed.paths, ["pr.txt"]);
});

test("PR repair preparation publishes an owned repair branch, not the original head", () => {
  const repo = initGitRepo("orch-pr-repair-");
  const { remote } = addOriginWithPeer(repo);
  gitDep.git(["checkout", "-b", "pr-17"], repo);
  writeFileSync(join(repo, "pr.txt"), "PR head\n");
  gitDep.git(["add", "pr.txt"], repo);
  gitDep.git(["commit", "-m", "PR head"], repo);
  gitDep.git(["branch", "feature/colleague"], repo);
  gitDep.git(["push", "origin", "feature/colleague"], repo);
  gitDep.git(["checkout", "main"], repo);

  const original = gitDep.git(["rev-parse", "feature/colleague"], remote);
  const calls = [];
  const repairPr = preparePrRepairRun({
    repo,
    orchDir: join(repo, ".orch"),
    sid: "repair-sid",
    branch: "pr-17",
    worktree: join(repo, ".orch", "wt", "pr-17"),
    prTarget: { number: 17, originalNumber: 17, baseBranch: "main" },
  }, { baseBranch: "main" }, {
    gh(args) {
      calls.push(args);
      if (args[0] === "pr" && args[1] === "list") return "[]";
      if (args[0] === "pr" && args[1] === "create") return "https://github.com/o/r/pull/42\n";
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    },
  });

  const repairBranch = "pr/repair/17-repair-sid";
  assert.equal(repairPr.branch, repairBranch);
  assert.equal(repairPr.prTarget.number, 42);
  assert.equal(gitDep.git(["rev-parse", repairBranch], remote), gitDep.git(["rev-parse", "pr-17"], repo));
  assert.equal(gitDep.git(["rev-parse", "feature/colleague"], remote), original);
  assert.ok(calls.some((args) => args[0] === "pr" && args[1] === "create" && args.includes(repairBranch)));
});

test("orch continue restores PR push authority and pushes the owned repair branch", async () => {
  const repo = initGitRepo("orch-pr-continue-authority-");
  const { remote } = addOriginWithPeer(repo);
  const sid = "prresume";
  const sourceBranch = "pr-9";
  const remoteBranch = "feature/colleague";
  gitDep.git(["checkout", "-b", sourceBranch], repo);
  writeFileSync(join(repo, "pr.txt"), "PR head\n");
  gitDep.git(["add", "pr.txt"], repo);
  gitDep.git(["commit", "-m", "PR head"], repo);
  gitDep.git(["push", "origin", `${sourceBranch}:refs/heads/${remoteBranch}`], repo);
  gitDep.git(["checkout", "main"], repo);
  const head = gitDep.git(["rev-parse", sourceBranch], repo);
  const orchDir = join(repo, ".orch");
  const prTarget = {
    number: 9,
    originalNumber: 9,
    branch: sourceBranch,
    sourceBranch,
    remoteBranch,
    headRefName: remoteBranch,
    headRefOid: head,
    baseBranch: "main",
    canPushHead: false,
    needsRepairBranch: true,
    ephemeral: true,
  };
  checkpointDep.record(orchDir, sid, {
    branch: sourceBranch, round: 1, stage: "reviewed", decision: "AGREE", reason: "looks good",
    author: { agent: "claude" }, reviewers: [{ agent: "codex" }],
  });
  runRecordDep.create(orchDir, {
    runId: sid, command: "pr", argv: ["pr", "9", "--until", "ready"],
    policy: { until: "ready", maxAttempts: 1 }, prTarget,
  });

  const repairBranch = `pr/repair/9-${sid}`;
  const pushes = [];
  let repaired = false;
  const baseCycleDeps = fakeCycleDeps();
  const cycleDeps = {
    ...baseCycleDeps,
    git: {
      ...baseCycleDeps.git,
      gitTry(args, cwd) {
        if (args[0] === "push") pushes.push({ args, cwd });
        return gitDep.gitTry(args, cwd);
      },
    },
  };
  const gh = (args) => {
    if (args[0] === "pr" && args[1] === "view") {
      const number = String(args[2]);
      return JSON.stringify({
        number: Number(number), state: "OPEN", isDraft: false, headRefOid: head,
        baseRefName: "main", mergeable: "MERGEABLE", mergeStateStatus: number === "9" && !repaired ? "BEHIND" : "CLEAN",
        reviewDecision: null, statusCheckRollup: [],
      });
    }
    if (args[0] === "pr" && args[1] === "list") return "[]";
    if (args[0] === "pr" && args[1] === "create") return "https://github.com/o/r/pull/42\n";
    if (args[0] === "api" && args.some((arg) => String(arg).endsWith("/update-branch"))) {
      repaired = true;
      return "{}";
    }
    if (args[0] === "api") return "[]";
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };

  await runMainInRepo(repo, ["continue", sid, "--no-tidy"], {
    cycleDeps,
    githubDeps: () => ({ gh, git: gitDep.git }),
    sleep: async () => {},
  });

  const pushedRefs = pushes.map(({ args }) => args[args.indexOf("origin") + 1].split(":").at(-1));
  assert.ok(pushedRefs.includes(`refs/heads/${repairBranch}`), "resume must push the owned repair branch");
  assert.ok(!pushedRefs.includes(`refs/heads/${remoteBranch}`), "resume must not push the contributor branch");
  assert.equal(gitDep.git(["rev-parse", remoteBranch], remote), head, "the contributor branch must remain untouched");
  const record = JSON.parse(readFileSync(join(orchDir, "run-records", `${sid}.json`), "utf8"));
  assert.equal(record.prTarget.remoteBranch, repairBranch, "the persisted target must follow the repair branch");
});

test("resumable numeric PR runs keep their ephemeral source branch for continue", async () => {
  const savedExitCode = process.exitCode;
  const repo = initGitRepo("orch-pr-resumable-branch-");
  const { remote } = addOriginWithPeer(repo);
  const sourceBranch = "feature/colleague";
  gitDep.git(["checkout", "-b", sourceBranch], repo);
  writeFileSync(join(repo, "pr.txt"), "PR head\n");
  gitDep.git(["add", "pr.txt"], repo);
  gitDep.git(["commit", "-m", "PR head"], repo);
  gitDep.git(["push", "origin", sourceBranch], repo);
  const head = gitDep.git(["rev-parse", sourceBranch], repo);
  gitDep.git(["update-ref", "refs/pull/123/head", head], remote);
  gitDep.git(["checkout", "main"], repo);
  mkdirSync(join(repo, ".orch"), { recursive: true });
  writeFileSync(join(repo, ".orch", "orch.yml"), "automation:\n  remedies: [ask]\n  humanWaitHours: 0.000001\n");

  let secondRun = false;
  const gh = (args) => {
    if (args[0] === "--version") return "gh 2";
    if (args[0] === "auth" && args[1] === "status") return "Logged in";
    if (args[0] === "pr" && args[1] === "view") return JSON.stringify({
      number: 123, state: "OPEN", headRefName: sourceBranch, headRefOid: head,
      baseRefName: "main", isCrossRepository: false, maintainerCanModify: true,
      isDraft: false, url: "https://github.com/o/r/pull/123",
    });
    if (args[0] === "pr" && args[1] === "list") return JSON.stringify([{
      number: 123, url: "https://github.com/o/r/pull/123", isDraft: false, headRefOid: head,
    }]);
    if (args[0] === "api" && args[1] === "repos/{owner}/{repo}") return JSON.stringify({ permissions: { push: true } });
    if (args[0] === "api" && String(args[1]).includes("collaborators/")) return JSON.stringify({ permission: "write" });
    if (args[0] === "api" && args.some((arg) => String(arg).includes("/comments"))) {
      if (args.includes("-X") && args.includes("POST")) return JSON.stringify({ id: 1 });
      return secondRun ? JSON.stringify([{ id: 2, body: "orch: abandon", user: { login: "maintainer", type: "User" } }]) : "[]";
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  const cycleDeps = {
    ...fakeCycleDeps(),
    checkpoint: checkpointDep,
    adapters: { get: (name) => ({ name, async audit() { return { decision: "DISAGREE", reason: "needs work", raw: "" }; } }) },
  };
  let nowCalls = 0;
  const deps = {
    cycleDeps,
    githubDeps: () => ({ gh, git: gitDep.git }),
    sleep: async () => {},
    now: () => (nowCalls++ === 0 ? 0 : 1_000_000),
  };

  try {
    const logs = await runMainInRepo(repo, ["pr", "123", "--until", "ready", "--json"], deps);
    const recordDir = join(repo, ".orch", "run-records");
    const record = JSON.parse(readFileSync(join(recordDir, readdirSync(recordDir)[0]), "utf8"));
    assert.equal(record.outcome, "wait-timeout");
    assert.equal(record.prTarget.remoteBranch, sourceBranch, "the PR target must be persisted for continue");
    assert.ok(gitDep.branchExists(repo, "pr-123"), "a resumable run must keep its ephemeral source branch");
    assert.match(logs.join("\n"), new RegExp(`orch continue ${record.runId}`));

    secondRun = true;
    const resumedLogs = await runMainInRepo(repo, ["continue", record.runId, "--no-tidy"], deps);
    assert.match(resumedLogs.join("\n"), /escalated/);
  } finally {
    process.exitCode = savedExitCode;
  }
});

test("a flag not read by the command is rejected", async () => {
  // Every command declares the flags it actually reads (COMMAND_FLAGS); anything
  // else parsed and vanished, which reads to a human as "run and merge" (--merge)
  // or "load this config" (--config-file) while nothing of the sort happens.
  // Reject loudly instead of dropping it. The check sits ahead of the commands
  // that return early (version/help/upgrade), or they exit 0 with the flag
  // dropped — exactly the silent lie the guard exists to prevent.
  const cases = [
    [["issue", "42", "--merge"], /--merge is not valid with 'orch issue'/],
    [["task", "x", "--merge"], /--merge is not valid with 'orch task'/],
    [["review", "b", "--merge"], /--merge is not valid with 'orch review'/],
    [["version", "--merge"], /--merge is not valid with 'orch version'/],
    [["help", "--merge"], /--merge is not valid with 'orch help'/],
    [["upgrade", "--merge"], /--merge is not valid with 'orch upgrade'/],
    [["update", "--merge"], /--merge is not valid with 'orch update'/],
    // ...including on `pr` itself: --help/--version short-circuit main() before
    // runPr, so `orch pr 42 --merge --help` would print usage and exit 0 having
    // merged nothing. Asking to merge and asking what the tool is are
    // contradictory requests; neither one silently wins.
    [["pr", "42", "--merge", "--help"], /--merge is not valid with 'orch help'/],
    [["pr", "42", "--merge", "-h"], /--merge is not valid with 'orch help'/],
    [["pr", "42", "--merge", "--version"], /--merge is not valid with 'orch version'/],
    // ...and the same rule for every other flag, not just --merge. `--dry` is
    // legal on `pr`/`release`/`init` (they plan without writing), so the
    // not-read flag exercised here is one those commands genuinely ignore.
    [["pr", "5", "--cheap"], /--cheap is not valid with 'orch pr'/],
    [["release", "x", "--cheap"], /--cheap is not valid with 'orch release'/],
    [["init", "--cheap"], /--cheap is not valid with 'orch init'/],
    [["dashboard", "--config-file", "x.yml"], /--config-file is not valid with 'orch dashboard'/],
    [["task", "x", "--limit", "3"], /--limit is not valid with 'orch task'/],
    // --file is read by `task` only: `orch issue 1 --file f` used to parse and
    // drop it, so the run silently used the issue body instead of the file.
    [["issue", "1", "--file", "f"], /--file is not valid with 'orch issue'/],
    // Read-only commands get the sharper message: --dry cannot "plan" a command
    // that changes nothing. `config` is NOT one of these — runConfigWizard
    // writes .orch/orch.yml, so it is a mutating command; --dry IS one of its
    // flags (see "orch config --dry prints the plan..." below) rather than
    // being rejected outright.
    [["dashboard", "--dry"], /--dry has no effect on 'orch dashboard'/],
  ];
  for (const [argv, message] of cases) {
    await assert.rejects(
      () => runMainCapture(argv, { upgradeDeps: { exec: () => assert.fail("upgrade ran despite a bad flag") } }),
      message,
      argv.join(" "),
    );
  }
  await assert.rejects(
    () => runMainCapture(["pr", "42", "--merge", "--until", "ready", "--dry"]),
    (e) => e.exit === 64 && /--merge is an alias for --until merged/.test(e.message),
  );
  // The message points at where the flag IS legal.
  await assert.rejects(() => runMainCapture(["issue", "42", "--merge"]), /only with: orch pr/);
  // ...and a flag stays legal where it is actually consumed: `pr` gets past the
  // guard and fails on its own usage check instead.
  await assert.rejects(() => runMainCapture(["pr", "abc", "--merge"]), /usage: orch pr <number>/);
});

test("COMMAND_FLAGS only names flags that exist", () => {
  // A typo'd entry (`config_file`) would reject a *legal* flag on that command —
  // the one hard break this guard can introduce. Same for a flag added to
  // PARSE_OPTIONS and never added here: it becomes rejected everywhere.
  const known = new Set(Object.keys(PARSE_OPTIONS));
  const named = new Set();
  for (const [command, names] of Object.entries(COMMAND_FLAGS)) {
    for (const name of names) {
      assert.ok(known.has(name), `orch ${command}: unknown flag --${name}`);
      named.add(name);
    }
  }
  for (const name of known) {
    if (name === "help" || name === "version") continue; // legal on every command
    assert.ok(named.has(name), `--${name} is in PARSE_OPTIONS but no command accepts it`);
  }
});

test("dashboard rejects a non-numeric or non-positive --limit", async () => {
  await assert.rejects(() => runMainCapture(["dashboard", "--limit", "nope"]), /--limit must be a positive integer/);
  await assert.rejects(() => runMainCapture(["dashboard", "--limit", "0"]), /--limit must be a positive integer/);
});

async function runMainCapture(argv, deps = {}) {
  const d = mkdtempSync(join(tmpdir(), "orch-mc-"));
  const prev = cwd();
  chdir(d);
  const logs = [];
  const origLog = console.log;
  console.log = (...args) => logs.push(args.map(String).join(" "));
  try {
    await main(argv, deps);
    return logs;
  } finally {
    console.log = origLog;
    chdir(prev);
  }
}

function initGitRepo(prefix = "orch-main-") {
  const d = mkdtempSync(join(tmpdir(), prefix));
  gitDep.git(["init", "-b", "main"], d);
  gitDep.git(["config", "user.email", "t@t"], d);
  gitDep.git(["config", "user.name", "t"], d);
  // core.autocrlf defaults to true on Windows git and rewrites LF to CRLF on
  // checkout, which would make file-content assertions platform-dependent.
  gitDep.git(["config", "core.autocrlf", "false"], d);
  writeFileSync(join(d, "a.txt"), "1\n");
  gitDep.git(["add", "."], d);
  gitDep.git(["commit", "-m", "init"], d);
  return d;
}

function initGitRepoOn(branch, prefix = "orch-main-") {
  const d = mkdtempSync(join(tmpdir(), prefix));
  gitDep.git(["init", "-b", branch], d);
  gitDep.git(["config", "user.email", "t@t"], d);
  gitDep.git(["config", "user.name", "t"], d);
  gitDep.git(["config", "core.autocrlf", "false"], d);
  writeFileSync(join(d, "a.txt"), "1\n");
  gitDep.git(["add", "."], d);
  gitDep.git(["commit", "-m", "init"], d);
  return d;
}

function addOriginWithPeer(repo) {
  const remote = mkdtempSync(join(tmpdir(), "orch-cli-remote-"));
  gitDep.git(["init", "--bare", "-b", "main"], remote);
  gitDep.git(["remote", "add", "origin", remote], repo);
  gitDep.git(["push", "-u", "origin", "main"], repo);
  const parent = mkdtempSync(join(tmpdir(), "orch-cli-peer-"));
  const peer = join(parent, "repo");
  gitDep.git(["clone", remote, peer], parent);
  gitDep.git(["config", "user.email", "t@t"], peer);
  gitDep.git(["config", "user.name", "t"], peer);
  gitDep.git(["config", "core.autocrlf", "false"], peer);
  return { remote, peer };
}

function fakeCycleDeps() {
  const verdict = { decision: "AGREE", reason: "ok", raw: "", usage: { model: "gpt-test-review", tokens: 20 } };
  return {
    adapters: { get: (name) => ({ name, async author() { return { usage: { model: "gpt-test-author", tokens: 40 } }; }, async audit() { return verdict; } }) },
    git: { ...gitDep, changedFiles: () => ["a.txt"] },
    gate: { detect: () => "true", run: () => ({ pass: true, log: "" }) },
    scope: { count: () => 0 },
    notify: { phase() {}, writeRound() {}, escalate() {}, buildDecisionBrief() { return ""; } },
    inflight: { setPaths() {} },
    finalize: async () => ({ status: "merged", reason: "test", sha: "abc" }),
  };
}

async function runMainInRepo(repo, argv, deps = {}) {
  const prev = cwd();
  chdir(repo);
  const logs = [];
  const origLog = console.log;
  console.log = (...args) => logs.push(args.map(String).join(" "));
  try {
    await main(argv, { preflight() {}, cycleDeps: fakeCycleDeps(), ...deps });
    return logs;
  } finally {
    console.log = origLog;
    chdir(prev);
  }
}

// The live TUI gate (task 6 of docs/tui-design.md): the loop runs ONLY on a
// genuine interactive terminal; every scriptable path stays the byte-identical
// one-shot render(). tuiRun is injected so node:test never touches a real TTY.
const failIfLive = () => { throw new Error("live TUI must not run for scriptable paths"); };

test("dashboard enters the live TUI on an interactive terminal", async () => {
  let called = null;
  const logs = await runMainCapture(["dashboard"], {
    stdout: { isTTY: true }, stdin: { isTTY: true },
    tuiRun: (orchDir, opts) => { called = { orchDir, opts }; },
  });
  assert.ok(called, "run() should be invoked");
  assert.match(called.orchDir, /\.orch$/);
  assert.equal(called.opts.refreshMs, 1000);
  assert.deepEqual(logs, []); // no static print when the TUI takes over
});

test("dashboard --refresh-ms passes the poll interval to the live loop", async () => {
  let opts = null;
  await runMainCapture(["dashboard", "--refresh-ms", "250"], {
    stdout: { isTTY: true }, stdin: { isTTY: true },
    tuiRun: (_orchDir, o) => { opts = o; },
  });
  assert.equal(opts.refreshMs, 250);
});

test("dashboard forwards --limit/--check-history to the live loop", async () => {
  let opts = null;
  await runMainCapture(["dashboard", "--limit", "5", "--check-history"], {
    stdout: { isTTY: true }, stdin: { isTTY: true },
    tuiRun: (_orchDir, o) => { opts = o; },
  });
  assert.equal(opts.historyLimit, 5);
  assert.equal(opts.checkHistory, true);
});

test("dashboard stays one-shot for a non-TTY stdout", async () => {
  const logs = await runMainCapture(["dashboard"], {
    stdout: { isTTY: false }, stdin: { isTTY: true }, tuiRun: failIfLive,
  });
  assert.ok(logs.length >= 1); // static render printed, TUI never ran
});

test("dashboard --once forces the static print even on a TTY", async () => {
  const logs = await runMainCapture(["dashboard", "--once"], {
    stdout: { isTTY: true }, stdin: { isTTY: true }, tuiRun: failIfLive,
  });
  assert.ok(logs.length >= 1);
});

test("dashboard --plain aliases --once", async () => {
  const logs = await runMainCapture(["dashboard", "--plain"], {
    stdout: { isTTY: true }, stdin: { isTTY: true }, tuiRun: failIfLive,
  });
  assert.ok(logs.length >= 1);
});

test("dashboard --json stays one-shot on a TTY", async () => {
  const logs = await runMainCapture(["dashboard", "--json"], {
    stdout: { isTTY: true }, stdin: { isTTY: true }, tuiRun: failIfLive,
  });
  assert.doesNotThrow(() => JSON.parse(logs.join("\n")));
});

test("dashboard --once reproduces the non-TTY static output byte-for-byte", async () => {
  const d = mkdtempSync(join(tmpdir(), "orch-dash-"));
  const plain = await runMainInRepo(d, ["dashboard"], { stdout: { isTTY: false }, stdin: { isTTY: false }, tuiRun: failIfLive });
  const once = await runMainInRepo(d, ["dashboard", "--once"], { stdout: { isTTY: true }, stdin: { isTTY: true }, tuiRun: failIfLive });
  assert.deepEqual(once, plain);
  assert.ok(plain.length >= 1);
});

test("task branch includes a sid suffix", async () => {
  const logs = await runMainCapture(["task", "do a thing", "--dry"]);
  assert.match(logs.join("\n"), /pr\/[a-z]+\/do-a-thing-\d+-[0-9a-z]+:/);
});

test("--cheap flag routes the task branch through cheap.role's agent", async () => {
  const d = mkdtempSync(join(tmpdir(), "orch-cheap-"));
  writeFileSync(join(d, "orch.yml"), "cheap:\n  role: qwen3-coder-30b\n");
  const prev = cwd();
  chdir(d);
  const logs = [];
  const origLog = console.log;
  console.log = (...args) => logs.push(args.map(String).join(" "));
  try {
    await main(["task", "do a thing", "--cheap", "--dry"]);
    assert.match(logs.join("\n"), /pr\/qwen3-coder-30b\//);
  } finally {
    console.log = origLog;
    chdir(prev);
  }
});

test("--cheap without cheap.role in orch.yml surfaces a clear error", async () => {
  const d = mkdtempSync(join(tmpdir(), "orch-cheap-noconf-"));
  const prev = cwd();
  chdir(d);
  try {
    await assert.rejects(main(["task", "do a thing", "--cheap", "--dry"]), /cheap.role must be set/);
  } finally {
    chdir(prev);
  }
});

test("a --file work order whose suspected_paths match cheap.paths auto-routes", async () => {
  const d = mkdtempSync(join(tmpdir(), "orch-cheap-auto-"));
  writeFileSync(join(d, "orch.yml"), "cheap:\n  role: qwen3-coder-30b\n  paths: [\"docs/**\"]\n");
  const wo = { title: "fix typo", problem: "docs typo", repro_steps: [], suspected_paths: ["docs/guide.md"], acceptance_criteria: [] };
  writeFileSync(join(d, "wo.json"), JSON.stringify(wo));
  const prev = cwd();
  chdir(d);
  const logs = [];
  const origLog = console.log;
  console.log = (...args) => logs.push(args.map(String).join(" "));
  try {
    await main(["task", "--file", "wo.json", "--dry"]);
    assert.match(logs.join("\n"), /pr\/qwen3-coder-30b\//);
  } finally {
    console.log = origLog;
    chdir(prev);
  }
});

test("over the concurrency cap, a cycle is skipped (not blocked)", async () => {
  const savedExitCode = process.exitCode; // save before test body so finally can restore, not force 0
  const d = mkdtempSync(join(tmpdir(), "orch-cap-"));
  const prev = cwd();
  chdir(d);
  try {
    execFileSync("git", ["init", "-b", "main"], { cwd: d });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: d });
    execFileSync("git", ["config", "user.name", "t"], { cwd: d });
    execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: d });
    execFileSync("git", ["checkout", "-b", "work"], { cwd: d });
    const orchDir = join(d, ".orch");
    mkdirSync(orchDir, { recursive: true });
    for (let i = 0; i < 4; i++) {
      inflight.register(orchDir, `cap-seed-${i}`, { branch: `pr/test/b-${i}`, pid: process.pid, baseSha: "abc" });
    }
    process.exitCode = 0;
    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.map(String).join(" "));
    try {
      await main(["task", "some task"], { preflight() {} });
    } finally {
      console.log = origLog;
    }
    // 3, not 2: the cap is a capacity refusal (nothing ran, retry later), while
    // 2 means a cycle really ran and did not agree. A caller that retries a 3
    // is right to; a caller that retries a 2 just burns another cycle.
    assert.equal(process.exitCode, 3);
    assert.match(logs.join("\n"), /concurrency cap 4 reached/);
  } finally {
    chdir(prev);
    process.exitCode = savedExitCode; // restore instead of unconditionally forcing 0
  }
});

test("registerWithConcurrencyCap removes the rejected run", () => {
  const orchDir = mkdtempSync(join(tmpdir(), "orch-cap-helper-"));
  inflight.register(orchDir, "cap-peer", { branch: "pr/test/peer", pid: process.pid, baseSha: "abc" });
  const exceeded = [];

  try {
    assert.equal(
      registerWithConcurrencyCap(
        orchDir,
        "cap-current",
        { branch: "pr/test/current", pid: process.pid, baseSha: "abc" },
        { concurrency: 1 },
        { onExceeded: (live) => exceeded.push(live) },
      ),
      false,
    );
    assert.deepEqual(exceeded, [2]);
    assert.equal(inflight.countLive(orchDir), 1);
  } finally {
    inflight.deregister(orchDir, "cap-peer");
    inflight.deregister(orchDir, "cap-current");
  }
});

// A single invocation's author fan-out can see BOTH an escalation (2, a cycle
// ran and needs review) and a concurrency-cap skip (3, nothing ran, safe to
// retry) if a concurrent peer process pushes a later run over the cap — see
// the "3, not 2" comment on the cap test above. process.exitCode is a single
// global the loop assigns per-run; last-write-wins would let whichever run
// finishes last decide the reported code regardless of severity. These are
// hand-computed against the documented priority (2 must survive a later 3;
// a later 2 must still win over an earlier 3), not observed from the code.
test("raiseExitCode: 2 (needs review) always wins over 3 (safe to retry), in either order", () => {
  const saved = process.exitCode;
  try {
    process.exitCode = 0;
    raiseExitCode(2);
    raiseExitCode(3);
    assert.equal(process.exitCode, 2, "a later 3 must not downgrade an earlier 2");

    process.exitCode = 0;
    raiseExitCode(3);
    raiseExitCode(2);
    assert.equal(process.exitCode, 2, "a later 2 must still win over an earlier 3");

    process.exitCode = 0;
    raiseExitCode(3);
    assert.equal(process.exitCode, 3, "3 alone is still reported");
  } finally {
    process.exitCode = saved;
  }
});

// Regression: 1 (ERROR) and 4 (WAIT_TIMEOUT) — both real run-controller.js
// exit codes reachable via raiseExitCode(controller.exit) — were missing from
// EXIT_CODE_PRIORITY. An unlisted code's priority falls back to 0 via `|| 0`,
// identical to "nothing raised yet" (process.exitCode starts at 0), so
// raiseExitCode(1) alone used to leave process.exitCode at 0 — a run that hit
// an internal error would report success. 1 must win over everything; 4 must
// still lose to nothing and beat 3 (a landed-but-timed-out run is more
// actionable than a bare capacity refusal).
test("raiseExitCode: 1 (error) always wins; 4 (wait-timeout) beats 3", () => {
  const saved = process.exitCode;
  try {
    process.exitCode = 0;
    raiseExitCode(1);
    assert.equal(process.exitCode, 1, "1 alone must be reported, not silently dropped");

    process.exitCode = 0;
    raiseExitCode(2);
    raiseExitCode(1);
    assert.equal(process.exitCode, 1, "1 must win over an earlier 2");

    process.exitCode = 0;
    raiseExitCode(1);
    raiseExitCode(2);
    assert.equal(process.exitCode, 1, "a later 2 must not downgrade an earlier 1");

    process.exitCode = 0;
    raiseExitCode(4);
    assert.equal(process.exitCode, 4, "4 alone must be reported, not silently dropped");

    process.exitCode = 0;
    raiseExitCode(3);
    raiseExitCode(4);
    assert.equal(process.exitCode, 4, "4 must win over an earlier 3");

    process.exitCode = 0;
    raiseExitCode(4);
    raiseExitCode(3);
    assert.equal(process.exitCode, 4, "a later 3 must not downgrade an earlier 4");
  } finally {
    process.exitCode = saved;
  }
});

test("orch task can run while the operator checkout stays on main", async () => {
  const repo = initGitRepo();
  const logs = await runMainInRepo(repo, ["task", "some task", "--no-tidy"]);
  assert.equal(gitDep.git(["rev-parse", "--abbrev-ref", "HEAD"], repo), "main");
  assert.doesNotMatch(logs.join("\n"), /main is reserved/);
  assert.match(logs.join("\n"), /orch: pr\/claude\/some-task-\d+-[0-9a-z]+: merged \(test\)/);
  assert.match(logs.join("\n"), /after 1 round\(s\).*; cost 60 tokens/);
});

test("orch task uses configured baseBranch in a repo without main", async () => {
  const repo = initGitRepoOn("dev", "orch-dev-base-");
  mkdirSync(join(repo, ".orch"), { recursive: true });
  writeFileSync(join(repo, ".orch", "orch.yml"), "baseBranch: dev\n");

  const logs = await runMainInRepo(repo, ["task", "some task", "--no-tidy"]);

  assert.throws(() => gitDep.git(["rev-parse", "--verify", "main"], repo), /Needed a single revision|unknown revision|ambiguous argument/);
  assert.equal(gitDep.git(["rev-parse", "--abbrev-ref", "HEAD"], repo), "dev");
  assert.match(logs.join("\n"), /orch: pr\/claude\/some-task-\d+-[0-9a-z]+: merged \(test\)/);
});

test("orch task fast-forwards stale local main from origin before branching", async () => {
  const repo = initGitRepo();
  const { peer } = addOriginWithPeer(repo);
  writeFileSync(join(peer, "remote.txt"), "remote\n");
  gitDep.git(["add", "."], peer);
  gitDep.git(["commit", "-m", "advance remote"], peer);
  gitDep.git(["push", "origin", "main"], peer);

  // This repo now has a real (local-peer) origin remote, so the new
  // pre-flight gh-auth gate (added alongside #136's fix — a real merge
  // in the default no-ff path can reach the gh-backed integration-PR
  // step regardless of merge mode) will call gh. Stub it instead of
  // letting the test shell out to whatever gh session happens to exist
  // on the host — a real network/auth call has no place in a unit test.
  const gh = (args) => args[0] === "--version" ? "gh 2" : "Logged in to github.com";
  const logs = await runMainInRepo(repo, ["task", "some task", "--no-tidy"], {
    githubDeps: () => ({ gh, git: gitDep.git }),
  });

  assert.equal(gitDep.git(["rev-parse", "main"], repo), gitDep.git(["rev-parse", "origin/main"], repo));
  assert.equal(readFileSync(join(repo, "remote.txt"), "utf8"), "remote\n");
  assert.equal(gitDep.git(["rev-parse", "--abbrev-ref", "HEAD"], repo), "main");
  assert.match(logs.join("\n"), /fast-forwarded local main from origin\/main/);
});

test("orch task branch naming is independent of an existing orch slug branch", async () => {
  const repo = initGitRepo();
  gitDep.git(["branch", "orch/some-task"], repo);
  gitDep.git(["branch", "orch/some-task-2"], repo);
  const logs = await runMainInRepo(repo, ["task", "some task", "--no-tidy"]);
  assert.equal(gitDep.git(["rev-parse", "--abbrev-ref", "HEAD"], repo), "main");
  assert.match(logs.join("\n"), /orch: pr\/claude\/some-task-\d+-[0-9a-z]+: merged \(test\)/);
});

test("#44: a merged task run hands cycle branches to finishRun for tidy-up", async () => {
  const repo = initGitRepo();
  const calls = [];
  await runMainInRepo(repo, ["task", "some task"], { finishRun: async (ctx) => { calls.push(ctx); } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].task, "some task");
  assert.match(calls[0].merged[0], /^pr\/claude\/some-task-/);
  assert.equal(calls[0].integrationBranch, "orch/integration");
  assert.deepEqual(calls[0].runStats, [
    { role: "author", agent: "claude", model: "gpt-test-author", tokens: 40 },
    { role: "reviewer", agent: "codex", model: "gpt-test-review", tokens: 20 },
  ]);
});

test("task status line surfaces the clean unattended cycle streak", async () => {
  const repo = initGitRepo();
  notify.recordRun(join(repo, ".orch"), { ts: "1", branch: "seed", verdict: "merged", rounds: 1 });
  const logs = await runMainInRepo(repo, ["task", "some task", "--no-tidy"]);
  assert.match(logs.join("\n"), /clean unattended cycles: 1/);
});

test("#44: --no-tidy skips post-run cleanup entirely", async () => {
  const repo = initGitRepo();
  const calls = [];
  await runMainInRepo(repo, ["task", "some task", "--no-tidy"], { finishRun: async (ctx) => { calls.push(ctx); } });
  assert.equal(calls.length, 0);
});

test("#44: a non-merged (escalated) run is not handed to finishRun", async () => {
  const savedExitCode = process.exitCode; // escalated sets exitCode 2 — restore so it doesn't fail the suite
  const repo = initGitRepo();
  const calls = [];
  const escalating = { ...fakeCycleDeps(), finalize: async () => ({ status: "escalated", reason: "stalemate", sha: "x" }) };
  try {
    await runMainInRepo(repo, ["task", "some task"], { cycleDeps: escalating, finishRun: async (ctx) => { calls.push(ctx); } });
    assert.equal(calls.length, 0);
  } finally {
    process.exitCode = savedExitCode;
  }
});

test("orch task already off main leaves cwd branch unchanged", async () => {
  const repo = initGitRepo();
  gitDep.git(["switch", "-c", "work"], repo);
  const logs = await runMainInRepo(repo, ["task", "some task", "--no-tidy"]);
  assert.equal(gitDep.git(["rev-parse", "--abbrev-ref", "HEAD"], repo), "work");
  assert.doesNotMatch(logs.join("\n"), /created and switched/);
});

test("orch task on main leaves uncommitted cwd changes in place", async () => {
  const repo = initGitRepo();
  writeFileSync(join(repo, "a.txt"), "dirty\n");
  writeFileSync(join(repo, "scratch.txt"), "untracked\n");
  await runMainInRepo(repo, ["task", "touch dirty", "--no-tidy"]);
  assert.equal(gitDep.git(["rev-parse", "--abbrev-ref", "HEAD"], repo), "main");
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "dirty\n");
  assert.equal(readFileSync(join(repo, "scratch.txt"), "utf8"), "untracked\n");
  const status = gitDep.git(["status", "--porcelain"], repo);
  assert.match(status, /M a\.txt/);
  assert.match(status, /\?\? scratch\.txt/);
});

test("--help / -h print usage and exit cleanly (no unknown-option error)", async () => {
  for (const flag of ["--help", "-h"]) {
    assert.doesNotThrow(() => parse([flag])); // node:util parseArgs must not reject it
    const logs = [];
    const orig = console.log;
    console.log = (m) => logs.push(m);
    try {
      await main([flag], { preflight() {} }); // must not throw, must not shell out
    } finally {
      console.log = orig;
    }
    const usage = logs.join("\n");
    assert.match(usage, /^orch - Run coding agents in an author, review, test, and merge loop\./);
    assert.match(usage, /Usage: orch <command> \[options\]/);
    assert.match(usage, /\nCommands:\n  init\s+Scaffold \.orch\/orch\.yml/);
    assert.match(usage, /\nOptions:\n  -h, --help\s+Show this help\./);
    assert.match(usage, /\nExamples:\n  orch init --link/);
    assert.match(usage, /Full docs: see \.orch\/ORCH\.md in initialized repos and the README\./);
    assert.doesNotMatch(usage, /\n\s+\(/);
    for (const line of usage.split("\n")) {
      assert.ok(line.length <= 80, `usage line exceeds 80 columns: ${line}`);
    }
  }
});

// Split a help example into argv the same way a shell would for simple quoted tokens.
function argvFromHelpExample(line) {
  const body = line.trim().replace(/^orch\s+/, "");
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|\S+/g;
  let m;
  while ((m = re.exec(body))) tokens.push(m[1] ?? m[2] ?? m[0]);
  return tokens;
}

test("printUsage examples all parse and accept role overrides as shown (A5)", async () => {
  const logs = [];
  const orig = console.log;
  console.log = (m) => logs.push(m);
  try {
    await main(["help"], { preflight() {} });
  } finally {
    console.log = orig;
  }
  const usage = logs.join("\n");
  const exampleBlock = usage.split("\nExamples:\n")[1]?.split("\n\n")[0] || "";
  const examples = exampleBlock.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("orch "));
  assert.ok(examples.length >= 4, `expected help examples, got: ${examples.join(" | ")}`);
  assert.ok(examples.some((e) => e.includes("--reviewer")), "help still shows the reviewer-only task example");

  const baseCfg = {
    agents: ["claude", "codex"],
    author: null, reviewer: null, authors: null, reviewers: null,
  };
  for (const line of examples) {
    const argv = argvFromHelpExample(line);
    const { command, flags } = parse(argv);
    assert.ok(command, `example produced no command: ${line}`);
    // Same allowReviewerOnly policy task/issue/review share after D2.
    assert.doesNotThrow(
      () => applyRoleOverrides(baseCfg, flags, { allowReviewerOnly: true }),
      `example failed role-override parse: ${line}`,
    );
  }
});

test("init scaffold active keys match orch.example.yml (B12)", async () => {
  const d = mkdtempSync(join(tmpdir(), "orch-scaffold-parity-"));
  const prev = cwd();
  const examplePath = join(prev, "orch.example.yml");
  // Tests run from the package root; fall back to this file's ../orch.example.yml.
  const exampleText = existsSync(examplePath)
    ? readFileSync(examplePath, "utf8")
    : readFileSync(new URL("../orch.example.yml", import.meta.url), "utf8");
  chdir(d);
  try {
    await main(["init"], { preflight() {}, detectAgents: () => ({ found: [], missing: [] }) });
    const scaffold = parseYamlKeys(readFileSync(join(d, ".orch", "orch.yml"), "utf8"));
    const example = parseYamlKeys(exampleText);
    assert.deepEqual(scaffold, example);
  } finally {
    chdir(prev);
  }
});

// Collect top-level and nested object keys from a YAML document (ignores comments).
function parseYamlKeys(text) {
  const doc = parseYaml(text) || {};
  const keys = [];
  function walk(obj, prefix = "") {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return;
    for (const [k, v] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${k}` : k;
      keys.push(path);
      if (v && typeof v === "object" && !Array.isArray(v)) walk(v, path);
    }
  }
  walk(doc);
  return keys.sort();
}

test("task --reviewer-only forces reviewers while rotating the author (D2)", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-reviewer-only-"));
  const base = {
    agents: ["claude", "codex"],
    author: null, reviewer: null, authors: null, reviewers: null,
  };
  // Without the flag pair, reviewer-only still throws.
  assert.throws(
    () => applyRoleOverrides(base, { reviewer: "codex" }, { allowReviewerOnly: false }),
    /set both --author\(s\) and --reviewer\(s\)/,
  );
  const cfg = applyRoleOverrides(base, { reviewer: "codex" }, { allowReviewerOnly: true });
  assert.equal(cfg.authors, null);
  assert.deepEqual(cfg.reviewers, ["codex"]);
  const picked = nextAuthor(cfg, d);
  assert.equal(picked.authorName, "claude"); // rotation author
  assert.deepEqual(picked.reviewerNames, ["codex"]); // forced reviewer, not rotation's codex-by-chance alone
  assert.deepEqual(picked.reviewers, [{ agent: "codex", model: null, effort: null }]);
});

import { resolveTaskBranch } from "../src/cli.js";

function resumeStubs({ record = null, exists = true, changed = ["a"] }) {
  const spy = { recorded: [], cleared: 0 };
  const deps = {
    git: { branchExists: () => exists, changedFiles: () => changed },
    resume: {
      lookup: () => record,
      record: (...a) => spy.recorded.push(a),
      clear: () => { spy.cleared++; },
    },
  };
  return { deps, spy };
}

test("resolveTaskBranch: no record -> fresh sid/branch, record written (#24)", () => {
  const { deps, spy } = resumeStubs({ record: null });
  const r = resolveTaskBranch({ repo: "/r", orchDir: "/o", task: "do x", authorName: "claude" }, deps);
  assert.equal(r.resume, false);
  assert.match(r.branch, /^pr\/claude\/do-x-\d+-[0-9a-z]+$/);
  assert.equal(spy.recorded.length, 1); // fresh run leaves a record to resume from
  assert.equal(spy.cleared, 0);
});

test("resolveTaskBranch: live branch with commits -> resume (#24)", () => {
  const rec = { branch: "pr/claude/do-x-9-z", sid: "9-z" };
  const { deps, spy } = resumeStubs({ record: rec, exists: true, changed: ["src/a.js"] });
  const r = resolveTaskBranch({ repo: "/r", orchDir: "/o", task: "do x", authorName: "claude" }, deps);
  assert.deepEqual(r, { sid: "9-z", branch: "pr/claude/do-x-9-z", resume: true });
  assert.equal(spy.recorded.length, 0); // resume reuses the record, doesn't rewrite
  assert.equal(spy.cleared, 0);
});

test("resolveTaskBranch: record but branch vanished -> clear stale, fresh (#24)", () => {
  const rec = { branch: "pr/claude/gone", sid: "1" };
  const { deps, spy } = resumeStubs({ record: rec, exists: false });
  const r = resolveTaskBranch({ repo: "/r", orchDir: "/o", task: "do x", authorName: "claude" }, deps);
  assert.equal(r.resume, false);
  assert.equal(spy.cleared, 1); // stale record dropped
});

test("resolveTaskBranch: record but no commits -> clear stale, fresh (#24)", () => {
  const rec = { branch: "pr/claude/empty", sid: "1" };
  const { deps, spy } = resumeStubs({ record: rec, exists: true, changed: [] });
  const r = resolveTaskBranch({ repo: "/r", orchDir: "/o", task: "do x", authorName: "claude" }, deps);
  assert.equal(r.resume, false);
  assert.equal(spy.cleared, 1); // mid-author abort before commit -> author fresh
});

test("resolveTaskBranch: recorded branch is a live peer -> no resume, no clobber (#24)", () => {
  const rec = { branch: "pr/claude/do-x-9-z", sid: "9-z" };
  const { deps, spy } = resumeStubs({ record: rec, exists: true, changed: ["a"] });
  const live = new Set(["pr/claude/do-x-9-z"]);
  const r = resolveTaskBranch({ repo: "/r", orchDir: "/o", task: "do x", authorName: "claude", liveBranches: live }, deps);
  assert.equal(r.resume, false); // don't hijack a concurrent live cycle
  assert.equal(spy.cleared, 0);  // and don't clear its record
});

test("resolveTaskBranch: escalated branch is terminal, so author fresh", () => {
  const orchDir = mkdtempSync(join(tmpdir(), "orch-escalated-resume-"));
  const branch = "pr/claude/do-x-9-z";
  const { deps, spy } = resumeStubs({ record: { branch, sid: "9-z" }, exists: true, changed: ["a"] });
  const decision = join(orchDir, "reviews", branch, "DECISION.md");
  mkdirSync(join(orchDir, "reviews", branch), { recursive: true });
  writeFileSync(decision, "# Decision needed\n");

  const r = resolveTaskBranch({ repo: "/r", orchDir, task: "do x", authorName: "claude" }, deps);
  assert.equal(r.resume, false); // a terminal escalation is not an interrupted run
  assert.notEqual(r.branch, branch);
  assert.equal(spy.cleared, 1); // stale resume state cannot trap a later rotation on this branch
});

test("resolveTaskBranch: a capped DISAGREE checkpoint is terminal without a decision marker", () => {
  const orchDir = mkdtempSync(join(tmpdir(), "orch-escalated-checkpoint-"));
  const branch = "pr/claude/do-x-9-z";
  const { deps, spy } = resumeStubs({ record: { branch, sid: "9-z" }, exists: true, changed: ["a"] });
  checkpointDep.record(orchDir, "9-z", { branch, round: 1, stage: "reviewed", decision: "DISAGREE" });

  const r = resolveTaskBranch({ repo: "/r", orchDir, task: "do x", authorName: "claude", roundCap: 1 }, deps);
  assert.equal(r.resume, false);
  assert.equal(spy.cleared, 1);
});

test("resolveTaskBranch: an uncheckable branch name is treated as escalated, not clean", () => {
  // notify.reviewsDir throws on a traversal name, so the escalation check cannot
  // answer. It must refuse the resume rather than default to "never escalated".
  const orchDir = mkdtempSync(join(tmpdir(), "orch-escalated-unsafe-"));
  const branch = "../escape";
  const { deps, spy } = resumeStubs({ record: { branch, sid: "9-z" }, exists: true, changed: ["a"] });

  const r = resolveTaskBranch({ repo: "/r", orchDir, task: "do x", authorName: "claude" }, deps);
  assert.equal(r.resume, false);
  assert.notEqual(r.branch, branch);
  assert.equal(spy.cleared, 1);
});

test("resolveTaskBranch: dry never reads or writes the store (#24)", () => {
  const { deps, spy } = resumeStubs({ record: { branch: "x", sid: "1" } });
  let looked = 0;
  deps.resume.lookup = () => { looked++; return { branch: "x", sid: "1" }; };
  const r = resolveTaskBranch({ repo: "/r", orchDir: "/o", task: "do x", authorName: "claude", dry: true }, deps);
  assert.equal(r.resume, false);
  assert.equal(looked, 0);
  assert.equal(spy.recorded.length, 0);
});

import { pinnedResumeAuthor } from "../src/cli.js";
import { branchExists, createTaskBranch, git as rawGit } from "../src/git.js";
function pinStubs({ records = [], exists = true, changed = ["a"] }) {
  return {
    git: { branchExists: () => exists, changedFiles: () => changed },
    resume: { lookupForTask: () => records },
  };
}

test("pinnedResumeAuthor pins the recorded author of a surviving committed branch (#27)", () => {
  // The rotation pool advanced to codex, but claude's killed branch still carries
  // committed work — pin claude regardless of the per-author key.
  const deps = pinStubs({ records: [{ author: "claude", branch: "pr/claude/do-x-1" }] });
  assert.equal(pinnedResumeAuthor({ repo: "/r", orchDir: "/o", task: "do x" }, deps), "claude");
});

test("pinnedResumeAuthor returns null when the branch has no committed work (#27)", () => {
  const deps = pinStubs({ records: [{ author: "claude", branch: "pr/claude/empty" }], changed: [] });
  assert.equal(pinnedResumeAuthor({ repo: "/r", orchDir: "/o", task: "do x" }, deps), null);
});

test("pinnedResumeAuthor ignores a branch that already escalated", () => {
  const orchDir = mkdtempSync(join(tmpdir(), "orch-escalated-pin-"));
  const branch = "pr/claude/do-x-1";
  mkdirSync(join(orchDir, "reviews", branch), { recursive: true });
  writeFileSync(join(orchDir, "reviews", branch, "DECISION.md"), "# Decision needed\n");
  const deps = pinStubs({ records: [{ author: "claude", branch }] });
  assert.equal(pinnedResumeAuthor({ repo: "/r", orchDir, task: "do x" }, deps), null);
  // Same refusal when the check cannot answer at all: reviewsDir throws on this name.
  assert.equal(pinnedResumeAuthor({ repo: "/r", orchDir, task: "do x" },
    pinStubs({ records: [{ author: "claude", branch: "../escape" }] })), null);
});

test("pinnedResumeAuthor skips a branch that is a live peer, and is null under dry (#27)", () => {
  const deps = pinStubs({ records: [{ author: "claude", branch: "pr/claude/do-x-1" }] });
  const live = new Set(["pr/claude/do-x-1"]);
  assert.equal(pinnedResumeAuthor({ repo: "/r", orchDir: "/o", task: "do x", liveBranches: live }, deps), null);
  assert.equal(pinnedResumeAuthor({ repo: "/r", orchDir: "/o", task: "do x", dry: true }, deps), null);
});

// The linchpin: a SIGKILL leaves a dead-pid inflight entry on disk (no deregister).
// main() builds liveBranches from inflight.listLive — if that returned dead entries,
// the branch would look "live", the pin would null out, and #27 would persist. Prove
// the real listLive filters dead pids so the committed branch is pinnable end-to-end.
test("pinnedResumeAuthor resolves through real inflight.listLive on a dead-pid SIGKILL (#27)", () => {
  const repo = mkdtempSync(join(tmpdir(), "orch-pin-"));
  rawGit(["init", "-b", "main"], repo);
  rawGit(["config", "user.email", "t@t"], repo);
  rawGit(["config", "user.name", "t"], repo);
  writeFileSync(join(repo, "a.txt"), "1\n");
  rawGit(["add", "."], repo); rawGit(["commit", "-m", "init"], repo);

  const orchDir = join(repo, ".orch");
  const branch = "pr/claude/do-x-1";
  // author committed before the kill
  const wt = join(orchDir, "wt", "pr_claude_do-x-1");
  createTaskBranch(repo, wt, branch, "main", "999999999\ndo-x-1"); // dead pid in marker
  writeFileSync(join(wt, "work.txt"), "x\n");
  rawGit(["add", "."], wt); rawGit(["commit", "-m", "author result"], wt);
  // SIGKILL: inflight entry left registered with a dead pid, resume record on disk
  inflight.register(orchDir, "do-x-1", { branch, pid: 999999999, baseSha: "deadbeef" });
  resume.record(orchDir, "do x", "claude", { branch, sid: "do-x-1" });

  const liveBranches = new Set(inflight.listLive(orchDir).map((e) => e.branch));
  assert.equal(liveBranches.has(branch), false); // dead pid filtered → not "live"
  // real git + real resume deps: the committed branch is pinnable
  assert.equal(pinnedResumeAuthor({ repo, orchDir, task: "do x", liveBranches }), "claude");
});

// Regression: realDeps() wired github.demote but not github.openPr, so any real
// `merge: pr` cycle crashed with "github.openPr is not a function" on its success
// path — never caught because every other test drives finalize() through hand-rolled
// stub deps. Go through the real dependency construction cli.js's cycle path uses.
test("realDeps() wires github.openPr — a merge:pr cycle escalates cleanly instead of throwing", async () => {
  const repo = initGitRepo("orch-mergepr-"); // no remote configured
  const orchDir = join(repo, ".orch");
  const branch = "pr/claude/do-x-1";
  const cfg = { merge: "pr", github: { mergeMethod: "squash", autoMergePr: false } };

  const result = await realDeps().finalize({
    repo, orchDir, branch, sid: "s1", baseSha: gitDep.git(["rev-parse", "main"], repo),
    paths: [], testCmd: "true", cfg, rounds: 1, closes: null,
  });

  // No remote → openPr can't open a PR, so it escalates locally instead of merging.
  // The bug threw a TypeError before reaching this point at all.
  assert.equal(result.status, "escalated");
  assert.match(result.reason, /merge: pr needs a remote/);
  assert.ok(existsSync(join(orchDir, "reviews", branch, "DECISION.md")));
});

// Regression (#106 review finding): review/pr-mode cycles write reviewed/tested
// checkpoints too, but the post-cycle clear was gated on mode === "task" — a
// normally COMPLETED `orch review` left a dangling checkpoint forever, which the
// dashboard's interruptedCycles() then reported as "died mid-flight".
test("completed review cycle clears its checkpoint (no false interrupted entry)", async () => {
  const repo = initGitRepo("orch-review-ck-");
  gitDep.git(["branch", "pr/claude/some-fix"], repo);

  let recorded = 0;
  const ck = { ...checkpointDep, record: (...a) => { recorded++; return checkpointDep.record(...a); } };
  const cycleDeps = {
    ...fakeCycleDeps(),
    checkpoint: ck,
    // DISAGREE → review mode escalates on round 1; the "reviewed" checkpoint is
    // already on disk by then, so a completed run must still clean it up.
    adapters: { get: (name) => ({ name, async audit() { return { decision: "DISAGREE", reason: "no", raw: "", usage: {} }; } }) },
  };
  try {
    process.exitCode = 0;
    await runMainInRepo(repo, ["review", "pr/claude/some-fix"], { cycleDeps });
  } finally {
    process.exitCode = 0;
  }

  assert.ok(recorded > 0); // the cycle really wrote a checkpoint mid-flight
  const dir = join(repo, ".orch", "checkpoints");
  const leftover = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
  assert.deepEqual(leftover, []); // ...and the completed run cleared it
});

// `review` shares task/issue's dry-run mechanism (dryDeps() instead of the
// real cycle deps), but had no dedicated regression test of its own — every
// mutating command in the schema needs one, not just the ones this slice
// touched directly.
test("orch review --dry never preflights or shells out to a real cycle", async () => {
  const repo = initGitRepo("orch-review-dry-");
  gitDep.git(["branch", "pr/claude/some-fix"], repo);
  const logs = await runMainInRepo(repo, ["review", "pr/claude/some-fix", "--dry"], {
    preflight() { assert.fail("preflight ran on a dry run"); },
  });
  assert.match(logs.join("\n"), /orch \(dry\)/);
  const dir = join(repo, ".orch", "checkpoints");
  assert.equal(existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).length : 0, 0);
});

// The schema's own matrix test (schema.test.js) derives its expectations from
// FLAGS/COMMANDS, so it can't catch a regression in those declarations
// themselves — delete --allow-large-scope from the schema and that test gets
// shorter and stays green. This anchors the flag to real, observed behavior
// instead: a live `orch task` cycle, through the real parser and engine, with
// only the adapter faked, and asserts the reviewer actually receives
// allowLargeScope on its audit() call.
test("orch task --allow-large-scope reaches the reviewer's audit call", async () => {
  const repo = initGitRepo("orch-task-allow-large-scope-");
  let auditOpts = null;
  const cycleDeps = {
    ...fakeCycleDeps(),
    adapters: {
      get: (name) => ({
        name,
        async author() { return { usage: {} }; },
        async audit(_branch, _worktree, opts) { auditOpts = opts; return { decision: "AGREE", reason: "ok", raw: "", usage: {} }; },
      }),
    },
  };
  const logs = await runMainInRepo(repo, ["task", "some task", "--allow-large-scope"], { cycleDeps, finishRun: async () => {} });
  assert.ok(auditOpts, "audit() was never called");
  assert.equal(auditOpts.allowLargeScope, true);
  assert.match(logs.join("\n"), /merged/);
});

test("orch continue <sid> resumes from checkpoint, past review, without re-authoring", async () => {
  const repo = initGitRepo("orch-continue-");
  const sid = "deadbeef";
  const branch = `pr/claude/some-fix-${sid}`;
  gitDep.git(["checkout", "-b", branch], repo);
  writeFileSync(join(repo, "a.txt"), "2\n");
  gitDep.git(["commit", "-am", "authored fix"], repo);
  gitDep.git(["checkout", "main"], repo);

  checkpointDep.record(join(repo, ".orch"), sid,
    { branch, round: 1, stage: "reviewed", decision: "AGREE", reason: "looks good" });

  let authorCalls = 0;
  const cycleDeps = {
    ...fakeCycleDeps(),
    adapters: {
      get: (name) => ({
        name,
        async author() { authorCalls++; return { usage: {} }; },
        async audit() { return { decision: "AGREE", reason: "still good", raw: "", usage: {} }; },
      }),
    },
  };
  const finishCalls = [];
  const logs = await runMainInRepo(repo, ["continue", sid],
    { cycleDeps, finishRun: async (ctx) => { finishCalls.push(ctx); } });

  assert.equal(authorCalls, 0); // resume skips re-authoring — the branch already has the commit
  assert.match(logs.join("\n"), new RegExp(`${branch}: merged`));
  assert.equal(finishCalls.length, 1);
  assert.deepEqual(finishCalls[0].merged, [branch]);
  const ck = checkpointDep.lookup(join(repo, ".orch"), sid);
  assert.equal(ck, null); // completed run clears its checkpoint
});

test("orch continue does not infer rotation from a branch/author mismatch", async () => {
  const repo = initGitRepo("orch-continue-no-rotation-inference-");
  const sid = "n0r0tate";
  const branch = "review/opaque-branch-name";
  gitDep.git(["checkout", "-b", branch], repo);
  writeFileSync(join(repo, "a.txt"), "2\n");
  gitDep.git(["commit", "-am", "authored fix"], repo);
  gitDep.git(["checkout", "main"], repo);

  const orchDir = join(repo, ".orch");
  checkpointDep.record(orchDir, sid, {
    branch, oid: gitDep.git(["rev-parse", branch], repo), round: 1, stage: "reviewed", decision: "AGREE", reason: "looks good",
    author: { agent: "codex", model: null, effort: null },
    reviewers: [{ agent: "claude", model: null, effort: null }],
  });

  let audits = 0;
  let authorCalls = 0;
  const cycleDeps = {
    ...fakeCycleDeps(),
    checkpoint: checkpointDep,
    adapters: {
      get: (name) => ({
        name,
        async author() { authorCalls++; throw new Error("must not re-author"); },
        async audit() { audits++; return { decision: "AGREE", reason: "still good", raw: "" }; },
      }),
    },
    finalize: async () => { throw new Error("simulated crash after cached review"); },
  };

  await assert.rejects(
    runMainInRepo(repo, ["continue", sid], { cycleDeps }),
    /simulated crash after cached review/,
  );
  assert.equal(authorCalls, 0, "a branch-name mismatch is not a rotation");
  assert.equal(audits, 0, "a cached AGREE checkpoint must not trigger a re-audit");
  const leftBehind = checkpointDep.lookup(orchDir, sid);
  assert.ok(leftBehind, "the cached checkpoint must remain live after the crash");
  assert.equal(leftBehind.stage, "tested");
});

// `continue`'s dry-run guard uses the same `dry ? dryDeps() : ...` switch as
// task/issue/review, but nothing exercised it directly for this command — a
// mutating command needs its own regression, not a inference from a sibling
// command's test.
test("orch continue <sid> --dry does not merge or clear the checkpoint", async () => {
  const repo = initGitRepo("orch-continue-dry-");
  const sid = "deadbeef";
  const branch = `pr/claude/some-fix-${sid}`;
  gitDep.git(["checkout", "-b", branch], repo);
  writeFileSync(join(repo, "a.txt"), "2\n");
  gitDep.git(["commit", "-am", "authored fix"], repo);
  gitDep.git(["checkout", "main"], repo);

  checkpointDep.record(join(repo, ".orch"), sid,
    { branch, round: 1, stage: "reviewed", decision: "AGREE", reason: "looks good" });

  const logs = await runMainInRepo(repo, ["continue", sid, "--dry"], {
    preflight() { assert.fail("preflight ran on a dry run"); },
  });

  assert.match(logs.join("\n"), /orch \(dry\)/);
  const ck = checkpointDep.lookup(join(repo, ".orch"), sid);
  assert.ok(ck, "a dry run must not clear the checkpoint it did not act on");
});

test("orch continue <sid> re-runs an interrupted author whose tip is a WIP commit", async () => {
  const repo = initGitRepo("orch-continue-wip-author-");
  const sid = "partial1";
  const branch = `pr/claude/some-fix-${sid}`;
  gitDep.git(["checkout", "-b", branch], repo);
  writeFileSync(join(repo, "partial.txt"), "unfinished\n");
  gitDep.git(["add", "."], repo);
  gitDep.git(["commit", "-m", "wip(author): partial work before timeout"], repo);
  gitDep.git(["checkout", "main"], repo);
  checkpointDep.record(join(repo, ".orch"), sid,
    { branch, round: 1, stage: "started", task: "fix the real timeout bug", authorPrompt: "fix the real timeout bug", author: { agent: "claude" }, reviewers: [{ agent: "codex" }] });

  let authorCalls = 0;
  let authoredTask = null;
  let audits = 0;
  const cycleDeps = {
    ...fakeCycleDeps(),
    adapters: {
      get: (name) => ({
        name,
        async author(task) { authorCalls++; authoredTask = task; return { usage: {} }; },
        async audit() { audits++; return { decision: "AGREE", reason: "ok", raw: "", usage: {} }; },
      }),
    },
  };

  await assert.rejects(
    runMainInRepo(repo, ["continue", sid], { cycleDeps, finishRun: async () => {} }),
    /partial WIP unchanged/,
  );
  assert.equal(authorCalls, 1, "a partial author tip must re-enter authoring before review");
  assert.equal(authoredTask, "fix the real timeout bug", "resume must execute the original task, never the branch slug");
  assert.equal(audits, 0, "an unchanged WIP must not reach review or merge");
  assert.equal(gitDep.git(["log", "-1", "--format=%s", branch], repo),
    "wip(author): partial work before timeout",
    "a no-op retry keeps the recoverable WIP tip for another attempt");
});

test("orch continue retries a task checkpoint whose author died before committing", async () => {
  const repo = initGitRepo("orch-continue-empty-author-");
  const sid = "empty1";
  const branch = `pr/claude/some-fix-${sid}`;
  gitDep.git(["branch", branch], repo);
  const orchDir = join(repo, ".orch");
  checkpointDep.record(orchDir, sid, {
    branch, round: 1, stage: "started", task: "fix the timeout bug",
    author: { agent: "claude" }, reviewers: [{ agent: "codex" }],
  });
  inflight.register(orchDir, sid, {
    branch, pid: 999999999, baseSha: gitDep.git(["rev-parse", "main"], repo),
    author: { agent: "claude" }, reviewers: [{ agent: "codex" }],
  });

  let authorCalls = 0;
  const cycleDeps = {
    ...fakeCycleDeps(),
    checkpoint: checkpointDep,
    adapters: {
      get: (name) => ({
        name,
        async author() { authorCalls++; return { usage: {} }; },
        async audit() { return { decision: "AGREE", reason: "ok", raw: "", usage: {} }; },
      }),
    },
  };
  const logs = await runMainInRepo(repo, ["continue", sid], { cycleDeps, finishRun: async () => {} });

  assert.equal(authorCalls, 1, "a task checkpoint must re-enter the author stage");
  assert.match(logs.join("\n"), new RegExp(`${branch}: merged`));
  assert.equal(checkpointDep.lookup(orchDir, sid), null);
});

test("orch task preserves an explicitly paired author/reviewer self-seat", async () => {
  const repo = initGitRepo("orch-fixed-self-task-");
  writeFileSync(join(repo, "orch.yml"), "agents: [claude, codex]\n");
  const auditCalls = [];
  const cycleDeps = {
    ...fakeCycleDeps(),
    adapters: {
      get: (name) => ({
        name,
        async author() { return { usage: {} }; },
        async audit() { auditCalls.push(name); return { decision: "AGREE", reason: "ok", raw: "", usage: {} }; },
      }),
    },
  };
  const logs = await runMainInRepo(repo, [
    "task", "same fixed roles", "--author", "claude", "--reviewer", "claude", "--no-tidy",
  ], { cycleDeps });

  assert.deepEqual(auditCalls, ["claude"]);
  assert.match(logs.join("\n"), /pr\/claude\/.*: merged/);
});

test("orch task keeps the valid seat from a colliding plural fixed-role fan-out", async () => {
  for (const [reviewer, author] of [["claude", "codex"], ["codex", "claude"]]) {
    const repo = initGitRepo(`orch-plural-role-collision-${reviewer}-`);
    const calls = [];
    const cycleDeps = {
      ...fakeCycleDeps(),
      adapters: {
        get: (name) => ({
          name,
          async author() { calls.push(["author", name]); return { usage: {} }; },
          async audit() { calls.push(["reviewer", name]); return { decision: "AGREE", reason: "ok", raw: "", usage: {} }; },
        }),
      },
    };
    const logs = await runMainInRepo(repo, [
      "task", "plural fixed roles", "--authors", "claude,codex", "--reviewers", reviewer, "--no-tidy",
    ], { cycleDeps });

    assert.deepEqual(calls, [["author", author], ["reviewer", reviewer]], reviewer);
    assert.match(logs.join("\n"), new RegExp(`pr/${author}/.*: merged`));
  }
});

test("orch review permits an explicitly requested reviewer who authored the branch", async () => {
  const repo = initGitRepo("orch-fixed-self-review-");
  const branch = "pr/claude/review-self";
  gitDep.git(["branch", branch], repo);
  writeFileSync(join(repo, "orch.yml"), "agents: [claude, codex]\n");
  const auditCalls = [];
  const cycleDeps = {
    ...fakeCycleDeps(),
    adapters: {
      get: (name) => ({
        name,
        async author() { throw new Error("review must not author"); },
        async audit() { auditCalls.push(name); return { decision: "AGREE", reason: "ok", raw: "", usage: {} }; },
      }),
    },
  };
  const logs = await runMainInRepo(repo, ["review", branch, "--reviewer", "claude"], {
    cycleDeps, finishRun: async () => {},
  });

  assert.deepEqual(auditCalls, ["claude"]);
  assert.match(logs.join("\n"), new RegExp(`${branch}: merged`));
});

test("orch review permits a configured reviewer who authored the branch", async () => {
  const repo = initGitRepo("orch-configured-self-review-");
  const branch = "pr/codex/review-self";
  gitDep.git(["branch", branch], repo);
  writeFileSync(join(repo, "orch.yml"), "agents: [claude, codex]\nauthors: [claude]\nreviewers: [codex]\n");
  const auditCalls = [];
  const cycleDeps = {
    ...fakeCycleDeps(),
    adapters: {
      get: (name) => ({
        name,
        async author() { throw new Error("review must not author"); },
        async audit() { auditCalls.push(name); return { decision: "AGREE", reason: "ok", raw: "", usage: {} }; },
      }),
    },
  };
  const logs = await runMainInRepo(repo, ["review", branch], { cycleDeps, finishRun: async () => {} });

  assert.deepEqual(auditCalls, ["codex"]);
  assert.match(logs.join("\n"), new RegExp(`${branch}: merged`));
});

test("orch continue permits an explicitly requested branch author as reviewer", async () => {
  const repo = initGitRepo("orch-continue-reviewer-self-");
  const sid = "continue-self";
  const branch = `pr/claude/reviewer-self-${sid}`;
  gitDep.git(["checkout", "-b", branch], repo);
  writeFileSync(join(repo, "a.txt"), "2\n");
  gitDep.git(["commit", "-am", "authored fix"], repo);
  gitDep.git(["checkout", "main"], repo);
  writeFileSync(join(repo, "orch.yml"), "agents: [claude, codex]\n");
  checkpointDep.record(join(repo, ".orch"), sid, {
    branch, round: 1, stage: "reviewed", decision: "AGREE", reason: "looks good",
  });

  const auditCalls = [];
  const cycleDeps = {
    ...fakeCycleDeps(),
    adapters: {
      get: (name) => ({
        name,
        async author() { throw new Error("continue must not re-author"); },
        async audit() { auditCalls.push(name); return { decision: "AGREE", reason: "ok", raw: "", usage: {} }; },
      }),
    },
  };
  const logs = await runMainInRepo(repo, ["continue", sid, "--reviewer", "claude"], {
    cycleDeps,
    finishRun: async () => {},
  });

  assert.deepEqual(auditCalls, ["claude"]);
  assert.match(logs.join("\n"), new RegExp(`${branch}: merged`));
});

test("orch continue permits a configured reviewer who authored the branch", async () => {
  const repo = initGitRepo("orch-continue-configured-self-");
  const sid = "continue-configured-self";
  const branch = `pr/codex/reviewer-self-${sid}`;
  gitDep.git(["checkout", "-b", branch], repo);
  writeFileSync(join(repo, "a.txt"), "2\n");
  gitDep.git(["commit", "-am", "authored fix"], repo);
  gitDep.git(["checkout", "main"], repo);
  writeFileSync(join(repo, "orch.yml"), "agents: [claude, codex]\nauthors: [claude]\nreviewers: [codex]\n");
  checkpointDep.record(join(repo, ".orch"), sid, {
    branch, round: 1, stage: "reviewed", decision: "AGREE", reason: "looks good",
    author: { agent: "codex" }, reviewers: [{ agent: "codex" }],
  });

  const auditCalls = [];
  const cycleDeps = {
    ...fakeCycleDeps(),
    adapters: {
      get: (name) => ({
        name,
        async author() { throw new Error("continue must not re-author"); },
        async audit() { auditCalls.push(name); return { decision: "AGREE", reason: "ok", raw: "", usage: {} }; },
      }),
    },
  };
  const logs = await runMainInRepo(repo, ["continue", sid], { cycleDeps, finishRun: async () => {} });

  assert.deepEqual(auditCalls, ["codex"]);
  assert.match(logs.join("\n"), new RegExp(`${branch}: merged`));
});

test("orch continue <sid> clears a stale checkpoint when the branch was merged and deleted", async () => {
  const repo = initGitRepo("orch-continue-stale-");
  const sid = "5ta1eck";
  const branch = `pr/claude/some-fix-${sid}`;
  gitDep.git(["checkout", "-b", branch], repo);
  writeFileSync(join(repo, "a.txt"), "2\n");
  gitDep.git(["commit", "-am", "authored fix"], repo);
  gitDep.git(["checkout", "main"], repo);
  gitDep.git(["merge", "--no-ff", branch, "-m", "merge authored fix"], repo);
  gitDep.git(["branch", "-D", branch], repo);

  const orchDir = join(repo, ".orch");
  checkpointDep.record(orchDir, sid,
    { branch, round: 1, stage: "reviewed", decision: "AGREE", reason: "looks good" });

  let cycleRan = false;
  const logs = await runMainInRepo(repo, ["continue", sid], {
    cycleDeps: { ...fakeCycleDeps(), finalize: async () => { cycleRan = true; return { status: "merged", reason: "test", sha: "abc" }; } },
  });

  assert.equal(cycleRan, false);
  assert.equal(checkpointDep.lookup(orchDir, sid), null);
  assert.match(logs.join("\n"), /cleared stale resume state/);
});

test("orch continue <sid> keeps the checkpoint when only the remote-tracking branch remains", async () => {
  const repo = initGitRepo("orch-continue-remote-");
  addOriginWithPeer(repo);
  const sid = "0r1g1n";
  const branch = `pr/claude/some-fix-${sid}`;
  gitDep.git(["checkout", "-b", branch], repo);
  writeFileSync(join(repo, "a.txt"), "2\n");
  gitDep.git(["commit", "-am", "authored fix"], repo);
  gitDep.git(["push", "-u", "origin", branch], repo);
  gitDep.git(["checkout", "main"], repo);
  gitDep.git(["branch", "-D", branch], repo);

  const orchDir = join(repo, ".orch");
  checkpointDep.record(orchDir, sid,
    { branch, round: 1, stage: "reviewed", decision: "AGREE", reason: "looks good" });

  await assert.rejects(
    runMainInRepo(repo, ["continue", sid]),
    new RegExp(`exists only as origin/${branch}`),
  );
  assert.equal(checkpointDep.lookup(orchDir, sid).branch, branch);
});

test("orch continue uses configured baseBranch in a repo without main", async () => {
  const repo = initGitRepoOn("dev", "orch-continue-dev-base-");
  const sid = "devb45e";
  const branch = `pr/claude/some-fix-${sid}`;
  gitDep.git(["checkout", "-b", branch], repo);
  writeFileSync(join(repo, "a.txt"), "2\n");
  gitDep.git(["commit", "-am", "authored fix"], repo);
  gitDep.git(["checkout", "dev"], repo);
  mkdirSync(join(repo, ".orch"), { recursive: true });
  writeFileSync(join(repo, ".orch", "orch.yml"), "baseBranch: dev\n");

  checkpointDep.record(join(repo, ".orch"), sid,
    { branch, round: 1, stage: "reviewed", decision: "AGREE", reason: "looks good" });

  const logs = await runMainInRepo(repo, ["continue", sid], { cycleDeps: fakeCycleDeps(), finishRun: async () => {} });

  assert.throws(() => gitDep.git(["rev-parse", "--verify", "main"], repo), /Needed a single revision|unknown revision|ambiguous argument/);
  assert.match(logs.join("\n"), new RegExp(`${branch}: merged`));
});

// The original run's resolved author/reviewer role specs (agent + model +
// effort) are persisted into the checkpoint record (engine.js) so a resume
// reuses the exact same models/efforts instead of re-resolving against
// whatever orch.yml/rotation currently say.
test("orch continue <sid> reuses the persisted author/reviewer model+effort by default", async () => {
  const repo = initGitRepo("orch-continue-roles-");
  const sid = "r01e5eed";
  const branch = `pr/claude/some-fix-${sid}`;
  gitDep.git(["checkout", "-b", branch], repo);
  writeFileSync(join(repo, "a.txt"), "2\n");
  gitDep.git(["commit", "-am", "authored fix"], repo);
  gitDep.git(["checkout", "main"], repo);

  checkpointDep.record(join(repo, ".orch"), sid, {
    branch, round: 1, stage: "reviewed", decision: "AGREE", reason: "looks good",
    author: { agent: "claude", model: "claude-opus-4-8", effort: "high" },
    reviewers: [{ agent: "codex", model: "gpt-5.1", effort: null }],
    allowLargeScope: true,
  });

  const auditOpts = [];
  const cycleDeps = {
    ...fakeCycleDeps(),
    adapters: {
      get: (name) => ({
        name,
        async author() { throw new Error("resume must not re-author"); },
        async audit(_branch, _worktree, opts) {
          auditOpts.push(opts);
          return { decision: "AGREE", reason: "still good", raw: "", usage: {} };
        },
      }),
    },
  };
  const logs = await runMainInRepo(repo, ["continue", sid], { cycleDeps, finishRun: async () => {} });

  assert.match(logs.join("\n"), new RegExp(`${branch}: merged`));
  assert.equal(auditOpts.length, 1);
  assert.equal(auditOpts[0].model, "gpt-5.1"); // persisted reviewer model, not a re-resolved default
  assert.equal(auditOpts[0].allowLargeScope, false); // legacy persisted sanction is not reused
});

test("orch continue ignores an exclusion unrelated to the cached reviewer", async () => {
  const repo = initGitRepo("orch-continue-unrelated-exclusion-");
  const sid = "unrel4ted";
  const branch = `pr/claude/some-fix-${sid}`;
  gitDep.git(["checkout", "-b", branch], repo);
  writeFileSync(join(repo, "a.txt"), "2\n");
  gitDep.git(["commit", "-am", "authored fix"], repo);
  gitDep.git(["checkout", "main"], repo);

  const orchDir = join(repo, ".orch");
  const originalReviewers = [{ agent: "codex", model: "gpt-5.1", effort: null }];
  checkpointDep.record(orchDir, sid, {
    branch, oid: gitDep.git(["rev-parse", branch], repo), round: 1,
    stage: "reviewed", decision: "AGREE", reason: "looks good",
    author: { agent: "claude", model: null, effort: null },
    reviewers: originalReviewers,
    excludedAgents: [{ name: "unrelated-agent", reason: "quota" }],
  });

  let auditCalls = 0;
  const cycleDeps = {
    ...fakeCycleDeps(),
    checkpoint: checkpointDep,
    adapters: {
      get: (name) => ({
        name,
        async author() { throw new Error("resume must not re-author"); },
        async audit() {
          auditCalls += 1;
          return { decision: "AGREE", reason: "still good", raw: "", usage: {} };
        },
      }),
    },
    // Leave the checkpoint behind after engine.js records the round so both
    // the cached-verdict and persisted-reviewer behavior are observable.
    finalize: async () => { throw new Error("simulated crash after checkpoint write"); },
  };
  writeFileSync(join(orchDir, "orch.yml"), "agents: [claude, codex, copilot]\n");

  await assert.rejects(
    runMainInRepo(repo, ["continue", sid], { cycleDeps }),
    /simulated crash/,
  );

  assert.equal(auditCalls, 0); // the cached AGREE verdict remains valid
  assert.deepEqual(checkpointDep.lookup(orchDir, sid).reviewers, originalReviewers);
});

// Codex review: preflight used to validate the FULL current orch.yml (its
// whole `agents:` pool plus any fixed roles) before a resume ever got to reuse
// its persisted author/reviewer specs — so an unrelated/unknown agent named
// elsewhere in orch.yml (one this resume will never invoke) made `continue`
// fail outright. preflight must only check the agents this resume actually
// uses: the persisted author/reviewer, not the whole pool.
test("orch continue <sid> ignores an unknown agent in orch.yml's pool that this resume doesn't use", async () => {
  const repo = initGitRepo("orch-continue-unrelated-agent-");
  const sid = "un1kn0wn";
  const branch = `pr/claude/some-fix-${sid}`;
  gitDep.git(["checkout", "-b", branch], repo);
  writeFileSync(join(repo, "a.txt"), "2\n");
  gitDep.git(["commit", "-am", "authored fix"], repo);
  gitDep.git(["checkout", "main"], repo);

  mkdirSync(join(repo, ".orch"), { recursive: true });
  // "bogus-agent" has no registered adapter — real preflight() would throw on
  // it if it were ever checked. This resume's persisted roles are claude/codex
  // only. (CI fix: the real preflight() also does a PATH lookup for whatever
  // agents it DOES check — claude/codex aren't installed on the CI runner, so
  // this can't call the real preflight() and still be CI-safe. A spy that
  // records `opts.only` tests the thing this test is actually about — which
  // names cli.js decided to check — without depending on real CLI binaries.)
  writeFileSync(join(repo, ".orch", "orch.yml"), "agents: [claude, codex, bogus-agent]\n");

  checkpointDep.record(join(repo, ".orch"), sid, {
    branch, round: 1, stage: "reviewed", decision: "AGREE", reason: "looks good",
    author: { agent: "claude", model: null, effort: null },
    reviewers: [{ agent: "codex", model: null, effort: null }],
  });

  let checkedOnly = null;
  const spyPreflight = (cfg, orchDir, opts = {}) => { checkedOnly = opts.only; };
  const logs = await runMainInRepo(repo, ["continue", sid],
    { preflight: spyPreflight, cycleDeps: fakeCycleDeps(), finishRun: async () => {} });

  assert.match(logs.join("\n"), new RegExp(`${branch}: merged`));
  assert.deepEqual(new Set(checkedOnly), new Set(["claude", "codex"])); // NOT bogus-agent
});

// `--reviewer` on `continue` overrides the persisted reviewer for this resume
// only — it must not mutate the checkpoint's stored roles.
test("orch continue <sid> --reviewer overrides the persisted reviewer without rewriting the checkpoint", async () => {
  const repo = initGitRepo("orch-continue-roles-override-");
  const sid = "0verr1de";
  const branch = `pr/claude/some-fix-${sid}`;
  gitDep.git(["checkout", "-b", branch], repo);
  writeFileSync(join(repo, "a.txt"), "2\n");
  gitDep.git(["commit", "-am", "authored fix"], repo);
  gitDep.git(["checkout", "main"], repo);

  const orchDir = join(repo, ".orch");
  checkpointDep.record(orchDir, sid, {
    branch, round: 1, stage: "reviewed", decision: "AGREE", reason: "looks good",
    author: { agent: "claude", model: null, effort: null },
    reviewers: [{ agent: "codex", model: "gpt-5.1", effort: null }],
  });

  const auditCalls = [];
  const cycleDeps = {
    ...fakeCycleDeps(),
    // Codex review (#126 stalemate, round 3): without wiring the REAL
    // checkpoint module here, engine.js's `deps.checkpoint` is undefined and
    // its resume/pendingVerdict shortcut never fires regardless of what's on
    // disk — so this test would pass even if the override were silently
    // ignored in production. Wire it for real so the test actually exercises
    // the code path it claims to.
    checkpoint: checkpointDep,
    adapters: {
      get: (name) => ({
        name,
        async author() { throw new Error("resume must not re-author"); },
        async audit(_branch, _worktree, opts) {
          auditCalls.push({ name, opts });
          return { decision: "AGREE", reason: "still good", raw: "", usage: {} };
        },
      }),
    },
  };
  writeFileSync(join(orchDir, "orch.yml"), "agents: [claude, codex, copilot]\n");
  const logs = await runMainInRepo(repo, ["continue", sid, "--reviewer", "copilot"],
    { cycleDeps, finishRun: async () => {} });

  assert.match(logs.join("\n"), new RegExp(`${branch}: merged`));
  assert.equal(auditCalls.length, 1);
  assert.equal(auditCalls[0].name, "copilot"); // overridden for this resume
});

// Regression (codex review of #126 branch, round 3): a "reviewed"-stage
// checkpoint caches a DECISION, not just a reviewer name. engine.js's resume
// shortcut trusts that cached decision and skips the audit call entirely for
// that round — so if the ORIGINAL reviewer crashed/errored (which is exactly
// how a stale "reviewed" checkpoint with a bad verdict gets left behind:
// engine.js writes the checkpoint, THEN checks for agentError and escalates),
// `--reviewer <x>` swaps in a working reviewer that never actually runs. The
// resume just replays the old broken reviewer's DISAGREE. This test proves
// the override reviewer's OWN verdict (AGREE) is what determines the
// outcome, not the stale cached one — it would fail (result stays escalated,
// override adapter's audit() never called) without engine.js consulting
// `opts.reviewerOverride` to skip the pendingVerdict shortcut.
test("orch continue <sid> --reviewer forces a fresh audit even when the checkpoint already cached a verdict", async () => {
  const repo = initGitRepo("orch-continue-roles-forcereview-");
  const sid = "f0rce0ne";
  const branch = `pr/claude/some-fix-${sid}`;
  gitDep.git(["checkout", "-b", branch], repo);
  writeFileSync(join(repo, "a.txt"), "2\n");
  gitDep.git(["commit", "-am", "authored fix"], repo);
  gitDep.git(["checkout", "main"], repo);

  const orchDir = join(repo, ".orch");
  // The cached verdict is DISAGREE — as if the original ("codex") reviewer
  // errored out and the cycle escalated. `continue --reviewer copilot` is
  // exactly the recovery move: swap the broken reviewer for a working one.
  checkpointDep.record(orchDir, sid, {
    branch, round: 1, stage: "reviewed", decision: "DISAGREE", reason: "codex: agent error: rate limited",
    author: { agent: "claude", model: null, effort: null },
    reviewers: [{ agent: "codex", model: "gpt-5.1", effort: null }],
  });

  const auditCalls = [];
  const cycleDeps = {
    ...fakeCycleDeps(),
    checkpoint: checkpointDep,
    adapters: {
      get: (name) => ({
        name,
        async author() { throw new Error("resume must not re-author"); },
        async audit(_branch, _worktree, opts) {
          auditCalls.push({ name, opts });
          return { decision: "AGREE", reason: "copilot: looks fine", raw: "", usage: {} };
        },
      }),
    },
  };
  writeFileSync(join(orchDir, "orch.yml"), "agents: [claude, codex, copilot]\n");
  const logs = await runMainInRepo(repo, ["continue", sid, "--reviewer", "copilot"],
    { cycleDeps, finishRun: async () => {} });

  assert.equal(auditCalls.length, 1);
  assert.equal(auditCalls[0].name, "copilot"); // the override reviewer actually ran
  assert.match(logs.join("\n"), new RegExp(`${branch}: merged`)); // its AGREE decided the outcome, not the stale DISAGREE
});

// Regression (codex review of #126 branch): the test above only proves the
// override is USED for this run — it never checks what gets left behind if
// the overridden run itself dies. `continue`'s cleanup (checkpoint.clear) only
// runs if runCycle RETURNS; a genuine crash (stage-timeout kill, adapter
// crash) skips it entirely, same as the real scenario `continue` exists for.
// Simulate that here: finalize throws AFTER engine.js has already written a
// "reviewed"-stage checkpoint for this round, so cli.js's post-runCycle
// cleanup never runs. The checkpoint left behind must still hold the
// ORIGINAL persisted reviewer (codex), not this run's --reviewer override
// (copilot) — otherwise a later plain `continue` would silently inherit the
// override forever.
test("orch continue <sid> --reviewer override does not leak into the checkpoint if the resume itself dies", async () => {
  const repo = initGitRepo("orch-continue-roles-crash-");
  const sid = "cra5h0ne";
  const branch = `pr/claude/some-fix-${sid}`;
  gitDep.git(["checkout", "-b", branch], repo);
  writeFileSync(join(repo, "a.txt"), "2\n");
  gitDep.git(["commit", "-am", "authored fix"], repo);
  gitDep.git(["checkout", "main"], repo);

  const orchDir = join(repo, ".orch");
  const originalReviewers = [{ agent: "codex", model: "gpt-5.1", effort: null }];
  checkpointDep.record(orchDir, sid, {
    branch, round: 1, stage: "reviewed", decision: "AGREE", reason: "looks good",
    author: { agent: "claude", model: null, effort: null },
    reviewers: originalReviewers,
    excludedAgents: [{ name: "unrelated-agent", reason: "quota" }],
  });

  const cycleDeps = {
    ...fakeCycleDeps(),
    adapters: {
      get: (name) => ({
        name,
        async author() { throw new Error("resume must not re-author"); },
        async audit() { return { decision: "AGREE", reason: "still good", raw: "", usage: {} }; },
      }),
    },
    // Throws AFTER engine.js's own checkpoint.record write for this round —
    // simulating the process dying between "reviewed" and merge, before
    // cli.js's continue handler ever reaches its own checkpoint.clear().
    finalize: async () => { throw new Error("simulated crash after checkpoint write"); },
  };
  writeFileSync(join(orchDir, "orch.yml"), "agents: [claude, codex, copilot]\n");

  await assert.rejects(
    runMainInRepo(repo, ["continue", sid, "--reviewer", "copilot"], { cycleDeps }),
    /simulated crash/,
  );

  const leftBehind = checkpointDep.lookup(orchDir, sid);
  assert.ok(leftBehind, "checkpoint must survive a crash (cleanup never ran)");
  assert.deepEqual(leftBehind.reviewers, originalReviewers); // NOT [copilot]
});

// Regression (codex review): a hard-killed prior `continue` attempt leaves its
// worktree checked out under .orch/wt with a dead owner pid. Without reclaiming
// it first, `git.attachExistingBranch` fails with "already checked out" and the
// resume never reaches review/test/merge. `continue` must reclaim orphans first,
// same as `task`/`pr` do at cycle start.
test("orch continue <sid> reclaims an orphaned worktree left by a killed prior attempt", async () => {
  const repo = initGitRepo("orch-continue-orphan-");
  const sid = "0ff1ce";
  const branch = `pr/claude/some-fix-${sid}`;
  gitDep.git(["checkout", "-b", branch], repo);
  writeFileSync(join(repo, "a.txt"), "2\n");
  gitDep.git(["commit", "-am", "authored fix"], repo);
  gitDep.git(["checkout", "main"], repo);

  checkpointDep.record(join(repo, ".orch"), sid,
    { branch, round: 1, stage: "reviewed", decision: "AGREE", reason: "looks good" });

  // Simulate the orphan: a worktree checked out on `branch` at the exact path
  // `continue` will reattach to, left behind by a process that no longer exists.
  const worktree = join(repo, ".orch", "wt", branch.replace(/\//g, "_"));
  gitDep.git(["worktree", "add", "--", worktree, branch], repo);
  writeFileSync(`${worktree}.orch-preserve`, "capture failed\n");

  const cycleDeps = {
    ...fakeCycleDeps(),
    adapters: {
      get: (name) => ({
        name,
        async author() { throw new Error("resume must not re-author"); },
        async audit() { return { decision: "AGREE", reason: "still good", raw: "", usage: {} }; },
      }),
    },
  };
  const finishCalls = [];
  const logs = await runMainInRepo(repo, ["continue", sid],
    { cycleDeps, finishRun: async (ctx) => { finishCalls.push(ctx); } });

  assert.match(logs.join("\n"), new RegExp(`${branch}: merged`));
  assert.equal(finishCalls.length, 1);
  assert.equal(existsSync(`${worktree}.orch-preserve`), false, "successful resume clears the preservation marker");
});

test("orch continue <sid> refuses an unregistered worktree directory and leaves it intact", async () => {
  const repo = initGitRepo("orch-continue-unregistered-");
  const sid = "unreg1";
  const branch = `pr/claude/some-fix-${sid}`;
  gitDep.git(["checkout", "-b", branch], repo);
  writeFileSync(join(repo, "a.txt"), "2\n");
  gitDep.git(["commit", "-am", "authored fix"], repo);
  gitDep.git(["checkout", "main"], repo);

  checkpointDep.record(join(repo, ".orch"), sid,
    { branch, round: 1, stage: "reviewed", decision: "AGREE", reason: "looks good" });
  const worktree = join(repo, ".orch", "wt", branch.replace(/\//g, "_"));
  mkdirSync(worktree, { recursive: true });

  await assert.rejects(
    runMainInRepo(repo, ["continue", sid]),
    (error) => {
      assert.match(error.message, /worktree directory exists/);
      assert.match(error.message, /Git's worktree registry does not know about it/);
      assert.ok(error.message.includes(worktree));
      assert.match(error.message, /Committed work .* safe/);
      assert.match(error.message, /inspect and clear the directory by hand/);
      assert.match(error.message, /orch continue/);
      return true;
    },
  );
  assert.equal(existsSync(worktree), true);
  assert.doesNotMatch(gitDep.git(["worktree", "list"], repo), /some-fix-unreg1/);
});

test("orch continue <sid> resumes dirty work from a preserved capture failure", async () => {
  const repo = initGitRepo("orch-continue-preserved-dirty-");
  const sid = "capture1";
  const branch = `pr/claude/some-fix-${sid}`;
  gitDep.git(["branch", branch], repo);
  const worktree = join(repo, ".orch", "wt", branch.replace(/\//g, "_"));
  gitDep.git(["worktree", "add", "--", worktree, branch], repo);
  writeFileSync(join(worktree, "RECOVERABLE"), "partial work\n");
  writeFileSync(`${worktree}.orch-preserve`, "index.lock blocked WIP capture\n");
  checkpointDep.record(join(repo, ".orch"), sid, {
    branch, round: 1, stage: "started", task: "finish the timeout fix", authorPrompt: "finish the timeout fix",
    author: { agent: "claude" }, reviewers: [{ agent: "codex" }],
  });

  let authoredTask = null;
  let recoveredContent = null;
  const cycleDeps = {
    ...fakeCycleDeps(),
    checkpoint: checkpointDep,
    adapters: {
      get: (name) => ({
        name,
        async author(task, wd) {
          authoredTask = task;
          gitDep.git(["add", "-A"], wd);
          gitDep.git(["commit", "-m", "completed preserved author work"], wd);
          recoveredContent = gitDep.git(["show", "HEAD:RECOVERABLE"], wd);
          return { usage: {} };
        },
        async audit() { return { decision: "AGREE", reason: "ok", raw: "", usage: {} }; },
      }),
    },
  };

  const logs = await runMainInRepo(repo, ["continue", sid], { cycleDeps, finishRun: async () => {} });
  assert.equal(authoredTask, "finish the timeout fix");
  assert.match(logs.join("\n"), new RegExp(`${branch}: merged`));
  assert.equal(recoveredContent, "partial work");
  assert.equal(existsSync(`${worktree}.orch-preserve`), false);
});

test("orch continue <sid> throws when no checkpoint or inflight record exists", async () => {
  const repo = initGitRepo("orch-continue-missing-");
  await assert.rejects(
    runMainInRepo(repo, ["continue", "nosuchsid"]),
    /no checkpoint or inflight record for sid nosuchsid/,
  );
});

test("orch continue <sid> requires the usage argument", async () => {
  const repo = initGitRepo("orch-continue-usage-");
  await assert.rejects(runMainInRepo(repo, ["continue"]), /usage: orch continue <sid>/);
});

test("orch continue <sid> refuses to resume an inflight-only branch with no committed changes", async () => {
  const repo = initGitRepo("orch-continue-empty-");
  const sid = "cafebabe";
  const branch = `pr/claude/some-fix-${sid}`;
  gitDep.git(["checkout", "-b", branch], repo);
  gitDep.git(["checkout", "main"], repo);

  // Simulate a death before the author's first commit: an inflight record
  // exists (registered before authoring starts) but no checkpoint was ever
  // written (checkpoints only appear once a review round completes), and the
  // branch carries no committed diff vs. main. A dead pid, not process.pid —
  // this must simulate the process actually having died, or the still-live
  // guard (added after #125's stalemate) would refuse it for the wrong reason.
  inflight.register(join(repo, ".orch"), sid, {
    branch, pid: 999999999, baseSha: gitDep.git(["rev-parse", "main"], repo),
    excludedAgents: [{ name: "unrelated-agent", reason: "quota" }],
  });

  await assert.rejects(
    runMainInRepo(repo, ["continue", sid]),
    /has no committed changes/,
  );
});

test("orch continue <sid> refuses to resume a started checkpoint with no committed changes", async () => {
  const repo = initGitRepo("orch-continue-started-empty-");
  const sid = "started0";
  const branch = `pr/claude/some-fix-${sid}`;
  gitDep.git(["checkout", "-b", branch], repo);
  gitDep.git(["checkout", "main"], repo);

  // The checkpoint is written before authoring begins. It must not turn an
  // empty branch into a resumable run after the author dies before committing.
  checkpointDep.record(join(repo, ".orch"), sid, { branch, round: 1, stage: "started" });

  await assert.rejects(
    runMainInRepo(repo, ["continue", sid]),
    /has no committed changes/,
  );
  assert.equal(checkpointDep.lookup(join(repo, ".orch"), sid), null,
    "refusing an empty started resume clears the stale checkpoint");
});

// Regression (#129 bug 1): a run that died BEFORE its first checkpoint has, by
// definition, a dead owner pid — that's the whole scenario `continue`'s inflight
// fallback exists for. `listLive()` deletes any inflight file whose pid is dead
// as a side effect ("doubles as inflight reclaim"). If `continue` called
// `listLive()` before reading this sid's own inflight record, it would delete
// the very record it's trying to resume. Use a pid far above any real process
// (guaranteed ESRCH) to simulate the dead owner.
test("orch continue <sid> resumes a died-before-checkpoint run via a dead-pid inflight record", async () => {
  const repo = initGitRepo("orch-continue-deadpid-");
  const sid = "d3adbeef";
  const branch = `pr/claude/some-fix-${sid}`;
  gitDep.git(["checkout", "-b", branch], repo);
  writeFileSync(join(repo, "a.txt"), "2\n");
  gitDep.git(["commit", "-am", "authored fix"], repo);
  gitDep.git(["checkout", "main"], repo);

  const DEAD_PID = 999999999; // above PID_MAX_LIMIT — process.kill(pid, 0) throws ESRCH
  inflight.register(join(repo, ".orch"), sid, { branch, pid: DEAD_PID, baseSha: gitDep.git(["rev-parse", "main"], repo), allowLargeScope: true });

  let authorCalls = 0;
  let auditOpts = null;
  const cycleDeps = {
    ...fakeCycleDeps(),
    adapters: {
      get: (name) => ({
        name,
        async author() { authorCalls++; return { usage: {} }; },
        async audit(_branch, _worktree, opts) { auditOpts = opts; return { decision: "AGREE", reason: "still good", raw: "", usage: {} }; },
      }),
    },
  };
  const logs = await runMainInRepo(repo, ["continue", sid],
    { cycleDeps, finishRun: async () => {} });

  assert.equal(authorCalls, 0); // resumed via the inflight record, not a fresh author round
  assert.equal(auditOpts.allowLargeScope, false); // legacy inflight sanction is not reused
  assert.match(logs.join("\n"), new RegExp(`${branch}: merged`));
});

// Regression (#129 bug 2): `task`/`issue` both check `live > cfg.concurrency`
// before starting a cycle; `continue` re-registered the resumed run in inflight
// with no equivalent check, letting a resume push the live-cycle count past the
// configured cap.
test("orch continue <sid> respects the concurrency cap", async () => {
  const repo = initGitRepo("orch-continue-cap-");
  const sid = "cap5eed";
  const branch = `pr/claude/some-fix-${sid}`;
  gitDep.git(["checkout", "-b", branch], repo);
  writeFileSync(join(repo, "a.txt"), "2\n");
  gitDep.git(["commit", "-am", "authored fix"], repo);
  gitDep.git(["checkout", "main"], repo);

  checkpointDep.record(join(repo, ".orch"), sid,
    { branch, round: 1, stage: "reviewed", decision: "AGREE", reason: "looks good" });

  // Fill the cap with other live (alive-pid) cycles first.
  writeFileSync(join(repo, ".orch", "orch.yml"), "concurrency: 1\n");
  inflight.register(join(repo, ".orch"), "otherlive", { branch: "pr/claude/other", pid: process.pid, baseSha: gitDep.git(["rev-parse", "main"], repo) });

  await assert.rejects(
    runMainInRepo(repo, ["continue", sid]),
    /concurrency cap 1 reached/,
  );
  // The rejected resume must not leave its own inflight record behind.
  assert.equal(inflight.lookup(join(repo, ".orch"), sid), null);
});

// Regression (codex review of #125 branch): a sid with a live (alive-pid)
// inflight entry is genuinely running right now — either the original
// `task`/`issue` cycle, or a previous `continue` that hasn't finished. A second
// `continue` on the same sid must not overwrite that entry's inflight file or
// attempt a second worktree at the same path.
test("orch continue <sid> refuses to attach a sid that already has a live run", async () => {
  const repo = initGitRepo("orch-continue-stilllive-");
  const sid = "1ive0001";
  const branch = `pr/claude/some-fix-${sid}`;
  gitDep.git(["checkout", "-b", branch], repo);
  writeFileSync(join(repo, "a.txt"), "2\n");
  gitDep.git(["commit", "-am", "authored fix"], repo);
  gitDep.git(["checkout", "main"], repo);

  checkpointDep.record(join(repo, ".orch"), sid,
    { branch, round: 1, stage: "reviewed", decision: "AGREE", reason: "looks good" });
  // Simulate the same sid already registered inflight with a genuinely alive pid.
  inflight.register(join(repo, ".orch"), sid, { branch, pid: process.pid, baseSha: gitDep.git(["rev-parse", "main"], repo) });

  const before = inflight.lookup(join(repo, ".orch"), sid);
  await assert.rejects(
    runMainInRepo(repo, ["continue", sid]),
    new RegExp(`sid ${sid} already has a live run \\(pid ${process.pid}\\)`),
  );
  // The live entry must survive untouched — not overwritten by the refused attempt.
  assert.deepEqual(inflight.lookup(join(repo, ".orch"), sid), before);
});

// Regression (codex review of #125 branch): the ORIGINAL `orch task` run that
// authored this branch wrote a resume.js record (task text + author → branch)
// before it ever ran, so a crash mid-cycle leaves it for a retry to resume
// (issue #24). `continue` doesn't know that original task text and so can't
// clear the record by its (task, author) key — without clearForBranch, the
// record survives after this branch is already terminal, and a later `orch
// task` with the same original text would wrongly reattach it.
test("orch continue <sid> clears the original task's resume.js record on completion", async () => {
  const repo = initGitRepo("orch-continue-resume-clear-");
  const sid = "c1eaner1";
  const branch = `pr/claude/some-fix-${sid}`;
  gitDep.git(["checkout", "-b", branch], repo);
  writeFileSync(join(repo, "a.txt"), "2\n");
  gitDep.git(["commit", "-am", "authored fix"], repo);
  gitDep.git(["checkout", "main"], repo);

  checkpointDep.record(join(repo, ".orch"), sid,
    { branch, round: 1, stage: "reviewed", decision: "AGREE", reason: "looks good" });
  // The record `resolveTaskBranch` would have written before the original run.
  resume.record(join(repo, ".orch"), "the original task text", "claude", { branch, sid });

  const cycleDeps = {
    ...fakeCycleDeps(),
    adapters: {
      get: (name) => ({
        name,
        async author() { throw new Error("resume must not re-author"); },
        async audit() { return { decision: "AGREE", reason: "still good", raw: "", usage: {} }; },
      }),
    },
  };
  const logs = await runMainInRepo(repo, ["continue", sid],
    { cycleDeps, finishRun: async () => {} });

  assert.match(logs.join("\n"), new RegExp(`${branch}: merged`));
  assert.deepEqual(resume.lookupForTask(join(repo, ".orch"), "the original task text"), []);
});

// Regression (codex review of #125 branch): `orch issue <n>` stamps `Closes #n`
// at merge time via ctx.closes (engine.js reads opts.closes when calling
// finalize). The checkpoint/inflight records `continue` reads never carried
// `closes`, so a resumed issue-bridge cycle merged WITHOUT ever closing its
// source issue. Checkpoint path: closes recovered from a completed round.
test("orch continue <sid> restores `closes` from the checkpoint so the issue still closes on merge", async () => {
  const repo = initGitRepo("orch-continue-closes-ck-");
  const sid = "c105e5c1";
  const branch = `pr/claude/some-fix-${sid}`;
  gitDep.git(["checkout", "-b", branch], repo);
  writeFileSync(join(repo, "a.txt"), "2\n");
  gitDep.git(["commit", "-am", "authored fix"], repo);
  gitDep.git(["checkout", "main"], repo);

  checkpointDep.record(join(repo, ".orch"), sid,
    { branch, round: 1, stage: "reviewed", decision: "AGREE", reason: "looks good", closes: 125 });

  let capturedCloses;
  const cycleDeps = {
    ...fakeCycleDeps(),
    finalize: async (ctx) => { capturedCloses = ctx.closes; return { status: "merged", reason: "test", sha: "abc" }; },
  };
  await runMainInRepo(repo, ["continue", sid], { cycleDeps, finishRun: async () => {} });

  assert.equal(capturedCloses, 125);
});

// Same recovery, via the inflight fallback (run died before its first
// checkpoint — the scenario `continue`'s inflight path exists for).
test("orch continue <sid> restores `closes` from the inflight fallback", async () => {
  const repo = initGitRepo("orch-continue-closes-inf-");
  const sid = "c105e5c2";
  const branch = `pr/claude/some-fix-${sid}`;
  gitDep.git(["checkout", "-b", branch], repo);
  writeFileSync(join(repo, "a.txt"), "2\n");
  gitDep.git(["commit", "-am", "authored fix"], repo);
  gitDep.git(["checkout", "main"], repo);

  inflight.register(join(repo, ".orch"), sid,
    { branch, pid: 999999999, baseSha: gitDep.git(["rev-parse", "main"], repo), closes: 125 });

  let capturedCloses;
  const cycleDeps = {
    ...fakeCycleDeps(),
    finalize: async (ctx) => { capturedCloses = ctx.closes; return { status: "merged", reason: "test", sha: "abc" }; },
  };
  await runMainInRepo(repo, ["continue", sid], { cycleDeps, finishRun: async () => {} });

  assert.equal(capturedCloses, 125);
});

// Regression (codex review of #125 branch): `cfg.agents` is only the rotation
// pool. A branch can legitimately be authored by a fixed `author:`/`--author`
// role outside that pool (e.g. `author: qwen3-coder-30b` with
// `agents: [claude, codex]`) — existing config/tests already allow this.
// `continue` must accept any REGISTERED adapter, not just names in cfg.agents.
test("orch continue <sid> accepts an author outside cfg.agents if it has a registered adapter", async () => {
  const repo = initGitRepo("orch-continue-fixedauthor-");
  const sid = "f1xeda01";
  const branch = `pr/qwen3-coder-30b/some-fix-${sid}`; // "qwen3-coder-30b" is not in the default cfg.agents pool
  gitDep.git(["checkout", "-b", branch], repo);
  writeFileSync(join(repo, "a.txt"), "2\n");
  gitDep.git(["commit", "-am", "authored fix"], repo);
  gitDep.git(["checkout", "main"], repo);

  checkpointDep.record(join(repo, ".orch"), sid,
    { branch, round: 1, stage: "reviewed", decision: "AGREE", reason: "looks good" });

  const logs = await runMainInRepo(repo, ["continue", sid],
    { cycleDeps: fakeCycleDeps(), finishRun: async () => {} });

  assert.match(logs.join("\n"), new RegExp(`${branch}: merged`));
});

// Regression (codex review of #125 branch): `continue` forked its own terminal
// handling instead of reusing the `task`/`issue` tail, dropping the issue-bridge
// escalation comment. Now that `continue` restores `closes` from the
// checkpoint/inflight record, it must also post the comment on escalation —
// same behavior as `orch issue` proper (see the sibling test above it mirrors).
test("orch continue posts a gh issue comment on escalation, using the restored closes", async () => {
  const savedExitCode = process.exitCode;
  const repo = initGitRepo("orch-continue-escalate-comment-");
  const sid = "e5ca1ate";
  const branch = `pr/claude/some-fix-${sid}`;
  gitDep.git(["checkout", "-b", branch], repo);
  writeFileSync(join(repo, "a.txt"), "2\n");
  gitDep.git(["commit", "-am", "authored fix"], repo);
  gitDep.git(["checkout", "main"], repo);

  checkpointDep.record(join(repo, ".orch"), sid,
    { branch, round: 1, stage: "reviewed", decision: "AGREE", reason: "looks good", closes: 52 });

  const calls = [];
  const gh = (args, input) => {
    if (args[0] === "issue" && args[1] === "comment") { calls.push({ args, input }); return ""; }
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  const escalating = { ...fakeCycleDeps(), finalize: async () => ({ status: "escalated", reason: "stalemate after cap", sha: "x" }) };
  try {
    await runMainInRepo(repo, ["continue", sid], { cycleDeps: escalating, githubDeps: () => ({ gh }) });
    assert.equal(process.exitCode, 2);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args[2], "52");
    assert.match(calls[0].input, /<!-- orch:result -->/);
    assert.match(calls[0].input, /ESCALATED/);
  } finally {
    process.exitCode = savedExitCode;
  }
});

// Regression (codex review of #125 branch): `continue` also dropped the
// detached docs-update spawn on a real merge — same behavior as `task`/`issue`.
test("orch continue spawns the docs-update task on a real merge", async () => {
  const repo = initGitRepo("orch-continue-docs-");
  const sid = "d0cspawn";
  const branch = `pr/claude/some-fix-${sid}`;
  gitDep.git(["checkout", "-b", branch], repo);
  writeFileSync(join(repo, "a.txt"), "2\n");
  gitDep.git(["commit", "-am", "authored fix"], repo);
  gitDep.git(["checkout", "main"], repo);

  checkpointDep.record(join(repo, ".orch"), sid,
    { branch, round: 1, stage: "reviewed", decision: "AGREE", reason: "looks good" });
  writeFileSync(join(repo, ".orch", "orch.yml"), "docs:\n  autoUpdate: true\n");

  const spawnCalls = [];
  const cycleDeps = {
    ...fakeCycleDeps(),
    finalize: async () => ({ status: "merged", reason: "test", sha: "abc", docsOnly: false, noop: false }),
  };
  await runMainInRepo(repo, ["continue", sid],
    { cycleDeps, finishRun: async () => {}, spawn: (...args) => { spawnCalls.push(args); return { unref() {} }; } });

  assert.equal(spawnCalls.length, 1);
});

// Regression (codex review of #126 branch, round 2): the previous fix
// protected the CHECKPOINT path but missed that `continue` ALSO re-registers
// itself in inflight (for its own liveness tracking during the resume) using
// the same `reviewers` value — which was still the possibly-overridden one,
// not the protected persistReviewers. If the original run only ever reached
// an inflight record (died before its first checkpoint — the inflight-only
// fallback path), that re-registration is the only remaining place a NEXT
// `continue` reads persisted roles from. inflight.register() runs BEFORE
// runCycle even starts, so we catch the bug by inspecting the file mid-flight
// (from inside the audit stub) rather than simulating an unrecoverable crash —
// a JS-level throw would just let the surrounding `finally` deregister it
// either way, proving nothing about what was actually written.
test("orch continue <sid> --reviewer override does not leak into the inflight-only fallback record", async () => {
  const repo = initGitRepo("orch-continue-roles-inflight-");
  const sid = "1nfl1ght";
  const branch = `pr/claude/some-fix-${sid}`;
  gitDep.git(["checkout", "-b", branch], repo);
  writeFileSync(join(repo, "a.txt"), "2\n");
  gitDep.git(["commit", "-am", "authored fix"], repo);
  gitDep.git(["checkout", "main"], repo);

  const orchDir = join(repo, ".orch");
  const originalReviewers = [{ agent: "codex", model: "gpt-5.1", effort: null }];
  // Dead pid: the original run died before its first review round ever wrote
  // a checkpoint — inflight is the only record `continue` has to work from.
  inflight.register(orchDir, sid, {
    branch, pid: 999999999, baseSha: gitDep.git(["rev-parse", "main"], repo),
    author: { agent: "claude", model: null, effort: null }, reviewers: originalReviewers,
  });

  let midFlight = null;
  const cycleDeps = {
    ...fakeCycleDeps(),
    adapters: {
      get: (name) => ({
        name,
        async author() { throw new Error("resume must not re-author"); },
        async audit() {
          // inflight.register for THIS resume attempt already ran before
          // runCycle started — check what it actually wrote.
          midFlight = inflight.lookup(orchDir, sid);
          return { decision: "AGREE", reason: "still good", raw: "", usage: {} };
        },
      }),
    },
  };
  writeFileSync(join(orchDir, "orch.yml"), "agents: [claude, codex, copilot]\n");

  await runMainInRepo(repo, ["continue", sid, "--reviewer", "copilot"],
    { cycleDeps, finishRun: async () => {} });

  assert.ok(midFlight, "audit stub must have run and captured the inflight record");
  assert.deepEqual(midFlight.reviewers, originalReviewers); // NOT [copilot]
});

test("summaryLine colors a merged result green when color is on", () => {
  const result = { status: "merged", reason: "agreed + green", rounds: 2, usageSummary: "128k tok · $0.42" };
  const out = summaryLine(result, "pr/claude/x", false, "", true);
  assert.match(out, new RegExp(`\\x1b\\[38;5;71mmerged\\x1b\\[0m`));
  assert.match(out, /pr\/claude\/x/);
});

test("summaryLine colors an escalated result red when color is on", () => {
  const result = { status: "escalated", reason: "stalemate", rounds: 3, usageSummary: "50k tok" };
  const out = summaryLine(result, "pr/codex/y", false, "", true);
  assert.match(out, new RegExp(`\\x1b\\[38;5;167mescalated\\x1b\\[0m`));
});

test("summaryLine emits no ANSI codes when color is off", () => {
  const result = { status: "merged", reason: "ok", rounds: 1, usageSummary: "$0" };
  const out = summaryLine(result, "b", true, "", false);
  assert.doesNotMatch(out, /\x1b\[/);
  assert.match(out, /^orch \(dry\): b: merged \(ok\) after 1 round\(s\); cost \$0$/);
});

test("summaryLine prefixes an issue number when supplied", () => {
  const result = { status: "merged", reason: "ok", rounds: 1, usageSummary: "$0" };
  assert.equal(
    summaryLine(result, "pr/claude/x", false, "", false, 442),
    "orch: #442 pr/claude/x: merged (ok) after 1 round(s); cost $0",
  );
  assert.equal(
    summaryLine(result, "pr/claude/x", false, "", false),
    "orch: pr/claude/x: merged (ok) after 1 round(s); cost $0",
  );
});

test("summaryLine keeps a multi-line reason out of the parenthetical, appended below instead", () => {
  const reason = "opened PR https://x/pr/7. Vetted: agents AGREE, tests green, security clean.\n## Merge deferred: dirty-merge\nmerge result: ```\nCONFLICT (content): Merge conflict in CHANGELOG.md\n```";
  const result = { status: "merge-deferred", trigger: "dirty-merge", reason, rounds: 1, usageSummary: "$0" };
  const out = summaryLine(result, "b", true, "", false);
  const [firstLine, ...restLines] = out.split("\n");
  assert.match(firstLine, /^orch \(dry\): b: merge-deferred \(dirty-merge\) — opened PR https:\/\/x\/pr\/7\. Vetted: agents AGREE, tests green, security clean; completed after 1 round\(s\); cost \$0$/);
  assert.equal(restLines.join("\n"), reason.split("\n").slice(1).join("\n"));
});

// #N: `orch issue <n>` used to stage a second branch for an issue that already
// had one, silently. The join key is the ISSUE NUMBER persisted on the run
// record — NOT the branch slug, which is derived from the (editable) title.
function stagePriorRun(repo, branch, entry) {
  gitDep.git(["branch", branch], repo);
  mkdirSync(join(repo, ".orch"), { recursive: true });
  writeFileSync(join(repo, ".orch", "runs.jsonl"),
    JSON.stringify({ ts: "2026-07-26T00:00:00Z", branch, sid: "9999-0", verdict: "escalated", reason: "security scan blocked the merge — 1 finding (guardrail-touch ×1)", ...entry }) + "\n");
}

// A second run record for the same branch, as a later cycle (or `orch review`)
// appends it.
function appendRun(repo, branch, entry) {
  const f = join(repo, ".orch", "runs.jsonl");
  writeFileSync(f, readFileSync(f, "utf8") +
    JSON.stringify({ ts: "2026-07-26T01:00:00Z", branch, sid: "9999-1", verdict: "escalated", reason: "stalemate", ...entry }) + "\n");
}

function issueGh(number, title) {
  return (args) => {
    if (args[0] === "--version") return "gh 2";
    if (args[0] === "auth" && args[1] === "status") return "Logged in";
    if (args[0] === "issue" && args[1] === "view") return JSON.stringify({ number, title, body: "why this matters", state: "OPEN" });
    if (args[0] === "issue" && args[1] === "comment") return "";
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
}

const escalatingDeps = () => ({ ...fakeCycleDeps(), finalize: async () => ({ status: "escalated", reason: "stalemate", sha: "x" }) });

test("orch issue <n> warns about a branch a prior run staged for the same issue (title unchanged)", async () => {
  const saved = process.exitCode;
  const repo = initGitRepo();
  stagePriorRun(repo, "pr/claude/stale-base-9999-0", { closes: 52 });
  try {
    const logs = await runMainInRepo(repo, ["issue", "52"],
      { cycleDeps: escalatingDeps(), githubDeps: () => ({ gh: issueGh(52, "stale base") }) });
    const out = logs.join("\n");
    assert.match(out, /issue #52 already has 1 staged branch/);
    assert.match(out, /pr\/claude\/stale-base-9999-0 — escalated/);
    assert.match(out, /orch review pr\/claude\/stale-base-9999-0/);
    assert.doesNotMatch(out, /may belong to another issue/);
  } finally {
    process.exitCode = saved;
  }
});

test("orch issue <n> still finds the prior branch after the issue title was edited", async () => {
  const saved = process.exitCode;
  const repo = initGitRepo();
  // Branch slug is from the OLD title; the issue now has a different one.
  stagePriorRun(repo, "pr/claude/stale-base-9999-0", { closes: 52 });
  try {
    const logs = await runMainInRepo(repo, ["issue", "52"],
      { cycleDeps: escalatingDeps(), githubDeps: () => ({ gh: issueGh(52, "orch bases cycles on a stale local main") }) });
    assert.match(logs.join("\n"), /issue #52 already has 1 staged branch[\s\S]*pr\/claude\/stale-base-9999-0/);
  } finally {
    process.exitCode = saved;
  }
});

test("orch issue <n> does not claim another issue's branch that happens to share the slug", async () => {
  const saved = process.exitCode;
  const repo = initGitRepo();
  stagePriorRun(repo, "pr/claude/stale-base-9999-0", { closes: 362 });
  try {
    const logs = await runMainInRepo(repo, ["issue", "999"],
      { cycleDeps: escalatingDeps(), githubDeps: () => ({ gh: issueGh(999, "stale base") }) });
    assert.doesNotMatch(logs.join("\n"), /already has \d+ staged branch/);
  } finally {
    process.exitCode = saved;
  }
});

test("a legacy branch with no persisted issue number is reported, flagged uncertain", () => {
  const repo = initGitRepo();
  const branch = "pr/claude/stale-base-9999-0";
  stagePriorRun(repo, branch, {}); // pre-fix record: no `closes`
  const found = priorStagedBranches({ repo, orchDir: join(repo, ".orch"), closes: 52, task: "stale base" });
  assert.deepEqual(found.map((e) => [e.branch, e.uncertain]), [[branch, true]]);
  assert.match(formatPriorStagedBranches(52, found), /may belong to another issue/);
});

// Regression: `orch review <branch>` runs with no issue, so its run record has
// no `closes`. Matching record-by-record let that one untagged record hand the
// branch to any same-titled issue — the cross-issue false attribution the
// number-based join exists to prevent. History is folded per branch first.
test("a later untagged review record does not hand another issue's branch to a same-title issue", async () => {
  const repo = initGitRepo();
  const branch = "pr/claude/stale-base-9999-0";
  const orchDir = join(repo, ".orch");
  stagePriorRun(repo, branch, { closes: 362 });  // orch issue 362 staged it
  appendRun(repo, branch, {});                   // orch review <branch> — no issue number

  // Issue #999, same title → same slug: must NOT claim #362's branch.
  assert.deepEqual(priorStagedBranches({ repo, orchDir, closes: 999, task: "stale base" }), []);
  const saved = process.exitCode;
  try {
    const logs = await runMainInRepo(repo, ["issue", "999"],
      { cycleDeps: escalatingDeps(), githubDeps: () => ({ gh: issueGh(999, "stale base") }) });
    assert.doesNotMatch(logs.join("\n"), /already has \d+ staged branch/);
  } finally {
    process.exitCode = saved;
  }

  // ...and #362 still sees it, with no uncertainty hedge.
  assert.deepEqual(priorStagedBranches({ repo, orchDir, closes: 362, task: "stale base" })
    .map((e) => [e.branch, e.uncertain]), [[branch, false]]);
});

test("priorStagedBranches skips a branch that no longer exists", () => {
  const repo = initGitRepo();
  stagePriorRun(repo, "pr/claude/stale-base-9999-0", { closes: 52 });
  gitDep.git(["branch", "-D", "pr/claude/stale-base-9999-0"], repo);
  assert.deepEqual(priorStagedBranches({ repo, orchDir: join(repo, ".orch"), closes: 52, task: "stale base" }), []);
});

test("realDeps stamps the issue number onto every run record it writes", () => {
  const orchDir = mkdtempSync(join(tmpdir(), "orch-closes-"));
  realDeps({ closes: 52 }).notify.recordRun(orchDir, { branch: "pr/claude/x-1-0", sid: "1-0", verdict: "escalated" });
  const entry = JSON.parse(readFileSync(join(orchDir, "runs.jsonl"), "utf8").trim());
  assert.equal(entry.closes, 52);
});

test("realDeps never overwrites a record that already carries its own issue number", () => {
  // A redriven deferred peer belongs to a DIFFERENT issue than the cycle that
  // unblocked it; stamping this run's number on it is cross-issue misattribution.
  const orchDir = mkdtempSync(join(tmpdir(), "orch-closes-peer-"));
  const { notify: n } = realDeps({ closes: 362 });
  n.recordRun(orchDir, { branch: "pr/codex/b-2-0", sid: "2-0", verdict: "merged", closes: 999 });
  // An explicit null is an answer too: an `orch task` peer has no issue at all.
  n.recordRun(orchDir, { branch: "pr/codex/c-3-0", sid: "3-0", verdict: "merged", closes: null });
  const entries = readFileSync(join(orchDir, "runs.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(entries.map((e) => e.closes), [999, null]);
});

test("the prior-branch notice does not claim a re-run is futile", () => {
  const out = formatPriorStagedBranches(52, [{ branch: "pr/claude/x-1-0", sid: "1-0", verdict: "escalated", reason: "security scan blocked the merge" }]);
  assert.doesNotMatch(out, /cannot change|deterministic|no point|futile/i);
  assert.match(out, /rotates the author and regenerates the diff/);
});

test("the issue number reaches realDeps, so this run's records are tagged for the next run", async () => {
  const saved = process.exitCode;
  const repo = initGitRepo();
  let seen;
  const realDepsSpy = (opts) => { seen = opts; return escalatingDeps(); };
  try {
    await runMainInRepo(repo, ["issue", "52"],
      { cycleDeps: undefined, realDeps: realDepsSpy, githubDeps: () => ({ gh: issueGh(52, "stale base") }) });
    assert.equal(seen?.closes, 52);
  } finally {
    process.exitCode = saved;
  }
});

// `orch release` — human counterpart of finalize()'s post-merge bump, for
// escalations that are hand-landed onto orch/integration.
function releaseFixture() {
  const repo = mkdtempSync(join(tmpdir(), "orch-release-"));
  gitDep.git(["init", "-b", "main"], repo);
  gitDep.git(["config", "user.email", "t@t"], repo);
  gitDep.git(["config", "user.name", "t"], repo);
  gitDep.git(["config", "core.autocrlf", "false"], repo);
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "x", version: "0.4.1" }, null, 2) + "\n");
  gitDep.git(["add", "."], repo);
  gitDep.git(["commit", "-m", "init"], repo);
  return repo;
}

test("orch release on a clean fixture bumps integration, not the primary checkout", async () => {
  const repo = releaseFixture();
  const before = gitDep.git(["rev-list", "--count", "HEAD"], repo).trim();
  const logs = await runMainInRepo(repo, ["release", "hand-landed guardrail fix (closes #403)"]);
  const output = logs.join("\n");
  assert.match(output, /chore\(release\): v0\.4\.2 committed on orch\/integration in /);
  assert.ok(output.includes(join(repo, ".orch", "integration")));

  const pkg = JSON.parse(gitDep.git(["show", "orch/integration:package.json"], repo));
  assert.equal(pkg.version, "0.4.2");
  const changelog = gitDep.git(["show", "orch/integration:CHANGELOG.md"], repo);
  assert.match(changelog, /hand-landed guardrail fix \(closes #403\)/);
  assert.match(changelog, /^# Changelog\n\n## v0\.4\.2 — \d{4}-\d{2}-\d{2}/);

  assert.equal(JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version, "0.4.1");
  assert.equal(gitDep.git(["rev-list", "--count", "HEAD"], repo).trim(), before, "main remains unchanged");
  const subject = gitDep.git(["log", "-1", "--format=%s", "orch/integration"], repo).trim();
  assert.equal(subject, "chore(release): v0.4.2");
  // No tag — tagging is CI's job.
  assert.equal(gitDep.git(["tag"], repo).trim(), "");
});

test("orch release reconciles origin before bumping the integration worktree", async () => {
  const repo = releaseFixture();
  const { peer } = addOriginWithPeer(repo);
  const integration = gitDep.ensureIntegrationWorktree(repo, join(repo, ".orch"));
  gitDep.git(["push", "-u", "origin", "orch/integration"], integration);
  gitDep.git(["fetch", "origin"], peer);
  gitDep.git(["switch", "-c", "orch/integration", "--track", "origin/orch/integration"], peer);
  writeFileSync(join(peer, "hand-landed.txt"), "pushed directly to origin\n");
  gitDep.git(["add", "."], peer);
  gitDep.git(["commit", "-m", "hand-landed integration change"], peer);
  gitDep.git(["push", "origin", "orch/integration"], peer);

  const logs = await runMainInRepo(repo, ["release", "recover remote hand-merge"]);
  assert.match(logs.join("\n"), /committed on orch\/integration in /);
  assert.equal(gitDep.git(["show", "orch/integration:hand-landed.txt"], repo), "pushed directly to origin");
  assert.equal(JSON.parse(gitDep.git(["show", "orch/integration:package.json"], repo)).version, "0.4.2");
});

test("orch release reports a dirty integration worktree before origin reconciliation", async () => {
  const repo = releaseFixture();
  const { peer } = addOriginWithPeer(repo);
  const integration = gitDep.ensureIntegrationWorktree(repo, join(repo, ".orch"));
  gitDep.git(["push", "-u", "origin", "orch/integration"], integration);
  gitDep.git(["fetch", "origin"], peer);
  gitDep.git(["switch", "-c", "orch/integration", "--track", "origin/orch/integration"], peer);
  writeFileSync(join(peer, "wip.txt"), "remote hand-merge\n");
  gitDep.git(["add", "."], peer);
  gitDep.git(["commit", "-m", "remote hand-merge"], peer);
  gitDep.git(["push", "origin", "orch/integration"], peer);
  writeFileSync(join(integration, "wip.txt"), "local uncommitted work\n");

  await assert.rejects(
    () => runMainInRepo(repo, ["release", "should not land"]),
    /working tree is dirty[\s\S]*wip\.txt/,
  );
  assert.equal(readFileSync(join(integration, "wip.txt"), "utf8"), "local uncommitted work\n");
});

test("orch release serializes with finalize's merge lock", async () => {
  const repo = releaseFixture();
  const orchDir = join(repo, ".orch");
  mkdirSync(orchDir, { recursive: true });
  const lockPath = join(orchDir, "merge.lock");
  writeFileSync(lockPath, String(process.pid));

  try {
    let completed = false;
    const pending = runMainInRepo(repo, ["release", "wait for integration lock"]).then((logs) => {
      completed = true;
      return logs;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(completed, false);
    rmSync(lockPath, { force: true });
    const logs = await pending;
    assert.match(logs.join("\n"), /chore\(release\): v0\.4\.2/);
  } finally {
    rmSync(lockPath, { force: true });
  }
});

test("orch release works when integrationBranch is the base branch", async () => {
  const repo = releaseFixture();
  mkdirSync(join(repo, ".orch"), { recursive: true });
  writeFileSync(join(repo, ".orch", "orch.yml"), "baseBranch: main\nintegrationBranch: main\n");
  gitDep.git(["add", ".orch/orch.yml"], repo);
  gitDep.git(["commit", "-m", "configure base integration branch"], repo);

  const logs = await runMainInRepo(repo, ["release", "base branch recovery"]);

  assert.match(logs.join("\n"), /chore\(release\): v0\.4\.2 committed on main in /);
  assert.equal(JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version, "0.4.2");
  assert.equal(gitDep.git(["rev-parse", "--abbrev-ref", "HEAD"], repo), "main");
  assert.equal(gitDep.git(["worktree", "list"], repo).includes(join(repo, ".orch", "integration")), false);
});

test("orch release on a dirty fixture exits non-zero and leaves the dirty file byte-for-byte untouched", async () => {
  const repo = releaseFixture();
  const integration = gitDep.ensureIntegrationWorktree(repo, join(repo, ".orch"));
  const dirtyPath = join(integration, "wip.txt");
  const dirtyBytes = "human WIP — must not be clobbered by release recovery\n";
  writeFileSync(dirtyPath, dirtyBytes);

  await assert.rejects(
    () => runMainInRepo(repo, ["release", "should not land"]),
    /working tree is dirty[\s\S]*wip\.txt/,
  );

  assert.equal(readFileSync(dirtyPath, "utf8"), dirtyBytes);
  // package.json must also be untouched (no partial bump, no whole-tree reset)
  const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
  assert.equal(pkg.version, "0.4.1");
  assert.equal(gitDep.git(["log", "-1", "--format=%s"], repo).trim(), "init");
});

test("orch release without an entry prints usage", async () => {
  const repo = releaseFixture();
  await assert.rejects(() => runMainInRepo(repo, ["release"]), /usage: orch release/);
});

test("missing required positional exits 64 like every other usage error", async () => {
  // These used to throw a plain Error (exit 1), splitting "you typed it wrong"
  // errors across two exit codes. All usage errors share one contract: 64.
  await assert.rejects(() => main(["release"], { preflight() {} }), (e) => e.exit === 64);
  await assert.rejects(() => main(["issue", "abc"], { preflight() {} }), (e) => e.exit === 64);
  await assert.rejects(() => main(["task"], { preflight() {} }), (e) => e.exit === 64);
  await assert.rejects(() => main(["review"], { preflight() {} }), (e) => e.exit === 64);
  await assert.rejects(() => main(["continue"], { preflight() {} }), (e) => e.exit === 64);
  // This deliberately uses no probe stub: a missing branch is answerable from
  // local git and must remain a usage error in a bare environment.
  await assert.rejects(
    () => runMainCapture(["pr", "abc"]),
    (e) => e.exit === 64 && /branch does not exist/.test(e.message),
  );
  await assert.rejects(() => main(["agent", "add"], { preflight() {} }), (e) => e.exit === 64);
  await assert.rejects(() => main(["agent", "build"], { preflight() {} }), (e) => e.exit === 64);
  await assert.rejects(
    () => main(["agent", "typo", "widget", "--build"], { preflight() {} }),
    (e) => e.exit === 64,
  );
});

// applyRoleOverrides used to throw a plain Error for a lopsided --author(s)/
// --reviewer(s) pair — a usage mistake, but exit 1 instead of the 64 every
// other "you typed it wrong" case above gets.
test("a lopsided --author/--reviewer pair exits 64, not 1", () => {
  assert.throws(
    () => applyRoleOverrides({ agents: ["claude"] }, { author: "claude" }),
    (e) => e.exit === 64 && /set both --author\(s\) and --reviewer\(s\)/.test(e.message),
  );
  assert.throws(
    () => applyRoleOverrides({ agents: ["claude"] }, { author: " ", reviewer: "codex" }),
    (e) => e.exit === 64 && /role override must name at least one agent/.test(e.message),
  );
});

// `mcp` serves stdio as a JSON-RPC transport and never returns on its own —
// if --help/--version don't route ahead of it, `orch mcp --help` hangs
// instead of printing and exiting.
test("orch mcp --help and --version print and return instead of entering MCP dispatch", async () => {
  const logs = await runMainCapture(["mcp", "--help"]);
  assert.match(logs.join("\n"), /Usage: orch <command>/);
  const versionLogs = await runMainCapture(["mcp", "--version"]);
  assert.match(versionLogs.join("\n"), /^v\d/);
});

// Positional/subcommand grammar used to be unchecked: these all ran the
// command and silently dropped the extra argument instead of refusing it.
test("a stray positional argument is a usage error, not silently dropped", async () => {
  await assert.rejects(() => main(["completion", "typo"], { preflight() {} }), (e) => e.exit === 64);
  await assert.rejects(() => runMainCapture(["dashboard", "extra", "--once"]), (e) => e.exit === 64);
  await assert.rejects(() => runMainCapture(["help", "extra"]), (e) => e.exit === 64);
  await assert.rejects(() => runMainCapture(["version", "extra"]), (e) => e.exit === 64);
});

// `agent add` and `agent build` used to share one flag list, so `--pr` (only
// meaningful when a build actually happens) validated on a plain `add`, and
// `--build` (redundant — the subcommand already says so) validated on
// `build`. Both silently did nothing, which is the exact "declared but
// inert" defect this schema exists to remove.
test("agent add and agent build do not share a flag set", async () => {
  await assert.rejects(
    () => main(["agent", "add", "widget", "--pr"], { preflight() {} }),
    (e) => e.exit === 64 && /--pr is not valid with 'orch agent add' without --build/.test(e.message),
  );
  await assert.rejects(
    () => main(["agent", "build", "widget", "--build"], { preflight() {} }),
    (e) => e.exit === 64 && /--build is not valid with 'orch agent build'/.test(e.message),
  );
  // --pr is legal on `agent add <unregistered> --build` (it reaches buildAgent).
  const d = mkdtempSync(join(tmpdir(), "orch-add-build-pr-"));
  await runMainInRepo(d, ["init"], { detectAgents: () => ({ found: [], missing: [] }) });
  let received = null;
  await runMainInRepo(d, ["agent", "add", "widget", "--build", "--pr"], {
    buildAgent: async (name, ctx) => { received = ctx.flags.pr; return { status: "approved", branch: "b" }; },
  });
  assert.equal(received, true);
});

test("agent add rejects a trailing extra argument", async () => {
  await assert.rejects(
    () => main(["agent", "add", "widget", "extra"], { preflight() {} }),
    (e) => e.exit === 64 && /'orch agent add' takes a single <name> argument/.test(e.message),
  );
});

test("unknown command errors instead of printing usage and exiting 0", async () => {
  await assert.rejects(
    // --dry only gates the background update check; dispatch is unaffected.
    () => main(["tsak", "some change", "--dry"], { preflight() {} }),
    /unknown command: tsak/,
  );
  // Bare `orch` is a real "show me the tool" request: usage, no throw.
  const logs = [];
  const orig = console.log;
  console.log = (m) => logs.push(m);
  try {
    await main([], { preflight() {} });
  } finally {
    console.log = orig;
  }
  assert.match(logs.join("\n"), /Usage: orch <command>/);
});

// --dry is a documented safety rail ("plan without shelling out or changing
// git"), but the write commands with no cycle of their own to stub out — init,
// agent add, pr, release — parsed the flag and then mutated anyway. Each test
// below asserts the ABSENT effect (no file written, no version bumped, no
// shell-out), not the printed line: a log assertion alone would still pass if
// the real work ran underneath it.
test("orch init --dry writes nothing", async () => {
  const d = mkdtempSync(join(tmpdir(), "orch-init-dry-"));
  // --link is included: it is the one init effect outside .orch/, writing to the
  // agent docs in the repo root.
  const logs = await runMainInRepo(d, ["init", "--link", "--dry"], {
    preflight() { throw new Error("preflight ran"); },
    detectAgents: () => { throw new Error("detectAgents ran"); },
  });
  assert.equal(existsSync(join(d, ".orch", "orch.yml")), false);
  assert.equal(existsSync(join(d, ".orch", "ORCH.md")), false);
  assert.equal(existsSync(join(d, "CLAUDE.md")), false);
  assert.match(logs.join("\n"), /orch \(dry\)/);
});

test("orch agent add --dry leaves orch.yml byte-identical", async () => {
  const d = mkdtempSync(join(tmpdir(), "orch-add-dry-"));
  await runMainInRepo(d, ["init"], { detectAgents: () => ({ found: [], missing: [] }) });
  const file = join(d, ".orch", "orch.yml");
  const before = readFileSync(file, "utf8");
  const logs = await runMainInRepo(d, ["agent", "add", "gemini", "--dry"]);
  assert.equal(readFileSync(file, "utf8"), before);
  assert.match(logs.join("\n"), /orch \(dry\)/);
  // ...and the real run still edits it, so the guard didn't disable the command.
  await runMainInRepo(d, ["agent", "add", "gemini"]);
  assert.match(readFileSync(file, "utf8"), /gemini/);
});

// `adapters.get(name)` answers "does orch's code have an adapter for this
// CLI" — a REGISTRY lookup. "Is `name` in THIS repo's agents: list" is a
// different question, answered by reading orch.yml. `agent add <name>
// --build` used to conflate them: buildAgent() returns "already-registered"
// whenever the REGISTRY has the adapter, and the CLI treated that as "done"
// — so a fresh repo with an empty agents: list, given a name orch already
// ships code for, printed "already registered" and never touched orch.yml.
test("agent add <known-adapter> --build still adds it — code existing isn't the same as being in this repo's agents", async () => {
  const d = mkdtempSync(join(tmpdir(), "orch-add-build-known-"));
  await runMainInRepo(d, ["init"], { detectAgents: () => ({ found: [], missing: [] }) });
  const file = join(d, ".orch", "orch.yml");
  // gemini ships a real adapter (src/adapters/gemini.js) but a fresh init's
  // agents: list is just claude/codex — exactly the reviewer's repro.
  const logs = await runMainInRepo(d, ["agent", "add", "gemini", "--build"], {
    buildAgent: async () => assert.fail("buildAgent ran — gemini's adapter code already exists, nothing to build"),
  });
  assert.match(readFileSync(file, "utf8"), /gemini/);
  assert.match(logs.join("\n"), /added gemini to agents/);
});

// Third variant of the same bug: `agent add <known-adapter> --build --pr`
// validates (schema.js allows --pr/role overrides alongside --build), but the
// known-adapter path never runs a build cycle — so --pr and the role
// overrides, which only mean something for a build, were silently dropped
// instead of refused. Fix the routing (reject them once, in the branch that
// skips the build), not the individual flag.
test("agent add <known-adapter> --build --pr is a usage error, not a silent drop", async () => {
  const d = mkdtempSync(join(tmpdir(), "orch-add-build-known-pr-"));
  await runMainInRepo(d, ["init"], { detectAgents: () => ({ found: [], missing: [] }) });
  const file = join(d, ".orch", "orch.yml");
  const before = readFileSync(file, "utf8");
  await assert.rejects(
    () => runMainInRepo(d, ["agent", "add", "gemini", "--build", "--pr"], {
      buildAgent: async () => assert.fail("buildAgent ran — gemini's adapter code already exists, nothing to build"),
    }),
    (e) => e.exit === 64 && /--pr is not valid with 'orch agent add gemini'/.test(e.message),
  );
  await assert.rejects(
    () => runMainInRepo(d, ["agent", "add", "gemini", "--build", "--reviewer", "codex"], {
      buildAgent: async () => assert.fail("buildAgent ran — gemini's adapter code already exists, nothing to build"),
    }),
    (e) => e.exit === 64 && /--reviewer is not valid with 'orch agent add gemini'/.test(e.message),
  );
  // orch.yml is byte-identical — a usage error must not partially apply the add.
  assert.equal(readFileSync(file, "utf8"), before);
});

// Fourth variant: the round-3 fix's build-only-flags list (cli.js) named
// pr/author/authors/reviewer/reviewers but left out --allow-large-scope,
// which SUBCOMMAND_FLAGS["agent build"] declares just as build-only — so
// `--allow-large-scope` alone validated, reached the known-adapter branch,
// and was silently dropped exactly like the flags criterion 19 fixed for.
test("agent add <known-adapter> --build --allow-large-scope is a usage error, not a silent drop", async () => {
  const d = mkdtempSync(join(tmpdir(), "orch-add-build-known-scope-"));
  await runMainInRepo(d, ["init"], { detectAgents: () => ({ found: [], missing: [] }) });
  const file = join(d, ".orch", "orch.yml");
  const before = readFileSync(file, "utf8");
  await assert.rejects(
    () => runMainInRepo(d, ["agent", "add", "gemini", "--build", "--allow-large-scope"], {
      buildAgent: async () => assert.fail("buildAgent ran — gemini's adapter code already exists, nothing to build"),
    }),
    (e) => e.exit === 64 && /--allow-large-scope is not valid with 'orch agent add gemini'/.test(e.message),
  );
  assert.equal(readFileSync(file, "utf8"), before);
});

// The known-adapter build-only-flags check above used to live deep inside
// cli.js's `agent` dispatch, which main() only reaches after the
// update-check network call and the GitHub App auth mint. Moving the check
// into validatePositionals (schema.js), which main() calls immediately after
// parse(), means a doomed `agent add <known> --build --pr` never fires either
// side effect — the same "validate before every side effect" property
// criterion 17/20 required elsewhere in this schema.
test("agent add <known-adapter> --build --pr is refused before the update-check side effect fires", async () => {
  const d = mkdtempSync(join(tmpdir(), "orch-add-build-known-noupdate-"));
  await runMainInRepo(d, ["init"], { detectAgents: () => ({ found: [], missing: [] }) });
  let updateChecked = false;
  await assert.rejects(
    () => runMainInRepo(d, ["agent", "add", "gemini", "--build", "--pr"], {
      maybeNotifyUpdate: () => { updateChecked = true; return Promise.resolve(); },
      buildAgent: async () => assert.fail("buildAgent ran — gemini's adapter code already exists, nothing to build"),
    }),
    (e) => e.exit === 64,
  );
  assert.equal(updateChecked, false, "update-check must not fire before a usage error is refused");
});

test("orch pr --merge --dry never preflights, authenticates, or shells out to gh", async () => {
  const d = mkdtempSync(join(tmpdir(), "orch-pr-dry-"));
  const logs = await runMainInRepo(d, ["pr", "123", "--merge", "--dry"], {
    preflight() { throw new Error("preflight ran"); },
    githubDeps: () => ({ gh: () => { throw new Error("gh ran"); } }),
  });
  assert.match(logs.join("\n"), /orch \(dry\).*#123/);
  assert.equal(existsSync(join(d, ".orch", "lock")), false, "no lock acquired");
  // Usage validation still precedes the dry guard.
  await assert.rejects(
    () => runMainInRepo(d, ["pr", "abc", "--dry"], { preflight() {} }),
    /usage: orch pr <number>/,
  );
});

// `orch completion install` writes ~/.orch/completion.bash — a real mutation,
// like the ones above, that used to have no --dry escape hatch at all (the
// schema declared `completion` with an empty flag list). cli.js's dispatch
// takes a `completionDeps.homedir` override (threaded to installCompletion),
// so the test points it at a throwaway tmpdir instead of the real home
// directory — a test whose safety depended on the dry-run guard never
// regressing (comparing a snapshot of the real file) could corrupt the
// developer's actual ~/.orch/completion.bash the moment that guard broke.
test("orch completion install --dry writes nothing", async () => {
  const home = mkdtempSync(join(tmpdir(), "orch-completion-home-"));
  const target = join(home, ".orch", "completion.bash");
  const logs = await runMainCapture(["completion", "install", "--dry"], {
    completionDeps: { homedir: () => home },
  });
  assert.equal(existsSync(target), false);
  assert.match(logs.join("\n"), /orch \(dry\).*completion\.bash/);
});

test("orch completion install writes the script under the given home directory", async () => {
  const home = mkdtempSync(join(tmpdir(), "orch-completion-home-"));
  const target = join(home, ".orch", "completion.bash");
  await runMainCapture(["completion", "install"], {
    completionDeps: { homedir: () => home },
  });
  assert.equal(existsSync(target), true);
});

test("--dry is only valid with 'orch completion install', not the bare print", async () => {
  await assert.rejects(
    () => runMainCapture(["completion", "--dry"]),
    /--dry is only valid with 'orch completion install'/,
  );
  await assert.rejects(
    () => runMainCapture(["completion", "bash", "--dry"]),
    /--dry is only valid with 'orch completion install'/,
  );
});

test("orch release --dry leaves package.json and CHANGELOG untouched", async () => {
  const repo = releaseFixture();
  const before = readFileSync(join(repo, "package.json"), "utf8");
  const logs = await runMainInRepo(repo, ["release", "would-be entry"], {}); // sanity: real path bumps
  assert.match(logs.join("\n"), /chore\(release\)/);
  const bumped = gitDep.git(["show", "orch/integration:package.json"], repo);
  assert.notEqual(bumped, before);

  const dryRepo = releaseFixture();
  const pkgBefore = readFileSync(join(dryRepo, "package.json"), "utf8");
  const dryLogs = await runMainInRepo(dryRepo, ["release", "hand-landed fix", "--dry"]);
  assert.equal(readFileSync(join(dryRepo, "package.json"), "utf8"), pkgBefore);
  assert.equal(existsSync(join(dryRepo, "CHANGELOG.md")), false);
  assert.match(dryLogs.join("\n"), /orch \(dry\)/);
  // Usage validation still precedes the dry guard.
  await assert.rejects(() => runMainInRepo(dryRepo, ["release", "--dry"]), /usage: orch release/);
});

// P2: durable run record (docs/cli-v2-implementation-plan.md §3 P2).
test("orch task leaves a run record with an outcome", async () => {
  const repo = initGitRepo();
  await runMainInRepo(repo, ["task", "some task", "--no-tidy"]);
  const dir = join(repo, ".orch", "run-records");
  const files = readdirSync(dir);
  assert.equal(files.length, 1);
  const record = JSON.parse(readFileSync(join(dir, files[0]), "utf8"));
  assert.equal(record.outcome, "reached");
  assert.equal(record.state, "READY");
  assert.equal(record.exit, 0);
  assert.equal(record.command, "task");
});

test("orch task --dry writes no run record", async () => {
  const repo = initGitRepo();
  await runMainInRepo(repo, ["task", "some task", "--dry"]);
  assert.equal(existsSync(join(repo, ".orch", "run-records")), false);
});

// Checkpoint/resume/inflight are still cleared on every terminal return (design
// §5.1: "checkpoint semantics unchanged" — the run-controller that would keep a
// stopped-at-cap cycle resumable via `continue` is a later slice), so a plain
// `orch task` escalation leaves a run record `continue` can look up by runId,
// but nothing left to actually reattach to — same "nothing to resume" refusal
// a pre-v2 sid gets today. `resumeTerminal` (the fresh-budget grant, inert
// until P5) only runs once the checkpoint/inflight lookup has confirmed
// there's something to reattach — so a refusal must leave the record's
// outcome/exit exactly as the original cycle left them, not null them out.
test("orch continue on a stopped-at-cap record with nothing to reattach refuses without corrupting the record", async () => {
  const savedExitCode = process.exitCode;
  const repo = initGitRepo();
  const escalating = { ...fakeCycleDeps(), finalize: async () => ({ status: "escalated", reason: "stalemate after cap", sha: "x" }) };
  try {
    await runMainInRepo(repo, ["task", "some task", "--no-tidy"], { cycleDeps: escalating });
    const dir = join(repo, ".orch", "run-records");
    const [file] = readdirSync(dir);
    const runId = file.replace(/\.json$/, "");
    let record = JSON.parse(readFileSync(join(dir, file), "utf8"));
    assert.equal(record.outcome, "stopped-at-cap");
    assert.equal(record.state, "STOPPED_AT_CAP");
    assert.equal(record.cycles[0].sid, runId); // single-cycle run: runId == its own sid

    await assert.rejects(
      () => runMainInRepo(repo, ["continue", runId], { cycleDeps: escalating }),
      /no checkpoint or inflight record/,
    );
    record = JSON.parse(readFileSync(join(dir, file), "utf8"));
    assert.equal(record.outcome, "stopped-at-cap"); // refusal must not touch the record
    assert.equal(record.exit, 2);
  } finally {
    process.exitCode = savedExitCode;
  }
});

// `--until once` sets policy.maxAttempts: 0 — a legitimate value, not "unset".
// `priorRun.policy?.maxAttempts || 1` would coerce that 0 to 1 (both `0` and
// `undefined` are falsy), silently granting a bigger budget than the original
// run asked for; `?? 1` only substitutes on `null`/`undefined`.
test("orch continue on a resumable stopped-at-cap record honors a stored maxAttempts:0", async () => {
  const repo = initGitRepo("orch-continue-maxattempts-");
  const sid = "deadbeef";
  const branch = `pr/claude/some-fix-${sid}`;
  gitDep.git(["checkout", "-b", branch], repo);
  writeFileSync(join(repo, "a.txt"), "2\n");
  gitDep.git(["commit", "-am", "authored fix"], repo);
  gitDep.git(["checkout", "main"], repo);
  gitDep.git(["branch", "orch/integration"], repo);
  checkpointDep.record(join(repo, ".orch"), sid,
    { branch, round: 1, stage: "reviewed", decision: "AGREE", reason: "looks good" });

  const dir = join(repo, ".orch", "run-records");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sid}.json`), JSON.stringify({
    schemaVersion: 1, runId: sid, command: "task", argv: [], policy: { until: "ready", maxAttempts: 0 },
    state: "STOPPED_AT_CAP", outcome: "stopped-at-cap", exit: 2, attempt: 1, retries: {}, headMovedRepins: 0,
    cycles: [{ sid, attempt: 0, branch, author: "claude", reviewers: ["codex"], status: "escalated", reason: null }],
  }));

  const cycleDeps = {
    ...fakeCycleDeps(),
    adapters: { get: (name) => ({ name, async author() { return { usage: {} }; }, async audit() { return { decision: "AGREE", reason: "still good", raw: "", usage: {} }; } }) },
  };
  const integrationHead = gitDep.git(["rev-parse", "orch/integration"], repo);
  let readinessReads = 0;
  const baseGh = readinessGh({
    number: 9, state: "OPEN", isDraft: false, headRefOid: integrationHead, baseRefName: "main",
    mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: null, statusCheckRollup: [],
  });
  const gh = (args, input) => {
    if (args[0] === "pr" && args[1] === "view") readinessReads += 1;
    return baseGh(args, input);
  };
  await runMainInRepo(repo, ["continue", sid], {
    cycleDeps, finishRun: async () => {}, githubDeps: () => ({ gh, git: gitDep.git }),
  });

  const record = JSON.parse(readFileSync(join(dir, `${sid}.json`), "utf8"));
  assert.equal(record.policy.maxAttempts, 1); // 1 (prior attempt) + 0 (maxAttempts:0), not 2
  assert.equal(record.attempt, 2); // priorRun.attempt (1) + 1 for this resumed cycle
  // Regression: the appended cycle entry must carry the SAME attempt number as
  // record.attempt (2), not the stale priorRun.attempt (1) — an off-by-one that
  // left `cycles` one step behind `attempt` and corrupted the attempt-keyed lineage.
  assert.equal(record.cycles.length, 2);
  assert.equal(record.cycles[1].attempt, 2);
  assert.ok(readinessReads > 0, "continue must reach the run controller");
});

// Regression: `orch task` resuming a quota-aborted sid (resolveTaskBranch's
// resume path — issue #24) reuses that ORIGINAL sid as its runId. Before this
// fix, the terminal cycle unconditionally called runRecord.create() on that
// runId, which unconditionally overwrites — resetting attempt/cycles/lastError/
// createdAt back to genesis and silently violating design §5's "a record is
// never deleted by orch" (nothing ever prunes/rebuilds these files, so the
// history is gone for good).
test("orch task resuming a sid with an existing run record appends to it instead of resetting it", async () => {
  const repo = initGitRepo();
  const sid = "resumesid1";
  const branch = `pr/claude/some-task-${sid}`;
  gitDep.git(["checkout", "-b", branch], repo);
  writeFileSync(join(repo, "a.txt"), "2\n");
  gitDep.git(["commit", "-am", "authored fix"], repo);
  gitDep.git(["checkout", "main"], repo);
  // The record `resolveTaskBranch` would have written before the original run,
  // and pinnedResumeAuthor reads to pin the same author on resume.
  resume.record(join(repo, ".orch"), "some task", "claude", { branch, sid });

  const dir = join(repo, ".orch", "run-records");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sid}.json`), JSON.stringify({
    schemaVersion: 1, runId: sid, command: "task", argv: [], policy: null,
    createdAt: "2020-01-01T00:00:00.000Z", updatedAt: "2020-01-01T00:00:00.000Z",
    state: "ERROR", outcome: "error", exit: 1, attempt: 2, retries: {}, headMovedRepins: 0,
    lastError: { message: "boom" },
    cycles: [
      { sid, attempt: 0, branch, author: "claude", reviewers: ["codex"], status: "escalated", reason: null },
      { sid, attempt: 1, branch, author: "claude", reviewers: ["codex"], status: "escalated", reason: null },
    ],
  }));

  await runMainInRepo(repo, ["task", "some task", "--no-tidy"]);

  const record = JSON.parse(readFileSync(join(dir, `${sid}.json`), "utf8"));
  assert.equal(record.createdAt, "2020-01-01T00:00:00.000Z"); // create() must not re-run on a resumed sid
  assert.equal(record.attempt, 3); // priorRecord.attempt (2) + 1 for this resumed cycle
  assert.equal(record.cycles.length, 3); // appended, not replaced
  assert.equal(record.cycles[2].attempt, 3);
});

// Regression: only a `status: "merged"` result landed on the standing
// integration→main PR — `merge: pr` mode and a demoted (`merge-deferred`)
// cycle each open a fresh PR scoped to that one branch, so their `kind` must
// read "per-cycle", not the hardcoded "standing" every result used to get.
test("orch task records pr.kind as per-cycle for merge:pr mode, standing only for a real merge", async () => {
  const merged = initGitRepo();
  await runMainInRepo(merged, ["task", "some task", "--no-tidy"], {
    cycleDeps: { ...fakeCycleDeps(), finalize: async () => ({ status: "merged", reason: "test", sha: "abc", prUrl: "https://example/pr/standing" }) },
  });
  const mergedDir = join(merged, ".orch", "run-records");
  const mergedRecord = JSON.parse(readFileSync(join(mergedDir, readdirSync(mergedDir)[0]), "utf8"));
  assert.deepEqual(mergedRecord.pr, { number: null, url: "https://example/pr/standing", kind: "standing" });

  const perCycle = initGitRepo();
  await runMainInRepo(perCycle, ["task", "some task", "--no-tidy"], {
    cycleDeps: { ...fakeCycleDeps(), finalize: async () => ({ status: "pr", reason: "test", prUrl: "https://example/pr/123" }) },
  });
  const perCycleDir = join(perCycle, ".orch", "run-records");
  const perCycleRecord = JSON.parse(readFileSync(join(perCycleDir, readdirSync(perCycleDir)[0]), "utf8"));
  assert.deepEqual(perCycleRecord.pr, { number: null, url: "https://example/pr/123", kind: "per-cycle" });
});

// Regression: a pre-v2 sid resumed via `orch continue` has no prior run
// record, so `runRecord.create()` used to fire only after `runCycle`
// returned — a crash inside runCycle left no record at all, violating
// design §5's "after any run a record with `outcome` exists".
test("orch continue on a pre-v2 sid leaves an error record when runCycle throws", async () => {
  const repo = initGitRepo("orch-continue-crash-");
  const sid = "deadbeef";
  const branch = `pr/claude/some-fix-${sid}`;
  gitDep.git(["checkout", "-b", branch], repo);
  writeFileSync(join(repo, "a.txt"), "2\n");
  gitDep.git(["commit", "-am", "authored fix"], repo);
  gitDep.git(["checkout", "main"], repo);
  checkpointDep.record(join(repo, ".orch"), sid,
    { branch, round: 1, stage: "reviewed", decision: "AGREE", reason: "looks good" });

  const crashing = {
    ...fakeCycleDeps(),
    adapters: { get: (name) => ({ name, async author() { return { usage: {} }; }, async audit() { throw new Error("boom"); } }) },
  };
  await assert.rejects(
    () => runMainInRepo(repo, ["continue", sid], { cycleDeps: crashing }),
    /boom/,
  );

  const dir = join(repo, ".orch", "run-records");
  const record = JSON.parse(readFileSync(join(dir, `${sid}.json`), "utf8"));
  assert.equal(record.outcome, "error");
  assert.equal(record.state, "ERROR");
  assert.equal(record.exit, 1);
  assert.match(record.lastError.message, /boom/);
});

// Design §5.3 acceptance: "`orch continue <runId>` and `<sid>` resolve to it" —
// a run whose lineage has moved past its first cycle must still be reachable
// by ANY of its cycles' sids, not just the runId. Only proved at the
// run-record.js unit level before this (lookup() lineage test); this proves
// the full `orch continue` command resolves and updates the SAME record file
// when invoked with a later cycle's sid, distinct from the run's own runId.
test("orch continue resolves and updates the run record when runId differs from the given sid", async () => {
  const repo = initGitRepo("orch-continue-lineage-");
  const runId = "runid-first-cycle";
  const laterSid = "sid-later-cycle";
  const branch = `pr/claude/some-fix-${laterSid}`;
  gitDep.git(["checkout", "-b", branch], repo);
  writeFileSync(join(repo, "a.txt"), "2\n");
  gitDep.git(["commit", "-am", "authored fix"], repo);
  gitDep.git(["checkout", "main"], repo);
  checkpointDep.record(join(repo, ".orch"), laterSid,
    { branch, round: 1, stage: "reviewed", decision: "AGREE", reason: "looks good" });

  const dir = join(repo, ".orch", "run-records");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${runId}.json`), JSON.stringify({
    schemaVersion: 1, runId, command: "task", argv: [], policy: { maxAttempts: 1 },
    state: "STOPPED_AT_CAP", outcome: "stopped-at-cap", exit: 2, attempt: 1, retries: {}, headMovedRepins: 0,
    cycles: [{ sid: laterSid, attempt: 0, branch, author: "claude", reviewers: ["codex"], status: "escalated", reason: null }],
  }));

  await runMainInRepo(repo, ["continue", laterSid], { cycleDeps: fakeCycleDeps(), finishRun: async () => {} });

  assert.equal(existsSync(join(dir, `${laterSid}.json`)), false); // no separate record keyed by the cycle sid
  const record = JSON.parse(readFileSync(join(dir, `${runId}.json`), "utf8"));
  assert.equal(record.runId, runId);
  assert.equal(record.attempt, 2);
  assert.equal(record.cycles.length, 2);
  assert.equal(record.cycles[1].sid, laterSid);
});
