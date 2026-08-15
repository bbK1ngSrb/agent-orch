import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAgentBin as resolveBin } from "../src/agent-bin.js";
import { detectAgents, formatDetection } from "../src/detect.js";
import { get, nativeAgents } from "../src/adapters/index.js";

function resolve(found) {
  return (exe) => found.includes(exe) ? exe : null;
}

// zai's `disabled` reads process.env on every access, so tests that care about
// it have to own the variable rather than inherit the runner's environment.
function withZaiKey(value, fn) {
  const prev = process.env.ZAI_API_KEY;
  if (value === undefined) delete process.env.ZAI_API_KEY;
  else process.env.ZAI_API_KEY = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.ZAI_API_KEY;
    else process.env.ZAI_API_KEY = prev;
  }
}

test("detectAgents: reports CLI agents found by the shared resolver", () => {
  // Derive from the registry so this can't drift when a native adapter is added.
  const runnable = withZaiKey("k", () => nativeAgents.filter((n) => !get(n).disabled));
  const { found, missing } = withZaiKey("k", () => detectAgents({ resolveAgentBin: resolve(nativeAgents) }));
  assert.deepEqual(found, runnable);
  assert.ok(missing.includes("local (ccr CLI not found: PATH + fallback dirs)"));
  // Nothing else is missing: every native agent is either runnable or disabled.
  assert.equal(missing.length, nativeAgents.length - runnable.length + 1);
});

test("detectAgents: resolves native adapters by their configured executable", () => {
  const { found, missing } = withZaiKey("k", () => detectAgents({
    resolveAgentBin: (exe) => exe === "claude" ? exe : null,
  }));
  assert.ok(found.includes("zai"));
  assert.ok(!missing.some((entry) => entry.startsWith("zai ")));
});

test("detectAgents: a disabled adapter is not detected even when its CLI resolves", () => {
  const { found, missing } = withZaiKey(undefined, () => detectAgents({
    resolveAgentBin: (exe) => exe === "claude" ? exe : null,
  }));
  assert.ok(!found.includes("zai"));
  assert.ok(missing.includes("zai (disabled: ZAI_API_KEY is not set)"));
  assert.ok(found.includes("claude")); // same bin, not disabled — still detected
});

test("detectAgents: an always-disabled adapter stays out of found and keeps the summary one line", () => {
  const detection = detectAgents({ resolveAgentBin: resolve(["agy"]) });
  assert.ok(!detection.found.includes("agy"));
  assert.ok(detection.missing.some((m) => m.startsWith("agy (disabled: agy cannot be used")));
  assert.ok(!formatDetection(detection).includes("\n"));
});

test("detectAgents: reports a missing CLI agent by name", () => {
  const { found, missing } = withZaiKey("k", () => detectAgents({ resolveAgentBin: resolve(["claude"]) }));
  assert.deepEqual(found, ["claude", "zai"]);
  assert.ok(missing.includes("codex (CLI not found: PATH + fallback dirs)"));
  assert.ok(missing.includes("copilot (CLI not found: PATH + fallback dirs)"));
  assert.ok(missing.includes("gemini (CLI not found: PATH + fallback dirs)"));
});

test("detectAgents: uses fallback dirs when PATH misses a CLI", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-detect-bin-"));
  const p = join(d, "claude");
  writeFileSync(p, "#!/bin/sh\n");
  chmodSync(p, 0o755);
  const { found, missing } = detectAgents({
    resolveAgentBin(exe) {
      return resolveBin(exe, [d], "");
    },
  });
  assert.ok(found.includes("claude"));
  assert.ok(!missing.some((m) => m.startsWith("claude ")));
});

test("detectAgents: reads local models from ccr's router config when ccr is on PATH", () => {
  const { found, missing } = detectAgents({
    resolveAgentBin: resolve(["ccr"]),
    readFile: () => JSON.stringify({ Providers: [{ name: "local", models: ["glm-4.5-air"] }] }),
  });
  assert.ok(found.includes("glm-4.5-air")); // bare name — what `orch agent add` accepts
  assert.ok(missing.includes("claude (CLI not found: PATH + fallback dirs)"));
});

test("detectAgents: filters configured models to those registered as local adapters", () => {
  const { found, missing } = detectAgents({
    resolveAgentBin: resolve(["ccr"]),
    readFile: () => JSON.stringify({ Providers: [{ name: "local", models: ["glm-4.5-air", "unsupported-model"] }] }),
  });
  assert.ok(found.includes("glm-4.5-air"));
  assert.ok(!found.includes("unsupported-model"));
  assert.ok(missing.some((m) => m.startsWith("unsupported-model (configured in ccr but not a registered local model)")));
});

test("detectAgents: ccr on PATH but no local provider configured reports missing", () => {
  const { missing } = detectAgents({
    resolveAgentBin: resolve(["ccr"]),
    readFile: () => JSON.stringify({ Providers: [] }),
  });
  assert.ok(missing.some((m) => m.startsWith("local (no models configured")));
});

test("detectAgents: ccr on PATH but config unreadable reports missing", () => {
  const { missing } = detectAgents({
    resolveAgentBin: resolve(["ccr"]),
    readFile: () => { throw new Error("ENOENT"); },
    exists: () => false,
  });
  assert.ok(missing.some((m) => m.startsWith("local (no ~/.claude-code-router/config.json)")));
});

test("detectAgents: ccr on PATH with sqlite config reports it's configured but unreadable", () => {
  const { missing } = detectAgents({
    resolveAgentBin: resolve(["ccr"]),
    readFile: () => { throw new Error("ENOENT"); },
    exists: (path) => path.endsWith("config.sqlite"),
  });
  assert.ok(missing.some((m) => m.startsWith("local (configured via ~/.claude-code-router/config.sqlite")));
  assert.ok(missing.some((m) => m.includes("ccr start")));
});

test("formatDetection: joins found and missing into a summary line", () => {
  const line = formatDetection({ found: ["claude", "glm-4.5-air"], missing: ["codex (CLI not found: PATH + fallback dirs)"] });
  assert.equal(line, "detected: claude, glm-4.5-air — not found: codex (CLI not found: PATH + fallback dirs)");
});

test("formatDetection: no agents found still prints a valid summary", () => {
  const line = formatDetection({ found: [], missing: ["claude (CLI not found: PATH + fallback dirs)", "codex (CLI not found: PATH + fallback dirs)"] });
  assert.equal(line, "detected: none — not found: claude (CLI not found: PATH + fallback dirs), codex (CLI not found: PATH + fallback dirs)");
});
