import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const DEFAULTS = {
  agents: ["claude", "codex"],
  test: "auto",
  reviseCap: 3,
  merge: "ff-only",
  scope: { maxLines: 0, ignore: ["*.lock", "dist/**", "*.snap"] },
};

function validate(cfg) {
  if (!Array.isArray(cfg.agents) || cfg.agents.length < 1)
    throw new Error("orch.yml: agents must be a non-empty list");
  if (!["ff-only", "no-ff"].includes(cfg.merge))
    throw new Error("orch.yml: merge must be ff-only or no-ff");
  if (!Number.isInteger(cfg.reviseCap) || cfg.reviseCap < 1)
    throw new Error("orch.yml: reviseCap must be a positive integer");
  if (!Number.isInteger(cfg.scope.maxLines) || cfg.scope.maxLines < 0)
    throw new Error("orch.yml: scope.maxLines must be a non-negative integer");
}

export function load(dir) {
  let user = {};
  const p = join(dir, "orch.yml");
  if (existsSync(p)) user = parse(readFileSync(p, "utf8")) || {};
  const cfg = {
    ...DEFAULTS,
    ...user,
    scope: { ...DEFAULTS.scope, ...(user.scope || {}) },
  };
  validate(cfg);
  return cfg;
}

export { DEFAULTS };
