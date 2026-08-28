import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, openSync, closeSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline";
import { execFileSync, spawn } from "node:child_process";
import { load, configPath, parseRoleSpec, parseRoleSpecs } from "./config.js";
import { runConfigWizard } from "./config-wizard.js";
import { runCycle } from "./engine.js";
import {
  demote, openPr, openIntegrationPr, buildIssueComment, buildComment, commentOnce,
  createPr, hasRemote, ghAvailable, requireGh, findPrByHead, prView, viewerPermission,
} from "./github.js";
import { mergeStanding } from "./landing.js";
import { runUntil } from "./run-controller.js";
import { createRebaseRemedy, createRotateRemedy } from "./remedies.js";
import { createReauthorRemedy } from "./remedies/reauthor.js";
import { createAskRemedy } from "./remedies/ask.js";
import { createIntegrationRepairRemedy } from "./integration-repair.js";
import * as adapters from "./adapters/index.js";
import * as git from "./git.js";
import * as gate from "./gate.js";
import * as scope from "./scope.js";
import { globToRegExp } from "./scope.js";
import * as notify from "./notify.js";
import { releaseLock, acquireBlocking, isPaused, LOCK_NAMES } from "./lock.js";
import { slugify } from "./slug.js";
import { serve } from "./mcp.js";
import { PARSE_OPTIONS, COMMAND_FLAGS, COMMANDS, renderHelp, usageError, validate as validateFlags, validatePositionals } from "./schema.js";

const VERSION = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;
const DISPLAY_VERSION = `v${VERSION}`;
import { newSid } from "./sid.js";
import * as inflight from "./inflight.js";
import * as resume from "./resume.js";
import * as checkpoint from "./checkpoint.js";
import * as runRecord from "./run-record.js";
import * as reviewLog from "./review-log.js";
import { finalize } from "./finalize.js";
import { validateWorkOrder, buildAuthorPrompt, issueToWorkOrder } from "./intake/workorder.js";
import { findProtectedMentions } from "./intake/allowlist.js";
import { appCredsFromEnv, installationToken, parseRepoSlug } from "./github-app.js";
import { finishRun } from "./complete.js";
import { detectAgents, formatDetection } from "./detect.js";
import { redact, publicSummary } from "./redact.js";
import { render as renderDashboard, snapshot as dashboardSnapshot } from "./dashboard.js";
import { FALLBACK_BIN_DIRS, resolveAgentBin } from "./agent-bin.js";
import { BASH_COMPLETION, installCompletion } from "./completion.js";
import { visWidth, paint, C, box, colorEnabled } from "./tui/theme.js";
import { run as runTui } from "./tui/loop.js";
import { maybeNotifyUpdate, runUpdateCheckChild } from "./update-check.js";
import { runUpgrade } from "./upgrade.js";
import { totalUsage } from "./usage.js";
import { setProcessSignalCleanup } from "./adapters/cli-adapter.js";

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
    const env = { ...process.env };
    delete env.ORCH_DETACHED;
    delete env.ORCH_DETACH_LOG;
    deps.spawn(process.execPath, [process.argv[1], "task", tagged],
      { detached: true, stdio, env }).unref();
  } finally {
    if (fd !== undefined) (deps.closeSync || closeSync)(fd);
  }
  // `quiet` (set by the --json call site below): this print is plain text, and
  // under --json it fires AFTER `run.end` has already gone out (docs spawn only
  // happens once the merge loop is done) — a bare console.log there breaks the
  // design §13 "stdout is one JSON object per line" contract, e.g. `... --json
  // | tail -1 | jq .exit`. finishRun's human-readable summary already reports
  // this outcome for non-json callers.
  if (!deps.quiet) console.log("▶ post-merge: docs-update spawned");
}

// Loop guard + opt-in gate around spawnDocsTask. Real merge only (never --dry).
// Skips docs-only merges (the docs-update's own merge can't re-trigger) AND no-op
// merges (an empty diff would re-spawn forever, since it's not docs-only either).
export function maybeSpawnDocs(res, cfg, deps = {}, orchDir) {
  const { dry = false, spawn: spawnFn = spawn, quiet = false } = deps;
  if (dry || res.status !== "merged" || !cfg.docs.autoUpdate || res.docsOnly || res.noop) return false;
  spawnDocsTask(cfg.docs.prompt, { spawn: spawnFn, quiet }, orchDir);
  return true;
}

function cleanStreakSuffix(orchDir, dry) {
  if (dry) return "";
  return `; clean unattended cycles: ${notify.kpi(orchDir).cleanUnattendedCycles}`;
}

const STATUS_COLOR = { merged: C.ok, escalated: C.fail, "merge-deferred": C.fail, pr: C.warn, demoted: C.warn };

// Maps today's single-cycle result to the run record's outcome/exit (design
// §5.2/§6). "stopped-at-cap" rather than "blocked": until the run-controller
// (P5) exists, an escalated/merge-deferred cycle IS the whole run hitting its
// (implicit, single-attempt) cap — exactly the case `continue` should be able
// to grant a fresh attempt budget for (§5.3).
function outcomeForResult(result) {
  return result.status === "escalated" || result.status === "merge-deferred" ? "stopped-at-cap" : "reached";
}
function exitForResult(result) {
  return outcomeForResult(result) === "stopped-at-cap" ? 2 : 0;
}
// Design §6 terminal states: only the outcomes a single implicit cycle can
// produce today (no run-controller/readiness slice yet) — "reached" success
// lands as READY, distinct from STOPPED_AT_CAP/ERROR so `continue` (§5.3) can
// tell them apart.
const STATE_FOR_OUTCOME = {
  reached: "READY", "stopped-at-cap": "STOPPED_AT_CAP", blocked: "BLOCKED",
  "wait-timeout": "WAIT_TIMEOUT", error: "ERROR",
};
// Design §5.2: `lastError` is `{ message, stack? } | null`, not a bare string.
function toLastError(err) {
  const stack = err?.stack ? redact(String(err.stack)) : null;
  return { message: redact(String(err?.message || err)), ...(stack ? { stack } : {}) };
}

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
stageTimeout: 25                        # wall-clock cap in minutes for each agent stage AND the test gate;
                                        # 0 disables; default: 25
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
# MCP PR merge opt-in
# ===================================================================
automation:
  mcpMayMerge: false                    # true = MCP orch_pr may request --until merged; default: false


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
- \`orch pr <number|branch> [--merge|--until once|ready|merged]\` review (and optionally merge) a PR
- \`orch release "<entry>"\`         run the version bump + CHANGELOG write by hand; only needed
                                    in repos that set \`release.autoBump: true\` (default \`false\`)
- \`orch mcp\`                       serve orch's cycle commands over MCP on stdio, for an AI
                                    client to drive; \`orch_pr\` merge needs automation.mcpMayMerge
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

The MCP \`orch_pr\` tool accepts a PR number or branch and \`once\`, \`ready\`, or
\`merged\`. The \`merged\` mode is refused unless \`automation.mcpMayMerge: true\`
is explicitly enabled in this repo; when enabled, it uses the same head-bound,
CI-checked merge path as \`orch pr --merge\`.

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

// The flag set and the per-command flag lists now live in src/schema.js — one
// declaration that the parser, `orch --help` and bash completion all read, so
// the three cannot drift. Re-exported here because they are part of this
// module's public surface (tests and completion import them from cli.js).
export { PARSE_OPTIONS, COMMAND_FLAGS };

// Thin wrapper over node's parseArgs: same result shape, but an unknown or
// malformed flag becomes a usage error (exit 64) with an orch-shaped message
// instead of node's raw ERR_PARSE_ARGS text.
export function parse(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: PARSE_OPTIONS, tokens: true });
  } catch (e) {
    const unknown = /Unknown option '([^']+)'/.exec(e.message);
    if (unknown) throw usageError(`unknown option ${unknown[1]} (run 'orch help' for usage)`);
    throw usageError(e.message.split(". To ")[0]);
  }
  const { values, positionals, tokens } = parsed;
  // parseArgs silently keeps the LAST occurrence of a repeated non-boolean
  // flag ("--until ready --until once" parsed to just {until: "once"}), so
  // the first value a user typed was discarded with no error at all — not
  // even the "declared but inert" usage error this schema exists to raise
  // for everything else. None of our string/int/enum flags are declared
  // `multiple`, so a second occurrence is always a mistake, not a list.
  const seen = new Set();
  for (const t of tokens) {
    if (t.kind !== "option" || PARSE_OPTIONS[t.name]?.type === "boolean") continue;
    if (seen.has(t.name)) throw usageError(`--${t.name} given more than once`);
    seen.add(t.name);
  }
  return { command: positionals[0], rest: positionals.slice(1), flags: values };
}

function splitNames(value) {
  if (value == null) return null;
  const values = Array.isArray(value) ? value : String(value).split(",");
  const names = values.map((v) => String(v).trim()).filter(Boolean);
  if (names.length === 0) throw usageError("role override must name at least one agent");
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

function fixedSelfReview(cfg) {
  const fixed = fixedRoles(cfg);
  return Boolean(fixed
    && fixed.authors.length === 1
    && fixed.reviewers.length === 1
    && fixed.authors[0].agent === fixed.reviewers[0].agent);
}

function configuredReviewers(cfg) {
  if (cfg.reviewers) return parseRoleSpecs(cfg.reviewers);
  if (cfg.reviewer) return [parseRoleSpec(cfg.reviewer)];
  return null;
}

function configuredSelfReviewer(cfg, authorName) {
  return Boolean(configuredReviewers(cfg)?.some((spec) => spec.agent === authorName));
}

function singleAgentPool(cfg) {
  return Array.isArray(cfg.agents) && cfg.agents.length === 1;
}

function roleSelectionDetail({ exclude = [], blockedAuthors = [], agents = [] } = {}) {
  const details = [];
  const excluded = exclude.map(exclusionName).filter(Boolean);
  const blocked = blockedAuthors.map(exclusionName).filter(Boolean);
  if (excluded.length) details.push(`excluded ${[...new Set(excluded)].join(", ")}`);
  if (blocked.length) details.push(`author blocked by reviewer ${[...new Set(blocked)].join(", ")}`);
  if (agents.length < 2) details.push(`rotation pool has ${agents.length} agent${agents.length === 1 ? "" : "s"}`);
  return details.join("; ") || "no independent candidate remains in the rotation pool";
}

function noEligibleRole(role, options) {
  return new Error(`orch: no eligible ${role} remains — ${roleSelectionDetail(options)}`);
}

export function applyRoleOverrides(cfg, flags, opts = {}) {
  // --author + --authors (or --reviewer + --reviewers) together used to pick
  // the plural silently and drop the singular — a value the user typed had no
  // effect and no error told them so. Reject the combination instead.
  if (flags.author != null && flags.authors != null) {
    throw usageError("set --author or --authors, not both");
  }
  if (flags.reviewer != null && flags.reviewers != null) {
    throw usageError("set --reviewer or --reviewers, not both");
  }
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
    throw usageError("set both --author(s) and --reviewer(s), or neither");
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
    if (explicitRoles) throw usageError("--cheap cannot be combined with --author/--authors/--reviewer/--reviewers");
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

function exclusionName(value) {
  return typeof value === "string" ? value : value?.name || value?.agent;
}

function exclusionRecord(value) {
  const name = exclusionName(value);
  if (!name) return null;
  return typeof value === "object" && value.name
    ? { name, reason: value.reason || "error", at: value.at || null }
    : { name, reason: "error", at: null };
}

export function resumeExclusions(orchDir, task, author, deps = { resume, checkpoint, inflight, runRecord }) {
  if (!author || !task) return [];
  const sid = deps.resume.lookup(orchDir, task, author)?.sid;
  if (!sid) return [];
  const entries = new Map();
  for (const source of [
    deps.runRecord.lookup(orchDir, sid)?.excludedAgents,
    deps.checkpoint.lookup(orchDir, sid)?.excludedAgents,
    deps.inflight.lookup(orchDir, sid)?.excludedAgents,
  ]) {
    for (const value of source || []) {
      const name = exclusionName(value);
      if (!name || entries.has(name)) continue;
      entries.set(name, exclusionRecord(value));
    }
  }
  return [...entries.values()];
}

export function nextAuthor(cfg, orchDir, pinnedAuthor = null, dry = false, options = {}) {
  const opts = options || {};
  const excluded = new Set((opts.exclude || []).map(exclusionName).filter(Boolean));
  const blockedAuthors = new Set((opts.blockedAuthors || []).map(exclusionName).filter(Boolean));
  const agents = Array.isArray(cfg.agents) ? cfg.agents : [];
  const persist = !dry && opts.persist !== false;
  const reviewerCount = opts.reviewerCount == null ? null : Math.max(1, Number(opts.reviewerCount) || 1);
  const forceRotate = Boolean(opts.forceRotate);
  // Explicit fixed roles win over rotation — the trivial "who authors, who audits".
  // Returns role specs ({agent, model, effort}) plus plain name arrays for back-compat.
  const fixed = fixedRoles(cfg);
  if (fixed) {
    if (persist) mkdirSync(orchDir, { recursive: true });
    const authors = fixed.authors.filter((spec) => !excluded.has(spec.agent));
    const authorName = authors[0]?.agent;
    // A paired fixed X/X role is an explicit request, unlike the reviewer-only
    // rotation path, so preserve the same seat when no independent seat exists.
    const allowSelf = fixedSelfReview(cfg);
    let reviewers = fixed.reviewers.filter((spec) => !excluded.has(spec.agent)
      && (allowSelf || authors.length > 1 || spec.agent !== authorName));
    if (!reviewers.length && singleAgentPool(cfg)) {
      reviewers = fixed.reviewers.filter((spec) => !excluded.has(spec.agent) && spec.agent === authorName);
    }
    return {
      authorName,
      reviewerName: reviewers[0]?.agent,
      authorNames: authors.map((s) => s.agent),
      reviewerNames: reviewers.map((s) => s.agent),
      authors,
      reviewers,
    };
  }
  if (persist) mkdirSync(orchDir, { recursive: true });
  const f = join(orchDir, "last-author");
  // Resuming a surviving branch (#27): pin its author and DON'T advance rotation —
  // this run is the prior run continuing, not a new author's turn.
  // Reviewer-only CLI overrides (D2) force reviewers while still rotating the author.
  const configured = configuredReviewers(cfg);
  const configuredCandidates = configured?.filter((spec) => !excluded.has(spec.agent));
  const reviewerCandidates = (authorName) => {
    if (configured) {
      let eligible = configuredCandidates.filter((spec) => spec.agent !== authorName);
      if (!eligible.length && singleAgentPool(cfg))
        eligible = configuredCandidates.filter((spec) => spec.agent === authorName);
      return reviewerCount == null ? eligible : eligible.slice(0, reviewerCount);
    }
    const authorIndex = agents.indexOf(authorName);
    if (authorIndex < 0) return [];
    const result = [];
    for (let step = 1; step <= agents.length && result.length < (reviewerCount || 1); step += 1) {
      const candidate = agents[(authorIndex + step) % agents.length];
      if (candidate !== authorName && !excluded.has(candidate)) result.push({ agent: candidate, model: null, effort: null });
    }
    if (!result.length && singleAgentPool(cfg) && !excluded.has(authorName))
      result.push({ agent: authorName, model: null, effort: null });
    return result;
  };
  const pickAgent = (start) => {
    for (let step = 0; step < agents.length; step += 1) {
      const candidate = agents[(start + step) % agents.length];
      if (!excluded.has(candidate) && (!blockedAuthors.has(candidate) || singleAgentPool(cfg))) return candidate;
    }
    return undefined;
  };
  const pinIndex = agents.indexOf(pinnedAuthor);
  if (pinnedAuthor && pinIndex >= 0 && !excluded.has(pinnedAuthor) && !blockedAuthors.has(pinnedAuthor) && !forceRotate) {
    const reviewers = reviewerCandidates(pinnedAuthor);
    return {
      authorName: pinnedAuthor, reviewerName: reviewers[0]?.agent,
      authorNames: [pinnedAuthor], reviewerNames: reviewers.map((s) => s.agent),
      authors: [{ agent: pinnedAuthor, model: null, effort: null }],
      reviewers,
    };
  }
  const last = existsSync(f) ? readFileSync(f, "utf8").trim() : null;
  const lastIndex = agents.indexOf(last);
  const start = pinIndex >= 0 ? (pinIndex + 1) % agents.length : (lastIndex >= 0 ? (lastIndex + 1) % agents.length : 0);
  const authorName = pickAgent(start);
  const reviewers = authorName ? reviewerCandidates(authorName) : [];
  if (persist && authorName) writeFileSync(f, authorName + "\n");
  return {
    authorName, reviewerName: reviewers[0]?.agent,
    authorNames: authorName ? [authorName] : [], reviewerNames: reviewers.map((s) => s.agent),
    authors: authorName ? [{ agent: authorName, model: null, effort: null }] : [],
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

// design §9 input for run-controller.js's `runUntil`: maps a LANDED cycle
// result to the PR readiness is read against. "merged" landed on the standing
// integration→base PR (design §0 glossary); "pr" (cfg.merge === "pr") opened
// a PR straight from the cycle's own branch. "approved" (engine.js's noMerge
// path — used by `pr`, the review-mode CLI entry) is mapped the same way;
// findPrByHead re-reads rather than trusting `cycle.prUrl`'s number (design
// §5.4 query-before-write).
function findPrByHeadSafe(branch, baseBranch, ghDeps, fallbackUrl) {
  // gh (findPrByHead -> deps.gh -> execFileSync) throws on any nonzero exit —
  // no GitHub remote, no auth, network hiccup. That must resolve to "no PR
  // found" (REMOTE_UNKNOWN in run-controller.js), not an uncaught throw that
  // skips straight past run-controller's own error handling to cli.js's
  // outer catch and truncates the --json stream after run.start.
  try {
    return findPrByHead(branch, baseBranch, { includeDraft: true }, ghDeps) || { number: null, url: fallbackUrl };
  } catch {
    return { number: null, url: fallbackUrl };
  }
}

const PR_VIEW_FIELDS = "number,state,headRefName,headRefOid,headRepositoryOwner,baseRefName,isCrossRepository,maintainerCanModify,isDraft,url";

function runRecordOwnsBranch(orchDir, branch) {
  const recordsDir = join(orchDir, "run-records");
  let files;
  try { files = readdirSync(recordsDir); } catch { return false; }
  return files.some((file) => {
    if (!file.endsWith(".json")) return false;
    try { return JSON.parse(readFileSync(join(recordsDir, file), "utf8")).branch === branch; }
    catch { return false; }
  });
}

// `pr/*` is orch's task-branch namespace. A durable run record is also an
// ownership proof for a branch created under another configured namespace.
// Ownership is deliberately separate from GitHub's maintainerCanModify bit:
// that permission is not authority to rewrite a colleague's branch.
export function orchOwnsBranch(branch, orchDir) {
  return /^pr\//.test(branch) || runRecordOwnsBranch(orchDir, branch);
}

export function resolvePrTarget({ target, repo, orchDir, baseBranch = "main", until = "once", gh, git: gitDep = git } = {}) {
  const value = String(target || "").trim();
  if (!value) throw usageError("usage: orch pr <number|branch>");
  if (!/^\d+$/.test(value) && !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)) {
    throw usageError("usage: orch pr <number|branch>");
  }

  let pr = null;
  let branch = value;
  let ephemeral = false;
  const runGit = (args) => typeof gitDep === "function" ? gitDep(args, repo) : gitDep.git(args, repo);
  const tryGit = (args) => {
    if (typeof gitDep?.gitTry === "function") return gitDep.gitTry(args, repo);
    try { return { ok: Boolean(runGit(args)) }; } catch { return { ok: false }; }
  };
  if (/^\d+$/.test(value)) {
    pr = prView(value, PR_VIEW_FIELDS, { gh });
    if (!pr.number) throw new Error(`orch pr #${value}: GitHub returned no PR`);
    if (pr.state && pr.state !== "OPEN") throw new Error(`PR #${pr.number} is ${pr.state}, not open`);
    branch = `pr-${pr.number}`;
    runGit(["fetch", "origin", `+pull/${pr.number}/head:${branch}`]);
    ephemeral = true;
  } else {
    if (!tryGit(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).ok) {
      if (remoteBranchRefExists(repo, branch)) {
        runGit(["branch", branch, `origin/${branch}`]);
      } else {
        throw usageError(`usage: orch pr <number> or <branch> [--until once|ready|merged]\norch pr ${branch}: branch does not exist locally or as origin/${branch}`);
      }
    }
    if (typeof gh === "function") {
      try {
        const found = findPrByHead(branch, baseBranch, { includeDraft: true }, { gh });
        if (found?.number) pr = prView(found.number, PR_VIEW_FIELDS, { gh });
      } catch { /* a local-only review remains valid without a readable remote */ }
    }
  }

  if (pr && until !== "once") {
    let viewerPush = false;
    try { viewerPush = viewerPermission({ gh }).push; } catch { /* fail closed */ }
    pr.viewerPush = viewerPush;
    pr.ownedBranch = orchOwnsBranch(pr.headRefName || branch, orchDir);
    pr.canPushHead = pr.isCrossRepository === false && pr.ownedBranch && viewerPush;
  }
  return {
    ...pr,
    number: pr?.number ? Number(pr.number) : null,
    url: pr?.url || null,
    branch,
    remoteBranch: pr?.headRefName || branch,
    sourceBranch: branch,
    headRefName: pr?.headRefName || branch,
    headRefOid: pr?.headRefOid || null,
    baseBranch: pr?.baseRefName || baseBranch,
    ephemeral,
    originalNumber: pr?.number ? Number(pr.number) : null,
    needsRepairBranch: Boolean(pr?.number && until !== "once" && !pr.canPushHead),
  };
}

export function resolveLanded(cycle, run, cfg, ghDeps, repo) {
  const baseBranch = cfg.baseBranch || "main";
  const pathsFor = (branch) => cycle.paths ?? git.changedFiles(repo, branch, baseBranch);
  if (run.prTarget?.number) {
    const target = run.prTarget;
    const branch = target.branch || run.branch;
    return {
      pr: { number: target.number, url: target.url || null },
      expectedHead: git.git(["rev-parse", branch], repo),
      landing: "pr",
      branch,
      paths: pathsFor(branch),
    };
  }
  if (cycle.status === "pr" || cycle.status === "approved") {
    const pr = findPrByHeadSafe(run.branch, baseBranch, ghDeps, cycle.prUrl);
    return { pr, expectedHead: git.git(["rev-parse", run.branch], repo), landing: "pr", branch: run.branch, paths: pathsFor(run.branch) };
  }
  const integrationBranch = cfg.integrationBranch || "orch/integration";
  if (integrationBranch === baseBranch) {
    return { pr: null, expectedHead: git.git(["rev-parse", integrationBranch], repo), landing: "base", branch: integrationBranch, paths: pathsFor(integrationBranch) };
  }
  const pr = findPrByHeadSafe(integrationBranch, baseBranch, ghDeps, cycle.prUrl);
  return { pr, expectedHead: git.git(["rev-parse", integrationBranch], repo), landing: "standing", branch: integrationBranch, paths: pathsFor(integrationBranch) };
}

export function preparePrRepairRun(run, cfg, ghDeps) {
  const target = run.prTarget;
  const repairBranch = `pr/repair/${target.number}-${run.sid}`;
  if (!git.branchExists(run.repo, repairBranch)) {
    git.git(["branch", repairBranch, run.branch], run.repo);
  }
  const head = git.git(["rev-parse", repairBranch], run.repo);
  // This is the only publication allowed for a foreign or colleague-owned
  // head: the original ref is never rewritten.
  git.git(["push", "-u", "origin", `${head}:refs/heads/${repairBranch}`], run.repo);
  const repairPr = createPr({
    head: repairBranch,
    base: target.baseBranch || cfg.baseBranch || "main",
    title: `orch: repair PR #${target.originalNumber || target.number}`,
    body: `Repair branch for PR #${target.originalNumber || target.number}.`,
  }, ghDeps);
  if (!repairPr.number) throw new Error(`could not open repair PR for #${target.originalNumber || target.number}`);
  return {
    ...run,
    branch: repairBranch,
    worktree: join(run.orchDir, "wt", repairBranch.replace(/\//g, "_")),
    prTarget: {
      ...target,
      number: repairPr.number,
      url: repairPr.url || null,
      repairNumber: repairPr.number,
      repairUrl: repairPr.url || null,
      branch: repairBranch,
      remoteBranch: repairBranch,
      headRefName: repairBranch,
      headRefOid: head,
      canPushHead: true,
      needsRepairBranch: false,
    },
  };
}

export function mergeForRun({ record, land, readiness }, run, cfg, ghDeps, emit) {
  return mergeStanding({
    record: { ...record, runId: run.sid, repo: run.repo, orchDir: run.orchDir },
    cfg,
    land,
    readiness,
  }, {
    gh: ghDeps.gh,
    git,
    gate,
    lock: { acquireBlocking, releaseLock },
    repo: run.repo,
    orchDir: run.orchDir,
    log: ghDeps.log,
    onMergeRequest: ({ pr, head, method }) => emit({ event: "merge.request", runId: run.sid, pr, head, method }),
  });
}

function mergeVerifiedEvent(runId, controller, cfg) {
  if (!controller?.mergeCommit) return null;
  return {
    event: "merge.verified",
    runId,
    pr: controller.land?.pr?.number || null,
    head: controller.headSha || null,
    method: controller.merge?.requests?.at(-1)?.method
      || (controller.land?.landing === "standing" ? "merge" : cfg.github?.mergeMethod || "squash"),
    mergeCommit: controller.mergeCommit,
    base: cfg.baseBranch || "main",
    ancestor: true,
  };
}

function outputResult(result, controller) {
  if (controller?.state !== "MERGED" || result?.status === "merged") return result;
  return { ...result, status: "merged", reason: "head-bound merge verified", mergeCommit: controller.mergeCommit };
}

function reviewersForAuthor(authorName, reviewerSpecs, { allowSelf = false } = {}) {
  const others = reviewerSpecs.filter((s) => s.agent !== authorName);
  return others.length || !allowSelf ? others : reviewerSpecs;
}

function persistRotationState({ orchDir, sid, runId, run, nextRun, previousAuthor }, stores = { inflight, runRecord, resume, checkpoint }) {
  stores.inflight.setRoles(orchDir, sid, {
    author: nextRun.author,
    reviewers: nextRun.reviewers,
    excludedAgents: nextRun.excludedAgents || [],
    rotationStage: nextRun.rotationStage,
  });
  stores.runRecord.update(orchDir, runId, {
    excludedAgents: nextRun.excludedAgents || [],
  });
  if (run.mode === "task" && nextRun.rotationStage === "started") {
    stores.resume.clear(orchDir, run.task, previousAuthor);
    stores.resume.record(orchDir, run.task, nextRun.authorName, { branch: nextRun.branch, sid });
  }
  stores.checkpoint.clear(orchDir, sid);
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

// 2 (a cycle ran and did not agree) outranks 3 (capacity refusal, nothing ran)
// when a single invocation's author fan-out sees both: a peer process can push
// a later run over the cap after an earlier one already escalated, and
// last-write-wins on process.exitCode would then report 3 — "safe to retry" —
// hiding the escalation a caller actually needs to go review. Exported as a
// pure function so the priority itself is unit-testable without racing a real
// concurrent process to reproduce the mix.
//
// 1 (ERROR, run-controller.js's EXIT_FOR_STATE) and 4 (WAIT_TIMEOUT) are also
// reachable via `raiseExitCode(controller.exit)` in the fan-out loop below,
// but were missing from this table — an unlisted code's priority reads as 0
// via the `|| 0` fallback, same as "nothing raised yet", so raiseExitCode(1)
// or raiseExitCode(4) on a fresh process.exitCode of 0 never wins the `>`
// comparison and silently leaves exitCode at 0 (success) even though the run
// actually errored or timed out. Ranked by how much a caller needs to see it:
// 1 (something broke) must survive everything; 2 (needs review) still outranks
// 3 as established above; 4 (landed, but readiness timed out) is more
// actionable than a mere capacity refusal so it outranks 3 too.
const EXIT_CODE_PRIORITY = { 1: 4, 2: 3, 4: 2, 3: 1 };
export function raiseExitCode(code) {
  const current = process.exitCode || 0;
  if ((EXIT_CODE_PRIORITY[code] || 0) > (EXIT_CODE_PRIORITY[current] || 0)) process.exitCode = code;
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

const DETACH_WAIT_MS = 5_000;
const DETACH_POLL_MS = 25;

function detachStamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}-${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}`;
}

function logTail(path, lines = 20) {
  try {
    return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).slice(-lines).join("\n");
  } catch {
    return "";
  }
}

function detachedInfo(runId, log) {
  if (process.env.ORCH_DETACHED !== "1") return null;
  return { pid: process.pid, detachedLog: log, startedAt: new Date().toISOString(), runId };
}

function detachedRecordInfo(info) {
  return info && { pid: info.pid, detachedLog: info.detachedLog, startedAt: info.startedAt };
}

export function installDetachedSignalCleanup(orchDir, runId, info) {
  if (!info) return null;
  setProcessSignalCleanup((signal) => {
    runRecord.update(orchDir, runId, {
      state: "ERROR",
      outcome: "error",
      exit: 1,
      interrupted: { at: new Date().toISOString(), signal },
    });
    for (const lockName of Object.values(LOCK_NAMES)) releaseLock(orchDir, lockName);
  });
  return () => setProcessSignalCleanup(null);
}

async function waitForDetached(orchDir, pid, child, { waitMs = DETACH_WAIT_MS, pollMs = DETACH_POLL_MS, startedAt = "" } = {}) {
  let exited = null;
  const onExit = (code, signal) => { exited = { code, signal }; };
  if (typeof child?.once === "function") child.once("exit", onExit);
  else if (typeof child?.on === "function") child.on("exit", onExit);

  const deadline = Date.now() + waitMs;
  try {
    for (;;) {
      const record = runRecord.findDetached(orchDir, pid, startedAt);
      if (record) return { record };
      if (exited) return { exited };
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { timedOut: true };
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, remaining)));
    }
  } finally {
    if (typeof child?.removeListener === "function") child.removeListener("exit", onExit);
  }
}

// Parent-side half of --detach. The child gets the original argv without the
// control flag and writes its durable run identity before the parent reports a
// handle. The inherited log path is kept stable so the child and parent always
// refer to the same file.
export async function detachRun(argv, { flags = {}, repo = process.cwd(), orchDir = join(repo, ".orch"), cfg, deps = {} } = {}) {
  const config = cfg || load(repo, flags["config-file"]);
  const configuredDir = config.automation?.detachLogDir || ".orch/logs";
  const logDir = isAbsolute(configuredDir) ? configuredDir : join(repo, configuredDir);
  mkdirSync(logDir, { recursive: true });
  const stamp = detachStamp();
  const logPath = join(logDir, `${stamp}-${process.pid}.log`);
  const open = deps.openSync || openSync;
  const close = deps.closeSync || closeSync;
  const spawnFn = deps.spawn || spawn;
  const fd = open(logPath, "w");
  const startedAt = new Date().toISOString();
  let child;
  const finalLog = logPath;
  try {
    const childArgv = argv.filter((arg) => arg !== "--detach");
    const script = deps.script || process.argv[1] || new URL("../bin/orch.js", import.meta.url).pathname;
    child = spawnFn(process.execPath, [script, ...childArgv], {
      detached: true,
      stdio: ["ignore", fd, fd],
      env: { ...process.env, ORCH_DETACHED: "1", ORCH_DETACH_LOG: logPath },
      windowsHide: true,
    });
    child.unref?.();
  } finally {
    close(fd);
  }

  const pid = child.pid ?? null;
  const waited = await waitForDetached(orchDir, pid, child, {
    waitMs: deps.detachWaitMs ?? DETACH_WAIT_MS,
    pollMs: deps.detachPollMs ?? DETACH_POLL_MS,
    startedAt,
  });
  if (waited.record) {
    const event = {
      event: "run.detached",
      pid,
      log: waited.record.detached?.detachedLog || waited.record.detached?.log || finalLog,
      runId: waited.record.runId || waited.record.detached?.runId,
    };
    if (flags.json) console.log(JSON.stringify(event));
    else console.log(`orch: run detached — pid ${pid}; log ${finalLog}; runId ${event.runId}`);
    return event;
  }
  if (waited.exited) {
    const code = Number.isInteger(waited.exited.code) ? waited.exited.code : 1;
    const tail = logTail(finalLog);
    if (tail) process.stderr.write(`${tail}\n`);
    throw Object.assign(new Error(`detached child exited with code ${code} (log: ${finalLog})${tail ? `\n${tail}` : ""}`), { exit: code });
  }
  const event = { event: "run.detached", pid, log: finalLog, runId: null, starting: true };
  if (flags.json) console.log(JSON.stringify(event));
  else console.log(`orch: run still starting — pid ${pid}; log ${finalLog}`);
  return event;
}

function commentOnIssue(result, branch, closes, githubDepsFn) {
  if (!closes) return;
  try {
    const body = redact(`<!-- orch:result -->\n${buildIssueComment(result, branch)}`);
    githubDepsFn().gh(["issue", "comment", String(closes), "--body-file", "-"], body);
  } catch (e) {
    console.error(`orch: could not comment on issue #${closes}: ${e.message}`);
  }
}

function commentOnPr(result, run, githubDepsFn) {
  const target = run.prTarget;
  if (!target?.originalNumber) return;
  try {
    const approved = result.status === "approved" || result.status === "merged";
    const summary = publicSummary({
      decision: approved ? "AGREE" : "DISAGREE",
      green: approved,
      branch: run.branch,
      rounds: result.rounds,
    });
    const body = [
      buildComment({ ...result, status: approved ? "approved" : result.status }, summary),
      target.repairUrl ? `\nRepair PR: ${target.repairUrl}` : "",
    ].join("");
    commentOnce({ kind: "pr", target: target.originalNumber, body: redact(body), marker: "verdict" }, githubDepsFn());
  } catch (e) {
    console.error(`orch: could not comment on PR #${target.originalNumber}: ${e.message}`);
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
  const exclusions = dry ? [] : resumeExclusions(orchDir, task, pinned);
  const forcedReviewers = configuredReviewers(cfg);
  const { authors, reviewers } = nextAuthor(cfg, orchDir, pinned, dry, {
    exclude: exclusions,
    blockedAuthors: forcedReviewers?.length === 1 ? forcedReviewers : [],
  });
  if (!authors.length) throw noEligibleRole("author", {
    exclude: exclusions,
    blockedAuthors: forcedReviewers?.length === 1 ? forcedReviewers : [],
    agents: cfg.agents || [],
  });
  const authorSpec = authors[0];
  const authorName = authorSpec.agent;
  const { sid, branch, resume: isResume } = resolveTaskBranch({ repo, orchDir, task, authorName, dry, liveBranches, baseBranch: cfg.baseBranch, roundCap: cfg.roundCap });
  const reviewerList = reviewersForAuthor(authorName, reviewers, { allowSelf: singleAgentPool(cfg) || fixedSelfReview(cfg) })
    .filter((reviewer) => !exclusions.some((value) => exclusionName(value) === reviewer.agent));
  if (!reviewerList.length) throw noEligibleRole("reviewer", { exclude: exclusions, agents: cfg.agents || [] });
  const run = {
    mode: "task", task, authorPrompt, workOrder: wo, allowLargeScope: Boolean(flags["allow-large-scope"]),
    branch, sid, resume: isResume, authorName, author: authorSpec,
    reviewerName: reviewerList[0].agent, reviewerNames: reviewerList.map((s) => s.agent),
    reviewers: reviewerList, noMerge: !flags.pr, excludedAgents: exclusions,
    cfg, orchDir, repo, worktree: join(orchDir, "wt", branch.replace(/\//g, "_")),
  };

  // A resumed sid (isResume above) reuses the ORIGINAL run's runId — look up
  // its existing record so create() below doesn't stomp attempt/cycles/lastError
  // back to genesis, and so the terminal update appends this cycle instead of
  // replacing the whole history.
  const priorRecord = dry ? null : runRecord.lookup(orchDir, sid);
  if (!dry) {
    const baseSha = git.git(["rev-parse", cfg.baseBranch], repo);
    registerWithConcurrencyCap(
      orchDir,
      sid,
      { branch, pid: process.pid, baseSha, author: authorSpec, reviewers: reviewerList, workOrder: wo, excludedAgents: exclusions },
      cfg,
      { onExceeded: (live) => { throw Object.assign(new Error(`orch: concurrency cap ${cfg.concurrency} reached — ${live} cycles live; try again shortly`), { exit: 3 }); } },
    );
    if (!priorRecord) runRecord.create(orchDir, { runId: sid, command: "agent", argv: [redact(name)] });
  }
  try {
    const result = await runCycle(run, dry ? dryDeps() : (deps.cycleDeps || realDeps()));
    if (!dry) {
      resume.clear(orchDir, task, authorName);
      checkpoint.clear(orchDir, sid);
      const attempt = priorRecord ? priorRecord.attempt + 1 : 0;
      const outcome = outcomeForResult(result);
      runRecord.update(orchDir, sid, {
        state: STATE_FOR_OUTCOME[outcome],
        outcome,
        exit: exitForResult(result),
        attempt,
        branch,
        cycles: [
          ...(priorRecord?.cycles || []),
          { sid, attempt, branch, author: authorName, reviewers: reviewerList.map((r) => r.agent), status: result.status, reason: result.reason || null },
        ],
      });
    }
    return { ...result, branch };
  } catch (err) {
    if (!dry) runRecord.update(orchDir, sid, { state: "ERROR", outcome: "error", exit: 1, lastError: toLastError(err) });
    throw err;
  } finally {
    if (!dry) inflight.deregister(orchDir, sid);
  }
}

export async function main(argv, deps = {}) {
  const { command, rest, flags } = parse(argv);
  const detachedChild = process.env.ORCH_DETACHED === "1";
  // First statement after parse deliberately: behind any early return
  // (version/help/upgrade) a misapplied flag is still dropped silently. The
  // schema rejects a flag this command does not read, `--dry` on a read-only
  // command, and a bad numeric/enum value — all exit 64, before anything runs.
  validateFlags(command, flags, { detachedChild });

  // A detached parent must hand even malformed commands to the child: that
  // preserves the child's real usage/preflight exit code and makes its log the
  // diagnostic source. The child has ORCH_DETACHED but no --detach flag, so it
  // continues through the normal command path below.
  if (flags.detach && !detachedChild) {
    return detachRun(argv, { flags, repo: process.cwd(), deps });
  }
  validatePositionals(command, rest, flags);

  // An unrecognised command used to fall through all the way to the bottom of
  // this function, past the update-check network call and the GitHub App
  // token mint below — so `orch bogsu` (a typo) still phoned home and minted
  // a token before being refused. Reject it here, before either can fire.
  // "__update-check-child" is an internal re-exec target (see below), never
  // typed by a user, so it is exempt rather than added to the schema.
  if (command && command !== "__update-check-child" && !COMMANDS[command]) {
    throw usageError(`unknown command: ${command} (run 'orch help' for usage)`, { showUsage: true });
  }

  // --help/--version describe the tool rather than run it, so they route
  // ahead of every command-specific branch — including `mcp`, whose dispatch
  // used to come first and swallow `orch mcp --help`/`--version` into a
  // hanging JSON-RPC stdio server instead of printing and exiting.
  if (flags.version || command === "version") { console.log(DISPLAY_VERSION); return; }
  if (flags.help || command === "help") { printUsage(); return; }

  if (command === "__update-check-child") {
    // Detached re-exec target (spawnChecker in update-check.js) — it has no
    // --dry flag of its own (INTERNAL_COMMANDS declares it read-only), but it
    // still writes ~/.orch/update-check.json on every real invocation. ORCH_DRYRUN=1
    // must be honored here identically to every other command that writes,
    // or a dry run of the *parent* command still leaves this real network
    // call + cache write running detached in the background.
    if (process.env.ORCH_DRYRUN !== "1") {
      await runUpdateCheckChild({ current: rest[0] || VERSION, cacheDir: rest[1] });
    }
    return;
  }

  // `mcp` dispatches before anything else that can print: on this command
  // stdout is a JSON-RPC transport, so one stray update banner would corrupt
  // the protocol stream. Early return also skips the GitHub App token mint
  // below — each cycle the server spawns does its own auth.
  if (command === "mcp") {
    await serve({ repo: process.cwd() });
    return;
  }

  if (command === "upgrade" || command === "update") {
    const dry = Boolean(flags.dry) || process.env.ORCH_DRYRUN === "1";
    await runUpgrade({ flags: { ...flags, dry }, stdout: deps.stdout || process.stdout, ...deps.upgradeDeps });
    return;
  }

  const repo = process.cwd();
  const orchDir = join(repo, ".orch");
  // --dry for the write commands that have no cycle of their own to stub out
  // (`init`, `agent add`, `pr`, `release`). They used to parse the flag and
  // mutate anyway — a silent no-op safety rail. Same expression the cycle
  // commands use below, so ORCH_DRYRUN=1 is honored identically.
  const dryRun = Boolean(flags.dry) || process.env.ORCH_DRYRUN === "1";

  if (!dryRun && command && command !== "completion") {
    const notifyFn = deps.maybeNotifyUpdate || maybeNotifyUpdate;
    notifyFn({ current: VERSION, json: Boolean(flags.json) }).catch(() => {});
  }

  // Optional GitHub App auth: if ORCH_APP_ID + ORCH_APP_PRIVATE_KEY are set,
  // mint a short-lived installation token and expose it to every `gh` shell-out
  // via GH_TOKEN (execFileSync inherits process.env). orch then acts as
  // orch[bot]. Falls back to ambient `gh auth` when unset or on any failure —
  // never a hard dependency. An explicit GH_TOKEN wins and skips minting.
  // ponytail: process.env mutation at the CLI entrypoint; the lazy correct wiring.
  // Skipped on a dry run: --dry promises to "plan without shelling out or
  // changing git" (schema.js), but minting a token still shelled out to `git
  // remote get-url` and phoned home to GitHub — a real side effect a dry run
  // must not have, regardless of which command asked for it.
  const appCreds = !dryRun && !process.env.GH_TOKEN && appCredsFromEnv();
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
    if (dryRun) {
      console.log(`orch (dry): would write ${join(orchDir, "orch.yml")} (only if absent) and ${join(orchDir, "ORCH.md")} (overwrites)`);
      // --link is the one init effect outside .orch/, so name it explicitly.
      if (flags.link) console.log("orch (dry): would link .orch/ORCH.md into the agent docs (CLAUDE.md / AGENTS.md / GEMINI.md)");
      return;
    }
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
    // --dry isn't a legal flag on `config` (see schema.js's comment on why),
    // but ORCH_DRYRUN=1 still applies here like every other write command —
    // it used to launch the interactive wizard and write orch.yml regardless.
    if (dryRun) {
      console.log(`orch (dry): would run the interactive config wizard and write ${flags["config-file"] || join(orchDir, "orch.yml")}`);
      return;
    }
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
    // validatePositionals (schema.js) already guarantees rest[0] is "add" or
    // "build" and rest[1] (the name) is present before main() gets here.
    if (rest[0] === "build") {
      const name = rest[1];
      const buildFn = deps.buildAgent || buildAgent;
      const result = await buildFn(name, { repo, orchDir, flags, deps });
      if (result.status === "already-registered") { console.log(`orch: ${name} already registered`); return; }
      reportAgentBuildResult(name, result, { withReason: true });
      return;
    }

    // `orch agent add <name>` appends a known agent to the `agents:` rotation
    // pool in orch.yml, preserving the file's comments. "Known" means orch's
    // adapter code has it (adapters.get succeeds) — that is a different
    // question from whether THIS repo's orch.yml already lists it, which the
    // `agents.includes(name)` check below answers. An unregistered name (no
    // adapter code yet) offers to build it — non-interactively via --build,
    // otherwise via the confirm prompt — and building stops there, exactly
    // like `agent build`: it scaffolds the adapter, it does not also add it
    // (the printed tip says to re-run `agent add` once it's merged). Once the
    // adapter code exists, --build has nothing left to do, so it falls
    // straight through to the add — it must not be read as "build instead of
    // add" and skip the add entirely.
    const name = rest[1];
    let unregistered = null;
    try {
      adapters.get(name); // throws "unknown agent: <name>" when no adapter code exists
    } catch (e) {
      unregistered = e;
    }
    if (unregistered) {
      if (flags.build) {
        const buildFn = deps.buildAgent || buildAgent;
        const result = await buildFn(name, { repo, orchDir, flags, deps });
        reportAgentBuildResult(name, result, { withReason: true });
        return;
      }
      const io = deps.io || realIo();
      const answer = await io.confirm(`orch: '${name}' is not a registered agent — build it now? (y/N) `);
      if (!answer) throw unregistered;
      const buildFn = deps.buildAgent || buildAgent;
      const result = await buildFn(name, { repo, orchDir, flags, deps });
      reportAgentBuildResult(name, result);
      return;
    }
    // Known adapter: there is nothing left to build. validatePositionals
    // (schema.js) already refused --pr/the role overrides before main() got
    // here — they only mean something for a build cycle this path never
    // runs. --build itself stays legal (it just means "skip the confirm
    // prompt", which a known adapter never reaches anyway).
    // Honor --config-file like every other write-capable command: edit the file the
    // run would actually read, not always the default .orch/orch.yml.
    const file = flags["config-file"] || configPath(repo);
    if (!existsSync(file)) throw new Error(`no ${flags["config-file"] ? file : "orch.yml"} — run \`orch init\` first`);
    if (load(repo, flags["config-file"]).agents.includes(name)) { console.log(`orch: ${name} already in agents`); return; }
    const text = readFileSync(file, "utf8");
    // Two on-disk shapes: inline flow (`agents: [claude, codex]`) and the
    // scaffold's block sequence (`agents:\n  - claude\n  - codex`). Support both
    // so `agent add` edits either without a full YAML round-trip (which would
    // strip the file's comments).
    const inlineRe = /^(agents:\s*\[)([^\]]*)(\])/m;
    let updated;
    if (inlineRe.test(text)) {
      updated = text.replace(inlineRe, (_m, open, inner, close) =>
        `${open}${inner.trim() ? inner.trim() + ", " : ""}${name}${close}`);
    } else {
      updated = appendAgentToBlockList(text, name);
      if (!updated) throw new Error(`could not find \`agents:\` list in ${file} — add it manually`);
    }
    // Dry runs stop here — after the edit is computed, so --dry still surfaces a
    // config the real run would fail on.
    if (dryRun) {
      console.log(`orch (dry): would add ${name} to agents in ${file}`);
      return;
    }
    writeFileSync(file, updated);
    console.log(`orch: added ${name} to agents`);
    return;
  }

  if (command === "task" || command === "review" || command === "issue" || command === "pr") {
    // D2: reviewer-only is meaningful for task/issue too ("rotate author, force this
    // reviewer"), matching review/continue/pr and the printUsage example.
    let cfg = applyRoleOverrides(load(repo, flags["config-file"]), flags, { allowReviewerOnly: true });
    const dry = Boolean(flags.dry) || process.env.ORCH_DRYRUN === "1";
    // design §4/§6 (P5): the run controller only drives ready/merged — `once`
    // (the default) is today's single implicit cycle, byte-for-byte unchanged
    // below. schema.js already refuses --json without --until ready|merged.
    const until = flags.until || (command === "pr" && flags.merge ? "merged" : "once");
    const jsonMode = Boolean(flags.json);
    const emit = (event) => { if (jsonMode) console.log(JSON.stringify(event)); };
    if (command === "pr" && dry) {
      if (!/^\d+$/.test(rest[0]) && !git.branchExists(repo, rest[0]) && !remoteBranchRefExists(repo, rest[0])) {
        throw usageError("usage: orch pr <number> or <branch> [--until once|ready|merged]");
      }
      console.log(`orch (dry): would review ${/^\d+$/.test(rest[0]) ? `PR #${rest[0]}` : `branch ${rest[0]}`}${until === "merged" ? " and merge it if approved" : ""}`);
      return;
    }
    // design §3/§4: resolve the run policy once so every `run.start` emission
    // (including the concurrency-cap skip path) carries the same object given
    // to the controller for that run.
    const runPolicy = {
      until,
      maxAttempts: until === "once" ? 0 : (cfg.automation?.maxAttempts ?? 3),
      baseMaxAttempts: until === "once" ? 0 : (cfg.automation?.maxAttempts ?? 3),
      humanWaitHours: cfg.automation?.humanWaitHours ?? 24,
      remedies: until === "once" ? [] : cfg.automation?.remedies,
      pollSeconds: cfg.automation?.pollSeconds ?? 30,
      ciWaitMinutes: cfg.automation?.ciWaitMinutes ?? 30,
      baseBranch: cfg.baseBranch,
      integrationBranch: cfg.integrationBranch,
    };

    // F3: operator kill switch. Cycle admission is serialized by the
    // concurrency cap and inflight registry below.
    if (isPaused(orchDir)) throw new Error(".orch/pause present — orchestration paused");

    // `issue` is a task whose work order is fetched from a GitHub issue; it runs
    // the identical author→audit→test→merge cycle, plus `Closes #N` on the merge.
    const mode = command === "task" || command === "issue" ? "task" : "review";
    let task, authorPrompt, reviewBranch, closes = null, workOrder = null, prTarget = null;
    if (command === "issue") {
      const n = rest[0];
      if (!/^\d+$/.test(String(n || ""))) throw usageError("usage: orch issue <number> [--author ... --reviewer ...]");
      const wo = fetchIssueWorkOrder(n, (deps.githubDeps || githubDeps)().gh);
      task = wo.title;
      authorPrompt = buildAuthorPrompt(wo);
      closes = Number(n);
      workOrder = wo;
      // Warn only — never block: the operator decides whether to resume, inspect
      // or stage another branch.
      const prior = priorStagedBranches({ repo, orchDir, closes, task });
      // design §13: stdout under --json is one JSON object per line, nothing else.
      if (prior.length && !jsonMode) console.log(formatPriorStagedBranches(closes, prior));
    } else if (mode === "task") {
      // §3a/§3b: a --file task is UNTRUSTED intake — it must be a JSON work order,
      // validated for shape, then wrapped in a neutralized fence the author treats
      // as reference, not instructions. Free-text `orch task "..."` (operator-typed,
      // trusted) is unchanged. `task` stays a short human label (drives slug/resume);
      // `authorPrompt` is what the author actually sees.
      if (flags.file) {
        // validatePositionals (schema.js) already rejects a stray positional
        // next to --file (ambiguous: two task sources) before main() gets here.
        const wo = parseWorkOrderFile(flags.file);
        task = wo.title;
        authorPrompt = buildAuthorPrompt(wo);
        workOrder = wo;
      } else {
        task = rest.join(" ");
        authorPrompt = task;
      }
      if (!task || !task.trim()) throw usageError('usage: orch task "describe the change" (or --file work-order.json)');
      runPolicy.source = {
        kind: command === "issue" ? "issue" : "task",
        text: workOrder ? `${workOrder.title}\n${workOrder.problem}` : task,
        ...(command === "issue" ? { issue: closes } : {}),
      };
    } else {
      reviewBranch = rest[0];
      if (!reviewBranch) throw usageError(command === "pr" ? "usage: orch pr <number|branch>" : "usage: orch review <branch>");
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
      const remote = hasRemote(repo, ghGit || git.git);
      if (remote && ghAvailable(gh)) requireGhAuth(gh);
      if (command === "pr") {
        if (/^\d+$/.test(String(reviewBranch)) && !remote) {
          throw new Error(`orch pr #${reviewBranch}: repository has no origin remote`);
        }
        prTarget = resolvePrTarget({
          target: reviewBranch,
          repo,
          orchDir,
          baseBranch: cfg.baseBranch,
          until,
          gh: remote ? gh : null,
          git: ghGit || git,
        });
        reviewBranch = prTarget.branch;
      }
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
        if (sync.updated && !jsonMode) console.log(`orch: fast-forwarded local ${cfg.baseBranch} from origin/${cfg.baseBranch}`);
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
      const exclusions = dry ? [] : resumeExclusions(orchDir, task, pinned);
      const forcedReviewers = configuredReviewers(cfg);
      const { authors, reviewers } = nextAuthor(cfg, orchDir, pinned, dry, {
        exclude: exclusions,
        // A reviewer-only override must never leave its requested reviewer
        // reviewing its own work. In a two-agent pool, rotate the author away
        // from that reviewer rather than vacating the requested seat.
        blockedAuthors: forcedReviewers?.length === 1 ? forcedReviewers : [],
      });
      if (!authors.length) throw noEligibleRole("author", {
        exclude: exclusions,
        blockedAuthors: forcedReviewers?.length === 1 ? forcedReviewers : [],
        agents: cfg.agents || [],
      });
      const reviewersForRun = (authorName) => {
        let reviewerList = reviewersForAuthor(authorName, reviewers, { allowSelf: singleAgentPool(cfg) || fixedSelfReview(cfg) })
          .filter((reviewer) => !exclusions.some((value) => exclusionName(value) === reviewer.agent));
        // Cheap mode intentionally uses its single configured seat for both
        // stages; the no-self-review rule still applies to pool rotation.
        if (!reviewerList.length && cfg.cheap?.role === authorName)
          reviewerList = [{ agent: authorName, model: null, effort: null }];
        return reviewerList;
      };
      const eligibleAuthors = authors.filter((authorSpec) => reviewersForRun(authorSpec.agent).length);
      if (!eligibleAuthors.length) throw noEligibleRole("reviewer", { exclude: exclusions, agents: cfg.agents || [] });
      runs = eligibleAuthors.map((authorSpec) => {
        const authorName = authorSpec.agent;
        const { sid, branch, resume } = resolveTaskBranch({ repo, orchDir, task, authorName, dry, liveBranches, baseBranch: cfg.baseBranch, roundCap: cfg.roundCap });
        const reviewerList = reviewersForRun(authorName);
        return {
          mode, task, authorPrompt, workOrder, allowLargeScope: Boolean(flags["allow-large-scope"]),
          until,
          closes, branch, sid, resume, authorName, author: authorSpec,
          reviewerName: reviewerList[0].agent, reviewerNames: reviewerList.map((s) => s.agent),
          reviewers: reviewerList, excludedAgents: exclusions,
          cfg, orchDir, repo, worktree: join(orchDir, "wt", branch.replace(/\//g, "_")),
        };
      });
    } else {
      const branch = reviewBranch;
      // audit-only: reviewers default to all agents except branch author. authorName unused by engine.
      const branchAuthor = branch.split("/")[1];
      const configured = configuredReviewers(cfg);
      const reviewers = reviewersForAuthor(branchAuthor, configured || roleSpecsFromAgents(cfg.agents), {
        allowSelf: singleAgentPool(cfg) || fixedSelfReview(cfg) || flags.reviewer != null || flags.reviewers != null
          || configuredSelfReviewer(cfg, branchAuthor),
      });
      if (!reviewers.length) throw noEligibleRole("reviewer", { agents: cfg.agents || [] });
      const authorName = branchAuthor && cfg.agents.includes(branchAuthor) ? branchAuthor : cfg.agents[0];
      task = null;
      const sid = newSid();
      runs = [{
        mode, task, until, noMerge: command === "pr", prTarget,
        allowLargeScope: Boolean(flags["allow-large-scope"]), branch, sid, authorName, author: { agent: authorName, model: null, effort: null },
        reviewerName: reviewers[0].agent, reviewerNames: reviewers.map((s) => s.agent),
        reviewers,
        cfg, orchDir, repo, worktree: join(orchDir, "wt", branch.replace(/\//g, "_")),
      }];
    }

    if (!jsonMode) maybePrintRunBanner(cfg, runs, flags, deps.stdout);
    if (!dry && runs.some((run) => run.resume)) notify.resetKpi(orchDir);

    const results = [];
    const mergedBranches = []; // cycle branches that actually landed on integration
    const prUrls = [];
    for (const run of runs) {
      let activeRun = run;
      let resumable = false;
      const registeredSids = new Set([run.sid]);
      const cycleRoles = [{ authorName: run.authorName, reviewerNames: run.reviewerNames }];
      // A resumed run (run.resume) reuses the ORIGINAL run's sid as its runId —
      // look up its existing record so create() below doesn't stomp
      // attempt/cycles/lastError back to genesis, and so the terminal update
      // appends this cycle instead of replacing the whole history.
      const priorRecord = dry ? null : runRecord.lookup(orchDir, run.sid);
      const detachedRun = detachedInfo(priorRecord?.runId || run.sid, process.env.ORCH_DETACH_LOG);
      const detachedRecord = detachedRecordInfo(detachedRun);
      let clearDetachedCleanup = null;
      if (!dry) {
        const baseSha = git.git(["rev-parse", cfg.baseBranch], repo);
        const accepted = registerWithConcurrencyCap(
          orchDir,
          run.sid,
          {
            branch: run.branch, pid: process.pid, baseSha, closes: run.closes || null,
            author: run.author, reviewers: run.reviewers, workOrder: run.workOrder,
            excludedAgents: run.excludedAgents,
            ...(detachedRun ? { detached: true, detachedLog: detachedRun.detachedLog, runId: detachedRun.runId } : {}),
          },
          cfg,
          { onExceeded: (live) => {
            // design §13: stdout under --json is one JSON object per line, nothing
            // else, and `run.end` always carries `blockedReason` when exit == 3 —
            // emit the pair here rather than a bare console.log so a skipped run
            // still closes out the event stream instead of just vanishing from it.
            if (jsonMode) {
              emit({ event: "run.start", runId: run.sid, command, until, policy: runPolicy, cwd: process.cwd(), orchVersion: DISPLAY_VERSION });
              emit({ event: "run.end", runId: run.sid, outcome: "blocked", exit: 3, blockedReason: "concurrency-cap", usage: {} });
            } else {
              console.log(`orch: concurrency cap ${cfg.concurrency} reached — ${live} cycles live; skipping ${run.branch}`);
            }
            // 3 = blocked by a policy/capacity limit, distinct from 2 (the cycle
            // ran and did not agree) — a caller can retry a 3, not a 2.
            raiseExitCode(3);
          } },
        );
        if (!accepted) {
          continue;
        }
        // runId == this cycle's sid (design §5.1/§5.3) until the run-controller
        // (P5) can extend a run across more than one cycle. `--dry` writes none.
        if (!priorRecord) runRecord.create(orchDir, { runId: run.sid, command, argv: argv.map(redact), policy: runPolicy, prTarget: run.prTarget || null, detached: detachedRecord });
        else if (detachedRecord) runRecord.update(orchDir, priorRecord.runId, { detached: detachedRecord });
        clearDetachedCleanup = installDetachedSignalCleanup(orchDir, priorRecord?.runId || run.sid, detachedRun);
      }
      emit({ event: "run.start", runId: run.sid, command, until, policy: runPolicy, cwd: process.cwd(), orchVersion: DISPLAY_VERSION });
      try {
        const cycleDeps = dry ? dryDeps() : (deps.cycleDeps || (deps.realDeps || realDeps)({ closes: run.closes }));
        const result = await runCycle(run, cycleDeps);
        results.push(result);
        let finalResult = result;
        if (!dry) {
          const attempt = priorRecord ? priorRecord.attempt + 1 : 0;
          let outcome = outcomeForResult(result);
          let exit = exitForResult(result);
          let state = STATE_FOR_OUTCOME[outcome];
          // "merged" landed on the standing integration→main PR; "pr"
          // (merge: pr mode) and "merge-deferred" (demote) each open a
          // fresh PR scoped to this cycle's own branch.
          let pr = result.prUrl ? { number: null, url: result.prUrl, kind: result.status === "merged" ? "standing" : "per-cycle" } : null;
          let controller = null;
          const cycleSids = [run.sid];
          const cycleBranches = [run.branch];
          // design §6/§9 (P5): once the local cycle lands, `ready`/`merged`
          // also wait on the remote standing PR before this run is done —
          // `once` (bare/default) stops here, unchanged from before P5.
          if (until !== "once") {
            const record = {
              attempt,
              retries: priorRecord?.retries || {},
              failures: priorRecord?.failures || [],
              excludedAgents: run.excludedAgents || priorRecord?.excludedAgents || [],
              headMovedRepins: priorRecord?.headMovedRepins || 0,
              policy: { ...runPolicy },
              ...(priorRecord?.human ? { human: priorRecord.human } : {}),
            };
            // Same `deps.githubDeps` override point every other gh call in this
            // file uses (real git access stays direct — these tests run against
            // a real temp repo, only the gh CLI itself gets faked).
            const ghDeps = { gh: (deps.githubDeps || githubDeps)().gh };
            const freshCycle = async (options = {}) => {
              const picks = options.picks || (options.author || options.reviewers ? options : null);
              let cycleRun = { ...activeRun, resume: true };
              let cycleDepsForRun = cycleDeps;
              const reauthorCycle = Boolean(options.reauthor || options.revise);
              if (reauthorCycle) {
                const previousRun = activeRun;
                const nextBranch = options.branch || previousRun.branch;
                const nextSid = options.sid || previousRun.sid;
                const changedIdentity = nextBranch !== previousRun.branch || nextSid !== previousRun.sid;
                const nextRun = {
                  ...previousRun,
                  author: options.author || previousRun.author,
                  authorName: options.authorName || previousRun.authorName,
                  reviewers: options.reviewers || previousRun.reviewers,
                  reviewerName: options.reviewerName || previousRun.reviewerName,
                  reviewerNames: options.reviewerNames || previousRun.reviewerNames,
                  authorPrompt: options.authorPrompt ?? previousRun.authorPrompt,
                  workOrder: options.workOrder ?? previousRun.workOrder,
                  branch: nextBranch,
                  sid: nextSid,
                  worktree: join(orchDir, "wt", nextBranch.replace(/\//g, "_")),
                  resume: options.resume ?? Boolean(options.revise),
                  reviewerOverride: options.reviewerOverride ?? false,
                  rotationStage: options.revise ? "revising" : "started",
                };
                if (!dry && changedIdentity) {
                  inflight.deregister(orchDir, previousRun.sid);
                  const baseSha = git.git(["rev-parse", cfg.baseBranch], repo);
                  registerWithConcurrencyCap(
                    orchDir,
                    nextSid,
                    {
                      branch: nextBranch, pid: process.pid, baseSha,
                      closes: nextRun.closes || null, author: nextRun.author,
                      reviewers: nextRun.reviewers, workOrder: nextRun.workOrder,
                      excludedAgents: nextRun.excludedAgents || [], rotationStage: nextRun.rotationStage,
                    },
                    cfg,
                    { onExceeded: () => { throw Object.assign(new Error(`orch: concurrency cap ${cfg.concurrency} reached — reauthor cycle cannot start`), { exit: 3 }); } },
                  );
                  registeredSids.add(nextSid);
                }
                activeRun = nextRun;
                if (!dry && options.revise) {
                  checkpoint.record(orchDir, nextSid, {
                    branch: nextBranch, round: 1, stage: "revising",
                    reason: options.reason || "human addendum", author: nextRun.author,
                    reviewers: nextRun.reviewers, task: nextRun.task,
                    authorPrompt: nextRun.authorPrompt, workOrder: nextRun.workOrder || null,
                    closes: nextRun.closes || null, excludedAgents: nextRun.excludedAgents || [],
                  });
                }
                cycleRun = { ...nextRun, resume: nextRun.resume };
              } else if (picks) {
                const previousAuthor = activeRun.authorName;
                const { freshAuthor = false, ...rolePicks } = picks;
                const nextRun = {
                  ...activeRun, ...rolePicks, resume: true,
                  // Preserve whether the replacement must re-enter authoring
                  // when a process dies before the replacement checkpoint.
                  rotationStage: freshAuthor ? "started" : "authored",
                };

                // Persist replacement roles and exclusions before clearing the
                // old checkpoint, so `continue` can recover the new seats if
                // this process dies before the replacement cycle checkpoints.
                persistRotationState({
                  orchDir,
                  sid: run.sid,
                  runId: priorRecord?.runId || run.sid,
                  run,
                  nextRun,
                  previousAuthor,
                }, deps.rotationState);
                activeRun = nextRun;

                // Keep the replacement worktree when the failed adapter left
                // it as the only recovery copy. `runCycle` stays in resume mode
                // so its partial-WIP guards remain active.
                const preserved = existsSync(`${activeRun.worktree}.orch-preserve`);
                cycleDepsForRun = preserved
                  ? { ...cycleDeps, git: { ...cycleDeps.git, pruneWorktree() {} } }
                  : cycleDeps;
                checkpoint.record(orchDir, run.sid, {
                  branch: activeRun.branch,
                  round: 1,
                  stage: activeRun.rotationStage,
                  author: activeRun.author,
                  reviewers: activeRun.reviewers,
                  task: activeRun.task,
                  authorPrompt: activeRun.authorPrompt,
                  workOrder: activeRun.workOrder || null,
                  closes: activeRun.closes || null,
                  excludedAgents: activeRun.excludedAgents || [],
                });
                cycleRun = { ...activeRun, resume: true, reviewerOverride: true };
              }
              cycleRoles.push({ authorName: cycleRun.authorName, reviewerNames: cycleRun.reviewerNames });
              cycleSids.push(cycleRun.sid);
              cycleBranches.push(cycleRun.branch);
              return runCycle(cycleRun, cycleDepsForRun);
            };
            const reauthor = createReauthorRemedy({
              getRun: () => activeRun,
              deps: cycleDeps,
              createCycle: freshCycle,
            });
            const integrationRepair = async (context) => {
              let repairRun = activeRun;
              if (repairRun.prTarget?.needsRepairBranch) {
                try {
                  repairRun = preparePrRepairRun(repairRun, cfg, ghDeps);
                  activeRun = repairRun;
                } catch (error) {
                  return {
                    result: {
                      state: "STOPPED_AT_CAP",
                      outcome: "stopped-at-cap",
                      exit: 2,
                      failureClass: context.failure?.class,
                      failure: context.failure,
                      reason: `could not create PR repair branch: ${error.message || error}`,
                    },
                    record: context.record,
                  };
                }
              }
              return createIntegrationRepairRemedy({
                run: repairRun,
                deps: { ...cycleDeps, sleep: deps.sleep },
                gh: ghDeps.gh,
                resolveLanded: (cycle) => resolveLanded(cycle, activeRun, cfg, ghDeps, repo),
              })(context);
            };
            controller = await runUntil(runPolicy, record, {
              runCycle: async ({ fresh } = {}) => fresh
                ? freshCycle()
                : result,
              remedies: {
                rebase: createRebaseRemedy({
                  getRun: () => activeRun,
                  deps: cycleDeps,
                  runCycle: () => freshCycle(),
                }),
                // #551: without this key the lookup in run-controller.js
                // misses and every REMOTE_BEHIND/CONFLICTING/CI_RED run ends
                // as a terminal failure instead of repairing (design §10A).
                "integration-repair": integrationRepair,
                rotate: createRotateRemedy({
                  getRun: () => activeRun,
                  deps: cycleDeps,
                  runCycle: freshCycle,
                  selectRoles: nextAuthor,
                }),
                reauthor,
                ask: createAskRemedy({
                  getRun: () => activeRun,
                  deps: { ...ghDeps, sleep: deps.sleep, ...(deps.now ? { now: deps.now } : {}) },
                  runCycle: freshCycle,
                  reauthor,
                }),
              },
              resolveLanded: (cycle) => resolveLanded(cycle, activeRun, cfg, ghDeps, repo),
              mergeStanding: (args) => mergeForRun(args, activeRun, cfg, ghDeps, emit),
              gh: ghDeps.gh, git, repo,
              sleep: deps.sleep,
            });
            outcome = controller.outcome;
            exit = controller.exit;
            state = controller.state;
            if (controller.land?.pr?.number) {
              pr = { number: controller.land.pr.number, url: controller.land.pr.url, kind: controller.land.landing === "standing" ? "standing" : "per-cycle" };
            }
            raiseExitCode(exit);
          }
          const cycleResults = controller?.cycleResults || [result];
          for (const retryResult of cycleResults.slice(1)) results.push(retryResult);
          finalResult = outputResult(cycleResults[cycleResults.length - 1], controller);
          results[results.length - 1] = finalResult;
          if (finalResult.prUrl && !controller?.land) {
            pr = { number: null, url: finalResult.prUrl, kind: finalResult.status === "merged" ? "standing" : "per-cycle" };
          }
          // A cap or human wait is deliberately resumable. Other terminal
          // outcomes are complete (or blocked) and can release their resume
          // state. A throw skips this line, leaving state for `continue`.
          resumable = until !== "once" && (outcome === "stopped-at-cap" || outcome === "wait-timeout");
          if (run.mode === "task" && activeRun.branch !== run.branch) resume.clearForBranch(orchDir, run.branch);
          if (!resumable) {
            if (run.mode === "task") resume.clearForBranch(orchDir, activeRun.branch);
            for (const cycleSid of registeredSids) checkpoint.clear(orchDir, cycleSid);
          }
          state = STATE_FOR_OUTCOME[outcome];
          const persistedAttempt = controller?.attempt ?? attempt;
          const cycleRunStats = cycleResults.flatMap((cycleResult) => cycleResult.runStats || []);
          const usage = cycleRunStats.length ? totalUsage(cycleRunStats) : finalResult.usage || {};
          runRecord.update(orchDir, run.sid, {
            state,
            outcome,
            exit,
            attempt: persistedAttempt,
            ...(controller?.retries ? { retries: controller.retries } : {}),
            branch: activeRun.branch,
            prTarget: activeRun.prTarget || run.prTarget || null,
            pr,
            ...(controller?.land ? { integration: { branch: controller.land.branch, landedSha: controller.headSha || controller.land.expectedHead } } : {}),
            ...(controller?.headMovedRepins != null ? { headMovedRepins: controller.headMovedRepins } : {}),
            ...(controller?.merge ? { merge: controller.merge } : {}),
            excludedAgents: controller?.excludedAgents || activeRun.excludedAgents || priorRecord?.excludedAgents || [],
            policy: controller?.policy || runPolicy,
            ...(controller?.human ? { human: controller.human } : {}),
            ...(controller?.resumeCommand ? { resumeCommand: controller.resumeCommand } : {}),
            ...(controller?.failures || controller?.failure ? {
              failures: [
                ...(controller?.failures || priorRecord?.failures || []),
                ...(controller?.failure ? [{ attempt: persistedAttempt, class: controller.failure.class, fingerprint: controller.failure.fingerprint, at: new Date().toISOString() }] : []),
              ],
            } : {}),
            cycles: [
              ...(priorRecord?.cycles || []),
              ...cycleResults.map((cycleResult, index) => ({
                sid: cycleSids[index] || run.sid, attempt: persistedAttempt,
                branch: cycleBranches[index] || activeRun.branch,
                author: cycleRoles[index]?.authorName || activeRun.authorName,
                reviewers: cycleRoles[index]?.reviewerNames || activeRun.reviewerNames,
                status: cycleResult.status, reason: cycleResult.reason || null,
              })),
            ],
          });
          const mergeEvent = mergeVerifiedEvent(run.sid, controller, cfg);
          if (mergeEvent) emit(mergeEvent);
          emit({
            event: "run.end", runId: run.sid, outcome, exit, usage,
            ...(controller?.failure ? { failureClass: controller.failure.class } : {}),
            ...(controller?.blockedReason ? { blockedReason: controller.blockedReason } : {}),
            ...(controller?.warnings?.length ? { warnings: controller.warnings } : {}),
            ...(controller?.note ? { note: controller.note } : {}),
            ...(controller?.resumeCommand ? { resumeCommand: controller.resumeCommand } : {}),
            ...(pr?.url ? { prUrl: pr.url } : {}),
          });
        } else {
          // `--dry` writes no run record and (design §4) never polls readiness —
          // still emit run.end under --json so the event stream isn't silently
          // truncated after run.start.
          emit({ event: "run.end", runId: run.sid, outcome: outcomeForResult(result), exit: exitForResult(result), usage: result.usage || {}, dry: true });
        }
        if (!jsonMode) console.log(summaryLine(finalResult, activeRun.branch, dry, cleanStreakSuffix(orchDir, dry), colorEnabled(process.stdout), run.closes));
        if (finalResult.status === "merged" && run.mode === "task") mergedBranches.push(activeRun.branch);
        if (finalResult.prUrl) prUrls.push(finalResult.prUrl);
        if (run.mode === "review" && activeRun.prTarget) {
          commentOnPr(finalResult, activeRun, deps.githubDeps || githubDeps);
        }
        if (finalResult.status === "escalated" || finalResult.status === "merge-deferred") {
          // Under `ready`/`merged` the exit code already came from the run
          // controller above (STOPPED_AT_CAP=2 or BLOCKED=3 per design §6) —
          // raising a flat 2 here too is harmless (raiseExitCode keeps the
          // higher of the two) but only `once` needs this as its only source.
          if (until === "once") raiseExitCode(2);
          // Issue bridge: leave a trace on the source issue — headless runs have
          // no one watching stdout, and the DECISION.md file is local-only.
          if (!dry) commentOnIssue(finalResult, activeRun.branch, run.closes, deps.githubDeps || githubDeps);
        }
      } catch (err) {
        if (!dry) {
          runRecord.update(orchDir, run.sid, {
            state: "ERROR",
            outcome: "error",
            exit: 1,
            prTarget: activeRun.prTarget || run.prTarget || null,
            lastError: toLastError(err),
          });
        }
        // Same "don't truncate the --json stream after run.start" contract as
        // the concurrency-cap and --dry paths above — an uncaught throw here
        // (e.g. a gh call this loop doesn't already fail closed, see
        // findPrByHeadSafe/prView above) must still close out the event
        // stream with a run.end before the bin/orch.js catch-all prints to
        // stderr and exits.
        if (jsonMode) emit({ event: "run.end", runId: run.sid, outcome: "error", exit: 1, usage: {} });
        throw err;
      } finally {
        clearDetachedCleanup?.();
        if (!dry) for (const cycleSid of registeredSids) inflight.deregister(orchDir, cycleSid);
        if (!dry && !resumable && run.prTarget?.ephemeral
          && orchOwnsBranch(run.prTarget.sourceBranch, orchDir)) {
          git.gitTry(["branch", "-D", "--", run.prTarget.sourceBranch], repo);
        }
      }
    }
    // After the cycles: the detached docs-update runs `orch task`, so spawn it
    // outside the loop. maybeSpawnDocs only fires on a real `merged` result.
    let docsPending = false;
    for (const result of results) docsPending = maybeSpawnDocs(result, cfg, { dry, spawn: deps.spawn, quiet: jsonMode }, orchDir) || docsPending;

    // #44: a human is at the terminal — tidy up the branches/state orch created and
    // explain it in plain English, instead of dead-ending in an opaque git state.
    // Default on; `--no-tidy` opts out. finishRun is idempotent, so the detached
    // docs child (which re-runs `orch task`) safely tidies itself when it lands.
    if (!dry && !flags["no-tidy"] && mergedBranches.length) {
      const finishFn = deps.finishRun || finishRun;
      // --json: keep tidying (branch cleanup is a real side effect), but a
      // human-readable print here would land after run.end and break "last
      // line is JSON" (design §13's stdout contract).
      const io = jsonMode ? { ...realIo(), print: () => {} } : (deps.io || realIo());
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
    if (!sid) throw usageError("usage: orch continue <sid>");
    const cfg = applyRoleOverrides(load(repo, flags["config-file"]), flags, { allowReviewerOnly: true });
    const dry = Boolean(flags.dry) || process.env.ORCH_DRYRUN === "1";
    const jsonMode = Boolean(flags.json);
    const emit = (event) => { if (jsonMode) console.log(JSON.stringify(event)); };
    if (isPaused(orchDir)) throw new Error(".orch/pause present — orchestration paused");
    // Run-record lookup (design §5.3): resolves by runId OR by any cycle sid
    // recorded under a run — a pre-v2 sid with no record simply misses here
    // and falls through to today's checkpoint/inflight resume below. A
    // terminal `stopped-at-cap`/`wait-timeout` record gets a fresh attempt
    // budget; the branch/task reattach mechanics stay checkpoint/inflight-driven
    // until the run-controller (P5) exists to act on that budget.
    const priorRun = dry ? null : runRecord.lookup(orchDir, sid);
    // Preflight (adapter registered + CLI on PATH + .orch/ writable) runs below,
    // once the resume's actual author/reviewer agents are known — see the
    // `opts.only` comment on preflight() for why this can't run against the
    // full current orch.yml pool here.
    // A hard-killed prior attempt at this sid can leave its worktree checked out
    // under .orch/wt with a dead owner pid — reclaim it BEFORE reattaching the
    // branch, same as `task`/`pr` do at cycle start, or `runCycle`'s worktree
    // setup collides with the orphaned checkout. liveBranches spares real peers.
    // Checkpoint is authoritative for completed stages, while inflight carries
    // the replacement roles and exclusions written immediately before a
    // rotation clears the old checkpoint. Read both BEFORE listLive() below:
    // listLive() prunes any inflight record whose owner pid is dead — exactly
    // the case a died-before-checkpoint resume needs to read (#129).
    const resumeSid = priorRun?.cycles?.at(-1)?.sid || sid;
    const ck = checkpoint.lookup(orchDir, resumeSid);
    const inf = inflight.lookup(orchDir, resumeSid);

    if (!dry) {
      const liveEntries = inflight.listLive(orchDir);
      // Codex review (#125 stalemate): a sid that already has a live, alive-pid
      // inflight entry is genuinely running right now — a second `continue` (or
      // a `continue` racing the original `task`/`issue` run) would overwrite that
      // entry's inflight file out from under it and collide on the same worktree
      // path. Refuse rather than clobber.
      const stillLive = liveEntries.find((e) => e.sid === resumeSid);
      if (stillLive) throw new Error(`orch: sid ${sid} already has a live run (pid ${stillLive.pid}) — refusing to attach a second`);
      const liveBranches = new Set(liveEntries.map((e) => e.branch));
      resetKpiOnRecovery(orchDir, git.reclaimOrphanWorktrees(repo, orchDir, liveBranches, { base: cfg.baseBranch }));
    }
    const branch = ck?.branch || inf?.branch;
    if (!branch) throw new Error(`orch: no checkpoint or inflight record for sid ${sid} — nothing to resume`);
    if (!git.branchExists(repo, branch)) {
      if (remoteBranchRefExists(repo, branch)) throw new Error(`orch: branch ${branch} (sid ${sid}) exists only as origin/${branch}; check it out locally before continuing`);
      if (!dry) {
        if (ck) checkpoint.clear(orchDir, resumeSid);
        if (inf) inflight.deregister(orchDir, resumeSid);
        console.log(`orch: branch ${branch} (sid ${sid}) no longer exists; cleared stale resume state`);
        return;
      }
      throw new Error(`orch: branch ${branch} (sid ${sid}) no longer exists`);
    }
    // A pre-authoring checkpoint or inflight-only fallback may represent a run
    // that died before the author committed anything — neither record proves
    // there's work to review/merge until the branch has a committed diff.
    const branchAuthor = branch.split("/")[1];
    const rotationRecorded = Boolean(inf?.rotationStage);
    if (((inf && !ck) || (ck?.stage === "started" && !ck.task))
      && !rotationRecorded
      && git.changedFiles(repo, branch, cfg.baseBranch).length === 0) {
      if (!dry && ck) checkpoint.clear(orchDir, resumeSid);
      throw new Error(`orch: branch ${branch} (sid ${sid}) has no committed changes — the run died before authoring finished; start a fresh \`orch task\` instead`);
    }

    // Codex review (#125 stalemate): `cfg.agents` is only the rotation pool —
    // a branch can legitimately be authored by a fixed `author:`/`--author`
    // role outside that pool (e.g. `author: qwen3-coder-30b` with
    // `agents: [claude, codex]`), which existing config/tests already allow.
    // The real validity check is whether the name has a registered adapter.
    // Numeric PR checkouts use the synthetic `pr-<number>` branch name, so
    // their persisted checkpoint/run target supplies the author instead.
    // The original run persisted its resolved author/reviewer role specs (agent
    // + model + effort, not just names) into the checkpoint/inflight record —
    // reuse those by default so a resume picks up the same models the original
    // run used, rather than re-resolving against whatever orch.yml/rotation say
    // *now* (which may have moved on since the original run started). An
    // explicit --reviewer(s) on this command overrides for this resume only —
    // it never rewrites the persisted record. --author is not overridable here:
    // the branch's commits were already authored by a specific agent.
    const persistedAuthor = inf?.author || ck?.author;
    if (!branchAuthor && !persistedAuthor?.agent && !priorRun?.prTarget) {
      throw new Error(`orch: cannot determine an author from branch ${branch}`);
    }
    const rotationStage = inf?.rotationStage || null;
    const persistedExclusions = [
      ...(priorRun?.excludedAgents || []),
      ...(ck?.excludedAgents || []),
      ...(inf?.excludedAgents || []),
    ];
    const exclusions = new Map();
    for (const value of persistedExclusions) {
      const entry = exclusionRecord(value);
      if (entry && !exclusions.has(entry.name)) exclusions.set(entry.name, entry);
    }
    const excludedNames = new Set(exclusions.keys());
    const selectedRoles = nextAuthor(cfg, orchDir, persistedAuthor?.agent || branchAuthor || cfg.agents?.[0], true, {
      exclude: [...excludedNames],
      persist: false,
    });
    const authorSpec = persistedAuthor?.agent && !excludedNames.has(persistedAuthor.agent)
      ? persistedAuthor
      : selectedRoles.authors?.[0]
        || (branchAuthor && !excludedNames.has(branchAuthor) ? { agent: branchAuthor, model: null, effort: null } : null);
    if (!authorSpec) throw noEligibleRole("author", { exclude: [...excludedNames], agents: cfg.agents || [] });
    const authorName = authorSpec.agent;
    try { adapters.get(authorName); }
    catch { throw new Error(`orch: cannot determine a registered author from branch ${branch}`); }
    const reviewerOverride = flags.reviewers != null || flags.reviewer != null;
    const persistedReviewers = inf?.reviewers?.length ? inf.reviewers : ck?.reviewers?.length ? ck.reviewers : null;
    const configuredSelfReview = configuredSelfReviewer(cfg, authorName);
    const eligiblePersistedReviewers = (persistedReviewers || [])
      .filter((reviewer) => reviewer?.agent
        && (reviewer.agent !== authorName || singleAgentPool(cfg) || configuredSelfReview)
        && !excludedNames.has(reviewer.agent));
    const configured = configuredReviewers(cfg);
    const fallbackReviewers = reviewersForAuthor(authorName, configured || selectedRoles.reviewers || roleSpecsFromAgents(cfg.agents), {
      allowSelf: singleAgentPool(cfg) || reviewerOverride || configuredSelfReview,
    })
      .filter((reviewer) => !excludedNames.has(reviewer.agent));
    const reviewers = !reviewerOverride && eligiblePersistedReviewers.length
      ? eligiblePersistedReviewers
      : fallbackReviewers;
    if (!reviewers.length) throw noEligibleRole("reviewer", { exclude: [...excludedNames], agents: cfg.agents || [] });
    if (!dry) preflightFn(cfg, orchDir, { only: [authorSpec.agent, ...reviewers.map((r) => r.agent)] });

    // Codex review (#125 stalemate): an `orch issue <n>` run stamps `Closes #n`
    // at merge time via ctx.closes — reconstruct it here too, or a resumed
    // issue-bridge cycle merges without ever closing the issue. checkpoint is
    // authoritative once a round has completed; the inflight fallback covers a
    // death before that.
    const closes = ck?.closes ?? inf?.closes ?? null;
    const task = ck?.task || branch;
    const authorPrompt = ck?.authorPrompt || task;
    const workOrder = ck?.workOrder || inf?.workOrder || null;
    if ((ck?.stage === "started" || ck?.stage === "revising") && !ck?.task) {
      throw new Error(`orch: cannot resume ${ck.stage} author for sid ${sid} — checkpoint has no original task`);
    }

    const allowLargeScope = Boolean(flags["allow-large-scope"]);
    const isPrResume = priorRun?.command === "pr";
    const prTarget = priorRun?.prTarget || null;
    const run = {
      // Older completed-author checkpoints carry no task, so retain the branch
      // fallback for their changelog label. Author-stage resumes fail above
      // unless they have the original work order and can execute it safely.
      mode: isPrResume ? "review" : "task", task, authorPrompt, workOrder,
      until: flags.until || priorRun?.policy?.until || "once",
      allowLargeScope, branch, sid: resumeSid, resume: true, closes,
      noMerge: isPrResume, prTarget,
      authorName, author: authorSpec,
      reviewerName: reviewers[0].agent, reviewerNames: reviewers.map((s) => s.agent),
      reviewers,
      excludedAgents: [...exclusions.values()],
      // Codex review (#126 stalemate): `reviewers` above is what this resume
      // actually audits with — an explicit `--reviewer` override applies for
      // this run only. `persistReviewers` is what engine.js writes back into
      // the checkpoint if this run dies before finishing — always the
      // ORIGINAL persisted roles when one exists, so a killed-mid-override
      // resume can't quietly make the override permanent (see the persistCase
      // fallback to `reviewers` in engine.js: only matters when no persisted
      // record existed yet, in which case there's nothing to protect).
      persistReviewers: rotationRecorded ? reviewers : (persistedReviewers || reviewers),
      // Codex review (#126 stalemate, round 3): a checkpoint already at
      // "reviewed"/"tested" caches the OLD verdict; without this flag
      // engine.js would trust that cached verdict and skip the audit call
      // entirely, so the overridden reviewer would never actually run.
      reviewerOverride: reviewerOverride || rotationRecorded,
      cfg, orchDir, repo, worktree: join(orchDir, "wt", branch.replace(/\//g, "_")),
    };

    const detachedRun = detachedInfo(priorRun?.runId || sid, process.env.ORCH_DETACH_LOG);
    const detachedRecord = detachedRecordInfo(detachedRun);
    let clearDetachedCleanup = null;
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
        resumeSid,
        {
          branch, pid: process.pid, baseSha, closes, author: authorSpec,
          reviewers: run.persistReviewers, workOrder, excludedAgents: run.excludedAgents,
          rotationStage,
          ...(detachedRun ? { detached: true, detachedLog: detachedRun.detachedLog, runId: detachedRun.runId } : {}),
        },
        cfg,
        { onExceeded: (live) => { throw Object.assign(new Error(`orch: concurrency cap ${cfg.concurrency} reached — ${live} cycles live; try again shortly`), { exit: 3 }); } },
      );
    }
    // Only reached once a checkpoint/inflight record proved there's actually
    // something to reattach — grant the fresh budget here, not at the earlier
    // lookup, or every refusal path above (no branch, no committed changes, no
    // registered author) would have already erased outcome/exit/retries on a
    // record that never got resumed.
    const resumedRecord = priorRun
      ? runRecord.resumeTerminal(orchDir, priorRun.runId, { maxAttempts: priorRun.attempt + (priorRun.policy?.maxAttempts ?? 1) })
      : null;
    const runId = priorRun?.runId || sid;
    // Create the record BEFORE runCycle, not after: a pre-v2 sid with no prior
    // record must still leave one behind if runCycle throws, or a crashed
    // continue produces no durable record at all (violates design §5's "after
    // any run a record with `outcome` exists").
    if (!dry && !priorRun) runRecord.create(orchDir, { runId, command, argv: argv.map(redact), detached: detachedRecord });
    else if (!dry && detachedRecord) runRecord.update(orchDir, runId, { detached: detachedRecord });
    clearDetachedCleanup = installDetachedSignalCleanup(orchDir, runId, detachedRun);
    if (!dry && rotationRecorded && !ck) {
      checkpoint.record(orchDir, resumeSid, {
        branch,
        round: 1,
        stage: rotationStage || "started",
        author: authorSpec,
        reviewers: run.reviewers,
        task: run.task,
        authorPrompt: run.authorPrompt,
        workOrder: run.workOrder || null,
        closes,
        excludedAgents: run.excludedAgents,
      });
    }
    const baseContinueDeps = deps.cycleDeps || realDeps({ closes });
    const continueDeps = !dry && rotationRecorded && existsSync(`${run.worktree}.orch-preserve`)
      ? { ...baseContinueDeps, git: { ...baseContinueDeps.git, pruneWorktree() {} } }
      : baseContinueDeps;
    const controllerPolicy = priorRun?.policy?.until && priorRun.policy.until !== "once"
      ? {
        ...priorRun.policy,
        until: flags.until || priorRun.policy.until,
        baseMaxAttempts: priorRun.policy.baseMaxAttempts ?? priorRun.policy.maxAttempts ?? 1,
        maxAttempts: resumedRecord?.policy?.maxAttempts ?? priorRun.attempt + (priorRun.policy.maxAttempts ?? 1),
      }
      : null;
    const resumePolicy = controllerPolicy || resumedRecord?.policy || priorRun?.policy || { until: flags.until || "once" };
    emit({ event: "run.start", runId, command, until: resumePolicy.until, policy: resumePolicy, cwd: process.cwd(), orchVersion: DISPLAY_VERSION });
    if (priorRun?.outcome === "stopped-at-cap" || priorRun?.outcome === "wait-timeout") {
      emit({ event: "run.resume", runId, previousOutcome: priorRun.outcome, maxAttempts: resumedRecord?.policy?.maxAttempts });
    }
    let activeRun = run;
    let controller = null;
    let finalResult;
    const registeredSids = new Set([resumeSid]);
    try {
      const result = await runCycle(run, dry ? dryDeps() : continueDeps);
      finalResult = result;
      if (!dry && controllerPolicy) {
        const cycleSids = [resumeSid];
        const cycleBranches = [branch];
        const cycleRoles = [{ authorName: run.authorName, reviewerNames: run.reviewerNames }];
        const freshCycle = async (options = {}) => {
          const picks = options.picks || (options.author || options.reviewers ? options : null);
          let cycleRun = { ...activeRun, resume: true };
          let cycleDepsForRun = continueDeps;
          const reauthorCycle = Boolean(options.reauthor || options.revise);
          if (reauthorCycle) {
            const previousRun = activeRun;
            const nextBranch = options.branch || previousRun.branch;
            const nextSid = options.sid || previousRun.sid;
            const changedIdentity = nextBranch !== previousRun.branch || nextSid !== previousRun.sid;
            activeRun = {
              ...previousRun, ...options,
              branch: nextBranch, sid: nextSid,
              worktree: join(orchDir, "wt", nextBranch.replace(/\//g, "_")),
              resume: options.resume ?? Boolean(options.revise),
              rotationStage: options.revise ? "revising" : "started",
            };
            if (changedIdentity) {
              inflight.deregister(orchDir, previousRun.sid);
              const baseSha = git.git(["rev-parse", cfg.baseBranch], repo);
              registerWithConcurrencyCap(orchDir, nextSid, {
                branch: nextBranch, pid: process.pid, baseSha,
                closes: activeRun.closes || null, author: activeRun.author,
                reviewers: activeRun.reviewers, workOrder: activeRun.workOrder,
                excludedAgents: activeRun.excludedAgents || [],
                rotationStage: activeRun.rotationStage,
              }, cfg, {
                onExceeded: () => { throw Object.assign(new Error(`orch: concurrency cap ${cfg.concurrency} reached — reauthor cycle cannot start`), { exit: 3 }); },
              });
              registeredSids.add(nextSid);
            }
            if (options.revise) checkpoint.record(orchDir, nextSid, {
              branch: nextBranch, round: 1, stage: "revising",
              reason: options.reason || "human addendum", author: activeRun.author,
              reviewers: activeRun.reviewers, task: activeRun.task,
              authorPrompt: activeRun.authorPrompt, workOrder: activeRun.workOrder || null,
              closes: activeRun.closes || null, excludedAgents: activeRun.excludedAgents || [],
            });
            cycleRun = { ...activeRun, resume: activeRun.resume };
          } else if (picks) {
            const previousAuthor = activeRun.authorName;
            const { freshAuthor = false, ...rolePicks } = picks;
            const nextRun = {
              ...activeRun, ...rolePicks, resume: true,
              rotationStage: freshAuthor ? "started" : "authored",
            };

            persistRotationState({
              orchDir,
              sid: run.sid,
              runId: priorRun?.runId || run.sid,
              run,
              nextRun,
              previousAuthor,
            }, deps.rotationState);
            activeRun = nextRun;

            const preserved = existsSync(`${activeRun.worktree}.orch-preserve`);
            cycleDepsForRun = preserved
              ? { ...continueDeps, git: { ...continueDeps.git, pruneWorktree() {} } }
              : continueDeps;
            checkpoint.record(orchDir, run.sid, {
              branch: activeRun.branch,
              round: 1,
              stage: activeRun.rotationStage,
              author: activeRun.author,
              reviewers: activeRun.reviewers,
              task: activeRun.task,
              authorPrompt: activeRun.authorPrompt,
              workOrder: activeRun.workOrder || null,
              closes: activeRun.closes || null,
              excludedAgents: activeRun.excludedAgents || [],
            });
            cycleRun = { ...activeRun, resume: true, reviewerOverride: true };
          } else {
            activeRun = { ...activeRun, ...options, resume: options.resume ?? true };
            cycleRun = activeRun;
          }
          cycleSids.push(cycleRun.sid);
          cycleBranches.push(cycleRun.branch);
          cycleRoles.push({ authorName: activeRun.authorName, reviewerNames: activeRun.reviewerNames });
          return runCycle(cycleRun, cycleDepsForRun);
        };
        const ghDeps = { gh: (deps.githubDeps || githubDeps)().gh };
        const integrationRepair = async (context) => {
          let repairRun = activeRun;
          if (repairRun.prTarget?.needsRepairBranch) {
            try {
              repairRun = preparePrRepairRun(repairRun, cfg, ghDeps);
              activeRun = repairRun;
            } catch (error) {
              return {
                result: {
                  state: "STOPPED_AT_CAP",
                  outcome: "stopped-at-cap",
                  exit: 2,
                  failureClass: context.failure?.class,
                  failure: context.failure,
                  reason: `could not create PR repair branch: ${error.message || error}`,
                },
                record: context.record,
              };
            }
          }
          return createIntegrationRepairRemedy({
            run: repairRun,
            deps: { ...continueDeps, sleep: deps.sleep },
            gh: ghDeps.gh,
            resolveLanded: (cycle) => resolveLanded(cycle, activeRun, cfg, ghDeps, repo),
          })(context);
        };
        const reauthor = createReauthorRemedy({ getRun: () => activeRun, createCycle: freshCycle });
        controller = await runUntil(controllerPolicy, {
          ...(resumedRecord || priorRun),
          attempt: priorRun.attempt,
          policy: controllerPolicy,
        }, {
          runCycle: async ({ fresh } = {}) => fresh ? freshCycle() : result,
          remedies: {
            rebase: createRebaseRemedy({
              getRun: () => activeRun,
              deps: continueDeps,
              runCycle: () => freshCycle(),
            }),
            rotate: createRotateRemedy({
              getRun: () => activeRun,
              deps: continueDeps,
              runCycle: freshCycle,
              selectRoles: nextAuthor,
            }),
            reauthor,
            ask: createAskRemedy({
              getRun: () => activeRun,
              deps: { ...ghDeps, sleep: deps.sleep, ...(deps.now ? { now: deps.now } : {}) },
              runCycle: freshCycle,
              reauthor,
            }),
            "integration-repair": integrationRepair,
          },
          resolveLanded: (cycle) => resolveLanded(cycle, activeRun, cfg, ghDeps, repo),
          mergeStanding: (args) => mergeForRun(args, activeRun, cfg, ghDeps, emit),
          gh: ghDeps.gh, git, repo, sleep: deps.sleep,
        });
        finalResult = controller.cycleResults?.at(-1) || result;
        finalResult = outputResult(finalResult, controller);
        // The arrays are needed by the durable lineage update below. Keep them
        // on the controller result without changing run-controller's contract.
        controller.cycleSids = cycleSids;
        controller.cycleBranches = cycleBranches;
        controller.cycleRoles = cycleRoles;
      }
      const outcome = controller?.outcome || outcomeForResult(result);
      const exit = controller?.exit ?? exitForResult(result);
      if (controller) raiseExitCode(exit);
      if (!dry) {
        const resumable = Boolean(controller && (outcome === "stopped-at-cap" || outcome === "wait-timeout"));
        if (!resumable) for (const cycleSid of registeredSids) checkpoint.clear(orchDir, cycleSid);
        const cycleResults = controller?.cycleResults || [result];
        const attempt = controller
          ? Math.max(priorRun.attempt + 1, controller.attempt || 0)
          : priorRun ? priorRun.attempt + 1 : 0;
        if (priorRun) {
          runRecord.update(orchDir, runId, {
            state: controller?.state || STATE_FOR_OUTCOME[outcome],
            outcome,
            exit,
            attempt,
            branch: activeRun.branch,
            prTarget: activeRun.prTarget || run.prTarget || null,
            excludedAgents: controller?.excludedAgents || run.excludedAgents,
            ...(controller?.policy ? { policy: controller.policy } : {}),
            ...(controller?.human ? { human: controller.human } : {}),
            ...(controller?.resumeCommand ? { resumeCommand: controller.resumeCommand } : {}),
            ...(controller?.retries ? { retries: controller.retries } : {}),
            ...(controller?.failures ? { failures: controller.failures } : {}),
            ...(controller?.merge ? { merge: controller.merge } : {}),
            cycles: [...priorRun.cycles, ...cycleResults.map((cycleResult, index) => ({
              sid: controller?.cycleSids?.[index] || resumeSid,
              attempt,
              branch: controller?.cycleBranches?.[index] || activeRun.branch,
              author: controller?.cycleRoles?.[index]?.authorName || activeRun.authorName,
              reviewers: controller?.cycleRoles?.[index]?.reviewerNames || activeRun.reviewerNames,
              status: cycleResult.status,
              reason: cycleResult.reason || null,
            }))],
          });
        } else {
          runRecord.update(orchDir, runId, {
            state: STATE_FOR_OUTCOME[outcome],
            outcome,
            exit,
            attempt,
            branch: activeRun.branch,
            prTarget: activeRun.prTarget || run.prTarget || null,
            excludedAgents: run.excludedAgents,
            ...(controller?.merge ? { merge: controller.merge } : {}),
            cycles: [{ sid: resumeSid, attempt, branch, author: authorName, reviewers: reviewers.map((r) => r.agent), status: result.status, reason: result.reason || null }],
          });
        }
        // Codex review (#125 stalemate): the original `orch task` run that
        // authored this branch wrote a resume.js record (task text + author →
        // branch) BEFORE it ever ran, so a crash mid-cycle leaves it for a retry
        // to pick up. `continue` doesn't know that original task text, so it
        // can't call resume.clear() by key — scan by branch instead, or a later
        // `orch task` with the same text would reattach this already-terminal
        // branch instead of authoring fresh.
        if (run.mode === "task" && activeRun.branch !== run.branch) resume.clearForBranch(orchDir, run.branch);
        if (!resumable) resume.clearForBranch(orchDir, activeRun.branch);
      }
      if (!jsonMode) {
        console.log(summaryLine(finalResult, activeRun.branch, dry, "", colorEnabled(process.stdout), closes));
        if (controller?.resumeCommand) console.log(`orch: resume with ${controller.resumeCommand}`);
      }
      // Codex review (#125 stalemate): `continue` forked its own terminal
      // handling instead of reusing the shared `task`/`issue` tail, and dropped
      // two of its side effects for a resumed cycle — the detached docs-update
      // spawn on a real merge, and the issue-bridge comment (closes is now
      // restored, see above) on escalation/merge-deferred. Both restored here,
      // matching the shared loop at the `task`/`issue` command above.
      if (!dry) maybeSpawnDocs(finalResult, cfg, { dry, spawn: deps.spawn, quiet: jsonMode }, orchDir);
      if (finalResult.status === "merged" && !dry && !flags["no-tidy"]) {
        const finishFn = deps.finishRun || finishRun;
        const io = jsonMode ? { ...realIo(), print: () => {} } : (deps.io || realIo());
        await finishFn(
          { repo, orchDir, task: run.task, merged: [activeRun.branch], interactive: Boolean(process.stdin.isTTY), runStats: finalResult.runStats || [], integrationBranch: cfg.integrationBranch, prUrls: finalResult.prUrl ? [finalResult.prUrl] : [] },
          { git, io, notify },
        );
      }
      if (finalResult.status === "escalated" || finalResult.status === "merge-deferred") {
        if (!controller) raiseExitCode(2);
        if (!dry) commentOnIssue(finalResult, activeRun.branch, closes, deps.githubDeps || githubDeps);
      }
      const mergeEvent = mergeVerifiedEvent(runId, controller, cfg);
      if (mergeEvent) emit(mergeEvent);
      emit({
        event: "run.end", runId, outcome, exit,
        usage: finalResult.usage || {},
        ...(controller?.failure ? { failureClass: controller.failure.class } : {}),
        ...(controller?.blockedReason ? { blockedReason: controller.blockedReason } : {}),
        ...(controller?.resumeCommand ? { resumeCommand: controller.resumeCommand } : {}),
      });
    } catch (err) {
      if (!dry) runRecord.update(orchDir, runId, {
        state: "ERROR", outcome: "error", exit: 1,
        prTarget: activeRun.prTarget || run.prTarget || null,
        lastError: toLastError(err),
      });
      emit({ event: "run.end", runId, outcome: "error", exit: 1, usage: {} });
      throw err;
    } finally {
      clearDetachedCleanup?.();
      if (!dry) for (const cycleSid of registeredSids) inflight.deregister(orchDir, cycleSid);
    }
    return;
  }

  if (command === "completion") {
    if (rest[0] === "install") {
      const home = deps.completionDeps?.homedir ? deps.completionDeps.homedir() : homedir();
      if (dryRun) {
        console.log(`orch (dry): would write ${join(home, ".orch", "completion.bash")}`);
        return;
      }
      const result = installCompletion(deps.completionDeps);
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
    const historyLimit = flags.limit ? Number(flags.limit) : 10; // schema validated the value
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
  // frozen. `orch release` does that bookkeeping alone in the dedicated
  // integration worktree. No tag — tagging is CI's job (#409). Recovery on
  // failure restores only the files the bump wrote, never a whole-tree reset
  // (see bumpVersion recovery: "written-files").
  if (command === "release") {
    const entry = rest.join(" ").trim();
    if (!entry) throw usageError('usage: orch release "<changelog entry>"');
    if (dryRun) { console.log(`orch (dry): would bump version + CHANGELOG with "${entry}"`); return; }
    const cfg = load(repo, flags["config-file"]);
    const baseBranch = cfg.baseBranch || "main";
    const integrationBranch = cfg.integrationBranch || "orch/integration";
    if (!(await acquireBlocking(orchDir, LOCK_NAMES.MERGE))) {
      throw new Error("orch release: could not acquire merge.lock");
    }
    try {
      const integration = integrationBranch === baseBranch
        ? repo
        : git.ensureIntegrationWorktree(repo, orchDir, integrationBranch, baseBranch);
      const currentBranch = git.git(["rev-parse", "--abbrev-ref", "HEAD"], integration).trim();
      if (currentBranch !== integrationBranch) {
        throw new Error(`orch release: checkout must be on ${integrationBranch}, currently on ${currentBranch}`);
      }
      const dirty = git.gitTry(["status", "--porcelain"], integration);
      if (!dirty.ok) throw new Error(`orch release: git status failed: ${dirty.out.trim() || "unknown error"}`);
      const dirtyLines = dirty.out.split("\n").map((l) => l.trimEnd()).filter(Boolean).filter((l) => l.slice(3).trim() !== ".orch/merge.lock");
      if (dirtyLines.length) {
        const files = dirtyLines.map((l) => l.slice(3).trim() || l).join("\n");
        throw new Error(
          `orch release: working tree is dirty — commit or stash first.\n${files}`,
        );
      }
      const originSync = git.reconcileIntegrationToOrigin(integration, integrationBranch);
      if (!originSync.ok) throw new Error(`orch release: ${originSync.reason}`);
      const version = git.bumpVersion(integration, entry, { recovery: "written-files" });
      if (!version) throw new Error("orch release: version bump failed (is package.json present and valid?)");
      const commit = git.git(["rev-parse", "HEAD"], integration).trim();
      console.log(`orch release: chore(release): v${version} committed on ${integrationBranch} in ${integration} (${commit})`);
      return;
    } finally {
      releaseLock(orchDir, LOCK_NAMES.MERGE);
    }
  }

  // Fall-through. No command at all is a legitimate "show me the tool" request
  // and exits 0; a command we do not recognise (typo, renamed subcommand in a
  // stale script) must be an error — exiting 0 tells every scripted caller
  // checking $? that the run succeeded when nothing ran at all.
  if (command) throw usageError(`unknown command: ${command} (run 'orch help' for usage)`, { showUsage: true });
  printUsage();
}

function printUsage() {
  console.log(renderHelp());
}

function costSuffix(result) {
  return result?.usageSummary ? `; cost ${result.usageSummary}` : "";
}

// Real collaborators for the GitHub PR bridge. gh/git shell out; cycle binds
// the engine to its real deps. §3f: the public PR comment is a machine summary
// only (built in commentOnPr), so no reviewer prose is read back here.
function githubDeps() {
  return {
    gh: ghShell,
    git: git.git,
    cycle: (o) => runCycle(o, realDeps()),
    log: (m) => process.stderr.write(`▶ ${m}\n`),
  };
}
