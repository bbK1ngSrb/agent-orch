// The only globally-serialized step. Holds .orch/merge.lock while it syncs the
// integration worktree, runs the two conflict guards (file-overlap pre-check +
// post-merge re-test), and either lands the merge into the integration branch
// plus its PR bridge or demotes the branch to a PR / local escalation. The
// engine calls this via deps.finalize so it stays a pure state machine.

import { totalUsage } from "./usage.js";

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
    const integrationSync = git.reconcileIntegrationToBase(integration, baseBranch);
    if (!integrationSync.ok) {
      return demote(ctx, deps, demoteReason(ctx, {
        trigger: "main-sync-failed",
        mergeReason: integrationSync.reason,
      }));
    }

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
    const overlap = overlapDetails(paths, peerPaths, peerEntries);
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
    // maps to a bumped `orch --version`. Opt-in via release.autoBump: a generic
    // orchestrator must not edit downstream release files by default.
    // Best-effort: never blocks the merge.
    if (cfg.release?.autoBump) git.bumpVersion(integration, changelogEntry(ctx));

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

function overlapDetails(mine, peerPaths, peerEntries = []) {
  const mineSet = new Set(mine);
  const peers = peerEntries.length
    ? peerEntries.map((e) => ({
      sid: e.sid,
      paths: (e.paths || []).filter((p) => mineSet.has(p)),
    })).filter((e) => e.paths.length)
    : [];
  const peer = peerEntries.length
    ? peers.flatMap((e) => e.paths)
    : peerPaths.filter((p) => mineSet.has(p));
  return { any: peer.length > 0, peer, peers };
}

// The hand-off from robot to human. An operator reading this needs to see at a
// glance that the change is *approved and green* and merely lost the automatic
// landing step — so we lead with teaching-toned prose (the repo mandates it),
// keep every machine fact (trigger, rounds, testCmd, baseSha, paths), and tuck
// the raw git conflict dump into a collapsed <details> so it informs without
// burying the signal.
function demoteReason(ctx, details) {
  const { baseSha, paths, rounds, testCmd } = ctx;
  const integ = details.integrationBranch || "integration";
  const out = [
    "## Why this PR exists",
    "",
    "This change is **approved** — the agents agreed after review — and **green**: the test gate " +
    `(\`${testCmd}\`) passed on the branch. orch could not land it automatically, so it fell back to ` +
    "opening this pull request. That fallback path (\"PR-fallback\") means the work is sound; it only " +
    "lost the automatic-landing step, usually to a race with another cycle that landed first.",
    "",
    "## What blocked the automatic landing",
    "",
    ...blockedSection(details),
    "",
    "## Signals",
    "",
    "| signal | value |",
    "| --- | --- |",
    `| review | AGREE after ${rounds} round(s) |`,
    `| test gate | passed on branch (${testCmd}) |`,
    `| trigger | ${details.trigger} |`,
    `| mergeability vs base | blocked — base ${baseSha}; ${integ} ${details.integrationTip || "unknown"} |`,
    `| branch paths | ${list(paths)} |`,
    "",
    "## Next step",
    "",
    nextStep(details.trigger),
  ];

  return out.join("\n");
}

// Plain-words explanation of the blocker, per trigger. Keeps the machine facts
// (conflicting paths, peer overlap, the raw merge output) but frames them so a
// human knows whether they are staring at a mechanical release-churn collision
// or a real logic conflict.
function blockedSection(details) {
  if (details.trigger === "overlap") {
    const lines = [
      "**Overlap.** Another cycle landed (or is landing) changes to files this branch also touches, so " +
      "orch can no longer prove the two edits are independent — merging blind could silently clobber the " +
      "other work, so it demoted instead.",
      "",
    ];
    if (details.landedCommits) lines.push(`landed commits: ${details.landedCommits.split("\n").map(oneLine).join("; ")}`);
    if (details.overlap.peers.length) {
      lines.push(`peer overlap: ${details.overlap.peers.map((e) => `${e.sid}: ${list(e.paths)}`).join("; ")}`);
    } else if (details.overlap.peer.length) {
      lines.push(`peer overlap: ${list(details.overlap.peer)}`);
    }
    return lines;
  }
  if (details.trigger === "conflict") {
    const mergeReason = String(details.mergeReason || "").trim();
    const conflicts = conflictPaths(details.mergeReason);
    const lines = [
      "**Merge conflict.** git could not combine this branch with the integration branch on its own, " +
      "because both sides changed the same lines. Conflicts confined to release-churn files " +
      "(`CHANGELOG.md`, `package-lock.json`, `package.json`) are landing-race collisions and resolve " +
      "mechanically; conflicts anywhere else are real content overlaps worth a closer read.",
      "",
    ];
    if (conflicts.length) lines.push(`conflicting paths: ${list(conflicts)}`);
    if (details.advice) lines.push(`advice: ${oneLine(details.advice)}`);
    lines.push(
      "",
      "<details><summary>raw merge output</summary>",
      "",
      mergeReason ? `merge result:\n\`\`\`\n${mergeReason}\n\`\`\`` : "merge result: merge failed",
      "",
      "</details>",
    );
    return lines;
  }
  if (details.trigger === "post-merge-test-fail") {
    return [
      "**Post-merge test failure.** The branch merged cleanly, but the test suite went red on the combined " +
      "tree — the two changes are individually green yet conflict in behaviour. orch reset the integration " +
      "branch to its pre-merge tip, so nothing was left half-landed.",
      "",
      "integration gate: failed after merge; integration was reset to the pre-merge tip.",
    ];
  }
  if (details.trigger === "merge-lock timeout") {
    return [
      "**Merge-lock timeout.** Another merge held the lock past the timeout, so this cycle never got to " +
      "touch the integration worktree. Nothing is wrong with the branch itself.",
      "",
      "merge lock: timed out before touching the integration worktree.",
    ];
  }
  if (details.trigger === "main-sync-failed") {
    return [
      "**Main out of sync.** orch could not fast-forward local main to origin, so it refused to land " +
      "against a possibly stale base rather than risk a bad merge.",
      "",
      `main sync: ${oneLine(details.mergeReason) || "failed"}`,
    ];
  }
  return [`trigger: ${details.trigger}`];
}

function nextStep(trigger) {
  switch (trigger) {
    case "overlap":
      return "next action: inspect the listed overlap, rebase or refresh the branch if needed, then rerun orch review before merging.";
    case "conflict":
      return "next action: resolve the merge conflict, then rerun orch review.";
    case "post-merge-test-fail":
      return "next action: fix the integrated test failure, then rerun orch review.";
    case "merge-lock timeout":
      return "next action: retry after the active merge finishes.";
    case "main-sync-failed":
      return "next action: inspect local main versus origin/main, then rerun orch review after main is synchronized.";
    default:
      return "next action: review the branch manually, then rerun orch review.";
  }
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
