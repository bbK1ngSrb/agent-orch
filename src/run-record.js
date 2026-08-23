// Durable run record (design docs/cli-v2-design.md §5): one JSON file per run
// in `.orch/run-records/<runId>.json`, written atomically. A "run" is a
// `--until` pursuit (one or more cycles); until the run-controller (P5) exists,
// a run is exactly the one cycle that creates it, keyed by that cycle's sid.
// Storage is the shared sid-keyed store (sid-store.js) — including its
// self-heal policy for corrupt records and its path-traversal-safe key check.
//
// Unlike checkpoints/inflight (cleared on every terminal return), a run
// record is never deleted by orch: `outcome` marks it terminal, and
// `orch continue` can revisit it later (resumeTerminal below).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic-file.js";
import { isSafeSid as safeSid, readRecord, recordFile, scanDir } from "./sid-store.js";

export const SCHEMA_VERSION = 1;

const dir = (orchDir) => join(orchDir, "run-records");

function save(orchDir, runId, record) {
  const d = dir(orchDir);
  mkdirSync(d, { recursive: true });
  writeFileAtomic(recordFile(d, runId), JSON.stringify(record));
  return record;
}

// `policy` is opaque here (design §4's RunPolicy, wired by the run-controller
// slice) — this store only persists whatever the caller passes.
export function create(orchDir, { runId, command, argv, policy = null }) {
  if (!safeSid(runId)) return null;
  const now = new Date().toISOString();
  return save(orchDir, runId, {
    schemaVersion: SCHEMA_VERSION,
    runId,
    createdAt: now,
    updatedAt: now,
    command,
    argv: argv || [],
    policy,
    state: "CYCLING",
    outcome: null,
    exit: null,
    attempt: 0,
    retries: {},
    headMovedRepins: 0,
    cycles: [],
    failures: [],
    remedies: [],
    excludedAgents: [],
    branch: null,
    pr: null,
    integration: null,
    readiness: null,
    merge: null,
    human: null,
    detached: null,
    interrupted: null,
    lastError: null,
  });
}

// Shallow merge + updatedAt, atomic. Returns null if no record exists yet.
export function update(orchDir, runId, patch) {
  if (!safeSid(runId)) return null;
  const existing = readRecord(dir(orchDir), runId);
  if (!existing) return null;
  return save(orchDir, runId, { ...existing, ...patch, updatedAt: new Date().toISOString() });
}

// Lookup by runId, or by any cycle sid recorded under a run (lineage —
// design §5.3: a run can outlive its first cycle once the controller exists).
export function lookup(orchDir, idOrSid) {
  if (!safeSid(idOrSid)) return null;
  const direct = readRecord(dir(orchDir), idOrSid);
  if (direct) return direct;
  for (const { record } of scanDir(dir(orchDir))) {
    if (record.cycles?.some((c) => c.sid === idOrSid)) return record;
  }
  return null;
}

// §5.3: resuming a terminal `stopped-at-cap`/`wait-timeout` run clears
// outcome/exit and grants a fresh attempt budget; retries/headMovedRepins
// reset because a continue is a fresh, human-initiated bounded episode.
// No-op (returns the record unchanged) for any other outcome.
export function resumeTerminal(orchDir, runId, { maxAttempts } = {}) {
  const existing = readRecord(dir(orchDir), runId);
  if (!existing) return null;
  if (existing.outcome !== "stopped-at-cap" && existing.outcome !== "wait-timeout") return existing;
  return update(orchDir, runId, {
    outcome: null,
    exit: null,
    retries: {},
    headMovedRepins: 0,
    policy: { ...(existing.policy || {}), maxAttempts },
  });
}
