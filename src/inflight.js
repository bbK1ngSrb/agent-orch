import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const dir = (orchDir) => join(orchDir, "inflight");
const file = (orchDir, sid) => join(dir(orchDir), `${sid}.json`);

export function register(orchDir, sid, { branch, pid, baseSha }) {
  mkdirSync(dir(orchDir), { recursive: true });
  writeFileSync(file(orchDir, sid), JSON.stringify({
    sid, branch, pid, baseSha, paths: [], ts: new Date().toISOString(),
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

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== "ESRCH"; }
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
