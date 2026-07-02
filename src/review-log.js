import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export const REVIEW_OUTCOMES_FILE = "review-outcomes.jsonl";

export function record(orchDir, entries) {
  const rows = entries.filter(Boolean);
  if (!rows.length) return;
  mkdirSync(orchDir, { recursive: true });
  appendFileSync(
    join(orchDir, REVIEW_OUTCOMES_FILE),
    rows.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
  );
}
