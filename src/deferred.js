// Overlap-demoted peers waiting for a mechanical redrive after the blocker lands.
// Tier-1 self-progress (#350): when cycle A merges, every peer that demoted because
// it overlapped with A is rebased onto the new integration tip and re-gated — no
// LLM, no resolver. True line conflicts stay deferred for a human.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic-file.js";

// One automatic redrive after the initial overlap demote. A second failure
// (rebase conflict, dirty merge, or post-merge gate) leaves the peer for a human.
export const MAX_REDRIVE_ATTEMPTS = 1;

const dir = (orchDir) => join(orchDir, "deferred");
const file = (orchDir, sid) => join(dir(orchDir), `${sid}.json`);

function safeSid(sid) {
  return typeof sid === "string" && sid !== "" && !sid.includes("/") && !sid.includes("\0")
    && !sid.includes("..");
}

// Snapshot enough of the demoted cycle for a lock-held redrive in finalize.
// `redriveAttempts` counts finished auto-retries (0 = not yet retried).
export function record(orchDir, entry) {
  if (!safeSid(entry?.sid)) return;
  mkdirSync(dir(orchDir), { recursive: true });
  const prev = read(orchDir, entry.sid);
  const payload = {
    sid: entry.sid,
    branch: entry.branch,
    paths: Array.isArray(entry.paths) ? entry.paths : [],
    testCmd: entry.testCmd || "true",
    baseSha: entry.baseSha || null,
    rounds: entry.rounds || 1,
    closes: entry.closes ?? null,
    title: entry.title || entry.task || entry.branch || null,
    task: entry.task || null,
    peerSids: Array.isArray(entry.peerSids) ? entry.peerSids : [],
    redriveAttempts: prev?.redriveAttempts || 0,
    trigger: "overlap",
    ts: new Date().toISOString(),
  };
  writeFileAtomic(file(orchDir, entry.sid), JSON.stringify(payload));
  return payload;
}

export function read(orchDir, sid) {
  if (!safeSid(sid)) return null;
  try { return JSON.parse(readFileSync(file(orchDir, sid), "utf8")); }
  catch { return null; }
}

export function list(orchDir) {
  const d = dir(orchDir);
  if (!existsSync(d)) return [];
  const out = [];
  for (const f of readdirSync(d)) {
    if (!f.endsWith(".json")) continue;
    try {
      const e = JSON.parse(readFileSync(join(d, f), "utf8"));
      if (e && e.sid && e.branch) out.push(e);
      else rmSync(join(d, f), { force: true });
    } catch {
      rmSync(join(d, f), { force: true });
    }
  }
  return out;
}

export function remove(orchDir, sid) {
  if (!safeSid(sid)) return;
  rmSync(file(orchDir, sid), { force: true });
}

// Mark one finished redrive attempt. Returns the updated entry, or null if gone.
export function markAttempt(orchDir, sid) {
  const e = read(orchDir, sid);
  if (!e) return null;
  e.redriveAttempts = (e.redriveAttempts || 0) + 1;
  e.ts = new Date().toISOString();
  writeFileAtomic(file(orchDir, sid), JSON.stringify(e));
  return e;
}

export function eligibleForRedrive(entry, { maxAttempts = MAX_REDRIVE_ATTEMPTS } = {}) {
  return !!entry && (entry.redriveAttempts || 0) < maxAttempts;
}

// True when a deferred peer should be considered after `landed` finished merging:
// either it listed landed.sid as a blocking peer, or their path sets intersect
// (the common concurrent-edit case).
export function blockedByLand(entry, landed) {
  if (!entry || !landed) return false;
  if (entry.sid === landed.sid) return false;
  if ((entry.peerSids || []).includes(landed.sid)) return true;
  const mine = new Set(landed.paths || []);
  return (entry.paths || []).some((p) => mine.has(p));
}
