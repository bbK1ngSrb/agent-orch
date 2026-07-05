import agy from "./agy.js";
import claude from "./claude.js";
import codex from "./codex.js";
import copilot from "./copilot.js";
import gemini from "./gemini.js";
import local from "./local.js";

const REGISTRY = { agy, claude, codex, copilot, gemini, ...local };

export function get(name) {
  const a = REGISTRY[name];
  if (!a) throw new Error(`unknown agent: ${name}`);
  return a;
}

export function bins() {
  return Object.fromEntries(Object.values(REGISTRY).map((a) => [a.name, a.name]));
}
