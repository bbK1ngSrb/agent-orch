import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

// Guards the failure-path cleanup added for #340: version-bump.yml pushes a
// chore/bump-cc-* branch and opens a PR, then admin-merges. When that merge is
// denied (bot self-merge block) the step used to fail AFTER the push, orphaning
// the branch on the remote — a fresh one per push to main. The fix is an ERR
// trap that deletes the branch (and closes the PR) on any failure below the
// push. These string assertions lock that guard in place; they mirror the
// lint-token-step.test.js precedent of asserting over a workflow's run script.

const wf = parse(
  readFileSync(
    fileURLToPath(new URL("../.github/workflows/version-bump.yml", import.meta.url)),
    "utf8",
  ),
);

// The bump work lives in the single step whose run script pushes the branch.
const run = wf.jobs.bump.steps.map((s) => s.run || "").find((r) => r.includes("git push origin"));

test("bump step exists and pushes the chore/bump-cc branch", () => {
  assert.ok(run, "expected a bump step that pushes the branch");
  assert.match(run, /BRANCH="chore\/bump-cc-/);
  assert.match(run, /git push origin "\$BRANCH"/);
});

test("a failure trap is armed before the PR is created", () => {
  assert.match(run, /trap \w+ ERR/, "expected an ERR trap for failure-path cleanup");
  // Trap must be armed after the push but before pr create, or an early
  // failure still leaks the branch.
  const trapAt = run.indexOf("trap ");
  const createAt = run.indexOf("gh pr create");
  const pushAt = run.indexOf("git push origin");
  assert.ok(trapAt > pushAt && trapAt < createAt, "trap must sit between push and pr create");
});

test("the trap deletes the orphaned branch on failure", () => {
  // Either path deletes the remote branch; PR-close also removes it, with a
  // raw ref delete as the fallback when no PR was created yet.
  assert.ok(
    /gh pr close "\$BRANCH" --delete-branch/.test(run) ||
      /git push origin --delete "\$BRANCH"/.test(run),
    "trap must delete the branch (via pr close or ref delete)",
  );
  assert.match(run, /git push origin --delete "\$BRANCH"/, "expected a ref-delete fallback");
});
