import claude from "./claude.js";
import codex from "./codex.js";
import local from "./local.js";

const REGISTRY = { claude, codex, ...local };

// Look up an adapter by config name; throws on an unknown agent.
export function get(name) {
  const a = REGISTRY[name];
  if (!a) throw new Error(`unknown agent: ${name}`);
  return a;
}

// Map of every registered agent name to its expected PATH binary.
export function bins() {
  return Object.fromEntries(Object.values(REGISTRY).map((a) => [a.name, a.name]));
}
