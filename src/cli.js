import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { load } from "./config.js";
import { runCycle } from "./engine.js";
import * as adapters from "./adapters/index.js";
import * as git from "./git.js";
import * as gate from "./gate.js";
import * as scope from "./scope.js";
import * as notify from "./notify.js";
import { acquireLock, releaseLock, isPaused } from "./lock.js";
import { slugify } from "./slug.js";
import { VERSION } from "./version.js";

export { slugify };

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
    options: { dry: { type: "boolean" }, version: { type: "boolean" } },
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

function preflight(cfg) {
  // Check the rotation pool plus any explicitly pinned roles.
  const names = new Set([...cfg.agents, cfg.author, cfg.reviewer].filter(Boolean));
  for (const name of names) {
    const a = adapters.get(name); // throws on unknown
    const exe = a.bin || a.name; // local models run via `ccr`, not their own name
    try { execFileSync("which", [exe], { stdio: "ignore" }); }
    catch { throw new Error(`agent CLI not found on PATH: ${exe} (for agent ${name})`); }
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
    mkdirSync(orchDir, { recursive: true });
    const ex = join(orchDir, "orch.yml");
    if (!existsSync(ex) && !existsSync(join(repo, "orch.yml"))) {
      writeFileSync(ex, SCAFFOLD);
    }
    const cfg = load(repo);
    preflight(cfg);
    console.log("orch: initialized (.orch/orch.yml). Agent CLIs found.");
    return;
  }

  if (command === "task" || command === "review") {
    const cfg = load(repo);
    const dry = Boolean(flags.dry) || process.env.ORCH_DRYRUN === "1";
    if (!dry) preflight(cfg); // dry-run never shells out, so don't require CLIs

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
    try {
      const result = await runCycle(
        { mode, task, branch, authorName, reviewerName, cfg, orchDir, repo, worktree },
        dry ? dryDeps() : realDeps()
      );
      console.log(`orch${dry ? " (dry)" : ""}: ${result.status} (${result.reason}) after ${result.rounds} round(s)`);
      if (result.status === "escalated") process.exitCode = 2;
    } finally {
      releaseLock(orchDir);
    }
    return;
  }

  console.log(`agent-orch ${VERSION}\nUsage:\n  orch init\n  orch task "change"\n  orch review <branch>\n  (flags: --dry, --version)`);
}
