// The only globally-serialized step. Holds .orch/merge.lock while it syncs the
// integration worktree, runs the two conflict guards (file-overlap pre-check +
// post-merge re-test), and either lands the merge into local main or demotes the
// branch to a PR / local escalation. The engine calls this via deps.finalize so
// it stays a pure state machine.

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
  const { repo, orchDir, branch, sid, baseSha, paths, testCmd, cfg, rounds, closes, runStats } = ctx;
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
    // Catch local `main` up to origin BEFORE building on it: `orch task`/`orch issue`
    // only does this once, at the start of the whole invocation. If some other
    // checkout of this origin pushed a merge since then, our local main is stale;
    // basing this cycle's merge on it wouldn't corrupt anything (a plain push is
    // fast-forward-only and already fails loudly, with rollback, if rejected —
    // see complete.js), but it would waste the whole cycle by getting rejected at
    // push time. Catching up here avoids that. Local main being AHEAD of origin is
    // normal mid-invocation (main is only pushed once, at the very end) so it's not
    // treated as a failure — only a genuine two-way divergence demotes.
    const sync = git.syncMainFromOrigin(repo, { allowAhead: true });
    if (!sync.ok) return demote(ctx, deps, `main diverged from origin: ${sync.reason}`);

    const integration = git.ensureIntegrationWorktree(repo, orchDir);
    git.syncWorktreeToMain(integration);

    // Guard 1: file-overlap. Anything that landed on main since our base, plus
    // any live peer's changed paths. Read under the lock so it is consistent.
    const others = [...git.changedSince(repo, baseSha), ...inflight.peerPaths(orchDir, sid)];
    if (overlaps(paths, others)) return demote(ctx, deps, "overlap");

    const preSha = git.git(["rev-parse", "HEAD"], integration); // main tip pre-merge
    // `orch issue <n>`: stamp `Closes #n` in the no-ff merge commit so the issue
    // auto-closes once main reaches origin. ponytail: ff-only has no merge commit
    // to carry it, so it won't auto-close — default is no-ff; demote PR covers the
    // fallback. The number is our own int, not attacker text — safe to interpolate.
    const message = closes ? `Merge ${branch}\n\nCloses #${closes}` : null;
    const m = git.mergeInWorktree(integration, branch, cfg.merge, message);
    if (!m.ok) return demote(ctx, deps, "conflict");

    // Guard 2: re-run the test gate against integrated main.
    const { pass } = gate.run(testCmd, integration);
    if (!pass) {
      git.git(["reset", "--hard", preSha], integration); // roll main back
      return demote(ctx, deps, "post-merge-test-fail");
    }

    // Patch-per-merge version bump + CHANGELOG entry, so a merged sha always
    // maps to a bumped `orch --version`. Best-effort: never blocks the merge.
    git.bumpVersion(integration, closes ? `${branch} (closes #${closes})` : branch);

    const sha = git.git(["rev-parse", "HEAD"], integration);
    // The integration worktree is checked out on branch `main`, so this commit
    // should already be visible as `repo`'s local main (same .git, shared refs) —
    // but don't just assume it: verify before reporting success, so a broken/stale
    // integration worktree fails loudly instead of "merged" going out while local
    // main never actually moved.
    const localMain = git.git(["rev-parse", "main"], repo);
    if (localMain !== sha) {
      notify.resetKpi?.(orchDir);
      throw new Error(
        `orch: merge commit ${sha} was built in the integration worktree but local main ` +
        `is still at ${localMain} — refusing to report a false "merged"`,
      );
    }
    const push = git.pushMain(repo);
    if (!push.ok) {
      notify.resetKpi?.(orchDir);
      throw new Error(`orch: merged local main at ${sha}, but push to origin/main failed: ${push.reason || "push failed"}`);
    }
    const verified = git.verifyOriginContains(repo, sha);
    if (!verified.ok) {
      notify.resetKpi?.(orchDir);
      throw new Error(
        `orch: pushed main but origin/main does not contain ${sha}: ${verified.reason || "verification failed"} — ` +
        `refusing to report a false "merged"`,
      );
    }
    const shortSha = git.git(["rev-parse", "--short", "HEAD"], integration);
    notify.recordRun(orchDir, {
      ts: new Date().toISOString(), branch, verdict: "merged", sha: shortSha, rounds,
      ...(usage.tokens ? { tokens: usage.tokens } : {}),
      ...(usage.costUsd != null ? { costUsd: usage.costUsd } : {}),
    });
    notify.cleanupReviews(orchDir, branch);
    return { status: "merged", reason: "agreed + green + merged", sha: shortSha };
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
