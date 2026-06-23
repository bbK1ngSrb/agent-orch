import claude from "./claude.js";
import codex from "./codex.js";

const REGISTRY = { claude, codex };

export function get(name) {
  const a = REGISTRY[name];
  if (!a) throw new Error(`unknown agent: ${name}`);
  return a;
}

export function bins() {
  return Object.fromEntries(Object.values(REGISTRY).map((a) => [a.name, a.name]));
}
