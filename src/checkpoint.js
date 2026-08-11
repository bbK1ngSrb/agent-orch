// Per-cycle stage checkpoint: lets a resumed cycle (resume.js already re-attaches
// the branch) skip review rounds already audited instead of re-running them from
// round 1. Keyed on sid, which resume.js pins BEFORE runCycle starts, so a crash
// mid-review/mid-test leaves a checkpoint the next run's resumed sid will find.
// Storage is the shared sid-keyed store (sid-store.js) — including its
// self-heal policy for corrupt records.
import { join } from "node:path";
import { readRecord, removeRecord, writeRecord } from "./sid-store.js";

const dir = (orchDir) => join(orchDir, "checkpoints");

// `data.oid` (caller-supplied: the branch head commit at checkpoint time) pins the
// recorded verdict to the content it was earned on. A checkpoint without an `oid`
// — an older orch wrote it, or the OID could not be read — is NOT trusted for the
// resume shortcut; engine.js re-audits instead (#422).
export function record(orchDir, sid, data) {
  // No sid → no resume path exists (the PR bridge calls runCycle without one).
  // Writing would leave a dangling `undefined.json` the dashboard reads as a
  // cycle that died mid-flight.
  if (!sid) return;
  writeRecord(dir(orchDir), sid, data);
}

export function lookup(orchDir, sid) {
  return readRecord(dir(orchDir), sid);
}

export function clear(orchDir, sid) {
  removeRecord(dir(orchDir), sid);
}
