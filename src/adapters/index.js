import agy from "./agy.js";
import claude from "./claude.js";
import codex from "./codex.js";
import copilot from "./copilot.js";
import gemini from "./gemini.js";
import grok from "./grok.js";
import kimi from "./kimi.js";
import zai from "./zai.js";
import local from "./local.js";

const NATIVE = { agy, claude, codex, copilot, gemini, grok, kimi, zai };
const REGISTRY = { ...NATIVE, ...local };

// Native per-CLI adapters (one bin per name), as opposed to ccr-routed local
// models. Single source of truth so `orch init` detection (src/detect.js) and
// the scaffold "Built-in:" doc comment can't silently drift when an adapter is
// added — a new adapter here is probed and doc-checked automatically.
export const nativeAgents = Object.keys(NATIVE);

// Every name orch's code has an adapter for, native or local-routed — the
// answer to "does `agent add <name>` have anything to build", known without
// touching a repo's orch.yml (that answers "is it in THIS repo's agents:
// list", a different question — see cli.js's agent-add handler).
export const agentNames = Object.keys(REGISTRY);

export function get(name) {
  const a = REGISTRY[name];
  if (!a) throw new Error(`unknown agent: ${name}`);
  return a;
}
