import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline";
import { execFileSync, spawn } from "node:child_process";
import { load, configPath, parseRoleSpec, parseRoleSpecs } from "./config.js";
import { runConfigWizard } from "./config-wizard.js";
import { runCycle } from "./engine.js";
import { runPr, demote, openPr, openIntegrationPr, buildIssueComment, hasRemote, ghAvailable, requireGh } from "./github.js";
import * as adapters from "./adapters/index.js";
import * as git from "./git.js";
import * as gate from "./gate.js";
import * as scope from "./scope.js";
import { globToRegExp } from "./scope.js";
import * as notify from "./notify.js";
import { acquireLock, releaseLock, acquireBlocking, isPaused } from "./lock.js";
import { slugify } from "./slug.js";
import { serve } from "./mcp.js";

const VERSION = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;
const DISPLAY_VERSION = `v${VERSION}`;
import { newSid } from "./sid.js";
import * as inflight from "./inflight.js";
import * as resume from "./resume.js";
import * as checkpoint from "./checkpoint.js";
import * as reviewLog from "./review-log.js";
import { finalize } from "./finalize.js";
import { validateWorkOrder, buildAuthorPrompt, issueToWorkOrder } from "./intake/workorder.js";
import { findProtectedMentions } from "./intake/allowlist.js";
import { appCredsFromEnv, installationToken, parseRepoSlug } from "./github-app.js";
import { finishRun } from "./complete.js";
import { detectAgents, formatDetection } from "./detect.js";
import { redact } from "./redact.js";
import { render as renderDashboard, snapshot as dashboardSnapshot } from "./dashboard.js";
import { FALLBACK_BIN_DIRS, resolveAgentBin } from "./agent-bin.js";
import { BASH_COMPLETION, installCompletion } from "./completion.js";
import { visWidth, paint, C, box, colorEnabled } from "./tui/theme.js";
import { run as runTui } from "./tui/loop.js";
import { maybeNotifyUpdate, runUpdateCheckChild } from "./update-check.js";
import { runUpgrade } from "./upgrade.js";

export { slugify };
export { resolveAgentBin };
export { visWidth };

function ghShell(args, input) {
  return execFileSync("gh", args, { input, encoding: "utf8" }).toString();
}

// Fire-and-forget a detached `orch task <prompt>` after a successful merge.
// Task mode derives the branch name from the prompt slug, so a FIXED prompt
// collides on the second run (git.js rejects an existing task branch) and, under
// detached stdio, fails invisibly. Lead the prompt with a short unique stamp so
// every run gets a unique slug/branch. stdio is captured to .orch/auto-docs.log
// (when orchDir is known) so a failed detached run leaves a trail.
// ponytail: ms stamp + in-process counter (so two merges in one ms still differ)
// + append-only log; rotate the log if it ever grows.
let docsSeq = 0;
export function spawnDocsTask(prompt, deps = { spawn }, orchDir) {
  const tagged = `auto-docs ${Date.now().toString(36)}${(docsSeq++).toString(36)} ${prompt}`;
  let stdio = "ignore";
  let fd;
  try {
    if (orchDir) {
      fd = (deps.openSync || openSync)(join(orchDir, "auto-docs.log"), "a");
      stdio = ["ignore", fd, fd];
    }
    deps.spawn(process.execPath, [process.argv[1], "task", tagged],
      { detached: true, stdio }).unref();
  } finally {
    if (fd !== undefined) (deps.closeSync || closeSync)(fd);
  }
  console.log("▶ post-merge: docs-update spawned");
}

// Loop guard + opt-in gate around spawnDocsTask. Real merge only (never --dry).
// Skips docs-only merges (the docs-update's own merge can't re-trigger) AND no-op
// merges (an empty diff would re-spawn forever, since it's not docs-only either).
export function maybeSpawnDocs(res, cfg, deps = {}, orchDir) {
  const { dry = false, spawn: spawnFn = spawn } = deps;
  if (dry || res.status !== "merged" || !cfg.docs.autoUpdate || res.docsOnly || res.noop) return false;
  spawnDocsTask(cfg.docs.prompt, { spawn: spawnFn }, orchDir);
  return true;
}

function cleanStreakSuffix(orchDir, dry) {
  if (dry) return "";
  return `; clean unattended cycles: ${notify.kpi(orchDir).cleanUnattendedCycles}`;
}

const STATUS_COLOR = { merged: C.ok, escalated: C.fail, "merge-deferred": C.fail, pr: C.warn, demoted: C.warn };

export function summaryLine(result, branch, dry, extra, color = false, closes = null) {
  const status = paint(color, STATUS_COLOR[result.status] || "", result.status);
  const reason = result.reason || "";
  const nl = reason.indexOf("\n");
  // reason can be a multi-line report (demoteReason()); keep the parenthetical
  // one-line and print the rest as a trailing indented block instead of
  // jamming embedded newlines/fences into the single-line summary.
  const head = nl === -1 ? reason : reason.slice(0, nl);
  const rest = nl === -1 ? "" : `\n${reason.slice(nl + 1)}`;
  const deferred = result.status === "merge-deferred" && result.trigger;
  const outcome = deferred
    ? ` (${result.trigger}) — ${head.replace(/[.;]$/, "")}; completed`
    : ` (${head})`;
  const issuePrefix = closes == null ? "" : `#${closes} `;
  return `orch${dry ? " (dry)" : ""}: ${issuePrefix}${branch}: ${status}${outcome} after ${result.rounds} round(s)${extra}; cost ${result.usageSummary}${rest}`;
}

function resetKpiOnRecovery(orchDir, recovery) {
  if (recovery?.recovered) notify.resetKpi(orchDir);
}

// `orch agent add` edits orch.yml as text (not a YAML round-trip, which would
// strip its comments). For the scaffold's block-sequence form, append a new
// `  - <name>` after the LAST existing item — scanning past interspersed blank
// or comment lines so a hand-edited pool (a comment between entries, or right
// after `agents:`) still appends at the end rather than mid-list, which would
// silently reorder the author rotation. Returns null if no block list is found.
export function appendAgentToBlockList(text, name) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^agents:[ \t]*(#.*)?$/.test(l));
  if (start === -1) return null;
  let itemIndent = null, gap = " ", lastItem = -1;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "" || /^\s*#/.test(l)) continue; // blank/comment inside or trailing the block
    const m = l.match(/^(\s+)-(\s+)/);
    if (!m) break; // a dedented line or the next key ends the sequence
    itemIndent = itemIndent ?? m[1];
    gap = m[2];
    lastItem = i;
  }
  if (lastItem === -1) return null;
  lines.splice(lastItem + 1, 0, `${itemIndent}-${gap}${name}`);
  return lines.join("\n");
}

// init scaffold — mirrors orch.example.yml. Every key is listed with its
// possible values and default; commented keys use the shown default.
const SCAFFOLD = `# agent-orch config — every key is optional; a commented key shows its default.
# Full annotated reference: docs/orch-manual.md. Groups are spaced and commented;
# uncomment a key to override the shown default.


# ===================================================================
# Agents — rotation pool
# ===================================================================
# When no explicit roles are set (next group), orch rotates this pool
# for the author and takes the next entry as reviewer. Order matters.
#
# Built-in: claude, codex, copilot, gemini, agy, grok, kimi, zai
# Local llm models (run via ccr, no API cost):
#   qwen3-coder-30b, deepseek-coder-v2-lite, glm-4.5-air
#
# Add a known agent with \`orch agent add <name>\`.
agents:
  - claude
  - codex


# ===================================================================
# Roles — optional explicit author/reviewer (set both sides or neither)
# ===================================================================
# A role is a spec "<agent> [model] [effort]":
#   agent  — required; one of the agents above
#   model  — optional model id, may carry a subversion. Current Claude ids:
#            claude-opus-4-8, claude-sonnet-5, claude-fable-5,
#            claude-haiku-4-5-20251001 (a bad id silently escalates the cycle)
#   effort — optional reasoning effort: minimal | low | medium | high | xhigh | max
#            (which values an agent CLI honors varies by agent)
#
# Unset → the agents pool rotates the author; the next agent reviews.
#
# author: claude claude-opus-4-8 high        # single author spec
# reviewer: codex                            # single reviewer spec
# authors:                                   # each writes its own branch
#   - claude claude-opus-4-8 high
#   - codex
# reviewers:                                 # all audit each branch, except its author
#   - claude
#   - codex high


# ===================================================================
# Cycle
# ===================================================================
test: auto                              # "auto" detects the test command, or set one, e.g. "pytest -q"
roundCap: 3                             # max review rounds incl. the first, before escalation (positive int); default: 3
                                        # (reviseCap is the deprecated alias for this key)
stageTimeout: 25                        # per-stage wall-clock cap in minutes; 0 disables; default: 25
concurrency: 4                          # max concurrent cycles per repo dir; over-cap launches exit; default: 4
baseBranch: main                        # trunk orch reads/diffs/PRs against (e.g. dev if main is deploy-only); default: main
integrationBranch: orch/integration     # local merge target for no-ff/ff-only; default: orch/integration
merge: no-ff                            # into integrationBranch: ff-only | no-ff | pr; default: no-ff
                                        # (pr = skip local integration, open a per-cycle branch PR)


# ===================================================================
# Cheap-agent dispatch (optional)
# ===================================================================
# \`orch task --cheap\` forces \`role\` (e.g. a local llm via ccr) ad hoc; without
# the flag, a \`--file\`/\`orch issue\` work order whose suspected_paths all match
# \`paths\` routes to \`role\` automatically.
#
# cheap:
#   role: qwen3-coder-30b
#   paths:
#     - "*.md"
#     - docs/**


# ===================================================================
# Scope gate (optional)
# ===================================================================
scope:
  maxLines: 0                           # 0 = disabled; >0 rejects oversized author commits
  ignore:                               # globs excluded from the line count
    - "*.lock"
    - dist/**
    - "*.snap"


# ===================================================================
# Security scan (deterministic merge gate)
# ===================================================================
# Globs exempt from the security scan — for committed build artifacts
# (minified bundles false-positive as subprocess spawns, #334). Exempting a
# path skips ALL security rules for it, so list only generated files, never
# authored code. Empty by default, but empty is not "everything is scanned":
# markdown and \`docs/**\` paths are dropped before the scan runs.
#
# security:
#   ignore:
#     - dist/**


# ===================================================================
# GitHub PR bridge (orch pr <n>; merge: pr; integrationBranch -> baseBranch)
# ===================================================================
github:
  mergeMethod: squash                   # gh pr merge strategy for non-integration PRs; default: squash
  autoMergePr: false                    # enable GitHub native auto-merge on PRs orch opens/updates; default: false
                                        # (needs "Allow merge commits" on for the integration PR; see
                                        # docs/orch-manual.md for the ruleset bypass_actors caveat)


# ===================================================================
# Main mirror PR (integrationBranch -> baseBranch)
# ===================================================================
main:
  autoMerge: false                      # true = merge the persistent integration PR once checks are green; default: false
  conflictResolution: manual            # manual | propose | auto; default: manual
  # conflictResolutionResolvers:        # default: null — role specs; rotate/fail over per conflict
  #   - claude
  autoResolveConflicts: false           # deprecated alias: true = conflictResolution: auto
  autoResolveConflictPaths:
    - CHANGELOG.md
    - docs/index.html
    - package-lock.json
    - package.json


# ===================================================================
# Auto docs-update after a real merge (optional)
# ===================================================================
docs:
  autoUpdate: false                     # true = spawn a docs-update task after a merge; default: false
  prompt: update documentation to reflect the latest merged changes
  paths:                                # docs-only globs (loop guard)
    - "*.md"
    - docs/**
    - "**/*.md"


# ===================================================================
# Release automation (optional)
# ===================================================================
release:
  autoBump: false                       # true = patch bump + CHANGELOG commit after each integrated merge; default: false
`;

// Agent-agnostic usage doc written to .orch/ORCH.md on init. Committed and
// shared, so any agent driving the repo (Claude/Codex/Gemini/…) has the same
// "how to use orch here" reference. Generic — no per-repo specifics. Overwritten
// on every init so it tracks the installed orch version (it is orch's own file,
// not meant for hand-edits; user customisations belong in their agent file).
export const ORCH_DOC = `# Using orch in this repo

This repo is set up for **agent-orch**: it authors a change with one agent,
cross-audits it with a second, gates on tests, then merges into
\`orch/integration\` and opens or updates the persistent PR to \`main\`.
\`main\` is a GitHub mirror; update it locally only by fetching and
fast-forwarding \`origin/main\`.

If \`main\` requires PR review and orch opens the PR with the same bot identity
that later merges it, GitHub will not let that bot approve its own PR. Headless
self-merge therefore needs either a distinct reviewer identity that records an
approval, or a ruleset \`bypass_actors\` grant for the merging actor. With the
bypass path, GitHub review is bypassed; orch's author -> cross-audit ->
test-gate is the governing review.

## Commands
- \`orch task "<change>" [roles]\`   author → cross-audit → test-gate → merge
- \`orch issue <number> [roles]\`    fetch a GitHub issue as a work order, run the cycle, \`Closes #<n>\`
- \`orch review <branch>\`           audit an existing branch (no author)
- \`orch continue <sid>\`            resume an interrupted/stalled cycle from its checkpoint
- \`orch pr <number> [--merge]\`     review (and optionally merge) a GitHub PR
- \`orch release "<entry>"\`         run the version bump + CHANGELOG write by hand; only needed
                                    in repos that set \`release.autoBump: true\` (default \`false\`)
- \`orch mcp\`                       serve orch's cycle commands over MCP on stdio, for an AI
                                    client to drive (no merge authority is exposed)
- \`orch agent add <name>\`          add an agent to the rotation pool
- \`orch agent build <name> [--pr]\` scaffold a missing adapter via orch's own pipeline
- \`orch dashboard [--json] [--limit <n>] [--check-history]\`
                                    live cycle status, log tail, run history, metrics
                                    (\`--limit\` caps history rows; \`--check-history\`
                                    shows stale red rows as resolved when branches are gone,
                                    view only — runs.jsonl is left unchanged)

A role is a spec \`"<agent> [model] [effort]"\`, e.g.
\`--author "claude claude-opus-4-8 high" --reviewer "codex"\`.
\`--cheap\` forces \`orch.yml\`'s \`cheap.role\` (e.g. a local llm) for one run;
set \`cheap.paths\` to auto-route matching \`--file\`/\`orch issue\` work orders.
\`--config-file <path.yml>\` layers a custom YAML file on top of \`orch.yml\` for one run.
Config and every option live in \`.orch/orch.yml\`.

A \`task\`/\`issue\` whose work order text names a protected path (orch's own
guardrail denylist in \`src/intake/allowlist.js\`) is refused at intake, before any
cycle starts: a real change to that path is unsatisfiable — the security scan's
\`guardrail-touch\` floor would escalate the diff on the first otherwise-agreeing
round. The scan is textual, so pass \`--allow-protected\` when the mention is
incidental. A change that really must touch a guardrail is either hand-authored
without orch, or run with \`--allow-protected\` to have orch stage it — the cycle
then escalates at \`guardrail-touch\` instead of merging, and you review that staged
branch and merge it by hand. Without the flag nothing runs, so there is no branch
to review. A hand merge never reaches \`finalize()\`, so no version bump or CHANGELOG
line is written. Whether that is a gap depends on your config: with the default
\`release.autoBump: false\` a clean merge writes neither, so there is nothing
to recover and you should not run \`orch release\`. Only with
\`release.autoBump: true\` does the hand merge skip bookkeeping a clean merge would
have done — close that gap with \`orch release "<changelog entry>"\`, which always
bumps and never consults \`autoBump\`.

Run \`orch --help\` for the full flag list.
`;

// --link block: an idempotent, fenced pointer to .orch/ORCH.md. Only the text
// between the markers is managed; surrounding content is never touched. The
// @import line resolves in Claude Code; other agents read the prose pointer.
const LINK_BEGIN = "<!-- orch:begin (managed by `orch init --link`; edits here are overwritten) -->";
const LINK_END = "<!-- orch:end -->";
const LINK_BLOCK = `${LINK_BEGIN}
## orch
This repo uses agent-orch. See \`.orch/ORCH.md\` for usage; config in \`.orch/orch.yml\`.
@.orch/ORCH.md
${LINK_END}`;
const LINK_FENCE = /<!-- orch:begin[\s\S]*?<!-- orch:end -->/;

// Per-agent instruction-file conventions. Local-llm agents (qwen/deepseek/glm)
// have no standard file, so they fall through to the CLAUDE.md default.
const AGENT_DOC_FILE = { claude: "CLAUDE.md", codex: "AGENTS.md", gemini: "GEMINI.md" };

// Append (or refresh) the fenced pointer in the repo's agent-instruction files.
// Targets every known file present; if none exist, creates the file for the
// configured primary agent (e.g. codex → AGENTS.md), not a blind CLAUDE.md, so
// a non-Claude driver's pointer lands where that agent actually reads. Re-running
// replaces the fence in place — never duplicates, never clobbers other content.
// Returns the files touched.
export function linkOrchDoc(repo, agents = [], deps = {}) {
  const { read = readFileSync, write = writeFileSync, exists = existsSync } = deps;
  let targets = ["CLAUDE.md", "AGENTS.md", "GEMINI.md"].filter((n) => exists(join(repo, n)));
  if (targets.length === 0) {
    const primary = agents.find((a) => AGENT_DOC_FILE[a]);
    targets = [primary ? AGENT_DOC_FILE[primary] : "CLAUDE.md"];
  }
  for (const name of targets) {
    const f = join(repo, name);
    const prev = exists(f) ? read(f, "utf8") : "";
    const next = LINK_FENCE.test(prev)
      ? prev.replace(LINK_FENCE, LINK_BLOCK)
      : prev.trimEnd() + (prev.trim() ? "\n\n" : "") + LINK_BLOCK + "\n";
    write(f, next);
  }
  return targets;
}

// Single source of truth for the flag set: parse() uses it, and tests assert
// printUsage() and src/completion.js cover every key so the three can't drift.
export const PARSE_OPTIONS = {
  dry: { type: "boolean" },
  version: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  merge: { type: "boolean" },
  author: { type: "string" },
  reviewer: { type: "string" },
  authors: { type: "string" },
  reviewers: { type: "string" },
  cheap: { type: "boolean" }, // force author+reviewer to orch.yml cheap.role for this run
  file: { type: "string" },
  "config-file": { type: "string" }, // load a .yml file, layered on top of orch.yml for this run
  "allow-protected": { type: "boolean" }, // #395: run despite a protected-path mention at intake
  "no-tidy": { type: "boolean" }, // #44: skip post-run completion/cleanup
  "no-banner": { type: "boolean" },
  link: { type: "boolean" }, // init: also wire .orch/ORCH.md into the agent file
  json: { type: "boolean" }, // dashboard: machine-readable output
  limit: { type: "string" }, // dashboard: run-history entries to show
  "check-history": { type: "boolean" }, // dashboard: show stale red rows as resolved (view only) when branches are gone
  once: { type: "boolean" }, // dashboard: force the static one-shot print instead of the live TUI
  plain: { type: "boolean" }, // dashboard: alias of --once
  "refresh-ms": { type: "string" }, // dashboard: live TUI poll interval (default 1000)
  check: { type: "boolean" }, // upgrade: check latest version without installing
  pr: { type: "boolean" }, // agent build: land via PR instead of a local-only branch
};

export function parse(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: PARSE_OPTIONS,
  });
  return { command: positionals[0], rest: positionals.slice(1), flags: values };
}

function splitNames(value) {
  if (value == null) return null;
  const values = Array.isArray(value) ? value : String(value).split(",");
  const names = values.map((v) => String(v).trim()).filter(Boolean);
  if (names.length === 0) throw new Error("role override must name at least one agent");
  return names;
}

function fixedRoles(cfg) {
  if (cfg.authors && cfg.reviewers) {
    return { authors: parseRoleSpecs(cfg.authors), reviewers: parseRoleSpecs(cfg.reviewers) };
  }
  if (cfg.author && cfg.reviewer) {
    return { authors: [parseRoleSpec(cfg.author)], reviewers: [parseRoleSpec(cfg.reviewer)] };
  }
  return null;
}

function configuredReviewers(cfg) {
  if (cfg.reviewers) return parseRoleSpecs(cfg.reviewers);
  if (cfg.reviewer) return [parseRoleSpec(cfg.reviewer)];
  return null;
}

export function applyRoleOverrides(cfg, flags, opts = {}) {
  const authorValue = flags.authors ?? flags.author;
  const reviewerValue = flags.reviewers ?? flags.reviewer;
  if (authorValue == null && reviewerValue != null && opts.allowReviewerOnly) {
    return {
      ...cfg,
      reviewer: null,
      reviewers: splitNames(reviewerValue),
    };
  }
  if ((authorValue == null) !== (reviewerValue == null))
    throw new Error("set both --author(s) and --reviewer(s), or neither");
  if (authorValue == null) return cfg;
  return {
    ...cfg,
    author: null,
    reviewer: null,
    authors: splitNames(authorValue),
    reviewers: splitNames(reviewerValue),
  };
}

// --cheap forces author+reviewer to orch.yml's cheap.role (e.g. a local llm),
// ad hoc, for one run. Without the flag, a work order (--file / orch issue)
// whose suspected_paths all match cheap.paths auto-routes the same way — a
// task-group/category default set once in config instead of a per-task flag.
// Explicit --author/--reviewer always win over the auto path; combining them
// with --cheap itself is rejected rather than silently picking one.
export function applyCheapOverride(cfg, flags, workOrder = null) {
  const explicitRoles = Boolean(flags.author || flags.authors || flags.reviewer || flags.reviewers);
  if (flags.cheap) {
    if (explicitRoles) throw new Error("--cheap cannot be combined with --author/--authors/--reviewer/--reviewers");
    if (!cfg.cheap.role) throw new Error("orch.yml: cheap.role must be set to use --cheap");
    return { ...cfg, author: null, reviewer: null, authors: [cfg.cheap.role], reviewers: [cfg.cheap.role] };
  }
  if (explicitRoles || !cfg.cheap.role || !cfg.cheap.paths.length) return cfg;
  const paths = Array.isArray(workOrder?.suspected_paths) ? workOrder.suspected_paths : [];
  if (!paths.length) return cfg;
  const regexes = cfg.cheap.paths.map(globToRegExp);
  if (!paths.every((p) => regexes.some((re) => re.test(p)))) return cfg;
  return { ...cfg, author: null, reviewer: null, authors: [cfg.cheap.role], reviewers: [cfg.cheap.role] };
}

export function nextAuthor(cfg, orchDir, pinnedAuthor = null, dry = false) {
  // Explicit fixed roles win over rotation — the trivial "who authors, who audits".
  // Returns role specs ({agent, model, effort}) plus plain name arrays for back-compat.
  if (!dry) mkdirSync(orchDir, { recursive: true });
  const fixed = fixedRoles(cfg);
  if (fixed) {
    return {
      authorName: fixed.authors[0].agent,
      reviewerName: fixed.reviewers[0].agent,
      authorNames: fixed.authors.map((s) => s.agent),
      reviewerNames: fixed.reviewers.map((s) => s.agent),
      authors: fixed.authors,
      reviewers: fixed.reviewers,
    };
  }
  const f = join(orchDir, "last-author");
  // Resuming a surviving branch (#27): pin its author and DON'T advance rotation —
  // this run is the prior run continuing, not a new author's turn.
  // Reviewer-only CLI overrides (D2) force reviewers while still rotating the author.
  const forcedReviewers = configuredReviewers(cfg);
  if (pinnedAuthor && cfg.agents.includes(pinnedAuthor)) {
    const pi = cfg.agents.indexOf(pinnedAuthor);
    const rotationReviewer = cfg.agents[(pi + 1) % cfg.agents.length];
    const reviewers = forcedReviewers || [{ agent: rotationReviewer, model: null, effort: null }];
    return {
      authorName: pinnedAuthor, reviewerName: reviewers[0].agent,
      authorNames: [pinnedAuthor], reviewerNames: reviewers.map((s) => s.agent),
      authors: [{ agent: pinnedAuthor, model: null, effort: null }],
      reviewers,
    };
  }
  const last = existsSync(f) ? readFileSync(f, "utf8").trim() : null;
  const i = last ? (cfg.agents.indexOf(last) + 1) % cfg.agents.length : 0;
  const authorName = cfg.agents[i];
  const rotationReviewer = cfg.agents[(i + 1) % cfg.agents.length];
  if (!dry) writeFileSync(f, authorName + "\n");
  const reviewers = forcedReviewers || [{ agent: rotationReviewer, model: null, effort: null }];
  return {
    authorName, reviewerName: reviewers[0].agent,
    authorNames: [authorName], reviewerNames: reviewers.map((s) => s.agent),
    authors: [{ agent: authorName, model: null, effort: null }],
    reviewers,
  };
}

export function preflight(cfg, orchDir, opts = {}) {
  // Check the rotation pool plus any explicitly pinned roles. Role entries are
  // specs ("<agent> [model] [effort]"); only the agent name needs a CLI on PATH.
  // `opts.only`, when given, restricts the check to exactly those agent names
  // instead of the full orch.yml pool/roles — used by `orch continue`, which
  // resumes with a run's already-persisted author/reviewer specs and must not
  // fail preflight over an unrelated agent named elsewhere in the current
  // orch.yml that this resume will never touch (issue: resume fails before it
  // can reuse the stored specs).
  const names = opts.only
    ? new Set(opts.only.filter(Boolean))
    : new Set([
        ...cfg.agents,
        ...[
          cfg.author,
          cfg.reviewer,
          ...(cfg.authors || []),
          ...(cfg.reviewers || []),
        ].filter(Boolean).map((s) => parseRoleSpec(s).agent),
      ].filter(Boolean));
  if (names.has("claude") && process.env.ANTHROPIC_BASE_URL !== undefined) {
    console.warn(`ANTHROPIC_BASE_URL is set to "${process.env.ANTHROPIC_BASE_URL}"; the claude adapter will inherit it.`);
  }
  for (const name of names) {
    const a = adapters.get(name); // throws on unknown
    if (a.disabled) throw new Error(`agent "${name}" is disabled: ${a.disabled}`);
    const exe = a.bin || a.name; // local models run via `ccr`, not their own name
    const resolved = resolveAgentBin(exe);
    if (!resolved) throw new Error(`agent CLI not found on PATH: ${exe} (for agent ${name}; also probed ${FALLBACK_BIN_DIRS.join(", ")})`);
    // Off-PATH but found (or Windows, where hits resolve to the absolute
    // .cmd/.exe path so the adapter can unwrap npm shims): spawn by absolute path.
    if (resolved !== exe) a.bin = resolved;
  }
  // Fail fast with a clear message if .orch/ is read-only (sandbox / RO mount),
  // instead of a raw EACCES/EROFS later from the first last-author write.
  if (orchDir) {
    try {
      mkdirSync(orchDir, { recursive: true });
      const probe = join(orchDir, ".write-probe");
      writeFileSync(probe, "");
      rmSync(probe);
    } catch (e) {
      throw new Error(`.orch/ is not writable (${e.code || e.message}): ${orchDir} — orch needs to write worktrees and state here. Run from a writable repo / unsandbox this path.`);
    }
  }
}

// F2: real collaborators, or fully stubbed ones under --dry / ORCH_DRYRUN=1.
// Dry deps touch NO real git, agent, or test process.
// Terminal io for finishRun (#44). confirm only ever prompts on a real TTY; with no
// TTY (CI / piped) it answers "no" so a non-interactive run never blocks and never
// force-deletes. finishRun also gates confirm on its own `interactive` flag.
function realIo() {
  return {
    print: (m) => console.log(m),
    confirm: (question) => {
      if (!process.stdin.isTTY) return Promise.resolve(false);
      return new Promise((resolve) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        rl.question(question, (ans) => { rl.close(); resolve(/^y(es)?$/i.test(String(ans).trim())); });
      });
    },
  };
}

function conflictResolvers(cfg, orchDir) {
  const pool = cfg.main.conflictResolutionResolvers || [{ agent: "claude", model: null, effort: null }];
  if (pool.length < 2 || !orchDir) return pool;
  mkdirSync(orchDir, { recursive: true });
  const cursor = join(orchDir, "last-conflict-resolver");
  const last = existsSync(cursor) ? Number.parseInt(readFileSync(cursor, "utf8"), 10) : -1;
  const start = Number.isInteger(last) ? (last + 1) % pool.length : 0;
  writeFileSync(cursor, String(start));
  return pool.slice(start).concat(pool.slice(0, start));
}

function formatRole(spec, separator) {
  return [spec.agent, spec.model, spec.effort].filter(Boolean).join(separator);
}

function roleName(spec) {
  return formatRole(spec, " ");
}

function firstRoleOtherThan(agentName, ...roleLists) {
  return roleLists.flat().find((r) => r?.agent !== agentName) || null;
}

function roleSpecsFromAgents(agents = []) {
  return agents.map((agent) => ({ agent, model: null, effort: null }));
}

function conflictReviewerFor(cfg, resolver, resolvers) {
  return firstRoleOtherThan(
    resolver.agent,
    resolvers,
    cfg.reviewers ? parseRoleSpecs(cfg.reviewers) : [],
    (cfg.agents || []).map((agent) => ({ agent, model: null, effort: null })),
  );
}

function resetMergeAttempt(gitDep, integration, preSha) {
  gitDep.gitTry(["reset", "--hard", preSha], integration);
  gitDep.gitTry(["clean", "-fd"], integration);
}

function conflictPrompt(branch, base, conflicts, metaOnly) {
  const rules = metaOnly ? [
    "- Release metadata only: keep changelog entries in descending version order.",
    "- Use the highest version string consistently in package metadata and version source files.",
    "- Preserve both sides' non-duplicate release notes.",
  ] : [
    "- Act as a neutral third party; reconstruct both parents' intent from the conflict and surrounding code.",
    "- Preserve behavior from both sides unless they are truly incompatible.",
    "- Do not take one side wholesale when the other side added distinct behavior.",
  ];
  return [
    `Resolve this merge conflict on ${branch} after merging origin/${base}.`,
    "",
    "Rules:",
    ...rules,
    "- Do not edit unrelated files.",
    "",
    `Conflicted files: ${conflicts.join(", ")}`,
  ].join("\n");
}

function proposalComment({ conflicts, resolver, reviewer, verdict, mode }) {
  return [
    "agent-orch: conflict resolution needs human approval.",
    "",
    `Mode: ${mode}`,
    `Conflicted files: ${conflicts.join(", ")}`,
    `Resolver: ${roleName(resolver)}`,
    `Reviewer: ${roleName(reviewer)}`,
    "",
    "Reviewer result:",
    `${verdict.decision}: ${verdict.reason || "(no reason)"}`,
  ].join("\n");
}

export async function resolveIntegrationConflict(ctx, deps = { git, adapters, gate }) {
  const { repo, orchDir, cfg, branch, base, testCmd } = ctx;
  const gitDep = deps.git;
  const adaptersDep = deps.adapters;
  const gateDep = deps.gate;
  const mode = cfg.main.conflictResolution || (cfg.main.autoResolveConflicts ? "auto" : "manual");
  if (mode === "manual") return { ok: false, reason: "conflictResolution is manual" };
  const integration = gitDep.ensureIntegrationWorktree(repo, orchDir, branch, base);
  gitDep.syncWorktreeToIntegration(integration, branch);
  const fetched = gitDep.fetchOriginMain(repo, { base });
  if (!fetched.ok) return { ok: false, reason: fetched.reason };

  const target = `refs/remotes/origin/${base}`;
  const preSha = gitDep.git(["rev-parse", "HEAD"], integration);
  const fail = (reason, comment = null) => {
    resetMergeAttempt(gitDep, integration, preSha);
    return { ok: false, reason, comment };
  };

  let conflicts = [];
  const resolvers = conflictResolvers(cfg, orchDir);
  const allowed = new Set(cfg.main.autoResolveConflictPaths || []);
  try {
    let merge = gitDep.gitTry(["merge", "--no-edit", target], integration);
    if (merge.ok) {
      const result = gateDep.run(testCmd, integration);
      if (!result.pass) return fail("merged tree failed the test gate");
      gitDep.git(["push", "origin", branch], integration);
      return { ok: true, summary: `merged origin/${base} cleanly` };
    }

    for (const resolver of resolvers) {
      resetMergeAttempt(gitDep, integration, preSha);
      merge = gitDep.gitTry(["merge", "--no-edit", target], integration);
      if (merge.ok) {
        const result = gateDep.run(testCmd, integration);
        if (!result.pass) continue;
        gitDep.git(["push", "origin", branch], integration);
        return { ok: true, summary: `merged origin/${base} cleanly` };
      }
      // Same as changedFiles / #383: -z + NUL-split, via gitTry so .trim() cannot
      // collapse a leading-space path into a metaOnly whitelist hit.
      const listed = gitDep.gitTry(["diff", "--name-only", "-z", "--diff-filter=U"], integration);
      conflicts = listed.ok ? listed.out.split("\0").filter(Boolean) : [];
      if (!conflicts.length) return fail((merge.out || "merge failed").trim());

      const metaOnly = conflicts.length > 0 && conflicts.every((p) => allowed.has(p));
      const reviewer = conflictReviewerFor(cfg, resolver, resolvers);
      if (!reviewer && (!metaOnly || mode !== "auto")) return fail(`no conflict reviewer configured that differs from ${resolver.agent}`);
      const stageTimeoutMs = cfg.stageTimeout * 60_000;
      try {
        await adaptersDep.get(resolver.agent).author(conflictPrompt(branch, base, conflicts, metaOnly), integration, {
          model: resolver.model,
          effort: resolver.effort,
          stageTimeoutMs,
        });
      } catch (e) {
        continue;
      }

      const remainingListed = gitDep.gitTry(["diff", "--name-only", "-z", "--diff-filter=U"], integration);
      const remaining = remainingListed.ok ? remainingListed.out.split("\0").filter(Boolean) : [];
      if (remaining.length) continue;
      if (gitDep.gitTry(["rev-parse", "-q", "--verify", "MERGE_HEAD"], integration).ok) {
        gitDep.git(["commit", "--no-edit"], integration);
      }

      let verdict = { decision: "AGREE", reason: "metadata-only conflict resolved", raw: "" };
      if (reviewer) {
        verdict = await adaptersDep.get(reviewer.agent).audit(branch, integration, {
          model: reviewer.model,
          effort: reviewer.effort,
          stageTimeoutMs,
        });
      }
      if (verdict.decision !== "AGREE") {
        const comment = proposalComment({ conflicts, resolver, reviewer, verdict, mode });
        return fail(mode === "auto" ? `conflict resolution demoted to propose: ${verdict.reason || "reviewer was not confident"}` : "conflict resolution proposed for human approval", comment);
      }

      const result = gateDep.run(testCmd, integration);
      if (!result.pass) continue;
      const effectiveMode = metaOnly ? mode : "propose";
      if (effectiveMode === "propose") {
        return fail("conflict resolution proposed for human approval", proposalComment({ conflicts, resolver, reviewer, verdict, mode: effectiveMode }));
      }
      gitDep.git(["push", "origin", branch], integration);
      return { ok: true, summary: `resolved ${conflicts.join(", ")}` };
    }

    return fail("all conflict resolvers failed");
  } catch (e) {
    return fail(e.message || String(e));
  }
}

// `closes` (the GitHub issue an `orch issue` run works on) is stamped onto the
// runs.jsonl entries this cycle writes. runs.jsonl is the only per-branch record
// that BOTH outlives the finished cycle (resume, checkpoint and inflight records
// are all cleared on return) and carries the outcome, so it is what
// priorStagedBranches reads back on the next run.
//
// This wrapper is only a FALLBACK for call sites that state no issue (engine.js,
// which always records THIS cycle); a record that carries `closes` is left alone.
// One cycle can write records for OTHER issues: after it lands, finalize.js
// redrives every overlap-deferred peer under the same lock, and each peer carries
// its own `closes` — including an explicit `null` for an `orch task` peer, which
// has no issue at all. So the test is the key's PRESENCE, not a non-null value:
// stamping this run's number over either kind of peer record is exactly the
// cross-issue false attribution priorStagedBranches exists to prevent.
export function realDeps({ closes = null } = {}) {
  const notifyDep = closes
    ? { ...notify, recordRun: (dir, entry) => notify.recordRun(dir, "closes" in entry ? entry : { ...entry, closes }) }
    : notify;
  const ghDeps = {
    gh: ghShell,
    git: git.git,
    notify: notifyDep,
    log: (m) => process.stderr.write(`▶ ${m}\n`),
    resolveIntegrationConflict,
  };
  const githubDep = {
    demote: (ctx) => demote(ctx, ghDeps),
    openPr: (ctx) => openPr(ctx, ghDeps),
    openIntegrationPr: (ctx) => openIntegrationPr(ctx, ghDeps),
  };
  const finalizeDep = (ctx) => finalize(ctx, { git, gate, lock: { acquireBlocking, releaseLock }, inflight, github: githubDep, notify: notifyDep });
  return { adapters, git, gate, scope, notify: notifyDep, inflight, finalize: finalizeDep, checkpoint, reviewLog };
}
function dryDeps() {
  const verdict = { decision: "AGREE", reason: "(dry-run: assumed agree)", raw: "" };
  return {
    adapters: { get: (n) => ({ name: n, async author() {}, async audit() { return verdict; } }) },
    git: {
      createTaskBranch() {}, attachExistingBranch() {}, pruneWorktree() {},
      git() { return "(dry-run)"; },
      changedFiles() { return ["(dry-run)"]; },
    },
    gate: { detect: () => "true", run: () => ({ pass: true, log: "(dry-run)" }) },
    scope: { count: () => 0 },
    inflight: { setPaths() {} },
    finalize: async () => ({ status: "merged", reason: "dry-run", sha: "dry" }),
    // Dry-run must not pollute the real run history/KPIs.
    notify: { ...notify, writeRound() {}, writeRoundRaw() {}, recordRun() {} },
  };
}

function reviewersForAuthor(authorName, reviewerSpecs) {
  const others = reviewerSpecs.filter((s) => s.agent !== authorName);
  return others.length ? others : reviewerSpecs;
}

function roleLabel(spec) {
  return formatRole(spec, " · ");
}

function uniqueLabels(specs) {
  return [...new Set(specs.map(roleLabel))].join(", ");
}


export function runBanner(cfg, runs, opts = {}) {
  const { color = false, columns } = opts;
  const lbl = (t) => ({ code: C.label, text: t.padEnd(8) });
  const rows = [
    [lbl("agents"), { code: C.agents, text: cfg.agents.join(", ") }],
  ];
  for (const r of runs) {
    const seg = [lbl("author"), { code: C.author, text: roleLabel(r.author) }];
    if (r.resume) seg.push({ code: C.flag, text: "  ⏳ resume pending" });
    rows.push(seg);
  }
  const reviewers = uniqueLabels(runs.flatMap((r) => r.reviewers || []));
  rows.push([lbl("review"), { code: C.review, text: reviewers || "-" }]);
  rows.push([
    lbl("test"), { code: 0, text: cfg.test },
    { code: C.label, text: "   merge  " }, { code: 0, text: cfg.merge },
  ]);
  return box(` agent-orch ${DISPLAY_VERSION} `, rows, { color, columns });
}

export function maybePrintRunBanner(cfg, runs, flags, stdout = process.stdout) {
  if (flags["no-banner"] || !stdout.isTTY) return false;
  const color = colorEnabled(stdout);
  stdout.write(`${runBanner(cfg, runs, { color, columns: stdout.columns })}\n`);
  return true;
}

function hasEscalationDecision(orchDir, branch, sid, roundCap) {
  try {
    if (existsSync(join(notify.reviewsDir(orchDir, branch), "DECISION.md"))) return true;
    const ck = sid ? checkpoint.lookup(orchDir, sid) : null;
    return ck?.stage === "reviewed" && ck.decision === "DISAGREE" && Number(ck.round) >= Number(roundCap);
  }
  // Fail closed: an unreadable answer (e.g. notify.reviewsDir rejecting an unsafe
  // branch name) must not read as "never escalated". A needless re-author costs
  // tokens; resuming a branch two reviewers rejected costs the merge guarantee.
  catch { return true; }
}

// The author of a surviving committed branch to resume, or null. Scans resume
// records for this task across authors (#27): a hard kill rotates the pool, so the
// re-run's author no longer matches the record's per-author key. Returns the author
// only when its branch still exists, carries committed work, and isn't a live peer —
// or an already-escalated branch. The same staleness guards resolveTaskBranch
// re-applies before it actually resumes.
export function pinnedResumeAuthor(ctx, deps = { git, resume }) {
  const { orchDir, task, repo, dry = false, liveBranches = new Set(), baseBranch = "main", roundCap } = ctx;
  const { git: g, resume: r } = deps;
  if (dry) return null;
  const hit = r.lookupForTask(orchDir, task).find((rec) =>
    g.branchExists(repo, rec.branch) &&
    g.changedFiles(repo, rec.branch, baseBranch).length > 0 &&
    !liveBranches.has(rec.branch) &&
    !hasEscalationDecision(orchDir, rec.branch, rec.sid, roundCap));
  return hit ? hit.author : null;
}

// Pick the branch/sid for one author in task mode, resuming a quota-aborted run
// when one is on record (issue #24). Resume only when the recorded branch still
// exists, carries committed work, isn't a live peer's branch, and has not already
// escalated — otherwise the record is stale/terminal, so drop it and author fresh.
// A fresh run records its branch *before* the cycle; cli clears it after runCycle
// returns. The decision marker covers a process dying after escalation but before
// that cleanup, where reusing the branch would skip the new task/issue body.
// ponytail: the record key ignores sid, so two truly-concurrent identical-text
// tasks share one key and the later fresh start clobbers the record — same
// fixed-prompt collision spawnDocsTask already stamps around; sequential retry
// (the real case) resumes and never overwrites.
// §3a: read + shape-validate an untrusted work-order file. JSON only — a
// free-text file is rejected with a clear message (breaking change vs. the old
// free-text --file). Returns the validated work order or throws.
export function parseWorkOrderFile(path) {
  const raw = readFileSync(path, "utf8");
  let obj;
  try { obj = JSON.parse(raw); }
  catch { throw new Error(`--file must be a JSON work order {title, problem, repro_steps, suspected_paths, acceptance_criteria}: ${path}`); }
  const v = validateWorkOrder(obj);
  if (!v.ok) throw new Error(`invalid work order in ${path}:\n- ${v.errors.join("\n- ")}`);
  return v.workOrder;
}

// §3a: fetch a GitHub issue and shape-validate it as an UNTRUSTED work order —
// same path as parseWorkOrderFile, but the source is the issue title+body. `gh`
// is injected so tests stub the fetch with no network/auth. Returns the
// validated work order or throws.
// Fails fast with one clear error instead of letting a broken `gh` session
// surface as a raw, confusing error from whichever gh shell-out happens first
// (#136 — GitHub App auth 404 fell back to "ambient gh auth" with no check
// that the fallback was actually usable).
export function requireGhAuth(gh) {
  try { gh(["auth", "status"]); }
  catch (e) {
    throw new Error(`gh CLI is not authenticated — run \`gh auth login\` (${String(e.message || e).split("\n")[0]})`);
  }
}

export function fetchIssueWorkOrder(n, gh) {
  requireGh(gh);
  requireGhAuth(gh);
  const issue = JSON.parse(gh(["issue", "view", String(n), "--json", "number,title,body,state"]));
  if (issue.state && issue.state !== "OPEN") throw new Error(`issue #${issue.number} is ${issue.state}, not open`);
  const v = validateWorkOrder(issueToWorkOrder(issue));
  if (!v.ok) throw new Error(`issue #${n} did not map to a valid work order:\n- ${v.errors.join("\n- ")}`);
  return v.workOrder;
}

// Register before a cycle starts so the cap counts this run as well. The caller
// owns the exceeded-cap action because task fan-out skips while single runs throw.
export function registerWithConcurrencyCap(orchDir, sid, meta, cfg, { onExceeded = () => {} } = {}) {
  inflight.register(orchDir, sid, meta);
  const live = inflight.countLive(orchDir);
  if (live > cfg.concurrency) {
    inflight.deregister(orchDir, sid);
    onExceeded(live);
    return false;
  }
  return true;
}

function commentOnIssue(result, branch, closes, githubDepsFn) {
  if (!closes) return;
  try {
    const body = redact(buildIssueComment(result, branch));
    githubDepsFn().gh(["issue", "comment", String(closes), "--body-file", "-"], body);
  } catch (e) {
    console.error(`orch: could not comment on issue #${closes}: ${e.message}`);
  }
}

function remoteBranchRefExists(repo, branch) {
  return git.gitTry(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`], repo).ok;
}

export function resolveTaskBranch(ctx, deps = { git, resume }) {
  const { repo, orchDir, task, authorName, dry = false, liveBranches = new Set(), baseBranch = "main", roundCap } = ctx;
  const { git: g, resume: r } = deps;
  const found = dry ? null : r.lookup(orchDir, task, authorName);
  if (found && !liveBranches.has(found.branch)) {
    if (hasEscalationDecision(orchDir, found.branch, found.sid, roundCap)) {
      r.clear(orchDir, task, authorName); // terminal escalation must not be re-run as a resume
    } else if (g.branchExists(repo, found.branch) && g.changedFiles(repo, found.branch, baseBranch).length > 0) {
      return { sid: found.sid, branch: found.branch, resume: true };
    } else {
      r.clear(orchDir, task, authorName); // record points at a vanished/empty branch
    }
  }
  const sid = newSid();
  const branch = `pr/${authorName}/${slugify(task)}-${sid}`;
  if (!dry) r.record(orchDir, task, authorName, { branch, sid });
  return { sid, branch, resume: false };
}

// Branches an EARLIER run already staged for this issue, newest run per branch,
// so `orch issue <n>` can say "work for #n is already sitting here" instead of
// silently staging a second branch (most important after an escalation — that is
// exactly the work someone means to come back to).
//
// The join key is the ISSUE NUMBER, persisted on the run record by realDeps().
// It is deliberately NOT the branch slug: the slug comes from the issue TITLE,
// so editing the title between runs makes the old branch invisible, and two
// issues with the same title make one issue's run claim the other's branch.
// Records written before the number was persisted have nothing but the slug to
// go on — those are still reported, flagged `uncertain`, because a hedged
// "this may be yours" is honest where a slug guess presented as fact is not.
//
// Matching is per BRANCH, not per record: a branch's whole history is folded
// first, and the slug fallback applies only when NO record for it carries an
// issue number. Per-record matching reintroduced the false attribution this
// warning exists to prevent — a later `orch review <branch>` writes a record
// with no `closes` (review mode has no issue), so a same-titled issue would
// match that one record and claim a branch already known to belong to another.
export function priorStagedBranches({ repo, orchDir, closes, task }, deps = { git }) {
  let lines;
  try { lines = readFileSync(join(orchDir, "runs.jsonl"), "utf8").split("\n"); }
  catch { return []; } // no run history yet
  const slugPrefix = `${slugify(task)}-`;
  const byBranch = new Map();
  for (const line of lines) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; } // partial/corrupt line
    if (!e.branch) continue;
    const prev = byBranch.get(e.branch);
    // Newest record wins for the outcome, and for the issue number the newest
    // record that CARRIES one wins — a later untagged record (a review run)
    // never erases the number an earlier cycle stamped on this branch.
    byBranch.set(e.branch, {
      branch: e.branch, sid: e.sid, verdict: e.verdict, reason: e.reason,
      closes: e.closes != null ? Number(e.closes) : prev?.closes ?? null,
    });
  }
  const matched = [...byBranch.values()].filter((e) => {
    if (e.closes != null) return e.closes === Number(closes);
    const [, , tail] = e.branch.split("/"); // pr/<agent>/<slug>-<sid>
    return Boolean(tail) && tail.startsWith(slugPrefix);
  });
  // A branch that no longer exists is finished work, not staged work.
  return matched
    .map((e) => ({ ...e, uncertain: e.closes == null }))
    .filter((e) => deps.git.branchExists(repo, e.branch));
}

export function formatPriorStagedBranches(closes, entries) {
  if (!entries.length) return null;
  const out = [`orch: issue #${closes} already has ${entries.length} staged branch${entries.length === 1 ? "" : "es"} from an earlier run:`];
  for (const e of entries) {
    const reason = String(e.reason || "").split("\n")[0].slice(0, 120);
    const hedge = e.uncertain ? "  [no issue number recorded — matched by title, may belong to another issue]" : "";
    out.push(`  ${e.branch} — ${e.verdict || "unknown"}${reason ? `: ${reason}` : ""}${hedge}`);
    // NOT `orch continue <sid>`: that needs a checkpoint/inflight record, and
    // both are cleared once a cycle returns — so it cannot resume a run that
    // already reached a terminal status. `orch review` re-audits the branch.
    out.push(`    inspect: git log ${e.branch}   re-audit: orch review ${e.branch}`);
  }
  out.push("  this run stages a NEW branch. A re-run rotates the author and regenerates the diff, so a security-floor");
  out.push("  escalation repeats only if the fresh diff touches the same protected paths.");
  return out.join("\n");
}

// `orch agent build <name>` self-bootstraps a missing adapter: a work order
// describing the gap is fed through orch's own author→audit→test pipeline,
// following the src/adapters/claude.js / codex.js pattern.
function buildAdapterWorkOrder(name) {
  const wo = {
    title: `Add ${name} adapter for orch`,
    problem: `orch has no adapter for the "${name}" CLI: \`orch agent add ${name}\` fails with ` +
      `"unknown agent: ${name}". Add src/adapters/${name}.js following the ` +
      `src/adapters/claude.js / src/adapters/codex.js pattern (export an object with a \`name\`, ` +
      `a \`bin\`, an async \`author(prompt, worktree, opts)\`, and an async \`audit(branch, worktree, opts)\`), ` +
      `and register it in the REGISTRY in src/adapters/index.js.`,
    repro_steps: [`orch agent add ${name}`, `→ throws "unknown agent: ${name}"`],
    suspected_paths: [`src/adapters/${name}.js`, "src/adapters/index.js", "test/adapters.test.js"],
    acceptance_criteria: [
      `src/adapters/${name}.js exports an adapter matching the claude.js/codex.js shape`,
      `src/adapters/index.js REGISTRY registers "${name}"`,
      `adapters.get("${name}") no longer throws`,
      "tests cover the new adapter",
    ],
  };
  const v = validateWorkOrder(wo);
  if (!v.ok) throw new Error(`internal: generated adapter work order invalid: ${v.errors.join(", ")}`);
  return v.workOrder;
}

function reportAgentBuildResult(name, result, { withReason = false } = {}) {
  const detail = withReason
    ? ` (${result.reason}) on ${result.branch}`
    : result.branch ? ` on ${result.branch}` : "";
  console.log(`orch agent build ${name}: ${result.status}${detail}${costSuffix(result)}`);
  if (result.status === "approved") {
    console.log(`orch: review the diff, then \`orch agent add ${name}\` once it's merged into main`);
  }
  if (result.status === "escalated" || result.status === "merge-deferred") process.exitCode = 2;
}

// Runs the build as a normal task-mode cycle, isolated in its own worktree/branch
// (the same mechanism every `orch task` uses) since orch would be modifying its
// own source while running. Default: `noMerge` — the result sits on its local
// branch only (no PR, main untouched) so it can be reviewed before it's trusted.
// `--pr` instead forces `cfg.merge: "pr"` for this run only (never persisted to
// orch.yml), so an AGREE+green result opens a PR through the full gate instead.
export async function buildAgent(name, { repo, orchDir, flags = {}, deps = {} }) {
  try { adapters.get(name); return { status: "already-registered" }; } catch { /* proceed to build */ }
  const resolved = (deps.resolveAgentBin || resolveAgentBin)(name);
  if (!resolved) throw new Error(`orch: no CLI named "${name}" found on PATH — check for a typo`);

  const wo = buildAdapterWorkOrder(name);
  const task = wo.title;
  const authorPrompt = buildAuthorPrompt(wo);
  let cfg = applyRoleOverrides(load(repo, flags["config-file"]), flags);
  if (flags.pr) cfg = { ...cfg, merge: "pr" };
  const dry = Boolean(flags.dry) || process.env.ORCH_DRYRUN === "1";
  const preflightFn = deps.preflight || preflight;
  if (!dry) preflightFn(cfg, orchDir);

  let liveBranches = new Set();
  if (!dry) {
    const sync = git.syncMainFromOrigin(repo, cfg.baseBranch);
    if (!sync.ok) throw new Error(`orch: cannot start from stale ${cfg.baseBranch}: ${sync.reason}`);
    liveBranches = new Set(inflight.listLive(orchDir).map((e) => e.branch));
    resetKpiOnRecovery(orchDir, git.reclaimOrphanWorktrees(repo, orchDir, liveBranches, { base: cfg.baseBranch }));
  }

  const pinned = pinnedResumeAuthor({ repo, orchDir, task, dry, liveBranches, baseBranch: cfg.baseBranch, roundCap: cfg.roundCap });
  const { authors, reviewers } = nextAuthor(cfg, orchDir, pinned, dry);
  const authorSpec = authors[0];
  const authorName = authorSpec.agent;
  const { sid, branch, resume: isResume } = resolveTaskBranch({ repo, orchDir, task, authorName, dry, liveBranches, baseBranch: cfg.baseBranch, roundCap: cfg.roundCap });
  const reviewerList = reviewersForAuthor(authorName, reviewers);
  const run = {
    mode: "task", task, authorPrompt, branch, sid, resume: isResume, authorName, author: authorSpec,
    reviewerName: reviewerList[0].agent, reviewerNames: reviewerList.map((s) => s.agent),
    reviewers: reviewerList, noMerge: !flags.pr,
    cfg, orchDir, repo, worktree: join(orchDir, "wt", branch.replace(/\//g, "_")),
  };

  if (!dry) {
    const baseSha = git.git(["rev-parse", cfg.baseBranch], repo);
    registerWithConcurrencyCap(
      orchDir,
      sid,
      { branch, pid: process.pid, baseSha, author: authorSpec, reviewers: reviewerList },
      cfg,
      { onExceeded: (live) => { throw new Error(`orch: concurrency cap ${cfg.concurrency} reached — ${live} cycles live; try again shortly`); } },
    );
  }
  try {
    const result = await runCycle(run, dry ? dryDeps() : (deps.cycleDeps || realDeps()));
    if (!dry) { resume.clear(orchDir, task, authorName); checkpoint.clear(orchDir, sid); }
    return { ...result, branch };
  } finally {
    if (!dry) inflight.deregister(orchDir, sid);
  }
}

// Which flags each command actually reads. A flag parsed but never consumed by
// the command it was typed on is a lie about what the command will do — `orch
// issue 42 --merge` reads as "run and merge" while only `orch pr` consumes
// --merge. Rather than one bespoke guard per flag, every command declares its
// flag set here and one check rejects the rest. Entries are derived from what
// each dispatch branch actually reads, so adding a flag to a command means
// adding it here too. --help/--version are legal everywhere (see below).
// Commands with no entry (unknown input, which falls through to usage) are not
// validated.
export const COMMAND_FLAGS = {
  init: ["config-file", "link"],
  config: ["config-file"],
  // `agent add <unregistered>` offers to build, and hands buildAgent the same
  // flags as `agent build` — so both subcommands share one flag set.
  agent: ["config-file", "dry", "pr", "author", "authors", "reviewer", "reviewers"],
  task: ["config-file", "dry", "file", "cheap", "allow-protected", "no-tidy", "no-banner", "author", "authors", "reviewer", "reviewers"],
  issue: ["config-file", "dry", "cheap", "allow-protected", "no-tidy", "no-banner", "author", "authors", "reviewer", "reviewers"],
  review: ["config-file", "dry", "cheap", "no-tidy", "no-banner", "author", "authors", "reviewer", "reviewers"],
  continue: ["config-file", "dry", "no-tidy", "author", "authors", "reviewer", "reviewers"],
  pr: ["config-file", "merge", "author", "authors", "reviewer", "reviewers"],
  release: [],
  dashboard: ["json", "limit", "check-history", "once", "plain", "refresh-ms"],
  completion: [],
  upgrade: ["check"],
  update: ["check"],
  mcp: [],
  version: [],
  help: [],
};

// `--help`/`--version` short-circuit main() before any command runs, so they are
// the *effective* command whenever present: `orch pr 42 --merge --help` prints
// usage and exits 0 having merged nothing. Asking to merge and asking what the
// tool is are contradictory requests; neither silently wins.
export function checkFlags(command, flags) {
  const effective = flags.help ? "help" : flags.version ? "version" : command;
  const allowed = COMMAND_FLAGS[effective];
  if (!allowed) return;
  for (const name of Object.keys(flags)) {
    if (name === "help" || name === "version" || allowed.includes(name)) continue;
    const valid = Object.keys(COMMAND_FLAGS).filter((c) => COMMAND_FLAGS[c].includes(name));
    throw new Error(
      `--${name} is not valid with 'orch ${effective}'` +
      (valid.length ? ` — only with: ${valid.map((c) => `orch ${c}`).join(", ")}` : " — it is not a flag of any command"),
    );
  }
}

export async function main(argv, deps = {}) {
  const { command, rest, flags } = parse(argv);
  // First statement after parse deliberately: behind any early return
  // (version/help/upgrade) a misapplied flag is still dropped silently.
  checkFlags(command, flags);

  if (command === "__update-check-child") {
    await runUpdateCheckChild({ current: rest[0] || VERSION, cacheDir: rest[1] });
    return;
  }

  // `mcp` dispatches before anything that can print: on this command stdout is
  // a JSON-RPC transport, so one stray update banner would corrupt the protocol
  // stream. Early return also skips the GitHub App token mint below — each
  // cycle the server spawns does its own auth.
  if (command === "mcp") {
    await serve({ repo: process.cwd() });
    return;
  }

  if (flags.version || command === "version") { console.log(DISPLAY_VERSION); return; }
  if (flags.help || command === "help") { printUsage(); return; }
  if (command === "upgrade" || command === "update") {
    await runUpgrade({ flags, stdout: deps.stdout || process.stdout, ...deps.upgradeDeps });
    return;
  }

  const repo = process.cwd();
  const orchDir = join(repo, ".orch");

  if (!flags.dry && command && command !== "completion") {
    maybeNotifyUpdate({ current: VERSION, json: Boolean(flags.json) }).catch(() => {});
  }

  // Optional GitHub App auth: if ORCH_APP_ID + ORCH_APP_PRIVATE_KEY are set,
  // mint a short-lived installation token and expose it to every `gh` shell-out
  // via GH_TOKEN (execFileSync inherits process.env). orch then acts as
  // orch[bot]. Falls back to ambient `gh auth` when unset or on any failure —
  // never a hard dependency. An explicit GH_TOKEN wins and skips minting.
  // ponytail: process.env mutation at the CLI entrypoint; the lazy correct wiring.
  const appCreds = !process.env.GH_TOKEN && appCredsFromEnv();
  if (appCreds) {
    try {
      const origin = git.gitTry(["remote", "get-url", "origin"], repo);
      if (origin.ok) {
        const slug = parseRepoSlug(origin.out);
        process.env.GH_TOKEN = await installationToken({ ...appCreds, ...slug });
      } else if (!/No such remote ['"]?origin['"]?/.test(origin.out)) {
        throw new Error(origin.out.trim() || "git remote get-url origin failed");
      }
    } catch (e) {
      process.stderr.write(`▶ orch: GitHub App auth unavailable (${e.message}); using ambient gh auth\n`);
    }
  }
  // preflight checks agent CLIs; tests stub it so the suite is green in a
  // CLI-less environment (e.g. clean CI). Production passes none.
  const preflightFn = deps.preflight || preflight;

  if (command === "init") {
    // Preflight first, writability-only: it probes .orch/ and fails with a
    // clear message before any real write, so a read-only repo never surfaces
    // a raw EACCES from the mkdir/writeFile below. `agents: []` skips the
    // fatal agent-CLI check — init's whole point is to report installed CLIs
    // non-fatally via detectAgents() below, not require them up front.
    // load() tolerates a missing config.
    const cfg = load(repo, flags["config-file"]);
    preflightFn({ agents: [] }, orchDir);
    mkdirSync(orchDir, { recursive: true });
    const ex = join(orchDir, "orch.yml");
    if (!existsSync(ex) && !existsSync(join(repo, "orch.yml"))) {
      writeFileSync(ex, SCAFFOLD);
    }
    writeFileSync(join(orchDir, "ORCH.md"), ORCH_DOC);
    console.log("orch: initialized (.orch/orch.yml, .orch/ORCH.md).");
    const detectFn = deps.detectAgents || detectAgents;
    console.log(`orch: ${formatDetection(detectFn())}`);
    if (flags.link) {
      const touched = linkOrchDoc(repo, cfg.agents);
      console.log(`orch: linked .orch/ORCH.md into ${touched.join(", ")}`);
    } else {
      console.log("orch: tip — to auto-load orch usage each session, point your agent");
      console.log("  file (CLAUDE.md / AGENTS.md / GEMINI.md) at it, e.g. add `@.orch/ORCH.md`,");
      console.log("  or re-run `orch init --link` to wire it in for you.");
    }
    return;
  }

  if (command === "config") {
    await runConfigWizard({
      repo,
      configFile: flags["config-file"],
      stdin: deps.stdin || process.stdin,
      stdout: deps.stdout || process.stdout,
      inputStart: deps.inputStart,
    });
    return;
  }

  if (command === "agent") {
    if (rest[0] === "build") {
      const name = rest[1];
      if (!name) throw new Error("usage: orch agent build <name> [--pr]");
      const buildFn = deps.buildAgent || buildAgent;
      const result = await buildFn(name, { repo, orchDir, flags, deps });
      if (result.status === "already-registered") { console.log(`orch: ${name} already registered`); return; }
      reportAgentBuildResult(name, result, { withReason: true });
      return;
    }

    // `orch agent add <name>` appends a known agent to the `agents:` rotation
    // pool in orch.yml, preserving the file's comments. Only registered agents
    // are accepted so the next run's preflight stays valid; an unregistered
    // name offers to build it (interactive only — see `buildAgent`).
    if (rest[0] !== "add" || !rest[1]) throw new Error("usage: orch agent add <name> | orch agent build <name> [--pr]");
    const name = rest[1];
    try {
      adapters.get(name); // throws "unknown agent: <name>" for unregistered names
    } catch (e) {
      const io = deps.io || realIo();
      const answer = await io.confirm(`orch: '${name}' is not a registered agent — build it now? (y/N) `);
      if (!answer) throw e;
      const buildFn = deps.buildAgent || buildAgent;
      const result = await buildFn(name, { repo, orchDir, flags, deps });
      reportAgentBuildResult(name, result);
      return;
    }
    const file = configPath(repo);
    if (!existsSync(file)) throw new Error("no orch.yml — run `orch init` first");
    if (load(repo).agents.includes(name)) { console.log(`orch: ${name} already in agents`); return; }
    const text = readFileSync(file, "utf8");
    // Two on-disk shapes: inline flow (`agents: [claude, codex]`) and the
    // scaffold's block sequence (`agents:\n  - claude\n  - codex`). Support both
    // so `agent add` edits either without a full YAML round-trip (which would
    // strip the file's comments).
    const inlineRe = /^(agents:\s*\[)([^\]]*)(\])/m;
    if (inlineRe.test(text)) {
      writeFileSync(file, text.replace(inlineRe, (_m, open, inner, close) =>
        `${open}${inner.trim() ? inner.trim() + ", " : ""}${name}${close}`));
    } else {
      const updated = appendAgentToBlockList(text, name);
      if (!updated) throw new Error("could not find `agents:` list in orch.yml — add it manually");
      writeFileSync(file, updated);
    }
    console.log(`orch: added ${name} to agents`);
    return;
  }

  if (command === "task" || command === "review" || command === "issue") {
    // D2: reviewer-only is meaningful for task/issue too ("rotate author, force this
    // reviewer"), matching review/continue/pr and the printUsage example.
    let cfg = applyRoleOverrides(load(repo, flags["config-file"]), flags, { allowReviewerOnly: true });
    const dry = Boolean(flags.dry) || process.env.ORCH_DRYRUN === "1";

    // F3: operator kill switch + one-cycle-at-a-time lock.
    if (isPaused(orchDir)) throw new Error(".orch/pause present — orchestration paused");

    // `issue` is a task whose work order is fetched from a GitHub issue; it runs
    // the identical author→audit→test→merge cycle, plus `Closes #N` on the merge.
    const mode = command === "issue" ? "task" : command; // "task" | "review"
    let task, authorPrompt, reviewBranch, closes = null, workOrder = null;
    if (command === "issue") {
      const n = rest[0];
      if (!/^\d+$/.test(String(n || ""))) throw new Error("usage: orch issue <number> [--author ... --reviewer ...]");
      const wo = fetchIssueWorkOrder(n, (deps.githubDeps || githubDeps)().gh);
      task = wo.title;
      authorPrompt = buildAuthorPrompt(wo);
      closes = Number(n);
      workOrder = wo;
      // Warn only — never block: the operator decides whether to resume, inspect
      // or stage another branch.
      const prior = priorStagedBranches({ repo, orchDir, closes, task });
      if (prior.length) console.log(formatPriorStagedBranches(closes, prior));
    } else if (mode === "task") {
      // §3a/§3b: a --file task is UNTRUSTED intake — it must be a JSON work order,
      // validated for shape, then wrapped in a neutralized fence the author treats
      // as reference, not instructions. Free-text `orch task "..."` (operator-typed,
      // trusted) is unchanged. `task` stays a short human label (drives slug/resume);
      // `authorPrompt` is what the author actually sees.
      if (flags.file) {
        // A stray positional next to --file is ambiguous (two task sources);
        // reject it instead of silently dropping the typed text.
        if (rest.length) throw new Error("orch task --file takes no positional task text — put the task in the work-order file");
        const wo = parseWorkOrderFile(flags.file);
        task = wo.title;
        authorPrompt = buildAuthorPrompt(wo);
        workOrder = wo;
      } else {
        task = rest.join(" ");
        authorPrompt = task;
      }
      if (!task) throw new Error('usage: orch task "describe the change" (or --file work-order.json)');
    } else {
      reviewBranch = rest[0];
      if (!reviewBranch) throw new Error("usage: orch review <branch>");
    }

    // §3c intake scan (#394): a task whose text names a protected path almost
    // always requires a change to it — and orch can never land one, since the
    // security scan's `guardrail-touch` floor (security-review.js) escalates
    // such a diff on the first otherwise-agreeing round. Running
    // anyway burns a full author + audit cycle and ends in a "stalemate" that
    // was structurally decided at intake. Refuse now, with the path and the
    // remedy in the message. Literal scan, not intent detection: an incidental
    // mention can be reworded, a required change must be hand-landed.
    //
    // #395: the scan is deliberately literal, so it cannot tell "delete
    // package.json" from "orch reads the version from package.json" — and
    // several protected entries (package.json, package-lock.json) are named in
    // passing by perfectly ordinary work orders. A refusal with no way past it
    // would turn that false positive into a lockout, so `--allow-protected` is
    // the operator's explicit acknowledgement that they have read the mention
    // and judged it incidental (or accepted that the result must be
    // hand-landed). It only skips THIS intake scan: a diff that really touches
    // a protected path is still stopped before the merge — `scanDiff`'s
    // `guardrail-touch` floor escalates first (engine.js), and `checkPaths` on
    // the final diff is the backstop behind it — so the override can waste a
    // cycle but can never land a guardrail change.
    if (mode === "task") {
      const intakeText = workOrder
        ? [workOrder.title, workOrder.problem, ...workOrder.repro_steps, ...workOrder.suspected_paths, ...workOrder.acceptance_criteria].join("\n")
        : task;
      const mentions = findProtectedMentions(intakeText);
      if (mentions.length && flags["allow-protected"]) {
        console.error(
          `orch: --allow-protected: proceeding despite protected-path mention(s): ${mentions.join(", ")}\n` +
          `      if the change really needs to touch one, the merge-time guard will still refuse it.`,
        );
      } else if (mentions.length) {
        throw new Error(
          `refusing to run: the task names protected path(s): ${mentions.join(", ")}\n` +
          `orch cannot author changes to protected paths — the review-time guard rejects such a diff, ` +
          `so this run could only end in stalemate. Make the change directly (hand-land it), ` +
          `reword the task if the mention is incidental, or pass --allow-protected to run anyway.`,
        );
      }
    }

    // Cheap-agent dispatch: --cheap forces cfg.cheap.role ad hoc; without the
    // flag, a work order whose suspected_paths all match cfg.cheap.paths routes
    // the same way automatically. Resolved here (after the work order, before
    // preflight) so the agent CLI it picks is the one preflight actually checks.
    cfg = applyCheapOverride(cfg, flags, workOrder);
    if (!dry) preflightFn(cfg, orchDir); // dry-run never shells out, so don't require CLIs
    // Any task/review run that lands a merge can still reach a `gh` shell-out:
    // cfg.merge === "pr" and autoMergePr obviously need it, but so does the
    // DEFAULT no-ff/ff-only path — finalize.js's openIntegrationPr opens/updates
    // the persistent integration→main PR after every successful local merge,
    // not just merge:"pr" runs (codex review round 1 on this fix caught that
    // the original gate missed this, letting a plain `orch task` still hit a
    // late gh failure after burning a full cycle). openIntegrationPr itself
    // only calls gh when a remote AND the gh CLI are both present — mirror
    // that same guard here so a fully local repo (no remote configured, no
    // PR bridge intended) isn't forced to have a gh session at all.
    if (!dry) {
      const { gh, git: ghGit } = (deps.githubDeps || githubDeps)();
      if (hasRemote(repo, ghGit) && ghAvailable(gh)) requireGhAuth(gh);
    }

    // Main is a GitHub mirror; task mode fast-forwards it from origin before
    // branches are based on it. Reclaim orphaned
    // worktrees BEFORE picking branches so resume resolution (#24) sees
    // post-reclaim truth — a hard-killed orphan branch is already gone by then,
    // so resume safely degrades to a fresh start instead of attaching a dead ref.
    let liveBranches = new Set();
    if (!dry) {
      if (mode === "task") {
        const sync = git.syncMainFromOrigin(repo, cfg.baseBranch);
        if (!sync.ok) throw new Error(`orch: cannot start from stale ${cfg.baseBranch}: ${sync.reason}`);
        if (sync.updated) console.log(`orch: fast-forwarded local ${cfg.baseBranch} from origin/${cfg.baseBranch}`);
      }
      liveBranches = new Set(inflight.listLive(orchDir).map((e) => e.branch));
      // PID-aware + inflight-branch-aware: clears dead cycles, spares live peers.
      resetKpiOnRecovery(orchDir, git.reclaimOrphanWorktrees(repo, orchDir, liveBranches, { base: cfg.baseBranch }));
    }

    let runs;
    if (mode === "task") {
      // Pin the author of a surviving committed branch from a prior killed run so the
      // rotation pool resumes it instead of authoring fresh under the next agent (#27).
      // resolveTaskBranch re-validates below; this only steers author selection.
      const pinned = pinnedResumeAuthor({ repo, orchDir, task, dry, liveBranches, baseBranch: cfg.baseBranch, roundCap: cfg.roundCap });
      const { authors, reviewers } = nextAuthor(cfg, orchDir, pinned, dry);
      runs = authors.map((authorSpec) => {
        const authorName = authorSpec.agent;
        const { sid, branch, resume } = resolveTaskBranch({ repo, orchDir, task, authorName, dry, liveBranches, baseBranch: cfg.baseBranch, roundCap: cfg.roundCap });
        const reviewerList = reviewersForAuthor(authorName, reviewers);
        return {
          mode, task, authorPrompt, closes, branch, sid, resume, authorName, author: authorSpec,
          reviewerName: reviewerList[0].agent, reviewerNames: reviewerList.map((s) => s.agent),
          reviewers: reviewerList,
          cfg, orchDir, repo, worktree: join(orchDir, "wt", branch.replace(/\//g, "_")),
        };
      });
    } else {
      const branch = reviewBranch;
      // audit-only: reviewers default to all agents except branch author. authorName unused by engine.
      const branchAuthor = branch.split("/")[1];
      const configured = configuredReviewers(cfg);
      const reviewers = reviewersForAuthor(branchAuthor, configured || roleSpecsFromAgents(cfg.agents));
      const authorName = branchAuthor && cfg.agents.includes(branchAuthor) ? branchAuthor : cfg.agents[0];
      task = null;
      const sid = newSid();
      runs = [{
        mode, task, branch, sid, authorName, author: { agent: authorName, model: null, effort: null },
        reviewerName: reviewers[0].agent, reviewerNames: reviewers.map((s) => s.agent),
        reviewers,
        cfg, orchDir, repo, worktree: join(orchDir, "wt", branch.replace(/\//g, "_")),
      }];
    }

    maybePrintRunBanner(cfg, runs, flags, deps.stdout);
    if (!dry && runs.some((run) => run.resume)) notify.resetKpi(orchDir);

    const results = [];
    const mergedBranches = []; // cycle branches that actually landed on integration
    const prUrls = [];
    for (const run of runs) {
      if (!dry) {
        const baseSha = git.git(["rev-parse", cfg.baseBranch], repo);
        const accepted = registerWithConcurrencyCap(
          orchDir,
          run.sid,
          { branch: run.branch, pid: process.pid, baseSha, closes: run.closes || null, author: run.author, reviewers: run.reviewers },
          cfg,
          { onExceeded: (live) => {
            console.log(`orch: concurrency cap ${cfg.concurrency} reached — ${live} cycles live; skipping ${run.branch}`);
            process.exitCode = 2;
          } },
        );
        if (!accepted) {
          continue;
        }
      }
      try {
        const result = await runCycle(run, dry ? dryDeps() : (deps.cycleDeps || (deps.realDeps || realDeps)({ closes: run.closes })));
        results.push(result);
        // Cycle returned (any terminal status) → drop the resume + checkpoint records.
        // A quota throw skips this line, leaving both for the next run to resume (#24).
        // Checkpoints clear for every mode: review/pr cycles write reviewed/tested
        // checkpoints too, and a completed run left dangling would read as
        // "died mid-flight" on the dashboard.
        if (!dry) {
          if (run.mode === "task") resume.clear(orchDir, run.task, run.authorName);
          checkpoint.clear(orchDir, run.sid);
        }
        console.log(summaryLine(result, run.branch, dry, cleanStreakSuffix(orchDir, dry), colorEnabled(process.stdout), run.closes));
        if (result.status === "merged" && run.mode === "task") mergedBranches.push(run.branch);
        if (result.prUrl) prUrls.push(result.prUrl);
        if (result.status === "escalated" || result.status === "merge-deferred") {
          process.exitCode = 2;
          // Issue bridge: leave a trace on the source issue — headless runs have
          // no one watching stdout, and the DECISION.md file is local-only.
          if (!dry) commentOnIssue(result, run.branch, run.closes, deps.githubDeps || githubDeps);
        }
      } finally {
        if (!dry) inflight.deregister(orchDir, run.sid);
      }
    }
    // After the cycles: the detached docs-update runs `orch task`, so spawn it
    // outside the loop. maybeSpawnDocs only fires on a real `merged` result.
    let docsPending = false;
    for (const result of results) docsPending = maybeSpawnDocs(result, cfg, { dry, spawn: deps.spawn }, orchDir) || docsPending;

    // #44: a human is at the terminal — tidy up the branches/state orch created and
    // explain it in plain English, instead of dead-ending in an opaque git state.
    // Default on; `--no-tidy` opts out. finishRun is idempotent, so the detached
    // docs child (which re-runs `orch task`) safely tidies itself when it lands.
    if (!dry && !flags["no-tidy"] && mergedBranches.length) {
      const finishFn = deps.finishRun || finishRun;
      const io = deps.io || realIo();
      const runStats = results.flatMap((r) => r.runStats || []);
      await finishFn(
        { repo, orchDir, task, merged: mergedBranches, interactive: Boolean(process.stdin.isTTY), docsPending, runStats, integrationBranch: cfg.integrationBranch, prUrls },
        { git, io, notify },
      );
    }
    return;
  }

  if (command === "continue") {
    const sid = rest[0];
    if (!sid) throw new Error("usage: orch continue <sid>");
    const cfg = applyRoleOverrides(load(repo, flags["config-file"]), flags, { allowReviewerOnly: true });
    const dry = Boolean(flags.dry) || process.env.ORCH_DRYRUN === "1";
    if (isPaused(orchDir)) throw new Error(".orch/pause present — orchestration paused");
    // Preflight (adapter registered + CLI on PATH + .orch/ writable) runs below,
    // once the resume's actual author/reviewer agents are known — see the
    // `opts.only` comment on preflight() for why this can't run against the
    // full current orch.yml pool here.
    // A hard-killed prior attempt at this sid can leave its worktree checked out
    // under .orch/wt with a dead owner pid — reclaim it BEFORE reattaching the
    // branch, same as `task`/`pr` do at cycle start, or `runCycle`'s worktree
    // setup collides with the orphaned checkout. liveBranches spares real peers.
    // Checkpoint is authoritative (survives whatever killed the process — stage
    // timeout, adapter crash, hung stdio); inflight is only a fallback for a run
    // that died before its first review round wrote a checkpoint. Read both
    // BEFORE listLive() below: listLive() prunes any inflight record whose owner
    // pid is dead — exactly the case a died-before-checkpoint resume needs to
    // read. Reading listLive() first would delete this sid's own inflight record
    // before inflight.lookup() got a chance to see it (#129).
    const ck = checkpoint.lookup(orchDir, sid);
    const inf = ck ? null : inflight.lookup(orchDir, sid);

    if (!dry) {
      const liveEntries = inflight.listLive(orchDir);
      // Codex review (#125 stalemate): a sid that already has a live, alive-pid
      // inflight entry is genuinely running right now — a second `continue` (or
      // a `continue` racing the original `task`/`issue` run) would overwrite that
      // entry's inflight file out from under it and collide on the same worktree
      // path. Refuse rather than clobber.
      const stillLive = liveEntries.find((e) => e.sid === sid);
      if (stillLive) throw new Error(`orch: sid ${sid} already has a live run (pid ${stillLive.pid}) — refusing to attach a second`);
      const liveBranches = new Set(liveEntries.map((e) => e.branch));
      resetKpiOnRecovery(orchDir, git.reclaimOrphanWorktrees(repo, orchDir, liveBranches, { base: cfg.baseBranch }));
    }
    const branch = ck?.branch || inf?.branch;
    if (!branch) throw new Error(`orch: no checkpoint or inflight record for sid ${sid} — nothing to resume`);
    if (!git.branchExists(repo, branch)) {
      if (remoteBranchRefExists(repo, branch)) throw new Error(`orch: branch ${branch} (sid ${sid}) exists only as origin/${branch}; check it out locally before continuing`);
      if (!dry) {
        if (ck) checkpoint.clear(orchDir, sid);
        if (inf) inflight.deregister(orchDir, sid);
        console.log(`orch: branch ${branch} (sid ${sid}) no longer exists; cleared stale resume state`);
        return;
      }
      throw new Error(`orch: branch ${branch} (sid ${sid}) no longer exists`);
    }
    // A pre-authoring checkpoint or inflight-only fallback may represent a run
    // that died before the author committed anything — neither record proves
    // there's work to review/merge until the branch has a committed diff.
    if ((inf || ck?.stage === "started") && git.changedFiles(repo, branch, cfg.baseBranch).length === 0) {
      if (!dry && ck) checkpoint.clear(orchDir, sid);
      throw new Error(`orch: branch ${branch} (sid ${sid}) has no committed changes — the run died before authoring finished; start a fresh \`orch task\` instead`);
    }

    // Codex review (#125 stalemate): `cfg.agents` is only the rotation pool —
    // a branch can legitimately be authored by a fixed `author:`/`--author`
    // role outside that pool (e.g. `author: qwen3-coder-30b` with
    // `agents: [claude, codex]`), which existing config/tests already allow.
    // The real validity check is whether the name has a registered adapter.
    const authorName = branch.split("/")[1];
    if (!authorName) throw new Error(`orch: cannot determine an author from branch ${branch}`);
    try { adapters.get(authorName); }
    catch { throw new Error(`orch: cannot determine a registered author from branch ${branch}`); }
    // The original run persisted its resolved author/reviewer role specs (agent
    // + model + effort, not just names) into the checkpoint/inflight record —
    // reuse those by default so a resume picks up the same models the original
    // run used, rather than re-resolving against whatever orch.yml/rotation say
    // *now* (which may have moved on since the original run started). An
    // explicit --reviewer(s) on this command overrides for this resume only —
    // it never rewrites the persisted record. --author is not overridable here:
    // the branch's commits were already authored by a specific agent.
    const persistedAuthor = ck?.author || inf?.author;
    const authorSpec = persistedAuthor && persistedAuthor.agent === authorName
      ? persistedAuthor : { agent: authorName, model: null, effort: null };
    const reviewerOverride = flags.reviewers != null || flags.reviewer != null;
    const persistedReviewers = ck?.reviewers?.length ? ck.reviewers : inf?.reviewers?.length ? inf.reviewers : null;
    let reviewers;
    if (!reviewerOverride && persistedReviewers) {
      reviewers = persistedReviewers;
    } else {
      const configured = configuredReviewers(cfg);
      reviewers = reviewersForAuthor(authorName, configured || roleSpecsFromAgents(cfg.agents));
    }
    if (!dry) preflightFn(cfg, orchDir, { only: [authorSpec.agent, ...reviewers.map((r) => r.agent)] });

    // Codex review (#125 stalemate): an `orch issue <n>` run stamps `Closes #n`
    // at merge time via ctx.closes — reconstruct it here too, or a resumed
    // issue-bridge cycle merges without ever closing the issue. checkpoint is
    // authoritative once a round has completed; the inflight fallback covers a
    // death before that.
    const closes = ck?.closes ?? inf?.closes ?? null;

    const run = {
      // No original task text survives in the checkpoint/inflight record, so
      // `task` falls back to the branch name — changelogEntry() and the
      // terminal summary both read `task`; the raw "continue <sid>" command
      // is not a meaningful changelog/summary label.
      mode: "task", task: branch, branch, sid, resume: true, closes,
      authorName, author: authorSpec,
      reviewerName: reviewers[0].agent, reviewerNames: reviewers.map((s) => s.agent),
      reviewers,
      // Codex review (#126 stalemate): `reviewers` above is what this resume
      // actually audits with — an explicit `--reviewer` override applies for
      // this run only. `persistReviewers` is what engine.js writes back into
      // the checkpoint if this run dies before finishing — always the
      // ORIGINAL persisted roles when one exists, so a killed-mid-override
      // resume can't quietly make the override permanent (see the persistCase
      // fallback to `reviewers` in engine.js: only matters when no persisted
      // record existed yet, in which case there's nothing to protect).
      persistReviewers: persistedReviewers || reviewers,
      // Codex review (#126 stalemate, round 3): a checkpoint already at
      // "reviewed"/"tested" caches the OLD verdict; without this flag
      // engine.js would trust that cached verdict and skip the audit call
      // entirely, so the overridden reviewer would never actually run.
      reviewerOverride,
      cfg, orchDir, repo, worktree: join(orchDir, "wt", branch.replace(/\//g, "_")),
    };

    if (!dry) {
      const baseSha = git.git(["rev-parse", cfg.baseBranch], repo);
      // Codex review (#126 stalemate, round 2): this is `continue`'s OWN
      // inflight re-registration for the resume attempt itself — if the
      // original run only ever got as far as an inflight record (died before
      // its first checkpoint), this is the only remaining place a NEXT
      // `continue` will read persisted roles from. Must use the protected
      // persistReviewers here too, not the possibly-overridden `reviewers`,
      // or the same override-permanence bug just resurfaces via the
      // inflight-only recovery path instead of the checkpoint path.
      registerWithConcurrencyCap(
        orchDir,
        sid,
        { branch, pid: process.pid, baseSha, closes, author: authorSpec, reviewers: run.persistReviewers },
        cfg,
        { onExceeded: (live) => { throw new Error(`orch: concurrency cap ${cfg.concurrency} reached — ${live} cycles live; try again shortly`); } },
      );
    }
    try {
      const result = await runCycle(run, dry ? dryDeps() : (deps.cycleDeps || realDeps({ closes })));
      if (!dry) {
        checkpoint.clear(orchDir, sid);
        // Codex review (#125 stalemate): the original `orch task` run that
        // authored this branch wrote a resume.js record (task text + author →
        // branch) BEFORE it ever ran, so a crash mid-cycle leaves it for a retry
        // to pick up. `continue` doesn't know that original task text, so it
        // can't call resume.clear() by key — scan by branch instead, or a later
        // `orch task` with the same text would reattach this already-terminal
        // branch instead of authoring fresh.
        resume.clearForBranch(orchDir, branch);
      }
      console.log(summaryLine(result, branch, dry, "", colorEnabled(process.stdout), closes));
      // Codex review (#125 stalemate): `continue` forked its own terminal
      // handling instead of reusing the shared `task`/`issue` tail, and dropped
      // two of its side effects for a resumed cycle — the detached docs-update
      // spawn on a real merge, and the issue-bridge comment (closes is now
      // restored, see above) on escalation/merge-deferred. Both restored here,
      // matching the shared loop at the `task`/`issue` command above.
      if (!dry) maybeSpawnDocs(result, cfg, { dry, spawn: deps.spawn }, orchDir);
      if (result.status === "merged" && !dry && !flags["no-tidy"]) {
        const finishFn = deps.finishRun || finishRun;
        const io = deps.io || realIo();
        await finishFn(
          { repo, orchDir, task: run.task, merged: [branch], interactive: Boolean(process.stdin.isTTY), runStats: result.runStats || [], integrationBranch: cfg.integrationBranch, prUrls: result.prUrl ? [result.prUrl] : [] },
          { git, io, notify },
        );
      }
      if (result.status === "escalated" || result.status === "merge-deferred") {
        process.exitCode = 2;
        if (!dry) commentOnIssue(result, branch, closes, deps.githubDeps || githubDeps);
      }
    } finally {
      if (!dry) inflight.deregister(orchDir, sid);
    }
    return;
  }

  if (command === "pr") {
    const cfg = applyRoleOverrides(load(repo, flags["config-file"]), flags, { allowReviewerOnly: true });
    const n = rest[0];
    if (!/^\d+$/.test(String(n || ""))) throw new Error("usage: orch pr <number> [--merge]");
    preflightFn(cfg, orchDir);
    requireGhAuth((deps.githubDeps || githubDeps)().gh);
    if (isPaused(orchDir)) throw new Error(".orch/pause present — orchestration paused");
    if (!acquireLock(orchDir)) throw new Error(".orch/lock held — another cycle is running");
    resetKpiOnRecovery(orchDir, git.reclaimOrphanWorktrees(repo, orchDir, undefined, { base: cfg.baseBranch })); // clear orphans from a crashed prior cycle
    try {
      const result = await runPr(
        { n, repo, orchDir, cfg, merge: Boolean(flags.merge) },
        githubDeps(),
      );
      console.log(`orch pr #${n}: ${result.status} (${result.reason}) after ${result.rounds} round(s)${costSuffix(result)}`);
      if (result.status !== "approved") process.exitCode = 2;
    } finally {
      releaseLock(orchDir);
    }
    return;
  }

  if (command === "completion") {
    if (rest[0] === "install") {
      const result = installCompletion();
      if (result.ok) {
        console.log(`orch: wrote completion script to ${result.path}`);
        console.log(`orch: add this line to your ~/.bashrc to enable it:`);
        console.log(`  source "${result.path}"`);
      } else {
        console.log(`orch: could not install completion script (${result.reason})`);
      }
      return;
    }
    console.log(BASH_COMPLETION);
    return;
  }

  if (command === "dashboard") {
    const historyLimit = flags.limit ? Number(flags.limit) : 10;
    if (!Number.isInteger(historyLimit) || historyLimit <= 0) throw new Error("--limit must be a positive integer");
    const checkHistory = Boolean(flags["check-history"]);
    const once = Boolean(flags.once || flags.plain);
    // Live TUI is the default only for a genuine interactive terminal; every
    // scriptable path (--json, --once/--plain, piped/redirected, non-TTY) keeps
    // the byte-identical one-shot render() below.
    const stdout = deps.stdout || process.stdout;
    const stdin = deps.stdin || process.stdin;
    if (stdout.isTTY && stdin.isTTY && !flags.json && !once) {
      const run = deps.tuiRun || runTui;
      const refreshMs = flags["refresh-ms"] ? Number(flags["refresh-ms"]) : 1000;
      run(orchDir, { refreshMs, historyLimit, checkHistory, repo });
      return;
    }
    if (flags.json) console.log(JSON.stringify(dashboardSnapshot(orchDir, { historyLimit, repo, checkHistory }), null, 2));
    else console.log(renderDashboard(orchDir, { historyLimit, repo, checkHistory, color: colorEnabled(process.stdout), columns: process.stdout.columns }));
    return;
  }

  // Human-side counterpart of finalize()'s post-merge bump: when a cycle
  // escalates (e.g. guardrail-touch) and a human hand-merges onto
  // orch/integration, finalize never runs, so the version/CHANGELOG stay
  // frozen. `orch release` does that bookkeeping alone. No tag — tagging is
  // CI's job (#409). Recovery on failure restores only the files the bump
  // wrote, never a whole-tree reset (see bumpVersion recovery: "written-files").
  if (command === "release") {
    const entry = rest.join(" ").trim();
    if (!entry) throw new Error('usage: orch release "<changelog entry>"');
    const dirty = git.gitTry(["status", "--porcelain"], repo);
    if (!dirty.ok) throw new Error(`orch release: git status failed: ${dirty.out.trim() || "unknown error"}`);
    const dirtyLines = dirty.out.split("\n").map((l) => l.trimEnd()).filter(Boolean);
    if (dirtyLines.length) {
      const files = dirtyLines.map((l) => l.slice(3).trim() || l).join("\n");
      throw new Error(
        `orch release: working tree is dirty — commit or stash first.\n${files}`,
      );
    }
    const version = git.bumpVersion(repo, entry, { recovery: "written-files" });
    if (!version) throw new Error("orch release: version bump failed (is package.json present and valid?)");
    console.log(`orch release: chore(release): v${version}`);
    return;
  }

  printUsage();
}

function printUsage() {
  console.log(`orch - Run coding agents in an author, review, test, and merge loop.

Usage: orch <command> [options]

Commands:
  init                  Scaffold .orch/orch.yml and .orch/ORCH.md.
  config                Interactively create or edit an orch YAML config.
  agent add <name>      Add a registered agent to the rotation pool.
  agent build <name>    Scaffold an adapter via orch's author/audit/test loop.
  task "change"         Run a cycle and update orch/integration on merge.
  task --file <file>    Run a cycle from an untrusted JSON work order.
  issue <number>        Run from a GitHub issue and close it on merge.
  review <branch>       Audit an existing branch without merging.
  continue <sid>        Resume an interrupted/stalled cycle from its checkpoint.
  pr <number>           Review a GitHub PR; add --merge to merge if approved.
  release "entry"       Bump version + CHANGELOG by hand (autoBump repos only).
  dashboard             Live status TUI; --once prints the static one-shot.
  mcp                   Serve orch as an MCP server over stdio (for AI clients).
  upgrade, update       Self-update the global npm install.
  completion [bash]     Print the bash completion script (default: bash).
  completion install    Write the completion script to ~/.orch/completion.bash.
  version               Print the version (same as --version).
  help                  Show this help.

Options:
  -h, --help            Show this help.
  --version             Print the version.
  --author <role>       Set author as "<agent> [model] [effort]".
  --authors <roles>     Set comma-separated authors; each gets a branch.
  --reviewer <role>     Set reviewer as "<agent> [model] [effort]".
  --reviewers <roles>   Set comma-separated reviewers.
  --cheap               Use cheap.role; cheap.paths can auto-route work orders.
  --file <file>         With task, read the work order from a JSON file.
  --config-file <file>  Config YAML path; with config, write there.
  --allow-protected     Run even if the work order names a protected path.
  --dry                 Plan without shelling out or changing git.
  --check               With upgrade, check latest version without installing.
  --link                With init, link .orch/ORCH.md from agent docs.
  --no-banner           Hide the run banner.
  --no-tidy             Leave task branches and checkouts after merge.
  --json                With dashboard, print JSON.
  --limit <n>           With dashboard, limit history rows.
  --check-history       Dashboard: show stale red rows resolved (view only).
  --once, --plain       Dashboard: force the static one-shot print.
  --refresh-ms <n>      Dashboard: live TUI poll interval ms (default 1000).
  --merge               With pr, merge approved PRs.
  --pr                  With agent build, open a PR instead.

Examples:
  orch init --link
  orch task "add input validation" --reviewer "codex"
  orch task --file work-order.json --cheap
  orch issue 42
  orch release "hand-landed guardrail fix (closes #N)"
  orch dashboard --json --limit 5

Full docs: see .orch/ORCH.md in initialized repos and the README.`);
}

function costSuffix(result) {
  return result?.usageSummary ? `; cost ${result.usageSummary}` : "";
}

// Real collaborators for the GitHub PR bridge. gh/git shell out; cycle binds
// the engine to its real deps. §3f: the public PR comment is a machine summary
// only (built in github.runPr), so no reviewer prose is read back here.
function githubDeps() {
  return {
    gh: ghShell,
    git: git.git,
    cycle: (o) => runCycle(o, realDeps()),
    log: (m) => process.stderr.write(`▶ ${m}\n`),
  };
}
