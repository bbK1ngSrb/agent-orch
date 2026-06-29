// Post-run completion for a human at a terminal. After a successful `orch task`,
// a git-illiterate operator should be left in a clean, self-explained state: orch
// saves to GitHub, tidies the temporary branches and scratch state it created, and
// prints a plain-English summary. Anything that could irreversibly lose work is
// marked ❗, explained, and gated on the operator's [y/N] — never done silently.
//
// Pure orchestration over an injected git facade + io, so it unit-tests without
// touching a real repo. Idempotent by construction (re-running is a no-op once
// synced/detached/deleted), so the optional docs-update child can run it too.

export async function finishRun(ctx, deps) {
  const { repo, task, operatorBranch, merged = [], interactive, docsPending = false, runStats = [] } = ctx;
  const { git, io } = deps;

  const sha = git.git(["rev-parse", "--short", "main"], repo);

  // 1. Sync - fast-forward push only. Never force. If origin/main advanced
  //    meanwhile, roll local main back to origin/main and stop loudly so later
  //    cycles do not base on an unpushable local merge.
  const push = git.pushMain(repo);
  if (!push.ok && git.resetMainToOriginIfDiverged) {
    const rollback = git.resetMainToOriginIfDiverged(repo);
    if (rollback.rolledBack) {
      throw new Error(
        `orch: push to origin/main failed after merging, and origin/main has advanced. ` +
        `Reset local main back to origin/main to avoid poisoning later cycles. ` +
        `Merged branch(es) kept for recovery: ${merged.join(", ")}. ` +
        `Push output: ${push.reason || "push failed"}`,
      );
    }
  }

  // 2. Free the operator's checkout. orch parks them on a fresh `orch/<slug>` branch
  //    at start (operatorBranch); detach onto the merged main tip so that branch can
  //    be deleted and they see the finished result. If orch never moved them
  //    (operatorBranch null = they were on their own branch), leave their checkout be.
  //    The merge already succeeded — a cleanup failure must NEVER surface as a crash
  //    (#44). Detach can refuse if uncommitted edits would be clobbered by the now-
  //    advanced main; degrade to leaving them where they are and saying so plainly.
  let detached = false;
  let parked = null;
  if (operatorBranch) {
    try { git.detachToMain(repo); detached = true; }
    catch { parked = operatorBranch; }
  }

  // 3. Delete the branches orch created. `branch -d` refuses to drop anything not
  //    merged into main, so the safe path can never lose work; only an explicit,
  //    consented force-delete (-D) can — and only on a real terminal. Skip the
  //    operator branch unless we actually freed it (it's still checked out otherwise).
  const toDelete = [...merged];
  if (operatorBranch && detached) toDelete.push(operatorBranch);
  const deleted = [];
  const leftover = [];
  for (const br of toDelete) {
    const res = git.deleteBranchSafe(repo, br);
    if (res.ok) { deleted.push(br); continue; }
    if (res.unmerged && interactive) {
      const ok = await io.confirm(
        `❗ The branch "${br}" has changes that were never merged into main.\n` +
        `   Deleting it permanently removes those changes. This CANNOT be undone.\n` +
        `   Delete "${br}" anyway? [y/N] `,
      );
      if (ok) {
        try { git.forceDeleteBranch(repo, br); deleted.push(br); continue; }
        catch { /* fall through to leftover */ }
      }
    }
    leftover.push(br);
  }

  io.print(summarize({ task, sha, push, deleted, leftover, operatorBranch, parked, docsPending, runStats }));
  return { pushed: push.ok, pushReason: push.reason, deleted, leftover, parked };
}

function formatInt(n) {
  return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function summarizeStats(runStats) {
  const measuredStats = runStats.filter((stat) => (Number(stat.tokens) || 0) > 0);
  if (!measuredStats.length) return [];
  const rows = new Map();
  for (const stat of measuredStats) {
    const role = stat.role || "agent";
    const agent = stat.agent || "unknown";
    const model = stat.model || "default";
    const key = `${role}\0${agent}\0${model}`;
    const prev = rows.get(key) || { role, agent, model, tokens: 0 };
    prev.tokens += Number(stat.tokens) || 0;
    rows.set(key, prev);
  }
  const total = [...rows.values()].reduce((sum, row) => sum + row.tokens, 0);
  const lines = ["Run statistics:"];
  for (const row of rows.values()) {
    const pct = total ? Math.round((row.tokens / total) * 100) : 0;
    lines.push(`  • ${row.role} ${row.agent} used ${row.model}: ${formatInt(row.tokens)} tokens (${pct}%)`);
  }
  lines.push(`  • Total: ${formatInt(total)} tokens`);
  return lines;
}

function summarize({ task, sha, push, deleted, leftover, operatorBranch, parked, docsPending, runStats }) {
  const L = [];
  L.push(`✅ All done — "${task}"`);
  L.push("");
  L.push("What happened:");
  L.push("  • Two AI agents wrote and reviewed the change; they agreed and the tests passed.");
  L.push(`  • It is now part of your project's main version (main, ${sha}).`);
  if (push.ok) {
    L.push("  • Saved to GitHub (origin/main is up to date).");
  } else {
    L.push(`  • ⚠️ Not saved to GitHub yet — ${push.reason || "push failed"}.`);
    L.push("    To save it yourself, run:  git push origin main");
  }
  if (deleted.length) {
    const n = deleted.length;
    L.push(`  • Tidied up ${n} temporary work ${n === 1 ? "branch" : "branches"} and orch's scratch files.`);
  }
  L.push("");
  const statsLines = summarizeStats(runStats);
  L.push(...statsLines);
  if (statsLines.length) L.push("");
  if (docsPending) {
    L.push("📝 A documentation update is still running in the background — it will be saved");
    L.push("   and tidied up the same way when it finishes.");
    L.push("");
  }
  if (parked) {
    L.push(`Couldn't move your checkout — you have uncommitted edits, so you're still on`);
    L.push(`"${parked}". Nothing was lost; commit or stash those edits, then you're free`);
    L.push("to switch away. (orch left this branch in place for you.)");
  } else if (operatorBranch) {
    L.push("You're now viewing the finished result. Git shows this as a \"detached\" view —");
    L.push("that's normal here and nothing is wrong; your work is safely on main.");
  }
  if (leftover.length) {
    L.push("");
    L.push("⚠️ Needs your attention — these were left as-is:");
    for (const br of leftover) L.push(`  • branch "${br}" (kept — it has unmerged changes)`);
  }
  return L.join("\n");
}
