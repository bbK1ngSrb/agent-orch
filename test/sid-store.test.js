import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRecord, recordFile, removeRecord, scanDir, writeRecord } from "../src/sid-store.js";

const IS_WINDOWS = process.platform === "win32";

function freshDir() {
  return mkdtempSync(join(tmpdir(), "orch-sidstore-"));
}

test("writeRecord/readRecord round-trip with a stamped ts", () => {
  const d = freshDir();
  writeRecord(d, "k1", { branch: "b", round: 2 });
  const got = readRecord(d, "k1");
  assert.equal(got.branch, "b");
  assert.equal(got.round, 2);
  assert.ok(Number.isFinite(Date.parse(got.ts)), "ts is an ISO timestamp");
});

test("a caller-supplied ts wins over the stamp (deferred.record returns its payload)", () => {
  const d = freshDir();
  writeRecord(d, "k1", { ts: "2020-01-01T00:00:00.000Z", v: 1 });
  assert.equal(readRecord(d, "k1").ts, "2020-01-01T00:00:00.000Z");
});

test("readRecord returns null for a missing record or dir", () => {
  const d = freshDir();
  assert.equal(readRecord(d, "nope"), null);
  assert.equal(readRecord(join(d, "no-such-dir"), "nope"), null);
});

test("corrupt record self-heals: read returns null and deletes the file", () => {
  const d = freshDir();
  writeRecord(d, "good", { v: 1 });
  writeFileSync(recordFile(d, "bad"), "{bad json");
  assert.equal(readRecord(d, "bad"), null);
  assert.equal(existsSync(recordFile(d, "bad")), false, "corrupt file removed");
  assert.equal(readRecord(d, "good").v, 1, "good record untouched");
});

test("scanDir returns {key, record} pairs, heals corrupt files, ignores non-json", () => {
  const d = freshDir();
  writeRecord(d, "a", { v: 1 });
  writeRecord(d, "b", { v: 2 });
  writeFileSync(recordFile(d, "corrupt"), "{nope");
  writeFileSync(join(d, "notes.txt"), "not a record");
  const got = scanDir(d);
  assert.deepEqual(
    got.map(({ key, record }) => `${key}:${record.v}`).sort(),
    ["a:1", "b:2"],
  );
  assert.equal(existsSync(recordFile(d, "corrupt")), false, "corrupt file removed during scan");
});

test("scanDir on a missing dir is empty", () => {
  assert.deepEqual(scanDir(join(freshDir(), "absent")), []);
});

test("corrupt record in a read-only dir: read still returns null (self-heal rm is best-effort)",
  { skip: IS_WINDOWS && "chmod doesn't restrict directory writes on Windows" }, () => {
    const d = freshDir();
    writeFileSync(recordFile(d, "bad"), "{bad json");
    chmodSync(d, 0o555); // rmSync of the corrupt file will fail with EACCES
    try {
      assert.equal(readRecord(d, "bad"), null, "failed self-heal must not escape as a throw");
    } finally {
      chmodSync(d, 0o755); // restore so tmp cleanup works
    }
  });

test("scanDir on an existing but unreadable dir throws (only ENOENT scans as empty)",
  { skip: IS_WINDOWS && "chmod doesn't restrict directory reads on Windows" }, () => {
    const d = freshDir();
    writeRecord(d, "k1", { v: 1 });
    chmodSync(d, 0o000); // dir exists but cannot be read
    try {
      // Unreadable must NOT report "empty" — scanDir backs the inflight
      // concurrency guard, where a silent [] would admit a colliding cycle.
      assert.throws(() => scanDir(d), (e) => e.code !== "ENOENT");
    } finally {
      chmodSync(d, 0o755);
    }
  });

test("removeRecord deletes and is idempotent", () => {
  const d = freshDir();
  writeRecord(d, "k1", { v: 1 });
  removeRecord(d, "k1");
  assert.equal(readRecord(d, "k1"), null);
  removeRecord(d, "k1"); // no throw on missing
});

test("writeRecord creates the dir recursively", () => {
  const d = join(freshDir(), "nested", "store");
  writeRecord(d, "k1", { v: 1 });
  assert.equal(readRecord(d, "k1").v, 1);
});
