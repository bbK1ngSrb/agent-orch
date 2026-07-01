import test from "node:test";
import assert from "node:assert/strict";
import { detectAgents, formatDetection } from "../src/detect.js";

function which(found) {
  return (exe) => { if (!found.includes(exe)) throw new Error(`not found: ${exe}`); };
}

test("detectAgents: reports CLI agents found on PATH", () => {
  const { found, missing } = detectAgents({ which: which(["claude", "codex"]) });
  assert.deepEqual(found, ["claude", "codex"]);
  assert.deepEqual(missing, ["local (ccr not on PATH)"]);
});

test("detectAgents: reports a missing CLI agent by name", () => {
  const { found, missing } = detectAgents({ which: which(["claude"]) });
  assert.deepEqual(found, ["claude"]);
  assert.ok(missing.includes("codex (no CLI on PATH)"));
});

test("detectAgents: reads local models from ccr's router config when ccr is on PATH", () => {
  const { found, missing } = detectAgents({
    which: which(["ccr"]),
    readFile: () => JSON.stringify({ Providers: [{ name: "local", models: ["glm-4.5-air"] }] }),
  });
  assert.ok(found.includes("glm-4.5-air")); // bare name — what `orch agent add` accepts
  assert.ok(missing.includes("claude (no CLI on PATH)"));
});

test("detectAgents: ccr on PATH but no local provider configured reports missing", () => {
  const { missing } = detectAgents({
    which: which(["ccr"]),
    readFile: () => JSON.stringify({ Providers: [] }),
  });
  assert.ok(missing.some((m) => m.startsWith("local (no models configured")));
});

test("detectAgents: ccr on PATH but config unreadable reports missing", () => {
  const { missing } = detectAgents({
    which: which(["ccr"]),
    readFile: () => { throw new Error("ENOENT"); },
  });
  assert.ok(missing.some((m) => m.startsWith("local (no ~/.claude-code-router/config.json)")));
});

test("formatDetection: joins found and missing into a summary line", () => {
  const line = formatDetection({ found: ["claude", "glm-4.5-air"], missing: ["codex (no CLI on PATH)"] });
  assert.equal(line, "detected: claude, glm-4.5-air — not found: codex (no CLI on PATH)");
});

test("formatDetection: no agents found still prints a valid summary", () => {
  const line = formatDetection({ found: [], missing: ["claude (no CLI on PATH)", "codex (no CLI on PATH)"] });
  assert.equal(line, "detected: none — not found: claude (no CLI on PATH), codex (no CLI on PATH)");
});
