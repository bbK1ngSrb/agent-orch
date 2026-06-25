import { mkdirSync, writeFileSync, rmSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Progress line to stderr (stdout stays reserved for the final result).
export function phase(msg) {
  process.stderr.write(`▶ ${msg}\n`);
}

// Persist one audit round's verdict under .orch/reviews/<branch>/.
export function writeRound(orchDir, branch, round, content) {
  const p = join(orchDir, "reviews", branch, `round-${round}.md`);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  return p;
}

// Render the human arbitration brief shown on a stalemate.
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
  appendFileSync(join(orchDir, "runs.jsonl"), JSON.stringify(entry) + "\n");
}

// Post-merge cleanup: per-branch review artifacts are throwaway once merged.
export function cleanupReviews(orchDir, branch) {
  rmSync(join(orchDir, "reviews", branch), { recursive: true, force: true });
}

// Write the escalation brief to DECISION.md and echo it to stderr for the human.
export function escalate(orchDir, branch, brief) {
  const p = join(orchDir, "reviews", branch, "DECISION.md");
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, brief);
  process.stderr.write(`\n${brief}\n`);
  return p;
}
