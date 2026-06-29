import { execFileSync, spawn } from "node:child_process";
import { render } from "../prompts.js";
import { parseVerdict } from "../verdict.js";

const OPTS = { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 };
const DEFAULT_PROGRESS_INTERVAL_MS = 30_000;

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

function formatElapsed(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes ? `${minutes}m ${String(rest).padStart(2, "0")}s` : `${seconds}s`;
}

function runAgent(bin, args, cwd, label) {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(bin, args, { cwd });
    const timer = setInterval(() => {
      process.stderr.write(`… ${label} still running (${formatElapsed(Date.now() - started)} elapsed)\n`);
    }, progressIntervalMs());
    timer.unref?.();
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      resolve(result);
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (e) => finish({ out: e.message || "", ok: false }));
    child.on("close", (code, signal) => {
      const failed = code !== 0 || Boolean(signal);
      const out = failed ? `${stdout}${stderr}` || `Command failed: ${bin}` : stdout;
      finish({ out, ok: !failed });
    });
  });
}

// Returns { out, ok }. On nonzero exit / crash, still captures whatever the
// agent printed so audit() can fail safely instead of throwing — EXCEPT a usage
// limit, which we rethrow so the run aborts (rather than logging a bogus
// DISAGREE) and the harness can wait for reset and resume.
async function runCapture(bin, args, cwd, label) {
  const result = await runAgent(bin, args, cwd, label);
  if (isUsageLimit(result.out)) throw new Error(`usage limit hit: ${result.out.trim().slice(0, 200)}`);
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
  return { model, tokens: total };
}

export function parseRunUsage(text, fallbackModel = null) {
  const raw = String(text ?? "");
  let model = fallbackModel;
  let tokens = 0;

  const whole = firstJsonObject(raw.trim());
  if (whole) {
    const parsed = jsonUsage(whole);
    if (parsed.model) model = parsed.model;
    if (parsed.tokens) tokens += parsed.tokens;
  }
  if (!whole) {
    for (const line of raw.split("\n")) {
      const obj = firstJsonObject(line.trim());
      if (!obj) continue;
      const parsed = jsonUsage(obj);
      if (parsed.model) model = parsed.model;
      if (parsed.tokens) tokens += parsed.tokens;
    }
  }

  const modelMatch = raw.match(/\bmodel\b\s*[:=]\s*([^\s,;]+)/i);
  if (modelMatch) model = modelMatch[1];

  const totalMatch = raw.match(/\b(?:total\s+tokens|tokens\s+(?:used|spent)|token\s+usage)\b\s*[:=]?\s*([\d,\s]+)/i);
  if (totalMatch) tokens += num(totalMatch[1]);
  if (!tokens) {
    const input = raw.match(/\b(?:input|prompt)\s+tokens\b\s*[:=]?\s*([\d,\s]+)/i);
    const output = raw.match(/\b(?:output|completion)\s+tokens\b\s*[:=]?\s*([\d,\s]+)/i);
    tokens = num(input?.[1]) + num(output?.[1]);
  }

  return { model, tokens };
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
  return {
    name,
    bin, // the actual executable (may differ from name, e.g. local models run via `ccr`)
    async author(task, wd, opts = {}) {
      // Author must succeed; a failure here is a hard error (no commits made).
      const args = buildArgs(render("author", { task }), wd, opts);
      const result = await runAgent(bin, args, wd, `${name} authoring`);
      if (!result.ok) throw new Error(result.out || `Command failed: ${bin}`);
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
      const { out, ok } = await runCapture(bin, args, wd, `${name} auditing`);
      const usage = parseRunUsage(out, modelFromArgs(args, opts));
      const parsed = parseVerdict(out);
      // A nonzero agent that still printed an explicit DISAGREE gave a real,
      // actionable review finding — keep it (don't bury it as "agent exited").
      // An AGREE from a crashed agent is untrusted and falls through to below.
      if (!ok && parsed.decision === "DISAGREE" && parsed.reason !== "unparseable verdict") return { ...parsed, usage };
      // Nonzero with no usable verdict (#33): flag it `agentError` so the engine
      // escalates instead of asking the author to revise a non-code failure.
      // Surface WHY it died (#31): a bad model id / missing flag lives in `out` —
      // fold a trimmed tail into the reason so the escalation names the cause.
      // Local files only.
      if (!ok) return { decision: "DISAGREE", reason: `agent exited nonzero${detail(out)}`, raw: out, agentError: true, usage };
      return { ...parsed, usage }; // unparseable/empty -> DISAGREE "unparseable verdict"
    },
  };
}
