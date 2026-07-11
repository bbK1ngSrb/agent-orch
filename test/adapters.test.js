import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { buildArgs as agyArgs } from "../src/adapters/agy.js";
import { buildArgs as claudeArgs } from "../src/adapters/claude.js";
import { buildArgs as codexArgs } from "../src/adapters/codex.js";
import { buildArgs as copilotArgs } from "../src/adapters/copilot.js";
import { buildArgs as geminiArgs } from "../src/adapters/gemini.js";
import { buildArgs as grokArgs } from "../src/adapters/grok.js";
import { get } from "../src/adapters/index.js";
import { makeCliAdapter, isUsageLimit, parseRunUsage } from "../src/adapters/cli-adapter.js";

// Fake-agent fixtures spawn `node -e <script>` instead of `sh -c <script>`.
// A shell (and printf/cat/trap/exit) is POSIX-only — this repo's own CI
// runner happened to have Git for Windows' usr/bin on PATH, which masked
// that these tests hard-depend on `sh` and don't run on a plain Windows
// install. Node's argv-array spawn (no shell) also means no quoting to get
// right — each script arg is passed to the child exactly as written here.
function nodeScript(script) {
  return ["-e", script];
}

test("agy buildArgs uses prompt mode", () => {
  assert.deepEqual(agyArgs("PROMPT", "/wd"), ["-p", "PROMPT"]);
});

test("agy buildArgs appends --model when given", () => {
  assert.deepEqual(agyArgs("PROMPT", "/wd", { model: "agy-model" }),
    ["-p", "PROMPT", "--model", "agy-model"]);
});

test("agy adapter refuses the author seat (review-only, #272)", async () => {
  // Headless agy edits its own scratch workspace, not the cwd worktree, so an
  // author run would succeed loudly while producing an empty diff. The adapter
  // must throw before spawning the CLI at all — a silent no-op author is worse
  // than a failed cycle.
  await assert.rejects(() => get("agy").author("TASK", "/wd"), /review-only/);
  // Audit needs no worktree writes, so the reviewer seat stays available.
  assert.equal(typeof get("agy").audit, "function");
});

test("claude buildArgs uses -p with headless write permission", () => {
  assert.deepEqual(claudeArgs("PROMPT", "/wd"),
    ["-p", "--allowedTools", "Edit,Write,Read,Bash,Glob,Grep", "--dangerously-skip-permissions", "PROMPT"]);
});

test("claude buildArgs appends --model and --effort when given", () => {
  assert.deepEqual(claudeArgs("PROMPT", "/wd", { model: "opus-4.8", effort: "high" }),
    ["-p", "--allowedTools", "Edit,Write,Read,Bash,Glob,Grep", "--dangerously-skip-permissions",
      "--model", "opus-4.8", "--effort", "high", "PROMPT"]);
});

test("codex buildArgs appends --model and reasoning-effort config when given", () => {
  assert.deepEqual(codexArgs("PROMPT", "/wd", { model: "gpt-5.1", effort: "medium" }),
    ["exec", "--cd", "/wd", "--dangerously-bypass-approvals-and-sandbox",
      "--model", "gpt-5.1", "-c", 'model_reasoning_effort="medium"', "PROMPT"]);
});

test("copilot buildArgs uses prompt mode with non-interactive tool and path permission", () => {
  assert.deepEqual(copilotArgs("PROMPT", "/wd"),
    ["-p", "PROMPT", "--allow-all-tools", "--allow-all-paths", "--add-dir", "/wd"]);
});

test("copilot buildArgs appends --model when given", () => {
  assert.deepEqual(copilotArgs("PROMPT", "/wd", { model: "gpt-5.1" }),
    ["-p", "PROMPT", "--allow-all-tools", "--allow-all-paths", "--add-dir", "/wd", "--model", "gpt-5.1"]);
});

test("gemini buildArgs uses prompt mode with non-interactive approval", () => {
  assert.deepEqual(geminiArgs("PROMPT", "/wd"), ["-p", "PROMPT", "--yolo"]);
});

test("gemini buildArgs appends --model when given", () => {
  assert.deepEqual(geminiArgs("PROMPT", "/wd", { model: "gemini-2.5-pro" }),
    ["-p", "PROMPT", "--yolo", "--model", "gemini-2.5-pro"]);
});

test("grok buildArgs uses headless prompt mode with approval bypass", () => {
  // --always-approve is required: headless -p still gates Edit/Write/Bash on
  // approval, which would hang/no-op the author stage without it.
  assert.deepEqual(grokArgs("PROMPT", "/wd"), ["-p", "PROMPT", "--always-approve"]);
});

test("grok buildArgs appends --model and --effort when given", () => {
  assert.deepEqual(grokArgs("PROMPT", "/wd", { model: "grok-4", effort: "high" }),
    ["-p", "PROMPT", "--always-approve", "--model", "grok-4", "--effort", "high"]);
});

test("buildArgs omits model/effort flags when absent (no regression)", () => {
  assert.deepEqual(agyArgs("P", "/wd", {}), ["-p", "P"]);
  assert.deepEqual(claudeArgs("P", "/wd", {}),
    ["-p", "--allowedTools", "Edit,Write,Read,Bash,Glob,Grep", "--dangerously-skip-permissions", "P"]);
  assert.deepEqual(codexArgs("P", "/wd", {}),
    ["exec", "--cd", "/wd", "--dangerously-bypass-approvals-and-sandbox", "P"]);
  assert.deepEqual(copilotArgs("P", "/wd", {}),
    ["-p", "P", "--allow-all-tools", "--allow-all-paths", "--add-dir", "/wd"]);
  assert.deepEqual(geminiArgs("P", "/wd", {}), ["-p", "P", "--yolo"]);
});

test("adapter forwards model/effort opts to buildArgs", async () => {
  let seen;
  const adapter = makeCliAdapter({
    name: "spy", bin: process.execPath,
    buildArgs: (_p, _wd, opts) => { seen = opts; return nodeScript("process.exit(0)"); },
  });
  await adapter.audit("pr/x/y", tmpdir(), { model: "m1", effort: "low" });
  assert.deepEqual(seen, { model: "m1", effort: "low" });
});

test("parseRunUsage reads JSON and text token summaries, estimating $ cost from known model prices", () => {
  assert.deepEqual(parseRunUsage('{"model":"claude-opus-4.8","usage":{"input_tokens":1000,"output_tokens":250}}\n'),
    { model: "claude-opus-4.8", tokens: 1250, inputTokens: 1000, outputTokens: 250, costUsd: 0.03375 });
  assert.deepEqual(parseRunUsage("AGREE\nmodel: gpt-5.1\ninput tokens: 100\noutput tokens: 25\n"),
    { model: "gpt-5.1", tokens: 125, inputTokens: 100, outputTokens: 25, costUsd: 0.000875 });
});

test("parseRunUsage prefers the CLI's reported total_cost_usd over its own price-table estimate", () => {
  assert.deepEqual(
    parseRunUsage('{"model":"claude-opus-4.8","total_cost_usd":1.5,"usage":{"input_tokens":1000,"output_tokens":250}}\n'),
    { model: "claude-opus-4.8", tokens: 1250, inputTokens: 1000, outputTokens: 250, costUsd: 1.5 },
  );
});

test("parseRunUsage omits costUsd for a model with no known price", () => {
  assert.deepEqual(parseRunUsage('{"model":"mystery-model","usage":{"input_tokens":100,"output_tokens":50}}\n'),
    { model: "mystery-model", tokens: 150, inputTokens: 100, outputTokens: 50 });
});

test("parseRunUsage omits costUsd when only a total token count is known, even for a priced model", () => {
  assert.deepEqual(parseRunUsage('{"model":"claude-opus-4.8","usage":{"total_tokens":1250}}\n'),
    { model: "claude-opus-4.8", tokens: 1250 });
  assert.deepEqual(parseRunUsage("model: claude-opus-4.8\ntotal tokens: 1250\n"),
    { model: "claude-opus-4.8", tokens: 1250 });
});

test("audit returns parsed model, token usage, and estimated cost from agent output", async () => {
  const adapter = makeCliAdapter({
    name: "metered",
    bin: process.execPath,
    buildArgs: () => nodeScript(
      "process.stdout.write('AGREE ok\\nmodel: gpt-5.1\\ninput tokens: 100\\noutput tokens: 25\\n')"),
  });
  const v = await adapter.audit("pr/x/y", tmpdir());
  assert.equal(v.decision, "AGREE");
  assert.deepEqual(v.usage, { model: "gpt-5.1", tokens: 125, inputTokens: 100, outputTokens: 25, costUsd: 0.000875 });
});

test("audit captures stderr from successful agent runs", async () => {
  const adapter = makeCliAdapter({
    name: "stderr-reviewer",
    bin: process.execPath,
    buildArgs: () => nodeScript("process.stderr.write('AGREE stderr verdict\\n')"),
  });
  const v = await adapter.audit("pr/x/y", tmpdir());
  assert.equal(v.decision, "AGREE");
  assert.match(v.raw, /stderr verdict/);
});

test("audit does not let successful stderr override a parseable stdout verdict", async () => {
  const adapter = makeCliAdapter({
    name: "stderr-warning",
    bin: process.execPath,
    buildArgs: () => nodeScript(
      "process.stdout.write('AGREE stdout verdict\\n'); process.stderr.write('warning mentions DISAGREE\\n')"),
  });
  const v = await adapter.audit("pr/x/y", tmpdir());
  assert.equal(v.decision, "AGREE");
  assert.match(v.raw, /warning mentions DISAGREE/);
});

test("audit emits elapsed progress while the agent is still running", async () => {
  const priorInterval = process.env.ORCH_PROGRESS_INTERVAL_MS;
  const priorWrite = process.stderr.write;
  const writes = [];
  process.env.ORCH_PROGRESS_INTERVAL_MS = "10";
  process.stderr.write = (chunk) => {
    writes.push(String(chunk));
    return true;
  };
  try {
    const adapter = makeCliAdapter({
      name: "slow",
      bin: process.execPath,
      buildArgs: () => nodeScript("setTimeout(() => process.stdout.write('AGREE ok\\n'), 60)"),
    });
    const v = await adapter.audit("pr/x/y", tmpdir());
    assert.equal(v.decision, "AGREE");
    assert.match(writes.join(""), /slow auditing still running .* elapsed/);
  } finally {
    if (priorInterval === undefined) delete process.env.ORCH_PROGRESS_INTERVAL_MS;
    else process.env.ORCH_PROGRESS_INTERVAL_MS = priorInterval;
    process.stderr.write = priorWrite;
  }
});

test("author fails fast when a stage exceeds stageTimeout, even if the child ignores SIGTERM (#56)", async () => {
  // The real failure: codex exec wedges on the backend and never exits. The
  // watchdog must kill by stage WALL-CLOCK and force a failure. A child that
  // traps SIGTERM (as the codex wrapper effectively did — it advanced orch to
  // audit on an empty branch) must still be reaped, so we SIGKILL the group and
  // resolve ok:false explicitly rather than trusting the child's exit.
  const adapter = makeCliAdapter({
    name: "staller",
    bin: process.execPath,
    buildArgs: () => nodeScript("setTimeout(() => {}, 30000)"),
  });
  const t0 = Date.now();
  await assert.rejects(
    () => adapter.author("do work", tmpdir(), { stageTimeoutMs: 120 }),
    /timed out/i,
    "author must throw on a stalled stage so the cycle exits nonzero",
  );
  assert.ok(Date.now() - t0 < 5000, "must abort promptly, not wait out the sleep");
});

test("audit fails safe (DISAGREE + agentError) when a reviewer stage stalls (#56)", async () => {
  // #56 stalls hit both author and reviewer stages. A stalled audit must not
  // hang the loop — it returns a fail-safe DISAGREE flagged for escalation.
  const adapter = makeCliAdapter({
    name: "staller",
    bin: process.execPath,
    buildArgs: () => nodeScript("setTimeout(() => {}, 30000)"),
  });
  const t0 = Date.now();
  const v = await adapter.audit("pr/x/y", tmpdir(), { stageTimeoutMs: 120 });
  assert.equal(v.decision, "DISAGREE");
  assert.equal(v.agentError, true, "a stalled+killed stage escalates, not revise-loops");
  assert.ok(Date.now() - t0 < 5000, "must abort promptly, not wait out the sleep");
});

test("ORCH_STAGE_TIMEOUT_MS overrides the engine-threaded cfg stageTimeout (#56)", async () => {
  // The engine always threads cfg.stageTimeout (default 25m) as an explicit
  // value, so the env var is only a real ops override if it WINS over explicit.
  // Otherwise an operator can never shorten/disable a stalled stage without
  // editing orch.yml — exactly the gap seen live (a 15m env cap was ignored
  // because cfg's 25m explicit shadowed it).
  const prior = process.env.ORCH_STAGE_TIMEOUT_MS;
  process.env.ORCH_STAGE_TIMEOUT_MS = "120";
  try {
    const adapter = makeCliAdapter({
      name: "staller",
      bin: process.execPath,
      buildArgs: () => nodeScript("setTimeout(() => {}, 30000)"),
    });
    const t0 = Date.now();
    const v = await adapter.audit("pr/x/y", tmpdir(), { stageTimeoutMs: 30_000 });
    assert.equal(v.decision, "DISAGREE");
    assert.equal(v.agentError, true);
    assert.ok(Date.now() - t0 < 5000, "env override must win over explicit and kill fast");
  } finally {
    if (prior === undefined) delete process.env.ORCH_STAGE_TIMEOUT_MS;
    else process.env.ORCH_STAGE_TIMEOUT_MS = prior;
  }
});

test("a stage that finishes within stageTimeout is not killed (no false positive)", async () => {
  // A healthy stage well under the timeout must complete normally — the
  // watchdog must not fire on legitimate work.
  const adapter = makeCliAdapter({
    name: "healthy",
    bin: process.execPath,
    buildArgs: () => nodeScript("process.stdout.write('AGREE ok\\n')"),
  });
  const v = await adapter.audit("pr/x/y", tmpdir(), { stageTimeoutMs: 10_000 });
  assert.equal(v.decision, "AGREE");
});

test("runAgent closes the child's stdin so codex's exec stdin read sees EOF (#58)", { timeout: 5000 }, async () => {
  // Repro of the codex hang: `codex exec <prompt>` reads stdin and blocks on
  // 'Reading additional input from stdin...' until EOF. The adapter spawned with
  // a default (open) stdin pipe never sends EOF, so the stage hangs until the #56
  // watchdog SIGKILLs it. `cat` stands in for that read — it only exits at EOF.
  // With stdin closed the child completes in ms; without, this test times out.
  const adapter = makeCliAdapter({
    name: "stdin-reader",
    bin: process.execPath,
    buildArgs: () => nodeScript(
      "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('AGREE\\n'))"),
  });
  const v = await adapter.audit("pr/x/y", tmpdir());
  assert.equal(v.decision, "AGREE");
});

test("author commits worktree changes the agent left uncommitted", async () => {
  const wd = mkdtempSync(join(tmpdir(), "orch-author-"));
  const g = (...a) => execFileSync("git", a, { cwd: wd, encoding: "utf8" });
  g("init", "-q");
  g("config", "user.email", "t@t");
  g("config", "user.name", "t");
  g("commit", "--allow-empty", "-q", "-m", "base");
  // Fake agent: writes a file but never commits (the real failure mode).
  const adapter = makeCliAdapter({
    name: "writer",
    bin: process.execPath,
    // Target path passed as its own argv element (not interpolated into the
    // script string) — spawn is argv-array, no shell, so no quoting to worry about.
    buildArgs: () => [...nodeScript("require('fs').writeFileSync(process.argv[1], 'hi')"), join(wd, "NEWFILE")],
  });
  await adapter.author("do work", wd);
  const head = g("log", "--oneline").trim().split("\n");
  assert.equal(head.length, 2, "author should add exactly one commit");
  assert.match(g("show", "--stat", "HEAD"), /NEWFILE/);
});

test("audit is fail-safe DISAGREE when the agent exits nonzero (F4)", async () => {
  // Fake agent: prints a partial answer then exits 3. audit() must NOT throw.
  const adapter = makeCliAdapter({
    name: "boom",
    bin: process.execPath,
    buildArgs: () => nodeScript("console.log('thinking...'); process.exit(3)"),
  });
  const v = await adapter.audit("pr/x/y", tmpdir());
  assert.equal(v.decision, "DISAGREE");
  assert.equal(v.agentError, true, "a crash with no verdict is flagged for fast-escalate (#33)");
});

test("audit preserves an explicit DISAGREE from a nonzero agent (not agentError) (#33)", async () => {
  // A nonzero AGREE is untrusted, but an explicit DISAGREE is a safe, actionable
  // review finding — keep it and do NOT flag agentError (it's a real review).
  const adapter = makeCliAdapter({
    name: "boom-disagree",
    bin: process.execPath,
    buildArgs: () => nodeScript("console.log('DISAGREE add a regression test'); process.exit(3)"),
  });
  const v = await adapter.audit("pr/x/y", tmpdir());
  assert.equal(v.decision, "DISAGREE");
  assert.match(v.reason, /add a regression test/);
  assert.equal(v.agentError, undefined);
});

test("audit surfaces the agent's actual error in the DISAGREE reason (#31)", async () => {
  // A nonzero exit must carry WHY it failed (e.g. a bad model id) into the
  // reason, not just a generic sentinel — otherwise the escalation is undiagnosable.
  const adapter = makeCliAdapter({
    name: "badmodel",
    bin: process.execPath,
    buildArgs: () => nodeScript(
      "process.stderr.write(\"There's an issue with the selected model (opus-4.8)\\n\"); process.exit(1)"),
  });
  const v = await adapter.audit("pr/x/y", tmpdir());
  assert.equal(v.decision, "DISAGREE");
  assert.match(v.reason, /opus-4\.8/, "reason must include the agent's error output");
  assert.equal(v.agentError, true, "a bare crash is also flagged for fast-escalate (#33)");
});

test("audit falls back to the command failure text when a nonzero agent prints nothing", async () => {
  const adapter = makeCliAdapter({
    name: "silent-boom",
    bin: process.execPath,
    buildArgs: () => nodeScript("process.exit(9)"),
  });
  const v = await adapter.audit("pr/x/y", tmpdir());
  assert.equal(v.decision, "DISAGREE");
  assert.equal(v.agentError, true);
  // The fallback text embeds `bin` itself, not a fixed string — assert
  // dynamically rather than hardcoding what used to be "sh".
  assert.equal(v.reason, `agent exited nonzero: Command failed: ${process.execPath}`);
  assert.equal(v.raw, `Command failed: ${process.execPath}`);
});

test("audit ignores AGREE printed by a crashed agent (F4 fail-safe)", async () => {
  // A nonzero exit must override any verdict the agent printed before dying.
  const adapter = makeCliAdapter({
    name: "boom-agree",
    bin: process.execPath,
    buildArgs: () => nodeScript("console.log('AGREE'); process.exit(3)"),
  });
  const v = await adapter.audit("pr/x/y", tmpdir());
  assert.equal(v.decision, "DISAGREE");
});

test("audit rethrows on usage limit instead of masking as DISAGREE", async () => {
  // A quota hit must propagate so the harness can wait for reset and resume —
  // logging a DISAGREE here would silently corrupt the audit verdict.
  const adapter = makeCliAdapter({
    name: "limited",
    bin: process.execPath,
    buildArgs: () => nodeScript("console.log('Claude usage limit reached. resets at 3pm'); process.exit(1)"),
  });
  await assert.rejects(() => adapter.audit("pr/x/y", tmpdir()), /usage limit/);
});

test("audit does not abort when a SUCCESSFUL run merely mentions limits (#85)", async () => {
  // A reviewer legitimately discussing rate/usage limits in its transcript
  // (e.g. auditing adapter code) must not be misclassified as a provider
  // limit error — only failed runs are limit candidates.
  const adapter = makeCliAdapter({
    name: "chatty",
    bin: process.execPath,
    buildArgs: () => nodeScript(
      "console.log('AGREE: the adapter handles usage limit and 429 responses correctly')"),
  });
  const v = await adapter.audit("pr/x/y", tmpdir());
  assert.equal(v.decision, "AGREE");
});

test("isUsageLimit matches limit messages but not generic failures", () => {
  assert.ok(isUsageLimit("Claude usage limit reached"));
  assert.ok(isUsageLimit("Error 429: too many requests"));
  assert.ok(isUsageLimit("model overloaded"));
  assert.ok(!isUsageLimit("compile error: undefined symbol"));
  assert.ok(!isUsageLimit(""));
});

test("codex buildArgs uses exec --cd with headless write permission", () => {
  assert.deepEqual(codexArgs("PROMPT", "/wd"),
    ["exec", "--cd", "/wd", "--dangerously-bypass-approvals-and-sandbox", "PROMPT"]);
});

test("registry resolves known adapters and rejects unknown", () => {
  assert.equal(get("agy").name, "agy");
  assert.equal(get("claude").name, "claude");
  assert.equal(get("codex").name, "codex");
  assert.equal(get("copilot").name, "copilot");
  assert.equal(get("gemini").name, "gemini");
  assert.equal(get("grok").name, "grok");
  assert.throws(() => get("nope"), /unknown agent/);
});

test("local models register, run via ccr, and select model by flag", () => {
  const a = get("qwen3-coder-30b");
  assert.equal(a.name, "qwen3-coder-30b");
  assert.equal(a.bin, "ccr"); // preflight checks bin, not name
  assert.ok(get("deepseek-coder-v2-lite"));
  assert.ok(get("glm-4.5-air"));
});

test("adapter exposes bin for preflight", () => {
  assert.equal(get("agy").bin, "agy");
  assert.equal(get("claude").bin, "claude"); // name === bin for native agents
  assert.equal(get("copilot").bin, "copilot");
  assert.equal(get("gemini").bin, "gemini");
  assert.equal(get("grok").bin, "grok");
});
