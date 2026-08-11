import { test } from "node:test";
import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../src/atomic-file.js";

test("writeFileAtomic preserves the original error if temp cleanup fails", () => {
  const original = new Error("rename failed");
  const cleanup = new Error("cleanup failed");
  let thrown;
  try {
    writeFileAtomic("/tmp/orch-state.json", "{\"ok\":true}", {
      tmpName: (target) => `${target}.tmp`,
      writeFileSync: () => {},
      renameSync: () => { throw original; },
      rmSync: () => { throw cleanup; },
    });
  } catch (err) {
    thrown = err;
  }

  assert.equal(thrown, original);
});

// Symlink-safety belongs on the primitive: rename replaces the path entry and
// does not open/follow a pre-existing symlink. Consumer modules used to re-test
// this thrice; one unit test owns the contract.
test("writeFileAtomic replaces a symlink at the path instead of writing through it", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-atomic-"));
  const target = join(d, "state.json");
  const linked = join(d, "linked.json");
  writeFileSync(linked, JSON.stringify({ branch: "linked" }));
  symlinkSync(linked, target);

  writeFileAtomic(target, JSON.stringify({ branch: "new" }));

  assert.equal(JSON.parse(readFileSync(linked, "utf8")).branch, "linked");
  assert.equal(lstatSync(target).isSymbolicLink(), false);
  assert.equal(JSON.parse(readFileSync(target, "utf8")).branch, "new");
  rmSync(d, { recursive: true, force: true });
});
