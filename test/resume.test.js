import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as resume from "../src/resume.js";

function freshDir() {
  return join(mkdtempSync(join(tmpdir(), "orch-resume-")), ".orch");
}

test("record then lookup round-trips branch + sid", () => {
  const d = freshDir();
  assert.equal(resume.lookup(d, "do x", "claude"), null); // absent first
  resume.record(d, "do x", "claude", { branch: "pr/claude/do-x-1-a", sid: "1-a" });
  assert.deepEqual(
    { branch: resume.lookup(d, "do x", "claude").branch, sid: resume.lookup(d, "do x", "claude").sid },
    { branch: "pr/claude/do-x-1-a", sid: "1-a" },
  );
});

test("lookup returns null for a different task or author", () => {
  const d = freshDir();
  resume.record(d, "do x", "claude", { branch: "b", sid: "s" });
  assert.equal(resume.lookup(d, "do y", "claude"), null); // different task text
  assert.equal(resume.lookup(d, "do x", "codex"), null);  // different author
});

test("clear removes the record", () => {
  const d = freshDir();
  resume.record(d, "do x", "claude", { branch: "b", sid: "s" });
  resume.clear(d, "do x", "claude");
  assert.equal(resume.lookup(d, "do x", "claude"), null);
  resume.clear(d, "do x", "claude"); // idempotent — no throw on missing
});

test("key is full task text, not the slug (collision safety)", () => {
  const d = freshDir();
  // Two prompts that slugify identically but differ in full text must not collide.
  resume.record(d, "Fix the bug now", "claude", { branch: "a", sid: "1" });
  resume.record(d, "Fix the bug! NOW", "claude", { branch: "b", sid: "2" });
  assert.equal(resume.lookup(d, "Fix the bug now", "claude").branch, "a");
  assert.equal(resume.lookup(d, "Fix the bug! NOW", "claude").branch, "b");
});
