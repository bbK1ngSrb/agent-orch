// Per-cycle stage checkpoint: lets a resumed cycle (resume.js already re-attaches
// the branch) skip review rounds already audited instead of re-running them from
// round 1. Keyed on sid, which resume.js pins BEFORE runCycle starts, so a crash
// mid-review/mid-test leaves a checkpoint the next run's resumed sid will find.
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic-file.js";

const dir = (orchDir) => join(orchDir, "checkpoints");
const file = (orchDir, sid) => join(dir(orchDir), `${sid}.json`);

export function record(orchDir, sid, data) {
  // No sid → no resume path exists (the PR bridge calls runCycle without one).
  // Writing would leave a dangling `undefined.json` the dashboard reads as a
  // cycle that died mid-flight.
  if (!sid) return;
  mkdirSync(dir(orchDir), { recursive: true });
  writeFileAtomic(file(orchDir, sid), JSON.stringify({ ...data, ts: new Date().toISOString() }));
}

export function lookup(orchDir, sid) {
  try { return JSON.parse(readFileSync(file(orchDir, sid), "utf8")); }
  catch { return null; } // ENOENT / parse error → no checkpoint
}

export function clear(orchDir, sid) {
  rmSync(file(orchDir, sid), { force: true });
}
