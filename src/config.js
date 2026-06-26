import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const DEFAULTS = {
  agents: ["claude", "codex"],
  author: null, // explicit fixed author; null = rotate through `agents`
  reviewer: null, // explicit fixed reviewer; pairs with `author`
  test: "auto",
  reviseCap: 3,
  merge: "ff-only",
  scope: { maxLines: 0, ignore: ["*.lock", "dist/**", "*.snap"] },
  github: { mergeMethod: "squash" }, // gh pr merge strategy for `orch pr <n> --merge`
  docs: {
    autoUpdate: false, // opt-in per repo; flip true in .orch/orch.yml
    prompt: "update documentation to reflect the latest merged changes",
    paths: ["*.md", "docs/**", "**/*.md"], // docs-only globs = loop guard
  },
};

function validate(cfg) {
  if (!Array.isArray(cfg.agents) || cfg.agents.length < 1)
    throw new Error("orch.yml: agents must be a non-empty list");
  if ((cfg.author == null) !== (cfg.reviewer == null))
    throw new Error("orch.yml: set both author and reviewer, or neither");
  if (!["ff-only", "no-ff"].includes(cfg.merge))
    throw new Error("orch.yml: merge must be ff-only or no-ff");
  if (!Number.isInteger(cfg.reviseCap) || cfg.reviseCap < 1)
    throw new Error("orch.yml: reviseCap must be a positive integer");
  if (!Number.isInteger(cfg.scope.maxLines) || cfg.scope.maxLines < 0)
    throw new Error("orch.yml: scope.maxLines must be a non-negative integer");
  if (!["squash", "merge", "rebase"].includes(cfg.github.mergeMethod))
    throw new Error("orch.yml: github.mergeMethod must be squash, merge, or rebase");
  if (typeof cfg.docs.autoUpdate !== "boolean")
    throw new Error("orch.yml: docs.autoUpdate must be a boolean");
  if (typeof cfg.docs.prompt !== "string" || !cfg.docs.prompt.trim())
    throw new Error("orch.yml: docs.prompt must be a non-empty string");
  if (!Array.isArray(cfg.docs.paths) || !cfg.docs.paths.every((p) => typeof p === "string"))
    throw new Error("orch.yml: docs.paths must be an array of strings");
}

// Config lives at .orch/orch.yml. Bare orch.yml at repo root still works (back-compat).
export function configPath(dir) {
  const preferred = join(dir, ".orch", "orch.yml");
  return existsSync(preferred) ? preferred : join(dir, "orch.yml");
}

export function load(dir) {
  let user = {};
  const p = configPath(dir);
  if (existsSync(p)) user = parse(readFileSync(p, "utf8")) || {};
  const cfg = {
    ...DEFAULTS,
    ...user,
    scope: { ...DEFAULTS.scope, ...(user.scope || {}) },
    github: { ...DEFAULTS.github, ...(user.github || {}) },
    docs: { ...DEFAULTS.docs, ...(user.docs || {}) },
  };
  validate(cfg);
  return cfg;
}

export { DEFAULTS };
