// Integration repair (design docs/cli-v2-design.md §10A): repairs the branch
// behind a standing/per-cycle PR that readiness reported as BEHIND — whether or
// not this run caused it. (CONFLICTING and CI-red are the same remedy's other
// two classes; see the slice note below.)
//
// Lock discipline (design §12): the run takes the non-blocking
// `integration-repair.lock` before ANY repair, and only takes `merge.lock`
// (the next lock in §12's order) around the part that touches the shared
// integration worktree / pushes. A peer holding the repair lock means this run
// starts no agent and gives its attempt back — the caller re-polls readiness.
//
// REMOTE_BEHIND (split 4a) is the agent-free path: GitHub's server-side
// update-branch, a gate run on the result, and the landing below.
// REMOTE_CONFLICTING / REMOTE_CI_RED (split 4b, #569) add a resolver agent, a
// security scan and a reviewer audit in front of that same landing.
//
// Work runs in a scratch worktree checked out on a throwaway LOCAL branch,
// never in the persistent integration worktree `finalize` owns and never
// detached: the gate must see the repaired tip, and `audit(branch, wd)` renders
// a prompt naming `refs/heads/<branch>` — a detached scratch would have the
// reviewer audit the PRE-repair tip and fail open.
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { checkPaths } from "./intake/allowlist.js";
import { parseRoleSpecs } from "./config.js";
import { scanDiff, parseRawPaths, SECURITY_DIFF_ARGS, SECURITY_RAW_ARGS } from "./security-review.js";
import * as lockDefault from "./lock.js";
import { LOCK_NAMES } from "./lock.js";
import { updateBranch } from "./github.js";
import { redact } from "./redact.js";
import { frameUntrustedReference, neutralizeFence } from "./intake/workorder.js";

const DEFAULT_RESOLVERS = [{ agent: "claude", model: null, effort: null }];

// git's own wording for "someone else moved the ref under you", across the
// versions/locales that keep the English message: the only push failure a
// retry can clear. Matched against `gitTry`'s `.out`, which carries stderr
// (git.js:62) — that is where git writes the rejection.
const PUSH_RACE_RE = /non-fast-forward|fetch first|stale info|remote contains work/i;

function errorText(error) {
  return String(error?.message || error || "unknown error").trim();
}

// Byte-for-byte the same rule cli.js:727 applies to an in-cycle conflict, so
// the two conflict paths cannot drift: `conflictResolution` wins, the
// deprecated `autoResolveConflicts` boolean is the fallback, and the default is
// `manual`.
function modeOf(cfg) {
  return cfg.main?.conflictResolution || (cfg.main?.autoResolveConflicts ? "auto" : "manual");
}

// #56/#58: every stage this file starts must carry the same wall-clock watchdog
// cli.js passes to the cycle's own stages — a hung resolver here would
// otherwise stall an unattended `--until` run while holding
// `integration-repair.lock`. Four call sites today (see LOCKED_STAGES).
function stageTimeoutMs(cfg) {
  return cfg.stageTimeout > 0 ? cfg.stageTimeout * 60_000 : 0;
}

// Seat the resolver the way the cycle seats its own roles: the same rotation
// cli.js's `conflictResolvers` runs, over the same `last-conflict-resolver`
// cursor, so a repair and an in-cycle conflict resolution share one turn order
// instead of this path pinning pool entry zero forever. Advanced eagerly —
// before we know whether a resolver will actually run — exactly as cli.js does,
// which is also what makes a dead seat fail over: a repair whose resolver
// throws leaves the cursor advanced, so the next attempt starts on the next
// seat. Called ONCE per repair; rotating again for the reviewer would
// double-advance the shared cursor.
function resolverPoolOf(cfg, orchDir) {
  const pool = cfg.main?.conflictResolutionResolvers || DEFAULT_RESOLVERS;
  if (pool.length < 2 || !orchDir) return pool;
  mkdirSync(orchDir, { recursive: true });
  const cursor = join(orchDir, "last-conflict-resolver");
  const last = existsSync(cursor) ? Number.parseInt(readFileSync(cursor, "utf8"), 10) : -1;
  const start = Number.isInteger(last) ? (last + 1) % pool.length : 0;
  writeFileSync(cursor, String(start));
  return pool.slice(start).concat(pool.slice(0, start));
}

// Fail-closed, in the same shape `resolveIntegrationConflict` (cli.js) uses: an
// audit only proves something when the auditor differs from the resolver. A
// single-agent pool finds nobody here and the repair refuses rather than
// letting the resolver bless its own work.
function reviewerFor(cfg, resolverAgent, resolvers) {
  const pool = [
    ...resolvers,
    // Same three sources, same order, as cli.js's `conflictReviewerFor`:
    // dropping `cfg.reviewers` here makes a repo that configures roles instead
    // of a bare `agents:` pool find no differing seat and fail every repair.
    ...(cfg.reviewers?.length ? parseRoleSpecs(cfg.reviewers) : []),
    ...(cfg.agents || []).map((agent) => ({ agent, model: null, effort: null })),
  ];
  return pool.find((spec) => spec?.agent && spec.agent !== resolverAgent) || null;
}

// Fail closed on an unreadable diff: every path floor below reads its input
// from one of these, and `gitTry` puts the ERROR TEXT in `.out`. Unchecked, a
// failed diff parses to an empty path list, which reads downstream as "the
// resolver touched nothing" — empty scan, clean gate, push.
function diffOut(git, wd, args) {
  const run = git.gitTry(["diff", ...args], wd);
  return run.ok ? { ok: true, out: run.out } : { ok: false, reason: `could not read the repair diff (git diff ${args.join(" ")}): ${run.out.trim()}` };
}

// -z NUL-split (as changedFiles/#383 does) so a path with a leading space or a
// newline survives intact.
function conflictedPathsIn(git, wd) {
  const listed = git.gitTry(["diff", "--name-only", "-z", "--diff-filter=U"], wd);
  return listed.ok ? listed.out.split("\0").filter(Boolean) : [];
}

export function resolverPrompt({ branch, base, cls, failure, conflicts }) {
  const ref = [
    conflicts.length
      ? `Integration repair on ${neutralizeFence(branch)}: merging origin/${neutralizeFence(base)} produced a merge conflict.`
      : `Integration repair on ${neutralizeFence(branch)}: red checks after merging origin/${neutralizeFence(base)}.`,
    "",
    `Failure class: ${neutralizeFence(cls)}`,
    failure?.summary ? `Details: ${neutralizeFence(failure.summary)}` : null,
    conflicts.length
      ? `Conflicted files: ${conflicts.map((path) => neutralizeFence(path)).join(", ")}`
      : null,
  ].filter((line) => line !== null).join("\n");

  return [
    frameUntrustedReference(ref),
    conflicts.length
      ? "Act as a neutral third party; reconstruct both parents' intent. Preserve behavior from both sides unless truly incompatible."
      : "Fix only the named failing check(s); do not widen scope.",
    "Resolve everything, stage the result, and commit it. Do not edit unrelated files.",
  ].filter((line) => line !== null).join("\n");
}

function proposalComment({ mode, cls, sha, branch, paths, resolver }) {
  return [
    "agent-orch: conflict resolution needs human approval.",
    "",
    `Mode: ${mode}`,
    `Class: ${cls}`,
    `Resolution: ${sha}`,
    `Resolution branch: ${branch}`,
    `Review with: git show ${sha} or git diff ${branch}^..${sha}`,
    paths.length ? `Files: ${paths.join(", ")}` : null,
    `Resolver: ${resolver}`,
    "Evidence: the local scratch branch is preserved so this resolution remains available after the repair returns.",
  ].filter((line) => line !== null).join("\n");
}

function addScratch(git, repo, orchDir, ref, branchName) {
  const path = join(orchDir, "wt", branchName);
  // -B, not --detach: a named branch is what #569's reviewer audits.
  const added = git.gitTry(["worktree", "add", "-B", branchName, path, ref], repo);
  return added.ok ? path : null;
}

// Point the LOCAL `refs/heads/<branch>` at the repaired tip. The integration
// branch already gets this through `reconcileIntegrationToOrigin` on the
// persistent worktree; a per-cycle PR branch has no worktree of its own once
// the cycle ended, so nothing else moves its ref. That matters because
// `resolveLanded` (cli.js) reads exactly this ref for readiness's
// `expectedHead`, and readiness rule 2 only re-pins a moved head for
// `landing: "standing"` — leaving the ref at the pre-repair sha turns every
// successful per-cycle repair into REMOTE_UNKNOWN.
// Fast-forward only, the same discipline `reconcileIntegrationToOrigin` uses: a
// local branch carrying commits the repaired tip does not have is a real
// divergence, and moving the ref would orphan them.
// The divergence half of `syncLocalBranch`, split out so the push can ask the
// same question BEFORE it moves origin. Returns a reason, or null when the ref
// can be fast-forwarded. Always null on the integration branch: there the local
// worktree is merged into the pushed tip first, so it cannot be left behind.
function localDivergence(git, repo, ctx, sha) {
  if (ctx.branch === ctx.integrationBranch) return null;
  const local = git.gitTry(["rev-parse", "-q", "--verify", `refs/heads/${ctx.branch}`], repo);
  return local.ok && !git.gitTry(["merge-base", "--is-ancestor", local.out.trim(), sha], repo).ok
    ? `local ${ctx.branch} has diverged from the repaired tip`
    : null;
}

function syncLocalBranch(git, repo, ctx, sha) {
  if (ctx.branch === ctx.integrationBranch) return { ok: true };
  const diverged = localDivergence(git, repo, ctx, sha);
  if (diverged) return { ok: false, reason: diverged };
  const updated = git.gitTry(["update-ref", `refs/heads/${ctx.branch}`, sha], repo);
  return updated.ok ? { ok: true } : { ok: false, reason: `could not update local ${ctx.branch}: ${updated.out.trim()}` };
}

function dropScratch(git, repo, path, branchName) {
  git.pruneWorktree(repo, path);
  git.gitTry(["branch", "-D", branchName], repo);
}

// Takes a tip that has already been gated and — once #569 lands a resolver —
// audited, and makes it origin's. Every repair path lands through here, so the
// guards below exist once instead of once per caller.
//
// The caller must NOT hold `merge.lock`; this acquires it (§12 order:
// `integration-repair.lock` -> `merge.lock`). Returns:
//   { ok: true, sha }                          // origin now carries `sha`
//   { ok: false, precondition: true, reason }  // lock timed out; nothing happened
//   { ok: false, raced: true, reason }          // push lost the race; origin untouched, local rolled back
//   { ok: false, reason }                       // reconcile / merge / re-gate refused
//
// `raced` is a fact about the LANDING, not a verdict on the attempt: only the
// caller knows whether it spent an agent stage before getting here. A caller
// that spent nothing gives the attempt back (retry is free); one that ran a
// resolver keeps it. A persistently lost race is bounded by run-controller.js's
// MAX_REMEDY_LOOPS, so no counter is needed here.
async function landRepairedTip(ctx, deps, { sha }) {
  const { orchDir, repo, branch, base, cfg } = ctx;
  const { git, gate } = deps;
  const lock = deps.lock || lockDefault;
  if (!(await lock.acquireBlocking(orchDir, LOCK_NAMES.MERGE))) {
    return { ok: false, precondition: true, reason: "merge.lock timed out" };
  }
  try {
    // Local worktree FIRST, push second. The repaired tip was built on
    // `origin/<branch>`, so any commit that exists only in the persistent
    // integration worktree (landed locally, not yet pushed) is not in `sha`:
    // pushing that first strands those commits behind a tip that does not
    // contain them, and the ff-only reconcile that used to follow could then
    // never bring local forward. Merging into the persistent worktree first
    // makes the pushed sha contain both sides or fail here with origin
    // untouched.
    let pushSha = sha;
    let rollback = null;
    if (branch === ctx.integrationBranch) {
      const integration = git.ensureIntegrationWorktree(repo, orchDir, branch, base);
      // The merge below is the WHOLE reconciliation, deliberately: it covers
      // local-behind (fast-forward), local-equal (no-op), local-ahead (already
      // up to date) and local-diverged (a real merge commit) in one step. There
      // used to be an ff-only `reconcileIntegrationToOrigin` in front of it,
      // and on this path it was unrecoverable: `updateBranch` has ALREADY moved
      // origin by the time we get here, so a persistent worktree carrying its
      // own unpushed commits is diverged by construction — the exact state the
      // merge-first ordering exists to handle — and refusing stranded those
      // commits for good (nothing else in the run merges them, and `finalize`'s
      // landing hits the same ff-only wall). Merging rewrites and discards
      // nothing, the re-gate below covers the tree no gate has seen, and the
      // plain push still has to fast-forward origin — so the guard bought
      // safety only in the sense that doing nothing is safe.
      // Plain merge, not `--ff-only`, for the same reason: fast-forwarding is
      // exactly the case that fails when local carries its own commits.
      // The persistent worktree is shared with `finalize` and outlives every
      // cycle, so an interrupted landing can leave modified or untracked files
      // in it. Those survive the merge, so the re-gate below would run against
      // a tree `git push` never publishes — destroying the one property the
      // re-gate exists to provide, that the gated tree IS the pushed tree.
      // Clean rather than refuse: the dirt is not self-clearing, so a refusal
      // would refuse again on every retry and §10A gives REMOTE_BEHIND no other
      // remedy. Same `reset --hard` + `clean -fd` pair as `rollback()` below,
      // and safe for the same reason: this is orch's own worktree, held under
      // `merge.lock`. `HEAD`, not origin's tip — the worktree legitimately
      // carries commits that were landed locally and not yet pushed, and this
      // discards working-tree dirt, not history. `-fd`, not `-fdx`: ignored
      // files (node_modules) are what lets the re-gate run at all, and they
      // never reach the pushed tree anyway.
      if (git.gitTry(["status", "--porcelain"], integration).out.trim()) {
        git.gitTry(["reset", "--hard", "HEAD"], integration);
        git.gitTry(["clean", "-fd"], integration);
        // A worktree that resisted the clean will resist it again, so this is a
        // plain refusal, not a `precondition` one: refunding the attempt would
        // spend the controller's remedy loops re-running a repair that cannot
        // succeed.
        const stillDirty = git.gitTry(["status", "--porcelain"], integration).out.trim();
        if (stillDirty) return { ok: false, reason: `could not clean the ${branch} worktree before merging: ${stillDirty}` };
      }
      const preMergeSha = git.gitTry(["rev-parse", "HEAD"], integration).out.trim();
      const merged = git.gitTry(["merge", "--no-edit", sha], integration);
      if (!merged.ok) {
        git.gitTry(["merge", "--abort"], integration);
        return { ok: false, reason: `could not merge the repaired tip into local ${branch}: ${merged.out.trim()}` };
      }
      pushSha = git.gitTry(["rev-parse", "HEAD"], integration).out.trim();
      // Merging locally before the push means a LOST push race now leaves a
      // merge commit behind: origin has the peer's landing, local has ours,
      // and neither is an ancestor of the other — a divergence that wedges
      // `finalize`'s own landing path, not just the next repair. Put the
      // worktree back the way we found it. Same `reset --hard` + `clean -fd`
      // cli.js's `resetMergeAttempt` uses, and safe for the same reason: this
      // is orch's own integration worktree, held under `merge.lock`.
      rollback = () => {
        git.gitTry(["reset", "--hard", preMergeSha], integration);
        git.gitTry(["clean", "-fd"], integration);
      };
      // The gate ran on the tip we were handed, so a real merge would push a
      // tree the gate never saw. Re-run it against the merged state — the same
      // guard `finalize.js:233` already applies to the same branch at the same
      // point in its life, under the same lock and with the same #56/#58
      // wall-clock cap. A genuine fast-forward needs none: the pushed tree IS
      // the gated tree.
      if (pushSha !== sha) {
        const testCmd = cfg.test === "auto" ? gate.detect(integration) : cfg.test;
        if (!gate.run(testCmd, integration, stageTimeoutMs(cfg)).pass) {
          rollback();
          return { ok: false, reason: `gate red on ${branch} with the repaired tip merged in` };
        }
      }
    }
    // Ask about local divergence BEFORE origin moves. A per-cycle branch has no
    // worktree left, so a local ref carrying commits the repaired tip lacks is
    // the one case nothing merges in: pushing first would leave those commits
    // reachable only from a local ref that can never fast-forward again, and the
    // post-push `syncLocalBranch` below could then only report it. On the
    // integration branch this is a deliberate no-op — the local-merge-first
    // ordering above already folded local's own commits into `pushSha`.
    const diverged = localDivergence(git, repo, ctx, pushSha);
    if (diverged) {
      rollback?.();
      return { ok: false, reason: diverged };
    }
    // A plain (non-force) push IS the "integration moved during repair"
    // check, and the server does it atomically: git rejects the ref update
    // unless `pushSha` fast-forwards whatever origin holds right now.
    const pushed = git.gitTry(["push", "origin", `${pushSha}:refs/heads/${branch}`], repo);
    if (!pushed.ok) {
      rollback?.();
      // Only a non-fast-forward rejection is the race this path means by
      // `raced`; auth, branch protection and pre-receive hooks all fail the
      // same push and would repeat identically. Handing those a free attempt
      // back (repairBehind) spends the controller's remedy loops re-running a
      // repair that cannot succeed, and hides the real error behind the cap.
      const raced = PUSH_RACE_RE.test(pushed.out);
      return { ok: false, ...(raced ? { raced: true } : {}), reason: `push rejected: ${pushed.out.trim()}` };
    }
    // Origin already carries the repair — a failure here is reported, not
    // rolled back.
    const synced = syncLocalBranch(git, repo, ctx, pushSha);
    if (!synced.ok) return synced;
    return { ok: true, sha: pushSha };
  } finally {
    lock.releaseLock(orchDir, LOCK_NAMES.MERGE);
  }
}

// REMOTE_BEHIND: GitHub's own update-branch merges base in server-side, and
// that merge result was never tested anywhere. Re-run the gate on the new tip
// before readiness is re-read. No agent runs anywhere on this path.
async function repairBehind(ctx, deps) {
  const { orchDir, repo, branch, cfg, prNumber, scratchBranch } = ctx;
  const { git, gate, gh } = deps;
  if (!prNumber) return { ok: false, precondition: true, reason: "no PR number to update" };
  const updated = updateBranch(prNumber, { gh });
  if (!updated.ok) return { ok: false, reason: `updateBranch failed: ${updated.message || updated.status}` };

  let scratch = null;
  try {
    // Force only the remote-tracking ref — it mirrors origin by definition, so
    // a force-pushed origin lands here as data rather than as a fetch error.
    const fetched = git.gitTry(["fetch", "origin", `+${branch}:refs/remotes/origin/${branch}`], repo);
    if (!fetched.ok) return { ok: false, reason: `could not fetch origin/${branch}: ${fetched.out.trim()}` };
    // `updateBranch` merged base in server-side, so the repaired tip is
    // whatever the fetch above put in the remote-tracking ref. Read it before
    // deriving anything from it.
    const repaired = git.gitTry(["rev-parse", `refs/remotes/origin/${branch}`], repo);
    if (!repaired.ok) return { ok: false, reason: `could not read the updated origin/${branch}` };
    // `updateBranch` already moved ORIGIN, so from here on the local ref is
    // stale no matter how this repair ends. Sync it now rather than only on the
    // way out: `resolveLanded` reads `refs/heads/<branch>` for readiness's
    // `expectedHead`, so a red gate below (or any later failure) would otherwise
    // leave the next readiness read at REMOTE_UNKNOWN — a class with no repair
    // path, so the branch could not be repaired again. Origin has already moved
    // irreversibly, so a diverged local here is only reportable, not preventable.
    const synced = syncLocalBranch(git, repo, ctx, repaired.out.trim());
    if (!synced.ok) return synced;
    scratch = addScratch(git, repo, orchDir, `origin/${branch}`, scratchBranch);
    if (!scratch) return { ok: false, reason: "could not create the repair worktree" };
    const testCmd = cfg.test === "auto" ? gate.detect(scratch) : cfg.test;
    // Same #56/#58 watchdog as the agent stages: `gate.run(cmd, cwd, timeoutMs)`
    // defaults to 0 (wait forever), and this one runs while the repair holds
    // `integration-repair.lock`. Deliberately BEFORE `merge.lock` is taken, so
    // a slow test suite does not hold the shared merge lock for its duration.
    if (!gate.run(testCmd, scratch, stageTimeoutMs(cfg)).pass) return { ok: false, reason: "gate red on the updated branch tip" };
    const landed = await landRepairedTip(ctx, deps, { sha: repaired.out.trim() });
    // Nothing but a gate run was spent here, so a landing that changed nothing
    // (lost push race) costs this repair no attempt: the caller re-polls
    // readiness and repairs again for free.
    return landed.raced ? { ...landed, precondition: true } : landed;
  } finally {
    if (scratch) dropScratch(git, repo, scratch, scratchBranch);
  }
}

// REMOTE_CONFLICTING / REMOTE_CI_RED: merge base in locally, and where that
// needs a judgement call (a real conflict, or a red check), let a resolver
// agent make it — then prove the resolution before `landRepairedTip` makes it
// origin's. Every gate below is written to fail CLOSED: a check that could not
// run has told us nothing, and nothing is not permission to push to a branch
// other cycles depend on.
async function repairConflictOrRed(ctx, deps) {
  const { orchDir, repo, branch, base, cfg, class: cls, failure, prNumber, scratchBranch } = ctx;
  const { git, gate, gh, adapters } = deps;
  const mode = modeOf(cfg);
  const timeoutMs = stageTimeoutMs(cfg);

  // Compute against a FRESH origin/<branch> and base, not whatever snapshot an
  // earlier fetch left behind. Force only the remote-tracking ref — it mirrors
  // origin by definition, so a force-pushed origin lands here as data rather
  // than as a fetch error.
  const fetched = git.gitTry(["fetch", "origin", `+${branch}:refs/remotes/origin/${branch}`], repo);
  if (!fetched.ok) return { ok: false, reason: `could not fetch origin/${branch}: ${fetched.out.trim()}` };
  if (!git.gitTry(["fetch", "origin", base], repo).ok) {
    return { ok: false, reason: `could not fetch origin/${base}` };
  }
  const scratch = addScratch(git, repo, orchDir, `origin/${branch}`, scratchBranch);
  if (!scratch) return { ok: false, reason: "could not create the repair worktree" };
  let preserveScratch = false;
  let preserveRecovery = false;

  try {
    const preSha = git.gitTry(["rev-parse", "HEAD"], scratch).out.trim();
    // One rotated pool for the whole repair: the reviewer must be picked out of
    // the SAME order the resolver came from (cli.js hands `conflictReviewerFor`
    // the rotated list too).
    const resolvers = resolverPoolOf(cfg, orchDir);
    const resolver = resolvers[0];
    // Paths the resolver is answerable for: the conflicted set, or (clean
    // merge) its own pre/post diff. Drives both the audit-allowlist decision
    // and the "did an agent touch this" exclusion below.
    let resolverPaths = [];
    let resolverRan = false;
    // The tree the resolver started from — the diff base that attributes
    // CONTENT to the resolver instead of to base. See the scan block below.
    let resolverBase = null;

    const merge = git.gitTry(["merge", "--no-edit", `origin/${base}`], scratch);
    if (!merge.ok) {
      const conflicts = conflictedPathsIn(git, scratch);
      if (!conflicts.length) return { ok: false, reason: (merge.out || "merge failed").trim() };
      // The same opt-in gate `resolveIntegrationConflict` already enforces: a
      // repo configured with a non-auto mode never gets an agent auto-resolving
      // a merge conflict here either. Checked BEFORE the resolver is
      // constructed, so no agent process starts at all.
      if (mode === "manual") {
        git.gitTry(["merge", "--abort"], scratch);
        return { ok: false, reason: "conflictResolution is manual" };
      }
      resolverRan = true;
      // Pin the CONFLICTED state as a tree so the resolver's own edits can be
      // read back afterwards. `conflicts` alone is the pre-resolution list: a
      // resolver that also rewrites a non-conflicted path base merged in
      // cleanly would fall in neither `resolverPaths` nor outside
      // `baseIncoming`, and so escape the path floor, the security scan and the
      // audit gate together. `git add -A` resolves the index in place (markers
      // and all) purely so `write-tree` can run; `author()` stages over it.
      git.gitTry(["add", "-A"], scratch);
      const wrote = git.gitTry(["write-tree"], scratch);
      // Unchecked, a failed write-tree would leave error text where a tree sha
      // belongs: the diff below fails, `resolverPaths` silently degrades back
      // to `conflicts`, and both the footprint and the marker scan fail open.
      if (!wrote.ok) {
        git.gitTry(["merge", "--abort"], scratch);
        return { ok: false, reason: `could not pin the conflicted tree: ${wrote.out.trim()}` };
      }
      resolverBase = wrote.out.trim();
      try {
        await adapters.get(resolver.agent).author(
          resolverPrompt({ branch, base, cls, failure, conflicts }), scratch,
          { model: resolver.model, effort: resolver.effort, stageTimeoutMs: timeoutMs, baseBranch: base },
        );
      } catch (error) {
        const preserve = Boolean(error?.preserveWorktree);
        if (preserve) preserveRecovery = true;
        else git.gitTry(["merge", "--abort"], scratch);
        // Without an explicit preservation request, nothing durable happened —
        // merge aborted, scratch dropped, origin untouched — so a pool with
        // another seat is worth one more attempt. A preserved recovery state is
        // terminal: retrying would collide with the retained branch/worktree.
        return {
          ok: false,
          ...(!preserve && resolvers.length > 1 ? { retrySeat: true } : {}),
          reason: `resolver failed: ${errorText(error)}${preserve ? `; worktree preserved at ${scratch} (branch ${scratchBranch})` : ""}`,
        };
      }
      // A tree-vs-worktree diff, so work the resolver staged but did not commit
      // (the `commit --no-edit` below would carry it) counts too.
      const agentDiff = diffOut(git, scratch, [...SECURITY_RAW_ARGS, resolverBase]);
      if (!agentDiff.ok) return { ok: false, reason: agentDiff.reason };
      resolverPaths = [...new Set([...conflicts, ...parseRawPaths(agentDiff.out)])];
      if (git.gitTry(["rev-parse", "-q", "--verify", "MERGE_HEAD"], scratch).ok) {
        // Re-stage before this commit, not just before the pre-resolver
        // `write-tree` above: a resolver that edits files without running
        // `git add` (real CLI agents normally rely on `captureAuthorWork` for
        // that, a file this one never calls into) would otherwise leave the
        // index exactly as `git add -A` staged it BEFORE the resolver ran —
        // markers and all — and `commit --no-edit` commits the INDEX, not the
        // working tree. The marker floor below greps the working tree, so
        // without this the floor validates the resolver's fix while
        // `candidateSha` pins the stale, unresolved content underneath it.
        git.gitTry(["add", "-A"], scratch);
        git.gitTry(["commit", "--no-edit"], scratch);
      }
    } else if (cls === "REMOTE_CI_RED") {
      // Merge was clean but the checks were red — repair the named check. Same
      // opt-in gate as the conflict branch above: a non-auto mode can never
      // push this resolution, so starting the resolver only burns an agent
      // stage (and `stageTimeout` of wall clock) to reach a verdict already known.
      if (mode === "manual") return { ok: false, reason: "conflictResolution is manual" };
      // Pin the merge result first: a clean merge produces no
      // `--diff-filter=U` list, so without a pre/post diff the exclusion below
      // would also drop paths the resolver itself edited whenever base's
      // incoming delta happened to touch the same file, exempting them from
      // both floors.
      resolverBase = git.gitTry(["rev-parse", "HEAD"], scratch).out.trim();
      resolverRan = true;
      try {
        await adapters.get(resolver.agent).author(
          resolverPrompt({ branch, base, cls, failure, conflicts: [] }), scratch,
          { model: resolver.model, effort: resolver.effort, stageTimeoutMs: timeoutMs, baseBranch: base },
        );
      } catch (error) {
        // Same as the conflict path: nothing durable happened, so hand the next
        // seat an attempt when the pool has one.
        const preserve = Boolean(error?.preserveWorktree);
        if (preserve) preserveRecovery = true;
        return {
          ok: false,
          ...(!preserve && resolvers.length > 1 ? { retrySeat: true } : {}),
          reason: `resolver failed: ${errorText(error)}${preserve ? `; worktree preserved at ${scratch} (branch ${scratchBranch})` : ""}`,
        };
      }
      // Unlike the conflict branch, a clean merge leaves no MERGE_HEAD to react
      // to, so there is no equivalent commit fallback here — and none is
      // needed. Any resolver that actually changed something committed it
      // itself (`captureAuthorWork`, or the fixture's own `git commit` above).
      // A resolver that reports success without moving HEAD off `resolverBase`
      // — the default pool, a fully compliant adapter, an agent that simply
      // makes no edit — has repaired nothing: `resolverPaths` would come back
      // empty below, which skips the marker floor, the security scan AND the
      // audit (`reviewPaths.length` gates it), so the untouched merge tip would
      // sail through to `landRepairedTip` and get reported merged. Refuse
      // before any of that runs. This also catches a resolver that edited the
      // working tree without committing: `candidateSha` below is `rev-parse
      // HEAD`, not the working tree, so an uncommitted edit would leave the
      // gate/audit stages testing content that never reaches origin — gate 1's
      // own failure mode, inside the slice that exists to close it.
      const afterResolve = git.gitTry(["rev-parse", "HEAD"], scratch);
      if (!afterResolve.ok) return { ok: false, reason: `could not re-read the resolved tip: ${afterResolve.out.trim()}` };
      if (afterResolve.out.trim() === resolverBase) {
        return { ok: false, retrySeat: resolvers.length > 1, reason: "resolver committed nothing — the red check was never repaired" };
      }
      const agentDiff = diffOut(git, scratch, [...SECURITY_RAW_ARGS, resolverBase]);
      if (!agentDiff.ok) return { ok: false, reason: agentDiff.reason };
      resolverPaths = parseRawPaths(agentDiff.out);
    }

    // Marker floor over BOTH resolver paths, not just the merge-conflict one.
    // `author()` unconditionally `git add -A`s and commits (cli-adapter.js
    // `captureAuthorWork`), and `git commit` SUCCEEDS mid-merge with raw
    // `<<<<<<<` still in the file — that clears git's unmerged-path
    // bookkeeping, so nothing downstream notices on its own. On the clean
    // REMOTE_CI_RED path there was never a conflict, so nothing else would ever
    // look. Markers rarely fail a test suite and an allowlist-only resolution
    // skips the audit round by design, so unchecked they reach origin. Scanned
    // over everything the resolver touched — markers it invents in a brand-new
    // file are markers all the same — and never a bare worktree grep: this
    // repo's own fixtures contain marker text.
    if (resolverPaths.length) {
      // #568 changed this helper's return type from a bare string to an object,
      // so `if (unresolvedConflictMarkers(...))` is now ALWAYS true and its
      // negation always false — either would turn this floor into a constant.
      // `error` means the search never ran (worktree gone, pathspec outside the
      // repo); that is not permission to push, so it refuses like a hit does.
      const { markers, error } = git.unresolvedConflictMarkers(scratch, resolverPaths);
      if (error) return { ok: false, reason: `conflict-marker check failed: ${error}` };
      if (markers) return { ok: false, reason: `resolver left conflict markers: ${markers.split("\n")[0]}` };
    }

    // THE candidate. Pinned once, here — after the marker floor and before the
    // first thing that judges the tree — and used for every judgement and for
    // the landing itself. The stages below (`gate.run` executes the repo's own
    // test command; the reviewer audit runs an agent WITH TOOLS) both run inside
    // this writable scratch worktree, and a fresh `rev-parse HEAD` at push time
    // would let either of them commit content that no diff, no scan, no gate and
    // no reviewer ever saw. Re-read and compared after each of those stages
    // below; a mismatch is refused, never re-scanned.
    const candidate = git.gitTry(["rev-parse", "HEAD"], scratch);
    if (!candidate.ok) return { ok: false, reason: `could not read the resolved tip: ${candidate.out.trim()}` };
    const candidateSha = candidate.out.trim();
    // A resolver can abort the merge and still commit a plausible-looking
    // repair. Refuse that tip: the repair must carry the base it was meant to
    // merge before it can reach the shared branch. This check is shared by the
    // conflict and clean CI-red paths.
    const containsBase = git.gitTry(["merge-base", "--is-ancestor", `origin/${base}`, candidateSha], scratch);
    if (!containsBase.ok) return { ok: false, reason: `repaired tip ${candidateSha} does not contain origin/${base} in its ancestry` };
    // A stage that was supposed to only read has written to the worktree. That
    // is an anomaly, not a new candidate: adapting (re-scanning the new tip)
    // would make the write routine, and the safe answer to "the tree moved
    // under the gate that was checking it" is to stop.
    const unmoved = (stage) => {
      const now = git.gitTry(["rev-parse", "HEAD"], scratch);
      if (!now.ok) return `could not re-read the resolved tip after the ${stage}: ${now.out.trim()}`;
      return now.out.trim() === candidateSha ? null : `the ${stage} moved the resolution off ${candidateSha.slice(0, 12)}`;
    };

    // Gate + security scan on the RESOLUTION, not on base's whole incoming
    // delta: `preSha...candidateSha` is everything base brought in PLUS whatever
    // the resolver did, so a routine base-side version bump that merged cleanly
    // would otherwise trip the same floors a genuine resolver edit deserves to
    // trip. Exclusion, not intersection — a resolver that ADDS a brand-new
    // protected path is in neither set and must still be caught.
    const resolutionDiff = diffOut(git, scratch, [...SECURITY_RAW_ARGS, `${preSha}...${candidateSha}`]);
    if (!resolutionDiff.ok) return { ok: false, reason: resolutionDiff.reason };
    const baseDiff = diffOut(git, scratch, [...SECURITY_RAW_ARGS, `${preSha}...origin/${base}`]);
    if (!baseDiff.ok) return { ok: false, reason: baseDiff.reason };
    const baseIncoming = new Set(parseRawPaths(baseDiff.out));
    // A UNION, not a filter over the diff. A filter can only keep paths that
    // appear in `preSha...candidateSha`, and a conflict resolved as "ours"
    // produces content identical to `preSha` — so that path is in no diff at
    // all, and a filter drops it from the protected-path floor and from
    // `reviewPaths` together. What lands is not unscanned bytes (the content
    // equals what was already there); it is that the resolver silently DISCARDED
    // base's incoming change to that file, and nobody was asked. Every path the
    // resolver is answerable for is therefore in unconditionally. The second
    // half keeps the exclusion above, which is correct for what it covers.
    const scanPaths = [...new Set([
      ...resolverPaths,
      ...parseRawPaths(resolutionDiff.out).filter((p) => !baseIncoming.has(p)),
    ])];

    const allowed = new Set(cfg.main?.autoResolveConflictPaths || []);
    const reviewPaths = scanPaths.filter((p) => !allowed.has(p));
    // Protected-path floor AFTER the allowlist, never before: `package.json`
    // and its lockfile are both protected paths AND the operator's default
    // `autoResolveConflictPaths` entries, so checking first would make every
    // routine version bump on base a terminal POLICY_PROTECTED_PATH — and with
    // `release.autoBump: true` that bump happens on essentially every landing,
    // wedging the whole pipeline. The allowlist is the operator's explicit
    // opt-in for exactly these paths; the CONTENT scan below still covers them.
    const prot = checkPaths(reviewPaths);
    if (!prot.ok) {
      return { ok: false, terminalClass: "POLICY_PROTECTED_PATH", reason: `protected paths touched: ${prot.violations.join(", ")}` };
    }
    // CONTENT attribution, the other half of the path exclusion above: diff
    // from the tree the RESOLVER started on (the pinned conflicted tree, or the
    // clean merge result), never from `preSha`. `preSha...HEAD` on a
    // resolver-touched path also carries every hunk base merged into that same
    // file, so a secret or a subprocess call base brought in would be scanned
    // as the resolver's work. `resolverBase` is null exactly when no resolver
    // ran, and then there is nothing to attribute — scan nothing rather than
    // fall back to a range that is all base.
    // Both ends are tree-ishes — `resolverBase` to `candidateSha`, never a
    // working-tree read: the scan must describe the commit that gets pushed, not
    // whatever the directory holds when the diff happens to run.
    const finalDiff = scanPaths.length && resolverBase
      ? diffOut(git, scratch, [...SECURITY_DIFF_ARGS, resolverBase, candidateSha, "--", ...scanPaths])
      : { ok: true, out: "" };
    if (!finalDiff.ok) return { ok: false, reason: finalDiff.reason };
    const scanned = scanDiff(finalDiff.out, { ignore: cfg.security?.ignore ?? [], rawPaths: scanPaths });
    // The scan's `guardrail-touch` rule is a PATH floor over the same
    // `DEFAULT_PROTECTED` list `checkPaths` uses, so leaving it unfiltered
    // re-imposes on the allowlist exactly what the ordering above removed.
    // Only the path floor is waived — the CONTENT rules (secret-read,
    // subprocess, network, ...) still apply to those files.
    // `scanDiff` marks the path-floor finding with its synthetic line; content
    // findings carry the matched added line instead.
    const findings = scanned.findings.filter((f) => !(
      f.rule === "guardrail-touch" &&
      f.line === "guardrail path changed" &&
      allowed.has(f.file)
    ));
    if (findings.length) {
      return { ok: false, terminalClass: "SECURITY_FINDING", reason: "security scan rejected the resolution", security: { ...scanned, findings } };
    }
    const testCmd = cfg.test === "auto" ? gate.detect(scratch) : cfg.test;
    // Same #56/#58 watchdog as the agent stages, and deliberately BEFORE
    // `merge.lock` is taken so a slow suite does not hold the shared merge lock.
    if (!gate.run(testCmd, scratch, timeoutMs).pass) return { ok: false, reason: "gate red on the resolution" };
    // `gate.run` executed the repository's own test command — arbitrary code —
    // in this worktree. Anything it committed is content no scan read.
    const movedByGate = unmoved("gate");
    if (movedByGate) return { ok: false, reason: movedByGate };

    // design §10A/review A6: an agent-authored resolution touching anything
    // outside the auto-approved allowlist gets one reviewer audit before it
    // reaches the shared branch — green tests prove the tree still works, not
    // that the resolver picked the right side of a conflict. The audit reads
    // `refs/heads/${scratchBranch}`, which IS the resolution (see the file
    // header): auditing `refs/heads/<branch>` instead would review the tip from
    // BEFORE the repair and AGREE to work it never read.
    // Confined-to-allowlist resolutions skip it: that is what the allowlist is
    // for.
    if (resolverRan && reviewPaths.length) {
      const reviewer = reviewerFor(cfg, resolver.agent, resolvers);
      if (!reviewer) return { ok: false, reason: `no conflict reviewer configured that differs from ${resolver.agent}` };
      let verdict;
      try {
        verdict = await adapters.get(reviewer.agent).audit(scratchBranch, scratch, {
          model: reviewer.model, effort: reviewer.effort, stageTimeoutMs: timeoutMs,
        });
      } catch (error) {
        const preserve = Boolean(error?.preserveWorktree);
        if (preserve) preserveRecovery = true;
        return {
          ok: false,
          reason: `conflict-resolution audit failed: ${errorText(error)}${preserve ? `; worktree preserved at ${scratch} (branch ${scratchBranch})` : ""}`,
        };
      }
      if (verdict?.decision !== "AGREE") {
        return { ok: false, reason: `conflict resolution audit rejected: ${verdict?.reason || "reviewer disagreed"}` };
      }
      // The auditor is an agent with tools, run in this writable worktree. It is
      // EXPECTED to read and not write, and that expectation is the only thing
      // between an audit-stage commit and a push of content nothing scanned.
      const movedByAudit = unmoved("audit");
      if (movedByAudit) return { ok: false, reason: movedByAudit };
    }

    // `conflictResolution: "propose"` publishes the agent's candidate for a
    // human without pushing it. Keep the named scratch branch so the SHA in the
    // comment still has reviewable content after this returns.
    if (resolverRan && mode === "propose") {
      preserveScratch = true;
      const evidence = `resolution remains on local branch ${scratchBranch} at ${candidateSha}`;
      if (!prNumber) return { ok: false, reason: `no PR to post the proposed resolution to; ${evidence}` };
      if (typeof gh !== "function") return { ok: false, reason: `could not post the proposed resolution to PR #${prNumber}: gh is unavailable; ${evidence}` };
      try {
        gh(["pr", "comment", String(prNumber), "--body", redact(proposalComment({
          mode, cls, sha: candidateSha, branch: scratchBranch, paths: resolverPaths, resolver: resolver.agent,
        }))]);
      } catch (error) {
        return { ok: false, reason: `could not post the proposed resolution to PR #${prNumber}: ${errorText(error)}; ${evidence}` };
      }
      return {
        ok: false,
        terminalClass: "REMOTE_REVIEW_REQUIRED",
        reason: `conflict resolution proposed for human approval (${evidence})`,
      };
    }

    const landed = await landRepairedTip(ctx, deps, { sha: candidateSha });
    // Attempt accounting, and the one place this path deliberately differs from
    // `repairBehind`. A landing that changed nothing (contended `merge.lock`,
    // lost push race) is a FREE retry only when nothing was spent to reach it —
    // true here exactly when no resolver ran (a REMOTE_CONFLICTING that merged
    // cleanly after all). Once a resolver has burned an agent stage, refunding
    // the attempt would let a contended lock re-run a paid resolver forever, so
    // the attempt is kept: `raced` without `precondition` falls through to
    // `terminal` in the remedy below.
    if (!resolverRan) return landed.raced ? { ...landed, precondition: true } : landed;
    const { precondition, ...paid } = landed;
    return paid;
  } finally {
    if (!preserveRecovery) {
      if (preserveScratch) git.pruneWorktree(repo, scratch);
      else dropScratch(git, repo, scratch, scratchBranch);
    }
  }
}

// `ctx.class` is one of REMOTE_BEHIND | REMOTE_CONFLICTING | REMOTE_CI_RED —
// the classes failure.js routes to this remedy. Returns `{ok:false,
// locked:true}` when a peer already owns `integration-repair.lock`: that is
// not a failed repair, so the caller re-polls readiness and gives the attempt
// back.
export async function repairIntegration(ctx, deps) {
  const lock = deps.lock || lockDefault;
  if (!lock.acquireLock(ctx.orchDir, LOCK_NAMES.INTEGRATION_REPAIR)) {
    return { ok: false, locked: true, precondition: true, reason: "a peer is already repairing the integration branch" };
  }
  try {
    if (ctx.class === "REMOTE_BEHIND") return await repairBehind(ctx, deps);
    return await repairConflictOrRed(ctx, deps);
  } catch (error) {
    // Every git helper here is `gitTry`, but `ensureIntegrationWorktree` and
    // the adapters still throw. A throw must not escape the remedy: run-
    // controller.js does not guard `executor(...)`, so it would crash the run
    // instead of classifying it.
    return { ok: false, reason: errorText(error) };
  } finally {
    lock.releaseLock(ctx.orchDir, LOCK_NAMES.INTEGRATION_REPAIR);
  }
}

// A peer's repair takes up to two gate runs (and, once #569 lands, agent stages
// too), so re-polling readiness the instant we lose the lock just burns the controller's remedy loops on a PR
// that is still broken (readiness itself returns immediately on a red rollup and
// adds no wall clock).
// ponytail: fixed backoff, not exponential — `lockRetryCap` bounds the total
// wait, so the shape of the individual sleep buys nothing.
const LOCK_RETRY_MS = 60_000;

// ...and a cap on how many times it does that. Handing the attempt back also
// drops the convergence entry, so without a cap nothing bounds contention: the
// run re-dispatched this remedy with `attempt` pinned at 0 until run-
// controller.js's MAX_REMEDY_LOOPS (32) ran out ~32 minutes later, and reported
// a bare STOPPED_AT_CAP that named no peer.
//
// Sized against ONE peer repair rather than fixed. The peer holds the lock
// across, in order (worst path — REMOTE_CONFLICTING/REMOTE_CI_RED):
//   1. the resolver `author()` stage, in `repairConflictOrRed` — `stageTimeout`
//   2. the gate run on the resolution, in `repairConflictOrRed` — `stageTimeout`
//   3. the reviewer `audit()` stage, in `repairConflictOrRed`  — `stageTimeout`
//   4. the `merge.lock` acquire, in `landRepairedTip`          — see below
//   5. the gate re-run on the merged tree, in `landRepairedTip` — `stageTimeout`
// Step 5 exists only when the local merge was a real merge rather than a
// fast-forward; the cap is deliberately sized for that worst path, since a
// shorter one would make the loser of a concurrent repair give up mid-peer-
// repair — and §10A makes this remedy `ready`'s only path to its goal.
// REMOTE_BEHIND spends only steps 4-5 plus its own gate run; the cap covers the
// longest path, not the shortest.
// The peer's plain git work (fetch, update-branch, reconcile, merge, push) is
// left unmodelled: it carries no watchdog and no bound worth guessing at, and
// `MIN_LOCK_RETRIES` is the floor that covers it when `stageTimeout` is small.
// `stageTimeout: 0` means no watchdog at all and an unbounded peer hold; that
// floor is the arbitrary compromise there, since waiting forever is not one.
const MIN_LOCK_RETRIES = 10;
// Give the modeled peer one extra polling interval for filesystem/GC and
// scheduler slack. The poll after that interval is the final attempt before
// terminalizing, rather than making the modeled hold the exact deadline.
const LOCK_RETRY_SLACK_ROUNDS = 1;
// `merge.lock` is taken INSIDE the held `integration-repair.lock`, and its wait
// carries no `stageTimeout` — it is bounded by `acquireBlocking`'s own default
// (src/lock.js:117, 5 minutes). Counted separately because a peer can spend it
// on top of both gate runs, and at small `stageTimeout` values the two windows
// alone already eat the whole cap.
const MERGE_LOCK_WAIT_MS = 300_000;
// Every stage the peer can run while holding `integration-repair.lock` — one
// per `stageTimeoutMs(cfg)` call site under that lock. Bump this with any new
// one. Four today: resolver, resolution gate, reviewer audit, landing re-gate.
const LOCKED_STAGES = 4;
// Counted under its own key, not the `repair-lock` counter failure.js spends on
// the free re-polls BEFORE this remedy is ever dispatched — sharing that one
// would arrive already exhausted and terminate on the first contention.
const LOCK_RETRY_KEY = "repair-lock-wait";

// Deliberately a fixed budget of whole `LOCK_RETRY_MS` sleeps, not an
// elapsed-time deadline with a final poll. `Math.ceil` already rounds the
// modelled peer hold UP to a whole retry, so the cap always overshoots it, and
// `MIN_LOCK_RETRIES` covers the unmodelled plain-git work on top. Measuring
// elapsed time instead would put wall clock into the same accounting the paid-
// resolver rule constrains — a run could then hand its attempt back for a
// reason unrelated to what it spent. Terminalizing on the last sleep names the
// peer; one more poll would at best convert that into a repair that the caller
// gets anyway on its next readiness round.
function lockRetryCap(cfg) {
  return Math.max(MIN_LOCK_RETRIES, Math.ceil((LOCKED_STAGES * stageTimeoutMs(cfg) + MERGE_LOCK_WAIT_MS) / LOCK_RETRY_MS))
    + LOCK_RETRY_SLACK_ROUNDS;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The `failures` entry run-controller.js appends BEFORE dispatching is what
// design §7's convergence check reads: left behind, the next round sees a
// streak of two, skips this remedy and falls to `ask`. Every path that hands
// the cycle back has to give that entry up, or the re-dispatch it is asking for
// cannot happen. `name` comes from the controller, so a renamed remedy key can
// never silently stop matching.
function withoutLastFailure(record, failure, name) {
  const history = record.failures || [];
  const last = history[history.length - 1];
  return last?.remedy === name && last.fingerprint === failure?.fingerprint
    ? { ...record, failures: history.slice(0, -1) }
    : record;
}

// The two policy floors in `repairConflictOrRed` end the run BLOCKED (exit 3),
// not STOPPED_AT_CAP: they are the same classes run-controller.js maps in its
// own `BLOCKED_REASON`, reached here through a remedy rather than through a
// local cycle escalation. REMOTE_REVIEW_REQUIRED is deliberately absent — it is
// not a policy block, it is a run that stopped waiting for a human.
const BLOCKED = {
  POLICY_PROTECTED_PATH: "guardrail-path",
  SECURITY_FINDING: "security-finding",
};

function terminal(failure, outcome, record, name) {
  const blockedReason = BLOCKED[outcome.terminalClass];
  // A precondition failure (peer holds the lock, merge.lock timed out, no PR
  // number) started no agent and changed nothing — it must not burn an
  // attempt, same rule as remedies.js's `executed: false` path. The convergence
  // entry goes back for exactly the same reason: this run repaired nothing, so
  // leaving it makes `chooseRemedy` see a two-long equal-fingerprint streak on
  // the resumed run, filter this remedy out (failure.js:203) and resolve
  // terminal — and §10A gives REMOTE_BEHIND no other remedy, so the PR could
  // never be repaired at all. `resumeTerminal` clears `retries`, not
  // `failures`, so here is the only place to drop it.
  const settled = outcome.precondition
    ? { ...withoutLastFailure(record, failure, name), attempt: Math.max(0, (record.attempt || 0) - 1) }
    : record;
  return {
    result: {
      ...(blockedReason
        ? { state: "BLOCKED", outcome: "blocked", exit: 3, blockedReason }
        : { state: "STOPPED_AT_CAP", outcome: "stopped-at-cap", exit: 2 }),
      failureClass: outcome.terminalClass || failure?.class,
      failure,
      reason: `integration repair failed: ${outcome.reason}`,
    },
    record: settled,
  };
}

export function createIntegrationRepairRemedy({ run, deps, resolveLanded, gh }) {
  return (context) => integrationRepairRemedy({ ...context, run, deps, resolveLanded, gh });
}

export async function integrationRepairRemedy({ failure, record, cycle, name, policy, run, deps, resolveLanded, gh }) {
  const cfg = run?.cfg || {};
  const integrationBranch = cfg.integrationBranch || "orch/integration";
  let land = null;
  try {
    land = resolveLanded?.(cycle);
  } catch (error) {
    return terminal(failure, { precondition: true, reason: `could not read the landed PR: ${errorText(error)}` }, record, name);
  }
  // Repair the branch the FAILING PR actually points at — a per-cycle PR
  // (`landing: "pr"`) is the cycle's own branch, not the integration branch.
  const branch = land?.branch || integrationBranch;
  if (!run?.repo || !run?.orchDir || !branch) {
    return terminal(failure, { precondition: true, reason: "branch context is missing" }, record, name);
  }
  const ctx = {
    repo: run.repo,
    orchDir: run.orchDir,
    cfg,
    branch,
    integrationBranch,
    base: cfg.baseBranch || "main",
    class: failure?.class,
    failure,
    prNumber: land?.pr?.number || null,
    scratchBranch: `orch-repair-${run.sid || process.pid}`,
  };
  let outcome;
  try {
    outcome = await repairIntegration(ctx, { ...deps, gh });
  } catch (error) {
    // `acquireLock` itself throws (a §12 order violation, or an fs error on the
    // lock file) OUTSIDE repairIntegration's own try — and run-controller.js
    // does not guard `executor(...)`, so an escape here crashes the run instead
    // of classifying it.
    outcome = { reason: errorText(error) };
  }
  if (outcome.ok) return { cycle, record };
  // Losing `integration-repair.lock` is not a failed repair: this run started no
  // agent and changed nothing, so it hands the attempt back and returns the
  // cycle, which makes run-controller.js re-poll readiness once the peer's
  // repair has landed. Returning a terminal result instead ended the whole run
  // on what is only contention (file header + design §12).
  if (outcome.locked) {
    const waited = (record.retries?.[LOCK_RETRY_KEY] || 0) + 1;
    // Still a precondition failure — the attempt and the convergence entry are
    // refunded either way (see `terminal`); what the cap changes is that the
    // run ends here, naming the peer, instead of spinning until the
    // controller's loop budget is gone.
    if (waited > lockRetryCap(cfg)) {
      return terminal(failure, { ...outcome, precondition: true }, record, name);
    }
    await (deps?.sleep || defaultSleep)(LOCK_RETRY_MS);
    const refunded = withoutLastFailure(record, failure, name);
    return {
      cycle,
      record: {
        ...refunded,
        retries: { ...(record.retries || {}), [LOCK_RETRY_KEY]: waited },
        attempt: Math.max(0, (record.attempt || 0) - 1),
      },
    };
  }
  // A lost push race on a path that spent nothing is the same no-op as losing
  // the lock: origin is untouched, the local worktree was rolled back, and the
  // next readiness poll sees the peer's landing. `repairBehind` marks it
  // `precondition` for exactly that reason — terminalizing it here ended the
  // whole run on contention that a re-poll clears. Bounded by run-controller
  // .js's MAX_REMEDY_LOOPS, and each round pays a real gate run, so it needs no
  // counter of its own. Only the integration branch has a rollback (the local
  // merge is integration-only), but only it can lose this race: a per-cycle
  // branch is `pr/<author>/<slug>-<sid>` (cli.js:1087), sid-scoped to one run,
  // so no peer run pushes to it. (`raced` WITHOUT `precondition` is the
  // resolver path, which has already paid for an agent stage and keeps its
  // attempt — it falls through to `terminal` below, which is the point.)
  if (outcome.raced && outcome.precondition) {
    return {
      cycle,
      record: { ...withoutLastFailure(record, failure, name), attempt: Math.max(0, (record.attempt || 0) - 1) },
    };
  }
  // A resolver that threw spent an agent stage, so unlike contention it KEEPS
  // the attempt — `maxAttempts` is what bounds the failover, not the pool size.
  // Configuring a multi-seat `conflictResolutionResolvers` pool is the
  // operator's consent to spend that second stage, and the rotation cursor has
  // already advanced, so the re-dispatch seats the NEXT agent. The last attempt
  // is not handed back: it reports the resolver's own error instead of the bare
  // `ask` the exhausted cap would produce.
  const maxAttempts = record.policy?.maxAttempts ?? policy?.maxAttempts ?? Infinity;
  if (outcome.retrySeat && (record.attempt || 0) < maxAttempts) {
    return { cycle, record: withoutLastFailure(record, failure, name) };
  }
  return terminal(failure, outcome, record, name);
}
