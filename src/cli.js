import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
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
// ponytail: no log capture — if the spawned task fails it's invisible.
// Upgrade path: redirect stdio to .orch/auto-docs.log if visibility is needed.
export function spawnDocsTask(prompt, deps = { spawn }) {
  deps.spawn(process.execPath, [process.argv[1], "task", prompt],
    { detached: true, stdio: "ignore" }).unref();
  console.log("▶ post-merge: docs-update spawned");
}

// Loop guard + opt-in gate around spawnDocsTask. Real merge only (never --dry).
// Skips docs-only merges (the docs-update's own merge can't re-trigger) AND no-op
// merges (an empty diff would re-spawn forever, since it's not docs-only either).
export function maybeSpawnDocs(res, cfg, deps = {}) {
  const { dry = false, spawn: spawnFn = spawn } = deps;
  if (dry || res.status !== "merged" || !cfg.docs.autoUpdate || res.docsOnly || res.noop) return false;
  spawnDocsTask(cfg.docs.prompt, { spawn: spawnFn });
  return true;
}

// init scaffold — mirrors orch.example.yml. Defaults uncommented; author/reviewer
// commented (opt-in: they override rotation and must be set together).
const SCAFFOLD = `# agent-orch config — all keys optional. Defaults shown.

# Pick roles explicitly (set both or neither). Unset → agents rotate the author.
# author: claude     # writes the change
# reviewer: codex    # audits it

agents: [claude, codex]   # rotation pool, used only when author/reviewer are unset
test: auto                # or an explicit command, e.g. "pytest -q"
reviseCap: 3              # max revise rounds before escalation
merge: ff-only            # or no-ff
`;

export function parse(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { dry: { type: "boolean" }, version: { type: "boolean" }, merge: { type: "boolean" } },
  });
  return { command: positionals[0], rest: positionals.slice(1), flags: values };
}

export function nextAuthor(cfg, orchDir) {
  // Explicit fixed roles win over rotation — the trivial "who authors, who audits".
  if (cfg.author && cfg.reviewer) {
    mkdirSync(orchDir, { recursive: true });
    return { authorName: cfg.author, reviewerName: cfg.reviewer };
  }
  const f = join(orchDir, "last-author");
  const last = existsSync(f) ? readFileSync(f, "utf8").trim() : null;
  const i = last ? (cfg.agents.indexOf(last) + 1) % cfg.agents.length : 0;
  const authorName = cfg.agents[i];
  const reviewerName = cfg.agents[(i + 1) % cfg.agents.length] || authorName;
  mkdirSync(orchDir, { recursive: true });
  writeFileSync(f, authorName + "\n");
  return { authorName, reviewerName };
}

export function preflight(cfg, orchDir) {
  // Check the rotation pool plus any explicitly pinned roles.
  const names = new Set([...cfg.agents, cfg.author, cfg.reviewer].filter(Boolean));
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
    const cfg = load(repo);
    const dry = Boolean(flags.dry) || process.env.ORCH_DRYRUN === "1";
    if (!dry) preflight(cfg, orchDir); // dry-run never shells out, so don't require CLIs

    // F3: operator kill switch + one-cycle-at-a-time lock.
    if (isPaused(orchDir)) throw new Error(".orch/pause present — orchestration paused");

    const mode = command; // "task" | "review"
    let authorName, reviewerName, branch, task;
    if (mode === "task") {
      task = rest.join(" ");
      if (!task) throw new Error('usage: orch task "describe the change"');
      ({ authorName, reviewerName } = nextAuthor(cfg, orchDir));
      branch = `pr/${authorName}/${slugify(task)}`;
    } else {
      branch = rest[0];
      if (!branch) throw new Error("usage: orch review <branch>");
      // audit-only: reviewer = first agent != branch author. authorName unused by engine.
      const branchAuthor = branch.split("/")[1];
      reviewerName = cfg.agents.find((a) => a !== branchAuthor) || cfg.agents[0];
      authorName = branchAuthor && cfg.agents.includes(branchAuthor) ? branchAuthor : cfg.agents[0];
      task = null;
    }
    const worktree = join(orchDir, "wt", branch.replace(/\//g, "_"));

    if (!acquireLock(orchDir)) throw new Error(".orch/lock held — another cycle is running");
    let result;
    try {
      result = await runCycle(
        { mode, task, branch, authorName, reviewerName, cfg, orchDir, repo, worktree },
        dry ? dryDeps() : realDeps()
      );
      console.log(`orch${dry ? " (dry)" : ""}: ${result.status} (${result.reason}) after ${result.rounds} round(s)`);
      if (result.status === "escalated") process.exitCode = 2;
    } finally {
      releaseLock(orchDir);
    }
    // After releasing the lock: the detached docs-update runs `orch task`, which
    // acquires the same lock. Spawning inside the try would race our own release.
    maybeSpawnDocs(result, cfg, { dry }); // auto docs-update on a real merge
    return;
  }

  if (command === "pr") {
    const cfg = load(repo);
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

  console.log(`agent-orch ${VERSION}\nUsage:\n  orch init\n  orch task "change"\n  orch review <branch>\n  orch pr <number> [--merge]\n  (flags: --dry, --version)`);
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
