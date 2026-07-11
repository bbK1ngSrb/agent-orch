import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pidAlive } from "./pid.js";

const dir = (orchDir) => join(orchDir, "inflight");
const file = (orchDir, sid) => join(dir(orchDir), `${sid}.json`);

// `closes` (the GitHub issue number an `orch issue` run will close on merge)
// is carried here too, not just in checkpoint.js: a run that dies before its
// first review round has no checkpoint yet, so `orch continue`'s inflight
// fallback is the only place left to recover it from (#125 review finding).
// `author`/`reviewers` (full role specs — agent/model/effort) are carried here
// too, for the same reason as `closes`: a run that dies before its first review
// round has no checkpoint yet, so `orch continue` needs this fallback to know
// which agents/models it should resume with instead of guessing from rotation.
export function register(orchDir, sid, { branch, pid, baseSha, closes = null, author = null, reviewers = null }) {
  mkdirSync(dir(orchDir), { recursive: true });
  writeFileSync(file(orchDir, sid), JSON.stringify({
    sid, branch, pid, baseSha, closes, author, reviewers, paths: [], ts: new Date().toISOString(),
  }));
}

export function setPaths(orchDir, sid, paths, baseSha) {
  const p = file(orchDir, sid);
  try {
    const e = JSON.parse(readFileSync(p, "utf8"));
    e.paths = paths;
    if (baseSha !== undefined) e.baseSha = baseSha;
    writeFileSync(p, JSON.stringify(e));
  } catch (err) {
    // Treat missing file (ENOENT) and parse errors as silent no-op.
    // In multi-process designs, the file may be removed or corrupted between calls.
  }
}

export function deregister(orchDir, sid) {
  rmSync(file(orchDir, sid), { force: true });
}

// Raw read, ignoring pid liveness — `orch continue` needs the branch of a sid
// whose owning process is already dead (that's the whole point of resuming it).
export function lookup(orchDir, sid) {
  try { return JSON.parse(readFileSync(file(orchDir, sid), "utf8")); }
  catch { return null; } // ENOENT / parse error → no record
}

// Live entries; dead-owner files are deleted here (doubles as inflight reclaim).
export function listLive(orchDir) {
  const d = dir(orchDir);
  if (!existsSync(d)) return [];
  const out = [];
  for (const f of readdirSync(d)) {
    if (!f.endsWith(".json")) continue;
    const p = join(d, f);
    try {
      const e = JSON.parse(readFileSync(p, "utf8"));
      if (Number.isInteger(e.pid) && pidAlive(e.pid)) out.push(e);
      else rmSync(p, { force: true });
    } catch {
      rmSync(p, { force: true }); // unreadable → stale
    }
  }
  return out;
}

export function countLive(orchDir) {
  return listLive(orchDir).length;
}

export function peerPaths(orchDir, sid) {
  return listLive(orchDir).filter((e) => e.sid !== sid).flatMap((e) => e.paths || []);
}
