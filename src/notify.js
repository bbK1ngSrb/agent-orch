import { mkdirSync, writeFileSync, rmSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function phase(msg) {
  process.stderr.write(`▶ ${msg}\n`);
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
  rmSync(reviewsDir(orchDir, branch), { recursive: true, force: true });
}

export function escalate(orchDir, branch, brief) {
  const p = join(reviewsDir(orchDir, branch), "DECISION.md");
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, brief);
  process.stderr.write(`\n${brief}\n`);
  return p;
}
