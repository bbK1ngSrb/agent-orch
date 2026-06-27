// Per-task resume record: lets `orch task` continue an authored-but-unmerged
// branch after a quota abort instead of re-authoring from scratch (issue #24).
// Keyed on the FULL task text (+ author) so slug collisions can't resume the
// wrong branch. Written before runCycle, cleared after it RETURNS — a throw
// (quota) skips the clear, so the record survives for the next run to resume.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const dir = (orchDir) => join(orchDir, "resume");
const key = (task, author) => createHash("sha1").update(`${author}\0${task}`).digest("hex");
const file = (orchDir, task, author) => join(dir(orchDir), `${key(task, author)}.json`);

export function record(orchDir, task, author, { branch, sid }) {
  mkdirSync(dir(orchDir), { recursive: true });
  writeFileSync(file(orchDir, task, author), JSON.stringify({ branch, sid, ts: new Date().toISOString() }));
}

export function lookup(orchDir, task, author) {
  try { return JSON.parse(readFileSync(file(orchDir, task, author), "utf8")); }
  catch { return null; } // ENOENT / parse error → no record
}

export function clear(orchDir, task, author) {
  rmSync(file(orchDir, task, author), { force: true });
}
