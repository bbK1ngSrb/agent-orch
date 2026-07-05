import { isDocsOnly } from "./scope.js";
import { checkPaths } from "./intake/allowlist.js";

// Pure state machine. All side-effecting collaborators arrive via `deps`,
// so tests stub them and dry-run is just another set of stubs.
export async function runCycle(opts, deps) {
  const { mode = "task", task, branch, authorName, reviewerName, cfg, orchDir, repo, worktree, noMerge = false, sid, resume = false } = opts;
  const { adapters, git, gate, scope, notify, finalize, inflight, checkpoint } = deps;
  // Role specs carry optional model/effort. Fall back to bare names so callers
  // that pass only authorName/reviewerNames (e.g. the PR bridge) keep working.
  const authorSpec = opts.author || { agent: authorName };
  const author = adapters.get(authorSpec.agent);
  // #56: per-stage watchdog. cfg.stageTimeout is in minutes (0 = off); pass it to
  // every stage in ms so a stalled author/reviewer is killed instead of hanging.
  const stageTimeoutMs = cfg?.stageTimeout > 0 ? cfg.stageTimeout * 60_000 : 0;
  const authorOpts = { model: authorSpec.model, effort: authorSpec.effort, stageTimeoutMs };
  const reviewerSpecs = opts.reviewers || (opts.reviewerNames || [reviewerName]).map((name) => ({ agent: name }));
  const reviewers = reviewerSpecs.map((s) => ({
    name: s.agent, adapter: adapters.get(s.agent), opts: { model: s.model, effort: s.effort, stageTimeoutMs },
  }));
  const runStats = [];
  const reviewOutcomes = [];
  const done = (result) => {
    const usage = totalUsage(runStats);
    const final = { ...result, runStats, usage, usageSummary: formatUsage(usage) };
    recordReviewOutcomes(deps.reviewLog, orchDir, reviewOutcomes, final);
    return final;
  };
  const recordTerminal = (result) => {
    const usage = totalUsage(runStats);
    notify.recordRun?.(orchDir, {
      ts: new Date().toISOString(), branch, verdict: result.status, reason: result.reason, rounds: result.rounds,
      ...(usage.tokens ? { tokens: usage.tokens } : {}),
      ...(usage.costUsd != null ? { costUsd: usage.costUsd } : {}),
    });
    return done(result);
  };
  const recordUsage = (role, agent, result, fallbackModel = null) => {
    const usage = result?.usage || {};
    const tokens = Number(usage.tokens) || 0;
    if (tokens <= 0) return;
    const entry = { role, agent, model: usage.model || fallbackModel || "default", tokens };
    if (usage.inputTokens) entry.inputTokens = usage.inputTokens;
    if (usage.outputTokens) entry.outputTokens = usage.outputTokens;
    if (usage.cachedTokens) entry.cachedTokens = usage.cachedTokens;
    if (typeof usage.costUsd === "number") entry.costUsd = usage.costUsd;
    runStats.push(entry);
  };

  // F5: task mode owns a fresh branch; review mode requires an existing one.
  // A resumed task (#24) re-attaches the quota-aborted branch — its authored
  // commits are already there, so we skip the initial author step below.
  notify.phase(`worktree ${branch} (${mode}${resume ? ", resume" : ""})`);
  if (mode === "review" || resume) git.attachExistingBranch(repo, worktree, branch);
  else git.createTaskBranch(repo, worktree, branch, "main", `${process.pid}\n${sid}`);

  const baseSha = git.git(["rev-parse", "main"], repo);

  try {
    // F1: author step + scope gate only in task mode. Review never writes.
    if (mode === "task") {
      // On resume the author's work is already committed on the branch — skip
      // re-authoring and go straight to audit. The scope gate below still runs,
      // so a too-big resumed diff is caught even if quota aborted before it ran.
      if (!resume) {
        notify.phase(`${author.name} authoring`);
        // §3b: for untrusted intake (work order), the author runs against a
        // fenced prompt; free-text tasks pass through unchanged.
        const authored = await author.author(opts.authorPrompt || task, worktree, authorOpts);
        recordUsage("author", author.name, authored, authorOpts.model);
      }

      // Scope gate (optional).
      if (cfg.scope.maxLines > 0) {
        const n = scope.count(branch, worktree, cfg.scope.ignore);
        if (n > cfg.scope.maxLines) {
          return recordTerminal(escalate(notify, orchDir, branch, 1,
            `scope: ${n} changed lines exceed cap ${cfg.scope.maxLines} — split the PR`));
        }
      }
    }

    // Publish changed paths for peer overlap checks (best-effort; finalize re-reads at land time).
    if (inflight) inflight.setPaths(orchDir, sid, git.changedFiles(repo, branch), baseSha);

    // Review mode escalates on first DISAGREE; task mode revises up to the cap.
    const cap = mode === "review" ? 1 : cfg.reviseCap;

    // Resolve the test command once.
    const testCmd = cfg.test === "auto" ? gate.detect(worktree) : cfg.test;

    // Crash recovery: on a resumed cycle, pick up the last checkpoint instead of
    // re-auditing rounds already decided. `stage: "tested"` means AGREE + gate
    // already passed — skip straight past both; `stage: "reviewed"` means the
    // round's verdict is known — skip that round's audit call only.
    let round = 1;
    let pendingVerdict = null;
    let skipTest = false;
    if (resume) {
      const ck = checkpoint?.lookup(orchDir, sid);
      if (ck && ck.branch === branch) {
        round = ck.round;
        if (ck.stage === "tested") {
          pendingVerdict = { decision: "AGREE", reason: ck.reason || "" };
          skipTest = true;
        } else if (ck.stage === "reviewed") {
          pendingVerdict = { decision: ck.decision, reason: ck.reason || "" };
        }
      }
    }

    for (;;) {
      let verdict;
      if (pendingVerdict) {
        verdict = pendingVerdict;
        pendingVerdict = null;
      } else {
        notify.phase(`${reviewers.map((r) => r.name).join(", ")} auditing (round ${round})`);
        const verdicts = await Promise.all(reviewers.map(async (reviewer) => ({
          reviewer: reviewer.name,
          model: reviewer.opts.model,
          ...(await reviewer.adapter.audit(branch, worktree, reviewer.opts)),
        })));
        for (const v of verdicts) recordUsage("reviewer", v.reviewer, v, v.model);
        const disagree = verdicts.filter((v) => v.decision !== "AGREE");
        reviewOutcomes.push(...verdicts.map((v) => ({
          branch,
          round,
          reviewer: v.reviewer,
          model: v.model || null,
          decision: v.decision === "AGREE" ? "AGREE" : "DISAGREE",
          agentError: Boolean(v.agentError),
        })));
        verdict = {
          decision: disagree.length ? "DISAGREE" : "AGREE",
          reason: verdicts.map((v) => `## ${v.reviewer}\n\n${v.decision}: ${v.reason}`).join("\n\n"),
        };
        notify.writeRound(orchDir, branch, round,
          `# Round ${round}\n\nVerdict: ${verdict.decision}\n\nCost: ${formatUsage(totalUsage(runStats))}\n\n${verdict.reason}\n`);
        checkpoint?.record(orchDir, sid, { branch, round, stage: "reviewed", decision: verdict.decision, reason: verdict.reason });

        // #33: a crashed/nonzero reviewer (agentError) is not a code defect, so
        // revising the author would burn the whole loop for nothing. Escalate
        // immediately — the reason carries the #31 stderr tail (bad model id, etc).
        const agentErrors = disagree.filter((v) => v.agentError);
        if (agentErrors.length) {
          const reason = `agent error: ${agentErrors.map((v) => `${v.reviewer} ${v.reason}`).join("; ")}`;
          return recordTerminal(escalate(notify, orchDir, branch, round, reason));
        }
      }

      if (verdict.decision === "AGREE") {
        if (!testCmd) {
          return recordTerminal(escalate(notify, orchDir, branch, round,
            "no test gate detected — set `test:` in orch.yml or merge manually"));
        }
        let pass;
        if (skipTest) {
          pass = true;
          skipTest = false;
        } else {
          notify.phase(`running gate: ${testCmd}`);
          ({ pass } = gate.run(testCmd, worktree));
          if (pass) checkpoint?.record(orchDir, sid, { branch, round, stage: "tested", reason: verdict.reason });
        }
        if (!pass) {
          return recordTerminal(escalate(notify, orchDir, branch, round,
            "AGREE but tests are red — not merging"));
        }
        // PR-bridge audit: report the verdict, let GitHub own the merge. Reviews
        // are kept (not cleaned) so the caller can quote them in a PR comment.
        if (noMerge) {
          return recordTerminal({ status: "approved", reason: "agreed + green (no merge)", rounds: round });
        }
        // Compute the loop-guard signals BEFORE finalize: a ff merge makes
        // main...branch empty, so reading it post-merge always yields [].
        const changed = git.changedFiles(repo, branch);
        // §3c: protected-path floor at the MERGE boundary. Gating the FINAL diff
        // (not just round 1) covers the initial author, every revise, resume, and
        // an `orch review` merge — the same set CODEOWNERS guards at review time.
        // The agent can't be trusted to comply voluntarily, so the deterministic
        // gate, not the prompt, is what keeps guardrail files out of main.
        const prot = checkPaths(changed);
        if (!prot.ok) {
          return recordTerminal(escalate(notify, orchDir, branch, round,
            `protected paths touched: ${prot.violations.join(", ")} — orch will not merge guardrail files`));
        }
        const docsOnly = isDocsOnly(changed, cfg.docs.paths);
        const noop = changed.length === 0;
        const fin = await finalize({
          repo, orchDir, branch, sid, baseSha, paths: changed,
          testCmd, cfg, rounds: round, task, closes: opts.closes || null, runStats,
        }, deps);
        const label = fin.status === "merged" ? `merged ${branch}`
          : fin.status === "pr" ? `opened PR for ${branch}`
          : `demoted ${branch} (${fin.reason})`;
        notify.phase(label);
        return done({ status: fin.status, reason: fin.reason, rounds: round, docsOnly, noop });
      }

      // DISAGREE — review mode (cap=1) escalates here on round 1, never revising.
      if (round >= cap) {
        const brief = notify.buildDecisionBrief({
          branch,
          reviewerCase: verdict.reason,
          authorCase: mode === "review" ? "(review-only; no author)" : "see prior rounds",
          diffSummary: safeDiff(git, repo, branch),
          rounds: round,
        });
        notify.escalate(orchDir, branch, brief);
        const why = mode === "review" ? "review verdict: DISAGREE" : "stalemate after cap";
        return recordTerminal({ status: "escalated", reason: why, rounds: round });
      }

      notify.phase(`${author.name} revising (round ${round + 1})`);
      const revised = await author.author(`Revise per review findings:\n${verdict.reason}`, worktree, authorOpts);
      recordUsage("author", author.name, revised, authorOpts.model);
      round += 1;
    }
  } finally {
    git.pruneWorktree(repo, worktree);
  }
}

function escalate(notify, orchDir, branch, round, reason) {
  notify.escalate(orchDir, branch, `# Escalation — ${branch}\n\n${reason}\n`);
  return { status: "escalated", reason, rounds: round };
}

function safeDiff(git, repo, branch) {
  try { return git.git(["diff", "--stat", `main...${branch}`], repo); }
  catch { return "(diff unavailable)"; }
}

function totalUsage(runStats = []) {
  let tokens = 0;
  let costUsd = 0;
  let hasCost = false;
  for (const s of runStats) {
    tokens += Number(s.tokens) || 0;
    if (typeof s.costUsd === "number") { costUsd += s.costUsd; hasCost = true; }
  }
  return { tokens, costUsd: hasCost ? costUsd : null };
}

function formatInt(n) {
  return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatUsd(n) {
  const v = Number(n) || 0;
  return `$${v > 0 && v < 0.01 ? v.toFixed(4) : v.toFixed(2)}`;
}

function formatUsage(usage) {
  const cost = usage.costUsd != null ? `, ~${formatUsd(usage.costUsd)}` : "";
  return `${formatInt(usage.tokens)} tokens${cost}`;
}

function recordReviewOutcomes(reviewLog, orchDir, reviewOutcomes, result) {
  if (!reviewLog?.record || !reviewOutcomes.length) return;
  const ts = new Date().toISOString();
  const defectLaterSurfaced = !["merged", "approved", "pr"].includes(result.status)
    && !/^agent error:/.test(result.reason || "")
    && !/^no test gate detected/.test(result.reason || "");
  reviewLog.record(orchDir, reviewOutcomes.map((entry) => ({
    ts,
    ...entry,
    terminalStatus: result.status,
    terminalReason: result.reason,
    terminalRounds: result.rounds,
    defectLaterSurfaced,
  })));
}
