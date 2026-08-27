// GitHub PR bridge. Fetches a PR head into a local branch, runs the orch
// audit cycle in review mode (never touching local main — GitHub owns the
// merge), posts the verdict as a PR comment, and optionally merges via the
// GitHub API. All shell-outs arrive via `deps` so tests stub them.
import { join } from "node:path";
import { parseRoleSpec, parseRoleSpecs } from "./config.js";
import { originRef, retryOnRefLock } from "./git.js";
import { redact, publicSummary } from "./redact.js";

// `gh pr merge` (without --auto/--admin) runs its own client-side "is this
// mergeable" precheck before ever calling the merge API, and that precheck
// doesn't know about GitHub ruleset bypass_actors — it sees "review
// required, no approval" and refuses, even for an actor the ruleset would
// actually let merge. Hitting the REST merge endpoint directly skips that
// broken precheck; GitHub evaluates bypass correctly there.
function mergeDirect(gh, prRef, method, sha = null) {
  const args = ["api", "-X", "PUT", `repos/{owner}/{repo}/pulls/${prRef}/merge`, "-f", `merge_method=${method}`];
  if (sha) args.push("-f", `sha=${sha}`);
  return gh(args);
}

function prNumberFromUrl(url) {
  return String(url || "").match(/\/pull\/(\d+)(?:\b|$)/)?.[1] || null;
}

// `gh` prints `gh: <message> (HTTP <code>)` on stderr for a REST/API failure;
// execFileSync folds that into error.stderr (or error.message when stderr is
// unavailable). Pulling the bare 3-digit code out of whichever text we have is
// the one place that turns a thrown error into an HTTP status — every caller
// below branches on that number, never on message text.
export function parseHttpStatus(e) {
  const msg = String(e?.stderr || e?.message || "");
  const m = msg.match(/\bHTTP (\d{3})\b/);
  return m ? Number(m[1]) : null;
}

function fallbackPrBody(reason, closes, method, prNumber = "<PR-number>") {
  const body = [
    "Merge deferred by agent-orch.",
    "",
    reason,
    "",
    "Manual merge note:",
    "- Plain `gh pr merge` can be refused by its bypass-blind precheck when a ruleset bypass would allow the merge.",
    `- If this PR is approved and checks are green, use: \`gh api -X PUT repos/{owner}/{repo}/pulls/${prNumber}/merge -f merge_method=${method}\``,
  ].join("\n");
  return redact(body) + (closes ? `\n\nCloses #${closes}` : "");
}

function refreshFallbackPrBody(gh, prNumber, body) {
  if (!prNumber) return;
  try { gh(["pr", "edit", prNumber, "--body", body]); } catch { /* PR is already open with the placeholder body */ }
}

function closingLinesFromIntegration(git, repo, base, branch) {
  let body;
  try {
    body = git(["log", "--format=%B", `${base}..${branch}`], repo);
  } catch {
    return "";
  }
  const seen = new Set();
  const lines = [];
  for (const match of String(body || "").matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi)) {
    if (seen.has(match[1])) continue;
    seen.add(match[1]);
    lines.push(`Closes #${match[1]}`);
  }
  return lines.length ? `\n\n${lines.join("\n")}` : "";
}

// Optional `sha` pins the merge to the commit this cycle verified. A concurrent
// cycle may advance the head after that — legitimate green work, not an
// intruder. Exactly two GitHub refusals are expected here and stay quiet:
//   - 405 "not mergeable" — checks still pending, review still missing, or the
//     PR is already merged. The common case; logging it every cycle is noise.
//   - 409 — head moved (with a sha pin) or the merge is conflicted. With a pin
//     we log once and leave the newer tip to the cycle that advanced it.
// Anything else — 401/403 (token expired or lacks permission), 404 (wrong PR
// ref, see #182), a malformed request, a network failure — is a real problem
// that recurs every cycle. Swallowing it makes it look identical to "not ready
// yet", so it gets logged. Still never throws: the PR is already open and the
// caller must not fail the cycle over a merge that can be retried.
function tryMergeDirect(gh, prRef, method, sha = null, log = () => {}) {
  const r = mergePrHeadBound(prRef, sha, method, { gh });
  if (r.result === "head-moved") {
    if (sha) log("integration advanced past the commit this cycle verified — the newer cycle will merge it");
    return;
  }
  if (r.result === "merged" || r.result === "blocked") return;
  log(`direct merge of ${prRef} failed with an unexpected error (not a "not ready yet" refusal): ${redact(r.message)}`);
}

// A statusCheckRollup entry is one of two shapes: a CheckRun (GitHub Actions /
// check-suite apps — has `status` + `conclusion`) or a StatusContext (the older
// commit-status API — has `state`). "Green" means every entry has reached a
// terminal, success-equivalent result:
//   - CheckRun: COMPLETED with SUCCESS, SKIPPED, or NEUTRAL. SKIPPED/NEUTRAL
//     count as passing because GitHub treats a skipped or neutral *required*
//     check as satisfied — dropping them would stall this direct merge forever
//     on any repo whose required checks include a path-filtered (skippable) job.
//   - StatusContext: SUCCESS only. PENDING and EXPECTED (a required context
//     GitHub is still waiting on) both keep us waiting — that "wait on a
//     not-yet-reported required context" is what makes this a "wait for required
//     checks" gate rather than a "whatever has reported so far is green" gate.
// Anything non-terminal or failing makes the whole rollup not-green. An empty
// rollup is green only when the required-checks read confirms there are no
// required contexts, and an unknown required-checks read always fails closed.
const PASSING_CONCLUSIONS = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);

function checkTerminalGreen(entry) {
  if (entry.status) return entry.status === "COMPLETED" && PASSING_CONCLUSIONS.has(entry.conclusion);
  if (entry.state) return entry.state === "SUCCESS";
  return false;
}

function checkPending(entry) {
  if (entry.status) return entry.status !== "COMPLETED";
  if (entry.state) return entry.state === "PENDING" || entry.state === "EXPECTED";
  return false;
}

function contextOf(entry) {
  return entry.context || entry.name;
}

// Design §9 rule 4: every reported entry must be terminal-green, every
// required context must be present, and an empty rollup is green only when the
// required set is known and empty. Keep this predicate shared by readiness and
// both merge paths so no caller can weaken the gate with an empty-rollup flag.
export function checksGreen(rollup, required) {
  const list = rollup || [];
  const failing = list.filter((e) => !checkTerminalGreen(e) && !checkPending(e)).map(contextOf);
  if (failing.length) return { state: "red", failing };
  if (list.some(checkPending)) return { state: "pending" };
  if (list.length === 0) {
    if (!required.known) return { state: "pending" };
    return { state: required.contexts.length === 0 ? "green" : "pending" };
  }
  if (!required.known) return { state: "unknown" };
  const requiredSet = new Set(required.contexts);
  for (const ctx of requiredSet) {
    if (!list.some((e) => contextOf(e) === ctx)) return { state: "pending" };
  }
  return { state: "green" };
}

function checksForPrMerge(prRef, base, deps) {
  const data = prView(prRef, ["baseRefName", "statusCheckRollup"], deps);
  return checksGreen(data.statusCheckRollup, requiredChecks(data.baseRefName || base, deps));
}

// `cached` is a mergeability read the caller already paid for. Pass it ONLY
// when nothing has touched the PR since — any write (update-branch, enabling
// auto-merge) can flip mergeStateStatus, so those paths must pass null and eat
// the round-trip.
function prHasConflicts(gh, prRef, cached = null) {
  const data = cached
    || JSON.parse(gh(["pr", "view", String(prRef), "--json", "mergeable,mergeStateStatus"]) || "{}");
  return data.mergeable === "CONFLICTING" || data.mergeStateStatus === "DIRTY";
}

// --- Design §9 read/write primitives — synchronous over deps.gh, HTTP status
// parsed from the thrown error, never message-text branching. ---

export function prView(n, fields, deps) {
  const f = Array.isArray(fields) ? fields.join(",") : fields;
  return JSON.parse(deps.gh(["pr", "view", String(n), "--json", f]) || "{}");
}

// The comments endpoint returns a JSON array per page; `--paginate` alone
// (no `--slurp`, absent before gh 2.47) concatenates those arrays into one
// flat array — exactly the list of comment objects callers expect.
export function listComments(n, { since } = {}, deps) {
  const args = ["api", `repos/{owner}/{repo}/issues/${n}/comments`, "--paginate"];
  if (since) args.push("-f", `since=${since}`);
  return JSON.parse(deps.gh(args) || "[]");
}

export function collaboratorPermission(login, deps) {
  try {
    const data = JSON.parse(deps.gh(["api", `repos/{owner}/{repo}/collaborators/${login}/permission`]) || "{}");
    return { ok: true, permission: data.permission, roleName: data.role_name };
  } catch (e) {
    return { ok: false, status: parseHttpStatus(e) };
  }
}

export function viewerPermission(deps) {
  const data = JSON.parse(deps.gh(["api", "repos/{owner}/{repo}"]) || "{}");
  const perms = data.permissions || {};
  return { push: !!perms.push, admin: !!perms.admin };
}

// Rules-API required_status_checks first; classic branch protection only when
// that comes back empty (a repo can have one or the other, not both). A 403
// on either read means the required set can't be determined at all.
export function requiredChecks(base, deps) {
  let contexts = [];
  try {
    const rules = JSON.parse(deps.gh(["api", `repos/{owner}/{repo}/rules/branches/${base}`]) || "[]");
    contexts = rules
      .filter((r) => r.type === "required_status_checks")
      .flatMap((r) => (r.parameters?.required_status_checks || []).map((c) => c.context));
  } catch (e) {
    if (parseHttpStatus(e) === 403) return { known: false, contexts: [] };
  }
  if (contexts.length) return { known: true, contexts };
  try {
    const data = JSON.parse(deps.gh(["api", `repos/{owner}/{repo}/branches/${base}/protection`]) || "{}");
    return { known: true, contexts: data.required_status_checks?.contexts || [] };
  } catch (e) {
    const status = parseHttpStatus(e);
    return status === 404 ? { known: true, contexts: [] } : { known: false, contexts: [] };
  }
}

export function findPrByHead(head, base, { includeDraft = true } = {}, deps) {
  const list = JSON.parse(deps.gh([
    "pr", "list", "--head", head, "--base", base, "--state", "open",
    "--json", "number,url,isDraft,headRefOid",
  ]) || "[]");
  const match = includeDraft ? list[0] : list.find((p) => !p.isDraft);
  return match ? { number: match.number, url: match.url, isDraft: !!match.isDraft, headRefOid: match.headRefOid } : null;
}

// Find-or-create: `gh pr create` exits nonzero ("a pull request for branch X
// into Y already exists") when the head already has an open PR — a bare
// create on a re-run would throw with no catch anywhere up to bin/orch.js.
export function createPr({ head, base, title, body, draft = false }, deps) {
  const { gh, log = () => {} } = deps;
  const existing = findPrByHead(head, base, { includeDraft: true }, deps);
  if (existing) {
    log(`PR already open for ${head}: ${existing.url}`);
    return { ...existing, created: false };
  }
  const args = ["pr", "create", "--head", head, "--base", base, "--title", redact(title), "--body", body];
  if (draft) args.push("--draft");
  const url = gh(args).trim();
  log(`opened PR for ${head}: ${url}`);
  return { number: Number(prNumberFromUrl(url)) || null, url, isDraft: !!draft, headRefOid: null, created: true };
}

// Create-or-edit-in-place: a hidden `<!-- orch:<marker> -->` tag identifies
// "our" comment across re-runs so a repeated call updates it instead of
// piling up a new comment every time.
export function commentOnce({ kind = "issue", target, body, marker }, deps) {
  const { gh } = deps;
  const tag = marker ? `<!-- orch:${marker} -->` : null;
  const tagged = tag ? `${tag}\n${body}` : body;
  const existing = tag && listComments(target, {}, deps).find((c) => String(c.body || "").includes(tag));
  const payload = JSON.stringify({ body: tagged });
  if (existing) {
    gh(["api", "-X", "PATCH", `repos/{owner}/{repo}/issues/comments/${existing.id}`, "--input", "-"], payload);
    return { id: existing.id, created: false };
  }
  const out = JSON.parse(gh(["api", "-X", "POST", `repos/{owner}/{repo}/issues/${target}/comments`, "--input", "-"], payload) || "{}");
  return { id: out.id, created: true };
}

// Head-bound merge: never throws on an HTTP failure — the caller decides what
// each discriminant means (blocked/rejected can be retried, head-moved needs
// a re-pin, not-found means the PR is gone).
export function mergePrHeadBound(n, headSha, method, deps) {
  try {
    const out = mergeDirect(deps.gh, n, method, headSha);
    let sha;
    try { sha = JSON.parse(out || "{}").sha; } catch { /* transport returned a non-JSON body; sha stays unknown */ }
    return { result: "merged", status: 200, message: "", sha };
  } catch (e) {
    const status = parseHttpStatus(e);
    const message = String(e?.stderr || e?.message || "");
    if (status === 409) return { result: "head-moved", status, message };
    if (status === 405) return { result: "blocked", status, message };
    if (status === 404) return { result: "not-found", status, message };
    return { result: "rejected", status, message };
  }
}

export function updateBranch(n, deps) {
  try {
    deps.gh(["api", "-X", "PUT", `repos/{owner}/{repo}/pulls/${n}/update-branch`]);
    return { ok: true };
  } catch (e) {
    return { ok: false, status: parseHttpStatus(e), message: String(e?.stderr || e?.message || "") };
  }
}

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
  const b = String(branch).replace(/[^\w./-]/g, "");
  const deferred = result.status === "merge-deferred";
  const head = deferred
    ? "⚠️ **agent-orch: MERGE DEFERRED** — this change is approved and green; orch opened a PR because it could not auto-land it. Details below."
    : "🛑 **agent-orch: ESCALATED** — orch gave up, no merge";
  // On the deferred path result.reason is already teaching-toned markdown (see
  // demoteReason in finalize.js) — render it as its own block instead of after a
  // flat `reason:` label, which would jam a markdown heading onto one line.
  const lines = deferred
    ? [head, "", `branch: ${b}`, `rounds: ${Number(result.rounds) || 0}`, "", String(result.reason)]
    : [head, "", `branch: ${b}`, `reason: ${result.reason}`, `rounds: ${Number(result.rounds) || 0}`];
  if (!deferred) {
    // §3f: reviewer prose stays out of the public comment (it can carry
    // attacker-controlled content from repo/task text); the full disagreement
    // is already on disk from notify.escalate() — point the maintainer at it.
    lines.push(
      "",
      "next steps:",
      `- full reviewer disagreement (private, not posted here): .orch/reviews/${b}/DECISION.md`,
      `- per-round detail: .orch/reviews/${b}/round-N.md`,
      `- once resolved: push a fix and \`orch review ${b}\` for a fresh audit, or open a PR manually`,
    );
  }
  return lines.join("\n");
}

export async function runPr(opts, deps) {
  const { n, repo, orchDir, cfg, merge = false, allowLargeScope = false } = opts;
  const { gh, git, cycle, log = () => {} } = deps;

  requireGh(gh);

  const pr = JSON.parse(gh(["pr", "view", String(n), "--json", "number,headRefName,state"]));
  if (pr.state && pr.state !== "OPEN") throw new Error(`PR #${pr.number} is ${pr.state}, not open`);

  const branch = `pr-${pr.number}`;
  const worktree = join(orchDir, "wt", branch);
  // Force-fetch so a re-run picks up new pushes to the PR.
  git(["fetch", "origin", `+pull/${pr.number}/head:${branch}`], repo);

  try {
    const reviewedSha = git(["rev-parse", branch], repo).trim();
    if (!reviewedSha) throw new Error(`orch pr #${pr.number}: could not resolve the fetched PR head`);

    // Review mode: reviewers default to the first configured agent; PR branch has no orch author.
    // Role specs ("<agent> [model] [effort]") are parsed so model/effort reach the adapters,
    // matching the task/review paths — otherwise a spec string becomes a bogus agent name.
    const reviewers = cfg.reviewers ? parseRoleSpecs(cfg.reviewers)
      : cfg.reviewer ? [parseRoleSpec(cfg.reviewer)]
      : [{ agent: cfg.agents[0], model: null, effort: null }];
    const reviewerName = reviewers[0].agent;
    const result = await cycle({
      mode: "review", noMerge: true, task: null, allowLargeScope, branch,
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
    // A hidden marker keeps this idempotent — a re-run edits the same PR
    // comment in place instead of piling up a new one every audit.
    commentOnce({ kind: "pr", target: n, body, marker: "verdict" }, deps);
    log(`commented on PR #${pr.number}: ${result.status}`);

    if (result.status === "approved" && merge) {
      // "approved" is orch's own agent verdict — it says nothing about the PR's
      // GitHub CI. Gate the merge on the status-check rollup, the same way the
      // integration PR path does, so a still-running or failing required check
      // holds the merge instead of relying on branch protection to catch it.
      // Fail closed: an unreadable rollup is not a green one.
      let green;
      try {
        green = checksForPrMerge(String(n), cfg.baseBranch || "main", deps).state === "green";
      } catch (e) {
        throw new Error(`orch pr #${pr.number}: could not read CI status before merging: ${e.message}`, { cause: e });
      }
      if (!green) {
        log(`PR #${pr.number} is approved but its checks are not green — not merging; re-run \`orch pr ${pr.number} --merge\` once CI settles`);
        return { ...result, mergeHold: "checks not green" };
      }
      const mergeResult = mergePrHeadBound(String(n), reviewedSha, cfg.github.mergeMethod, deps);
      if (mergeResult.result === "head-moved") {
        throw new Error(
          `orch pr #${pr.number}: the PR head moved during review — re-run \`orch pr ${pr.number} --merge\` to audit the new head`,
        );
      }
      if (mergeResult.result !== "merged") {
        throw new Error(
          `orch pr #${pr.number}: direct merge failed (HTTP ${mergeResult.status ?? "?"}): ${redact(mergeResult.message)}`,
        );
      }
      // gh reporting exit 0 isn't proof the commit is actually on origin/main —
      // squash/rebase merges mint a brand-new sha, so we can't just check the
      // pre-merge branch head; ask GitHub for the merge commit it produced and
      // confirm THAT sha is really there before calling this a "merged" success.
      const merged = JSON.parse(gh(["pr", "view", String(n), "--json", "state,mergeCommit"]));
      if (merged.state !== "MERGED" || !merged.mergeCommit?.oid) {
        throw new Error(
          `orch pr #${pr.number}: gh pr merge exited 0 but the PR is not reporting MERGED ` +
          `(state: ${merged.state}) — refusing to report a false "merged" success`,
        );
      }
      const base = cfg.baseBranch || "main";
      retryOnRefLock(() => git(["fetch", "origin", `${base}:${originRef(base)}`], repo));
      try {
        git(["merge-base", "--is-ancestor", merged.mergeCommit.oid, originRef(base)], repo);
      } catch {
        throw new Error(
          `orch pr #${pr.number}: gh reports PR merged (commit ${merged.mergeCommit.oid}) but it is ` +
          `not yet an ancestor of origin/${base} — refusing to report a false "merged" success`,
        );
      }
      log(`merged PR #${pr.number} via ${cfg.github.mergeMethod}, verified on origin/${base}`);
    }
    return result;
  } finally {
    // Best-effort cleanup — never let it mask a real error from the try block.
    try { git(["branch", "-D", "--", branch], repo); } // worktree already pruned by the cycle
    catch (e) { log(`warning: could not delete local branch ${branch}: ${e.message}`); }
  }
}

export function hasRemote(repo, git) {
  try { return git(["remote"], repo).trim().length > 0; } catch { return false; }
}

export function ghAvailable(gh) {
  try { requireGh(gh); return true; } catch { return false; }
}

export function requireGh(gh) {
  try { gh(["--version"]); }
  catch { throw new Error("gh CLI not found — install https://cli.github.com/ and run `gh auth login`"); }
}

// Shared push+create step for demote() and openPr(). §3f: --head must carry the
// real ref so gh finds the branch; the human-readable title is scrubbed (a
// secret-shaped branch name leaks through publicSummary's \w sanitizer otherwise).
async function pushAndCreatePr(ctx, deps, title, body, headSha = null) {
  const { repo, branch, cfg } = ctx;
  const { git } = deps;
  const base = cfg?.baseBranch || "main";
  const refspec = headSha ? `${headSha}:refs/heads/${branch}` : branch;
  git(["push", "-u", "origin", refspec], repo);
  return createPr({ head: branch, base, title, body }, deps).url;
}

// Demote an approved-but-unmergeable branch: open a PR if we can, else escalate
// locally (keep the branch + write DECISION.md). Never pushes straight to main.
export async function demote(ctx, deps) {
  const { repo, orchDir, branch, reviewedSha = null, reason, closes, cfg } = ctx;
  const { git, gh, notify, log = () => {} } = deps;
  if (!hasRemote(repo, git) || !ghAvailable(gh)) {
    notify.escalate(orchDir, branch,
      `# Escalation — ${branch}\n\nAuto-merge demoted.\n\n${reason}\n\nNo git remote or gh CLI available to open a PR. The branch is kept for manual review.\n`);
    return { prUrl: null };
  }
  // `fallbackPrBody()` appends `Closes #N` AFTER redact — it's our own int, and
  // redact would not touch it anyway, but keeping it outside the scrub
  // guarantees gh sees it intact.
  const mergeMethod = cfg?.github?.mergeMethod || "squash";
  const url = await pushAndCreatePr(ctx, deps, `orch: ${branch}`, fallbackPrBody(reason, closes, mergeMethod), reviewedSha);
  const prNumber = prNumberFromUrl(url);
  refreshFallbackPrBody(gh, prNumber, fallbackPrBody(reason, closes, mergeMethod, prNumber || "<PR-number>"));
  if (cfg?.github?.autoMergePr) {
    tryMergeDirect(gh, prNumber || branch, mergeMethod, reviewedSha, log);
  }
  return { prUrl: url };
}

// Success-path PR: cfg.merge === "pr" routes an AGREE+green cycle through a PR
// instead of git.mergeInWorktree, so branch protection / CI-gated merge checks
// still apply. cfg.github.autoMergePr additionally enables GitHub's native
// auto-merge on that PR, so solo/local runs can stay zero-friction while still
// leaving the audit trail a PR provides. Never pushes straight to main.
export async function openPr(ctx, deps) {
  const { repo, orchDir, branch, reviewedSha = null, cfg, closes } = ctx;
  const { git, gh, notify, log = () => {} } = deps;
  if (!hasRemote(repo, git) || !ghAvailable(gh)) {
    notify.escalate(orchDir, branch,
      `# Escalation — ${branch}\n\nmerge: pr requires a git remote and the gh CLI to open a PR; neither is available. The branch is kept for manual review.\n`);
    return { prUrl: null };
  }
  const body = redact("agent-orch: agents agreed and tests are green. Opened as a PR (merge: pr) instead of merging directly to main.")
    + (closes ? `\n\nCloses #${closes}` : "");
  const url = await pushAndCreatePr(ctx, deps, `orch: ${branch}`, body, reviewedSha);
  const prNumber = prNumberFromUrl(url);
  // The PR is already open at this point — a failure enabling GitHub's native
  // auto-merge (branch protection off, no merge queue, etc.) must not be
  // reported as a cycle failure; log it and hand back the PR we did open.
  if (cfg?.github?.autoMergePr) {
    try {
      const args = ["pr", "merge", branch, "--auto", `--${cfg.github.mergeMethod}`];
      if (reviewedSha) args.push("--match-head-commit", reviewedSha);
      gh(args);
      // GitHub's native auto-merge never fires if the only thing satisfying
      // the review requirement is a ruleset bypass_actor grant rather than a
      // real approval — mergeStateStatus stays BLOCKED forever even once
      // checks pass (verified empirically). Try an immediate direct merge
      // too: a no-op failure (checks still pending) is expected and safe to
      // swallow — native auto-merge covers the normal real-approval case.
      // The REST merge endpoint is keyed by PR *number*: passing the branch
      // name here 404s every time, which looks identical to a legitimate
      // not-ready-yet once swallowed (same defect #182 fixed for the
      // integration path).
      tryMergeDirect(gh, prNumber || branch, cfg.github.mergeMethod, reviewedSha, log);
    } catch (e) {
      log(`could not enable auto-merge for ${branch}: ${e.message}`);
    }
  }
  return { prUrl: url };
}

// Default local-merge landing bridge: the reusable integration branch is already
// merged, tested, and bumped locally. Push that branch and maintain one PR from
// it to main; GitHub owns the final main update.
export async function openIntegrationPr(ctx, deps) {
  const { repo, orchDir, cfg, integrationSha = null } = ctx;
  const branch = cfg.integrationBranch || "orch/integration";
  const base = cfg.baseBranch || "main";
  const { git, gh, notify, log = () => {}, resolveIntegrationConflict } = deps;
  // Tip this cycle verified and pushed — finalize threads it so we pin the
  // direct merge to that commit rather than re-resolving the branch name later.
  const tipSha = (integrationSha || "").trim() || null;
  if (!hasRemote(repo, git) || !ghAvailable(gh)) {
    notify.escalate?.(orchDir, branch,
      `# Escalation — ${branch}\n\nThe local integration branch is green, but a git remote and the gh CLI are required to open or update the PR to ${base}.\n`);
    return { prUrl: null };
  }

  const title = "orch: integrate green local cycles";
  const body = redact(
    `agent-orch: local integration passed. This persistent PR gates ${branch} into ${base}; ${base} is a GitHub mirror and is not advanced locally.`,
  ) + closingLinesFromIntegration(git, repo, base, branch);
  const refspec = tipSha ? `${tipSha}:refs/heads/${branch}` : branch;
  git(["push", "-u", "origin", refspec], repo);
  const open = JSON.parse(gh([
    "pr", "list",
    "--head", branch,
    "--base", base,
    "--state", "open",
    "--json", "number,url",
  ]) || "[]");

  let prRef;
  let url;
  if (open[0]) {
    prRef = String(open[0].number);
    url = open[0].url;
    // The body is NOT boilerplate: it carries one `Closes #N` line per issue
    // that landed on the integration branch, and GitHub only auto-closes those
    // issues by parsing the body when this PR merges. A skipped refresh means
    // the newest issue ships but stays open. Written over REST rather than
    // `gh pr edit`, which also selects the retired
    // `repository.pullRequest.projectCards` GraphQL field and exits nonzero on
    // that alone even when the edit itself is valid. Still non-fatal — REST can
    // fail for other reasons and this must never escalate a green+merged+pushed
    // cycle (#212) — but the log says what may be missing.
    try {
      gh(["api", "-X", "PATCH", `repos/{owner}/{repo}/pulls/${prRef}`, "-f", `title=${title}`, "-f", `body=${body}`]);
      log(`updated integration PR #${prRef}: ${url}`);
    } catch (e) {
      log(`integration PR #${prRef} body update failed (non-fatal) — it may be missing Closes references, so merging it may leave shipped issues open: ${e.message}`);
    }
  } else {
    url = gh([
      "pr", "create", "--head", branch, "--base", base,
      "--title", title,
      "--body", body,
    ]).trim();
    // mergeDirect() hits the REST endpoint keyed by numeric PR id, so prRef
    // must be that number, not the head-branch name — else the direct-merge
    // path 404s (#182). The number is right there in the create URL.
    prRef = prNumberFromUrl(url) || branch;
    log(`opened integration PR for ${branch}: ${url}`);
  }

  // Keep the persistent integration PR fresh. After any *other* PR merges into
  // `base`, this PR goes mergeStateStatus:BEHIND — clean (no conflict), but
  // un-mergeable until its branch absorbs those new base commits. GitHub exposes
  // that as the "Update branch" button; it is a pure fast-forward-style merge of
  // `base` into the head with no conflict to resolve, so orch does it itself
  // rather than waiting for a human — otherwise an unattended run freezes every
  // time anything else lands on `base`. Skip it when CONFLICTING: that state
  // routes to the conflict resolver below, not to a blind update. `gh` has no
  // first-class subcommand for this, so hit the REST endpoint (keyed by numeric
  // PR id, like mergeDirect) directly. A failure here is never fatal to a
  // green+merged+pushed cycle — the next cycle retries.
  let updatedFromBase = false;
  // Reused by the conflict check below, but only while it is still true: every
  // write to the PR clears it back to null so the next reader re-fetches.
  let mergeState = null;
  try {
    const state = JSON.parse(gh(["pr", "view", prRef, "--json", "mergeable,mergeStateStatus"]) || "{}");
    mergeState = state;
    if (state.mergeStateStatus === "BEHIND" && state.mergeable !== "CONFLICTING") {
      const res = updateBranch(prRef, deps);
      mergeState = null;
      if (res.ok) {
        updatedFromBase = true;
        log(`updated stale integration PR #${prRef} from ${base}`);
      } else {
        log(`could not update-branch integration PR #${prRef} (non-fatal): ${res.message}`);
      }
    }
  } catch (e) {
    mergeState = null;
    log(`could not update-branch integration PR #${prRef} (non-fatal): ${e.message}`);
  }
  if (cfg?.github?.autoMergePr) {
    mergeState = null;
    try {
      // The persistent integration branch must stay in main's ancestry. Squash
      // or rebase would strand orch/integration behind main after the first PR.
      // Requires the repo to allow merge-commit merges — see docs/ORCH.md.
      const args = ["pr", "merge", prRef, "--auto", "--merge"];
      if (tipSha && !updatedFromBase) args.push("--match-head-commit", tipSha);
      gh(args);
    } catch (e) {
      log(`could not enable auto-merge for ${branch}: ${e.message}`);
    }
  }
  if (cfg?.main?.autoResolveConflicts || (cfg?.main?.conflictResolution && cfg.main.conflictResolution !== "manual")) {
    try {
      if (prHasConflicts(gh, prRef, mergeState)) {
        const resolved = await resolveIntegrationConflict?.({ ...ctx, branch, base, prRef, prUrl: url });
        if (resolved?.ok) {
          log(`auto-resolved integration PR #${prRef}: ${resolved.summary || "resolved and pushed"}`);
        } else {
          const reason = resolved?.reason || "no conflict resolver is configured";
          log(`integration PR #${prRef} conflict auto-resolve skipped: ${reason}`);
          try {
            gh(["pr", "comment", prRef, "--body", redact(resolved?.comment || `agent-orch: auto-resolve was enabled, but the integration PR still needs a human: ${reason}`)]);
          } catch (e) {
            log(`could not comment on integration PR #${prRef}: ${e.message}`);
          }
        }
      }
    } catch (e) {
      log(`could not inspect or auto-resolve integration PR #${prRef}: ${e.message}`);
    }
  }
  // main.autoMerge runs alongside native auto-merge, not as an either/or. It is
  // gated on the shared §9 checksGreen predicate, so it holds until every
  // reported check — including a required context GitHub still lists as
  // EXPECTED — is terminal and green, and every required context is present.
  // (A required check GitHub never surfaces in the rollup at all keeps the
  // direct call from happening; the next cycle retries.) This direct merge is
  // the fallback that matters when native
  // auto-merge stays stuck at BLOCKED forever: if the review requirement is
  // satisfied by a ruleset bypass_actor grant rather than a real approval, GitHub
  // never auto-merges even after checks pass (verified empirically), and this
  // green-gated direct merge is the only thing that lands it. When native
  // auto-merge does work, the direct call is a harmless no-op (already merged),
  // swallowed by tryMergeDirect. The merge is pinned to tipSha so this cycle only
  // lands the commit it verified; if a concurrent cycle advanced the tip, a 409
  // is logged once and that newer cycle owns the merge.
  if (cfg?.main?.autoMerge) {
    try {
      if (checksForPrMerge(prRef, base, deps).state === "green") tryMergeDirect(gh, prRef, "merge", tipSha, log);
    } catch (e) {
      log(`could not inspect checks for ${branch}: ${e.message}`);
    }
  }
  return { prUrl: url };
}
