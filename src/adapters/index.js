import agy from "./agy.js";
import claude from "./claude.js";
import codex from "./codex.js";
import copilot from "./copilot.js";
import gemini from "./gemini.js";
import grok from "./grok.js";
import local from "./local.js";

const NATIVE = { agy, claude, codex, copilot, gemini, grok };
const REGISTRY = { ...NATIVE, ...local };

// Native per-CLI adapters (one bin per name), as opposed to ccr-routed local
// models. Single source of truth so `orch init` detection (src/detect.js) and
// the scaffold "Built-in:" doc comment can't silently drift when an adapter is
// added — a new adapter here is probed and doc-checked automatically.
export const nativeAgents = Object.keys(NATIVE);

export function get(name) {
  const a = REGISTRY[name];
  if (!a) throw new Error(`unknown agent: ${name}`);
  return a;
}
