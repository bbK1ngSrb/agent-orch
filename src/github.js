// GitHub PR bridge. Fetches a PR head into a local branch, runs the orch
// audit cycle in review mode (never touching local main — GitHub owns the
// merge), posts the verdict as a PR comment, and optionally merges via the
// GitHub API. All shell-outs arrive via `deps` so tests stub them.
import { join } from "node:path";
import { parseRoleSpec, parseRoleSpecs } from "./config.js";

// Build the PR comment body from the cycle result + the reviewer's written case.
export function buildComment(result, verdict) {
  const approved = result.status === "approved";
  const head = approved
    ? "✅ **agent-orch: APPROVED** — agents agree, tests green"
    : "🛑 **agent-orch: NEEDS WORK** — review escalated";
  return [
    head,
    "",
    verdict || "(no reviewer notes captured)",
    "",
    `_${result.rounds} round(s); merge${approved ? " ready" : " blocked"} — GitHub owns the merge._`,
  ].join("\n");
}

export async function runPr(opts, deps) {
  const { n, repo, orchDir, cfg, merge = false } = opts;
  const { gh, git, cycle, readVerdict, log = () => {} } = deps;

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

    const verdict = readVerdict(orchDir, branch);
    const body = buildComment(result, verdict);
    gh(["pr", "comment", String(n), "--body-file", "-"], body);
    log(`commented on PR #${pr.number}: ${result.status}`);

    if (result.status === "approved" && merge) {
      gh(["pr", "merge", String(n), `--${cfg.github.mergeMethod}`]);
      log(`merged PR #${pr.number} via ${cfg.github.mergeMethod}`);
    }
    return result;
  } finally {
    // Best-effort cleanup — never let it mask a real error from the try block.
    try { git(["branch", "-D", branch], repo); } // worktree already pruned by the cycle
    catch (e) { log(`warning: could not delete local branch ${branch}: ${e.message}`); }
  }
}

function hasRemote(repo, git) {
  try { return git(["remote"], repo).trim().length > 0; } catch { return false; }
}

function ghAvailable(gh) {
  try { gh(["--version"]); return true; } catch { return false; }
}

// Demote an approved-but-unmergeable branch: open a PR if we can, else escalate
// locally (keep the branch + write DECISION.md). Never pushes to main.
export async function demote(ctx, deps) {
  const { repo, orchDir, branch, reason } = ctx;
  const { gh, git, notify, log = () => {} } = deps;
  if (!hasRemote(repo, git) || !ghAvailable(gh)) {
    notify.escalate(orchDir, branch,
      `# Escalation — ${branch}\n\nAuto-merge demoted (reason: ${reason}). No git remote or gh CLI available to open a PR. The branch is kept for manual review.\n`);
    return { prUrl: null };
  }
  git(["push", "-u", "origin", branch], repo);
  const url = gh([
    "pr", "create", "--head", branch, "--base", "main",
    "--title", `orch: ${branch}`,
    "--body", `Auto-demoted by agent-orch (reason: ${reason}). Agents agreed and the branch was green in isolation, but it could not be safely auto-merged into main.`,
  ]).trim();
  log(`opened PR for ${branch}: ${url}`);
  return { prUrl: url };
}
