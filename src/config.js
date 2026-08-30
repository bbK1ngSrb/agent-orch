import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { get as getAdapter } from "./adapters/index.js";

const DEFAULTS = {
  agents: ["claude", "codex"],
  author: null, // explicit fixed author; null = rotate through `agents`
  reviewer: null, // explicit fixed reviewer; pairs with `author`
  authors: null, // configured role-spec pool; pairs with `reviewers`
  reviewers: null, // configured role-spec pool; pairs with `authors`
  test: "auto",
  roundCap: 3, // max review rounds, counting the initial review as round 1
               // (so 3 = 3 reviews / 2 revisions).
  stageTimeout: 25, // #56: per-stage wall-clock cap in MINUTES; 0 disables. A stalled
                    // codex/claude stage is killed and the cycle fails (nonzero exit)
                    // instead of hanging forever on an infinite "still running" heartbeat.
                    // The test gate uses gateTimeout below, which defaults to this value.
  gateTimeout: 25, // test-gate wall-clock cap in minutes; defaults to stageTimeout
  baseBranch: "main", // trunk orch reads from, diffs against, and opens PRs to
  integrationBranch: "orch/integration", // local merge target; baseBranch is advanced only by GitHub PR + ff-only fetch
  merge: "no-ff", // ff-only | no-ff | pr — "pr" skips local integration: an AGREE+green
                  // cycle opens a per-cycle PR (github.openPr) instead of git.mergeInWorktree
  landing: "no-ff", // canonical spelling of merge; values are unchanged until P12
  concurrency: 4, // max concurrent cycles per repo dir; over this, a cycle exits rather than blocks
  cheap: {
    role: null, // role spec ("<agent> [model] [effort]") used for author+reviewer when cheap routing triggers
    paths: [], // globs; a --file/issue work order whose suspected_paths all match auto-routes to `role`
  },
  scope: { maxLines: 0, ignore: ["*.lock", "dist/**", "*.snap"] },
  security: {
    ignore: [], // globs exempt from the deterministic security scan (#334). Deliberately
                // NOT scope.ignore: excluding a file from a line COUNT is routine hygiene,
                // excluding it from the security FLOOR is a security decision — coupling
                // them would silently widen the exemption every time someone tunes scope.
  },
  github: {
    mergeMethod: "squash", // gh pr merge strategy for orch-owned PR auto-merge
    autoMergePr: false, // enable GitHub auto-merge on PRs orch opens or updates
  },
  main: {
    autoMerge: false, // opt-in direct merge of the persistent integration->main PR
    autoResolveConflicts: false, // opt-in Claude reconciliation when the persistent PR is dirty
    conflictResolution: "manual", // manual | propose | auto; autoResolveConflicts is a deprecated alias
    conflictResolutionResolvers: null, // null = fallback to the historical single claude resolver
    autoResolveConflictPaths: ["CHANGELOG.md", "docs/index.html", "package-lock.json", "package.json"],
  },
  docs: {
    autoUpdate: false, // opt-in per repo; flip true in .orch/orch.yml
    prompt: "update documentation to reflect the latest merged changes",
    paths: ["*.md", "docs/**", "**/*.md"], // docs-only globs = loop guard
  },
  release: {
    autoBump: false, // opt-in per repo: patch version bump + CHANGELOG entry after each integrated merge
  },
  automation: {
    maxAttempts: 3, // design §4 RunPolicy.maxAttempts — `--until ready|merged` run-controller cap (P5)
    humanWaitHours: 24, // bounded wait for an `ask` reply; continue resumes it later
    mcpMayMerge: false, // MCP may request `--until merged` only when explicitly enabled
    remedies: null, // null uses the failure table order; operators may override the priority
    rotateModels: {}, // optional per-agent model ladders consumed by the rotate remedy
    pollSeconds: 30, // initial readiness poll interval; backs off 2x per attempt, capped at 10 min
    ciWaitMinutes: 30, // bound on one readiness wait window before it counts as an attempt (REMOTE_CI_TIMEOUT)
    conflictResolution: null, // canonical spelling of main.conflictResolution; null keeps the manual default
    conflictResolvers: null, // canonical spelling of main.conflictResolutionResolvers
    conflictAutoPaths: ["CHANGELOG.md", "docs/index.html", "package-lock.json", "package.json"],
    detachLogDir: ".orch/logs",
  },
  env: { passthrough: [] }, // accepted v2 key; env forwarding remains inert until its execution broker lands
};

const REMOVED_CONFIG_MESSAGES = new Map([
  ["merge", "orch.yml: 'merge' was renamed to 'landing' in v0.5.0 (same values). Rename the key."],
  ["main.autoMerge", "orch.yml: 'main.autoMerge' was removed in v0.5.0; use --until merged for per-run merging."],
  ["github.autoMergePr", "orch.yml: 'github.autoMergePr' was removed in v0.5.0; use --until merged for per-run merging."],
  ["main.conflictResolution", "orch.yml: 'main.conflictResolution'/'main.autoResolveConflicts' were removed in v0.5.0; conflict repair is a loop remedy under --until ready|merged."],
  ["main.autoResolveConflicts", "orch.yml: 'main.conflictResolution'/'main.autoResolveConflicts' were removed in v0.5.0; conflict repair is a loop remedy under --until ready|merged."],
  ["main.conflictResolutionResolvers", "orch.yml: 'main.conflictResolutionResolvers' was removed in v0.5.0; use 'automation.conflictResolvers'."],
  ["main.autoResolveConflictPaths", "orch.yml: 'main.autoResolveConflictPaths' was removed in v0.5.0; use 'automation.conflictAutoPaths'."],
  ["reviseCap", "orch.yml: 'reviseCap' was removed in v0.5.0; use 'roundCap'."],
]);

const CONFIG_CHILDREN = {
  cheap: new Set(["role", "paths"]),
  scope: new Set(["maxLines", "ignore"]),
  security: new Set(["ignore"]),
  github: new Set(["mergeMethod"]),
  main: new Set(),
  docs: new Set(["autoUpdate", "prompt", "paths"]),
  release: new Set(["autoBump"]),
  automation: new Set([
    "maxAttempts", "humanWaitHours", "mcpMayMerge", "remedies", "rotateModels",
    "pollSeconds", "ciWaitMinutes", "conflictResolution", "conflictResolvers", "conflictAutoPaths", "detachLogDir",
  ]),
  env: new Set(["passthrough"]),
};

const CONFIG_KEYS = new Set([
  "agents", "author", "reviewer", "authors", "reviewers", "test", "roundCap", "stageTimeout",
  "gateTimeout", "baseBranch", "integrationBranch", "landing", "concurrency", "cheap", "scope",
  "security", "github", "main", "docs", "release", "automation", "env",
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function gateTimeoutMs(cfg = {}) {
  const minutes = cfg.gateTimeout ?? cfg.stageTimeout ?? 0;
  return Number(minutes) > 0 ? Number(minutes) * 60_000 : 0;
}

function collectConfigIssues(source, warnings, problems, prefix = "", label = "orch.yml") {
  if (!isObject(source)) return;
  for (const [key, value] of Object.entries(source)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (REMOVED_CONFIG_MESSAGES.has(path)) {
      const problem = REMOVED_CONFIG_MESSAGES.get(path).replace("orch.yml:", `${label}:`);
      problems.add(problem);
      continue;
    }
    const known = prefix ? CONFIG_CHILDREN[prefix]?.has(key) : CONFIG_KEYS.has(key);
    if (!known) {
      problems.add(path.startsWith("main.")
        ? `${label}: unknown key '${path}'.`
        : `${label}: unknown key '${path}' (typo? see orch.example.yml).`);
      continue;
    }
    // rotateModels is a map keyed by adapter name, not a closed object whose
    // entries should be interpreted as config paths.
    if (isObject(value) && path !== "automation.rotateModels") collectConfigIssues(value, warnings, problems, path, label);
  }
}

function warningList(user, override, userLabel = "orch.yml") {
  const warnings = new Set();
  collectConfigIssues(user, warnings, new Set(), "", userLabel);
  collectConfigIssues(override, warnings, new Set(), "", "--config-file");
  return [...warnings];
}

function problemList(user, override, userLabel = "orch.yml") {
  const problems = new Set();
  collectConfigIssues(user, new Set(), problems, "", userLabel);
  collectConfigIssues(override, new Set(), problems, "", "--config-file");
  return [...problems];
}

// roundCapKey names the spelling the operator actually wrote, so an error about a
// bad value never mentions a key that is absent from their config.
export function validate(cfg, roundCapKey = "roundCap", landingKey = cfg?.landing !== undefined ? "landing" : "merge") {
  if (!isObject(cfg)) throw new Error("orch.yml: config must be a mapping");
  if (!Array.isArray(cfg.agents) || cfg.agents.length < 1)
    throw new Error("orch.yml: agents must be a non-empty list");
  if (!cfg.agents.every((agent) => typeof agent === "string" && /^\S+$/.test(agent)))
    throw new Error("orch.yml: agents entries must be bare adapter names; put model/effort in author/reviewer or use CLI overrides");
  if (cfg.test == null || typeof cfg.test !== "string" || !cfg.test.trim())
    throw new Error("orch.yml: test must be a non-empty string");
  if (cfg.author != null && (typeof cfg.author !== "string" || !cfg.author.trim()))
    throw new Error("orch.yml: author must be a non-empty string");
  if (cfg.reviewer != null && (typeof cfg.reviewer !== "string" || !cfg.reviewer.trim()))
    throw new Error("orch.yml: reviewer must be a non-empty string");
  if ((cfg.author == null) !== (cfg.reviewer == null))
    throw new Error("orch.yml: set both author and reviewer, or neither");
  if ((cfg.authors == null) !== (cfg.reviewers == null))
    throw new Error("orch.yml: set both authors and reviewers, or neither");
  if (cfg.authors != null && (!Array.isArray(cfg.authors) || cfg.authors.length < 1 || !cfg.authors.every((a) => typeof a === "string" && a.trim())))
    throw new Error("orch.yml: authors must be a non-empty list of strings");
  if (cfg.reviewers != null && (!Array.isArray(cfg.reviewers) || cfg.reviewers.length < 1 || !cfg.reviewers.every((r) => typeof r === "string" && r.trim())))
    throw new Error("orch.yml: reviewers must be a non-empty list of strings");
  if (cfg.authors != null) {
    const authors = parseRoleSpecs(cfg.authors);
    const reviewers = parseRoleSpecs(cfg.reviewers);
    for (let i = 0; i < authors.length; i += 1) {
      const author = authors[i];
      const start = i % reviewers.length;
      const diverse = reviewers.some((_, step) =>
        reviewers[(start + step) % reviewers.length].agent !== author.agent);
      if (!diverse) {
        throw new Error(`orch.yml: authors[${i}] (${author.agent}) has no reviewer with a different agent`);
      }
    }
  }
  const landing = cfg.landing ?? cfg.merge;
  if (!["ff-only", "no-ff", "pr"].includes(landing))
    throw new Error(`orch.yml: ${landingKey} must be ff-only, no-ff, or pr`);
  if (!Number.isInteger(cfg.roundCap) || cfg.roundCap < 1)
    throw new Error(`orch.yml: ${roundCapKey} must be a positive integer`);
  if (!Number.isInteger(cfg.stageTimeout) || cfg.stageTimeout < 0)
    throw new Error("orch.yml: stageTimeout must be a non-negative integer (minutes; 0 disables)");
  if (!Number.isInteger(cfg.gateTimeout) || cfg.gateTimeout < 0)
    throw new Error("orch.yml: gateTimeout must be a non-negative integer (minutes; 0 disables)");
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
  if (!Array.isArray(cfg.security.ignore) || !cfg.security.ignore.every((p) => typeof p === "string" && p.trim()))
    throw new Error("orch.yml: security.ignore must be an array of non-empty glob strings");
  if (!["squash", "merge", "rebase"].includes(cfg.github.mergeMethod))
    throw new Error("orch.yml: github.mergeMethod must be squash, merge, or rebase");
  if (typeof cfg.github.autoMergePr !== "boolean")
    throw new Error("orch.yml: github.autoMergePr must be a boolean");
  if (typeof cfg.main.autoMerge !== "boolean")
    throw new Error("orch.yml: main.autoMerge must be a boolean");
  // Keep these checks even though load() normalizes first: validate() is exported
  // and callers may use it directly on an already-merged config object.
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
  if (typeof cfg.release.autoBump !== "boolean")
    throw new Error("orch.yml: release.autoBump must be a boolean");
  if (!Number.isInteger(cfg.automation.maxAttempts) || cfg.automation.maxAttempts < 0)
    throw new Error("orch.yml: automation.maxAttempts must be a non-negative integer");
  if (typeof cfg.automation.humanWaitHours !== "number" || !Number.isFinite(cfg.automation.humanWaitHours)
    || cfg.automation.humanWaitHours <= 0 || cfg.automation.humanWaitHours > 720)
    throw new Error("orch.yml: automation.humanWaitHours must be a number greater than 0 and at most 720");
  if (typeof cfg.automation.mcpMayMerge !== "boolean")
    throw new Error("orch.yml: automation.mcpMayMerge must be a boolean");
  if (!isObject(cfg.automation.rotateModels)
    || Object.entries(cfg.automation.rotateModels).some(([agent, models]) => !/^\S+$/.test(agent)
      || !Array.isArray(models) || models.length < 1
      || new Set(models).size !== models.length
      || !models.every((model) => typeof model === "string" && model.trim())))
    throw new Error("orch.yml: automation.rotateModels must map agents to non-empty, duplicate-free lists of model strings");
  for (const agent of Object.keys(cfg.automation.rotateModels)) {
    try { getAdapter(agent); }
    catch { throw new Error(`orch.yml: automation.rotateModels.${agent} names an unknown adapter`); }
  }
  const remedyNames = new Set(["rebase", "rotate", "reauthor", "ask"]);
  if (cfg.automation.remedies !== null && (!Array.isArray(cfg.automation.remedies)
    || new Set(cfg.automation.remedies).size !== cfg.automation.remedies.length
    || !cfg.automation.remedies.every((remedy) => remedyNames.has(remedy))))
    throw new Error("orch.yml: automation.remedies must be a duplicate-free subset of rebase, rotate, reauthor, ask");
  if (!Number.isInteger(cfg.automation.pollSeconds) || cfg.automation.pollSeconds < 1)
    throw new Error("orch.yml: automation.pollSeconds must be a positive integer");
  if (!Number.isInteger(cfg.automation.ciWaitMinutes) || cfg.automation.ciWaitMinutes < 1)
    throw new Error("orch.yml: automation.ciWaitMinutes must be a positive integer");
  if (typeof cfg.automation.detachLogDir !== "string" || !cfg.automation.detachLogDir.trim())
    throw new Error("orch.yml: automation.detachLogDir must be a non-empty string");
  if (!Array.isArray(cfg.env.passthrough) || !cfg.env.passthrough.every((key) => typeof key === "string" && /^[A-Z_][A-Z0-9_]*$/.test(key)))
    throw new Error("orch.yml: env.passthrough must be an array of valid environment variable names");
  if (cfg.env.passthrough.some((key) => key === "GH_TOKEN" || key === "GITHUB_TOKEN" || key === "GH_ENTERPRISE_TOKEN" || key.startsWith("ORCH_APP_")))
    throw new Error("orch.yml: env.passthrough may not include GitHub or ORCH_APP credentials");
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
  // Already-parsed runtime objects (e.g. after normalizeMainConfig) re-enter cleanly.
  if (spec && typeof spec === "object" && !Array.isArray(spec)) {
    if (typeof spec.agent !== "string" || !spec.agent.trim()) throw new Error("role spec must name an agent");
    const agent = spec.agent.trim();
    const model = spec.model == null || spec.model === "" ? null : String(spec.model);
    const effort = spec.effort == null || spec.effort === "" ? null : String(spec.effort);
    const capabilities = getAdapter(agent).capabilities || {};
    if (model && !capabilities.model) throw new Error(`role spec: agent ${agent} does not support model`);
    if (effort && !capabilities.effort) throw new Error(`role spec: agent ${agent} does not support effort`);
    return { agent, model, effort };
  }
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

// Read the canonical round-cap spelling from one config layer.
function pickRoundCap(source) {
  return Object.prototype.hasOwnProperty.call(source, "roundCap")
    ? { value: source.roundCap, key: "roundCap" } : null;
}

// overridePath (--config-file) layers on top of the repo's orch.yml, same
// deep-merge rules — lets a run apply one-off settings without editing orch.yml.
export function mergeConfig(user = {}, override = {}) {
  user ||= {};
  override ||= {};
  return {
    ...DEFAULTS,
    ...user,
    ...override,
    cheap: { ...DEFAULTS.cheap, ...(user.cheap || {}), ...(override.cheap || {}) },
    scope: { ...DEFAULTS.scope, ...(user.scope || {}), ...(override.scope || {}) },
    security: { ...DEFAULTS.security, ...(user.security || {}), ...(override.security || {}) },
    github: { ...DEFAULTS.github, ...(user.github || {}), ...(override.github || {}) },
    main: { ...DEFAULTS.main, ...(user.main || {}), ...(override.main || {}) },
    docs: { ...DEFAULTS.docs, ...(user.docs || {}), ...(override.docs || {}) },
    release: { ...DEFAULTS.release, ...(user.release || {}), ...(override.release || {}) },
    automation: { ...DEFAULTS.automation, ...(user.automation || {}), ...(override.automation || {}) },
    env: { ...DEFAULTS.env, ...(user.env || {}), ...(override.env || {}) },
  };
}

export function normalizeV2Config(cfg, user = {}, override = {}) {
  const has = (source, key) => Object.prototype.hasOwnProperty.call(source, key);
  const landingSource = has(override, "landing") || has(override, "merge") ? override
    : has(user, "landing") || has(user, "merge") ? user : null;
  const landingKey = landingSource ? (has(landingSource, "landing") ? "landing" : "merge") : "landing";
  cfg.landing = landingSource ? landingSource[landingKey] : DEFAULTS.landing;
  // Cycle code in pre-cutover releases still reads cfg.merge. Keep the old
  // runtime alias while making landing the source of truth for new configs.
  cfg.merge = cfg.landing;

  const gateSource = has(override, "gateTimeout") ? override : has(user, "gateTimeout") ? user : null;
  cfg.gateTimeout = gateSource ? gateSource.gateTimeout : cfg.stageTimeout;

  if (has(override.automation || {}, "conflictResolution")) {
    cfg.main.conflictResolution = override.automation.conflictResolution;
  } else if (has(user.automation || {}, "conflictResolution")) {
    cfg.main.conflictResolution = user.automation.conflictResolution;
  }
  if (has(override.automation || {}, "conflictResolvers") || has(user.automation || {}, "conflictResolvers")) {
    const overrideAutomation = override.automation || {};
    const userAutomation = user.automation || {};
    if (has(overrideAutomation, "conflictResolvers")) {
      cfg.main.conflictResolutionResolvers = overrideAutomation.conflictResolvers;
    } else if (!has(override.main || {}, "conflictResolutionResolvers")) {
      cfg.main.conflictResolutionResolvers = userAutomation.conflictResolvers;
    }
  }
  if (has(override.automation || {}, "conflictAutoPaths") || has(user.automation || {}, "conflictAutoPaths")) {
    const overrideAutomation = override.automation || {};
    const userAutomation = user.automation || {};
    if (has(overrideAutomation, "conflictAutoPaths")) {
      cfg.main.autoResolveConflictPaths = overrideAutomation.conflictAutoPaths;
    } else if (!has(override.main || {}, "autoResolveConflictPaths")) {
      cfg.main.autoResolveConflictPaths = userAutomation.conflictAutoPaths;
    }
  }
  return { landingKey, cfg };
}

function readConfigLayers(dir, overridePath) {
  let user = {};
  const p = configPath(dir);
  if (existsSync(p)) user = parse(readFileSync(p, "utf8")) || {};
  let override = {};
  if (overridePath) {
    if (!existsSync(overridePath)) throw new Error(`orch: --config-file not found: ${overridePath}`);
    override = parse(readFileSync(overridePath, "utf8")) || {};
  }
  return { user, override };
}

export function load(dir, overridePath, { onWarning = console.warn } = {}) {
  const { user, override } = readConfigLayers(dir, overridePath);
  const cfg = mergeConfig(user, override);
  for (const warning of warningList(user, override)) onWarning(warning);
  const problems = problemList(user, override);
  if (problems.length) throw new Error(problems.join("\n"));
  // Both layers are consulted so each deprecated spelling gets its own warning.
  const fromOverride = pickRoundCap(override);
  const fromUser = pickRoundCap(user);
  const picked = fromOverride ?? fromUser;
  delete cfg.reviseCap; // one source of truth downstream
  cfg.roundCap = picked ? picked.value : DEFAULTS.roundCap;
  const { landingKey } = normalizeV2Config(cfg, user, override);
  normalizeMainConfig(cfg, user.main || {}, override.main || {}, user.automation || {}, override.automation || {});
  validate(cfg, picked?.key || "roundCap", landingKey);
  return cfg;
}

function flatten(value, prefix, target, source) {
  if (!isObject(value)) {
    if (prefix) target[prefix] = source;
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    flatten(child, path, target, source);
  }
}

// Non-interactive config consumers need the same effective values as load(),
// plus enough provenance to explain where each value came from.
export function configReport(dir, overridePath) {
  let user = {};
  let override = {};
  const problems = [];
  const userSource = existsSync(join(dir, ".orch", "orch.yml")) ? ".orch/orch.yml"
    : existsSync(join(dir, "orch.yml")) ? "orch.yml" : "default";
  try {
    ({ user, override } = readConfigLayers(dir, overridePath));
  } catch (error) {
    problems.push(error.message);
  }
  problems.push(...problemList(user, override, userSource));
  const warnings = warningList(user, override, userSource);
  let config = null;
  if (!problems.length) {
    try {
      config = load(dir, overridePath, { onWarning: () => {} });
    } catch (error) {
      problems.push(error.message);
    }
  }
  const sources = {};
  flatten(DEFAULTS, "", sources, "default");
  const has = (source, key) => Object.hasOwn(source, key);
  flatten(user, "", sources, userSource);
  flatten(override, "", sources, "--config-file");
  const landingSource = has(override, "landing") || has(override, "merge") ? "--config-file"
    : has(user, "landing") || has(user, "merge") ? userSource : "default";
  sources.landing = landingSource;
  sources.roundCap = has(override, "roundCap") ? "--config-file" : has(user, "roundCap") ? userSource : "default";
  delete sources.merge;
  delete sources.reviseCap;
  delete sources["github.autoMergePr"];
  for (const key of [
    "main.autoMerge", "main.autoResolveConflicts", "main.conflictResolution",
    "main.conflictResolutionResolvers", "main.autoResolveConflictPaths",
  ]) delete sources[key];
  if (!has(override, "gateTimeout") && !has(user, "gateTimeout")) {
    sources.gateTimeout = sources.stageTimeout;
  }
  const hasPath = (source, path) => {
    let current = source;
    for (const part of path.split(".")) {
      if (!isObject(current) || !Object.hasOwn(current, part)) return false;
      current = current[part];
    }
    return true;
  };
  const sourceFor = (overrideHas, userHas) => overrideHas ? "--config-file" : userHas ? userSource : "default";
  const normalizedSource = (canonical, legacy) => hasPath(override, canonical) || hasPath(override, legacy) ? "--config-file"
    : hasPath(user, canonical) || hasPath(user, legacy) ? userSource : "default";
  const modeSource = sourceFor(
    hasPath(override, "main.conflictResolution") || !hasPath(user, "main.conflictResolution") && hasPath(override, "main.autoResolveConflicts"),
    hasPath(user, "main.conflictResolution") || !hasPath(override, "main.conflictResolution") && hasPath(user, "main.autoResolveConflicts"),
  );
  sources["main.conflictResolution"] = modeSource;
  sources["main.autoResolveConflicts"] = modeSource;
  sources["main.conflictResolutionResolvers"] = normalizedSource(
    "automation.conflictResolvers", "main.conflictResolutionResolvers",
  );
  sources["main.autoResolveConflictPaths"] = normalizedSource(
    "automation.conflictAutoPaths", "main.autoResolveConflictPaths",
  );
  for (const key of [
    "main.autoMerge", "main.autoResolveConflicts", "main.conflictResolution",
    "main.conflictResolutionResolvers", "main.autoResolveConflictPaths",
  ]) delete sources[key];
  if (config) {
    const { merge: _merge, main: _main, ...publicConfig } = config;
    if (publicConfig.github) {
      const { autoMergePr: _autoMergePr, ...github } = publicConfig.github;
      publicConfig.github = github;
    }
    config = publicConfig;
  }
  return { config, sources, warnings, problems, ok: problems.length === 0 };
}

export function normalizeMainConfig(cfg, userMain = {}, overrideMain = {}, userAutomation = {}, overrideAutomation = {}) {
  if (typeof cfg.main.autoResolveConflicts !== "boolean")
    throw new Error("orch.yml: main.autoResolveConflicts must be a boolean");
  const explicitMode = Object.prototype.hasOwnProperty.call(userMain, "conflictResolution") ||
    Object.prototype.hasOwnProperty.call(overrideMain, "conflictResolution") ||
    Object.prototype.hasOwnProperty.call(userAutomation, "conflictResolution") ||
    Object.prototype.hasOwnProperty.call(overrideAutomation, "conflictResolution");
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
