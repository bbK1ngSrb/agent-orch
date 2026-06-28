import { isDocsOnly } from "./scope.js";
import { checkPaths } from "./intake/allowlist.js";

// Pure state machine. All side-effecting collaborators arrive via `deps`,
// so tests stub them and dry-run is just another set of stubs.
export async function runCycle(opts, deps) {
  const { mode = "task", task, branch, authorName, reviewerName, cfg, orchDir, repo, worktree, noMerge = false, sid, resume = false } = opts;
  const { adapters, git, gate, scope, notify, finalize, inflight } = deps;
  // Role specs carry optional model/effort. Fall back to bare names so callers
  // that pass only authorName/reviewerNames (e.g. the PR bridge) keep working.
  const authorSpec = opts.author || { agent: authorName };
  const author = adapters.get(authorSpec.agent);
  const authorOpts = { model: authorSpec.model, effort: authorSpec.effort };
  const reviewerSpecs = opts.reviewers || (opts.reviewerNames || [reviewerName]).map((name) => ({ agent: name }));
  const reviewers = reviewerSpecs.map((s) => ({
    name: s.agent, adapter: adapters.get(s.agent), opts: { model: s.model, effort: s.effort },
  }));
  const runStats = [];
  const done = (result) => ({ ...result, runStats });
  const recordUsage = (role, agent, result, fallbackModel = null) => {
    const usage = result?.usage || {};
    runStats.push({
      role,
      agent,
      model: usage.model || fallbackModel || "default",
      tokens: Number(usage.tokens) || 0,
    });
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
          return done(escalate(notify, orchDir, branch, 1,
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

    let round = 1;
    for (;;) {
      notify.phase(`${reviewers.map((r) => r.name).join(", ")} auditing (round ${round})`);
      const verdicts = await Promise.all(reviewers.map(async (reviewer) => ({
        reviewer: reviewer.name,
        model: reviewer.opts.model,
        ...(await reviewer.adapter.audit(branch, worktree, reviewer.opts)),
      })));
      for (const v of verdicts) recordUsage("reviewer", v.reviewer, v, v.model);
      const disagree = verdicts.filter((v) => v.decision !== "AGREE");
      const verdict = {
        decision: disagree.length ? "DISAGREE" : "AGREE",
        reason: verdicts.map((v) => `## ${v.reviewer}\n\n${v.decision}: ${v.reason}`).join("\n\n"),
      };
      notify.writeRound(orchDir, branch, round,
        `# Round ${round}\n\nVerdict: ${verdict.decision}\n\n${verdict.reason}\n`);

      if (verdict.decision === "AGREE") {
        if (!testCmd) {
          return done(escalate(notify, orchDir, branch, round,
            "no test gate detected — set `test:` in orch.yml or merge manually"));
        }
        notify.phase(`running gate: ${testCmd}`);
        const { pass } = gate.run(testCmd, worktree);
        if (!pass) {
          return done(escalate(notify, orchDir, branch, round,
            "AGREE but tests are red — not merging"));
        }
        // PR-bridge audit: report the verdict, let GitHub own the merge. Reviews
        // are kept (not cleaned) so the caller can quote them in a PR comment.
        if (noMerge) {
          return done({ status: "approved", reason: "agreed + green (no merge)", rounds: round });
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
          return done(escalate(notify, orchDir, branch, round,
            `protected paths touched: ${prot.violations.join(", ")} — orch will not merge guardrail files`));
        }
        const docsOnly = isDocsOnly(changed, cfg.docs.paths);
        const noop = changed.length === 0;
        const fin = await finalize({
          repo, orchDir, branch, sid, baseSha, paths: changed,
          testCmd, cfg, rounds: round,
        }, deps);
        notify.phase(fin.status === "merged" ? `merged ${branch}` : `demoted ${branch} (${fin.reason})`);
        return done({ status: fin.status, reason: fin.reason, rounds: round, docsOnly, noop });
      }

      // #33: a crashed/nonzero reviewer (agentError) is not a code defect, so
      // revising the author would burn the whole loop for nothing. Escalate
      // immediately — the reason carries the #31 stderr tail (bad model id, etc).
      const agentErrors = disagree.filter((v) => v.agentError);
      if (agentErrors.length) {
        const reason = `agent error: ${agentErrors.map((v) => `${v.reviewer} ${v.reason}`).join("; ")}`;
        return done(escalate(notify, orchDir, branch, round, reason));
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
        return done({ status: "escalated", reason: why, rounds: round });
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
