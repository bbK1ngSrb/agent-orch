import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir, cwd } from "node:process";
import { execFileSync } from "node:child_process";
import { slugify, nextAuthor, parse, main, preflight, maybeSpawnDocs, applyRoleOverrides } from "../src/cli.js";
import * as inflight from "../src/inflight.js";
import * as gitDep from "../src/git.js";

const docsCfg = { docs: { autoUpdate: true, prompt: "update docs", paths: ["*.md"] } };
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
  } finally {
    chdir(prev);
    process.exitCode = 0;
  }
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

test("parse captures --no-banner flag", () => {
  const p = parse(["task", "do x", "--no-banner"]);
  assert.equal(p.flags["no-banner"], true);
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

test("preflight throws a clear error when .orch/ is read-only", () => {
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

test("agent add appends a known agent to the pool, preserving comments", async () => {
  const d = mkdtempSync(join(tmpdir(), "orch-add-"));
  const prev = cwd();
  chdir(d);
  try {
    await main(["init"], { preflight() {} }); // stub: no real agent CLIs needed in tests
    await main(["agent", "add", "qwen3-coder-30b"]);
    const text = readFileSync(join(d, ".orch", "orch.yml"), "utf8");
    assert.match(text, /agents: \[claude, codex, qwen3-coder-30b\]/);
    assert.match(text, /# === Agents ===/); // comments survived
    // idempotent: a second add is a no-op
    await main(["agent", "add", "qwen3-coder-30b"]);
    const again = readFileSync(join(d, ".orch", "orch.yml"), "utf8");
    assert.equal((again.match(/qwen3-coder-30b/g) || []).length, text.match(/qwen3-coder-30b/g).length);
  } finally {
    chdir(prev);
  }
});

test("agent add rejects an unknown agent", async () => {
  const d = mkdtempSync(join(tmpdir(), "orch-add-"));
  const prev = cwd();
  chdir(d);
  try {
    await main(["init"], { preflight() {} }); // stub: no real agent CLIs needed in tests
    await assert.rejects(() => main(["agent", "add", "nope"]), /unknown agent/);
  } finally {
    chdir(prev);
  }
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
  writeFileSync(join(d, "a.txt"), "1\n");
  gitDep.git(["add", "."], d);
  gitDep.git(["commit", "-m", "init"], d);
  return d;
}

function fakeCycleDeps() {
  const verdict = { decision: "AGREE", reason: "ok", raw: "" };
  return {
    adapters: { get: (name) => ({ name, async author() {}, async audit() { return verdict; } }) },
    git: gitDep,
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

test("task branch includes a sid suffix", async () => {
  const logs = await runMainCapture(["task", "do a thing", "--dry"]);
  assert.match(logs.join("\n"), /pr\/[a-z]+\/do-a-thing-\d+-[0-9a-z]+:/);
});

test("task prints a compact startup banner on a TTY", async () => {
  const logs = await runMainCapture(["task", "do a thing", "--dry"], { isTTY: true });
  const out = logs.join("\n");
  assert.match(out, /\+-+\+/);
  assert.match(out, /orch 0\.1\.0 :: task/);
  assert.match(out, /agents: claude, codex/);
  assert.match(out, /roles: claude -> codex/);
  assert.match(out, /test: auto/);
  assert.match(out, /merge: no-ff/);
});

test("startup banner is suppressed with --no-banner or without a TTY", async () => {
  const hidden = await runMainCapture(["task", "do a thing", "--dry", "--no-banner"], { isTTY: true });
  assert.doesNotMatch(hidden.join("\n"), /orch 0\.1\.0 :: task/);

  const nonTty = await runMainCapture(["task", "do a thing", "--dry"], { isTTY: false });
  assert.doesNotMatch(nonTty.join("\n"), /orch 0\.1\.0 :: task/);
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
    assert.equal(process.exitCode, 2);
    assert.match(logs.join("\n"), /concurrency cap 4 reached/);
  } finally {
    chdir(prev);
    process.exitCode = savedExitCode; // restore instead of unconditionally forcing 0
  }
});

test("orch task on main auto-creates and switches to an orch slug branch", async () => {
  const repo = initGitRepo();
  const logs = await runMainInRepo(repo, ["task", "some task"]);
  assert.equal(gitDep.git(["rev-parse", "--abbrev-ref", "HEAD"], repo), "orch/some-task");
  assert.match(logs.join("\n"), /created and switched to orch\/some-task/);
  assert.match(logs.join("\n"), /orch: pr\/claude\/some-task-\d+-[0-9a-z]+: merged \(test\)/);
});

test("orch task on main appends a numeric suffix when the orch slug branch exists", async () => {
  const repo = initGitRepo();
  gitDep.git(["branch", "orch/some-task"], repo);
  gitDep.git(["branch", "orch/some-task-2"], repo);
  const logs = await runMainInRepo(repo, ["task", "some task"]);
  assert.equal(gitDep.git(["rev-parse", "--abbrev-ref", "HEAD"], repo), "orch/some-task-3");
  assert.match(logs.join("\n"), /created and switched to orch\/some-task-3/);
});

test("orch task already off main leaves cwd branch unchanged", async () => {
  const repo = initGitRepo();
  gitDep.git(["switch", "-c", "work"], repo);
  const logs = await runMainInRepo(repo, ["task", "some task"]);
  assert.equal(gitDep.git(["rev-parse", "--abbrev-ref", "HEAD"], repo), "work");
  assert.doesNotMatch(logs.join("\n"), /created and switched/);
});

test("orch task on main carries uncommitted cwd changes to the new branch", async () => {
  const repo = initGitRepo();
  writeFileSync(join(repo, "a.txt"), "dirty\n");
  writeFileSync(join(repo, "scratch.txt"), "untracked\n");
  await runMainInRepo(repo, ["task", "touch dirty"]);
  assert.equal(gitDep.git(["rev-parse", "--abbrev-ref", "HEAD"], repo), "orch/touch-dirty");
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
    assert.match(logs.join("\n"), /Usage:/);
  }
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
import * as resume from "../src/resume.js";

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
