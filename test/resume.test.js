import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
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

test("lookupForTask finds records across authors for the same task (#27)", () => {
  const d = freshDir();
  resume.record(d, "do x", "claude", { branch: "pr/claude/do-x-1", sid: "1" });
  resume.record(d, "do x", "codex", { branch: "pr/codex/do-x-2", sid: "2" });
  resume.record(d, "do y", "claude", { branch: "pr/claude/do-y-3", sid: "3" });
  const recs = resume.lookupForTask(d, "do x");
  assert.deepEqual(
    recs.map((r) => `${r.author}:${r.branch}`).sort(),
    ["claude:pr/claude/do-x-1", "codex:pr/codex/do-x-2"], // both authors of "do x", not "do y"
  );
});

test("lookupForTask is empty for an unknown task or absent dir", () => {
  const d = freshDir();
  assert.deepEqual(resume.lookupForTask(d, "never recorded"), []); // dir doesn't exist yet
  resume.record(d, "do x", "claude", { branch: "b", sid: "s" });
  assert.deepEqual(resume.lookupForTask(d, "do z"), []); // recorded, but different task
});

test("key is full task text, not the slug (collision safety)", () => {
  const d = freshDir();
  // Two prompts that slugify identically but differ in full text must not collide.
  resume.record(d, "Fix the bug now", "claude", { branch: "a", sid: "1" });
  resume.record(d, "Fix the bug! NOW", "claude", { branch: "b", sid: "2" });
  assert.equal(resume.lookup(d, "Fix the bug now", "claude").branch, "a");
  assert.equal(resume.lookup(d, "Fix the bug! NOW", "claude").branch, "b");
});

test("scans self-heal a corrupt record (shared sid-store policy)", () => {
  const d = freshDir();
  resume.record(d, "do x", "claude", { branch: "b", sid: "s" });
  const p = join(d, "resume", "corrupt.json");
  writeFileSync(p, "{bad json");
  // lookupForTask skips the corrupt record but deletes it; the valid one stays.
  assert.deepEqual(resume.lookupForTask(d, "do x").map((r) => r.branch), ["b"]);
  assert.equal(existsSync(p), false, "corrupt file deleted, not left on disk");
  // clearForBranch likewise tolerates (and heals) a fresh corrupt file.
  writeFileSync(p, "{still bad");
  resume.clearForBranch(d, "b");
  assert.equal(existsSync(p), false);
  assert.equal(resume.lookup(d, "do x", "claude"), null, "matching branch cleared");
});
