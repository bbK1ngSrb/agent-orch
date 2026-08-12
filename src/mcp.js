// MCP (Model Context Protocol) stdio server. Exposes a small, fixed set of orch
// operations to any MCP client — Hermes Agent, Claude Code — over
// newline-delimited JSON-RPC 2.0 on stdin/stdout, so both clients drive the same
// orchestration through one contract instead of two hand-rolled shell recipes.
//
// The CLI stays the source of truth. Every tool spawns `bin/orch.js` with a
// FIXED argv array assembled from validated arguments:
//
//   * no shell (`spawn` with `shell: false`), so nothing here can execute an
//     arbitrary command;
//   * no caller-supplied flags — free text is passed after `--` and rejected if
//     it starts with `-`, so a task string cannot smuggle in `--allow-protected`
//     or `--config-file`;
//   * no tool can emit `--merge`, and `orch pr` is not exposed at all. `--merge`
//     is orch's only PR-merge path, so an MCP client can never merge into
//     `main`; a cycle lands on the integration branch and `main` still advances
//     only through the standing integration PR a human merges. That is a
//     property of the tool table, not of a policy layer — see the test.
//
// Security, protected-path, test-gate, worktree, checkpoint and concurrency
// controls all live in the cycle the child process runs, so they apply to an
// MCP-started cycle exactly as they do to a hand-typed one.
//
// stdout carries protocol frames only; every diagnostic goes to stderr.

import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

const ORCH_BIN = fileURLToPath(new URL("../bin/orch.js", import.meta.url));

// Fallback only. The negotiated version is whatever the client asks for: a
// client that sees an unfamiliar string may refuse to continue to tools/list.
export const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

function requireText(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  // A leading dash would be read as a flag by the child's argument parser even
  // behind `--` on some shells' completion paths; refuse it outright.
  if (/^-/.test(value.trim())) throw new Error(`${field} must not start with '-'`);
  return value.trim();
}

function requireBranch(value) {
  const branch = requireText(value, "branch");
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch)) throw new Error("branch has invalid characters");
  return branch;
}

function requireSid(value) {
  const sid = requireText(value, "sid");
  if (!/^[A-Za-z0-9._-]+$/.test(sid)) throw new Error("sid has invalid characters");
  return sid;
}

function requireIssueNumber(value) {
  const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isInteger(n) || n <= 0) throw new Error("number must be a positive integer");
  return String(n);
}

const TEXT_ARG = { type: "string", description: "What the cycle should change, in plain English." };

// The tool table. `argv` builds the child's arguments; `match` narrows the
// runs.jsonl records the call reports (see readNewRuns).
export const TOOLS = [
  {
    name: "orch_status",
    description:
      "Read orch's current state: live cycles, interrupted checkpoints and recent run history. Fast, read-only.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", description: "Run-history rows to return (default 10)." } },
      additionalProperties: false,
    },
    argv: (a) => {
      const argv = ["dashboard", "--json", "--once"];
      if (a.limit != null) {
        if (!Number.isInteger(a.limit) || a.limit <= 0) throw new Error("limit must be a positive integer");
        argv.push("--limit", String(a.limit));
      }
      return argv;
    },
    parseStdout: true,
  },
  {
    name: "orch_plan",
    description:
      "Dry-run a task: report the branch, author and reviewers a cycle would use without shelling out to any agent or touching git.",
    inputSchema: { type: "object", properties: { task: TEXT_ARG }, required: ["task"], additionalProperties: false },
    argv: (a) => ["task", "--dry", "--", requireText(a.task, "task")],
  },
  {
    name: "orch_task",
    description:
      "Run a full cycle (author, cross-audit, test gate) from a task description. On agreement the branch lands on the integration branch — never on main.",
    inputSchema: { type: "object", properties: { task: TEXT_ARG }, required: ["task"], additionalProperties: false },
    argv: (a) => ["task", "--", requireText(a.task, "task")],
  },
  {
    name: "orch_issue",
    description: "Run a cycle whose work order is fetched from a GitHub issue; the issue closes when the change lands.",
    inputSchema: {
      type: "object",
      properties: { number: { type: "integer", description: "GitHub issue number." } },
      required: ["number"],
      additionalProperties: false,
    },
    argv: (a) => ["issue", requireIssueNumber(a.number)],
  },
  {
    name: "orch_review",
    description: "Audit an existing branch with the reviewer agents without merging it.",
    inputSchema: {
      type: "object",
      properties: { branch: { type: "string", description: "Branch to audit." } },
      required: ["branch"],
      additionalProperties: false,
    },
    argv: (a) => ["review", requireBranch(a.branch)],
    match: (a) => ({ branch: requireBranch(a.branch) }),
  },
  {
    name: "orch_continue",
    description: "Resume an interrupted or stalled cycle from its checkpoint, by cycle id (sid).",
    inputSchema: {
      type: "object",
      properties: { sid: { type: "string", description: "Cycle id, as reported by orch_status." } },
      required: ["sid"],
      additionalProperties: false,
    },
    argv: (a) => ["continue", requireSid(a.sid)],
    match: (a) => ({ sid: requireSid(a.sid) }),
  },
];

function fileSize(path) {
  try { return statSync(path).size; } catch { return 0; }
}

// runs.jsonl is repo-wide and append-only, so the tail written while one tool
// call ran may also hold records from a concurrent cycle (another MCP call, a
// terminal `orch`, the poller). Filter by whatever this call knows for certain;
// `orch_task`/`orch_issue` learn their sid only from the record itself, so they
// report the whole tail and the caller reads the branch.
function readNewRuns(path, offset, filter = {}) {
  if (fileSize(path) <= offset) return [];
  let text = "";
  try { text = readFileSync(path).subarray(offset).toString("utf8"); }
  catch { return []; }
  return text.split("\n").filter(Boolean).flatMap((line) => {
    let entry;
    try { entry = JSON.parse(line); } catch { return []; }
    if (Object.entries(filter).some(([k, v]) => entry[k] !== v)) return [];
    return [{
      sid: entry.sid ?? null,
      branch: entry.branch ?? null,
      status: entry.verdict ?? null,
      reason: entry.reason ?? null,
      prUrl: entry.prUrl ?? null,
      closes: entry.closes ?? null,
      rounds: entry.rounds ?? null,
    }];
  });
}

// ponytail: a real cycle takes minutes and the call blocks for all of it — an
// MCP client with a short timeout will give up while the cycle keeps running to
// completion in the child. The fast tools (orch_status, orch_plan) carry most of
// the value. Upgrade path if that bites: start the cycle detached, return its sid
// immediately, and let the caller poll orch_status.
export function runTool(tool, args, ctx) {
  const { repo, spawnFn = spawn } = ctx;
  const argv = tool.argv(args); // throws on invalid arguments — caller reports it
  const orchDir = join(repo, ".orch");
  const runsLog = join(orchDir, "runs.jsonl");
  const offset = fileSize(runsLog);
  return new Promise((resolve) => {
    const child = spawnFn(process.execPath, [ORCH_BIN, ...argv], {
      cwd: repo,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => { stdout += d; });
    child.stderr?.on("data", (d) => { stderr += d; });
    child.on("error", (e) => resolve({ ok: false, exitCode: null, stdout, stderr: `${stderr}${e.message}` }));
    child.on("close", (code) => {
      const payload = {
        ok: code === 0,
        exitCode: code,
        command: `orch ${argv.join(" ")}`,
        cycles: readNewRuns(runsLog, offset, tool.match ? tool.match(args) : {}),
        logs: { runs: runsLog, reviewOutcomes: join(orchDir, "review-outcomes.jsonl") },
        stdout,
        stderr,
      };
      if (tool.parseStdout) {
        try { payload.status = JSON.parse(stdout); delete payload.stdout; } catch { /* keep raw stdout */ }
      }
      resolve(payload);
    });
  });
}

const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const toolResult = (id, value, isError = false) =>
  rpcResult(id, { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], isError });

// Returns the response object, or null when the message needs no reply
// (JSON-RPC notifications — anything with no `id` — must be answered with
// silence; a reply breaks strict clients, and `notifications/initialized` is the
// first thing both Hermes and Claude Code send).
export async function handle(msg, ctx) {
  const id = msg?.id;
  const isNotification = id === undefined || id === null;
  const method = msg?.method;

  if (method === "initialize") {
    const asked = msg.params?.protocolVersion;
    return rpcResult(id, {
      protocolVersion: typeof asked === "string" ? asked : DEFAULT_PROTOCOL_VERSION,
      // Without a `tools` capability a conformant client never calls tools/list.
      capabilities: { tools: {} },
      serverInfo: { name: "orch", version: VERSION },
    });
  }
  if (isNotification) return null;
  if (method === "ping") return rpcResult(id, {});
  if (method === "tools/list") {
    return rpcResult(id, {
      tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    });
  }
  if (method === "tools/call") {
    const tool = TOOLS.find((t) => t.name === msg.params?.name);
    if (!tool) return rpcError(id, -32602, `unknown tool: ${msg.params?.name}`);
    const args = msg.params?.arguments ?? {};
    if (typeof args !== "object" || Array.isArray(args)) return rpcError(id, -32602, "arguments must be an object");
    try {
      const result = await runTool(tool, args, ctx);
      // A failed orch run is a tool-level failure, not a protocol fault: report
      // it as a result with isError so the model can read the reason and retry.
      return toolResult(id, result, !result.ok);
    } catch (e) {
      return toolResult(id, { ok: false, error: e.message }, true);
    }
  }
  return rpcError(id, -32601, `unknown method: ${method}`);
}

// Reads newline-delimited JSON-RPC from `stdin`, writes responses to `stdout`.
// Resolves when stdin ends. Requests are dispatched without awaiting each other,
// so several cycles can be in flight at once; each response is keyed by its own
// id, and orch's existing per-cycle worktree isolation and concurrency cap keep
// the checkouts apart.
export function serve({ stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, repo = process.cwd(), spawnFn = spawn } = {}) {
  const ctx = { repo, spawnFn };
  const inflight = new Set();
  let buffer = "";
  const send = (res) => { if (res) stdout.write(`${JSON.stringify(res)}\n`); };

  const dispatch = (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return send(rpcError(null, -32700, "parse error")); }
    const p = handle(msg, ctx).then(send, (e) => {
      stderr.write(`orch mcp: ${e.message}\n`);
      if (msg?.id != null) send(rpcError(msg.id, -32603, e.message));
    });
    inflight.add(p);
    p.finally(() => inflight.delete(p));
  };

  stdin.setEncoding("utf8");
  return new Promise((resolve) => {
    stdin.on("data", (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) dispatch(line);
      }
    });
    stdin.on("end", () => resolve(Promise.all(inflight).then(() => undefined)));
    stdin.on("close", () => resolve(Promise.all(inflight).then(() => undefined)));
  });
}
