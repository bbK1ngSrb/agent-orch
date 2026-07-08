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

const ISSUE_URL_BASE = "https://github.com/bbk1ng/agent-orch/issues";

function changelogEntry(ctx) {
  const title = oneLine(ctx.title || ctx.task || ctx.branch) || ctx.branch;
  return ctx.closes
    ? `${title} (closes [#${ctx.closes}](${ISSUE_URL_BASE}/${ctx.closes}))`
    : title;
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
      ts: new Date().toISOString(), branch, sid, verdict: r.prUrl ? "pr" : "escalated", rounds,
      ...(usage.tokens ? { tokens: usage.tokens } : {}),
      ...(usage.costUsd != null ? { costUsd: usage.costUsd } : {}),
      ...(r.prUrl ? { prUrl: r.prUrl } : {}),
    });
    return r.prUrl
      ? { status: "pr", reason: `agreed + green → PR ${r.prUrl}`, prUrl: r.prUrl }
      : { status: "escalated", reason: "agreed + green → escalated locally (merge: pr needs a remote + gh CLI)" };
  }

  if (!lock.acquireBlocking(orchDir, "merge.lock")) {
    return demote(ctx, deps, demoteReason(ctx, { trigger: "merge-lock timeout" })); // never acquired → don't touch the worktree
  }
  try {
    const baseBranch = cfg.baseBranch || "main";
    // Catch the local base branch up to origin BEFORE building from it: `orch task`/`orch issue`
    // only does this once, at the start of the whole invocation. If some other
    // checkout of this origin merged a PR since then, our local base is stale.
    // Local base must never be ahead here: orch lands on the integration branch
    // and lets GitHub advance the base branch through the PR.
    const sync = git.syncMainFromOrigin(repo, baseBranch);
    if (!sync.ok) {
      return demote(ctx, deps, demoteReason(ctx, {
        trigger: "main-sync-failed",
        mergeReason: sync.reason,
      }));
    }

    const integrationBranch = cfg.integrationBranch || "orch/integration";
    const integration = git.ensureIntegrationWorktree(repo, orchDir, integrationBranch, baseBranch);
    git.syncWorktreeToIntegration(integration, integrationBranch);

    // Guard 1: file-overlap with live in-flight peers only, read under the lock so it
    // is consistent. A peer hasn't landed yet, so Guard 2 can't see its changes and
    // last-writer-wins races remain possible — demote. Overlap with commits already
    // landed on integration is deliberately NOT pre-demoted: a textual conflict fails
    // the merge below, and a semantic conflict fails the Guard 2 re-test — a cleanly
    // mergeable green branch should land (#96).
    const peerEntries = typeof inflight.listLive === "function"
      ? inflight.listLive(orchDir).filter((e) => e.sid !== sid)
      : [];
    const peerPaths = peerEntries.length
      ? peerEntries.flatMap((e) => e.paths || [])
      : inflight.peerPaths(orchDir, sid);
    const integrationTip = git.git(["rev-parse", "HEAD"], integration);
    const overlap = overlapDetails(paths, [], peerPaths, peerEntries);
    if (overlap.any) {
      return demote(ctx, deps, demoteReason(ctx, {
        trigger: "overlap",
        integrationBranch,
        integrationTip,
        overlap,
      }));
    }

    const preSha = integrationTip; // integration tip pre-merge
    // `orch issue <n>`: stamp `Closes #n` in the no-ff merge commit so the issue
    // auto-closes once GitHub merges the integration PR. ponytail: ff-only has no merge commit
    // to carry it, so it won't auto-close — default is no-ff; demote PR covers the
    // fallback. The number is our own int, not attacker text — safe to interpolate.
    const message = closes ? `Merge ${branch}\n\nCloses #${closes}` : null;
    const m = git.mergeInWorktree(integration, branch, cfg.merge, message);
    if (!m.ok) {
      return demote(ctx, deps, demoteReason(ctx, {
        trigger: "conflict",
        integrationBranch,
        integrationTip: preSha,
        mergeReason: m.reason,
        advice: m.advice,
      }));
    }

    // Guard 2: re-run the test gate against integrated branch state.
    const { pass } = gate.run(testCmd, integration);
    if (!pass) {
      git.git(["reset", "--hard", preSha], integration); // roll integration back
      return demote(ctx, deps, demoteReason(ctx, {
        trigger: "post-merge-test-fail",
        integrationBranch,
        integrationTip: preSha,
        integrationGate: "failed",
      }));
    }

    // Patch-per-merge version bump + CHANGELOG entry, so a merged sha always
    // maps to a bumped `orch --version`. Best-effort: never blocks the merge.
    git.bumpVersion(integration, changelogEntry(ctx));

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
      ts: new Date().toISOString(), branch, sid, verdict: "merged", sha: shortSha, rounds,
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

function overlapDetails(mine, landedPaths, peerPaths, peerEntries = []) {
  const mineSet = new Set(mine);
  const landed = landedPaths.filter((p) => mineSet.has(p));
  const peers = peerEntries.length
    ? peerEntries.map((e) => ({
      sid: e.sid,
      paths: (e.paths || []).filter((p) => mineSet.has(p)),
    })).filter((e) => e.paths.length)
    : [];
  const peer = peerEntries.length
    ? peers.flatMap((e) => e.paths)
    : peerPaths.filter((p) => mineSet.has(p));
  return { any: landed.length > 0 || peer.length > 0, landed, peer, peers };
}

function demoteReason(ctx, details) {
  const { baseSha, paths, rounds, testCmd } = ctx;
  const lines = [
    `trigger: ${details.trigger}`,
    `review: AGREE after ${rounds} round(s)`,
    `test gate: passed on branch (${testCmd})`,
    `branch state: base ${baseSha}; ${details.integrationBranch || "integration"} ${details.integrationTip || "unknown"}`,
    `branch paths: ${list(paths)}`,
  ];

  if (details.trigger === "overlap") {
    if (details.overlap.landed.length) lines.push(`landed overlap: ${list(details.overlap.landed)}`);
    if (details.landedCommits) lines.push(`landed commits: ${details.landedCommits.split("\n").map(oneLine).join("; ")}`);
    if (details.overlap.peers.length) {
      lines.push(`peer overlap: ${details.overlap.peers.map((e) => `${e.sid}: ${list(e.paths)}`).join("; ")}`);
    } else if (details.overlap.peer.length) {
      lines.push(`peer overlap: ${list(details.overlap.peer)}`);
    }
    lines.push("next action: inspect the listed overlap, rebase or refresh the branch if needed, then rerun orch review before merging.");
  } else if (details.trigger === "conflict") {
    const mergeReason = String(details.mergeReason || "").trim();
    lines.push(mergeReason ? `merge result:\n\`\`\`\n${mergeReason}\n\`\`\`` : "merge result: merge failed");
    const conflicts = conflictPaths(details.mergeReason);
    if (conflicts.length) lines.push(`conflicting paths: ${list(conflicts)}`);
    if (details.advice) lines.push(`advice: ${oneLine(details.advice)}`);
    lines.push("next action: resolve the merge conflict, then rerun orch review.");
  } else if (details.trigger === "post-merge-test-fail") {
    lines.push("integration gate: failed after merge; integration was reset to the pre-merge tip.");
    lines.push("next action: fix the integrated test failure, then rerun orch review.");
  } else if (details.trigger === "merge-lock timeout") {
    lines.push("merge lock: timed out before touching the integration worktree.");
    lines.push("next action: retry after the active merge finishes.");
  } else if (details.trigger === "main-sync-failed") {
    lines.push(`main sync: ${oneLine(details.mergeReason) || "failed"}`);
    lines.push("next action: inspect local main versus origin/main, then rerun orch review after main is synchronized.");
  }

  return lines.join("\n");
}

function conflictPaths(reason = "") {
  return [...String(reason).matchAll(/CONFLICT.*? in (.+)$/gmi)].map((m) => m[1].trim());
}

function list(items = []) {
  return items.length ? items.join(", ") : "(none)";
}

function oneLine(value = "") {
  return String(value).replace(/\s+/g, " ").trim();
}

async function demote(ctx, deps, reason) {
  const { orchDir, branch, sid, rounds, runStats } = ctx;
  const { github, notify } = deps;
  const usage = totalUsage(runStats);
  const r = await github.demote({ ...ctx, reason });
  notify.recordRun(orchDir, {
    ts: new Date().toISOString(), branch, sid, verdict: "pr-fallback", reason, rounds,
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
