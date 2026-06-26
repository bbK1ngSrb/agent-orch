import { test } from "node:test";
import assert from "node:assert/strict";
import { lintWorkflow } from "../scripts/lint-token-step.js";

const safe = {
  jobs: {
    author: {
      permissions: { contents: "read" },
      steps: [{ run: "node bin/orch.js task ..." }, { run: "npm test" }],
    },
    open_pr: {
      permissions: { "pull-requests": "write", contents: "write" },
      steps: [{ uses: "actions/checkout@<sha>", with: { ref: "main" } },
              { run: "gh pr create --fill" }],
    },
  },
};

test("token job that runs no authored code → ok", () => {
  const r = lintWorkflow(safe);
  assert.equal(r.ok, true);
  assert.deepEqual(r.violations, []);
});

test("token job that also runs the test gate → violation", () => {
  const bad = JSON.parse(JSON.stringify(safe));
  bad.jobs.open_pr.steps.push({ run: "npm test" });
  const r = lintWorkflow(bad);
  assert.equal(r.ok, false);
  assert.ok(r.violations.some((v) => v.includes("open_pr")));
});

test("token job that runs the agent CLI → violation", () => {
  const bad = JSON.parse(JSON.stringify(safe));
  bad.jobs.open_pr.steps.push({ run: "node bin/orch.js task 'fix it'" });
  assert.equal(lintWorkflow(bad).ok, false);
});

test("token job that checks out a non-main ref → violation", () => {
  const bad = JSON.parse(JSON.stringify(safe));
  bad.jobs.open_pr.steps[0].with.ref = "refs/pull/7/head";
  assert.equal(lintWorkflow(bad).ok, false);
});

test("a job referencing secrets.GITHUB_TOKEN counts as token-bearing", () => {
  const bad = {
    jobs: {
      x: {
        permissions: { contents: "read" },
        steps: [{ run: "curl -H 'auth: ${{ secrets.GITHUB_TOKEN }}' ...; npm test" }],
      },
    },
  };
  assert.equal(lintWorkflow(bad).ok, false);
});

test("empty / job-less workflow → ok", () => {
  assert.equal(lintWorkflow({}).ok, true);
  assert.equal(lintWorkflow({ jobs: {} }).ok, true);
});
