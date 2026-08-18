import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { buildArgs as agyArgs } from "../src/adapters/agy.js";
import { buildArgs as claudeArgs } from "../src/adapters/claude.js";
import { buildArgs as codexArgs } from "../src/adapters/codex.js";
import { buildArgs as copilotArgs } from "../src/adapters/copilot.js";
import { buildArgs as geminiArgs } from "../src/adapters/gemini.js";
import { buildArgs as grokArgs } from "../src/adapters/grok.js";
import { buildArgs as kimiArgs } from "../src/adapters/kimi.js";
import { buildArgs as zaiArgs } from "../src/adapters/zai.js";
import { get } from "../src/adapters/index.js";
import {
  makeCliAdapter,
  mergeAdapterEnv,
  allowlistEnv,
  isUsageLimit,
  parseRunUsage,
  MAX_AGENT_OUTPUT_CHARS,
  formatProgressBeat,
  _resetReviewProgress,
  createCapturedOutput,
  appendCapturedOutput,
  capturedOutputText,
} from "../src/adapters/cli-adapter.js";

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

// #272/#296: headless agy edits and reads inside its own scratch workspace,
// never the cwd worktree it's handed — so letting it author would silently
// produce an empty diff, and letting it review would judge stale/empty
// scratch-dir state instead of the real branch. Both seats must refuse loudly
// and never spawn the CLI (a spawn would "succeed" and reintroduce the silent
// no-op / bogus-verdict bug this guards against).
test("agy refuses the author seat loudly (#272, #296)", async () => {
  await assert.rejects(
    () => get("agy").author("do work", tmpdir(), {}),
    /agy cannot be used.*scratch workspace/s,
  );
});

test("agy refuses the audit seat loudly (#272, #296)", async () => {
  await assert.rejects(
    () => get("agy").audit("some-branch", tmpdir(), {}),
    /agy cannot be used.*scratch workspace/s,
  );
});

// preflight() (src/cli.js) reads this flag to reject a config naming agy
// before a cycle ever starts, instead of only failing mid-run inside
// author()/audit(). See "preflight rejects a config naming agy" in cli.test.js.
test("agy adapter exposes `disabled` so preflight can reject it upfront (#272, #296)", () => {
  assert.match(get("agy").disabled, /scratch workspace/);
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

test("zai reuses claude's argv builder", () => {
  assert.deepEqual(zaiArgs("PROMPT", "/wd", { model: "glm-4.7" }),
    claudeArgs("PROMPT", "/wd", { model: "glm-4.7" }));
});

test("zai is disabled without an API key and enables dynamically when one is set", () => {
  const originalKey = process.env.ZAI_API_KEY;
  try {
    delete process.env.ZAI_API_KEY;
    assert.match(get("zai").disabled, /ZAI_API_KEY is not set/);
    process.env.ZAI_API_KEY = "test-key";
    assert.equal(get("zai").disabled, undefined);
  } finally {
    if (originalKey === undefined) delete process.env.ZAI_API_KEY;
    else process.env.ZAI_API_KEY = originalKey;
  }
});

test("mergeAdapterEnv preserves, overrides, and deletes without mutating the base", () => {
  const base = { inherited: "yes", replaced: "old", removed: "present" };
  const merged = mergeAdapterEnv(base, { replaced: "new", removed: undefined, added: "value" });
  assert.deepEqual(merged, { inherited: "yes", replaced: "new", added: "value" });
  assert.deepEqual(base, { inherited: "yes", replaced: "old", removed: "present" });
});

test("allowlistEnv keeps only allowlisted names, case-insensitively", () => {
  const filtered = allowlistEnv({
    PATH: "/bin", Path: "C:\\Windows", ProgramData: "C:\\ProgramData",
    ANTHROPIC_API_KEY: "k", CLAUDE_CODE_OAUTH_TOKEN: "t", https_proxy: "http://p",
    GH_TOKEN: "ghs_leak", GITHUB_TOKEN: "ghp_leak", AWS_SECRET_ACCESS_KEY: "aws",
    NODE_OPTIONS: "--require evil.js", ORCH_STAGE_TIMEOUT_MS: "1", SOME_RANDOM_SECRET: "s",
  });
  assert.deepEqual(filtered, {
    PATH: "/bin", Path: "C:\\Windows", ProgramData: "C:\\ProgramData",
    ANTHROPIC_API_KEY: "k", CLAUDE_CODE_OAUTH_TOKEN: "t", https_proxy: "http://p",
  });
});

test("child env is allowlisted: GH_TOKEN and ambient secrets never reach the agent", async () => {
  const allowedKey = "ANTHROPIC_ORCH_TEST_INHERITED";
  const overriddenKey = "ANTHROPIC_ORCH_TEST_OVERRIDDEN";
  const deletedKey = "ANTHROPIC_ORCH_TEST_DELETED";
  const secretKey = "ORCH_TEST_ADAPTER_SECRET";
  const keys = [allowedKey, overriddenKey, deletedKey, secretKey, "GH_TOKEN"];
  const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env[allowedKey] = "inherited";
  process.env[overriddenKey] = "parent";
  process.env[deletedKey] = "remove-me";
  process.env[secretKey] = "ambient-secret";
  process.env.GH_TOKEN = "ghs_installation_token";
  try {
    const script = `process.stdout.write(JSON.stringify({
      inherited: process.env[${JSON.stringify(allowedKey)}],
      overridden: process.env[${JSON.stringify(overriddenKey)}],
      deleted: Object.hasOwn(process.env, ${JSON.stringify(deletedKey)}),
      secret: Object.hasOwn(process.env, ${JSON.stringify(secretKey)}),
      ghToken: Object.hasOwn(process.env, "GH_TOKEN"),
      hasPath: Boolean(process.env.PATH || process.env.Path),
    }) + "\\nAGREE\\n")`;
    const adapter = makeCliAdapter({
      name: "env-spy",
      bin: process.execPath,
      env: { [overriddenKey]: "adapter", [deletedKey]: undefined },
      buildArgs: () => nodeScript(script),
    });
    const result = await adapter.audit("pr/x/y", tmpdir());
    assert.match(result.raw, /"inherited":"inherited"/);
    assert.match(result.raw, /"overridden":"adapter"/);
    assert.match(result.raw, /"deleted":false/);
    // The point of the allowlist: neither orch's own GitHub credential nor any
    // other ambient variable is visible to the untrusted agent subprocess.
    assert.match(result.raw, /"secret":false/);
    assert.match(result.raw, /"ghToken":false/);
    assert.match(result.raw, /"hasPath":true/);
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
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

test("kimi buildArgs uses headless prompt mode without approval flags", () => {
  // -p/--prompt is kimi-code's non-interactive single-prompt mode. It must NOT
  // carry --yolo or --auto: kimi-code 0.27.0 exits 1 with "error: Cannot
  // combine --prompt with --yolo" — prompt mode auto-approves tools on its own.
  const args = kimiArgs("PROMPT", "/wd");
  assert.deepEqual(args, ["-p", "PROMPT"]);
  assert.ok(!args.includes("--yolo") && !args.includes("--auto"));
});

test("kimi buildArgs appends --model when given", () => {
  assert.deepEqual(kimiArgs("PROMPT", "/wd", { model: "kimi-k2" }),
    ["-p", "PROMPT", "--model", "kimi-k2"]);
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
  assert.deepEqual(kimiArgs("P", "/wd", {}), ["-p", "P"]);
});

test("adapter forwards model/effort opts to buildArgs", async () => {
  let seen;
  const adapter = makeCliAdapter({
    name: "spy", bin: process.execPath,
    capabilities: { model: true, effort: true },
    buildArgs: (_p, _wd, opts) => { seen = opts; return nodeScript("process.exit(0)"); },
  });
  await adapter.audit("pr/x/y", tmpdir(), { model: "m1", effort: "low" });
  assert.deepEqual(seen, { model: "m1", effort: "low" });
});

test("adapter rejects unsupported model/effort opts before spawning", async () => {
  let spawned = false;
  const adapter = makeCliAdapter({
    name: "limited", bin: process.execPath,
    capabilities: { model: true, effort: false },
    buildArgs: () => { spawned = true; return nodeScript("process.exit(0)"); },
  });
  await assert.rejects(
    () => adapter.audit("pr/x/y", tmpdir(), { model: "ok", effort: "high" }),
    /limited adapter does not support effort settings/,
  );
  assert.equal(spawned, false);
});

test("adapters declare model/effort capability support", () => {
  assert.deepEqual(get("claude").capabilities, { model: true, effort: true });
  assert.deepEqual(get("codex").capabilities, { model: true, effort: true });
  assert.deepEqual(get("agy").capabilities, { model: true, effort: false });
  assert.deepEqual(get("copilot").capabilities, { model: true, effort: false });
  assert.deepEqual(get("gemini").capabilities, { model: true, effort: false });
  assert.deepEqual(get("grok").capabilities, { model: true, effort: true });
  assert.deepEqual(get("kimi").capabilities, { model: true, effort: false });
  assert.deepEqual(get("zai").capabilities, { model: true, effort: false });
  assert.deepEqual(get("qwen3-coder-30b").capabilities, { model: false, effort: false });
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

test("parseRunUsage does not stack text fallbacks on top of parsed JSON usage", () => {
  // Transcript reports usage in JSON *and* mentions token/model lines in prose
  // (e.g. an agent reviewing usage code) — prose must not double-count tokens
  // or overwrite the JSON model.
  assert.deepEqual(
    parseRunUsage('{"model":"claude-opus-4.8","usage":{"input_tokens":1000,"output_tokens":250}}\nmodel: gpt-5.1\ntotal tokens: 9999\n'),
    { model: "claude-opus-4.8", tokens: 1250, inputTokens: 1000, outputTokens: 250, costUsd: 0.03375 },
  );
});

test("parseRunUsage text fallbacks still fill data JSON did not provide", () => {
  // JSON present but with no usage/model — prose fills the gaps.
  assert.deepEqual(
    parseRunUsage('{"type":"result"}\nmodel: gpt-5.1\ninput tokens: 100\noutput tokens: 25\n'),
    { model: "gpt-5.1", tokens: 125, inputTokens: 100, outputTokens: 25, costUsd: 0.000875 },
  );
});

test("parseRunUsage preserves a reported zero cost instead of re-estimating", () => {
  assert.deepEqual(
    parseRunUsage('{"model":"claude-opus-4.8","total_cost_usd":0,"usage":{"input_tokens":1000,"output_tokens":250}}\n'),
    { model: "claude-opus-4.8", tokens: 1250, inputTokens: 1000, outputTokens: 250, costUsd: 0 },
  );
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

test("audit caps captured child output while preserving the tail", async () => {
  const adapter = makeCliAdapter({
    name: "chatty",
    bin: process.execPath,
    buildArgs: () => nodeScript(
      `process.stdout.write('x'.repeat(${MAX_AGENT_OUTPUT_CHARS + 50_000}));` +
      "process.stdout.write('\\nAGREE final verdict\\n')"),
  });
  const v = await adapter.audit("pr/x/y", tmpdir());
  assert.equal(v.decision, "AGREE");
  assert.match(v.raw, /output truncated to last/);
  assert.match(v.raw, /final verdict/);
  assert.ok(v.raw.length <= MAX_AGENT_OUTPUT_CHARS + 200);
});

// Unit: amortized buffer (ADP-1) — under-cap concat, over-cap marker+tail,
// many small post-cap chunks stay correct without per-chunk 1MB re-slice.
test("appendCapturedOutput concatenates under the cap", () => {
  const buf = createCapturedOutput();
  appendCapturedOutput(buf, "hello ");
  appendCapturedOutput(buf, "world");
  assert.equal(capturedOutputText(buf), "hello world");
  assert.equal(buf.truncated, false);
});

test("appendCapturedOutput keeps last 1MB with truncation marker", () => {
  const buf = createCapturedOutput();
  const head = "H".repeat(100_000);
  const mid = "M".repeat(MAX_AGENT_OUTPUT_CHARS);
  const tail = "TAIL-MARKER-XYZ";
  appendCapturedOutput(buf, head);
  appendCapturedOutput(buf, mid);
  appendCapturedOutput(buf, tail);
  const text = capturedOutputText(buf);
  assert.match(text, /^\[orch: output truncated to last /);
  assert.ok(text.endsWith(tail));
  assert.ok(!text.includes("H".repeat(100))); // head was dropped
  // marker + at most MAX payload
  assert.ok(text.length <= MAX_AGENT_OUTPUT_CHARS + 200);
  assert.equal(text.length - text.indexOf("\n") - 1, MAX_AGENT_OUTPUT_CHARS);
});

test("appendCapturedOutput amortizes many small post-cap chunks", () => {
  const buf = createCapturedOutput();
  // Fill past the cap with one large chunk, then stream many tiny ones.
  appendCapturedOutput(buf, "x".repeat(MAX_AGENT_OUTPUT_CHARS + 10_000));
  const n = 2_000;
  for (let i = 0; i < n; i++) appendCapturedOutput(buf, `e${i % 10}`);
  // Intermediate length stays bounded (cap × 1.5 + one chunk, plus marker room).
  assert.ok(buf.len <= Math.floor(MAX_AGENT_OUTPUT_CHARS * 1.5) + 8);
  const text = capturedOutputText(buf);
  assert.match(text, /output truncated to last/);
  assert.ok(text.endsWith("e9")); // last of e0..e9 cycle
  assert.ok(text.length <= MAX_AGENT_OUTPUT_CHARS + 200);
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

test("formatProgressBeat keeps non-TTY line-per-beat form byte-for-byte", () => {
  assert.equal(
    formatProgressBeat({
      tty: false,
      stage: "review",
      label: "slow auditing",
      word: "percolating",
      dots: "...",
      elapsed: "30s",
    }),
    "… slow auditing still running (30s elapsed)\n",
  );
});

test("formatProgressBeat rewrites one TTY line with stage, whimsy, dots, elapsed", () => {
  const line = formatProgressBeat({
    tty: true,
    stage: "author",
    label: "claude authoring",
    word: "percolating",
    dots: "......",
    elapsed: "6m 30s",
  });
  assert.equal(line, "\r▸ author  claude authoring   percolating......      6m 30s\x1b[K");
  assert.ok(!line.endsWith("\n"), "TTY beat must not append a newline (in-place rewrite)");
});

test("audit emits elapsed progress while the agent is still running (non-TTY)", async () => {
  const priorInterval = process.env.ORCH_PROGRESS_INTERVAL_MS;
  const priorWrite = process.stderr.write;
  const priorIsTTY = process.stderr.isTTY;
  const writes = [];
  process.env.ORCH_PROGRESS_INTERVAL_MS = "10";
  Object.defineProperty(process.stderr, "isTTY", { value: false, configurable: true });
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
    const joined = writes.join("");
    assert.match(joined, /slow auditing still running .* elapsed/);
    assert.ok(!joined.includes("\r"), "non-TTY must not emit carriage returns");
    assert.ok(!joined.includes("\x1b["), "non-TTY must not emit ANSI escapes");
  } finally {
    if (priorInterval === undefined) delete process.env.ORCH_PROGRESS_INTERVAL_MS;
    else process.env.ORCH_PROGRESS_INTERVAL_MS = priorInterval;
    process.stderr.write = priorWrite;
    Object.defineProperty(process.stderr, "isTTY", { value: priorIsTTY, configurable: true });
  }
});

test("audit rewrites one live TTY progress line with stage + whimsy + elapsed", async () => {
  const priorInterval = process.env.ORCH_PROGRESS_INTERVAL_MS;
  const priorWrite = process.stderr.write;
  const priorIsTTY = process.stderr.isTTY;
  const writes = [];
  process.env.ORCH_PROGRESS_INTERVAL_MS = "10";
  Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
  process.stderr.write = (chunk) => {
    writes.push(String(chunk));
    return true;
  };
  _resetReviewProgress();
  try {
    const adapter = makeCliAdapter({
      name: "slow",
      bin: process.execPath,
      buildArgs: () => nodeScript("setTimeout(() => process.stdout.write('AGREE ok\\n'), 60)"),
    });
    const v = await adapter.audit("pr/x/y", tmpdir(), { round: 1 });
    assert.equal(v.decision, "AGREE");
    const progress = writes.filter((w) => w.includes("\r▸"));
    assert.ok(progress.length >= 1, "expected at least one in-place progress beat");
    assert.match(progress[0], /^\r▸ review  slow auditing   \w+1\.+\s+\d/);
    assert.ok(progress[0].includes("\x1b[K"), "TTY beat erases to end of line");
    // Later beats rewrite the same line (no newline between them).
    for (const beat of progress) {
      assert.ok(!beat.includes("\n"), "progress beats stay on one line until finish");
    }
    // Finish ends the strip so the next phase line is clean.
    assert.ok(writes.some((w) => w === "\n"), "finish must emit a trailing newline after TTY progress");
  } finally {
    _resetReviewProgress();
    if (priorInterval === undefined) delete process.env.ORCH_PROGRESS_INTERVAL_MS;
    else process.env.ORCH_PROGRESS_INTERVAL_MS = priorInterval;
    process.stderr.write = priorWrite;
    Object.defineProperty(process.stderr, "isTTY", { value: priorIsTTY, configurable: true });
  }
});

test("review TTY progress accumulates dots and round markers across rounds", async () => {
  const priorInterval = process.env.ORCH_PROGRESS_INTERVAL_MS;
  const priorWrite = process.stderr.write;
  const priorIsTTY = process.stderr.isTTY;
  const writes = [];
  process.env.ORCH_PROGRESS_INTERVAL_MS = "10";
  Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
  process.stderr.write = (chunk) => {
    writes.push(String(chunk));
    return true;
  };
  _resetReviewProgress();
  try {
    const adapter = makeCliAdapter({
      name: "slow",
      bin: process.execPath,
      buildArgs: () => nodeScript("setTimeout(() => process.stdout.write('AGREE ok\\n'), 45)"),
    });
    await adapter.audit("pr/x/y", tmpdir(), { round: 1 });
    await adapter.audit("pr/x/y", tmpdir(), { round: 2 });
    const progress = writes.filter((w) => w.includes("\r▸"));
    assert.ok(progress.length >= 2, "expected progress across both rounds");
    // At least one beat from round 2 must show both round markers and more dots.
    const late = progress[progress.length - 1];
    assert.match(late, /1\.+2\.+/);
    assert.match(late, /^\r▸ review  slow auditing/);
  } finally {
    _resetReviewProgress();
    if (priorInterval === undefined) delete process.env.ORCH_PROGRESS_INTERVAL_MS;
    else process.env.ORCH_PROGRESS_INTERVAL_MS = priorInterval;
    process.stderr.write = priorWrite;
    Object.defineProperty(process.stderr, "isTTY", { value: priorIsTTY, configurable: true });
  }
});

// Parallel reviewers (engine Promise.all) must not share one module-level strip:
// each keeps its own progress identity, and concurrent TTY beats fall back to
// line-per-beat so labels/elapsed stay attributable instead of flickering one \r line.
test("parallel reviewers keep separate TTY progress and fall back to line-per-beat", async () => {
  const priorInterval = process.env.ORCH_PROGRESS_INTERVAL_MS;
  const priorWrite = process.stderr.write;
  const priorIsTTY = process.stderr.isTTY;
  const writes = [];
  process.env.ORCH_PROGRESS_INTERVAL_MS = "10";
  Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
  process.stderr.write = (chunk) => {
    writes.push(String(chunk));
    return true;
  };
  _resetReviewProgress();
  try {
    const slow = (name) => makeCliAdapter({
      name,
      bin: process.execPath,
      buildArgs: () => nodeScript("setTimeout(() => process.stdout.write('AGREE ok\\n'), 55)"),
    });
    const a = slow("alpha");
    const b = slow("beta");
    const wd = tmpdir();
    await Promise.all([
      a.audit("pr/x/y", wd, { round: 1 }),
      b.audit("pr/x/y", wd, { round: 1 }),
    ]);
    const joined = writes.join("");
    assert.ok(joined.includes("alpha auditing"), "alpha progress must be attributable");
    assert.ok(joined.includes("beta auditing"), "beta progress must be attributable");
    // Under concurrency the strip falls back to newline-per-beat (non-CR form).
    const concurrentBeats = writes.filter((w) =>
      w.includes("still running") && (w.includes("alpha") || w.includes("beta")));
    assert.ok(concurrentBeats.length >= 2, "expected line-per-beat progress from both reviewers");
    for (const beat of concurrentBeats) {
      assert.ok(beat.endsWith("\n"), "concurrent beats must be line-per-beat, not CR rewrites");
      assert.ok(!beat.includes("\r"), "concurrent beats must not fight over one CR line");
    }
    // Shared state would interleave both labels into one strip's dots; with
    // per-label state, each beat names exactly one reviewer.
    for (const beat of concurrentBeats) {
      const hasAlpha = beat.includes("alpha");
      const hasBeta = beat.includes("beta");
      assert.equal(hasAlpha !== hasBeta, true, `beat must name one reviewer, got: ${JSON.stringify(beat)}`);
    }
  } finally {
    _resetReviewProgress();
    if (priorInterval === undefined) delete process.env.ORCH_PROGRESS_INTERVAL_MS;
    else process.env.ORCH_PROGRESS_INTERVAL_MS = priorInterval;
    process.stderr.write = priorWrite;
    Object.defineProperty(process.stderr, "isTTY", { value: priorIsTTY, configurable: true });
  }
});

// Staggered finish: concurrent path latches endedProgressLine when closing the
// shared CR strip. When one reviewer exits early, the survivor resumes CR
// rewrite and must clear that latch so its finish still emits a trailing \n —
// otherwise the next phase line glues onto the stale strip.
test("survivor TTY progress ends with newline after concurrency drops 2→1", async () => {
  const priorInterval = process.env.ORCH_PROGRESS_INTERVAL_MS;
  const priorWrite = process.stderr.write;
  const priorIsTTY = process.stderr.isTTY;
  const writes = [];
  process.env.ORCH_PROGRESS_INTERVAL_MS = "10";
  Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
  process.stderr.write = (chunk) => {
    writes.push(String(chunk));
    return true;
  };
  _resetReviewProgress();
  try {
    const early = makeCliAdapter({
      name: "early",
      bin: process.execPath,
      buildArgs: () => nodeScript("setTimeout(() => process.stdout.write('AGREE ok\\n'), 35)"),
    });
    const late = makeCliAdapter({
      name: "late",
      bin: process.execPath,
      buildArgs: () => nodeScript("setTimeout(() => process.stdout.write('AGREE ok\\n'), 120)"),
    });
    const wd = tmpdir();
    await Promise.all([
      early.audit("pr/x/y", wd, { round: 1 }),
      late.audit("pr/x/y", wd, { round: 1 }),
    ]);
    // Concurrent window: both emit line-per-beat (non-CR).
    const concurrentBeats = writes.filter((w) =>
      w.includes("still running") && (w.includes("early") || w.includes("late")));
    assert.ok(concurrentBeats.length >= 1, "expected concurrent line-per-beat while both alive");
    // After early exits, late resumes solo CR rewrite.
    const survivorCr = writes.filter((w) => w.includes("\r▸") && w.includes("late auditing"));
    assert.ok(survivorCr.length >= 1, "survivor must resume in-place CR progress after peer exits");
    // Survivor finish must terminate the CR strip so the next phase line is clean.
    assert.ok(writes.some((w) => w === "\n"), "survivor finish must emit trailing newline after CR progress");
    // Last CR beat must be followed by a standalone newline (not glued phase text).
    const lastCrIdx = writes.findLastIndex((w) => w.includes("\r▸") && w.includes("late auditing"));
    assert.ok(lastCrIdx >= 0);
    const afterCr = writes.slice(lastCrIdx + 1);
    assert.ok(afterCr.some((w) => w === "\n"), "terminating newline must follow survivor's last CR beat");
  } finally {
    _resetReviewProgress();
    if (priorInterval === undefined) delete process.env.ORCH_PROGRESS_INTERVAL_MS;
    else process.env.ORCH_PROGRESS_INTERVAL_MS = priorInterval;
    process.stderr.write = priorWrite;
    Object.defineProperty(process.stderr, "isTTY", { value: priorIsTTY, configurable: true });
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

for (const parentSignal of ["SIGTERM", "SIGHUP"]) test(`terminating the orch process with ${parentSignal} kills its detached agent child`, { timeout: 5000, skip: process.platform === "win32" }, async () => {
  const wd = mkdtempSync(join(tmpdir(), "orch-parent-exit-"));
  const pidFile = join(wd, "agent.pid");
  const adapterUrl = new URL("../src/adapters/cli-adapter.js", import.meta.url).href;
  const parent = spawn(process.execPath, ["--input-type=module", "-e", `
    import { makeCliAdapter } from ${JSON.stringify(adapterUrl)};
    const adapter = makeCliAdapter({
      name: "staller",
      bin: process.execPath,
      buildArgs: () => ["-e", ${JSON.stringify(`require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)`)}],
    });
    await adapter.audit("pr/x/y", ${JSON.stringify(wd)}, { stageTimeoutMs: 0 });
  `], { stdio: "ignore" });

  let agentPid;
  for (let i = 0; i < 50; i++) {
    try { agentPid = Number(readFileSync(pidFile, "utf8")); break; } catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
  }
  assert.ok(agentPid, "agent child did not start");
  parent.kill(parentSignal);
  await new Promise((resolve) => parent.once("exit", resolve));

  let reaped = false;
  for (let i = 0; i < 100; i++) {
    try { process.kill(agentPid, 0); } catch (error) {
      if (error.code === "ESRCH") { reaped = true; break; }
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(reaped, "agent child was not reaped");
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

test("audit escalates when a crashed agent only echoed the review prompt", async () => {
  // Real failure mode: `codex exec` rejects a bad model id with a 400 but echoes
  // the rendered review prompt first. That prompt spells out the verdict
  // vocabulary ("- `DISAGREE` followed by a one-paragraph reason…"), which the
  // parser's word-boundary fallback used to read as a genuine rejection —
  // dispatching revise rounds against stderr noise. Unanchored + nonzero must
  // take the #33 agentError escalation instead.
  const adapter = makeCliAdapter({
    name: "echo-boom",
    bin: process.execPath,
    buildArgs: () => nodeScript(
      "console.log('- `AGREE` followed by a one-paragraph reason, if the change should merge.');" +
      "console.log('- `DISAGREE` followed by a one-paragraph reason listing concrete findings.');" +
      "process.stderr.write('ERROR: model not supported\\n'); process.exit(1)"),
  });
  const v = await adapter.audit("pr/x/y", tmpdir());
  assert.equal(v.decision, "DISAGREE");
  assert.equal(v.agentError, true, "an echoed prompt is not a review — escalate, don't revise");
  assert.match(v.reason, /agent exited nonzero/);
});

test("audit escalates when a successful agent only echoed the review prompt", async () => {
  // Exit 0, but the output is the rendered review prompt verbatim — the
  // reviewer never ran. The prompt's own instruction bullets contain AGREE /
  // DISAGREE, so the unanchored fallback would otherwise read them as a real
  // verdict and drive pointless revise rounds against a dead reviewer.
  const adapter = makeCliAdapter({
    name: "echo-ok",
    bin: process.execPath,
    buildArgs: (prompt) => [...nodeScript("process.stdout.write(process.argv[1])"), prompt],
  });
  const v = await adapter.audit("pr/x/y", tmpdir());
  assert.equal(v.decision, "DISAGREE");
  assert.equal(v.agentError, true, "a pure prompt echo is not a review — escalate, don't revise");
  assert.match(v.reason, /only echoed the review prompt/);
});

test("audit keeps a genuine AGREE sitting between quoted prompt bullets", async () => {
  // A reviewer that quotes its own instructions is normal. A line-leading
  // AGREE between the two quoted bullets is a real verdict, not an echo —
  // it must survive the echo strip and parse as AGREE with no agentError.
  const out = [
    "Reviewer notes, quoting the instructions for clarity:",
    "- `AGREE` followed by a one-paragraph reason, if the change should merge.",
    "AGREE",
    "The change is correct and well tested.",
    "- `DISAGREE` followed by a one-paragraph reason listing concrete findings.",
    "",
  ].join("\n");
  const adapter = makeCliAdapter({
    name: "quoting-reviewer",
    bin: process.execPath,
    buildArgs: () => nodeScript(`process.stdout.write(${JSON.stringify(out)})`),
  });
  const v = await adapter.audit("pr/x/y", tmpdir());
  assert.equal(v.decision, "AGREE");
  assert.equal(v.agentError, undefined);
});

test("audit keeps a genuine AGREE before a trailing full-prompt recap", async () => {
  // Verdict first, then a debug dump of the whole prompt. The recap contains
  // the prompt's verdict bullets, but the leading AGREE is genuine and must
  // parse as AGREE with no agentError.
  const out = [
    "AGREE",
    "The change is correct and well tested.",
    "",
    "--- (debug: prompt recap below) ---",
    "You are an adversarial code reviewer. Audit the branch `pr/x/y` against `main`.",
    "- `AGREE` followed by a one-paragraph reason, if the change should merge.",
    "- `DISAGREE` followed by a one-paragraph reason listing concrete findings.",
    "",
  ].join("\n");
  const adapter = makeCliAdapter({
    name: "recap-reviewer",
    bin: process.execPath,
    buildArgs: () => nodeScript(`process.stdout.write(${JSON.stringify(out)})`),
  });
  const v = await adapter.audit("pr/x/y", tmpdir());
  assert.equal(v.decision, "AGREE");
  assert.equal(v.agentError, undefined);
});

test("audit keeps an ordinary DISAGREE with a real reason (no agentError)", async () => {
  const adapter = makeCliAdapter({
    name: "real-disagree",
    bin: process.execPath,
    buildArgs: () => nodeScript("console.log('DISAGREE the parser drops empty lines')"),
  });
  const v = await adapter.audit("pr/x/y", tmpdir());
  assert.equal(v.decision, "DISAGREE");
  assert.match(v.reason, /drops empty lines/);
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
  assert.equal(get("kimi").name, "kimi");
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
  assert.equal(get("kimi").bin, "kimi");
});
