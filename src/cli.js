import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, openSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { execFileSync, spawn } from "node:child_process";
import { load, configPath, parseRoleSpec, parseRoleSpecs } from "./config.js";
import { runCycle } from "./engine.js";
import { runPr, demote } from "./github.js";
import * as adapters from "./adapters/index.js";
import * as git from "./git.js";
import * as gate from "./gate.js";
import * as scope from "./scope.js";
import * as notify from "./notify.js";
import { acquireLock, releaseLock, acquireBlocking, isPaused } from "./lock.js";
import { slugify } from "./slug.js";
import { VERSION } from "./version.js";
import { newSid } from "./sid.js";
import * as inflight from "./inflight.js";
import * as resume from "./resume.js";
import { finalize } from "./finalize.js";
import { validateWorkOrder, buildAuthorPrompt } from "./intake/workorder.js";
import { appCredsFromEnv, installationToken, parseRepoSlug } from "./github-app.js";

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
merge: no-ff              # merge into main: ff-only | no-ff; default: no-ff (concurrent disjoint cycles both land; ff-only = linear but extra cycles fall back to PR)
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
      help: { type: "boolean", short: "h" },
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
function realDeps() {
  const ghShell = (args, input) => execFileSync("gh", args, { input, encoding: "utf8" }).toString();
  const githubDep = { demote: (ctx) => demote(ctx, { gh: ghShell, git: git.git, notify, log: (m) => process.stderr.write(`▶ ${m}\n`) }) };
  const finalizeDep = (ctx) => finalize(ctx, { git, gate, lock: { acquireBlocking, releaseLock }, inflight, github: githubDep, notify });
  return { adapters, git, gate, scope, notify, inflight, finalize: finalizeDep };
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
    let task, authorPrompt, reviewBranch;
    if (mode === "task") {
      // §3a/§3b: a --file task is UNTRUSTED intake — it must be a JSON work order,
      // validated for shape, then wrapped in a neutralized fence the author treats
      // as reference, not instructions. Free-text `orch task "..."` (operator-typed,
      // trusted) is unchanged. `task` stays a short human label (drives slug/resume);
      // `authorPrompt` is what the author actually sees.
      if (flags.file) {
        const wo = parseWorkOrderFile(flags.file);
        task = wo.title;
        authorPrompt = buildAuthorPrompt(wo);
      } else {
        task = rest.join(" ");
        authorPrompt = task;
      }
      if (!task) throw new Error('usage: orch task "describe the change" (or --file work-order.json)');
    } else {
      reviewBranch = rest[0];
      if (!reviewBranch) throw new Error("usage: orch review <branch>");
    }

    // Integration worktree owns `main`; if cwd is on main, move it to an
    // operator branch before reclaim/picking branches. Reclaim orphaned
    // worktrees BEFORE picking branches so resume resolution (#24) sees
    // post-reclaim truth — a hard-killed orphan branch is already gone by then,
    // so resume safely degrades to a fresh start instead of attaching a dead ref.
    let liveBranches = new Set();
    if (!dry) {
      switchFromMain(repo, mode === "task" ? task : `review ${reviewBranch}`);
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
          mode, task, authorPrompt, branch, sid, resume, authorName, author: authorSpec,
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

    const results = [];
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
        // Cycle returned (any terminal status) → drop the resume record. A quota
        // throw skips this line, leaving the record for the next run to resume (#24).
        if (!dry && run.mode === "task") resume.clear(orchDir, run.task, run.authorName);
        console.log(`orch${dry ? " (dry)" : ""}: ${run.branch}: ${result.status} (${result.reason}) after ${result.rounds} round(s)`);
        if (result.status === "escalated" || result.status === "pr-fallback") process.exitCode = 2;
      } finally {
        if (!dry) inflight.deregister(orchDir, run.sid);
      }
    }
    // After the cycles: the detached docs-update runs `orch task`, so spawn it
    // outside the loop. maybeSpawnDocs only fires on a real `merged` result.
    for (const result of results) maybeSpawnDocs(result, cfg, { dry }, orchDir);
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

  printUsage();
}

function printUsage() {
  console.log(`agent-orch ${VERSION}
Usage:
  orch init
  orch agent add <name>
  orch task "change" [--author "<agent> [model] [effort]" --reviewer "<agent> [model] [effort]"]
    (or: orch task --file work-order.json — an UNTRUSTED JSON work order:
     {title, problem, repro_steps[], suspected_paths[], acceptance_criteria[]}; title/problem required)
  orch review <branch> [--reviewer "claude claude-opus-4-8 high, codex"]
  orch pr <number> [--merge] [--reviewer ...]
  A role spec is "<agent> [model] [effort]"; model may carry a subversion (e.g. claude-opus-4-8).
  If launched from main, orch creates and switches to orch/<slug> first.
  (flags: --dry, --version, --help)`);
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
