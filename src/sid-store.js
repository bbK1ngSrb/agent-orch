// Shared storage primitive for orch's sid-keyed JSON record stores
// (checkpoints/, resume/, inflight/, deferred/): one `<key>.json` per record,
// written atomically, plus read/remove/scan. Each store keeps only its
// field-shape logic on top of this.
//
// Corrupt-file policy: SELF-HEAL. A record that fails JSON.parse (half-written,
// hand-edited, …) is deleted and treated as absent. Rationale: a corrupt record
// is unreadable garbage either way — every store already tolerates the record
// being missing, and leaving it on disk forever is clutter that can never
// become valid again. This used to be per-store (inflight/deferred deleted,
// checkpoint/resume silently skipped); it is now deliberate and uniform.
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic-file.js";

// Sids have a known narrow shape (`<pid>-<n>`); allowlist rather than denylist
// separators, since a denylist has to get `\`, drive letters, and encoding
// right, and an allowlist doesn't. Reject anything else — a malformed key is
// a caller bug, not something to silently normalise.
const SAFE_KEY = /^[A-Za-z0-9_-]+$/;

export const recordFile = (dir, key) => {
  if (!SAFE_KEY.test(key)) throw new Error(`sid-store: unsafe key ${JSON.stringify(key)}`);
  return join(dir, `${key}.json`);
};

// A sid is always CLI-generated (`<pid>-<base36counter>`, see sid.js) — but
// `orch continue <sid>` accepts operator-typed input as this key unvalidated.
// `key` above goes straight into `join()`, so a sid containing "/" or ".."
// can walk the path outside `dir`. Shared here (was duplicated in
// deferred.js) so every store — not just deferred's — can reject one.
export function isSafeSid(sid) {
  return typeof sid === "string" && sid !== "" && !sid.includes("/") && !sid.includes("\0")
    && !sid.includes("..");
}

// Stamps `ts` unless the caller already carries one (deferred.record returns
// its payload, ts included, so it must match what lands on disk).
export function writeRecord(dir, key, data) {
  mkdirSync(dir, { recursive: true });
  writeFileAtomic(recordFile(dir, key), JSON.stringify({ ts: new Date().toISOString(), ...data }));
}

// Path-based read for callers that already hold a full path (dashboard's
// stat-cached checkpoint reader). Same corrupt-file policy as readRecord.
export function readRecordFile(path) {
  let raw;
  try { raw = readFileSync(path, "utf8"); }
  catch { return null; } // ENOENT / unreadable → no record
  try { return JSON.parse(raw); }
  catch {
    // Corrupt → self-heal (see header policy). Best-effort only: force:true
    // suppresses ENOENT but not EACCES/EPERM/EBUSY, and "no record" must not
    // become a throw because the cleanup itself failed.
    try { rmSync(path, { force: true }); } catch { /* best-effort */ }
    return null;
  }
}

export function readRecord(dir, key) {
  return readRecordFile(recordFile(dir, key));
}

export function removeRecord(dir, key) {
  rmSync(recordFile(dir, key), { force: true });
}

// All parseable records in dir as { key, record } pairs (key = filename sans
// ".json"). Corrupt files are deleted per the header policy; a missing dir
// scans as empty. Other readdir failures (EACCES, NFS hiccups, …) propagate:
// scanDir backs the inflight concurrency guard, where silently reporting an
// unreadable-but-existing dir as empty would let a colliding cycle start.
export function scanDir(dir) {
  let names;
  try { names = readdirSync(dir); }
  catch (e) {
    if (e.code === "ENOENT") return []; // missing dir is genuinely empty
    throw e;
  }
  const out = [];
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    const key = n.slice(0, -".json".length);
    let record;
    try { record = readRecord(dir, key); }
    catch { continue; } // filename isn't a key we'd ever generate → not ours, skip
    if (record) out.push({ key, record });
  }
  return out;
}
