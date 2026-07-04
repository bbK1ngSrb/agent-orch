// The only globally-serialized step. Holds .orch/merge.lock while it syncs the
// integration worktree, runs the two conflict guards (file-overlap pre-check +
// post-merge re-test), and either lands the merge into the integration branch
// plus its PR bridge or demotes the branch to a PR / local escalation. The
// engine calls this via deps.finalize so it stays a pure state machine.

// Sums a cycle's per-role runStats into a single { tokens, costUsd } pair for
// run-history persistence. costUsd is null (omitted) unless at least one
// entry had a known price — never fabricate a total from partial data.
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

export async function finalize(ctx, deps) {
  const { repo, orchDir, branch, sid, paths, testCmd, cfg, rounds, closes, runStats } = ctx;
  const { git, gate, lock, inflight, github, notify } = deps;
  const usage = totalUsage(runStats);

  // cfg.merge === "pr": opt out of direct-to-main. No local merge, no merge.lock —
  // GitHub owns the merge (branch protection / CI-gated checks apply).
  if (cfg.merge === "pr") {
    const r = await github.openPr(ctx, deps);
    notify.recordRun(orchDir, {
      ts: new Date().toISOString(), branch, verdict: r.prUrl ? "pr" : "escalated", rounds,
      ...(usage.tokens ? { tokens: usage.tokens } : {}),
      ...(usage.costUsd != null ? { costUsd: usage.costUsd } : {}),
      ...(r.prUrl ? { prUrl: r.prUrl } : {}),
    });
    return r.prUrl
      ? { status: "pr", reason: `agreed + green → PR ${r.prUrl}`, prUrl: r.prUrl }
      : { status: "escalated", reason: "agreed + green → escalated locally (merge: pr needs a remote + gh CLI)" };
  }

  if (!lock.acquireBlocking(orchDir, "merge.lock")) {
    return demote(ctx, deps, "merge-lock timeout"); // never acquired → don't touch the worktree
  }
  try {
    // Catch local `main` up to origin BEFORE building from it: `orch task`/`orch issue`
    // only does this once, at the start of the whole invocation. If some other
    // checkout of this origin merged a PR since then, our local main is stale.
    // Local main must never be ahead here: orch lands on the integration branch
    // and lets GitHub advance main through the PR.
    const sync = git.syncMainFromOrigin(repo);
    if (!sync.ok) return demote(ctx, deps, `main diverged from origin: ${sync.reason}`);

    const integrationBranch = cfg.integrationBranch || "orch/integration";
    const integration = git.ensureIntegrationWorktree(repo, orchDir, integrationBranch);
    git.syncWorktreeToIntegration(integration, integrationBranch);

    // Guard 1: file-overlap with live in-flight peers only, read under the lock so it
    // is consistent. A peer hasn't landed yet, so Guard 2 can't see its changes and
    // last-writer-wins races remain possible — demote. Overlap with commits already
    // landed on integration is deliberately NOT pre-demoted: a textual conflict fails
    // the merge below, and a semantic conflict fails the Guard 2 re-test — a cleanly
    // mergeable green branch should land (#96).
    if (overlaps(paths, inflight.peerPaths(orchDir, sid))) return demote(ctx, deps, "overlap");

    const preSha = git.git(["rev-parse", "HEAD"], integration); // integration tip pre-merge
    // `orch issue <n>`: stamp `Closes #n` in the no-ff merge commit so the issue
    // auto-closes once GitHub merges the integration PR. ponytail: ff-only has no merge commit
    // to carry it, so it won't auto-close — default is no-ff; demote PR covers the
    // fallback. The number is our own int, not attacker text — safe to interpolate.
    const message = closes ? `Merge ${branch}\n\nCloses #${closes}` : null;
    const m = git.mergeInWorktree(integration, branch, cfg.merge, message);
    if (!m.ok) return demote(ctx, deps, "conflict");

    // Guard 2: re-run the test gate against integrated branch state.
    const { pass } = gate.run(testCmd, integration);
    if (!pass) {
      git.git(["reset", "--hard", preSha], integration); // roll integration back
      return demote(ctx, deps, "post-merge-test-fail");
    }

    // Patch-per-merge version bump + CHANGELOG entry, so a merged sha always
    // maps to a bumped `orch --version`. Best-effort: never blocks the merge.
    git.bumpVersion(integration, closes ? `${branch} (closes #${closes})` : branch);

    const sha = git.git(["rev-parse", "HEAD"], integration);
    const localIntegration = git.git(["rev-parse", integrationBranch], repo);
    if (localIntegration !== sha) {
      notify.resetKpi?.(orchDir);
      throw new Error(
        `orch: merge commit ${sha} was built in the integration worktree but ${integrationBranch} ` +
        `is still at ${localIntegration} — refusing to report a false "merged"`,
      );
    }
    let pr;
    try {
      pr = await github.openIntegrationPr(ctx, deps);
    } catch (e) {
      notify.escalate?.(orchDir, integrationBranch,
        `# Escalation — ${integrationBranch}\n\nThe local integration branch is green, but the PR bridge failed after the merge landed locally: ${e.message}\n`);
      pr = { prUrl: null };
    }
    const shortSha = git.git(["rev-parse", "--short", "HEAD"], integration);
    notify.recordRun(orchDir, {
      ts: new Date().toISOString(), branch, verdict: "merged", sha: shortSha, rounds,
      ...(pr.prUrl ? { prUrl: pr.prUrl } : {}),
      ...(usage.tokens ? { tokens: usage.tokens } : {}),
      ...(usage.costUsd != null ? { costUsd: usage.costUsd } : {}),
    });
    notify.cleanupReviews(orchDir, branch);
    return {
      status: "merged",
      reason: pr.prUrl
        ? `agreed + green + integrated → PR ${pr.prUrl}`
        : "agreed + green + integrated locally; PR bridge unavailable",
      sha: shortSha,
      prUrl: pr.prUrl,
    };
  } finally {
    lock.releaseLock(orchDir, "merge.lock");
  }
}

function overlaps(mine, others) {
  const set = new Set(others);
  return mine.some((p) => set.has(p));
}

async function demote(ctx, deps, reason) {
  const { orchDir, branch, rounds, runStats } = ctx;
  const { github, notify } = deps;
  const usage = totalUsage(runStats);
  const r = await github.demote({ ...ctx, reason });
  notify.recordRun(orchDir, {
    ts: new Date().toISOString(), branch, verdict: "pr-fallback", reason, rounds,
    ...(usage.tokens ? { tokens: usage.tokens } : {}),
    ...(usage.costUsd != null ? { costUsd: usage.costUsd } : {}),
    ...(r.prUrl ? { prUrl: r.prUrl } : {}),
  });
  return {
    status: "pr-fallback",
    reason: r.prUrl ? `${reason} → PR ${r.prUrl}` : `${reason} → escalated locally (no remote)`,
    prUrl: r.prUrl,
  };
}
