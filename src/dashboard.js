// Read-only view over existing .orch/ state: live cycles (inflight + their
// latest checkpoint), interrupted checkpoints, run history (runs.jsonl), and
// success-rate metrics.
// No new persistence — this only reads what engine.js/finalize.js/notify.js
// already write.
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import * as inflight from "./inflight.js";
import { branchExists } from "./git.js";
import { kpi, reviewsDir } from "./notify.js";
import { paint, C, STAGE_SYMBOL, VERDICT_SYMBOL, table, formatTimestamp } from "./tui/theme.js";

const STAGE_LABELS = { reviewed: "review", tested: "test" };
const VERDICT_COLOR = { merged: C.ok, pr: C.warn, escalated: C.fail, "merge-deferred": C.fail };
const RED_VERDICTS = new Set(["escalated", "merge-deferred"]);
const JSONL_CACHE = new Map();
const CHECKPOINT_CACHE = new Map();
const LOG_CACHE = new Map();
const LOG_TAIL_BYTES = 16 * 1024;

function fileStat(p) {
  try { return statSync(p); } catch { return null; }
}

function statKey(stat) { return `${stat.mtimeMs}:${stat.size}:${stat.ino}`; }

// Live cycles, newest inflight registration first, each annotated with its
// most recent checkpoint stage (or "authoring" if none was recorded yet —
// checkpoint.record only fires after the first review/test round).
export function liveCycles(orchDir) {
  return inflight.listLive(orchDir)
    .map((e) => {
      const ck = readCheckpoint(join(orchDir, "checkpoints", `${e.sid}.json`));
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

function readCheckpoint(p) {
  const stat = fileStat(p);
  if (!stat) {
    CHECKPOINT_CACHE.delete(p);
    return null;
  }
  const key = statKey(stat);
  const cached = CHECKPOINT_CACHE.get(p);
  if (cached?.key === key) return cached.value;

  let value = null;
  try { value = JSON.parse(readFileSync(p, "utf8")); } catch {
    // Ignore corrupt partial writes; checkpoint.lookup behaves the same way.
  }
  CHECKPOINT_CACHE.set(p, { key, value });
  return value;
}

function readCheckpoints(orchDir) {
  const d = join(orchDir, "checkpoints");
  const prefix = `${d}${sep}`;
  if (!existsSync(d)) {
    for (const p of CHECKPOINT_CACHE.keys()) {
      if (p.startsWith(prefix)) CHECKPOINT_CACHE.delete(p);
    }
    return [];
  }
  const out = [];
  const seen = new Set();
  for (const f of readdirSync(d)) {
    if (!f.endsWith(".json")) continue;
    const p = join(d, f);
    seen.add(p);
    const ck = readCheckpoint(p);
    if (!ck?.branch) continue;
    out.push({
      sid: f.slice(0, -".json".length),
      branch: ck.branch,
      stage: STAGE_LABELS[ck.stage] || ck.stage || "unknown",
      round: ck.round ?? null,
      lastUpdate: ck.ts || null,
    });
  }
  for (const p of CHECKPOINT_CACHE.keys()) {
    if (p.startsWith(prefix) && !seen.has(p)) CHECKPOINT_CACHE.delete(p);
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
  if (!repo || !existsSync(repo) || !existsSync(join(repo, ".git"))) return orphaned;
  return orphaned.filter((c) => branchExists(repo, c.branch));
}

function readJsonl(p) {
  const stat = fileStat(p);
  if (!stat) {
    JSONL_CACHE.delete(p);
    return [];
  }
  const key = statKey(stat);
  const cached = JSONL_CACHE.get(p);
  if (cached?.key === key) return cached.value;

  const entries = readFileSync(p, "utf8").split("\n").filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
  JSONL_CACHE.set(p, { key, value: entries });
  return entries;
}

function reconcileHistory(entries, repo) {
  if (!repo || !existsSync(repo) || !existsSync(join(repo, ".git"))) return entries;
  return entries.map((e) =>
    RED_VERDICTS.has(e.verdict) && e.branch && !branchExists(repo, e.branch)
      ? { ...e, resolved: true }
      : e);
}

// Most recent entries first.
export function runHistory(orchDir, limit = 20, { repo = null, checkHistory = false, entries: suppliedEntries = null } = {}) {
  const entries = suppliedEntries ?? readJsonl(join(orchDir, "runs.jsonl"));
  const history = entries.slice(-limit).reverse();
  return checkHistory ? reconcileHistory(history, repo) : history;
}

// Success-rate + usage totals over the full run-history file.
export function metrics(orchDir, { entries: suppliedEntries = null } = {}) {
  const entries = suppliedEntries ?? readJsonl(join(orchDir, "runs.jsonl"));
  // "merged" and "pr" are different terminal outcomes — a `pr` run opened a
  // GitHub PR (cfg.merge === "pr") but never actually landed a local merge, so
  // folding it into `merged` mislabels it. Count them separately; `successRate`
  // still treats both as a successful cycle (neither is an escalation).
  let merged = 0, prOpened = 0, tokens = 0, costUsd = 0, hasCost = false, unpricedRuns = 0;
  for (const e of entries) {
    if (e.verdict === "merged") merged++;
    else if (e.verdict === "pr") prOpened++;
    if (typeof e.tokens === "number") tokens += e.tokens;
    // A run with tokens but no numeric cost is UNPRICED, not free — count it so
    // the total cost can be labeled as partial instead of silently understated.
    if (typeof e.costUsd === "number") { costUsd += e.costUsd; hasCost = true; }
    else if (typeof e.tokens === "number" && e.tokens > 0) unpricedRuns++;
  }
  return {
    total: entries.length,
    merged,
    prOpened,
    successRate: entries.length ? (merged + prOpened) / entries.length : null,
    totalTokens: tokens,
    totalCostUsd: hasCost ? costUsd : null,
    unpricedRuns,
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
  const p = join(dir, file);
  const stat = fileStat(p);
  if (!stat) {
    LOG_CACHE.delete(p);
    return null;
  }
  const key = `${statKey(stat)}:${lines}`;
  const cached = LOG_CACHE.get(p);
  if (cached?.key === key) return { file, tail: cached.tail };

  const length = Math.min(LOG_TAIL_BYTES, stat.size);
  let content = "";
  if (length > 0) {
    const fd = openSync(p, "r");
    try {
      const buffer = Buffer.allocUnsafe(length);
      const bytesRead = readSync(fd, buffer, 0, length, stat.size - length);
      content = buffer.toString("utf8", 0, bytesRead);
    } finally {
      closeSync(fd);
    }
  }
  const result = { file, tail: content.split("\n").filter(Boolean).slice(-lines).join("\n") };
  LOG_CACHE.set(p, { key, tail: result.tail });
  return result;
}

export function snapshot(orchDir, { historyLimit = 10, repo = null, checkHistory = false } = {}) {
  const live = liveCycles(orchDir);
  const interrupted = interruptedCycles(orchDir, live, repo);
  const entries = readJsonl(join(orchDir, "runs.jsonl"));
  return {
    live: live.map((c) => ({ ...c, log: latestLog(orchDir, c.branch) })),
    interrupted,
    history: runHistory(orchDir, historyLimit, { repo, checkHistory, entries }),
    metrics: metrics(orchDir, { entries }),
  };
}

function pct(n) { return n == null ? "n/a" : `${Math.round(n * 100)}%`; }
function usd(n) { return n == null ? "n/a" : `$${n.toFixed(4)}`; }
function stageText(stage) { return `${STAGE_SYMBOL[stage] || ""} ${stage}`.trim(); }
function verdictText(verdict, color, colorCode) {
  return `${VERDICT_SYMBOL[verdict] || ""} ${paint(color, colorCode, verdict)}`.trim();
}

export function render(orchDir, opts = {}) {
  const { historyLimit, color = false, columns, repo = null, checkHistory = false } = opts;
  const { live, interrupted, history, metrics: m } = snapshot(orchDir, { historyLimit, repo, checkHistory });
  const lines = [];
  lines.push(`orch dashboard — ${orchDir}`);
  lines.push("");
  lines.push(`Live cycles (${live.length})`);
  if (!live.length) {
    lines.push("  (none)");
  } else {
    for (const c of live) {
      const round = c.round != null ? ` round ${c.round}` : "";
      lines.push(`  ${c.branch}  [${stageText(c.stage)}${round}]  sid=${c.sid}  pid=${c.pid}  since ${formatTimestamp(c.startedAt)}`);
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
      const when = c.lastUpdate ? `  last update ${formatTimestamp(c.lastUpdate)}` : "";
      lines.push(`  ${c.branch}  [${stageText(c.stage)}${round}]  sid=${c.sid}${when}`);
    }
  }
  lines.push("");
  lines.push(`Run history (last ${history.length})`);
  if (!history.length) {
    lines.push("  (none)");
  } else {
    const rows = history.map((e) => {
      // No costUsd on a metered run means the model had no price entry — say
      // "unpriced" so the operator sees the gap instead of assuming $0.
      const usage = e.tokens ? `${e.tokens}tok ${e.costUsd != null ? usd(e.costUsd) : "unpriced"}` : "";
      const colorCode = e.resolved ? C.muted : VERDICT_COLOR[e.verdict] || "";
      const verdict = verdictText(e.verdict, color, colorCode);
      const row = [formatTimestamp(e.ts), e.branch, verdict, `${e.rounds}rnd`, usage];
      if (checkHistory) row.push(e.resolved ? "resolved" : "");
      return row;
    });
    const headers = ["TIME", "BRANCH", "VERDICT", "ROUNDS", "COST"];
    if (checkHistory) headers.push("STATUS");
    lines.push(table(headers, rows, { color, columns }));
  }
  lines.push("");
  lines.push("Metrics");
  const prSuffix = m.prOpened ? `  PRs opened: ${m.prOpened}` : "";
  lines.push(`  runs: ${m.total}  merged: ${m.merged}${prSuffix}  success rate: ${pct(m.successRate)}`);
  lines.push(`  clean unattended cycles: ${m.cleanUnattendedCycles}`);
  const unpriced = m.unpricedRuns ? ` (+${m.unpricedRuns} unpriced run${m.unpricedRuns === 1 ? "" : "s"})` : "";
  lines.push(`  tokens: ${m.totalTokens}  cost: ${usd(m.totalCostUsd)}${unpriced}`);
  return lines.join("\n");
}
