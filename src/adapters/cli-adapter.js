import { execFileSync, spawn } from "node:child_process";
import { render } from "../prompts.js";
import { parseVerdict } from "../verdict.js";
import { estimateCostUsd } from "../pricing.js";

const OPTS = { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 };
const DEFAULT_PROGRESS_INTERVAL_MS = 30_000;
const DEFAULT_STAGE_TIMEOUT_MS = 25 * 60_000; // #56: per-stage wall-clock cap; 0 disables.

// True if CLI output looks like a Claude usage/rate-limit message. Keep this in
// sync with the regex in harness/orch-loop.sh (is_limit) — that wrapper waits
// out the limit and resumes, so the error must propagate, not get masked.
const LIMIT_RE = /usage limit|rate.?limit|limit (will )?reset|resets? at|\b429\b|overloaded/i;
export function isUsageLimit(text) {
  return LIMIT_RE.test(text || "");
}

function progressIntervalMs() {
  const ms = Number(process.env.ORCH_PROGRESS_INTERVAL_MS);
  return Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_PROGRESS_INTERVAL_MS;
}

// #56: how long a single author/review stage may run before it is force-killed.
// Precedence: ORCH_STAGE_TIMEOUT_MS env override > explicit per-call value (from
// cfg.stageTimeout, threaded by the engine) > module default. The env var is the
// ops escape hatch, so it MUST win over the cfg value — the engine always threads
// an explicit cfg.stageTimeout (default 25m), so an env-loses ordering would make
// the "override" impossible to use without editing orch.yml. 0 disables the
// watchdog. Detection is by stage WALL-CLOCK, never CPU — `codex exec` is
// network-bound and shows TIME=0 even when healthy, so CPU is not a liveness signal.
function stageTimeoutMs(explicit) {
  const env = Number(process.env.ORCH_STAGE_TIMEOUT_MS);
  if (Number.isFinite(env) && env >= 0) return env;
  if (Number.isFinite(explicit) && explicit >= 0) return explicit;
  return DEFAULT_STAGE_TIMEOUT_MS;
}

function formatElapsed(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes ? `${minutes}m ${String(rest).padStart(2, "0")}s` : `${seconds}s`;
}

function runAgent(bin, args, cwd, label, runOpts = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const timeoutMs = stageTimeoutMs(runOpts.stageTimeoutMs);
    let stdout = "";
    let stderr = "";
    let settled = false;
    // detached: the child leads its own process group, so a stalled agent that
    // spawns grandchildren (e.g. `node codex exec` → the codex musl binary) can
    // be reaped as a whole group, not orphaned. #56 observed exactly that pair.
    // stdin "ignore": the child gets /dev/null (immediate EOF). `codex exec`
    // reads stdin to append to its prompt and blocks forever on an open pipe
    // ('Reading additional input from stdin...') — #58. We never write stdin, and
    // claude takes its prompt from argv, so EOF is safe for every adapter.
    const child = spawn(bin, args, { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setInterval(() => {
      process.stderr.write(`… ${label} still running (${formatElapsed(Date.now() - started)} elapsed)\n`);
    }, progressIntervalMs());
    timer.unref?.();
    // #56 watchdog: a hard wall-clock cap. On expiry, SIGKILL the whole group
    // (untrappable — a child that ignores SIGTERM still dies) AND resolve ok:false
    // explicitly. We must NOT wait for `close`: the stalled child may exit 0 on a
    // catchable signal (which would let an empty branch advance to audit) or sit
    // in uninterruptible-sleep on NFS where even SIGKILL doesn't reap promptly.
    const watchdog = timeoutMs > 0 ? setTimeout(() => {
      const elapsed = Date.now() - started;
      process.stderr.write(`… ${label} TIMED OUT after ${formatElapsed(elapsed)} — killing stalled stage\n`);
      // Liveness-gated: only signal a still-running child's group. Once settled or
      // exited the pid may be recycled, and killing a stranger's group is unsafe.
      if (!settled && child.exitCode === null && child.pid != null) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
      }
      finish({ out: `${stdout}${stderr}\n${label} timed out after ${formatElapsed(elapsed)}`, ok: false });
    }, timeoutMs) : null;
    watchdog?.unref?.();
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      if (watchdog) clearTimeout(watchdog);
      resolve(result);
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (e) => {
      const out = e.message || "";
      finish({ out, raw: out, ok: false });
    });
    child.on("close", (code, signal) => {
      const failed = code !== 0 || Boolean(signal);
      const raw = `${stdout}${stderr}`;
      const out = failed ? raw || `Command failed: ${bin}` : stdout;
      finish({ out, raw, ok: !failed });
    });
  });
}

// Returns { out, ok }. On nonzero exit / crash, still captures whatever the
// agent printed so audit() can fail safely instead of throwing — EXCEPT a usage
// limit, which we rethrow so the run aborts (rather than logging a bogus
// DISAGREE) and the harness can wait for reset and resume. Only FAILED runs
// are limit candidates: a successful transcript that merely *discusses* rate
// limits (e.g. a review of adapter code) must not abort the cycle (#85).
async function runCapture(bin, args, cwd, label, runOpts = {}) {
  const result = await runAgent(bin, args, cwd, label, runOpts);
  if (!result.ok && isUsageLimit(result.out)) throw new Error(`usage limit hit: ${result.out.trim().slice(0, 200)}`);
  return result;
}

function num(value) {
  const n = Number(String(value || "").replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function firstJsonObject(line) {
  try {
    const obj = JSON.parse(line);
    return obj && typeof obj === "object" ? obj : null;
  } catch {
    return null;
  }
}

function jsonUsage(obj) {
  const usage = obj.usage || obj.token_usage || obj.tokenUsage || obj.response?.usage || {};
  const input = num(usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens ?? usage.promptTokens);
  const output = num(usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens ?? usage.completionTokens);
  const cached = num(usage.cache_creation_input_tokens) + num(usage.cache_read_input_tokens) + num(usage.cached_tokens);
  const total = num(usage.total_tokens ?? usage.totalTokens) || input + output + cached;
  const model = obj.model || obj.response?.model || obj.message?.model;
  // Claude CLI's `--output-format json` reports actual spend as a top-level
  // `total_cost_usd` — prefer it over our own per-model estimate when present.
  const reportedCostUsd = num(obj.total_cost_usd ?? obj.totalCostUsd) || null;
  return { model, tokens: total, input, output, cached, costUsd: reportedCostUsd };
}

export function parseRunUsage(text, fallbackModel = null) {
  const raw = String(text ?? "");
  let model = fallbackModel;
  let tokens = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let reportedCostUsd = null;

  const apply = (parsed) => {
    if (parsed.model) model = parsed.model;
    if (parsed.tokens) tokens += parsed.tokens;
    inputTokens += parsed.input || 0;
    outputTokens += parsed.output || 0;
    cachedTokens += parsed.cached || 0;
    if (parsed.costUsd != null) reportedCostUsd = (reportedCostUsd || 0) + parsed.costUsd;
  };

  const whole = firstJsonObject(raw.trim());
  if (whole) {
    apply(jsonUsage(whole));
  } else {
    for (const line of raw.split("\n")) {
      const obj = firstJsonObject(line.trim());
      if (!obj) continue;
      apply(jsonUsage(obj));
    }
  }

  const modelMatch = raw.match(/\bmodel\b\s*[:=]\s*([^\s,;]+)/i);
  if (modelMatch) model = modelMatch[1];

  const totalMatch = raw.match(/\b(?:total\s+tokens|tokens\s+(?:used|spent)|token\s+usage)\b\s*[:=]?\s*([\d,\s]+)/i);
  if (totalMatch) tokens += num(totalMatch[1]);
  if (!tokens) {
    const inputMatch = raw.match(/\b(?:input|prompt)\s+tokens\b\s*[:=]?\s*([\d,\s]+)/i);
    const outputMatch = raw.match(/\b(?:output|completion)\s+tokens\b\s*[:=]?\s*([\d,\s]+)/i);
    const inputN = num(inputMatch?.[1]);
    const outputN = num(outputMatch?.[1]);
    tokens = inputN + outputN;
    inputTokens += inputN;
    outputTokens += outputN;
  }

  const costUsd =
    reportedCostUsd != null
      ? reportedCostUsd
      : inputTokens || outputTokens
        ? estimateCostUsd(model, { inputTokens, outputTokens })
        : null;
  const result = { model, tokens };
  if (inputTokens) result.inputTokens = inputTokens;
  if (outputTokens) result.outputTokens = outputTokens;
  if (cachedTokens) result.cachedTokens = cachedTokens;
  if (costUsd != null) result.costUsd = costUsd;
  return result;
}

function modelFromArgs(args, opts = {}) {
  if (opts.model) return opts.model;
  const i = args.indexOf("--model");
  return i >= 0 ? args[i + 1] : null;
}

// Last few non-blank lines of an agent's failure output, trimmed for a verdict
// reason. Empty string when there's nothing useful, so the reason stays clean.
function detail(out) {
  const tail = (out || "").trim().split("\n").map((l) => l.trim()).filter(Boolean).slice(-3).join(" ");
  return tail ? `: ${tail.slice(-300)}` : "";
}

export function makeCliAdapter({ name, bin, buildArgs }) {
  // Spawns read adapter.bin (not the closed-over param) so preflight can rewrite
  // it to an absolute path when the CLI is found off-PATH in a known install dir.
  const adapter = {
    name,
    bin, // the actual executable (may differ from name, e.g. local models run via `ccr`)
    async author(task, wd, opts = {}) {
      // Author must succeed; a failure here is a hard error (no commits made).
      const args = buildArgs(render("author", { task }), wd, opts);
      const result = await runAgent(adapter.bin, args, wd, `${name} authoring`, { stageTimeoutMs: opts.stageTimeoutMs });
      if (!result.ok) throw new Error(result.out || `Command failed: ${adapter.bin}`);
      const out = result.out;
      const usage = parseRunUsage(out, modelFromArgs(args, opts));
      // The agent edits files in the worktree but cannot be trusted to commit
      // them — a `-p` run often leaves the work uncommitted, so the branch stays
      // at base and the auditor reviews an empty diff. Capture the work
      // deterministically: stage everything, and commit if anything is staged.
      // If the agent already committed (clean tree), this is a harmless no-op.
      execFileSync("git", ["add", "-A"], { cwd: wd, ...OPTS });
      const staged = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: wd, ...OPTS }).trim();
      if (staged) {
        execFileSync("git", ["commit", "-m", `orch: ${name} authored task`], { cwd: wd, ...OPTS });
      }
      return { usage };
    },
    async audit(branch, wd, opts = {}) {
      // F4: never throw, and never trust a crashed/nonzero agent. A failed run
      // is a fail-safe DISAGREE even if it printed AGREE before dying.
      const args = buildArgs(render("review", { branch }), wd, opts);
      const { out, raw, ok } = await runCapture(adapter.bin, args, wd, `${name} auditing`, { stageTimeoutMs: opts.stageTimeoutMs });
      const captured = raw ?? out;
      const usage = parseRunUsage(captured, modelFromArgs(args, opts));
      const parsed = parseVerdict(out);
      if (ok && parsed.reason === "unparseable verdict") {
        const parsedRaw = parseVerdict(captured);
        if (parsedRaw.reason !== "unparseable verdict") return { ...parsedRaw, usage };
        return { ...parsed, reason: `unparseable verdict${detail(captured)}`, raw: captured, usage };
      }
      // A nonzero agent that still printed an explicit DISAGREE gave a real,
      // actionable review finding — keep it (don't bury it as "agent exited").
      // An AGREE from a crashed agent is untrusted and falls through to below.
      if (!ok && parsed.decision === "DISAGREE" && parsed.reason !== "unparseable verdict") return { ...parsed, raw: captured, usage };
      // Nonzero with no usable verdict (#33): flag it `agentError` so the engine
      // escalates instead of asking the author to revise a non-code failure.
      // Surface WHY it died (#31): a bad model id / missing flag lives in `out` —
      // fold a trimmed tail into the reason so the escalation names the cause.
      // Local files only.
      if (!ok) return { decision: "DISAGREE", reason: `agent exited nonzero${detail(captured)}`, raw: captured, agentError: true, usage };
      return { ...parsed, raw: captured, usage };
    },
  };
  return adapter;
}
