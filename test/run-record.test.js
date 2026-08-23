import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, update, lookup, resumeTerminal, SCHEMA_VERSION } from "../src/run-record.js";
import { writeFileAtomic } from "../src/atomic-file.js";

function tmpOrchDir() {
  return mkdtempSync(join(tmpdir(), "orch-run-record-"));
}

test("create writes a record with the run-record schema", () => {
  const d = tmpOrchDir();
  const record = create(d, { runId: "100-0", command: "task", argv: ["task", "do x"] });
  assert.equal(record.schemaVersion, SCHEMA_VERSION);
  assert.equal(record.runId, "100-0");
  assert.equal(record.outcome, null);
  assert.equal(record.attempt, 0);
  const onDisk = JSON.parse(readFileSync(join(d, "run-records", "100-0.json"), "utf8"));
  assert.equal(onDisk.runId, "100-0");
});

test("update shallow-merges and bumps updatedAt", async () => {
  const d = tmpOrchDir();
  const created = create(d, { runId: "100-0", command: "task", argv: [] });
  await new Promise((r) => setTimeout(r, 2));
  const updated = update(d, "100-0", { outcome: "reached", exit: 0 });
  assert.equal(updated.outcome, "reached");
  assert.equal(updated.exit, 0);
  assert.equal(updated.command, "task"); // untouched fields survive the merge
  assert.notEqual(updated.updatedAt, created.createdAt);
});

test("update on a missing runId is a no-op returning null", () => {
  const d = tmpOrchDir();
  assert.equal(update(d, "missing", { outcome: "reached" }), null);
});

test("lookup resolves by runId directly", () => {
  const d = tmpOrchDir();
  create(d, { runId: "100-0", command: "task", argv: [] });
  assert.equal(lookup(d, "100-0").runId, "100-0");
  assert.equal(lookup(d, "no-such-run"), null);
});

test("lookup resolves by a cycle sid recorded under a run", () => {
  const d = tmpOrchDir();
  create(d, { runId: "100-0", command: "task", argv: [] });
  update(d, "100-0", { cycles: [{ sid: "100-1", attempt: 1, branch: "pr/claude/x-100-1" }] });
  const found = lookup(d, "100-1");
  assert.equal(found.runId, "100-0");
});

test("atomic write survives a simulated crash (original record untouched, no partial file left)", () => {
  const d = tmpOrchDir();
  create(d, { runId: "100-0", command: "task", argv: [] });
  const path = join(d, "run-records", "100-0.json");
  const before = readFileSync(path, "utf8");
  assert.doesNotThrow(() => JSON.parse(before));

  // Simulate a process crash between the temp write and the rename that
  // publishes it: the temp write "succeeds" but rename never completes.
  assert.throws(() => writeFileAtomic(path, JSON.stringify({ outcome: "corrupt" }), {
    writeFileSync: () => {},
    renameSync: () => { throw new Error("simulated crash mid-rename"); },
  }));

  const after = readFileSync(path, "utf8");
  assert.equal(after, before); // the published record is untouched, not half-written
  assert.doesNotThrow(() => JSON.parse(after));
});

test("resumeTerminal clears outcome/exit and grants a fresh attempt budget", () => {
  const d = tmpOrchDir();
  create(d, { runId: "100-0", command: "task", argv: [] });
  update(d, "100-0", { outcome: "stopped-at-cap", exit: 2, attempt: 3, retries: { conflict: 1 }, headMovedRepins: 2 });
  const resumed = resumeTerminal(d, "100-0", { maxAttempts: 3 + 5 });
  assert.equal(resumed.outcome, null);
  assert.equal(resumed.exit, null);
  assert.deepEqual(resumed.retries, {});
  assert.equal(resumed.headMovedRepins, 0);
  assert.equal(resumed.policy.maxAttempts, 8);
});

test("resumeTerminal is a no-op for a non-terminal-cap outcome", () => {
  const d = tmpOrchDir();
  create(d, { runId: "100-0", command: "task", argv: [] });
  update(d, "100-0", { outcome: "reached", exit: 0 });
  const result = resumeTerminal(d, "100-0", { maxAttempts: 99 });
  assert.equal(result.outcome, "reached");
});

test("create/update/lookup reject unsafe runId/sid", () => {
  const d = tmpOrchDir();
  assert.equal(create(d, { runId: "../escape", command: "task", argv: [] }), null);
  assert.equal(update(d, "../escape", { outcome: "reached" }), null);
  assert.equal(lookup(d, "../escape"), null);
});
