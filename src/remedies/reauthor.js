import { newSid } from "../sid.js";
import { buildAuthorPrompt } from "../intake/workorder.js";
import { slugify } from "../slug.js";

const MAX_FAILURE_FINGERPRINTS = 3;

function text(value) {
  return String(value || "").trim();
}

function roleSpec(value, fallback) {
  if (typeof value === "string") return { agent: value };
  return value?.agent ? value : { agent: fallback };
}

function workOrderFor(run) {
  const source = run?.workOrder;
  if (source && typeof source === "object") return { ...source };
  return {
    title: text(run?.task) || "reauthor change",
    problem: text(run?.authorPrompt) || text(run?.task) || "Resolve the reported defect.",
    repro_steps: [],
    suspected_paths: [],
    acceptance_criteria: [],
  };
}

export function failureHistory(record = {}, failure = {}) {
  const entries = [...(record.failures || [])];
  const current = {
    class: failure.class || "unknown",
    summary: text(failure.summary || failure.reason),
    fingerprint: failure.fingerprint || null,
  };
  const history = [...entries, current].slice(-MAX_FAILURE_FINGERPRINTS);
  return history.map((entry) => ({
    class: entry.class || "unknown",
    summary: text(entry.summary || entry.reason) || "(no detail)",
    fingerprint: entry.fingerprint || null,
  }));
}

export function rewriteWorkOrder(run, record, failure, addendum = "") {
  const workOrder = workOrderFor(run);
  const failures = failureHistory(record, failure);
  const history = failures.map((entry, index) => [
    `${index + 1}. class: ${entry.class}`,
    `   summary: ${entry.summary}`,
    entry.fingerprint ? `   fingerprint: ${entry.fingerprint}` : "   fingerprint: (none)",
  ].join("\n")).join("\n");
  const narrower = failure?.class === "SCOPE_EXCEEDED"
    ? "Implement the same work order with the smallest change that satisfies its acceptance criteria; do not refactor or split the work."
    : "Re-author the same work order from scratch; preserve its scope and do not add unrelated changes.";
  const addendumText = text(addendum);
  const problem = [
    workOrder.problem,
    addendumText ? `Human addendum:\n${addendumText}` : null,
    "What failed before:",
    history,
    narrower,
  ].filter(Boolean).join("\n\n");
  return { ...workOrder, problem };
}

export function buildReauthorPrompt(run, record, failure, addendum = "") {
  return buildAuthorPrompt(rewriteWorkOrder(run, record, failure, addendum));
}

function terminal(failure, reason, record) {
  return {
    result: {
      state: "STOPPED_AT_CAP",
      outcome: "stopped-at-cap",
      exit: 2,
      failureClass: failure?.class,
      failure,
      reason: `reauthor remedy could not proceed: ${reason}`,
    },
    record,
  };
}

function nextBranch(run, author, sid) {
  const agent = slugify(author?.agent || run?.authorName || "author");
  const task = slugify(run?.task || "reauthor");
  return `pr/${agent}/${task}-${sid}`;
}

export function createReauthorRemedy({ run, getRun, deps = {}, runCycle, createCycle } = {}) {
  return (context) => reauthorRemedy({
    ...context,
    run: getRun ? getRun() : run,
    deps,
    runCycle,
    createCycle,
  });
}

// Re-author is intentionally one cycle, not a child run. A normal re-author
// gets a fresh branch based by runCycle from the current base. A review
// addendum (or a human free-text reply) revises the current branch in place so
// the existing work is not silently discarded.
export async function reauthorRemedy({ failure, record = {}, policy, run, runCycle, createCycle, addendum = "", addendumAuthor = "human", addendumAt = null, revise = false }) {
  if (!run) return terminal(failure, "run context is missing", record);
  const author = roleSpec(run.author, run.authorName);
  if (!author.agent) return terminal(failure, "author is missing", record);
  const prompt = buildReauthorPrompt(run, record, failure, addendum);
  const workOrder = rewriteWorkOrder(run, record, failure, addendum);
  const inPlace = revise || failure?.class === "REMOTE_CHANGES_REQUESTED";
  const sid = inPlace ? run.sid : newSid();
  const branch = inPlace ? run.branch : nextBranch(run, author, sid);
  const currentPolicy = { ...(record.policy || policy || {}) };
  if (text(addendum)) {
    const source = currentPolicy.source && typeof currentPolicy.source === "object"
      ? currentPolicy.source
      : {};
    const attribution = `Human addendum (${text(addendumAuthor) || "human"}, ${addendumAt || new Date().toISOString()})`;
    currentPolicy.source = {
      ...source,
      text: [source.text, `${attribution}:\n${text(addendum)}`].filter(Boolean).join("\n\n"),
    };
  }
  const nextRecord = {
    ...record,
    branch,
    ...(inPlace ? {} : { reauthorizedFrom: run.branch }),
    policy: currentPolicy,
  };
  const cycleFactory = createCycle || runCycle;
  if (typeof cycleFactory !== "function") return terminal(failure, "fresh cycle is unavailable", nextRecord);
  try {
    const cycle = await cycleFactory({
      reauthor: true,
      revise: inPlace,
      freshAuthor: !inPlace,
      sid,
      branch,
      author,
      authorName: author.agent,
      authorPrompt: prompt,
      workOrder,
      reason: failure?.summary || failure?.reason || "reauthor after classified failure",
      resume: inPlace,
    });
    return { cycle, record: nextRecord };
  } catch (error) {
    return terminal(failure, text(error?.message || error) || "fresh cycle failed", nextRecord);
  }
}
