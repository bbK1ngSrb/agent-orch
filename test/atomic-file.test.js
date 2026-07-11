import { test } from "node:test";
import assert from "node:assert/strict";
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
