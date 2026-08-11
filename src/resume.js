// Per-task resume record: lets `orch task` continue an authored-but-unmerged
// branch after a quota abort instead of re-authoring from scratch (issue #24).
// Keyed on the FULL task text (+ author) so slug collisions can't resume the
// wrong branch. Written before runCycle, cleared after it RETURNS — a throw
// (quota) skips the clear, so the record survives for the next run to resume.
// Storage is the shared sid-keyed store (sid-store.js) — including its
// self-heal policy for corrupt records.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { readRecord, removeRecord, scanDir, writeRecord } from "./sid-store.js";

const dir = (orchDir) => join(orchDir, "resume");
const key = (task, author) => createHash("sha1").update(`${author}\0${task}`).digest("hex");
const taskKey = (task) => createHash("sha1").update(task).digest("hex");

export function record(orchDir, task, author, { branch, sid }) {
  // author + taskHash let lookupForTask find this branch regardless of which agent
  // the rotation pool advanced to on the resuming run (#27).
  writeRecord(dir(orchDir), key(task, author),
    { branch, sid, author, taskHash: taskKey(task) });
}

export function lookup(orchDir, task, author) {
  return readRecord(dir(orchDir), key(task, author));
}

// Every record for this task text, across authors — the per-author key can't be
// reversed from the filename, so we scan and match the stored taskHash. Lets the
// caller pin the author of a surviving branch when rotation has moved on (#27).
export function lookupForTask(orchDir, task) {
  const th = taskKey(task);
  return scanDir(dir(orchDir))
    .map(({ record }) => record)
    .filter((r) => r.taskHash === th && r.author && r.branch);
}

export function clear(orchDir, task, author) {
  removeRecord(dir(orchDir), key(task, author));
}

// `orch continue <sid>` resumes a branch without knowing the original task text
// that keyed its resume.js record (see resolveTaskBranch), so it can't call
// clear() by (task, author). Scan by branch instead — same directory-scan
// pattern as lookupForTask, filtering on r.branch rather than r.taskHash.
export function clearForBranch(orchDir, branch) {
  for (const { key: k, record: r } of scanDir(dir(orchDir))) {
    if (r.branch === branch) removeRecord(dir(orchDir), k);
  }
}
