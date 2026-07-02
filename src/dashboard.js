// Read-only view over existing .orch/ state: live cycles (inflight + their
// latest checkpoint), run history (runs.jsonl), and success-rate metrics.
// No new persistence — this only reads what engine.js/finalize.js/notify.js
// already write.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as inflight from "./inflight.js";
import * as checkpoint from "./checkpoint.js";
import { kpi, reviewsDir } from "./notify.js";

const STAGE_LABELS = { reviewed: "review", tested: "test" };

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

export function snapshot(orchDir, { historyLimit = 10 } = {}) {
  const live = liveCycles(orchDir);
  return {
    live: live.map((c) => ({ ...c, log: latestLog(orchDir, c.branch) })),
    history: runHistory(orchDir, historyLimit),
    metrics: metrics(orchDir),
  };
}

function pct(n) { return n == null ? "n/a" : `${Math.round(n * 100)}%`; }
function usd(n) { return n == null ? "n/a" : `$${n.toFixed(4)}`; }

export function render(orchDir, opts = {}) {
  const { live, history, metrics: m } = snapshot(orchDir, opts);
  const lines = [];
  lines.push(`orch dashboard — ${orchDir}`);
  lines.push("");
  lines.push(`Live cycles (${live.length})`);
  if (!live.length) {
    lines.push("  (none)");
  } else {
    for (const c of live) {
      const round = c.round != null ? ` round ${c.round}` : "";
      lines.push(`  ${c.branch}  [${c.stage}${round}]  pid=${c.pid}  since ${c.startedAt}`);
      if (c.log) lines.push(`    log (${c.log.file}): ${c.log.tail.split("\n").pop()}`);
    }
  }
  lines.push("");
  lines.push(`Run history (last ${history.length})`);
  if (!history.length) {
    lines.push("  (none)");
  } else {
    for (const e of history) {
      const usage = e.tokens ? `  ${e.tokens}tok${e.costUsd != null ? ` ${usd(e.costUsd)}` : ""}` : "";
      lines.push(`  ${e.ts}  ${e.branch}  ${e.verdict}  ${e.rounds}rnd${usage}`);
    }
  }
  lines.push("");
  lines.push("Metrics");
  lines.push(`  runs: ${m.total}  merged: ${m.merged}  success rate: ${pct(m.successRate)}`);
  lines.push(`  clean unattended cycles: ${m.cleanUnattendedCycles}`);
  lines.push(`  tokens: ${m.totalTokens}  cost: ${usd(m.totalCostUsd)}`);
  return lines.join("\n");
}
