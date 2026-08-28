// Structured failure classes (design docs/cli-v2-design.md §6-§7): turns the
// free-text escalate/demote reasons engine.js and finalize.js have always
// produced into a small closed set of classes, plus a fingerprint so "the
// same failure twice" is decidable. Pure functions only — no wiring into a
// remedy executor yet (rebase/rotate/reauthor/ask ship in P6/P7; the run
// controller that would call chooseRemedy ships in P5).
import { createHash } from "node:crypto";

// Trigger ids: one per row of design §6's mapping table. classify() turns a
// trigger into a class; several triggers collapse onto the same class (e.g.
// both DIFF_UNREADABLE rows), which is why this is keyed by trigger, not class.
export const TRIGGERS = {
  SCOPE_CAP: "scope-cap",
  EMPTY_DIFF: "empty-diff",
  REVIEWER_AGENT_ERROR: "reviewer-agent-error",
  NO_TEST_COMMAND: "no-test-command",
  TEST_RED: "test-red",
  UNREADABLE_BRANCH_HEAD: "unreadable-branch-head",
  SECURITY_DIFF_UNREADABLE: "security-diff-unreadable",
  SECURITY_SCAN_REJECTED: "security-scan-rejected",
  PROTECTED_PATH: "protected-path",
  REVIEW_STALEMATE: "review-stalemate",
  LAND_HEAD_MOVED: "land-head-moved",
  LAND_PR_OPEN_FAILED: "land-pr-open-failed",
  LAND_LOCK: "land-lock",
  LAND_SYNC: "land-sync",
  LAND_OVERLAP: "land-overlap",
  LAND_DIRTY_MERGE: "land-dirty-merge",
  LAND_INTEGRATION_TEST: "land-integration-test",
  AUTHOR_AGENT_ERROR: "author-agent-error",
  CONCURRENCY_CAP: "concurrency-cap",
};

const AGENT_ERROR_TRIGGERS = new Set([TRIGGERS.REVIEWER_AGENT_ERROR, TRIGGERS.AUTHOR_AGENT_ERROR]);

// design §6 table, "Trigger (today)" -> "Class".
const TRIGGER_CLASS = {
  [TRIGGERS.SCOPE_CAP]: "SCOPE_EXCEEDED",
  [TRIGGERS.EMPTY_DIFF]: "DIFF_EMPTY",
  [TRIGGERS.NO_TEST_COMMAND]: "TEST_MISSING",
  [TRIGGERS.TEST_RED]: "TEST_RED",
  [TRIGGERS.UNREADABLE_BRANCH_HEAD]: "DIFF_UNREADABLE",
  [TRIGGERS.SECURITY_DIFF_UNREADABLE]: "DIFF_UNREADABLE",
  [TRIGGERS.SECURITY_SCAN_REJECTED]: "SECURITY_FINDING",
  [TRIGGERS.PROTECTED_PATH]: "POLICY_PROTECTED_PATH",
  [TRIGGERS.REVIEW_STALEMATE]: "REVIEW_STALEMATE",
  [TRIGGERS.LAND_HEAD_MOVED]: "LAND_HEAD_MOVED",
  [TRIGGERS.LAND_PR_OPEN_FAILED]: "LAND_PR_OPEN_FAILED",
  [TRIGGERS.LAND_LOCK]: "LAND_LOCK",
  [TRIGGERS.LAND_SYNC]: "LAND_SYNC",
  [TRIGGERS.LAND_OVERLAP]: "LAND_OVERLAP",
  [TRIGGERS.LAND_DIRTY_MERGE]: "LAND_DIRTY_MERGE",
  [TRIGGERS.LAND_INTEGRATION_TEST]: "LAND_INTEGRATION_TEST",
  [TRIGGERS.CONCURRENCY_CAP]: "CONCURRENCY_CAP",
};

// Remote (readiness/merge, §9-§10), human and internal classes: not reachable
// through classify() yet (nothing in this slice produces them), but chooseRemedy
// and the acceptance table below must know about them so P5-P8 can wire a
// producer without touching this file's shape again.
export const REMOTE_CLASSES = [
  "REMOTE_CI_RED", "REMOTE_CI_TIMEOUT", "REMOTE_CONFLICTING", "REMOTE_BEHIND",
  "REMOTE_REVIEW_REQUIRED", "REMOTE_CHANGES_REQUESTED", "REMOTE_PR_CLOSED",
  "REMOTE_MERGE_REJECTED", "REMOTE_AUTH", "REMOTE_UNKNOWN",
];
export const HUMAN_CLASSES = ["HUMAN_ABANDON", "HUMAN_TIMEOUT"];
export const INTERNAL_CLASSES = ["INTERNAL"];

export const FAILURE_CLASSES = [
  ...new Set([...Object.values(TRIGGER_CLASS), "AGENT_ERROR", "AGENT_QUOTA",
    ...REMOTE_CLASSES, ...HUMAN_CLASSES, ...INTERNAL_CLASSES]),
];

// trigger -> class. `quota` distinguishes the one trigger family (agent-error)
// that maps to two different classes depending on whether the adapter's limit
// matcher fired (engine.js passes it from the adapter's `quota` flag).
export function classify(trigger, { quota = false } = {}) {
  if (AGENT_ERROR_TRIGGERS.has(trigger)) return quota ? "AGENT_QUOTA" : "AGENT_ERROR";
  const cls = TRIGGER_CLASS[trigger];
  if (!cls) throw new Error(`failure.classify: unknown trigger "${trigger}"`);
  return cls;
}

// Strip the parts of a summary that vary run-to-run for the SAME underlying
// failure (commit SHAs, timestamps, line numbers) so two attempts that failed
// identically fingerprint identically even though they ran on different trees.
export function normalizeSummary(summary) {
  return String(summary || "")
    .toLowerCase()
    .replace(/\b[0-9a-f]{7,40}\b/g, "<sha>")
    .replace(/\d{4}-\d{2}-\d{2}t[\d:.]+z?/g, "<timestamp>")
    .replace(/:\d+\b/g, ":<line>")
    .replace(/\s+/g, " ")
    .trim();
}

// fingerprint = sha256(class + normalizedSummary) — deliberately without the
// tree, base or config (design §7 review impl-M1): every remedy changes the
// tree, so a tree-bound fingerprint could never detect "two different
// attempts failed the same way".
export function fingerprint(cls, summary) {
  return createHash("sha256").update(`${cls}\n${normalizeSummary(summary)}`).digest("hex");
}

// design §7 remedy table. `remedies` is either a fixed ordered array or a
// `(failure) => array` for the one row (REMOTE_CI_TIMEOUT) whose order
// depends on extra context. `freeRetry.key` defaults to the class name;
// standing-PR classes share one counter (`repair-lock`, §10A).
const REMEDY_TABLE = {
  REVIEW_STALEMATE: { remedies: ["rotate", "reauthor", "ask"] },
  AGENT_ERROR: { remedies: ["rotate", "ask"] },
  AGENT_QUOTA: { remedies: ["rotate", "ask"] },
  TEST_RED: { remedies: ["rebase", "rotate", "reauthor", "ask"] },
  TEST_MISSING: { remedies: ["ask"] },
  DIFF_EMPTY: { remedies: ["reauthor", "rotate", "ask"] },
  DIFF_UNREADABLE: { freeRetry: { cap: 1, backoffSeconds: 30 }, remedies: ["rebase", "ask"] },
  LAND_HEAD_MOVED: { freeRetry: { cap: 1, backoffSeconds: 30 }, remedies: ["rebase", "ask"] },
  LAND_LOCK: { freeRetry: { cap: 1, backoffSeconds: 30 }, remedies: ["rebase", "ask"] },
  LAND_SYNC: { freeRetry: { cap: 1, backoffSeconds: 30 }, remedies: ["rebase", "ask"] },
  SCOPE_EXCEEDED: { remedies: ["reauthor", "ask"] },
  LAND_OVERLAP: { freeRetry: { cap: 1 }, remedies: ["rebase"] },
  LAND_DIRTY_MERGE: { remedies: ["rebase", "rotate", "ask"] },
  LAND_INTEGRATION_TEST: { remedies: ["rebase", "rotate", "ask"] },
  REMOTE_BEHIND: { freeRetry: { key: "repair-lock", cap: 3 }, remedies: ["integration-repair", "ask"] },
  REMOTE_CONFLICTING: { freeRetry: { key: "repair-lock", cap: 3 }, remedies: ["integration-repair", "ask"] },
  REMOTE_CI_RED: { freeRetry: { key: "repair-lock", cap: 3 }, remedies: ["integration-repair", "ask"] },
  REMOTE_CI_TIMEOUT: {
    remedies: (failure) => (failure?.meta?.checkFailedMeanwhile ? ["integration-repair", "ask"] : ["wait", "ask"]),
  },
  REMOTE_UNKNOWN: { freeRetry: { key: "reread", cap: 3, backoffSeconds: 10 }, remedies: ["ask"] },
  REMOTE_CHANGES_REQUESTED: { remedies: ["reauthor"] },
  REMOTE_REVIEW_REQUIRED: { remedies: ["ask"] },
  REMOTE_PR_CLOSED: { remedies: ["ask"] },
  LAND_PR_OPEN_FAILED: { freeRetry: { cap: 1 }, remedies: ["ask"] },
  REMOTE_AUTH: { freeRetry: { cap: 1, backoffSeconds: 30 }, remedies: [], terminal: "BLOCKED" },
  REMOTE_MERGE_REJECTED: { freeRetry: { cap: 1, backoffSeconds: 30 }, remedies: [], terminal: "BLOCKED" },
  HUMAN_TIMEOUT: { remedies: [], terminal: "WAIT_TIMEOUT" },
  SECURITY_FINDING: { remedies: [], terminal: "BLOCKED" },
  POLICY_PROTECTED_PATH: { remedies: [], terminal: "BLOCKED" },
  CONCURRENCY_CAP: { remedies: [], terminal: "BLOCKED" },
  HUMAN_ABANDON: { remedies: [], terminal: "BLOCKED" },
  INTERNAL: { remedies: [], terminal: "ERROR" },
};

function resolveRemedies(row, failure) {
  const list = typeof row.remedies === "function" ? row.remedies(failure) : row.remedies;
  return list || [];
}

function terminalDecision(row) {
  return { decision: "terminal", outcome: row.terminal || "STOPPED_AT_CAP" };
}

// Deterministic chooser (design §7): first applicable, honouring
// `policy.remedies` order and skipping disabled ones (`integration-repair` is
// never in `policy.remedies` and can never be disabled — it is `ready`'s only
// path to its goal).
//
// `failure` = { class, fingerprint, meta? }.
// `record`  = the durable run record (run-record.js §5.2): reads `.attempt`,
//             `.retries` (per-class/per-reason free-retry counters), `.policy`
//             and `.failures` (prior `{ fingerprint, remedy }` entries, most
//             recent last — used for convergence detection).
export function chooseRemedy(failure, record = {}, policy = {}) {
  const { class: cls, fingerprint: fp } = failure;
  const row = REMEDY_TABLE[cls];
  if (!row) throw new Error(`failure.chooseRemedy: unknown failure class "${cls}"`);

  const history = record.failures || [];
  // Consecutive equal-fingerprint streak ending at (and including) this failure.
  let streak = 1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].fingerprint === fp) streak += 1;
    else break;
  }

  // "integration-repair" and "wait" are not among the four operator-orderable
  // remedies (rebase/rotate/reauthor/ask, design glossary) — they can't be
  // disabled via policy.remedies.
  const policyRemedies = policy.remedies;
  const alwaysAllowed = new Set(["integration-repair", "wait"]);
  const rowRemedies = resolveRemedies(row, failure);
  // Order = priority (design §15): when the operator supplies `policy.remedies`,
  // its order wins over the row's hard-coded order for the four operator-orderable
  // remedies. `integration-repair`/`wait` are never operator-orderable (line 177
  // comment), so they keep their fixed row position instead of being reordered.
  let allowed = rowRemedies;
  if (policyRemedies) {
    const policyOrderable = rowRemedies.filter((r) => !alwaysAllowed.has(r));
    const orderedQueue = policyRemedies.filter((r) => policyOrderable.includes(r));
    let qi = 0;
    allowed = rowRemedies
      .map((r) => (alwaysAllowed.has(r) ? r : orderedQueue[qi++]))
      .filter((r) => r !== undefined);
  }

  const pendingAsk = Boolean(record.human?.askCommentId
    && !record.human.replies?.some((reply) => Number(reply.id) > Number(record.human.askCommentId)));

  // Convergence (design §7): two consecutive equal fingerprints skip the
  // remedy that produced the second; three equal fingerprints go to `ask` (or
  // the row's terminal outcome when `ask` isn't offered).
  if (streak >= 3) {
    return allowed.includes("ask") ? { decision: "ask" } : terminalDecision(row);
  }
  if (streak === 2) {
    const lastRemedy = history[history.length - 1]?.remedy;
    if (!(pendingAsk && allowed.includes("ask"))) allowed = allowed.filter((r) => r !== lastRemedy);
  }

  if (row.freeRetry) {
    const key = row.freeRetry.key || cls;
    const used = record.retries?.[key] || 0;
    if (used < row.freeRetry.cap) {
      return {
        decision: "free-retry", key, cap: row.freeRetry.cap, remaining: row.freeRetry.cap - used - 1,
        backoffSeconds: row.freeRetry.backoffSeconds || 0,
      };
    }
  }

  // An unanswered question is not a completed remedy. Resume must poll its
  // saved comment before convergence can choose another remedy, or a late
  // human reply can be lost. Free retries are checked first so they cannot
  // consume a reply while the saved question remains pending.
  if (pendingAsk && allowed.includes("ask")) return { decision: "ask" };

  if (!allowed.length) return terminalDecision(row);

  const candidate = allowed[0];
  if (candidate === "ask") return { decision: "ask" };

  // design §7 reads "attempt > maxAttempts"; first cycle = attempt 0 (glossary),
  // so ">=" here yields exactly maxAttempts remedy attempts before falling back
  // — the off-by-one is deliberate, not a typo.
  const attempt = record.attempt || 0;
  const maxAttempts = record.policy?.maxAttempts ?? policy.maxAttempts ?? Infinity;
  if (attempt >= maxAttempts) {
    return allowed.includes("ask") ? { decision: "ask" } : terminalDecision(row);
  }

  return { decision: "remedy", remedy: candidate, consumesAttempt: true };
}

// `orch: retry [n]` (design §7 attempt accounting): default 1, max 3 per
// reply, and at most `2 * baseMaxAttempts` extra per run in total. Pure —
// caller persists the returned `maxAttempts`/`grantedExtra` onto the record.
export function raiseMaxAttempts({ maxAttempts, baseMaxAttempts, grantedExtra = 0 }, requestedN = 1) {
  const n = Math.min(Math.max(1, Math.trunc(requestedN) || 1), 3);
  const ceiling = 2 * baseMaxAttempts;
  const room = Math.max(0, ceiling - grantedExtra);
  const granted = Math.min(n, room);
  return { maxAttempts: maxAttempts + granted, grantedExtra: grantedExtra + granted, granted };
}
