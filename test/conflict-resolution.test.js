import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveIntegrationConflict } from "../src/cli.js";

function tmp() { return mkdtempSync(join(tmpdir(), "orch-conflict-")); }

function makeDeps({ verdict = { decision: "AGREE", reason: "both intents preserved" }, firstAuthorThrows = false } = {}) {
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
      if (args[0] === "diff") return resolved ? "" : "src/tui/input.js\n";
      return "";
    },
    gitTry(args) {
      calls.push(["gitTry", ...args]);
      if (args[0] === "merge") {
        resolved = false;
        return { ok: false, out: "CONFLICT (content): Merge conflict in src/tui/input.js" };
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
  const deps = makeDeps({ firstAuthorThrows: true });
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
