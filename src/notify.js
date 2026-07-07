import { mkdirSync, readFileSync, writeFileSync, rmSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { paint, C, colorEnabled } from "./tui/theme.js";

const PHASE_STATUS_COLOR = { ok: C.ok, fail: C.fail };

export function phase(label, detail = "", status = null, stream = process.stderr, color = colorEnabled(stream)) {
  const bulletColor = status ? PHASE_STATUS_COLOR[status] : C.title;
  const bullet = paint(color, bulletColor, "▸");
  const lbl = paint(color, C.label, label);
  const text = detail ? paint(color, status ? bulletColor : "", detail) : "";
  stream.write(`${bullet} ${lbl}${text ? `  ${text}` : ""}\n`);
}

// `branch` reaches us from --branch and from a PR's headRefName (attacker-shaped
// under public intake). It is interpolated straight into a path, so a name like
// `../../etc` would let writeRound/escalate write — and cleanupReviews rm -rf —
// outside .orch/reviews. Reject traversal/absolute names before any join.
export function reviewsDir(orchDir, branch) {
  if (typeof branch !== "string" || branch === "" || branch.includes("\0") ||
      branch.startsWith("/") || /(^|\/)\.\.(\/|$)/.test(branch)) {
    throw new Error(`unsafe branch name for review path: ${branch}`);
  }
  return join(orchDir, "reviews", branch);
}

export function writeRound(orchDir, branch, round, content) {
  const p = join(reviewsDir(orchDir, branch), `round-${round}.md`);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  return p;
}

export function writeRoundRaw(orchDir, branch, round, content) {
  const p = join(reviewsDir(orchDir, branch), `round-${round}-raw.md`);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  return p;
}

export function buildDecisionBrief({ branch, reviewerCase, authorCase, diffSummary, rounds }) {
  return [
    `# Decision needed — ${branch}`,
    ``,
    `Stalemate after ${rounds} rounds. You arbitrate: merge as-is / revise / abandon.`,
    ``,
    `## Reviewer's case`,
    reviewerCase || "(none)",
    ``,
    `## Author's case`,
    authorCase || "(none)",
    ``,
    `## Diff`,
    diffSummary || "(none)",
    ``,
  ].join("\n");
}

// Bounded run record: one JSON line per finished cycle. Outlives the wiped
// review folder so there is still a greppable trail (branch, verdict, sha, ts).
export function recordRun(orchDir, entry) {
  mkdirSync(orchDir, { recursive: true });
  updateKpi(orchDir, entry);
  appendFileSync(join(orchDir, "runs.jsonl"), JSON.stringify(entry) + "\n");
}

export function kpi(orchDir) {
  return readKpi(orchDir);
}

export function resetKpi(orchDir) {
  mkdirSync(orchDir, { recursive: true });
  const state = { cleanUnattendedCycles: 0 };
  writeFileSync(join(orchDir, "kpi.json"), `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

function readKpi(orchDir) {
  try {
    const state = JSON.parse(readFileSync(join(orchDir, "kpi.json"), "utf8"));
    return { cleanUnattendedCycles: Number(state.cleanUnattendedCycles) || 0 };
  } catch {
    return { cleanUnattendedCycles: 0 };
  }
}

function updateKpi(orchDir, entry) {
  const clean = (entry.verdict === "merged" || entry.verdict === "pr") &&
    !entry.recovery && !entry.manualGitRecovery;
  const next = clean
    ? { cleanUnattendedCycles: readKpi(orchDir).cleanUnattendedCycles + 1 }
    : { cleanUnattendedCycles: 0 };
  writeFileSync(join(orchDir, "kpi.json"), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

// Post-merge cleanup: per-branch review artifacts are throwaway once merged.
export function cleanupReviews(orchDir, branch) {
  rmSync(reviewsDir(orchDir, branch), { recursive: true, force: true });
}

export function escalate(orchDir, branch, brief) {
  mkdirSync(orchDir, { recursive: true });
  resetKpi(orchDir);
  const p = join(reviewsDir(orchDir, branch), "DECISION.md");
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, brief);
  process.stderr.write(`\n${brief}\n`);
  return p;
}
