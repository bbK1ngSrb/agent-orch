import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync, openSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { execFileSync, spawn } from "node:child_process";
import { load } from "./config.js";
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

// init scaffold — mirrors orch.example.yml. Defaults uncommented; role overrides
// commented (opt-in: they override rotation and must be set together).
const SCAFFOLD = `# agent-orch config — all keys optional. Defaults shown.

# Pick roles explicitly (set both sides or neither). Unset → agents rotate the author.
# author: claude     # writes the change
# reviewer: codex    # audits it
# authors: [claude, codex]    # each writes a separate branch
# reviewers: [claude, codex]  # all audit each branch, except its author

agents: [claude, codex]   # rotation pool, used only when author/reviewer are unset
test: auto                # or an explicit command, e.g. "pytest -q"
reviseCap: 3              # max revise rounds before escalation
merge: ff-only            # or no-ff
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
    return { authorNames: splitNames(cfg.authors), reviewerNames: splitNames(cfg.reviewers) };
  }
  if (cfg.author && cfg.reviewer) {
    return { authorNames: [cfg.author], reviewerNames: [cfg.reviewer] };
  }
  return null;
}

function configuredReviewers(cfg) {
  if (cfg.reviewers) return splitNames(cfg.reviewers);
  if (cfg.reviewer) return [cfg.reviewer];
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
  const fixed = fixedRoles(cfg);
  if (fixed) {
    mkdirSync(orchDir, { recursive: true });
    return {
      authorName: fixed.authorNames[0],
      reviewerName: fixed.reviewerNames[0],
      ...fixed,
    };
  }
  const f = join(orchDir, "last-author");
  const last = existsSync(f) ? readFileSync(f, "utf8").trim() : null;
  const i = last ? (cfg.agents.indexOf(last) + 1) % cfg.agents.length : 0;
  const authorName = cfg.agents[i];
  const reviewerName = cfg.agents[(i + 1) % cfg.agents.length] || authorName;
  mkdirSync(orchDir, { recursive: true });
  writeFileSync(f, authorName + "\n");
  return { authorName, reviewerName, authorNames: [authorName], reviewerNames: [reviewerName] };
}

export function preflight(cfg, orchDir) {
  // Check the rotation pool plus any explicitly pinned roles.
  const names = new Set([
    ...cfg.agents,
    cfg.author,
    cfg.reviewer,
    ...(cfg.authors || []),
    ...(cfg.reviewers || []),
  ].filter(Boolean));
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

function reviewersForAuthor(authorName, reviewerNames) {
  const others = reviewerNames.filter((name) => name !== authorName);
  return others.length ? others : reviewerNames;
}

export async function main(argv) {
  const { command, rest, flags } = parse(argv);
  if (flags.version || command === "version") { console.log(VERSION); return; }

  const repo = process.cwd();
  const orchDir = join(repo, ".orch");

  if (command === "init") {
    // Preflight first: it probes .orch/ writability and fails with a clear
    // message before any real write, so a read-only repo never surfaces a raw
    // EACCES from the mkdir/writeFile below. load() tolerates a missing config.
    const cfg = load(repo);
    preflight(cfg, orchDir);
    mkdirSync(orchDir, { recursive: true });
    const ex = join(orchDir, "orch.yml");
    if (!existsSync(ex) && !existsSync(join(repo, "orch.yml"))) {
      writeFileSync(ex, SCAFFOLD);
    }
    console.log("orch: initialized (.orch/orch.yml). Agent CLIs found.");
    return;
  }

  if (command === "task" || command === "review") {
    const cfg = applyRoleOverrides(load(repo), flags, { allowReviewerOnly: command === "review" });
    const dry = Boolean(flags.dry) || process.env.ORCH_DRYRUN === "1";
    if (!dry) preflight(cfg, orchDir); // dry-run never shells out, so don't require CLIs

    // F3: operator kill switch + one-cycle-at-a-time lock.
    if (isPaused(orchDir)) throw new Error(".orch/pause present — orchestration paused");

    const mode = command; // "task" | "review"
    let runs, task;
    if (mode === "task") {
      task = flags.file ? readFileSync(flags.file, "utf8").trim() : rest.join(" ");
      if (!task) throw new Error('usage: orch task "describe the change" (or --file path)');
      const { authorNames, reviewerNames } = nextAuthor(cfg, orchDir);
      runs = authorNames.map((authorName) => {
        const branch = `pr/${authorName}/${slugify(task)}`;
        const reviewerList = reviewersForAuthor(authorName, reviewerNames);
        return {
          mode, task, branch, authorName,
          reviewerName: reviewerList[0], reviewerNames: reviewerList,
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
        : cfg.agents.filter((a) => a !== branchAuthor);
      const reviewers = reviewerList.length ? reviewerList : [cfg.agents[0]];
      const authorName = branchAuthor && cfg.agents.includes(branchAuthor) ? branchAuthor : cfg.agents[0];
      task = null;
      runs = [{
        mode, task, branch, authorName,
        reviewerName: reviewers[0], reviewerNames: reviewers,
        cfg, orchDir, repo, worktree: join(orchDir, "wt", branch.replace(/\//g, "_")),
      }];
    }

    if (!acquireLock(orchDir)) throw new Error(".orch/lock held — another cycle is running");
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
    preflight(cfg, orchDir);
    if (isPaused(orchDir)) throw new Error(".orch/pause present — orchestration paused");
    if (!acquireLock(orchDir)) throw new Error(".orch/lock held — another cycle is running");
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

  console.log(`agent-orch ${VERSION}\nUsage:\n  orch init\n  orch task "change" [--author A --reviewer B]   (or: orch task --file task.md)\n  orch review <branch> [--reviewer A,B]\n  orch pr <number> [--merge] [--reviewer A,B]\n  (flags: --dry, --version)`);
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
