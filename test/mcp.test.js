import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TOOLS, handle, serve, DEFAULT_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "../src/mcp.js";

const ORCH_BIN = fileURLToPath(new URL("../bin/orch.js", import.meta.url));

// A stand-in child process: records the argv it was spawned with, then closes
// with the supplied exit code. `onSpawn` can write runs.jsonl first, so a tool
// call sees exactly the records a real cycle would have appended.
function fakeSpawn({ code = 0, stdout = "", stderr = "", onSpawn = () => {}, pid = 4242 } = {}) {
  const calls = [];
  const fn = (bin, argv, opts) => {
    calls.push({ bin, argv, opts });
    const child = new EventEmitter();
    child.pid = pid;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      onSpawn(argv);
      if (stdout) child.stdout.emit("data", stdout);
      if (stderr) child.stderr.emit("data", stderr);
      child.emit("close", code);
    });
    return child;
  };
  fn.calls = calls;
  return fn;
}

const call = (id, name, args) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
const payload = (res) => JSON.parse(res.result.content[0].text);

test("initialize negotiates a version this server actually supports", async () => {
  // An older but supported version is honoured, so an older client keeps working.
  const res = await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }, {});
  assert.equal(res.id, 1);
  assert.equal(res.result.protocolVersion, "2024-11-05");
  // Without this a conformant client never goes on to tools/list.
  assert.deepEqual(res.result.capabilities.tools, {});
  assert.equal(res.result.serverInfo.name, "orch");

  const bare = await handle({ jsonrpc: "2.0", id: 2, method: "initialize" }, {});
  assert.equal(bare.result.protocolVersion, DEFAULT_PROTOCOL_VERSION);

  // An unsupported or malformed version must not be echoed back: that would
  // claim conformance to a protocol this server has never seen. The lifecycle
  // spec says answer with the latest version we do support and let the client
  // decide whether to continue.
  for (const asked of ["2099-01-01", "", 5, null, { v: 1 }]) {
    const out = await handle({ jsonrpc: "2.0", id: 3, method: "initialize", params: { protocolVersion: asked } }, {});
    assert.equal(out.result.protocolVersion, DEFAULT_PROTOCOL_VERSION, `asked ${JSON.stringify(asked)}`);
  }
  assert.ok(SUPPORTED_PROTOCOL_VERSIONS.includes("2025-06-18"));
});

test("notifications get no response at all", async () => {
  // `notifications/initialized` is the first thing both Hermes and Claude Code
  // send; answering a message that has no id breaks strict clients.
  assert.equal(await handle({ jsonrpc: "2.0", method: "notifications/initialized" }, {}), null);
  assert.equal(await handle({ jsonrpc: "2.0", method: "some/unknown/notification" }, {}), null);
  // `initialize` is a request, so a notification-shaped one is malformed — it
  // still gets silence, not a response addressed to no id.
  assert.equal(await handle({ jsonrpc: "2.0", method: "initialize", params: { protocolVersion: "2025-06-18" } }, {}), null);
});

test("tools/list exposes every tool with a name, description and schema", async () => {
  const res = await handle({ jsonrpc: "2.0", id: 3, method: "tools/list" }, {});
  const names = res.result.tools.map((t) => t.name);
  assert.deepEqual(names, ["orch_status", "orch_plan", "orch_task", "orch_issue", "orch_review", "orch_continue"]);
  for (const tool of res.result.tools) {
    assert.ok(tool.description, `${tool.name} has no description`);
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(Object.keys(tool).length, 3); // no internals leak into the wire schema
  }
});

test("an unknown method is a protocol error, an unknown tool is an invalid-params error", async () => {
  assert.equal((await handle({ jsonrpc: "2.0", id: 4, method: "nope" }, {})).error.code, -32601);
  const res = await handle(call(5, "orch_shell", {}), {});
  assert.equal(res.error.code, -32602);
});

test("no tool can merge into main: --merge and `pr` are unreachable", async () => {
  // orch's ONLY PR-merge path is `orch pr <n> --merge`. Foreign repos therefore
  // get the conservative default (human merges) by construction, not by policy
  // code: no argv builder can produce either token, for any input.
  const probes = [
    { task: "--merge" }, { task: "pr 1 --merge" }, { branch: "merge" }, { sid: "merge" },
    { number: 1 }, { limit: 1 }, {},
  ];
  for (const tool of TOOLS) {
    assert.ok(!TOOLS.some((t) => t.name === "orch_pr"), "orch pr must not be exposed");
    for (const probe of probes) {
      let argv;
      try { argv = tool.argv(probe); } catch { continue; } // rejected input can't reach the child
      assert.ok(!argv.includes("--merge"), `${tool.name} produced --merge`);
      assert.notEqual(argv[0], "pr", `${tool.name} produced an 'orch pr' invocation`);
    }
  }
});

test("free text cannot smuggle flags into the child's argv", async () => {
  const spawnFn = fakeSpawn();
  const res = await handle(call(6, "orch_task", { task: "--allow-protected" }), { repo: "/tmp", spawnFn });
  assert.equal(res.result.isError, true);
  assert.match(payload(res).error, /must not start with '-'/);
  assert.equal(spawnFn.calls.length, 0, "invalid arguments must never reach a child process");

  // Legitimate text with an embedded dash still runs, and lands after `--` so
  // the child's parser reads it as a positional.
  const ok = fakeSpawn();
  await handle(call(7, "orch_task", { task: "fix the --dry flag" }), { repo: "/tmp", spawnFn: ok });
  assert.deepEqual(ok.calls[0].argv, [ORCH_BIN, "task", "--", "fix the --dry flag"]);
  assert.equal(ok.calls[0].opts.shell, false);
  assert.equal(ok.calls[0].bin, process.execPath);
});

test("argument validation rejects bad branches, sids and issue numbers", async () => {
  const spawnFn = fakeSpawn();
  const ctx = { repo: "/tmp", spawnFn };
  const bad = [
    ["orch_review", { branch: "feat/x;rm -rf /" }],
    ["orch_review", {}],
    ["orch_continue", { sid: "a b" }],
    ["orch_issue", { number: 0 }],
    ["orch_issue", { number: "12x" }],
    ["orch_status", { limit: -1 }],
  ];
  for (const [name, args] of bad) {
    const res = await handle(call(8, name, args), ctx);
    assert.equal(res.result.isError, true, `${name} ${JSON.stringify(args)} should be rejected`);
  }
  assert.equal(spawnFn.calls.length, 0);

  // A string issue number is accepted and normalized — models emit both.
  const ok = fakeSpawn();
  await handle(call(9, "orch_issue", { number: "42" }), { repo: "/tmp", spawnFn: ok });
  assert.deepEqual(ok.calls[0].argv, [ORCH_BIN, "issue", "42"]);
});

test("orch_status returns the dashboard's parsed JSON", async () => {
  const snapshot = { live: [], history: [{ sid: "abc", branch: "orch/claude/x" }] };
  const spawnFn = fakeSpawn({ stdout: JSON.stringify(snapshot) });
  const res = await handle(call(10, "orch_status", { limit: 5 }), { repo: "/tmp", spawnFn });
  assert.deepEqual(spawnFn.calls[0].argv, [ORCH_BIN, "dashboard", "--json", "--once", "--limit", "5"]);
  assert.deepEqual(payload(res).status, snapshot);
  assert.equal(res.result.isError, false);
});

test("a cycle reports id, branch, status, reason, PR url and log paths", async () => {
  const repo = mkdtempSync(join(tmpdir(), "orch-mcp-"));
  const runs = join(repo, ".orch", "runs.jsonl");
  const record = (entry) => appendFileSync(runs, JSON.stringify(entry) + "\n");
  mkdirSync(join(repo, ".orch"), { recursive: true });
  record({ ts: "t0", sid: "old", branch: "orch/claude/old", verdict: "merged" }); // pre-existing: not this call's

  // A real sid is `<pid>-<counter>` (src/sid.js) and the pid is the child's.
  const spawnFn = fakeSpawn({
    pid: 777,
    onSpawn: () => record({
      ts: "t1", sid: "777-a", branch: "orch/claude/new", verdict: "merged",
      reason: "agreed", rounds: 2, prUrl: "https://example.invalid/pr/7", closes: 42,
    }),
  });
  const res = await handle(call(11, "orch_issue", { number: 42 }), { repo, spawnFn });
  const out = payload(res);
  assert.equal(out.ok, true);
  assert.deepEqual(out.cycles, [{
    sid: "777-a", branch: "orch/claude/new", status: "merged", reason: "agreed",
    prUrl: "https://example.invalid/pr/7", closes: 42, rounds: 2,
  }]);
  assert.equal(out.logs.runs, runs);
});

test("a concurrent cycle's run record is not attributed to this call", async () => {
  // runs.jsonl is repo-wide, so the tail written while one call ran can hold a
  // peer's record too. Tools that know their target filter the tail by it.
  const repo = mkdtempSync(join(tmpdir(), "orch-mcp-"));
  mkdirSync(join(repo, ".orch"), { recursive: true });
  const runs = join(repo, ".orch", "runs.jsonl");
  const spawnFn = fakeSpawn({
    onSpawn: () => {
      appendFileSync(runs, JSON.stringify({ sid: "peer", branch: "orch/codex/other", verdict: "merged" }) + "\n");
      appendFileSync(runs, JSON.stringify({ sid: "mine", branch: "orch/claude/mine", verdict: "escalated", reason: "stalemate" }) + "\n");
    },
  });
  const res = await handle(call(12, "orch_review", { branch: "orch/claude/mine" }), { repo, spawnFn });
  const out = payload(res);
  assert.equal(out.cycles.length, 1);
  assert.equal(out.cycles[0].sid, "mine");
  assert.equal(out.cycles[0].status, "escalated");
});

test("orch_task reports only the cycle its own child started", async () => {
  // orch_task has no target to match on, so it correlates on the sid's pid
  // prefix. A peer cycle running in another process writes into the same tail
  // and must not be reported as this call's result.
  const repo = mkdtempSync(join(tmpdir(), "orch-mcp-"));
  mkdirSync(join(repo, ".orch"), { recursive: true });
  const runs = join(repo, ".orch", "runs.jsonl");
  const spawnFn = fakeSpawn({
    pid: 1234,
    onSpawn: () => {
      appendFileSync(runs, JSON.stringify({ sid: "99-b", branch: "orch/codex/peer", verdict: "merged" }) + "\n");
      appendFileSync(runs, JSON.stringify({ sid: "1234-b", branch: "orch/claude/mine", verdict: "merged" }) + "\n");
      // A pid that merely shares a prefix is a different process.
      appendFileSync(runs, JSON.stringify({ sid: "12345-c", branch: "orch/codex/other", verdict: "merged" }) + "\n");
    },
  });
  const out = payload(await handle(call(14, "orch_task", { task: "do a thing" }), { repo, spawnFn }));
  assert.deepEqual(out.cycles.map((c) => c.branch), ["orch/claude/mine"]);
});

test("a malformed run record is skipped instead of killing the server", async () => {
  // `JSON.parse` returns `null`, a number or an array for these perfectly valid
  // JSON lines. readNewRuns runs inside a `close` listener, so a throw here would
  // be an uncaught exception: the whole MCP server dies and the call never
  // resolves. The good record still has to come back.
  const repo = mkdtempSync(join(tmpdir(), "orch-mcp-"));
  mkdirSync(join(repo, ".orch"), { recursive: true });
  const runs = join(repo, ".orch", "runs.jsonl");
  const spawnFn = fakeSpawn({
    pid: 55,
    onSpawn: () => {
      for (const line of ["null", "123", '"text"', "[1,2]", "{not json"]) appendFileSync(runs, line + "\n");
      appendFileSync(runs, JSON.stringify({ sid: "55-a", branch: "orch/claude/ok", verdict: "merged" }) + "\n");
    },
  });
  const out = payload(await handle(call(15, "orch_task", { task: "do a thing" }), { repo, spawnFn }));
  assert.deepEqual(out.cycles.map((c) => c.sid), ["55-a"]);
});

test("a failed orch run is a tool error, not a protocol error", async () => {
  const spawnFn = fakeSpawn({ code: 2, stderr: "orch: escalated\n" });
  const res = await handle(call(13, "orch_task", { task: "do a thing" }), { repo: "/tmp", spawnFn });
  assert.equal(res.error, undefined); // JSON-RPC layer stays healthy
  assert.equal(res.result.isError, true);
  const out = payload(res);
  assert.equal(out.ok, false);
  assert.equal(out.exitCode, 2);
  assert.match(out.stderr, /escalated/);
});

test("a spawn failure is reported instead of crashing the server", async () => {
  const spawnFn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => child.emit("error", new Error("ENOENT")));
    return child;
  };
  const out = payload(await handle(call(14, "orch_plan", { task: "x" }), { repo: "/tmp", spawnFn }));
  assert.equal(out.ok, false);
  assert.match(out.stderr, /ENOENT/);
});

test("serve frames responses per line and answers concurrent calls by id", async () => {
  const stdin = new EventEmitter();
  stdin.setEncoding = () => {};
  const lines = [];
  const stdout = { write: (s) => lines.push(s) };
  const stderr = { write: () => {} };

  // Two in-flight calls that finish out of order: the slow one is requested
  // first. Each response must still carry its own request's id.
  const spawnFn = (bin, argv) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const delay = argv.includes("slow") ? 30 : 1;
    setTimeout(() => child.emit("close", 0), delay);
    return child;
  };
  const done = serve({ stdin, stdout, stderr, repo: "/tmp", spawnFn });

  stdin.emit("data",
    JSON.stringify(call(100, "orch_task", { task: "slow" })) + "\n" +
    JSON.stringify(call(101, "orch_task", { task: "quick" })) + "\n");
  // A frame split across two chunks must still parse as one message.
  const split = JSON.stringify({ jsonrpc: "2.0", id: 102, method: "tools/list" }) + "\n";
  stdin.emit("data", split.slice(0, 12));
  stdin.emit("data", split.slice(12));
  stdin.emit("data", "{not json}\n");
  stdin.emit("end");
  await done;

  const parsed = lines.map((l) => {
    assert.ok(l.endsWith("\n"), "every frame ends with a newline");
    assert.equal(l.trim().split("\n").length, 1, "one JSON object per line");
    return JSON.parse(l);
  });
  const byId = new Map(parsed.filter((r) => r.id != null).map((r) => [r.id, r]));
  assert.equal(byId.get(101).result.isError, false);
  assert.equal(byId.get(100).result.isError, false);
  assert.ok(byId.get(102).result.tools.length);
  // The quick call answered before the slow one it was queued behind.
  assert.ok(parsed.findIndex((r) => r.id === 101) < parsed.findIndex((r) => r.id === 100));
  assert.equal(parsed.find((r) => r.error?.code === -32700)?.id, null);
});

test("`orch mcp` speaks the protocol over real stdio with a clean stdout", async () => {
  // End-to-end through the shipped bin. No update-check suppression on purpose:
  // this is what proves the early dispatch keeps banners and notices off the
  // protocol stream. Anything but pure JSON-RPC on stdout fails the parse below.
  const child = spawn(process.execPath, [ORCH_BIN, "mcp"], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d) => { out += d; });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }) + "\n");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
  child.stdin.end();
  const code = await new Promise((resolve) => child.on("close", resolve));

  assert.equal(code, 0);
  const frames = out.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(frames.length, 2, `expected exactly two frames, got: ${out}`);
  assert.deepEqual(frames[0].result.capabilities.tools, {});
  assert.ok(frames[1].result.tools.some((t) => t.name === "orch_status"));
});
