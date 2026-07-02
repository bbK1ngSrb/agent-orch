import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, openSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline";
import { execFileSync, spawn } from "node:child_process";
import { load, configPath, parseRoleSpec, parseRoleSpecs } from "./config.js";
import { runCycle } from "./engine.js";
import { runPr, demote, openPr, buildIssueComment } from "./github.js";
import * as adapters from "./adapters/index.js";
import * as git from "./git.js";
import * as gate from "./gate.js";
import * as scope from "./scope.js";
import { globToRegExp } from "./scope.js";
import * as notify from "./notify.js";
import { acquireLock, releaseLock, acquireBlocking, isPaused } from "./lock.js";
import { slugify } from "./slug.js";
import { VERSION } from "./version.js";
import { newSid } from "./sid.js";
import * as inflight from "./inflight.js";
import * as resume from "./resume.js";
import * as checkpoint from "./checkpoint.js";
import * as reviewLog from "./review-log.js";
import { finalize } from "./finalize.js";
import { validateWorkOrder, buildAuthorPrompt, issueToWorkOrder } from "./intake/workorder.js";
import { appCredsFromEnv, installationToken, parseRepoSlug } from "./github-app.js";
import { finishRun } from "./complete.js";
import { detectAgents, formatDetection } from "./detect.js";
import { redact } from "./redact.js";
import { render as renderDashboard, snapshot as dashboardSnapshot } from "./dashboard.js";

export { slugify };

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
  if (orchDir) { const fd = openSync(join(orchDir, "auto-docs.log"), "a"); stdio = ["ignore", fd, fd]; }
  deps.spawn(process.execPath, [process.argv[1], "task", tagged],
    { detached: true, stdio }).unref();
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

// init scaffold — mirrors orch.example.yml. Every key is listed with its
// possible values and default; commented keys use the shown default.
const SCAFFOLD = `# agent-orch config — all keys optional. Commented keys show the default.

# === Agents ===
# Rotation pool: picks author/reviewer when no explicit roles are set below.
# Built-in: claude, codex. Local llm models (run via ccr): qwen3-coder-30b,
# deepseek-coder-v2-lite, glm-4.5-air. Append a known agent with \`orch agent add <name>\`.
agents: [claude, codex]   # default: [claude, codex]

# === Roles (optional; set both sides or neither) ===
# A role is a spec "<agent> [model] [effort]":
#   agent  — required; one of the agents above
#   model  — optional model id, may carry a subversion (e.g. claude-opus-4-8, gpt-5.1)
#   effort — optional reasoning effort (e.g. low | medium | high)
# Unset → the agents pool rotates the author; the next agent reviews.
# author: claude claude-opus-4-8 high      # single author spec
# reviewer: codex gpt-5.1           # single reviewer spec
# authors: [claude claude-opus-4-8 high, codex]   # each writes its own branch
# reviewers: [claude, codex high]          # all audit each branch, except its author

# === Cycle ===
test: auto                # "auto" detects the test command, or set one, e.g. "pytest -q"
reviseCap: 3              # max revise rounds before escalation (positive integer); default: 3
stageTimeout: 25          # per-stage wall-clock cap in MINUTES; 0 disables; default: 25. A stalled author/review (e.g. a wedged codex exec) is killed and the cycle fails (nonzero exit) instead of hanging forever. Env override: ORCH_STAGE_TIMEOUT_MS (milliseconds)
merge: no-ff              # merge into main: ff-only | no-ff | pr; default: no-ff (concurrent disjoint cycles both land; ff-only = linear but extra cycles fall back to PR; pr = never touch local main, always open a GitHub PR)
concurrency: 4            # max concurrent orch cycles in this repo dir; over this a cycle exits; default: 4

# === Cheap-agent dispatch (optional) ===
# Route mechanical/low-stakes tasks to a cheaper agent (e.g. a local llm via ccr)
# instead of always paying for Claude/Codex. \`orch task --cheap\` forces \`role\`
# ad hoc; without the flag, a \`--file\`/\`orch issue\` work order whose
# suspected_paths all match \`paths\` routes to \`role\` automatically.
# cheap:
#   role: qwen3-coder-30b  # role spec used for both author and reviewer
#   paths: ["*.md", "docs/**"]

# === Scope gate (optional) ===
scope:
  maxLines: 0             # 0 = disabled; >0 escalates author commits over this many changed lines
  ignore: ["*.lock", "dist/**", "*.snap"]   # globs excluded from the line count

# === GitHub PR bridge (orch pr <n>; also used by merge: pr above) ===
github:
  mergeMethod: squash     # gh pr merge strategy: squash | merge | rebase; default: squash
  autoMergePr: false      # with merge: pr, also enable GitHub's native auto-merge on the PR it opens; default: false

# === Auto docs-update after a real merge (optional) ===
docs:
  autoUpdate: false       # true = spawn a docs-update task after a merge; default: false
  prompt: update documentation to reflect the latest merged changes
  paths: ["*.md", "docs/**", "**/*.md"]   # docs-only globs (loop guard)
`;

// Agent-agnostic usage doc written to .orch/ORCH.md on init. Committed and
// shared, so any agent driving the repo (Claude/Codex/Gemini/…) has the same
// "how to use orch here" reference. Generic — no per-repo specifics. Overwritten
// on every init so it tracks the installed orch version (it is orch's own file,
// not meant for hand-edits; user customisations belong in their agent file).
const ORCH_DOC = `# Using orch in this repo

This repo is set up for **agent-orch**: it authors a change with one agent,
cross-audits it with a second, gates on tests, then merges.

## Commands
- \`orch task "<change>" [roles]\`   author → cross-audit → test-gate → merge
- \`orch issue <number> [roles]\`    fetch a GitHub issue as a work order, run the cycle, \`Closes #<n>\`
- \`orch review <branch>\`           audit an existing branch (no author)
- \`orch pr <number> [--merge]\`     review (and optionally merge) a GitHub PR
- \`orch agent add <name>\`          add an agent to the rotation pool
- \`orch agent build <name> [--pr]\` scaffold a missing adapter via orch's own pipeline

A role is a spec \`"<agent> [model] [effort]"\`, e.g.
\`--author "claude claude-opus-4-8 high" --reviewer "codex"\`.
\`--cheap\` forces \`orch.yml\`'s \`cheap.role\` (e.g. a local llm) for one run;
set \`cheap.paths\` to auto-route matching \`--file\`/\`orch issue\` work orders.
Config and every option live in \`.orch/orch.yml\`.

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

export function parse(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
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
      "no-tidy": { type: "boolean" }, // #44: skip post-run completion/cleanup
      "no-banner": { type: "boolean" },
      link: { type: "boolean" }, // init: also wire .orch/ORCH.md into the agent file
      json: { type: "boolean" }, // dashboard: machine-readable output
      limit: { type: "string" }, // dashboard: run-history entries to show
      pr: { type: "boolean" }, // agent build: land via PR instead of a local-only branch

    },
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

export function nextAuthor(cfg, orchDir, pinnedAuthor = null) {
  // Explicit fixed roles win over rotation — the trivial "who authors, who audits".
  // Returns role specs ({agent, model, effort}) plus plain name arrays for back-compat.
  const fixed = fixedRoles(cfg);
  if (fixed) {
    mkdirSync(orchDir, { recursive: true });
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
  mkdirSync(orchDir, { recursive: true });
  // Resuming a surviving branch (#27): pin its author and DON'T advance rotation —
  // this run is the prior run continuing, not a new author's turn.
  if (pinnedAuthor && cfg.agents.includes(pinnedAuthor)) {
    const pi = cfg.agents.indexOf(pinnedAuthor);
    const reviewerName = cfg.agents[(pi + 1) % cfg.agents.length] || pinnedAuthor;
    return {
      authorName: pinnedAuthor, reviewerName,
      authorNames: [pinnedAuthor], reviewerNames: [reviewerName],
      authors: [{ agent: pinnedAuthor, model: null, effort: null }],
      reviewers: [{ agent: reviewerName, model: null, effort: null }],
    };
  }
  const last = existsSync(f) ? readFileSync(f, "utf8").trim() : null;
  const i = last ? (cfg.agents.indexOf(last) + 1) % cfg.agents.length : 0;
  const authorName = cfg.agents[i];
  const reviewerName = cfg.agents[(i + 1) % cfg.agents.length] || authorName;
  writeFileSync(f, authorName + "\n");
  return {
    authorName, reviewerName,
    authorNames: [authorName], reviewerNames: [reviewerName],
    authors: [{ agent: authorName, model: null, effort: null }],
    reviewers: [{ agent: reviewerName, model: null, effort: null }],
  };
}

export function preflight(cfg, orchDir) {
  // Check the rotation pool plus any explicitly pinned roles. Role entries are
  // specs ("<agent> [model] [effort]"); only the agent name needs a CLI on PATH.
  const roleNames = [
    cfg.author,
    cfg.reviewer,
    ...(cfg.authors || []),
    ...(cfg.reviewers || []),
  ].filter(Boolean).map((s) => parseRoleSpec(s).agent);
  const names = new Set([...cfg.agents, ...roleNames].filter(Boolean));
  for (const name of names) {
    const a = adapters.get(name); // throws on unknown
    const exe = a.bin || a.name; // local models run via `ccr`, not their own name
    try { execFileSync("which", [exe], { stdio: "ignore" }); }
    catch { throw new Error(`agent CLI not found on PATH: ${exe} (for agent ${name})`); }
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
export function realDeps() {
  const ghShell = (args, input) => execFileSync("gh", args, { input, encoding: "utf8" }).toString();
  const ghDeps = { gh: ghShell, git: git.git, notify, log: (m) => process.stderr.write(`▶ ${m}\n`) };
  const githubDep = { demote: (ctx) => demote(ctx, ghDeps), openPr: (ctx) => openPr(ctx, ghDeps) };
  const finalizeDep = (ctx) => finalize(ctx, { git, gate, lock: { acquireBlocking, releaseLock }, inflight, github: githubDep, notify });
  return { adapters, git, gate, scope, notify, inflight, finalize: finalizeDep, checkpoint, reviewLog };
}
function dryDeps() {
  const verdict = { decision: "AGREE", reason: "(dry-run: assumed agree)", raw: "" };
  return {
    adapters: { get: (n) => ({ name: n, async author() {}, async audit() { return verdict; } }) },
    git: {
      createTaskBranch() {}, attachExistingBranch() {}, pruneWorktree() {},
      git() { return "(dry-run)"; },
      changedFiles() { return []; },
    },
    gate: { detect: () => "true", run: () => ({ pass: true, log: "(dry-run)" }) },
    scope: { count: () => 0 },
    inflight: { setPaths() {} },
    finalize: async () => ({ status: "merged", reason: "dry-run", sha: "dry" }),
    notify,
  };
}

function reviewersForAuthor(authorName, reviewerSpecs) {
  const others = reviewerSpecs.filter((s) => s.agent !== authorName);
  return others.length ? others : reviewerSpecs;
}

function roleLabel(spec) {
  return [spec.agent, spec.model, spec.effort].filter(Boolean).join(" · ");
}

function uniqueLabels(specs) {
  return [...new Set(specs.map(roleLabel))].join(", ");
}

// Display width in terminal columns: U+23F3 (⏳) and other emoji render 2 cols
// while `.length` counts them as 1, which would misalign the box borders.
// ANSI color codes are zero-width and stripped first.
const WIDE_GLYPH = /[⌚-⏿☀-➿\u{1f000}-\u{1faff}]/u;
export function visWidth(s) {
  const plain = s.replace(/\x1b\[[0-9;]*m/g, "");
  let w = 0;
  for (const ch of plain) w += WIDE_GLYPH.test(ch) ? 2 : 1;
  return w;
}

// ANSI palette. paint() no-ops when color is off and always resets the span so
// color never bleeds into the box border.
// orch brand orange (256-color): 208 ≈ #ff8700. Banner leans on the orange
// family, varying brightness per field; 8-color terminals degrade to the
// nearest base via the 256→16 map, so it stays legible without truecolor.
const C = { border: "38;5;130", title: "1;38;5;208", label: "2", agents: "38;5;214", author: "1;38;5;208", review: "38;5;179", flag: "38;5;220" };
const paint = (on, code, s) => (on && code && s ? `\x1b[${code}m${s}\x1b[0m` : s);

// Render one inner row from colored segments [{code,text}], padded to `inner`
// display columns by visWidth (not .length). Overflow is truncated on the plain
// text with an ellipsis; that rare case drops color rather than miscount widths.
function bannerRow(segs, inner, color) {
  const plain = segs.map((s) => s.text).join("");
  if (visWidth(plain) > inner) {
    let out = "", w = 0;
    for (const ch of plain) {
      const cw = WIDE_GLYPH.test(ch) ? 2 : 1;
      if (w + cw > inner - 1) break;
      out += ch; w += cw;
    }
    out += "…";
    return `${paint(color, C.border, "│")} ${out}${" ".repeat(inner - visWidth(out))} ${paint(color, C.border, "│")}`;
  }
  const body = segs.map((s) => paint(color, s.code, s.text)).join("");
  const pad = " ".repeat(inner - visWidth(plain));
  return `${paint(color, C.border, "│")} ${body}${pad} ${paint(color, C.border, "│")}`;
}

export function runBanner(cfg, runs, opts = {}) {
  const { color = false, columns } = opts;
  const lbl = (t) => ({ code: C.label, text: t.padEnd(8) });
  const rows = [
    [lbl("agents"), { code: C.agents, text: cfg.agents.join(", ") }],
  ];
  // One author row per run so concurrent authors and their resume state are
  // each visible; a single review row aggregates the distinct reviewers.
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

  // Responsive: fill the terminal up to a cap, but never narrower than content
  // and never wider than 96 inner cols; clamp tiny/undefined widths safely.
  const longest = Math.max(...rows.map((segs) => visWidth(segs.map((s) => s.text).join(""))));
  const avail = Number.isFinite(columns) ? columns : 76;
  const inner = Math.max(Math.min(longest, 96), Math.min(96, Math.max(40, avail - 4)));

  const title = ` agent-orch ${VERSION} `;
  const dashes = inner + 2 - visWidth(title);
  const left = Math.max(0, Math.floor(dashes / 2)), right = Math.max(0, dashes - left);
  const top = paint(color, C.border, `╭${"─".repeat(left)}`) +
    paint(color, C.title, title) +
    paint(color, C.border, `${"─".repeat(right)}╮`);
  const bottom = paint(color, C.border, `╰${"─".repeat(inner + 2)}╯`);
  return [top, ...rows.map((segs) => bannerRow(segs, inner, color)), bottom].join("\n");
}

export function maybePrintRunBanner(cfg, runs, flags, stdout = process.stdout) {
  if (flags["no-banner"] || !stdout.isTTY) return false;
  const color = stdout.isTTY && process.env.NO_COLOR == null;
  stdout.write(`${runBanner(cfg, runs, { color, columns: stdout.columns })}\n`);
  return true;
}

function nextAvailableOrchBranch(repo, slugSource) {
  const base = `orch/${slugify(slugSource)}`;
  let branch = base;
  for (let i = 2; git.branchExists(repo, branch); i++) branch = `${base}-${i}`;
  return branch;
}

function switchFromMain(repo, slugSource) {
  const head = git.git(["rev-parse", "--abbrev-ref", "HEAD"], repo);
  if (head !== "main") return null;
  const branch = nextAvailableOrchBranch(repo, slugSource);
  git.git(["switch", "-c", branch], repo);
  console.log(`orch: main is reserved for the integration worktree - created and switched to ${branch} (your changes carried over)`);
  return branch;
}

// The author of a surviving committed branch to resume, or null. Scans resume
// records for this task across authors (#27): a hard kill rotates the pool, so the
// re-run's author no longer matches the record's per-author key. Returns the author
// only when its branch still exists, carries committed work, and isn't a live peer —
// the same staleness guards resolveTaskBranch re-applies before it actually resumes.
export function pinnedResumeAuthor(ctx, deps = { git, resume }) {
  const { orchDir, task, repo, dry = false, liveBranches = new Set() } = ctx;
  const { git: g, resume: r } = deps;
  if (dry) return null;
  const hit = r.lookupForTask(orchDir, task).find((rec) =>
    g.branchExists(repo, rec.branch) &&
    g.changedFiles(repo, rec.branch).length > 0 &&
    !liveBranches.has(rec.branch));
  return hit ? hit.author : null;
}

// Pick the branch/sid for one author in task mode, resuming a quota-aborted run
// when one is on record (issue #24). Resume only when the recorded branch still
// exists, carries committed work, and isn't a live peer's branch — otherwise the
// record is stale (branch vanished / empty), so drop it and author fresh. A fresh
// run records its branch *before* the cycle; cli clears it after runCycle returns.
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
export function fetchIssueWorkOrder(n, gh) {
  try { gh(["--version"]); }
  catch { throw new Error("gh CLI not found — install https://cli.github.com/ and run `gh auth login`"); }
  const issue = JSON.parse(gh(["issue", "view", String(n), "--json", "number,title,body,state"]));
  if (issue.state && issue.state !== "OPEN") throw new Error(`issue #${issue.number} is ${issue.state}, not open`);
  const v = validateWorkOrder(issueToWorkOrder(issue));
  if (!v.ok) throw new Error(`issue #${n} did not map to a valid work order:\n- ${v.errors.join("\n- ")}`);
  return v.workOrder;
}

export function resolveTaskBranch(ctx, deps = { git, resume }) {
  const { repo, orchDir, task, authorName, dry = false, liveBranches = new Set() } = ctx;
  const { git: g, resume: r } = deps;
  const found = dry ? null : r.lookup(orchDir, task, authorName);
  if (found && !liveBranches.has(found.branch)) {
    if (g.branchExists(repo, found.branch) && g.changedFiles(repo, found.branch).length > 0) {
      return { sid: found.sid, branch: found.branch, resume: true };
    }
    r.clear(orchDir, task, authorName); // record points at a vanished/empty branch
  }
  const sid = newSid();
  const branch = `pr/${authorName}/${slugify(task)}-${sid}`;
  if (!dry) r.record(orchDir, task, authorName, { branch, sid });
  return { sid, branch, resume: false };
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

// Runs the build as a normal task-mode cycle, isolated in its own worktree/branch
// (the same mechanism every `orch task` uses) since orch would be modifying its
// own source while running. Default: `noMerge` — the result sits on its local
// branch only (no PR, main untouched) so it can be reviewed before it's trusted.
// `--pr` instead forces `cfg.merge: "pr"` for this run only (never persisted to
// orch.yml), so an AGREE+green result opens a PR through the full gate instead.
export async function buildAgent(name, { repo, orchDir, flags = {}, deps = {} }) {
  try { adapters.get(name); return { status: "already-registered" }; } catch { /* proceed to build */ }

  const wo = buildAdapterWorkOrder(name);
  const task = wo.title;
  const authorPrompt = buildAuthorPrompt(wo);
  let cfg = load(repo);
  if (flags.pr) cfg = { ...cfg, merge: "pr" };
  const dry = Boolean(flags.dry) || process.env.ORCH_DRYRUN === "1";
  const preflightFn = deps.preflight || preflight;
  if (!dry) preflightFn(cfg, orchDir);

  let liveBranches = new Set();
  if (!dry) {
    const sync = git.syncMainFromOrigin(repo);
    if (!sync.ok) throw new Error(`orch: cannot start from stale main: ${sync.reason}`);
    liveBranches = new Set(inflight.listLive(orchDir).map((e) => e.branch));
    git.reclaimOrphanWorktrees(repo, orchDir, liveBranches);
  }

  const pinned = pinnedResumeAuthor({ repo, orchDir, task, dry, liveBranches });
  const { authors, reviewers } = nextAuthor(cfg, orchDir, pinned);
  const authorSpec = authors[0];
  const authorName = authorSpec.agent;
  const { sid, branch, resume: isResume } = resolveTaskBranch({ repo, orchDir, task, authorName, dry, liveBranches });
  const reviewerList = reviewersForAuthor(authorName, reviewers);
  const run = {
    mode: "task", task, authorPrompt, branch, sid, resume: isResume, authorName, author: authorSpec,
    reviewerName: reviewerList[0].agent, reviewerNames: reviewerList.map((s) => s.agent),
    reviewers: reviewerList, noMerge: !flags.pr,
    cfg, orchDir, repo, worktree: join(orchDir, "wt", branch.replace(/\//g, "_")),
  };

  if (!dry) {
    const baseSha = git.git(["rev-parse", "main"], repo);
    inflight.register(orchDir, sid, { branch, pid: process.pid, baseSha });
    const live = inflight.countLive(orchDir);
    if (live > cfg.concurrency) {
      inflight.deregister(orchDir, sid);
      throw new Error(`orch: concurrency cap ${cfg.concurrency} reached — ${live} cycles live; try again shortly`);
    }
  }
  try {
    const result = await runCycle(run, dry ? dryDeps() : (deps.cycleDeps || realDeps()));
    if (!dry) { resume.clear(orchDir, task, authorName); checkpoint.clear(orchDir, sid); }
    return { ...result, branch };
  } finally {
    if (!dry) inflight.deregister(orchDir, sid);
  }
}

export async function main(argv, deps = {}) {
  const { command, rest, flags } = parse(argv);
  if (flags.version || command === "version") { console.log(VERSION); return; }
  if (flags.help || command === "help") { printUsage(); return; }

  const repo = process.cwd();
  const orchDir = join(repo, ".orch");

  // Optional GitHub App auth: if ORCH_APP_ID + ORCH_APP_PRIVATE_KEY are set,
  // mint a short-lived installation token and expose it to every `gh` shell-out
  // via GH_TOKEN (execFileSync inherits process.env). orch then acts as
  // orch[bot]. Falls back to ambient `gh auth` when unset or on any failure —
  // never a hard dependency. An explicit GH_TOKEN wins and skips minting.
  // ponytail: process.env mutation at the CLI entrypoint; the lazy correct wiring.
  const appCreds = !process.env.GH_TOKEN && appCredsFromEnv();
  if (appCreds) {
    try {
      const slug = parseRepoSlug(git.git(["remote", "get-url", "origin"], repo));
      process.env.GH_TOKEN = await installationToken({ ...appCreds, ...slug });
    } catch (e) {
      process.stderr.write(`▶ orch: GitHub App auth unavailable (${e.message}); using ambient gh auth\n`);
    }
  }
  // preflight shells out to `which <agent-cli>`; tests stub it so the suite
  // is green in a CLI-less environment (e.g. clean CI). Production passes none.
  const preflightFn = deps.preflight || preflight;

  if (command === "init") {
    // Preflight first, writability-only: it probes .orch/ and fails with a
    // clear message before any real write, so a read-only repo never surfaces
    // a raw EACCES from the mkdir/writeFile below. `agents: []` skips the
    // fatal agent-CLI check — init's whole point is to report installed CLIs
    // non-fatally via detectAgents() below, not require them up front.
    // load() tolerates a missing config.
    const cfg = load(repo);
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

  if (command === "agent") {
    if (rest[0] === "build") {
      const name = rest[1];
      if (!name) throw new Error("usage: orch agent build <name> [--pr]");
      const buildFn = deps.buildAgent || buildAgent;
      const result = await buildFn(name, { repo, orchDir, flags, deps });
      if (result.status === "already-registered") { console.log(`orch: ${name} already registered`); return; }
      console.log(`orch agent build ${name}: ${result.status} (${result.reason}) on ${result.branch}${costSuffix(result)}`);
      if (result.status === "approved") {
        console.log(`orch: review the diff, then \`orch agent add ${name}\` once it's merged into main`);
      }
      if (result.status === "escalated" || result.status === "pr-fallback") process.exitCode = 2;
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
      const result = await buildFn(name, { repo, orchDir, flags: {}, deps });
        console.log(`orch agent build ${name}: ${result.status}${result.branch ? ` on ${result.branch}` : ""}${costSuffix(result)}`);
      if (result.status === "approved") {
        console.log(`orch: review the diff, then \`orch agent add ${name}\` once it's merged into main`);
      }
      return;
    }
    const file = configPath(repo);
    if (!existsSync(file)) throw new Error("no orch.yml — run `orch init` first");
    if (load(repo).agents.includes(name)) { console.log(`orch: ${name} already in agents`); return; }
    const text = readFileSync(file, "utf8");
    const re = /^(agents:\s*\[)([^\]]*)(\])/m;
    if (!re.test(text)) throw new Error("could not find `agents: [...]` in orch.yml — add it manually");
    writeFileSync(file, text.replace(re, (_m, open, inner, close) =>
      `${open}${inner.trim() ? inner.trim() + ", " : ""}${name}${close}`));
    console.log(`orch: added ${name} to agents`);
    return;
  }

  if (command === "task" || command === "review" || command === "issue") {
    let cfg = applyRoleOverrides(load(repo), flags, { allowReviewerOnly: command === "review" });
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
    } else if (mode === "task") {
      // §3a/§3b: a --file task is UNTRUSTED intake — it must be a JSON work order,
      // validated for shape, then wrapped in a neutralized fence the author treats
      // as reference, not instructions. Free-text `orch task "..."` (operator-typed,
      // trusted) is unchanged. `task` stays a short human label (drives slug/resume);
      // `authorPrompt` is what the author actually sees.
      if (flags.file) {
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

    // Cheap-agent dispatch: --cheap forces cfg.cheap.role ad hoc; without the
    // flag, a work order whose suspected_paths all match cfg.cheap.paths routes
    // the same way automatically. Resolved here (after the work order, before
    // preflight) so the agent CLI it picks is the one preflight actually checks.
    cfg = applyCheapOverride(cfg, flags, workOrder);
    if (!dry) preflightFn(cfg, orchDir); // dry-run never shells out, so don't require CLIs

    // Integration worktree owns `main`; if cwd is on main, move it to an
    // operator branch before reclaim/picking branches. Reclaim orphaned
    // worktrees BEFORE picking branches so resume resolution (#24) sees
    // post-reclaim truth — a hard-killed orphan branch is already gone by then,
    // so resume safely degrades to a fresh start instead of attaching a dead ref.
    let liveBranches = new Set();
    let operatorBranch = null; // #44: the orch/<slug> we parked the operator on, if any
    if (!dry) {
      if (mode === "task") {
        const sync = git.syncMainFromOrigin(repo);
        if (!sync.ok) throw new Error(`orch: cannot start from stale main: ${sync.reason}`);
        if (sync.updated) console.log("orch: fast-forwarded local main from origin/main");
      }
      operatorBranch = switchFromMain(repo, mode === "task" ? task : `review ${reviewBranch}`);
      liveBranches = new Set(inflight.listLive(orchDir).map((e) => e.branch));
      git.reclaimOrphanWorktrees(repo, orchDir, liveBranches); // PID-aware + inflight-branch-aware: clears dead cycles, spares live peers
    }

    let runs;
    if (mode === "task") {
      // Pin the author of a surviving committed branch from a prior killed run so the
      // rotation pool resumes it instead of authoring fresh under the next agent (#27).
      // resolveTaskBranch re-validates below; this only steers author selection.
      const pinned = pinnedResumeAuthor({ repo, orchDir, task, dry, liveBranches });
      const { authors, reviewers } = nextAuthor(cfg, orchDir, pinned);
      runs = authors.map((authorSpec) => {
        const authorName = authorSpec.agent;
        const { sid, branch, resume } = resolveTaskBranch({ repo, orchDir, task, authorName, dry, liveBranches });
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
      const reviewerList = configured
        ? reviewersForAuthor(branchAuthor, configured)
        : cfg.agents.filter((a) => a !== branchAuthor).map((a) => ({ agent: a, model: null, effort: null }));
      const reviewers = reviewerList.length ? reviewerList : [{ agent: cfg.agents[0], model: null, effort: null }];
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

    const results = [];
    const mergedBranches = []; // #44: cycle branches that actually landed on main
    for (const run of runs) {
      if (!dry) {
        const baseSha = git.git(["rev-parse", "main"], repo);
        inflight.register(orchDir, run.sid, { branch: run.branch, pid: process.pid, baseSha });
        const live = inflight.countLive(orchDir);
        if (live > cfg.concurrency) {
          inflight.deregister(orchDir, run.sid);
          console.log(`orch: concurrency cap ${cfg.concurrency} reached — ${live} cycles live; skipping ${run.branch}`);
          process.exitCode = 2;
          continue;
        }
      }
      try {
        const result = await runCycle(run, dry ? dryDeps() : (deps.cycleDeps || realDeps()));
        results.push(result);
        // Cycle returned (any terminal status) → drop the resume + checkpoint records.
        // A quota throw skips this line, leaving both for the next run to resume (#24).
        if (!dry && run.mode === "task") {
          resume.clear(orchDir, run.task, run.authorName);
          checkpoint.clear(orchDir, run.sid);
        }
        console.log(`orch${dry ? " (dry)" : ""}: ${run.branch}: ${result.status} (${result.reason}) after ${result.rounds} round(s); cost ${result.usageSummary}`);
        if (result.status === "merged" && run.mode === "task") mergedBranches.push(run.branch);
        if (result.status === "escalated" || result.status === "pr-fallback") {
          process.exitCode = 2;
          // Issue bridge: leave a trace on the source issue — headless runs have
          // no one watching stdout, and the DECISION.md file is local-only.
          if (!dry && run.closes) {
            try {
              const gh = (deps.githubDeps || githubDeps)().gh;
              const body = redact(buildIssueComment(result, run.branch));
              gh(["issue", "comment", String(run.closes), "--body-file", "-"], body);
            } catch (e) {
              console.error(`orch: could not comment on issue #${run.closes}: ${e.message}`);
            }
          }
        }
      } finally {
        if (!dry) inflight.deregister(orchDir, run.sid);
      }
    }
    // After the cycles: the detached docs-update runs `orch task`, so spawn it
    // outside the loop. maybeSpawnDocs only fires on a real `merged` result.
    let docsPending = false;
    for (const result of results) docsPending = maybeSpawnDocs(result, cfg, { dry }, orchDir) || docsPending;

    // #44: a human is at the terminal — tidy up the branches/state orch created and
    // explain it in plain English, instead of dead-ending in an opaque git state.
    // Default on; `--no-tidy` opts out. finishRun is idempotent, so the detached
    // docs child (which re-runs `orch task`) safely tidies itself when it lands.
    if (!dry && !flags["no-tidy"] && mergedBranches.length) {
      const finishFn = deps.finishRun || finishRun;
      const io = deps.io || realIo();
      const runStats = results.flatMap((r) => r.runStats || []);
      await finishFn(
        { repo, task, operatorBranch, merged: mergedBranches, interactive: Boolean(process.stdin.isTTY), docsPending, runStats },
        { git, io },
      );
    }
    return;
  }

  if (command === "pr") {
    const cfg = applyRoleOverrides(load(repo), flags, { allowReviewerOnly: true });
    const n = rest[0];
    if (!n) throw new Error("usage: orch pr <number> [--merge]");
    preflightFn(cfg, orchDir);
    if (isPaused(orchDir)) throw new Error(".orch/pause present — orchestration paused");
    if (!acquireLock(orchDir)) throw new Error(".orch/lock held — another cycle is running");
    git.reclaimOrphanWorktrees(repo, orchDir); // clear orphans from a crashed prior cycle
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

  if (command === "dashboard") {
    const historyLimit = flags.limit ? Number(flags.limit) : 10;
    if (flags.json) console.log(JSON.stringify(dashboardSnapshot(orchDir, { historyLimit }), null, 2));
    else console.log(renderDashboard(orchDir, { historyLimit }));
    return;
  }

  printUsage();
}

function printUsage() {
  console.log(`agent-orch ${VERSION}
Usage:
  orch init [--link]   (--link: wire .orch/ORCH.md into CLAUDE.md/AGENTS.md/GEMINI.md)
  orch agent add <name>
  orch agent build <name> [--pr]
    (unregistered agent → scaffolds src/adapters/<name>.js through orch's own
     author→audit→test pipeline, isolated in its own worktree/branch; default
     lands on that local branch only, --pr opens a PR instead)
  orch task "change" [--author "<agent> [model] [effort]" --reviewer "<agent> [model] [effort]"]
    (or: orch task --file work-order.json — an UNTRUSTED JSON work order:
     {title, problem, repro_steps[], suspected_paths[], acceptance_criteria[]}; title/problem required)
  orch issue <number> [--author ... --reviewer ...]
    (fetch a GitHub issue as an UNTRUSTED work order, run the full cycle, and
     stamp "Closes #<number>" on the merge so it auto-closes)
  orch review <branch> [--reviewer "claude claude-opus-4-8 high, codex"]
  orch pr <number> [--merge] [--reviewer ...]
  orch dashboard [--json] [--limit N]
    (read-only: live cycle status/stage, streaming log tail, run history, success-rate metrics)
  A role spec is "<agent> [model] [effort]"; model may carry a subversion (e.g. claude-opus-4-8).
  --cheap forces orch.yml's cheap.role (e.g. a local llm) for one run (task/issue);
  set cheap.paths to auto-route matching --file/orch issue work orders without the flag.
  If launched from main, orch creates and switches to orch/<slug> first.
  After a merge, orch pushes main, deletes its temp branches, and prints a summary;
  --no-tidy leaves all branches/checkout untouched.
  (flags: --dry, --cheap, --link, --no-tidy, --no-banner, --version, --help)`);
}

function costSuffix(result) {
  return result?.usageSummary ? `; cost ${result.usageSummary}` : "";
}

// Real collaborators for the GitHub PR bridge. gh/git shell out; cycle binds
// the engine to its real deps. §3f: the public PR comment is a machine summary
// only (built in github.runPr), so no reviewer prose is read back here.
function githubDeps() {
  return {
    gh: (args, input) => execFileSync("gh", args, { input, encoding: "utf8" }).toString(),
    git: git.git,
    cycle: (o) => runCycle(o, realDeps()),
    log: (m) => process.stderr.write(`▶ ${m}\n`),
  };
}
