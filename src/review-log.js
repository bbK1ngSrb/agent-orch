import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export const REVIEW_OUTCOMES_FILE = "review-outcomes.jsonl";

// Per-reviewer `decision` values written to the log (not control-flow verdicts):
//   AGREE    — reviewer accepted the diff
//   DISAGREE — reviewer rejected the diff (editorial)
//   ERROR    — reviewer process crash/stall (agentError); not a code rejection
// Control flow still uses only AGREE/DISAGREE (+ agentError side-channel).

export function record(orchDir, entries) {
  const rows = entries.filter(Boolean);
  if (!rows.length) return;
  mkdirSync(orchDir, { recursive: true });
  appendFileSync(
    join(orchDir, REVIEW_OUTCOMES_FILE),
    rows.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
  );
}
