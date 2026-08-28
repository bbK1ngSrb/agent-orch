import { join } from "node:path";
import { writeFileAtomic } from "./atomic-file.js";
import { pidAlive } from "./pid.js";
import { readRecord, recordFile, removeRecord, scanDir, writeRecord } from "./sid-store.js";

const dir = (orchDir) => join(orchDir, "inflight");

// `closes` (the GitHub issue number an `orch issue` run will close on merge)
// is carried here too, not just in checkpoint.js: a run that dies before its
// first review round has no checkpoint yet, so `orch continue`'s inflight
// fallback is the only place left to recover it from (#125 review finding).
// `author`/`reviewers` (full role specs — agent/model/effort) are carried here
// too, for the same reason as `closes`: a run that dies before its first review
// round has no checkpoint yet, so `orch continue` needs this fallback to know
// which agents/models it should resume with instead of guessing from rotation.
// `excludedAgents` is carried for the same reason: a replacement cycle can die
// before its first checkpoint is written.
// `rotationStage` tells `continue` whether that replacement must re-enter the
// author stage or can resume directly at review.
export function register(orchDir, sid, { branch, pid, baseSha, closes = null, author = null, reviewers = null, workOrder = null, excludedAgents = [], rotationStage = null, detached = false, detachedLog = null, log = null, runId = null }) {
  writeRecord(dir(orchDir), sid, {
    sid, branch, pid, baseSha, closes, author, reviewers, workOrder, excludedAgents, rotationStage, paths: [],
    ...(detached ? { detached: true, detachedLog: detachedLog || log, runId: runId || sid } : {}),
  });
}

// Persist replacement roles before a rotated cycle starts. Missing or
// concurrently removed records remain a best-effort no-op, like setPaths().
export function setRoles(orchDir, sid, { author, reviewers, excludedAgents, rotationStage } = {}) {
  const d = dir(orchDir);
  try {
    const e = readRecord(d, sid);
    if (!e) return;
    if (author !== undefined) e.author = author;
    if (reviewers !== undefined) e.reviewers = reviewers;
    if (excludedAgents !== undefined) e.excludedAgents = excludedAgents;
    if (rotationStage !== undefined) e.rotationStage = rotationStage;
    writeFileAtomic(recordFile(d, sid), JSON.stringify(e));
  } catch {
    // A concurrent cleanup or transient write failure must not abort a cycle.
  }
}

export function setPaths(orchDir, sid, paths, baseSha) {
  const d = dir(orchDir);
  // Missing record (and, per sid-store's self-heal policy, a corrupt one) is a
  // silent no-op: in multi-process designs the file may vanish between calls.
  // The write must stay inside the same guard — the record (or its directory)
  // can also vanish between the read and the write, and a throw out of here
  // would abort a live runCycle (engine.js wraps it in try/finally, no catch).
  try {
    const e = readRecord(d, sid);
    if (!e) return;
    e.paths = paths;
    if (baseSha !== undefined) e.baseSha = baseSha;
    writeFileAtomic(recordFile(d, sid), JSON.stringify(e));
  } catch {
    // record vanished or became unwritable mid-call → no-op
  }
}

export function deregister(orchDir, sid) {
  removeRecord(dir(orchDir), sid);
}

// Raw read, ignoring pid liveness — `orch continue` needs the branch of a sid
// whose owning process is already dead (that's the whole point of resuming it).
export function lookup(orchDir, sid) {
  return readRecord(dir(orchDir), sid);
}

// Live entries; dead-owner files are deleted here (doubles as inflight reclaim).
export function listLive(orchDir) {
  const d = dir(orchDir);
  const out = [];
  for (const { key, record: e } of scanDir(d)) {
    if (Number.isInteger(e.pid) && pidAlive(e.pid)) out.push(e);
    else removeRecord(d, key); // dead owner → stale
  }
  return out;
}

export function countLive(orchDir) {
  return listLive(orchDir).length;
}

export function peerPaths(orchDir, sid) {
  return listLive(orchDir).filter((e) => e.sid !== sid).flatMap((e) => e.paths || []);
}
