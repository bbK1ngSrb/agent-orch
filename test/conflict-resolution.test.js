import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveIntegrationConflict } from "../src/cli.js";

function tmp() { return mkdtempSync(join(tmpdir(), "orch-conflict-")); }

function makeDeps({ verdict = { decision: "AGREE", reason: "both intents preserved" }, firstAuthorThrows = false, conflictPath = "src/tui/input.js" } = {}) {
  const calls = [];
  let resolved = false;
  let authorCalls = 0;
  const adapters = {
    get(agent) {
      return {
        async author(prompt, wd, opts) {
          calls.push(["author", agent, prompt, wd, opts]);
          authorCalls++;
          if (firstAuthorThrows && authorCalls === 1) throw new Error("stalled");
          resolved = true;
        },
        async audit(branch, wd, opts) {
          calls.push(["audit", agent, branch, wd, opts]);
          return verdict;
        },
      };
    },
  };
  const git = {
    ensureIntegrationWorktree() { calls.push(["ensure"]); return "/integration"; },
    syncWorktreeToIntegration() { calls.push(["sync"]); },
    fetchOriginMain() { calls.push(["fetch"]); return { ok: true }; },
    git(args) {
      calls.push(["git", ...args]);
      if (args[0] === "rev-parse" && args[1] === "HEAD") return "pre";
      // Match production -z listing: NUL-separated paths (no newline split).
      if (args[0] === "diff") return resolved ? "" : `${conflictPath}\0`;
      return "";
    },
    gitTry(args) {
      calls.push(["gitTry", ...args]);
      if (args[0] === "merge") {
        resolved = false;
        return { ok: false, out: `CONFLICT (content): Merge conflict in ${conflictPath}` };
      }
      if (args[0] === "rev-parse") return { ok: true, out: "" };
      return { ok: true, out: "" };
    },
  };
  const gate = {
    run(cmd, wd) {
      calls.push(["gate", cmd, wd]);
      return { pass: true, log: "" };
    },
  };
  return { adapters, git, gate, calls };
}

function cfg(overrides = {}) {
  return {
    agents: ["claude", "codex"],
    reviewers: null,
    stageTimeout: 1,
    main: {
      conflictResolution: "auto",
      autoResolveConflicts: true,
      conflictResolutionResolvers: [
        { agent: "claude", model: null, effort: null },
        { agent: "codex", model: null, effort: null },
      ],
      autoResolveConflictPaths: ["CHANGELOG.md"],
      ...overrides,
    },
  };
}

test("code conflict resolution is rejected when cross-audit catches a green-but-wrong merge", async () => {
  const deps = makeDeps({ verdict: { decision: "DISAGREE", reason: "footer dropped the help hint from main" } });
  const result = await resolveIntegrationConflict({
    repo: "/repo",
    orchDir: tmp(),
    cfg: cfg(),
    branch: "orch/integration",
    base: "main",
    testCmd: "npm test",
  }, deps);

  assert.equal(result.ok, false);
  assert.match(result.reason, /demoted to propose/);
  assert.match(result.comment, /footer dropped the help hint/);
  assert.ok(deps.calls.some((c) => c[0] === "audit" && c[1] === "codex"), "reviewer must differ from resolver");
  assert.ok(!deps.calls.some((c) => c[0] === "gate"), "green tests are not trusted without reviewer agreement");
  assert.ok(!deps.calls.some((c) => c[0] === "git" && c[1] === "push"), "rejected resolution must not push");
});

test("resolver failover starts the next resolver from a reset merge attempt", async () => {
  const deps = makeDeps({ firstAuthorThrows: true, conflictPath: "CHANGELOG.md" });
  const result = await resolveIntegrationConflict({
    repo: "/repo",
    orchDir: tmp(),
    cfg: cfg(),
    branch: "orch/integration",
    base: "main",
    testCmd: "npm test",
  }, deps);

  assert.equal(result.ok, true);
  assert.deepEqual(deps.calls.filter((c) => c[0] === "author").map((c) => c[1]), ["claude", "codex"]);
  const resets = deps.calls.filter((c) => c[0] === "gitTry" && c[1] === "reset");
  assert.ok(resets.length >= 2, "each resolver attempt starts after a clean reset");
  assert.ok(deps.calls.some((c) => c[0] === "git" && c[1] === "push" && c[3] === "orch/integration"));
});

test("auto conflict resolution proposes non-whitelisted conflicts instead of pushing", async () => {
  const deps = makeDeps();
  const result = await resolveIntegrationConflict({
    repo: "/repo",
    orchDir: tmp(),
    cfg: cfg(),
    branch: "orch/integration",
    base: "main",
    testCmd: "npm test",
  }, deps);

  assert.equal(result.ok, false);
  assert.match(result.reason, /proposed for human approval/);
  assert.match(result.comment, /Mode: propose/);
  assert.ok(deps.calls.some((c) => c[0] === "audit" && c[1] === "codex"));
  assert.ok(!deps.calls.some((c) => c[0] === "git" && c[1] === "push"), "auto must not push non-whitelisted conflicts");
});

test("metadata-only auto resolution can run with a single resolver and no reviewer", async () => {
  const deps = makeDeps({ conflictPath: "CHANGELOG.md" });
  const singleAgentCfg = cfg({
    conflictResolutionResolvers: [{ agent: "claude", model: null, effort: null }],
  });
  singleAgentCfg.agents = ["claude"];
  const result = await resolveIntegrationConflict({
    repo: "/repo",
    orchDir: tmp(),
    cfg: singleAgentCfg,
    branch: "orch/integration",
    base: "main",
    testCmd: "npm test",
  }, deps);

  assert.equal(result.ok, true);
  assert.ok(deps.calls.some((c) => c[0] === "author" && c[1] === "claude"));
  assert.ok(!deps.calls.some((c) => c[0] === "audit"), "metadata-only single-agent path does not require a reviewer");
  assert.ok(deps.calls.some((c) => c[0] === "git" && c[1] === "push" && c[3] === "orch/integration"));
});

// Crafted unmerged path = allowed paths joined by newline. Without -z, splitting
// on \n would make metaOnly true and skip the reviewer; with -z the single path
// is not in the whitelist, so a reviewer is required.
test("newline-joined allowed paths do not count as metadata-only (require reviewer)", async () => {
  const forged = "CHANGELOG.md\npackage.json";
  const deps = makeDeps({ conflictPath: forged });
  const singleAgentCfg = cfg({
    conflictResolutionResolvers: [{ agent: "claude", model: null, effort: null }],
    autoResolveConflictPaths: ["CHANGELOG.md", "package.json"],
  });
  singleAgentCfg.agents = ["claude"];
  const result = await resolveIntegrationConflict({
    repo: "/repo",
    orchDir: tmp(),
    cfg: singleAgentCfg,
    branch: "orch/integration",
    base: "main",
    testCmd: "npm test",
  }, deps);

  assert.equal(result.ok, false);
  assert.match(result.reason, /no conflict reviewer configured/);
  assert.ok(!deps.calls.some((c) => c[0] === "author"), "must not auto-resolve before requiring a reviewer");
  assert.ok(!deps.calls.some((c) => c[0] === "git" && c[1] === "push"));
  // Production listing must pass -z so NUL-split keeps the forged path whole.
  assert.ok(
    deps.calls.some((c) => c[0] === "git" && c[1] === "diff" && c.includes("-z") && c.includes("--diff-filter=U")),
    "unmerged listing must use -z",
  );
});
