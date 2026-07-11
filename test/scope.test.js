import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseNumstat, isDocsOnly, count, globToRegExp } from "../src/scope.js";

const DOCS = ["*.md", "docs/**", "**/*.md"];

test("isDocsOnly: all docs paths -> true", () => {
  assert.equal(isDocsOnly(["README.md", "docs/x.md", "src/nested/y.md"], DOCS), true);
});

test("isDocsOnly: any non-docs path -> false", () => {
  assert.equal(isDocsOnly(["README.md", "src/a.js"], DOCS), false);
});

test("isDocsOnly: empty list -> false", () => {
  assert.equal(isDocsOnly([], DOCS), false);
});

const NUMSTAT = [
  "10\t5\tsrc/a.js",
  "3\t0\tpkg.lock",
  "-\t-\tbin/blob.png",   // binary -> skipped
  "2\t2\tdist/bundle.js",
].join("\n");

test("sums added+deleted, ignores binary", () => {
  assert.equal(parseNumstat(NUMSTAT, []), 10 + 5 + 3 + 0 + 2 + 2);
});

test("honors ignore globs including ** ", () => {
  assert.equal(parseNumstat(NUMSTAT, ["*.lock", "dist/**"]), 15);
});

test("globToRegExp: ? matches exactly one non-slash character", () => {
  const re = globToRegExp("src/?/file.js");
  assert.equal(re.test("src/a/file.js"), true);
  assert.equal(re.test("src//file.js"), false);
  assert.equal(re.test("src/ab/file.js"), false);
  assert.equal(re.test("src/a/b/file.js"), false);
});

test("parseNumstat ignore globs honor ? as one path character", () => {
  const numstat = [
    "1\t0\tsrc/a/generated.js",
    "2\t0\tsrc/ab/generated.js",
    "3\t0\tsrc//generated.js",
    "4\t0\tsrc/a/b/generated.js",
  ].join("\n");

  assert.equal(parseNumstat(numstat, ["src/?/generated.js"]), 2 + 3 + 4);
});

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

test("count() diffs against a custom base branch", () => {
  const repo = mkdtempSync(join(tmpdir(), "orch-scope-"));
  git(["init", "-b", "main"], repo);
  git(["config", "user.email", "t@t"], repo);
  git(["config", "user.name", "t"], repo);
  writeFileSync(join(repo, "a.txt"), "1\n");
  git(["add", "."], repo);
  git(["commit", "-m", "init"], repo);

  git(["checkout", "-b", "dev"], repo);
  writeFileSync(join(repo, "dev.txt"), "1\n");
  git(["add", "."], repo);
  git(["commit", "-m", "dev-only"], repo);

  git(["checkout", "-b", "feature"], repo);
  writeFileSync(join(repo, "b.txt"), "1\n2\n3\n");
  git(["add", "."], repo);
  git(["commit", "-m", "add b"], repo);

  assert.equal(count("feature", repo, [], "dev"), 3);
});
