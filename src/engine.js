// Pure state machine. All side-effecting collaborators arrive via `deps`,
// so tests stub them and dry-run is just another set of stubs.
export async function runCycle(opts, deps) {
  const { mode = "task", task, branch, authorName, reviewerName, cfg, orchDir, repo, worktree } = opts;
  const { adapters, git, gate, scope, notify } = deps;
  const author = adapters.get(authorName);
  const reviewer = adapters.get(reviewerName);

  // F5: task mode owns a fresh branch; review mode requires an existing one.
  notify.phase(`worktree ${branch} (${mode})`);
  if (mode === "review") git.attachExistingBranch(repo, worktree, branch);
  else git.createTaskBranch(repo, worktree, branch, "main");

  try {
    // F1: author step + scope gate only in task mode. Review never writes.
    if (mode === "task") {
      notify.phase(`${author.name} authoring`);
      await author.author(task, worktree);

      // Scope gate (optional).
      if (cfg.scope.maxLines > 0) {
        const n = scope.count(branch, worktree, cfg.scope.ignore);
        if (n > cfg.scope.maxLines) {
          return escalate(notify, orchDir, branch, 1,
            `scope: ${n} changed lines exceed cap ${cfg.scope.maxLines} — split the PR`);
        }
      }
    }

    // Review mode escalates on first DISAGREE; task mode revises up to the cap.
    const cap = mode === "review" ? 1 : cfg.reviseCap;

    // Resolve the test command once.
    const testCmd = cfg.test === "auto" ? gate.detect(worktree) : cfg.test;

    let round = 1;
    for (;;) {
      notify.phase(`${reviewer.name} auditing (round ${round})`);
      const verdict = await reviewer.audit(branch, worktree);
      notify.writeRound(orchDir, branch, round,
        `# Round ${round}\n\nVerdict: ${verdict.decision}\n\n${verdict.reason}\n`);

      if (verdict.decision === "AGREE") {
        if (!testCmd) {
          return escalate(notify, orchDir, branch, round,
            "no test gate detected — set `test:` in orch.yml or merge manually");
        }
        notify.phase(`running gate: ${testCmd}`);
        const { pass } = gate.run(testCmd, worktree);
        if (!pass) {
          return escalate(notify, orchDir, branch, round,
            "AGREE but tests are red — not merging");
        }
        const m = git.mergeIntoMain(repo, branch, cfg.merge);
        if (!m.ok) {
          return escalate(notify, orchDir, branch, round,
            `merge failed (${m.reason}) — rebase ${branch} onto main`);
        }
        notify.phase(`merged ${branch}`);
        return { status: "merged", reason: "agreed + green + merged", rounds: round };
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
        return { status: "escalated", reason: why, rounds: round };
      }

      notify.phase(`${author.name} revising (round ${round + 1})`);
      await author.author(`Revise per review findings:\n${verdict.reason}`, worktree);
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
