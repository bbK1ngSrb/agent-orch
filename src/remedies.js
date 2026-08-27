import { existsSync } from "node:fs";
import * as lockDefault from "./lock.js";

function repairPrompt(failure, cycle, conflicts) {
  const reason = String(cycle?.reason || failure?.reason || "").trim();
  return [
    "Repair the current rebase conflict or failing test in this worktree.",
    `Failure class: ${failure?.class || "unknown"}`,
    `Conflicting paths:\n${(conflicts.length ? conflicts : ["(none reported by git)"]).map((p) => `- ${p}`).join("\n")}`,
    reason ? `Failure detail: ${reason}` : null,
    "No gate log is provided; run the relevant tests yourself in this worktree to inspect the actual failure.",
    "Fix only this rebase conflict and directly failing tests; do not widen scope.",
    "Resolve all conflicts, stage the repaired changes, and commit them.",
  ].filter(Boolean).join("\n");
}

function errorText(error) {
  return String(error?.message || error || "unknown error").trim();
}

function terminal(failure, reason, record, executed) {
  return {
    result: {
      state: "STOPPED_AT_CAP",
      outcome: "stopped-at-cap",
      exit: 2,
      failureClass: failure?.class,
      failure,
      reason: `rebase remedy ${executed ? "failed" : "could not proceed"}: ${reason}`,
    },
    record: executed
      ? record
      : { ...record, attempt: Math.max(0, (record.attempt || 0) - 1) },
  };
}

function branchHead(deps, repo, branch) {
  const result = deps.git?.gitTry?.(["rev-parse", "--verify", `refs/heads/${branch}`], repo);
  return result?.ok ? result.out.trim() : null;
}

export function createRebaseRemedy({ run, getRun, deps, runCycle }) {
  return (context) => rebaseRemedy({ ...context, run: getRun ? getRun() : run, deps, runCycle });
}

export async function rebaseRemedy({ failure, record, cycle, policy, run, deps, runCycle }) {
  const repo = run?.repo;
  const orchDir = run?.orchDir;
  const branch = run?.branch;
  const cfg = run?.cfg || {};
  const integrationBranch = cfg.integrationBranch || policy?.integrationBranch || "orch/integration";

  if (!repo || !orchDir || !branch) return terminal(failure, "branch context is missing", record, false);
  if (!branchHead(deps, repo, branch)) return terminal(failure, `branch ${branch} does not exist`, record, false);
  if (!integrationBranch || integrationBranch === branch) {
    return terminal(failure, `integration branch ${integrationBranch || "(missing)"} is not a rebase target`, record, false);
  }

  const lock = deps.lock || lockDefault;
  const mergeLock = lockDefault.LOCK_NAMES.MERGE;
  if (!(await lock.acquireBlocking(orchDir, mergeLock))) {
    return terminal(failure, "could not acquire merge.lock", record, false);
  }

  let integrationPath;
  try {
    integrationPath = deps.git.ensureIntegrationWorktree(repo, orchDir, integrationBranch, cfg.baseBranch || "main");
    const reconciled = deps.git.reconcileIntegrationToOrigin(integrationPath, integrationBranch);
    if (!reconciled?.ok) {
      return terminal(failure, reconciled.reason || `could not reconcile ${integrationBranch}`, record, false);
    }
  } catch (error) {
    return terminal(failure, `could not refresh ${integrationBranch}: ${errorText(error)}`, record, false);
  } finally {
    lock.releaseLock(orchDir, mergeLock);
  }
  if (!integrationPath || !existsSync(integrationPath)) {
    return terminal(failure, "integration worktree does not exist", record, false);
  }

  // Read the expected branch tip only after integration has been refreshed.
  const expectedSha = branchHead(deps, repo, branch);
  if (!expectedSha) return terminal(failure, `branch ${branch} disappeared before rebase`, record, false);

  const repairOnTestRed = failure?.class === "TEST_RED";
  const rebased = deps.git.rebaseBranchOnto(
    repo,
    orchDir,
    branch,
    integrationBranch,
    expectedSha,
    { keepWorktreeOnConflict: true, keepWorktreeOnSuccess: repairOnTestRed },
  );
  let repairPath = null;
  let conflictPaths = [];
  let continueRebase = false;
  let repairExpectedSha = expectedSha;
  if (!rebased?.ok) {
    if (!rebased?.conflict || !rebased.path) {
      return terminal(failure, rebased?.reason || "rebase did not run", record, !rebased?.precondition);
    }
    repairPath = rebased.path;
    conflictPaths = Array.isArray(rebased.conflicts) ? rebased.conflicts : [];
    continueRebase = true;
  } else if (repairOnTestRed) {
    if (!rebased.path) return terminal(failure, "rebase repair worktree is unavailable", record, true);
    repairPath = rebased.path;
    repairExpectedSha = rebased.sha;
  }

  if (repairPath) {
    const authorSpec = run.author || { agent: run.authorName };
    let author;
    try {
      author = deps.adapters.get(authorSpec.agent);
      if (typeof author?.author !== "function") throw new Error(`author adapter ${authorSpec.agent} is unavailable`);
      await author.author(
        repairPrompt(failure, cycle, conflictPaths),
        repairPath,
        {
          model: authorSpec.model,
          effort: authorSpec.effort,
          stageTimeoutMs: cfg.stageTimeout > 0 ? cfg.stageTimeout * 60_000 : 0,
          baseBranch: integrationBranch,
        },
      );
    } catch (error) {
      deps.git.abortRebase?.(repo, repairPath);
      return terminal(failure, `repair failed: ${errorText(error)}`, record, true);
    }

    const finished = deps.git.finishRebase?.(
      repo,
      branch,
      repairPath,
      repairExpectedSha,
      { continueRebase, conflictPaths },
    );
    if (!finished?.ok) {
      return terminal(failure, finished?.reason || "repaired rebase could not continue", record, true);
    }
  }

  if (typeof runCycle !== "function") return terminal(failure, "fresh cycle is unavailable", record, true);
  return { cycle: await runCycle(), record };
}

function roleSpec(value) {
  return typeof value === "string"
    ? { agent: value, model: null, effort: null }
    : { agent: value?.agent, model: value?.model || null, effort: value?.effort || null };
}

function agentName(value) {
  return typeof value === "string" ? value : value?.agent || value?.name;
}

function currentRoles(run) {
  const author = roleSpec(run?.author || { agent: run?.authorName });
  const reviewers = (run?.reviewers || run?.reviewerNames || [run?.reviewerName])
    .filter(Boolean)
    .map(roleSpec);
  return { author, reviewers };
}

function exclusionEntry(value, fallbackReason = "error") {
  const name = agentName(value);
  if (!name) return null;
  if (typeof value === "object" && value.name) {
    return { name, reason: value.reason || fallbackReason, at: value.at || new Date().toISOString() };
  }
  return { name, reason: fallbackReason, at: new Date().toISOString() };
}

function exclusionMap(values = []) {
  const entries = new Map();
  for (const value of values) {
    const entry = exclusionEntry(value);
    if (entry && !entries.has(entry.name)) entries.set(entry.name, entry);
  }
  return entries;
}

function rotateTerminal(failure, reason, record) {
  return {
    result: {
      state: "STOPPED_AT_CAP",
      outcome: "stopped-at-cap",
      exit: 2,
      failureClass: failure?.class,
      failure,
      reason: `rotate remedy could not proceed: ${reason}`,
    },
    record: { ...record, attempt: Math.max(0, (record.attempt || 0) - 1) },
  };
}

function selectionDetail({ excluded = [], blockedAuthors = [], agents = [] } = {}) {
  const details = [];
  if (excluded.length) details.push(`excluded ${[...new Set(excluded)].join(", ")}`);
  if (blockedAuthors.length) details.push(`author blocked by reviewer ${[...new Set(blockedAuthors)].join(", ")}`);
  if (agents.length < 2) details.push(`rotation pool has ${agents.length} agent${agents.length === 1 ? "" : "s"}`);
  return details.join("; ") || "no independent candidate remains in the rotation pool";
}

export function createRotateRemedy({ run, getRun, deps = {}, runCycle, selectRoles }) {
  return (context) => rotateRemedy({
    ...context,
    run: getRun ? getRun() : run,
    deps,
    runCycle,
    selectRoles,
  });
}

// Re-seat through the CLI's selector so task starts, resumes, and remedies all
// apply the same author/reviewer rules.
export async function rotateRemedy({ failure, record, cycle, run, deps = {}, runCycle, selectRoles }) {
  const currentRecord = record || {};
  if (!run || typeof runCycle !== "function") return rotateTerminal(failure, "run context is missing", currentRecord);

  const { author, reviewers } = currentRoles(run);
  const excluded = exclusionMap(currentRecord.excludedAgents);
  const reportedAgents = (failure?.failedAgents || cycle?.failedAgents || [])
    .map(agentName)
    .filter(Boolean);
  const failedRole = failure?.failedRole || cycle?.failedRole
    || (reportedAgents.includes(author.agent) || failure?.failedAgent === author.agent
      ? "author"
      : reportedAgents.some((agent) => reviewers.some((reviewer) => reviewer.agent === agent))
        || reviewers.some((reviewer) => reviewer.agent === failure?.failedAgent)
        || failure?.class === "REVIEW_STALEMATE" ? "reviewer" : null);
  const failedAgents = [...new Set(reportedAgents.length
    ? reportedAgents
    : (failure?.failedAgent ? [failure.failedAgent] : []))];
  if (!failedAgents.length && failedRole === "author" && author.agent) failedAgents.push(author.agent);
  if (!failedAgents.length && failedRole === "reviewer" && failure?.class !== "REVIEW_STALEMATE" && reviewers[0]?.agent)
    failedAgents.push(reviewers[0].agent);

  for (const value of failure?.failedAgents || cycle?.failedAgents || []) {
    const name = agentName(value);
    if (name) excluded.set(name, exclusionEntry(value, value?.quota ? "quota" : "error"));
  }
  for (const name of failedAgents) {
    if (!excluded.has(name)) excluded.set(name, exclusionEntry(name));
  }

  if (!failedRole || !author.agent) {
    return rotateTerminal(failure, "the failing seat is unknown", {
      ...currentRecord,
      excludedAgents: [...excluded.values()],
    });
  }

  // A stalemate has no agent-error metadata. It still vacates the current
  // reviewer for this selection, without permanently burning that agent.
  const selectionExcluded = new Set(excluded.keys());
  if (failure?.class === "REVIEW_STALEMATE" && !failedAgents.length && reviewers[0]?.agent)
    selectionExcluded.add(reviewers[0].agent);

  const rotateAuthor = failedRole === "author" || excluded.has(author.agent);
  const selector = selectRoles || deps.nextAuthor;
  if (typeof selector !== "function") return rotateTerminal(failure, "seat selector is unavailable", {
    ...currentRecord,
    excludedAgents: [...excluded.values()],
  });
  const blockedAuthors = rotateAuthor ? reviewers.map((reviewer) => reviewer.agent) : [];
  const selected = selector(run.cfg, run.orchDir, author.agent, true, {
    exclude: [...selectionExcluded],
    persist: false,
    forceRotate: rotateAuthor,
    reviewerCount: Math.max(1, reviewers.length),
    blockedAuthors,
  });
  const selectedAuthor = selected?.authors?.[0];
  const nextAuthor = selectedAuthor?.agent === author.agent ? author : selectedAuthor;
  const nextReviewers = (selected?.reviewers || [])
    .filter((reviewer) => reviewer.agent !== nextAuthor?.agent && !selectionExcluded.has(reviewer.agent));
  if (!nextAuthor) {
    return rotateTerminal(failure, `no diverse author candidate remains — ${selectionDetail({
      excluded: [...selectionExcluded], blockedAuthors, agents: run.cfg?.agents || [],
    })}`, {
      ...currentRecord,
      excludedAgents: [...excluded.values()],
    });
  }
  if (!nextReviewers.length) {
    return rotateTerminal(failure, `no diverse reviewer candidate remains — ${selectionDetail({
      excluded: [...selectionExcluded], blockedAuthors, agents: run.cfg?.agents || [],
    })}`, {
      ...currentRecord,
      excludedAgents: [...excluded.values()],
    });
  }

  const nextRecord = { ...currentRecord, excludedAgents: [...excluded.values()] };
  return {
    cycle: await runCycle({
      author: nextAuthor,
      reviewers: nextReviewers,
      authorName: nextAuthor.agent,
      reviewerName: nextReviewers[0].agent,
      reviewerNames: nextReviewers.map((reviewer) => reviewer.agent),
      excludedAgents: nextRecord.excludedAgents,
      reviewerOverride: true,
      freshAuthor: failedRole === "author",
    }),
    record: nextRecord,
  };
}
