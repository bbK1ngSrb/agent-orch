// The only globally-serialized step. Holds .orch/merge.lock while it syncs the
// integration worktree, runs the two conflict guards (file-overlap pre-check +
// post-merge re-test), and either lands the merge into local main or demotes the
// branch to a PR / local escalation. The engine calls this via deps.finalize so
// it stays a pure state machine.
export async function finalize(ctx, deps) {
  const { repo, orchDir, branch, sid, baseSha, paths, testCmd, cfg, rounds } = ctx;
  const { git, gate, lock, inflight, github, notify } = deps;

  if (!lock.acquireBlocking(orchDir, "merge.lock")) {
    return demote(ctx, deps, "merge-lock timeout"); // never acquired → don't touch the worktree
  }
  try {
    const integration = git.ensureIntegrationWorktree(repo, orchDir);
    git.syncWorktreeToMain(integration);

    // Guard 1: file-overlap. Anything that landed on main since our base, plus
    // any live peer's changed paths. Read under the lock so it is consistent.
    const others = [...git.changedSince(repo, baseSha), ...inflight.peerPaths(orchDir, sid)];
    if (overlaps(paths, others)) return demote(ctx, deps, "overlap");

    const preSha = git.git(["rev-parse", "HEAD"], integration); // main tip pre-merge
    const m = git.mergeInWorktree(integration, branch, cfg.merge);
    if (!m.ok) return demote(ctx, deps, "conflict");

    // Guard 2: re-run the test gate against integrated main.
    const { pass } = gate.run(testCmd, integration);
    if (!pass) {
      git.git(["reset", "--hard", preSha], integration); // roll main back
      return demote(ctx, deps, "post-merge-test-fail");
    }

    const sha = git.git(["rev-parse", "--short", "HEAD"], integration);
    notify.recordRun(orchDir, { ts: new Date().toISOString(), branch, verdict: "merged", sha, rounds });
    notify.cleanupReviews(orchDir, branch);
    return { status: "merged", reason: "agreed + green + merged", sha };
  } finally {
    lock.releaseLock(orchDir, "merge.lock");
  }
}

function overlaps(mine, others) {
  const set = new Set(others);
  return mine.some((p) => set.has(p));
}

async function demote(ctx, deps, reason) {
  const { orchDir, branch, rounds } = ctx;
  const { github, notify } = deps;
  const r = await github.demote(ctx);
  notify.recordRun(orchDir, {
    ts: new Date().toISOString(), branch, verdict: "pr-fallback", reason, rounds,
    ...(r.prUrl ? { prUrl: r.prUrl } : {}),
  });
  return {
    status: "pr-fallback",
    reason: r.prUrl ? `${reason} → PR ${r.prUrl}` : `${reason} → escalated locally (no remote)`,
    prUrl: r.prUrl,
  };
}
