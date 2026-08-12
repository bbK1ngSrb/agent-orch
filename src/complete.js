// Post-run completion for a human at a terminal. After a successful `orch task`,
// a git-illiterate operator should be left in a clean, self-explained state: orch
// reports the integration PR, tidies the temporary branches and scratch state it created, and
// prints a plain-English summary. Anything that could irreversibly lose work is
// marked ❗, explained, and gated on the operator's [y/N] — never done silently.
//
// Pure orchestration over an injected git facade + io, so it unit-tests without
// touching a real repo. Idempotent by construction (re-running is a no-op once
// synced/detached/deleted), so the optional docs-update child can run it too.

import { formatInt, formatUsd } from "./usage.js";

export async function finishRun(ctx, deps) {
  const {
    repo, task, merged = [], interactive, docsPending = false, runStats = [],
    integrationBranch = "orch/integration", prUrls = [],
  } = ctx;
  const { git, io } = deps;

  const sha = git.git(["rev-parse", "--short", integrationBranch], repo);

  // Delete the branches orch created. The safe path refuses to drop anything not
  //    merged into integration, so it can never lose work; only an explicit,
  //    consented force-delete (-D) can — and only on a real terminal. Skip the
  //    operator branch: orch no longer moves a main checkout to a temporary branch.
  const toDelete = [...merged];
  const deleted = [];
  const leftover = [];
  for (const br of toDelete) {
    const res = git.deleteBranchSafe(repo, br, integrationBranch);
    if (res.ok) { deleted.push(br); continue; }
    if (res.unmerged && interactive) {
      const ok = await io.confirm(
        `❗ The branch "${br}" has changes that were never merged into ${integrationBranch}.\n` +
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

  io.print(summarize({ task, sha, deleted, leftover, docsPending, runStats, integrationBranch, prUrls }));
  return { deleted, leftover };
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
    const prev = rows.get(key) || { role, agent, model, tokens: 0, costUsd: 0, hasCost: false };
    prev.tokens += Number(stat.tokens) || 0;
    if (typeof stat.costUsd === "number") {
      prev.costUsd += stat.costUsd;
      prev.hasCost = true;
    }
    rows.set(key, prev);
  }
  const total = [...rows.values()].reduce((sum, row) => sum + row.tokens, 0);
  const totalCost = [...rows.values()].reduce((sum, row) => sum + (row.hasCost ? row.costUsd : 0), 0);
  const anyCost = [...rows.values()].some((row) => row.hasCost);
  const lines = ["Run statistics:"];
  for (const row of rows.values()) {
    const pct = total ? Math.round((row.tokens / total) * 100) : 0;
    const cost = row.hasCost ? ` (~${formatUsd(row.costUsd)})` : "";
    lines.push(`  • ${row.role} ${row.agent} used ${row.model}: ${formatInt(row.tokens)} tokens${cost} (${pct}%)`);
  }
  lines.push(`  • Total: ${formatInt(total)} tokens${anyCost ? ` (~${formatUsd(totalCost)})` : ""}`);
  return lines;
}

function summarize({ task, sha, deleted, leftover, docsPending, runStats, integrationBranch, prUrls }) {
  const L = [];
  L.push(`✅ All done — "${task}"`);
  L.push("");
  L.push("What happened:");
  L.push("  • Two AI agents wrote and reviewed the change; they agreed and the tests passed.");
  L.push(`  • It is now in ${integrationBranch} (${sha}) and ready locally.`);
  if (prUrls.length) L.push(`  • GitHub will advance main through ${prUrls[0]}.`);
  else L.push("  • Main was not changed locally; it advances only after the integration PR merges on GitHub.");
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
  if (leftover.length) {
    L.push("");
    L.push("⚠️ Needs your attention — these were left as-is:");
    for (const br of leftover) L.push(`  • branch "${br}" (kept — it has unmerged changes)`);
  }
  return L.join("\n");
}
