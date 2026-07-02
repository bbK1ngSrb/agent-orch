import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const DEFAULTS = {
  agents: ["claude", "codex"],
  author: null, // explicit fixed author; null = rotate through `agents`
  reviewer: null, // explicit fixed reviewer; pairs with `author`
  authors: null, // plural fixed authors; pairs with `reviewers`
  reviewers: null, // plural fixed reviewers; pairs with `authors`
  test: "auto",
  reviseCap: 3,
  stageTimeout: 25, // #56: per-stage wall-clock cap in MINUTES; 0 disables. A stalled
                    // codex/claude stage is killed and the cycle fails (nonzero exit)
                    // instead of hanging forever on an infinite "still running" heartbeat.
  merge: "no-ff", // ff-only | no-ff | pr — "pr" opts out of direct-to-main: an AGREE+green
                  // cycle opens a PR (github.openPr) instead of git.mergeInWorktree
  concurrency: 4, // max concurrent cycles per repo dir; over this, a cycle exits rather than blocks
  scope: { maxLines: 0, ignore: ["*.lock", "dist/**", "*.snap"] },
  github: {
    mergeMethod: "squash", // gh pr merge strategy for `orch pr <n> --merge` and merge: pr's auto-merge
    autoMergePr: false, // when merge: pr, also enable GitHub auto-merge on the PR it opens
  },
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
  if ((cfg.authors == null) !== (cfg.reviewers == null))
    throw new Error("orch.yml: set both authors and reviewers, or neither");
  if (cfg.authors != null && (!Array.isArray(cfg.authors) || cfg.authors.length < 1 || !cfg.authors.every((a) => typeof a === "string" && a.trim())))
    throw new Error("orch.yml: authors must be a non-empty list of strings");
  if (cfg.reviewers != null && (!Array.isArray(cfg.reviewers) || cfg.reviewers.length < 1 || !cfg.reviewers.every((r) => typeof r === "string" && r.trim())))
    throw new Error("orch.yml: reviewers must be a non-empty list of strings");
  if (!["ff-only", "no-ff", "pr"].includes(cfg.merge))
    throw new Error("orch.yml: merge must be ff-only, no-ff, or pr");
  if (!Number.isInteger(cfg.reviseCap) || cfg.reviseCap < 1)
    throw new Error("orch.yml: reviseCap must be a positive integer");
  if (!Number.isInteger(cfg.stageTimeout) || cfg.stageTimeout < 0)
    throw new Error("orch.yml: stageTimeout must be a non-negative integer (minutes; 0 disables)");
  if (!Number.isInteger(cfg.concurrency) || cfg.concurrency < 1)
    throw new Error("orch.yml: concurrency must be a positive integer");
  if (!Number.isInteger(cfg.scope.maxLines) || cfg.scope.maxLines < 0)
    throw new Error("orch.yml: scope.maxLines must be a non-negative integer");
  if (!["squash", "merge", "rebase"].includes(cfg.github.mergeMethod))
    throw new Error("orch.yml: github.mergeMethod must be squash, merge, or rebase");
  if (typeof cfg.github.autoMergePr !== "boolean")
    throw new Error("orch.yml: github.autoMergePr must be a boolean");
  if (typeof cfg.docs.autoUpdate !== "boolean")
    throw new Error("orch.yml: docs.autoUpdate must be a boolean");
  if (typeof cfg.docs.prompt !== "string" || !cfg.docs.prompt.trim())
    throw new Error("orch.yml: docs.prompt must be a non-empty string");
  if (!Array.isArray(cfg.docs.paths) || !cfg.docs.paths.every((p) => typeof p === "string"))
    throw new Error("orch.yml: docs.paths must be an array of strings");
}

// A role spec is "<agent> [model] [effort]" — whitespace-separated fields.
//   agent  — required; one of the registered agents
//   model  — optional model id, may carry a subversion (e.g. claude-opus-4-8); opaque
//   effort — optional reasoning effort; one of EFFORTS below
// String form only — it covers both CLI flags and YAML plain scalars.
// Bare names ("claude") parse to { agent: "claude", model: null, effort: null },
// so old configs and CLI flags keep working unchanged.
// A trailing token matching a known effort keyword is taken as effort, so
// "codex high" => {effort:"high"} (not model:"high") and effort is settable
// without also naming a model. ponytail: a model literally named like an effort
// keyword would be misread — none exists, and effort is a reserved trailing word.
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "minimal"]);
export function parseRoleSpec(spec) {
  const parts = String(spec ?? "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) throw new Error("role spec must name an agent");
  const [agent, ...rest] = parts;
  let effort = null;
  if (rest.length && EFFORTS.has(rest[rest.length - 1].toLowerCase())) {
    effort = rest.pop();
  }
  const model = rest.length ? rest[0] : null;
  return { agent, model, effort };
}

// Parse a list of role specs from a YAML array or a comma-separated string.
export function parseRoleSpecs(value) {
  const items = Array.isArray(value) ? value : String(value).split(",");
  const specs = items.map((v) => (typeof v === "string" ? v.trim() : v)).filter(Boolean).map(parseRoleSpec);
  if (!specs.length) throw new Error("role override must name at least one agent");
  return specs;
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
