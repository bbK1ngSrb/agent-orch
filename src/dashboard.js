// Read-only view over existing .orch/ state: live cycles (inflight + their
// latest checkpoint), interrupted checkpoints, run history (runs.jsonl), and
// success-rate metrics.
// No new persistence — this only reads what engine.js/finalize.js/notify.js
// already write.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as inflight from "./inflight.js";
import * as checkpoint from "./checkpoint.js";
import { branchExists } from "./git.js";
import { kpi, reviewsDir } from "./notify.js";
import { paint, C, table } from "./tui/theme.js";

const STAGE_LABELS = { reviewed: "review", tested: "test" };
const VERDICT_COLOR = { merged: C.ok, pr: C.warn, escalated: C.fail, "pr-fallback": C.fail };

// Live cycles, newest inflight registration first, each annotated with its
// most recent checkpoint stage (or "authoring" if none was recorded yet —
// checkpoint.record only fires after the first review/test round).
export function liveCycles(orchDir) {
  return inflight.listLive(orchDir)
    .map((e) => {
      const ck = checkpoint.lookup(orchDir, e.sid);
      return {
        sid: e.sid,
        branch: e.branch,
        pid: e.pid,
        startedAt: e.ts,
        stage: ck ? (STAGE_LABELS[ck.stage] || ck.stage) : "authoring",
        round: ck?.round ?? null,
        lastUpdate: ck?.ts || e.ts,
      };
    })
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

function readCheckpoints(orchDir) {
  const d = join(orchDir, "checkpoints");
  if (!existsSync(d)) return [];
  const out = [];
  for (const f of readdirSync(d)) {
    if (!f.endsWith(".json")) continue;
    try {
      const ck = JSON.parse(readFileSync(join(d, f), "utf8"));
      if (!ck?.branch) continue;
      out.push({
        sid: f.slice(0, -".json".length),
        branch: ck.branch,
        stage: STAGE_LABELS[ck.stage] || ck.stage || "unknown",
        round: ck.round ?? null,
        lastUpdate: ck.ts || null,
      });
    } catch {
      // Ignore corrupt partial writes; checkpoint.lookup behaves the same way.
    }
  }
  return out.sort((a, b) => ((a.lastUpdate || "") < (b.lastUpdate || "") ? 1 : -1));
}

// A checkpoint with no live owner is normally a crashed/stalled cycle. But if
// its branch is gone (deleteBranchSafe runs after a clean merge), the cycle
// actually finished and something upstream just skipped checkpoint.clear —
// e.g. a manual merge outside orch, or a crash right before cleanup. Repo is
// optional so callers without a real git checkout (tests, JSON-only reads)
// keep the old behavior of listing every ownerless checkpoint.
export function interruptedCycles(orchDir, live = liveCycles(orchDir), repo = null) {
  const liveSids = new Set(live.map((c) => c.sid));
  const orphaned = readCheckpoints(orchDir).filter((c) => !liveSids.has(c.sid));
  if (!repo) return orphaned;
  return orphaned.filter((c) => branchExists(repo, c.branch));
}

function readJsonl(p) {
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

// Most recent entries first.
export function runHistory(orchDir, limit = 20) {
  const entries = readJsonl(join(orchDir, "runs.jsonl"));
  return entries.slice(-limit).reverse();
}

// Success-rate + usage totals over the full run-history file.
export function metrics(orchDir) {
  const entries = readJsonl(join(orchDir, "runs.jsonl"));
  let merged = 0, tokens = 0, costUsd = 0, hasCost = false;
  for (const e of entries) {
    if (e.verdict === "merged" || e.verdict === "pr") merged++;
    if (typeof e.tokens === "number") tokens += e.tokens;
    if (typeof e.costUsd === "number") { costUsd += e.costUsd; hasCost = true; }
  }
  return {
    total: entries.length,
    merged,
    successRate: entries.length ? merged / entries.length : null,
    totalTokens: tokens,
    totalCostUsd: hasCost ? costUsd : null,
    cleanUnattendedCycles: kpi(orchDir).cleanUnattendedCycles,
  };
}

// Tail of the latest review round for a live branch — the closest thing to a
// "streaming log" available from existing state (round-N.md is written once
// per completed round, not incrementally).
export function latestLog(orchDir, branch, lines = 12) {
  const dir = reviewsDir(orchDir, branch);
  if (!existsSync(dir)) return null;
  const rounds = readdirSync(dir)
    .filter((f) => /^round-\d+\.md$/.test(f))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  if (!rounds.length) return null;
  const file = rounds[rounds.length - 1];
  const content = readFileSync(join(dir, file), "utf8").split("\n").filter(Boolean);
  return { file, tail: content.slice(-lines).join("\n") };
}

export function snapshot(orchDir, { historyLimit = 10, repo = null } = {}) {
  const live = liveCycles(orchDir);
  const interrupted = interruptedCycles(orchDir, live, repo);
  return {
    live: live.map((c) => ({ ...c, log: latestLog(orchDir, c.branch) })),
    interrupted,
    history: runHistory(orchDir, historyLimit),
    metrics: metrics(orchDir),
  };
}

function pct(n) { return n == null ? "n/a" : `${Math.round(n * 100)}%`; }
function usd(n) { return n == null ? "n/a" : `$${n.toFixed(4)}`; }

export function render(orchDir, opts = {}) {
  const { historyLimit, color = false, repo = null } = opts;
  const { live, interrupted, history, metrics: m } = snapshot(orchDir, { historyLimit, repo });
  const lines = [];
  lines.push(`orch dashboard — ${orchDir}`);
  lines.push("");
  lines.push(`Live cycles (${live.length})`);
  if (!live.length) {
    lines.push("  (none)");
  } else {
    for (const c of live) {
      const round = c.round != null ? ` round ${c.round}` : "";
      lines.push(`  ${c.branch}  [${c.stage}${round}]  sid=${c.sid}  pid=${c.pid}  since ${c.startedAt}`);
      if (c.log) lines.push(`    log (${c.log.file}): ${c.log.tail.split("\n").pop()}`);
    }
  }
  lines.push("");
  lines.push(`Interrupted cycles (${interrupted.length})`);
  if (!interrupted.length) {
    lines.push("  (none)");
  } else {
    for (const c of interrupted) {
      const round = c.round != null ? ` round ${c.round}` : "";
      const when = c.lastUpdate ? `  last update ${c.lastUpdate}` : "";
      lines.push(`  ${c.branch}  [${c.stage}${round}]  sid=${c.sid}${when}`);
    }
  }
  lines.push("");
  lines.push(`Run history (last ${history.length})`);
  if (!history.length) {
    lines.push("  (none)");
  } else {
    const rows = history.map((e) => {
      const usage = e.tokens ? `${e.tokens}tok${e.costUsd != null ? ` ${usd(e.costUsd)}` : ""}` : "";
      const verdict = paint(color, VERDICT_COLOR[e.verdict] || "", e.verdict);
      return [e.ts, e.branch, verdict, `${e.rounds}rnd`, usage];
    });
    lines.push(table(["TIME", "BRANCH", "VERDICT", "ROUNDS", "COST"], rows, { color }));
  }
  lines.push("");
  lines.push("Metrics");
  lines.push(`  runs: ${m.total}  merged: ${m.merged}  success rate: ${pct(m.successRate)}`);
  lines.push(`  clean unattended cycles: ${m.cleanUnattendedCycles}`);
  lines.push(`  tokens: ${m.totalTokens}  cost: ${usd(m.totalCostUsd)}`);
  return lines.join("\n");
}
