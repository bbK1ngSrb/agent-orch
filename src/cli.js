import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync, openSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { execFileSync, spawn } from "node:child_process";
import { load, configPath, parseRoleSpec, parseRoleSpecs } from "./config.js";
import { runCycle } from "./engine.js";
import { runPr } from "./github.js";
import * as adapters from "./adapters/index.js";
import * as git from "./git.js";
import * as gate from "./gate.js";
import * as scope from "./scope.js";
import * as notify from "./notify.js";
import { acquireLock, releaseLock, isPaused } from "./lock.js";
import { slugify } from "./slug.js";
import { VERSION } from "./version.js";

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
#   model  — optional model id, may carry a subversion (e.g. opus-4.8, gpt-5.1)
#   effort — optional reasoning effort (e.g. low | medium | high)
# Unset → the agents pool rotates the author; the next agent reviews.
# author: claude opus-4.8 high      # single author spec
# reviewer: codex gpt-5.1           # single reviewer spec
# authors: [claude opus-4.8 high, codex]   # each writes its own branch
# reviewers: [claude, codex high]          # all audit each branch, except its author

# === Cycle ===
test: auto                # "auto" detects the test command, or set one, e.g. "pytest -q"
reviseCap: 3              # max revise rounds before escalation (positive integer); default: 3
merge: ff-only            # merge into main: ff-only | no-ff; default: ff-only
concurrency: 4            # max concurrent orch cycles in this repo dir; over this a cycle exits; default: 4

# === Scope gate (optional) ===
scope:
  maxLines: 0             # 0 = disabled; >0 escalates author commits over this many changed lines
  ignore: ["*.lock", "dist/**", "*.snap"]   # globs excluded from the line count

# === GitHub PR bridge (orch pr <n>) ===
github:
  mergeMethod: squash     # gh pr merge strategy: squash | merge | rebase; default: squash

# === Auto docs-update after a real merge (optional) ===
docs:
  autoUpdate: false       # true = spawn a docs-update task after a merge; default: false
  prompt: update documentation to reflect the latest merged changes
  paths: ["*.md", "docs/**", "**/*.md"]   # docs-only globs (loop guard)
`;

export function parse(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      dry: { type: "boolean" },
      version: { type: "boolean" },
      merge: { type: "boolean" },
      author: { type: "string" },
      reviewer: { type: "string" },
      authors: { type: "string" },
      reviewers: { type: "string" },
      file: { type: "string" },
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

export function nextAuthor(cfg, orchDir) {
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
  const last = existsSync(f) ? readFileSync(f, "utf8").trim() : null;
  const i = last ? (cfg.agents.indexOf(last) + 1) % cfg.agents.length : 0;
  const authorName = cfg.agents[i];
  const reviewerName = cfg.agents[(i + 1) % cfg.agents.length] || authorName;
  mkdirSync(orchDir, { recursive: true });
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
function realDeps() {
  return { adapters, git, gate, scope, notify };
}
function dryDeps() {
  const verdict = { decision: "AGREE", reason: "(dry-run: assumed agree)", raw: "" };
  return {
    adapters: { get: (n) => ({ name: n, async author() {}, async audit() { return verdict; } }) },
    git: {
      createTaskBranch() {}, attachExistingBranch() {}, pruneWorktree() {},
      mergeIntoMain() { return { ok: true, reason: "dry-run" }; },
      git() { return "(dry-run diff)"; },
      changedFiles() { return []; },
    },
    gate: { detect: () => "true", run: () => ({ pass: true, log: "(dry-run)" }) },
    scope: { count: () => 0 },
    notify,
  };
}

function reviewersForAuthor(authorName, reviewerSpecs) {
  const others = reviewerSpecs.filter((s) => s.agent !== authorName);
  return others.length ? others : reviewerSpecs;
}

export async function main(argv, deps = {}) {
  const { command, rest, flags } = parse(argv);
  if (flags.version || command === "version") { console.log(VERSION); return; }

  const repo = process.cwd();
  const orchDir = join(repo, ".orch");
  // preflight shells out to `which <agent-cli>`; tests stub it so the suite
  // is green in a CLI-less environment (e.g. clean CI). Production passes none.
  const preflightFn = deps.preflight || preflight;

  if (command === "init") {
    // Preflight first: it probes .orch/ writability and fails with a clear
    // message before any real write, so a read-only repo never surfaces a raw
    // EACCES from the mkdir/writeFile below. load() tolerates a missing config.
    const cfg = load(repo);
    preflightFn(cfg, orchDir);
    mkdirSync(orchDir, { recursive: true });
    const ex = join(orchDir, "orch.yml");
    if (!existsSync(ex) && !existsSync(join(repo, "orch.yml"))) {
      writeFileSync(ex, SCAFFOLD);
    }
    console.log("orch: initialized (.orch/orch.yml). Agent CLIs found.");
    return;
  }

  if (command === "agent") {
    // `orch agent add <name>` appends a known agent to the `agents:` rotation
    // pool in orch.yml, preserving the file's comments. Only registered agents
    // are accepted so the next run's preflight stays valid.
    if (rest[0] !== "add" || !rest[1]) throw new Error("usage: orch agent add <name>");
    const name = rest[1];
    adapters.get(name); // throws "unknown agent: <name>" for unregistered names
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

  if (command === "task" || command === "review") {
    const cfg = applyRoleOverrides(load(repo), flags, { allowReviewerOnly: command === "review" });
    const dry = Boolean(flags.dry) || process.env.ORCH_DRYRUN === "1";
    if (!dry) preflightFn(cfg, orchDir); // dry-run never shells out, so don't require CLIs

    // F3: operator kill switch + one-cycle-at-a-time lock.
    if (isPaused(orchDir)) throw new Error(".orch/pause present — orchestration paused");

    const mode = command; // "task" | "review"
    let runs, task;
    if (mode === "task") {
      task = flags.file ? readFileSync(flags.file, "utf8").trim() : rest.join(" ");
      if (!task) throw new Error('usage: orch task "describe the change" (or --file path)');
      const { authors, reviewers } = nextAuthor(cfg, orchDir);
      runs = authors.map((authorSpec) => {
        const authorName = authorSpec.agent;
        const branch = `pr/${authorName}/${slugify(task)}`;
        const reviewerList = reviewersForAuthor(authorName, reviewers);
        return {
          mode, task, branch, authorName, author: authorSpec,
          reviewerName: reviewerList[0].agent, reviewerNames: reviewerList.map((s) => s.agent),
          reviewers: reviewerList,
          cfg, orchDir, repo, worktree: join(orchDir, "wt", branch.replace(/\//g, "_")),
        };
      });
    } else {
      const branch = rest[0];
      if (!branch) throw new Error("usage: orch review <branch>");
      // audit-only: reviewers default to all agents except branch author. authorName unused by engine.
      const branchAuthor = branch.split("/")[1];
      const configured = configuredReviewers(cfg);
      const reviewerList = configured
        ? reviewersForAuthor(branchAuthor, configured)
        : cfg.agents.filter((a) => a !== branchAuthor).map((a) => ({ agent: a, model: null, effort: null }));
      const reviewers = reviewerList.length ? reviewerList : [{ agent: cfg.agents[0], model: null, effort: null }];
      const authorName = branchAuthor && cfg.agents.includes(branchAuthor) ? branchAuthor : cfg.agents[0];
      task = null;
      runs = [{
        mode, task, branch, authorName, author: { agent: authorName, model: null, effort: null },
        reviewerName: reviewers[0].agent, reviewerNames: reviewers.map((s) => s.agent),
        reviewers,
        cfg, orchDir, repo, worktree: join(orchDir, "wt", branch.replace(/\//g, "_")),
      }];
    }

    if (!acquireLock(orchDir)) throw new Error(".orch/lock held — another cycle is running");
    if (!dry) git.reclaimOrphanWorktrees(repo, orchDir); // clear orphans from a crashed prior cycle
    const results = [];
    try {
      for (const run of runs) {
        const result = await runCycle(run, dry ? dryDeps() : realDeps());
        results.push(result);
        console.log(`orch${dry ? " (dry)" : ""}: ${run.branch}: ${result.status} (${result.reason}) after ${result.rounds} round(s)`);
        if (result.status === "escalated") process.exitCode = 2;
      }
    } finally {
      releaseLock(orchDir);
    }
    // After releasing the lock: the detached docs-update runs `orch task`, which
    // acquires the same lock. Spawning inside the try would race our own release.
    for (const result of results) maybeSpawnDocs(result, cfg, { dry }, orchDir); // auto docs-update on a real merge
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
      console.log(`orch pr #${n}: ${result.status} (${result.reason}) after ${result.rounds} round(s)`);
      if (result.status !== "approved") process.exitCode = 2;
    } finally {
      releaseLock(orchDir);
    }
    return;
  }

  console.log(`agent-orch ${VERSION}
Usage:
  orch init
  orch agent add <name>
  orch task "change" [--author "<agent> [model] [effort]" --reviewer "<agent> [model] [effort]"]   (or: orch task --file task.md)
  orch review <branch> [--reviewer "claude opus-4.8 high, codex"]
  orch pr <number> [--merge] [--reviewer ...]
  A role spec is "<agent> [model] [effort]"; model may carry a subversion (e.g. opus-4.8).
  (flags: --dry, --version)`);
}

// Real collaborators for the GitHub PR bridge. gh/git shell out; cycle binds
// the engine to its real deps; readVerdict pulls the reviewer's written case.
function githubDeps() {
  return {
    gh: (args, input) => execFileSync("gh", args, { input, encoding: "utf8" }).toString(),
    git: git.git,
    cycle: (o) => runCycle(o, realDeps()),
    readVerdict,
    log: (m) => process.stderr.write(`▶ ${m}\n`),
  };
}

function readVerdict(orchDir, branch) {
  const dir = join(orchDir, "reviews", branch);
  const decision = join(dir, "DECISION.md");
  if (existsSync(decision)) return readFileSync(decision, "utf8");
  if (!existsSync(dir)) return "";
  return readdirSync(dir)
    .filter((f) => f.startsWith("round-"))
    .sort()
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n");
}
