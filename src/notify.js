import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function phase(msg) {
  process.stderr.write(`▶ ${msg}\n`);
}

export function writeRound(orchDir, branch, round, content) {
  const p = join(orchDir, "reviews", branch, `round-${round}.md`);
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

export function escalate(orchDir, branch, brief) {
  const p = join(orchDir, "reviews", branch, "DECISION.md");
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, brief);
  process.stderr.write(`\n${brief}\n`);
  return p;
}
