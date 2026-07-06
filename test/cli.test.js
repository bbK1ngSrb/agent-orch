import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir, cwd } from "node:process";
import { execFileSync } from "node:child_process";
import { slugify, nextAuthor, parse, main, preflight, resolveAgentBin, maybeSpawnDocs, applyRoleOverrides, applyCheapOverride, maybePrintRunBanner, runBanner, visWidth, linkOrchDoc, realDeps, buildAgent } from "../src/cli.js";
import { existsSync } from "node:fs";
import * as inflight from "../src/inflight.js";
import * as adapters from "../src/adapters/index.js";
import * as gitDep from "../src/git.js";
import * as notify from "../src/notify.js";
import * as checkpointDep from "../src/checkpoint.js";

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

test("main prints startup banner for task runs on TTY", async () => {
  let out = "";
  await runMainCapture(["task", "hello world", "--dry"], {
    stdout: { isTTY: true, write: (chunk) => { out += chunk; } },
  });
  const plain = out.replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(plain, /agent-orch \d+\.\d+\.\d+/);
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

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("runBanner shows version, agents, per-agent model+effort, test, merge", () => {
  const cfg = { agents: ["claude", "codex"], test: "npm test", merge: "ff-only" };
  const banner = stripAnsi(runBanner(cfg, [{
    author: { agent: "claude", model: "opus", effort: "high" },
    reviewers: [{ agent: "codex", model: "gpt-5", effort: null }],
  }]));
  assert.match(banner, /agent-orch \d+\.\d+\.\d+/);
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
  assert.match(stripAnsi(out), /agent-orch \d+\.\d+\.\d+/);

  out = "";
  assert.equal(maybePrintRunBanner(cfg, runs, { "no-banner": true }, tty), false);
  assert.equal(out, "");

  const notTty = { isTTY: false, write: (chunk) => { out += chunk; } };
  assert.equal(maybePrintRunBanner(cfg, runs, {}, notTty), false);
  assert.equal(out, "");
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

import { fetchIssueWorkOrder } from "../src/cli.js";

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

test("orch issue posts a gh issue comment on escalation", async () => {
  const savedExitCode = process.exitCode;
  const repo = initGitRepo();
  const calls = [];
  const gh = (args, input) => {
    if (args[0] === "--version") return "gh 2";
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
    assert.match(calls[0].input, /ESCALATED/);
    assert.match(calls[0].input, /stalemate after cap/);
  } finally {
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

test("resolveAgentBin returns the bare name when the CLI is on PATH", () => {
  assert.equal(resolveAgentBin("ls"), "ls"); // PATH hit → spawn by name as before
});

test("resolveAgentBin searches the given PATH itself, without external which", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-bin-"));
  const p = join(d, "fake-path-cli-xyz");
  writeFileSync(p, "#!/bin/sh\n");
  chmodSync(p, 0o755);
  // PATH holds only d — a PATH too degraded to find `which` itself. The CLI
  // still resolves by name, and empty PATH entries are skipped, not treated as cwd.
  assert.equal(resolveAgentBin("fake-path-cli-xyz", [], `:${d}:`), "fake-path-cli-xyz");
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

test("resolveAgentBin ignores a non-executable file in a fallback dir", () => {
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

test("--cheap combined with --author throws", () => {
  const cfg = { cheap: { role: "qwen3-coder-30b", paths: [] } };
  assert.throws(() => applyCheapOverride(cfg, { cheap: true, author: "claude", reviewer: "codex" }),
    /cannot be combined/);
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

test("agent add appends copilot to the pool", async () => {
  const d = mkdtempSync(join(tmpdir(), "orch-add-"));
  const prev = cwd();
  chdir(d);
  try {
    await main(["init"], { preflight() {}, detectAgents: () => ({ found: [], missing: [] }) });
    await main(["agent", "add", "copilot"]);
    const text = readFileSync(join(d, ".orch", "orch.yml"), "utf8");
    assert.match(text, /agents: \[claude, codex, copilot\]/);
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
    // detectAgents() (src/detect.js) actually probes — it drifted stale for
    // gemini once already (missing from the scaffold after gemini support shipped).
    for (const name of ["claude", "codex", "copilot", "gemini"]) {
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
  return { remote, peer };
}

function fakeCycleDeps() {
  const verdict = { decision: "AGREE", reason: "ok", raw: "", usage: { model: "gpt-test-review", tokens: 20 } };
  return {
    adapters: { get: (name) => ({ name, async author() { return { usage: { model: "gpt-test-author", tokens: 40 } }; }, async audit() { return verdict; } }) },
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
    assert.equal(process.exitCode, 2);
    assert.match(logs.join("\n"), /concurrency cap 4 reached/);
  } finally {
    chdir(prev);
    process.exitCode = savedExitCode; // restore instead of unconditionally forcing 0
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

test("orch task fast-forwards stale local main from origin before branching", async () => {
  const repo = initGitRepo();
  const { peer } = addOriginWithPeer(repo);
  writeFileSync(join(peer, "remote.txt"), "remote\n");
  gitDep.git(["add", "."], peer);
  gitDep.git(["commit", "-m", "advance remote"], peer);
  gitDep.git(["push", "origin", "main"], peer);

  const logs = await runMainInRepo(repo, ["task", "some task", "--no-tidy"]);

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
  inflight.register(join(repo, ".orch"), sid, { branch, pid: 999999999, baseSha: gitDep.git(["rev-parse", "main"], repo) });

  await assert.rejects(
    runMainInRepo(repo, ["continue", sid]),
    /has no committed changes/,
  );
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
  inflight.register(join(repo, ".orch"), sid, { branch, pid: DEAD_PID, baseSha: gitDep.git(["rev-parse", "main"], repo) });

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
  const logs = await runMainInRepo(repo, ["continue", sid],
    { cycleDeps, finishRun: async () => {} });

  assert.equal(authorCalls, 0); // resumed via the inflight record, not a fresh author round
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
