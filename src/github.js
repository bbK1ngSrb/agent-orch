// GitHub PR bridge. Fetches a PR head into a local branch, runs the orch
// audit cycle in review mode (never touching local main — GitHub owns the
// merge), posts the verdict as a PR comment, and optionally merges via the
// GitHub API. All shell-outs arrive via `deps` so tests stub them.
import { join } from "node:path";
import { parseRoleSpec, parseRoleSpecs } from "./config.js";
import { redact, publicSummary } from "./redact.js";

// Build the PR comment body. §3f: `body` is the constrained machine summary
// (publicSummary), never attacker-influenced reviewer prose — those notes stay
// in the maintainer's private channel (.orch/reviews/).
export function buildComment(result, body) {
  const approved = result.status === "approved";
  const head = approved
    ? "✅ **agent-orch: APPROVED** — agents agree, tests green"
    : "🛑 **agent-orch: NEEDS WORK** — review escalated";
  return [
    head,
    "",
    body || "(no summary)",
    "",
    `_${result.rounds} round(s); merge${approved ? " ready" : " blocked"} — GitHub owns the merge._`,
  ].join("\n");
}

// §3f: issue-bridge escalation comment. Same machine-summary-only discipline
// as buildComment's PR path — result.reason is our own diagnostic text (scope
// caps, stalemate, protected paths, adapter stderr tail), never attacker prose,
// but the caller still redacts it before posting.
export function buildIssueComment(result, branch) {
  const head = result.status === "pr-fallback"
    ? "⚠️ **agent-orch: PR FALLBACK** — could not auto-merge, opened a PR for manual review"
    : "🛑 **agent-orch: ESCALATED** — orch gave up, no merge";
  return [
    head,
    "",
    `branch: ${String(branch).replace(/[^\w./-]/g, "")}`,
    `reason: ${result.reason}`,
    `rounds: ${Number(result.rounds) || 0}`,
  ].join("\n");
}

export async function runPr(opts, deps) {
  const { n, repo, orchDir, cfg, merge = false } = opts;
  const { gh, git, cycle, log = () => {} } = deps;

  try { gh(["--version"]); }
  catch { throw new Error("gh CLI not found — install https://cli.github.com/ and run `gh auth login`"); }

  const pr = JSON.parse(gh(["pr", "view", String(n), "--json", "number,headRefName,state"]));
  if (pr.state && pr.state !== "OPEN") throw new Error(`PR #${pr.number} is ${pr.state}, not open`);

  const branch = `pr-${pr.number}`;
  const worktree = join(orchDir, "wt", branch);
  // Force-fetch so a re-run picks up new pushes to the PR.
  git(["fetch", "origin", `+pull/${pr.number}/head:${branch}`], repo);

  try {
    // Review mode: reviewers default to the first configured agent; PR branch has no orch author.
    // Role specs ("<agent> [model] [effort]") are parsed so model/effort reach the adapters,
    // matching the task/review paths — otherwise a spec string becomes a bogus agent name.
    const reviewers = cfg.reviewers ? parseRoleSpecs(cfg.reviewers)
      : cfg.reviewer ? [parseRoleSpec(cfg.reviewer)]
      : [{ agent: cfg.agents[0], model: null, effort: null }];
    const reviewerName = reviewers[0].agent;
    const result = await cycle({
      mode: "review", noMerge: true, task: null, branch,
      authorName: reviewerName, reviewers, cfg, orchDir, repo, worktree,
    });

    // §3f: post the machine summary only — reviewer prose never reaches the
    // public PR. redact is the final scrub on the exact bytes sent to gh.
    const approved = result.status === "approved";
    const summary = publicSummary({
      decision: approved ? "AGREE" : "DISAGREE",
      green: approved, // review mode escalates before the gate; approved ⇒ green
      branch,
      rounds: result.rounds,
    });
    const body = redact(buildComment(result, summary));
    gh(["pr", "comment", String(n), "--body-file", "-"], body);
    log(`commented on PR #${pr.number}: ${result.status}`);

    if (result.status === "approved" && merge) {
      gh(["pr", "merge", String(n), `--${cfg.github.mergeMethod}`]);
      log(`merged PR #${pr.number} via ${cfg.github.mergeMethod}`);
    }
    return result;
  } finally {
    // Best-effort cleanup — never let it mask a real error from the try block.
    try { git(["branch", "-D", "--", branch], repo); } // worktree already pruned by the cycle
    catch (e) { log(`warning: could not delete local branch ${branch}: ${e.message}`); }
  }
}

function hasRemote(repo, git) {
  try { return git(["remote"], repo).trim().length > 0; } catch { return false; }
}

function ghAvailable(gh) {
  try { gh(["--version"]); return true; } catch { return false; }
}

// Shared push+create step for demote() and openPr(). §3f: --head must carry the
// real ref so gh finds the branch; the human-readable title is scrubbed (a
// secret-shaped branch name leaks through publicSummary's \w sanitizer otherwise).
async function pushAndCreatePr(ctx, deps, title, body) {
  const { repo, branch } = ctx;
  const { gh, git, log = () => {} } = deps;
  git(["push", "-u", "origin", branch], repo);
  const url = gh([
    "pr", "create", "--head", branch, "--base", "main",
    "--title", redact(title),
    "--body", body,
  ]).trim();
  log(`opened PR for ${branch}: ${url}`);
  return url;
}

// Demote an approved-but-unmergeable branch: open a PR if we can, else escalate
// locally (keep the branch + write DECISION.md). Never pushes to main.
export async function demote(ctx, deps) {
  const { repo, orchDir, branch, reason, closes } = ctx;
  const { git, gh, notify } = deps;
  if (!hasRemote(repo, git) || !ghAvailable(gh)) {
    notify.escalate(orchDir, branch,
      `# Escalation — ${branch}\n\nAuto-merge demoted (reason: ${reason}). No git remote or gh CLI available to open a PR. The branch is kept for manual review.\n`);
    return { prUrl: null };
  }
  // A `Closes #N` line (issue bridge) is appended AFTER redact — it's our own
  // int, and redact would not touch it anyway, but keeping it outside the
  // scrub guarantees gh sees it intact.
  const body = redact(`Auto-demoted by agent-orch (reason: ${reason}). Agents agreed and the branch was green in isolation, but it could not be safely auto-merged into main.`)
    + (closes ? `\n\nCloses #${closes}` : "");
  const url = await pushAndCreatePr(ctx, deps, `orch: ${branch}`, body);
  return { prUrl: url };
}

// Success-path PR: cfg.merge === "pr" routes an AGREE+green cycle through a PR
// instead of git.mergeInWorktree, so branch protection / CI-gated merge checks
// still apply. cfg.github.autoMergePr additionally enables GitHub's native
// auto-merge on that PR, so solo/local runs can stay zero-friction while still
// leaving the audit trail a PR provides. Never pushes straight to main.
export async function openPr(ctx, deps) {
  const { repo, orchDir, branch, cfg, closes } = ctx;
  const { git, gh, notify, log = () => {} } = deps;
  if (!hasRemote(repo, git) || !ghAvailable(gh)) {
    notify.escalate(orchDir, branch,
      `# Escalation — ${branch}\n\nmerge: pr requires a git remote and the gh CLI to open a PR; neither is available. The branch is kept for manual review.\n`);
    return { prUrl: null };
  }
  const body = redact("agent-orch: agents agreed and tests are green. Opened as a PR (merge: pr) instead of merging directly to main.")
    + (closes ? `\n\nCloses #${closes}` : "");
  const url = await pushAndCreatePr(ctx, deps, `orch: ${branch}`, body);
  // The PR is already open at this point — a failure enabling GitHub's native
  // auto-merge (branch protection off, no merge queue, etc.) must not be
  // reported as a cycle failure; log it and hand back the PR we did open.
  if (cfg?.github?.autoMergePr) {
    try {
      gh(["pr", "merge", branch, "--auto", `--${cfg.github.mergeMethod}`]);
    } catch (e) {
      log(`could not enable auto-merge for ${branch}: ${e.message}`);
    }
  }
  return { prUrl: url };
}
