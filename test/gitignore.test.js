import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const rootUrl = new URL("../", import.meta.url);
const gitignore = readFileSync(fileURLToPath(new URL(".gitignore", rootUrl)), "utf8");

test(".gitignore uses /scripts/* so !/scripts/… negations can re-include files", () => {
  // Bare `/scripts` excludes the directory entry; git never evaluates
  // `!/scripts/foo` for untracked files under it. `/scripts/*` matches
  // contents only, so exceptions take effect (gitignore(5)).
  const lines = gitignore.split("\n").map((l) => l.trim());
  assert.ok(
    lines.includes("/scripts/*"),
    "must ignore scripts contents via /scripts/*",
  );
  assert.ok(
    !lines.includes("/scripts"),
    "bare /scripts makes ! exceptions inert for untracked files",
  );
  assert.ok(
    lines.includes("!/scripts/lint-token-step.js"),
    "security lint script must stay trackable",
  );
});

test("negated scripts file is not ignored by git (live check-ignore)", () => {
  const dir = mkdtempSync(join(tmpdir(), "gitignore-scripts-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    // Same shape as the repo rule: contents ignore + per-file exception.
    writeFileSync(
      join(dir, ".gitignore"),
      "/scripts/*\n!/scripts/lint-token-step.js\n",
    );
    mkdirSync(join(dir, "scripts"));
    writeFileSync(join(dir, "scripts/lint-token-step.js"), "ok\n");
    writeFileSync(join(dir, "scripts/other.js"), "nope\n");

    // check-ignore exits 1 when the path is NOT ignored.
    let notIgnoredExit = 0;
    try {
      execFileSync("git", ["check-ignore", "-q", "scripts/lint-token-step.js"], {
        cwd: dir,
      });
    } catch (e) {
      notIgnoredExit = e.status ?? 1;
    }
    assert.equal(notIgnoredExit, 1, "negated file must not be ignored");

    // Non-exception stays ignored (exit 0).
    execFileSync("git", ["check-ignore", "-q", "scripts/other.js"], { cwd: dir });

    const dry = execFileSync("git", ["add", "-n", "scripts/lint-token-step.js"], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.match(dry, /lint-token-step\.js/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
