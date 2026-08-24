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

export function createRebaseRemedy({ run, deps, runCycle }) {
  return (context) => rebaseRemedy({ ...context, run, deps, runCycle });
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
