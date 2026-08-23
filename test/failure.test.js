import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classify, fingerprint, chooseRemedy, raiseMaxAttempts,
  TRIGGERS, FAILURE_CLASSES, REMOTE_CLASSES, HUMAN_CLASSES, INTERNAL_CLASSES,
} from "../src/failure.js";

// design §6: every "Trigger (today)" row maps to its stated class.
const MAPPING_ROWS = [
  [TRIGGERS.SCOPE_CAP, "SCOPE_EXCEEDED"],
  [TRIGGERS.EMPTY_DIFF, "DIFF_EMPTY"],
  [TRIGGERS.NO_TEST_COMMAND, "TEST_MISSING"],
  [TRIGGERS.TEST_RED, "TEST_RED"],
  [TRIGGERS.UNREADABLE_BRANCH_HEAD, "DIFF_UNREADABLE"],
  [TRIGGERS.SECURITY_DIFF_UNREADABLE, "DIFF_UNREADABLE"],
  [TRIGGERS.SECURITY_SCAN_REJECTED, "SECURITY_FINDING"],
  [TRIGGERS.PROTECTED_PATH, "POLICY_PROTECTED_PATH"],
  [TRIGGERS.REVIEW_STALEMATE, "REVIEW_STALEMATE"],
  [TRIGGERS.LAND_HEAD_MOVED, "LAND_HEAD_MOVED"],
  [TRIGGERS.LAND_PR_OPEN_FAILED, "LAND_PR_OPEN_FAILED"],
  [TRIGGERS.LAND_LOCK, "LAND_LOCK"],
  [TRIGGERS.LAND_SYNC, "LAND_SYNC"],
  [TRIGGERS.LAND_OVERLAP, "LAND_OVERLAP"],
  [TRIGGERS.LAND_DIRTY_MERGE, "LAND_DIRTY_MERGE"],
  [TRIGGERS.LAND_INTEGRATION_TEST, "LAND_INTEGRATION_TEST"],
  [TRIGGERS.CONCURRENCY_CAP, "CONCURRENCY_CAP"],
];

test("classify(): 17 direct-mapping rows (design §6) plus the 2 agent-error rows below = 19", () => {
  assert.equal(MAPPING_ROWS.length, 17);
  for (const [trigger, cls] of MAPPING_ROWS) {
    assert.equal(classify(trigger), cls, `${trigger} -> ${cls}`);
  }
});

test("classify(): agent-error triggers split on the quota hint (2 more rows: reviewer + author)", () => {
  assert.equal(classify(TRIGGERS.REVIEWER_AGENT_ERROR), "AGENT_ERROR");
  assert.equal(classify(TRIGGERS.REVIEWER_AGENT_ERROR, { quota: true }), "AGENT_QUOTA");
  assert.equal(classify(TRIGGERS.AUTHOR_AGENT_ERROR), "AGENT_ERROR");
  assert.equal(classify(TRIGGERS.AUTHOR_AGENT_ERROR, { quota: true }), "AGENT_QUOTA");
});

test("classify(): unknown trigger throws instead of silently returning INTERNAL", () => {
  assert.throws(() => classify("not-a-real-trigger"), /unknown trigger/);
});

test("13 remote/human/internal classes are declared (design §6 closing paragraph)", () => {
  assert.equal(REMOTE_CLASSES.length, 10);
  assert.equal(HUMAN_CLASSES.length, 2);
  assert.equal(INTERNAL_CLASSES.length, 1);
  assert.equal(REMOTE_CLASSES.length + HUMAN_CLASSES.length + INTERNAL_CLASSES.length, 13);
  for (const cls of [...REMOTE_CLASSES, ...HUMAN_CLASSES, ...INTERNAL_CLASSES]) {
    assert.ok(FAILURE_CLASSES.includes(cls), `${cls} listed in FAILURE_CLASSES`);
  }
});

test("fingerprint(): identical class + summary -> identical hash", () => {
  const a = fingerprint("TEST_RED", "test/foo.test.js failing");
  const b = fingerprint("TEST_RED", "test/foo.test.js failing");
  assert.equal(a, b);
});

test("fingerprint(): equal across different trees with the same findings (SHA/timestamp/line noise stripped)", () => {
  const a = fingerprint("REVIEW_STALEMATE",
    "## rev\n\nDISAGREE: fix the race at engine.js:120 (commit 4b825dc642cb6eb9a060e54bf8d69288fbee4904, 2026-08-17T10:00:00Z)");
  const b = fingerprint("REVIEW_STALEMATE",
    "## rev\n\nDISAGREE: fix the race at engine.js:987 (commit 9daeafb9864cf43055ae93beb0afd6c243d1b5e, 2026-08-23T09:26:00Z)");
  assert.equal(a, b, "SHAs, timestamps and line numbers must not affect the fingerprint");
});

test("fingerprint(): different class -> different hash even for the same summary", () => {
  const a = fingerprint("TEST_RED", "same text");
  const b = fingerprint("LAND_DIRTY_MERGE", "same text");
  assert.notEqual(a, b);
});

test("fingerprint(): different summary content -> different hash", () => {
  const a = fingerprint("TEST_RED", "test A failing");
  const b = fingerprint("TEST_RED", "test B failing");
  assert.notEqual(a, b);
});

// --- chooseRemedy ---------------------------------------------------------

function failureFor(cls, summary = "x") {
  return { class: cls, fingerprint: fingerprint(cls, summary) };
}

test("chooseRemedy(): first cycle, no history -> first remedy in the row, in policy order", () => {
  const failure = failureFor("TEST_RED");
  const d = chooseRemedy(failure, { attempt: 0, retries: {}, failures: [] }, { maxAttempts: 3, remedies: ["rebase", "rotate", "reauthor", "ask"] });
  assert.deepEqual(d, { decision: "remedy", remedy: "rebase", consumesAttempt: true });
});

test("chooseRemedy(): policy.remedies filters and reorders candidates", () => {
  const failure = failureFor("TEST_RED");
  const d = chooseRemedy(failure, { attempt: 0, retries: {}, failures: [] }, { maxAttempts: 3, remedies: ["rotate", "ask"] });
  assert.equal(d.decision, "remedy");
  assert.equal(d.remedy, "rotate", "rebase is not in policy.remedies, so it is skipped");
});

test("chooseRemedy(): policy.remedies order overrides the row's hard-coded order", () => {
  const failure = failureFor("TEST_RED");
  const d = chooseRemedy(failure, { attempt: 0, retries: {}, failures: [] }, { maxAttempts: 3, remedies: ["rotate", "rebase", "reauthor", "ask"] });
  assert.equal(d.decision, "remedy");
  assert.equal(d.remedy, "rotate", "policy.remedies puts rotate before rebase, so rotate wins even though the row lists rebase first");
});

test("chooseRemedy(): unknown class throws", () => {
  assert.throws(() => chooseRemedy(failureFor("NOT_A_CLASS"), {}, {}), /unknown failure class/);
});

test("chooseRemedy(): free-retry cap — retried while under cap, next remedy once exhausted", () => {
  const failure = failureFor("LAND_HEAD_MOVED");
  const policy = { maxAttempts: 3, remedies: ["rebase", "ask"] };
  const underCap = chooseRemedy(failure, { attempt: 0, retries: { LAND_HEAD_MOVED: 0 }, failures: [] }, policy);
  assert.deepEqual(underCap, { decision: "free-retry", key: "LAND_HEAD_MOVED", cap: 1, remaining: 0, backoffSeconds: 30 });
  const exhausted = chooseRemedy(failure, { attempt: 0, retries: { LAND_HEAD_MOVED: 1 }, failures: [] }, policy);
  assert.deepEqual(exhausted, { decision: "remedy", remedy: "rebase", consumesAttempt: true });
});

test("chooseRemedy(): standing-PR classes share the 'repair-lock' free-retry counter (§10A)", () => {
  const policy = { maxAttempts: 3, remedies: ["ask"] };
  const record = { attempt: 0, retries: { "repair-lock": 2 }, failures: [] };
  const underCap = chooseRemedy(failureFor("REMOTE_BEHIND"), record, policy);
  assert.equal(underCap.decision, "free-retry");
  assert.equal(underCap.key, "repair-lock");
  assert.equal(underCap.remaining, 0);
  const exhaustedRecord = { attempt: 0, retries: { "repair-lock": 3 }, failures: [] };
  const exhausted = chooseRemedy(failureFor("REMOTE_CI_RED"), exhaustedRecord, policy);
  assert.deepEqual(exhausted, { decision: "remedy", remedy: "integration-repair", consumesAttempt: true },
    "once the wait cap is spent, the next remedy is integration repair itself — it counts as one attempt (§10A)");
});

test("chooseRemedy(): convergence — two consecutive equal fingerprints skip the remedy that produced the second", () => {
  const failure = failureFor("REVIEW_STALEMATE", "same defect");
  const policy = { maxAttempts: 5, remedies: ["rotate", "reauthor", "ask"] };
  const record = {
    attempt: 1, retries: {},
    failures: [{ fingerprint: failure.fingerprint, remedy: "rotate" }],
  };
  const d = chooseRemedy(failure, record, policy);
  assert.equal(d.decision, "remedy");
  assert.equal(d.remedy, "reauthor", "rotate produced the repeat, so it is skipped in favor of the next remedy");
});

test("chooseRemedy(): three consecutive equal fingerprints -> ask", () => {
  const failure = failureFor("TEST_RED", "same defect");
  const policy = { maxAttempts: 5, remedies: ["rebase", "rotate", "reauthor", "ask"] };
  const record = {
    attempt: 2, retries: {},
    failures: [
      { fingerprint: failure.fingerprint, remedy: "rebase" },
      { fingerprint: failure.fingerprint, remedy: "rotate" },
    ],
  };
  const d = chooseRemedy(failure, record, policy);
  assert.deepEqual(d, { decision: "ask" });
});

test("chooseRemedy(): convergence with no 'ask' offered falls back to the row's terminal outcome", () => {
  const failure = failureFor("REMOTE_AUTH", "same defect");
  const policy = { maxAttempts: 5, remedies: [] };
  const record = {
    attempt: 2, retries: { REMOTE_AUTH: 1 },
    failures: [
      { fingerprint: failure.fingerprint, remedy: null },
      { fingerprint: failure.fingerprint, remedy: null },
    ],
  };
  const d = chooseRemedy(failure, record, policy);
  assert.deepEqual(d, { decision: "terminal", outcome: "BLOCKED" });
});

test("chooseRemedy(): attempts exhausted -> ask if offered, else STOPPED_AT_CAP", () => {
  const withAsk = chooseRemedy(failureFor("DIFF_EMPTY"),
    { attempt: 3, retries: {}, failures: [] }, { maxAttempts: 3, remedies: ["reauthor", "rotate", "ask"] });
  assert.deepEqual(withAsk, { decision: "ask" });

  const withoutAsk = chooseRemedy(failureFor("DIFF_EMPTY"),
    { attempt: 3, retries: {}, failures: [] }, { maxAttempts: 3, remedies: ["reauthor", "rotate"] });
  assert.deepEqual(withoutAsk, { decision: "terminal", outcome: "STOPPED_AT_CAP" });
});

test("chooseRemedy(): classes with no remedy list resolve straight to their terminal outcome", () => {
  assert.deepEqual(
    chooseRemedy(failureFor("SECURITY_FINDING"), { attempt: 0, retries: {}, failures: [] }, { maxAttempts: 3 }),
    { decision: "terminal", outcome: "BLOCKED" },
  );
  assert.deepEqual(
    chooseRemedy(failureFor("HUMAN_TIMEOUT"), { attempt: 0, retries: {}, failures: [] }, { maxAttempts: 3 }),
    { decision: "terminal", outcome: "WAIT_TIMEOUT" },
  );
  assert.deepEqual(
    chooseRemedy(failureFor("INTERNAL"), { attempt: 0, retries: {}, failures: [] }, { maxAttempts: 3 }),
    { decision: "terminal", outcome: "ERROR" },
  );
});

test("chooseRemedy(): integration-repair is never filtered out by policy.remedies", () => {
  const d = chooseRemedy(failureFor("REMOTE_CI_RED"),
    { attempt: 0, retries: { "repair-lock": 3 }, failures: [] },
    { maxAttempts: 3, remedies: ["ask"] }); // integration-repair deliberately absent from policy
  assert.deepEqual(d, { decision: "remedy", remedy: "integration-repair", consumesAttempt: true });
});

test("chooseRemedy(): REMOTE_CI_TIMEOUT orders integration-repair first only when a check failed meanwhile", () => {
  const policy = { maxAttempts: 3, remedies: ["ask"] };
  const waited = chooseRemedy({ class: "REMOTE_CI_TIMEOUT", fingerprint: "f1" }, { attempt: 0, retries: {}, failures: [] }, policy);
  assert.equal(waited.remedy, "wait");
  const checkFailed = chooseRemedy(
    { class: "REMOTE_CI_TIMEOUT", fingerprint: "f2", meta: { checkFailedMeanwhile: true } },
    { attempt: 0, retries: {}, failures: [] }, policy,
  );
  assert.equal(checkFailed.remedy, "integration-repair");
});

// --- raiseMaxAttempts (retry n ceilings) ----------------------------------

test("raiseMaxAttempts(): default request is 1", () => {
  const r = raiseMaxAttempts({ maxAttempts: 3, baseMaxAttempts: 3, grantedExtra: 0 });
  assert.deepEqual(r, { maxAttempts: 4, grantedExtra: 1, granted: 1 });
});

test("raiseMaxAttempts(): a single reply is capped at 3", () => {
  const r = raiseMaxAttempts({ maxAttempts: 3, baseMaxAttempts: 3, grantedExtra: 0 }, 10);
  assert.equal(r.granted, 3);
  assert.equal(r.maxAttempts, 6);
});

test("raiseMaxAttempts(): total extra per run is capped at 2 * baseMaxAttempts", () => {
  const baseMaxAttempts = 2; // ceiling = 4 extra total
  const first = raiseMaxAttempts({ maxAttempts: baseMaxAttempts, baseMaxAttempts, grantedExtra: 0 }, 3);
  assert.equal(first.grantedExtra, 3);
  const next = raiseMaxAttempts({ maxAttempts: first.maxAttempts, baseMaxAttempts, grantedExtra: first.grantedExtra }, 3);
  assert.equal(next.granted, 1, "only 1 of the room remains under the 2x-base ceiling");
  assert.equal(next.grantedExtra, 4);
  const exhausted = raiseMaxAttempts({ maxAttempts: next.maxAttempts, baseMaxAttempts, grantedExtra: next.grantedExtra }, 1);
  assert.equal(exhausted.granted, 0, "ceiling fully consumed — no further extra attempts granted");
  assert.equal(exhausted.maxAttempts, next.maxAttempts);
});
