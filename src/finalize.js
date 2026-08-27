// The only globally-serialized step. Holds .orch/merge.lock while it syncs the
// integration worktree, runs the two conflict guards (file-overlap pre-check +
// post-merge re-test), and either lands the merge into the integration branch
// plus its PR bridge or demotes the branch to a PR / local escalation. The
// engine calls this via deps.finalize so it stays a pure state machine.
//
// After a clean land, Tier-1 redrive (#350) also rebases + re-gates any peer that
// was demoted for overlapping this cycle — serial under the same merge.lock so
// N deferred peers never re-race. True line conflicts stay deferred for a human.

import * as deferredDefault from "./deferred.js";
import { totalUsage } from "./usage.js";
import { classify, fingerprint, TRIGGERS } from "./failure.js";
import { LOCK_NAMES } from "./lock.js";

// design §6: trigger id -> failure class, for the demote()/landIntoIntegration
// callers below. Kept here (not failure.js) because "lock"/"sync"/"overlap"/
// "dirty-merge"/"integration-test" are finalize.js's own vocabulary — failure.js
// only knows the TRIGGERS ids they map onto.
function triggerClass(trigger) {
  const id = {
    lock: TRIGGERS.LAND_LOCK,
    sync: TRIGGERS.LAND_SYNC,
    overlap: TRIGGERS.LAND_OVERLAP,
    "dirty-merge": TRIGGERS.LAND_DIRTY_MERGE,
    "integration-test": TRIGGERS.LAND_INTEGRATION_TEST,
  }[trigger];
  if (!id) throw new Error(`finalize.triggerClass: unknown demote trigger "${trigger}"`);
  return classify(id);
}

const ISSUE_URL_BASE = "https://github.com/bbk1ng/agent-orch/issues";

// A CHANGELOG line ships to npm, so it must never be a branch name: the branch
// is a machine-generated slug (work order squashed to filename-safe chars +
// session id) and tells a consumer nothing. A resumed cycle also sets
// ctx.task to the branch (cli.js), so reject that value however it arrives.
const NO_WORK_ORDER = "release bookkeeping (no work-order text recorded)";

// Changelog policy: use the first conventional feat/fix subject in chronological
// order. Later review-round fixes are refinements, so one representative subject
// keeps a long branch to one line; if none is usable, retain the issue-title fallback.
function changelogEntry(ctx, git) {
  const base = oneLine(ctx.baseSha);
  const branch = oneLine(ctx.reviewedSha || ctx.branch);
  let subject = "";
  if (base && branch) {
    try {
      subject = git.git(["log", "--format=%s", "--reverse", `${base}..${branch}`], ctx.repo)
        .split("\n")
        .map(oneLine)
        .find((line) => /^(?:feat|fix)(?:\([^)]*\))?!?:\s+\S/.test(line)) || "";
    } catch { /* an unreadable range uses the title fallback below */ }
  }
  const candidate = subject || oneLine(ctx.title || ctx.task);
  const title = candidate && candidate !== oneLine(ctx.branch) ? candidate : NO_WORK_ORDER;
  return ctx.closes
    ? `${title} (closes [#${ctx.closes}](${ISSUE_URL_BASE}/${ctx.closes}))`
    : title;
}

function reviewedHeadEscalation(ctx, deps) {
  if (!Object.hasOwn(ctx, "reviewedSha")) return null;
  const { repo, orchDir, branch, reviewedSha, sid, rounds, closes, runStats } = ctx;
  const { git, notify } = deps;
  let currentSha = null;
  try {
    currentSha = git.git(["rev-parse", "--verify", `refs/heads/${branch}`], repo);
  } catch { /* unreadable fails closed below */ }
  if (reviewedSha && currentSha && reviewedSha === currentSha) return null;

  const reviewed = reviewedSha || "<unreadable>";
  const current = currentSha || "<unreadable>";
  const reason = `branch head integrity check failed: reviewed SHA ${reviewed}; current SHA ${current} — terminal escalation, refusing to merge or publish`;
  notify.escalate(orchDir, branch,
    `# Escalation — ${branch}\n\n` +
    `The branch moved after approval or its current OID became unreadable.\n\n` +
    `- Reviewed SHA: \`${reviewed}\`\n` +
    `- Current SHA: \`${current}\`\n\n` +
    `The approval applies only to the reviewed commit, so orch refused to merge or publish the branch.\n`);
  const usage = totalUsage(runStats);
  notify.recordRun(orchDir, {
    ts: new Date().toISOString(), branch, sid, verdict: "escalated", reason, rounds,
    closes: closes ?? null,
    ...(usage.tokens ? { tokens: usage.tokens } : {}),
    ...(usage.costUsd != null ? { costUsd: usage.costUsd } : {}),
  });
  const cls = classify(TRIGGERS.LAND_HEAD_MOVED);
  return { status: "escalated", reason, class: cls, fingerprint: fingerprint(cls, `${reviewed}->${current}`) };
}

export async function finalize(ctx, deps) {
  const { repo, orchDir, branch, sid, paths, testCmd, cfg, rounds, closes, runStats } = ctx;
  const { git, gate, lock, inflight, github, notify } = deps;
  const deferred = deps.deferred || deferredDefault;
  const usage = totalUsage(runStats);

  // cfg.merge === "pr": opt out of direct-to-main. No local merge, no merge.lock —
  // GitHub owns the merge (branch protection / CI-gated checks apply).
  if (cfg.merge === "pr") {
    const integrityFailure = reviewedHeadEscalation(ctx, deps);
    if (integrityFailure) return integrityFailure;
    const r = await github.openPr(ctx, deps);
    notify.recordRun(orchDir, {
      ts: new Date().toISOString(), branch, sid, verdict: r.prUrl ? "pr" : "escalated", rounds,
      closes: closes ?? null,
      ...(usage.tokens ? { tokens: usage.tokens } : {}),
      ...(usage.costUsd != null ? { costUsd: usage.costUsd } : {}),
      ...(r.prUrl ? { prUrl: r.prUrl } : {}),
    });
    if (r.prUrl) return { status: "pr", reason: `agreed + green → PR ${r.prUrl}`, prUrl: r.prUrl };
    const cls = classify(TRIGGERS.LAND_PR_OPEN_FAILED);
    return {
      status: "escalated", reason: "agreed + green → escalated locally (merge: pr needs a remote + gh CLI)",
      class: cls, fingerprint: fingerprint(cls, "pr-open-failed"),
    };
  }

  if (!(await lock.acquireBlocking(orchDir, LOCK_NAMES.MERGE))) {
    return demote(ctx, deps, { trigger: "lock" }); // never acquired → don't touch the worktree
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
      return demote(ctx, deps, {
        trigger: "sync",
        mergeReason: sync.reason,
      });
    }

    const integrationBranch = cfg.integrationBranch || "orch/integration";
    const integration = git.ensureIntegrationWorktree(repo, orchDir, integrationBranch, baseBranch);
    git.syncWorktreeToIntegration(integration, integrationBranch);
    const originSync = git.reconcileIntegrationToOrigin(integration, integrationBranch);
    if (!originSync.ok) {
      return demote(ctx, deps, {
        trigger: "sync",
        mergeReason: originSync.reason,
      });
    }
    const integrationSync = git.reconcileIntegrationToBase(integration, baseBranch);
    if (!integrationSync.ok) {
      return demote(ctx, deps, {
        trigger: "sync",
        mergeReason: integrationSync.reason,
      });
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
      const result = await demote(ctx, deps, {
        trigger: "overlap",
        integrationBranch,
        integrationTip,
        overlap,
      });
      // Only a successful demotion is eligible for post-land redrive. Persist
      // the reviewed commit so redrive never re-resolves mutable branch content.
      if (result.status === "merge-deferred") {
        deferred.record?.(orchDir, {
          sid, branch, reviewedSha: ctx.reviewedSha || null,
          paths, testCmd, baseSha: ctx.baseSha, rounds, closes,
          title: ctx.title, task: ctx.task,
          peerSids: overlap.peers.map((e) => e.sid).filter(Boolean),
        });
      }
      return result;
    }

    const landed = await landIntoIntegration(ctx, deps, {
      integration, integrationBranch, baseBranch, preSha: integrationTip,
    });
    if (landed.status !== "merged") return landed;

    // Post-land: serially redrive overlap-deferred peers under this same lock.
    // Best-effort — a redrive bug must never undo a merge that already landed.
    try {
      await redriveDeferredPeers(ctx, deps, {
        integration, integrationBranch, baseBranch,
        landed: { sid, paths },
        deferred,
      });
    } catch { /* primary land stands */ }

    return landed;
  } finally {
    lock.releaseLock(orchDir, LOCK_NAMES.MERGE);
  }
}

// Merge + Guard 2 + record. Caller holds merge.lock and has the integration
// worktree synced. Shared by the primary land path and Tier-1 peer redrive.
// `quietFail` (redrive path): on conflict/gate-fail do not demote again — the
// peer already has a merge-deferred PR from its first demote; just leave it.
async function landIntoIntegration(ctx, deps, { integration, integrationBranch, baseBranch, preSha, quietFail = false }) {
  const { repo, orchDir, branch, reviewedSha, sid, testCmd, cfg, rounds, closes, runStats } = ctx;
  const { git, gate, github, notify } = deps;
  const usage = totalUsage(runStats);

  // Primary lands carry the OID captured immediately before the security reads.
  // This runs under merge.lock; a moved or unreadable branch invalidates approval.
  const integrityFailure = reviewedHeadEscalation(ctx, deps);
  if (integrityFailure) return integrityFailure;

  // `orch issue <n>`: stamp `Closes #n` in the no-ff merge commit so the issue
  // auto-closes once GitHub merges the integration PR. ponytail: ff-only has no merge commit
  // to carry it, so it won't auto-close — default is no-ff; demote PR covers the
  // fallback. The number is our own int, not attacker text — safe to interpolate.
  const message = closes ? `Merge ${branch}\n\nCloses #${closes}` : null;
  const m = git.mergeInWorktree(integration, reviewedSha || branch, cfg.merge, message);
  if (!m.ok) {
    if (quietFail) {
      const cls = classify(TRIGGERS.LAND_DIRTY_MERGE);
      return {
        status: "merge-deferred", trigger: "dirty-merge", reason: m.reason || "conflict",
        class: cls, fingerprint: fingerprint(cls, `dirty-merge: ${conflictPaths(m.reason).sort().join(",")}`),
      };
    }
    return demote(ctx, deps, {
      trigger: "dirty-merge",
      integrationBranch,
      integrationTip: preSha,
      mergeReason: m.reason,
      advice: m.advice,
    });
  }

  // Guard 2: re-run the test gate against integrated branch state. This runs
  // under merge.lock, so the gate gets the same wall-clock cap as an agent
  // stage (#505) — a hung test command must not hold the lock forever.
  const { pass } = gate.run(testCmd, integration, cfg.stageTimeout > 0 ? cfg.stageTimeout * 60_000 : 0);
  if (!pass) {
    git.git(["reset", "--hard", preSha], integration); // roll integration back
    if (quietFail) {
      const cls = classify(TRIGGERS.LAND_INTEGRATION_TEST);
      return {
        status: "merge-deferred", trigger: "integration-test", reason: "post-merge-test-fail",
        class: cls, fingerprint: fingerprint(cls, "integration-test failure"),
      };
    }
    return demote(ctx, deps, {
      trigger: "integration-test",
      integrationBranch,
      integrationTip: preSha,
      integrationGate: "failed",
    });
  }

  // Patch-per-merge version bump + CHANGELOG entry, so a merged sha always
  // maps to a bumped `orch --version`. Opt-in via release.autoBump: a generic
  // orchestrator must not edit downstream release files by default.
  // Best-effort: never blocks the merge.
  if (cfg.release?.autoBump) git.bumpVersion(integration, changelogEntry(ctx, git));

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
    // Thread the integration tip this cycle verified so the bridge can pin
    // main.autoMerge to that commit (not whatever the branch points at later).
    pr = await github.openIntegrationPr({ ...ctx, integrationSha: sha }, deps);
  } catch (e) {
    notify.escalate?.(orchDir, integrationBranch,
      `# Escalation — ${integrationBranch}\n\nThe local integration branch is green, but the PR bridge failed after the merge landed locally: ${e.message}\n`);
    pr = { prUrl: null };
  }
  const shortSha = git.git(["rev-parse", "--short", "HEAD"], integration);
  notify.recordRun(orchDir, {
    ts: new Date().toISOString(), branch, sid, verdict: "merged", sha: shortSha, rounds,
    // This context's OWN issue — a redriven peer (below) is a different issue
    // than the cycle that unblocked it, so the record must carry the peer's.
    // Always emit the key, `null` included: an `orch task` peer HAS no issue, and
    // the realDeps stamp keys on the key's PRESENCE, not on a non-null value.
    closes: closes ?? null,
    ...(pr.prUrl ? { prUrl: pr.prUrl } : {}),
    ...(usage.tokens ? { tokens: usage.tokens } : {}),
    ...(usage.costUsd != null ? { costUsd: usage.costUsd } : {}),
  });
  notify.cleanupReviews(orchDir, branch);
  // The cycle's `pr/*` head has served its whole purpose now that its content is
  // on the integration branch — drop the remote copy so origin doesn't accumulate
  // one orphan per cycle (#339). Only reached on the merged path: demote and
  // `merge: pr` return earlier and keep their open-PR head untouched.
  //
  // Gated on pr.prUrl for a reason: `openIntegrationPr` is the ONLY step that
  // pushes the integration branch to origin (github.js), and it can throw (caught
  // above → prUrl null). On that failure origin/integration is stale — the merged
  // content lives only on the local branch — so deleting the `pr/*` head would
  // destroy the sole remote copy of just-landed work, in the exact state a human
  // is being told to recover from. prUrl truthy ⇒ the push succeeded ⇒ origin has
  // the content ⇒ the head is safe to drop. Also guarded against ever deleting a
  // protected ref, and best-effort so it never undoes a merge that already landed.
  if (pr.prUrl && branch && branch !== integrationBranch && branch !== baseBranch) {
    git.deleteRemoteBranch?.(repo, branch);
  }
  return {
    status: "merged",
    reason: pr.prUrl
      ? `agreed + green + integrated → PR ${pr.prUrl}`
      : "agreed + green + integrated locally; PR bridge unavailable",
    sha: shortSha,
    prUrl: pr.prUrl,
  };
}

// After a cycle lands, redrive every overlap-deferred peer it unblocked. Holds
// the caller's merge.lock; peers never fan out in parallel (no thundering herd).
// A peer that fails redrive once stays deferred for a human — never loops.
async function redriveDeferredPeers(ctx, deps, { integration, integrationBranch, baseBranch, landed, deferred }) {
  const { repo, orchDir, cfg } = ctx;
  const { git, gate, inflight, notify } = deps;
  if (typeof deferred?.list !== "function") return;

  // Seeds of "what just became available": the primary land, then any peer we
  // successfully redrive (so C deferred on B can heal after B heals on A).
  const unblocked = [{ sid: landed.sid, paths: landed.paths || [] }];
  const seen = new Set();
  // Sids whose work is already ON the integration branch: this cycle, plus every
  // peer we redrive below. Their `.orch/inflight` records are still live here —
  // the landing cycle only deregisters after finalize() returns — but a landed
  // change is not an unlanded peer, and the same policy as the Guard 1 comment
  // above applies: overlap with what already landed is not a demote reason.
  // Without this, the blocker itself always shows up in the live-peer scan on
  // exactly the paths that caused the deferral, so no peer is ever redriven.
  // We hold merge.lock, so the exclusions are only "us" + "peers we just landed".
  const landedSids = new Set([landed.sid]);

  while (unblocked.length) {
    const blocker = unblocked.shift();
    const peers = deferred.list(orchDir)
      .filter((e) => !seen.has(e.sid))
      .filter((e) => deferred.eligibleForRedrive?.(e) !== false)
      .filter((e) => deferred.blockedByLand?.(e, blocker));

    // One directory scan per wave, not per peer: listLive is a readdir +
    // JSON.parse + pidAlive() per record, while the only thing this loop itself
    // changes about the live set is `landedSids`, applied as a cheap in-memory
    // filter below.
    // ponytail: snapshot per wave — a cycle that registers mid-wave is not seen
    // until the next one. Safe because the whole wave runs under merge.lock: a
    // newcomer cannot land before us, and it rebases onto integration, so it
    // gets our content. Re-scan per peer only if peers start landing outside
    // the lock.
    const hasListLive = typeof inflight.listLive === "function";
    const allLive = hasListLive ? inflight.listLive(orchDir) : [];

    for (const peer of peers) {
      seen.add(peer.sid);

      // Still blocked by a live in-flight cycle → leave queued; do not burn an attempt.
      const live = allLive.filter((e) => e.sid !== peer.sid && !landedSids.has(e.sid));
      // Only fall back to peerPaths when listLive is unavailable: peerPaths filters
      // by sid alone, so using it when the filtered list is merely empty would let
      // the landed sids back in through the back door.
      const livePaths = hasListLive
        ? live.flatMap((e) => e.paths || [])
        : (typeof inflight.peerPaths === "function" ? inflight.peerPaths(orchDir, peer.sid) : []);
      if (overlapDetails(peer.paths || [], livePaths, live).any) continue;

      const reviewedSha = typeof peer.reviewedSha === "string" ? peer.reviewedSha.trim() : "";
      if (!reviewedSha) {
        // Legacy/unpinned records require a fresh human review and must not loop.
        deferred.markAttempt?.(orchDir, peer.sid);
        continue;
      }

      git.syncWorktreeToIntegration(integration, integrationBranch);
      const preSha = git.git(["rev-parse", "HEAD"], integration);

      let redriveSha = reviewedSha;
      if (typeof git.rebaseBranchOnto === "function") {
        const rb = git.rebaseBranchOnto(repo, orchDir, peer.branch, integrationBranch, reviewedSha);
        if (!rb.ok || !rb.sha) {
          // A moved head invalidates this pass without consuming the peer's one
          // real redrive attempt. Conflicts still consume it and stay human-owned.
          if (!rb.moved) deferred.markAttempt?.(orchDir, peer.sid);
          continue;
        }
        redriveSha = rb.sha;
        // The CAS advanced the branch. Persist that exact OID before landing so
        // a crash or failed re-gate never falls back to the pre-rebase commit.
        deferred.record?.(orchDir, { ...peer, reviewedSha: redriveSha });
      }

      // Identity/CAS checks passed; consume the one real redrive attempt before
      // merge + re-gate so a crash in that work cannot loop indefinitely.
      deferred.markAttempt?.(orchDir, peer.sid);

      const peerCtx = {
        repo, orchDir,
        branch: peer.branch,
        reviewedSha: redriveSha,
        sid: peer.sid,
        paths: peer.paths || [],
        testCmd: peer.testCmd || ctx.testCmd,
        cfg,
        rounds: peer.rounds || 1,
        closes: peer.closes ?? null,
        baseSha: peer.baseSha || null,
        title: peer.title || null,
        task: peer.task || null,
        runStats: [],
      };

      // Re-gate is mandatory: never blind-merge a rebased branch. quietFail keeps
      // the existing demote PR — a second demote would only reopen noise.
      const result = await landIntoIntegration(peerCtx, deps, {
        integration, integrationBranch, baseBranch, preSha, quietFail: true,
      });
      if (result.status === "merged") {
        deferred.remove?.(orchDir, peer.sid);
        landedSids.add(peer.sid); // merged only — a failed redrive is still unlanded
        unblocked.push({ sid: peer.sid, paths: peer.paths || [] });
        notify.phase?.("merge", `redrove ${peer.branch} after overlap`);
      }
      // else: stayed merge-deferred; attempt already marked, human owns it
    }
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
    `## Merge deferred: ${details.trigger}`,
    "",
    `Automatic landing was deferred by the \`${details.trigger}\` safety guard. This change is ` +
    `**approved** — the agents agreed after review — and **green**: the test gate (\`${testCmd}\`) ` +
    "passed on the branch. The work is intact and waiting for the blocked landing step to be resolved.",
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
    nextStep(details.trigger, integ),
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
  if (details.trigger === "dirty-merge") {
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
  if (details.trigger === "integration-test") {
    return [
      "**Post-merge test failure.** The branch merged cleanly, but the test suite went red on the combined " +
      "tree — the two changes are individually green yet conflict in behaviour. orch reset the integration " +
      "branch to its pre-merge tip, so nothing was left half-landed.",
      "",
      "integration gate: failed after merge; integration was reset to the pre-merge tip.",
    ];
  }
  if (details.trigger === "lock") {
    return [
      "**Merge-lock timeout.** Another merge held the lock past the timeout, so this cycle never got to " +
      "touch the integration worktree. Nothing is wrong with the branch itself.",
      "",
      "merge lock: timed out before touching the integration worktree.",
    ];
  }
  if (details.trigger === "sync") {
    return [
      "**Main out of sync.** orch could not fast-forward local main to origin, so it refused to land " +
      "against a possibly stale base rather than risk a bad merge.",
      "",
      `main sync: ${oneLine(details.mergeReason) || "failed"}`,
    ];
  }
  return [`trigger: ${details.trigger}`];
}

function nextStep(trigger, integrationBranch = "orch/integration") {
  switch (trigger) {
    case "overlap":
      return "next action: inspect the listed overlap, rebase or refresh the branch if needed, then rerun orch review before merging.";
    case "dirty-merge":
      // Do not open a per-change PR against main — that is a second trunk door
      // the standing integration PR exists to prevent. Hand-merge into the
      // integration branch; the integration → main PR remains the only gate.
      return `next action: hand-merge this branch into \`${integrationBranch}\` ` +
        `(resolve conflicts there); do not open a per-change PR against main. ` +
        `Land via the standing \`${integrationBranch} → main\` PR.`;
    case "integration-test":
      return "next action: fix the integrated test failure, then rerun orch review.";
    case "lock":
      return "next action: retry after the active merge finishes.";
    case "sync":
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

async function demote(ctx, deps, details) {
  const { orchDir, branch, sid, rounds, closes, runStats, cfg } = ctx;
  const { github, notify } = deps;
  const integrityFailure = reviewedHeadEscalation(ctx, deps);
  if (integrityFailure) return integrityFailure;
  const usage = totalUsage(runStats);
  const reason = demoteReason(ctx, details);
  const integrationBranch = details.integrationBranch || cfg?.integrationBranch || "orch/integration";

  // dirty-merge: never open a per-change agent PR against main. That path is a
  // second trunk door this repo forbids (CLAUDE.md); the standing
  // orch/integration → main PR is the only human gate. Escalate with the staged
  // branch + conflict detail so a human can hand-merge into integration — same
  // pattern as security-floor / round-cap escalations.
  let r;
  if (details.trigger === "dirty-merge") {
    notify.escalate(orchDir, branch,
      `# Escalation — ${branch}\n\n` +
      `Auto-merge demoted (\`dirty-merge\`). The agents agreed and tests are green, ` +
      `but this branch conflicts with \`${integrationBranch}\`.\n\n` +
      `**Do not open a PR from this branch to main.** Hand-merge it into ` +
      `\`${integrationBranch}\` (resolve conflicts there), then land via the ` +
      `standing \`${integrationBranch} → main\` PR.\n\n${reason}\n`);
    r = { prUrl: null };
  } else {
    r = await github.demote({ ...ctx, reason });
  }

  notify.recordRun(orchDir, {
    ts: new Date().toISOString(), branch, sid, verdict: "merge-deferred", trigger: details.trigger, reason, rounds,
    closes: closes ?? null,
    ...(usage.tokens ? { tokens: usage.tokens } : {}),
    ...(usage.costUsd != null ? { costUsd: usage.costUsd } : {}),
    ...(r.prUrl ? { prUrl: r.prUrl } : {}),
  });
  const peer = details.trigger === "overlap" && details.overlap?.peers?.length
    ? `; collides with ${details.overlap.peers.map((e) => `peer ${e.sid} on ${list(e.paths)}`).join("; ")}`
    : details.trigger === "overlap" && details.overlap?.peer?.length
      ? `; collides with a peer on ${list(details.overlap.peer)}`
      : "";
  const outcome = details.trigger === "dirty-merge"
    ? `escalated for hand-merge into ${integrationBranch}`
    : r.prUrl ? `opened PR ${r.prUrl}` : "kept the branch locally (no remote)";
  const summary = `${outcome}${peer}. Vetted: agents AGREE, tests green, security clean.`;
  const cls = triggerClass(details.trigger);
  return {
    status: "merge-deferred",
    trigger: details.trigger,
    reason: `${summary}\n${reason}`,
    prUrl: r.prUrl,
    class: cls,
    fingerprint: fingerprint(cls, demoteFingerprintSummary(details)),
  };
}

// design §7 normalizedSummary rule per class: LAND_DIRTY_MERGE fingerprints on
// the conflicted paths, LAND_OVERLAP on the peer paths; the rest have no
// per-attempt variable content worth isolating, so the trigger name is enough.
function demoteFingerprintSummary(details) {
  if (details.trigger === "dirty-merge") return `dirty-merge: ${conflictPaths(details.mergeReason).sort().join(",")}`;
  if (details.trigger === "overlap") {
    const paths = details.overlap?.peers?.length
      ? details.overlap.peers.flatMap((e) => e.paths || [])
      : (details.overlap?.peer || []);
    return `overlap: ${[...paths].sort().join(",")}`;
  }
  // "sync" (LAND_SYNC) has no design §7 normalizedSummary rule of its own and
  // details.mergeReason is deliberately not folded in here — trigger name only.
  return details.trigger;
}
