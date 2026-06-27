// Per-task resume record: lets `orch task` continue an authored-but-unmerged
// branch after a quota abort instead of re-authoring from scratch (issue #24).
// Keyed on the FULL task text (+ author) so slug collisions can't resume the
// wrong branch. Written before runCycle, cleared after it RETURNS — a throw
// (quota) skips the clear, so the record survives for the next run to resume.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const dir = (orchDir) => join(orchDir, "resume");
const key = (task, author) => createHash("sha1").update(`${author}\0${task}`).digest("hex");
const taskKey = (task) => createHash("sha1").update(task).digest("hex");
const file = (orchDir, task, author) => join(dir(orchDir), `${key(task, author)}.json`);

export function record(orchDir, task, author, { branch, sid }) {
  mkdirSync(dir(orchDir), { recursive: true });
  // author + taskHash let lookupForTask find this branch regardless of which agent
  // the rotation pool advanced to on the resuming run (#27).
  writeFileSync(file(orchDir, task, author),
    JSON.stringify({ branch, sid, author, taskHash: taskKey(task), ts: new Date().toISOString() }));
}

export function lookup(orchDir, task, author) {
  try { return JSON.parse(readFileSync(file(orchDir, task, author), "utf8")); }
  catch { return null; } // ENOENT / parse error → no record
}

// Every record for this task text, across authors — the per-author key can't be
// reversed from the filename, so we scan and match the stored taskHash. Lets the
// caller pin the author of a surviving branch when rotation has moved on (#27).
export function lookupForTask(orchDir, task) {
  const th = taskKey(task);
  let names;
  try { names = readdirSync(dir(orchDir)); }
  catch { return []; } // no resume dir yet → no records
  const out = [];
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    try {
      const r = JSON.parse(readFileSync(join(dir(orchDir), n), "utf8"));
      if (r.taskHash === th && r.author && r.branch) out.push(r);
    } catch { /* skip unreadable/partial record */ }
  }
  return out;
}

export function clear(orchDir, task, author) {
  rmSync(file(orchDir, task, author), { force: true });
}
