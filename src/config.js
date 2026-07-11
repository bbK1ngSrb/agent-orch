import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { get as getAdapter } from "./adapters/index.js";

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
  baseBranch: "main", // trunk orch reads from, diffs against, and opens PRs to
  integrationBranch: "orch/integration", // local merge target; baseBranch is advanced only by GitHub PR + ff-only fetch
  merge: "no-ff", // ff-only | no-ff | pr — "pr" skips local integration: an AGREE+green
                  // cycle opens a per-cycle PR (github.openPr) instead of git.mergeInWorktree
  concurrency: 4, // max concurrent cycles per repo dir; over this, a cycle exits rather than blocks
  cheap: {
    role: null, // role spec ("<agent> [model] [effort]") used for author+reviewer when cheap routing triggers
    paths: [], // globs; a --file/issue work order whose suspected_paths all match auto-routes to `role`
  },
  scope: { maxLines: 0, ignore: ["*.lock", "dist/**", "*.snap"] },
  github: {
    mergeMethod: "squash", // gh pr merge strategy for orch-owned PR auto-merge
    autoMergePr: false, // enable GitHub auto-merge on PRs orch opens or updates
  },
  main: {
    autoMerge: false, // opt-in direct merge of the persistent integration->main PR
    autoResolveConflicts: false, // opt-in Claude reconciliation when the persistent PR is dirty
    conflictResolution: "manual", // manual | propose | auto; autoResolveConflicts is a deprecated alias
    conflictResolutionResolvers: null, // null = fallback to the historical single claude resolver
    autoResolveConflictPaths: ["CHANGELOG.md", "docs/index.html", "package-lock.json", "package.json", "src/version.js", "version.js"],
  },
  docs: {
    autoUpdate: false, // opt-in per repo; flip true in .orch/orch.yml
    prompt: "update documentation to reflect the latest merged changes",
    paths: ["*.md", "docs/**", "**/*.md"], // docs-only globs = loop guard
  },
};

export function validate(cfg) {
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
  if (typeof cfg.baseBranch !== "string" || !cfg.baseBranch.trim())
    throw new Error("orch.yml: baseBranch must be a non-empty string");
  if (typeof cfg.integrationBranch !== "string" || !cfg.integrationBranch.trim())
    throw new Error("orch.yml: integrationBranch must be a non-empty string");
  if (!Number.isInteger(cfg.concurrency) || cfg.concurrency < 1)
    throw new Error("orch.yml: concurrency must be a positive integer");
  if (cfg.cheap.role != null && (typeof cfg.cheap.role !== "string" || !cfg.cheap.role.trim()))
    throw new Error("orch.yml: cheap.role must be a non-empty string");
  if (!Array.isArray(cfg.cheap.paths) || !cfg.cheap.paths.every((p) => typeof p === "string"))
    throw new Error("orch.yml: cheap.paths must be an array of strings");
  if (!Number.isInteger(cfg.scope.maxLines) || cfg.scope.maxLines < 0)
    throw new Error("orch.yml: scope.maxLines must be a non-negative integer");
  if (!["squash", "merge", "rebase"].includes(cfg.github.mergeMethod))
    throw new Error("orch.yml: github.mergeMethod must be squash, merge, or rebase");
  if (typeof cfg.github.autoMergePr !== "boolean")
    throw new Error("orch.yml: github.autoMergePr must be a boolean");
  if (typeof cfg.main.autoMerge !== "boolean")
    throw new Error("orch.yml: main.autoMerge must be a boolean");
  if (typeof cfg.main.autoResolveConflicts !== "boolean")
    throw new Error("orch.yml: main.autoResolveConflicts must be a boolean");
  if (!["manual", "propose", "auto"].includes(cfg.main.conflictResolution))
    throw new Error("orch.yml: main.conflictResolution must be manual, propose, or auto");
  if (cfg.main.conflictResolutionResolvers != null && (!Array.isArray(cfg.main.conflictResolutionResolvers) || cfg.main.conflictResolutionResolvers.length < 1))
    throw new Error("orch.yml: main.conflictResolutionResolvers must be a non-empty list of role specs");
  if (!Array.isArray(cfg.main.autoResolveConflictPaths) || !cfg.main.autoResolveConflictPaths.every((p) => typeof p === "string"))
    throw new Error("orch.yml: main.autoResolveConflictPaths must be an array of strings");
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
  const parsed = { agent, model, effort };
  const capabilities = getAdapter(agent).capabilities || {};
  if (model && !capabilities.model) throw new Error(`role spec: agent ${agent} does not support model`);
  if (effort && !capabilities.effort) throw new Error(`role spec: agent ${agent} does not support effort`);
  return parsed;
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

// overridePath (--config-file) layers on top of the repo's orch.yml, same
// deep-merge rules — lets a run apply one-off settings without editing orch.yml.
export function load(dir, overridePath) {
  let user = {};
  const p = configPath(dir);
  if (existsSync(p)) user = parse(readFileSync(p, "utf8")) || {};
  let override = {};
  if (overridePath) {
    if (!existsSync(overridePath)) throw new Error(`orch: --config-file not found: ${overridePath}`);
    override = parse(readFileSync(overridePath, "utf8")) || {};
  }
  const cfg = {
    ...DEFAULTS,
    ...user,
    ...override,
    cheap: { ...DEFAULTS.cheap, ...(user.cheap || {}), ...(override.cheap || {}) },
    scope: { ...DEFAULTS.scope, ...(user.scope || {}), ...(override.scope || {}) },
    github: { ...DEFAULTS.github, ...(user.github || {}), ...(override.github || {}) },
    main: { ...DEFAULTS.main, ...(user.main || {}), ...(override.main || {}) },
    docs: { ...DEFAULTS.docs, ...(user.docs || {}), ...(override.docs || {}) },
  };
  normalizeMainConfig(cfg, user.main || {}, override.main || {});
  validate(cfg);
  return cfg;
}

function normalizeMainConfig(cfg, userMain, overrideMain) {
  if (typeof cfg.main.autoResolveConflicts !== "boolean")
    throw new Error("orch.yml: main.autoResolveConflicts must be a boolean");
  const explicitMode = Object.prototype.hasOwnProperty.call(userMain, "conflictResolution") ||
    Object.prototype.hasOwnProperty.call(overrideMain, "conflictResolution");
  if (!explicitMode) cfg.main.conflictResolution = cfg.main.autoResolveConflicts ? "auto" : "manual";
  cfg.main.autoResolveConflicts = cfg.main.conflictResolution !== "manual";
  if (cfg.main.conflictResolutionResolvers != null) {
    if (!Array.isArray(cfg.main.conflictResolutionResolvers) || cfg.main.conflictResolutionResolvers.length < 1)
      throw new Error("orch.yml: main.conflictResolutionResolvers must be a non-empty list of role specs");
    cfg.main.conflictResolutionResolvers = parseRoleSpecs(cfg.main.conflictResolutionResolvers);
  }
  if (cfg.main.conflictResolution === "propose" ||
    (cfg.main.conflictResolution === "auto" && cfg.main.autoResolveConflictPaths.length === 0)) {
    const resolvers = cfg.main.conflictResolutionResolvers || [{ agent: "claude", model: null, effort: null }];
    const reviewers = cfg.reviewers ? parseRoleSpecs(cfg.reviewers) : [];
    const agents = (cfg.agents || []).map((agent) => ({ agent, model: null, effort: null }));
    const hasReviewer = (resolver) => [...resolvers, ...reviewers, ...agents].some((r) => r.agent !== resolver.agent);
    if (!resolvers.every(hasReviewer))
      throw new Error("orch.yml: main.conflictResolution requires a conflict reviewer that differs from each resolver");
  }
}

export { DEFAULTS };
