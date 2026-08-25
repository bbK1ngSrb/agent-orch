// Integration repair (design docs/cli-v2-design.md §10A): repairs the branch
// behind a standing/per-cycle PR that readiness reported as BEHIND,
// CONFLICTING or CI-red — whether or not this run caused it.
//
// Lock discipline (design §12): the run takes the non-blocking
// `integration-repair.lock` before ANY repair, and only takes `merge.lock`
// (the next lock in §12's order) around the part that touches the shared
// integration worktree / pushes. A peer holding the repair lock means this run
// starts no agent and gives its attempt back — the caller re-polls readiness.
//
// Agent work always runs in a scratch worktree checked out on a throwaway
// LOCAL branch, never in the persistent integration worktree `finalize` owns
// and never detached: `audit(branch, wd)` renders a prompt naming
// `refs/heads/<branch>`, so a detached scratch would have the reviewer audit
// the PRE-repair tip and fail open (the defect this file exists to not have).
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { checkPaths } from "./intake/allowlist.js";
import { parseRoleSpecs } from "./config.js";
import { scanDiff, parseRawPaths, SECURITY_DIFF_ARGS, SECURITY_RAW_ARGS } from "./security-review.js";
import * as lockDefault from "./lock.js";
import { LOCK_NAMES } from "./lock.js";
import { updateBranch } from "./github.js";
import { redact } from "./redact.js";

const DEFAULT_RESOLVERS = [{ agent: "claude", model: null, effort: null }];

// git's own wording for "someone else moved the ref under you", across the
// versions/locales that keep the English message: the only push failure a
// retry can clear. Matched against `gitTry`'s `.out`, which carries stderr
// (git.js:62) — that is where git writes the rejection.
const PUSH_RACE_RE = /non-fast-forward|fetch first|stale info|remote contains work/i;

function errorText(error) {
  return String(error?.message || error || "unknown error").trim();
}

function modeOf(cfg) {
  return cfg.main?.conflictResolution || (cfg.main?.autoResolveConflicts ? "auto" : "manual");
}

// #56/#58: every agent stage this file starts must carry the same wall-clock
// watchdog cli.js passes to the cycle's own stages — a hung resolver here
// would otherwise stall an unattended `--until` run while holding
// `integration-repair.lock`.
function stageTimeoutMs(cfg) {
  return cfg.stageTimeout > 0 ? cfg.stageTimeout * 60_000 : 0;
}

// Seat the resolver the way the cycle seats its own roles: the same rotation
// cli.js's `conflictResolvers` runs, over the same `last-conflict-resolver`
// cursor, so a repair and an in-cycle conflict resolution share one turn order
// instead of this path pinning pool entry zero forever. Advanced eagerly —
// before we know whether a resolver will actually run — exactly as cli.js:742
// does, which is also what makes a dead seat fail over: a repair whose resolver
// throws leaves the cursor advanced, so the next attempt starts on the next
// seat.
// A seat that throws fails over ACROSS repair attempts, not inside one: the
// remedy hands the cycle back, the controller dispatches the remedy again, and
// this rotation seats the next agent (see `retrySeat` below). Retrying a second
// seat INSIDE one repair would instead mean restoring the conflicted worktree
// between attempts (cli.js's `resetMergeAttempt`), the resolver restructure this
// slice is told not to do.
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

// Fail-closed, in the same shape `resolveIntegrationConflict` (cli.js) uses:
// an audit only proves something when the auditor differs from the resolver.
function reviewerFor(cfg, resolverAgent, resolvers) {
  const pool = [
    ...resolvers,
    // Same three sources, same order, as cli.js's `conflictReviewerFor`:
    // dropping `cfg.reviewers` here made a repo that configures roles instead
    // of a bare `agents:` pool find no differing seat and fail every repair.
    ...(cfg.reviewers?.length ? parseRoleSpecs(cfg.reviewers) : []),
    ...(cfg.agents || []).map((agent) => ({ agent, model: null, effort: null })),
  ];
  return pool.find((spec) => spec?.agent && spec.agent !== resolverAgent) || null;
}

// Fail closed on an unreadable diff: every path floor below reads its input
// from one of these, and `gitTry` puts the ERROR TEXT in `.out`. Unchecked,
// a failed diff parses to an empty path list, which reads downstream as
// "the resolver touched nothing" — empty scan, clean gate, push.
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

function addScratch(git, repo, orchDir, ref, branchName) {
  const path = join(orchDir, "wt", branchName);
  // -B, not --detach: the throwaway branch IS what the reviewer audits.
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

function resolverPrompt({ branch, base, cls, failure, conflicts }) {
  return [
    conflicts.length
      ? `Integration repair on ${branch}: merging origin/${base} produced a merge conflict.`
      : `Integration repair on ${branch}: red checks after merging origin/${base}.`,
    "",
    `Failure class: ${cls}`,
    failure?.summary ? `Details: ${failure.summary}` : null,
    conflicts.length ? `Conflicted files: ${conflicts.join(", ")}` : null,
    "",
    conflicts.length
      ? "Act as a neutral third party; reconstruct both parents' intent. Preserve behavior from both sides unless truly incompatible."
      : "Fix only the named failing check(s); do not widen scope.",
    "Resolve everything, stage the result, and commit it. Do not edit unrelated files.",
  ].filter((line) => line !== null).join("\n");
}

function proposalComment({ mode, cls, paths, resolver }) {
  return [
    "agent-orch: conflict resolution needs human approval.",
    "",
    `Mode: ${mode}`,
    `Class: ${cls}`,
    paths.length ? `Files: ${paths.join(", ")}` : null,
    `Resolver: ${resolver}`,
  ].filter((line) => line !== null).join("\n");
}

// Takes a tip that has already been gated and — where a resolver was involved —
// audited, and makes it origin's. Both repair paths land through here, so the
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
      // Bring local up to origin before merging: ff-only, so a genuinely
      // diverged local branch stops the repair instead of being rewritten.
      const reconciled = git.reconcileIntegrationToOrigin(integration, branch);
      if (!reconciled?.ok) {
        return { ok: false, reason: `could not reconcile local ${branch}: ${reconciled?.reason || "unknown error"}` };
      }
      // Plain merge, not `--ff-only`: fast-forwarding is exactly the case that
      // fails when local carries its own commits, which is the case this
      // ordering exists to keep.
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

async function repairConflictOrRed(ctx, deps) {
  const { orchDir, repo, branch, base, cfg, class: cls, failure, prNumber, scratchBranch } = ctx;
  const { git, gate, gh, adapters } = deps;
  const mode = modeOf(cfg);
  const timeoutMs = stageTimeoutMs(cfg);

  // Compute against a FRESH origin/<branch>, not whatever snapshot an earlier
  // fetch left behind.
  const fetched = git.gitTry(["fetch", "origin", `+${branch}:refs/remotes/origin/${branch}`], repo);
  if (!fetched.ok) return { ok: false, reason: `could not fetch origin/${branch}: ${fetched.out.trim()}` };
  if (!git.gitTry(["fetch", "origin", base], repo).ok) {
    return { ok: false, reason: `could not fetch origin/${base}` };
  }
  const scratch = addScratch(git, repo, orchDir, `origin/${branch}`, scratchBranch);
  if (!scratch) return { ok: false, reason: "could not create the repair worktree" };

  try {
    const preSha = git.gitTry(["rev-parse", "HEAD"], scratch).out.trim();
    // One rotated pool for the whole repair: rotating twice would double-advance
    // the shared cursor, and the reviewer must be picked out of the SAME order
    // the resolver came from (cli.js hands `conflictReviewerFor` the rotated
    // list too).
    const resolvers = resolverPoolOf(cfg, orchDir);
    const resolver = resolvers[0];
    // Paths the resolver is answerable for: the conflicted set, or (clean
    // merge) its own pre/post diff. Drives both the audit-allowlist decision
    // and the "did an agent touch this" exclusion below.
    let resolverPaths = [];
    let resolverRan = false;
    // The tree the resolver started from — the diff base that attributes CONTENT
    // to the resolver instead of to base. See the scan block below.
    let resolverBase = null;

    const merge = git.gitTry(["merge", "--no-edit", `origin/${base}`], scratch);
    if (!merge.ok) {
      const conflicts = conflictedPathsIn(git, scratch);
      if (!conflicts.length) return { ok: false, reason: (merge.out || "merge failed").trim() };
      // The same opt-in gate `resolveIntegrationConflict` already enforces: a
      // repo configured `conflictResolution: "manual"` (the default) never
      // gets an agent auto-resolving a merge conflict here either.
      if (mode === "manual") {
        git.gitTry(["merge", "--abort"], scratch);
        return { ok: false, reason: "conflictResolution is manual" };
      }
      resolverRan = true;
      // Pin the CONFLICTED state as a tree so the resolver's own edits can be
      // read back afterwards. `conflicts` alone is the pre-resolution list: a
      // resolver that also rewrites a non-conflicted path base merged in
      // cleanly would fall in neither `resolverPaths` nor outside
      // `baseIncoming`, and so escape the path floor, the security scan and
      // the audit gate together. `git add -A` resolves the index in place
      // (markers and all) purely so `write-tree` can run; `author()` stages
      // over it again.
      git.gitTry(["add", "-A"], scratch);
      const wrote = git.gitTry(["write-tree"], scratch);
      // Unchecked, a failed write-tree would leave error text where a tree sha
      // belongs: the diff below fails, `resolverPaths` silently degrades back
      // to `conflicts`, and both the footprint and the marker scan fail open.
      if (!wrote.ok) {
        git.gitTry(["merge", "--abort"], scratch);
        return { ok: false, reason: `could not pin the conflicted tree: ${wrote.out.trim()}` };
      }
      const preAgentTree = wrote.out.trim();
      resolverBase = preAgentTree;
      try {
        await adapters.get(resolver.agent).author(
          resolverPrompt({ branch, base, cls, failure, conflicts }), scratch,
          { model: resolver.model, effort: resolver.effort, stageTimeoutMs: timeoutMs, baseBranch: base },
        );
      } catch (error) {
        git.gitTry(["merge", "--abort"], scratch);
        // Nothing durable happened — merge aborted, scratch dropped, origin
        // untouched — so a pool with another seat is worth one more attempt.
        // A single-seat pool is not: it would re-run the same dead agent until
        // `maxAttempts` and report nothing more useful than this error.
        return { ok: false, retrySeat: resolvers.length > 1, reason: `resolver failed: ${errorText(error)}` };
      }
      // `author()` unconditionally `git add -A`s and commits (cli-adapter.js
      // captureAuthorWork), and `git commit` SUCCEEDS mid-merge with raw
      // `<<<<<<<` markers still in the file — that clears git's unmerged-path
      // bookkeeping, so nothing downstream would notice on its own. An
      // allowlist-only conflict skips the audit round by design, so an
      // unreviewed marker would reach origin. Scanned over everything the
      // resolver touched, not just the conflicted paths: markers it invents in
      // a brand-new file are markers all the same. No bare `git grep` over the
      // whole worktree — a repo whose own fixtures contain marker text (this
      // one does) would never pass.
      // A tree-vs-worktree diff, so work the resolver staged but did not commit
      // (the `commit --no-edit` below would carry it) counts too.
      const agentDiff = diffOut(git, scratch, [...SECURITY_RAW_ARGS, preAgentTree]);
      if (!agentDiff.ok) return { ok: false, reason: agentDiff.reason };
      resolverPaths = [...new Set([...conflicts, ...parseRawPaths(agentDiff.out)])];
      if (git.gitTry(["rev-parse", "-q", "--verify", "MERGE_HEAD"], scratch).ok) {
        git.gitTry(["commit", "--no-edit"], scratch);
      }
    } else if (cls === "REMOTE_CI_RED") {
      // Merge was clean but the checks were red — repair the named check.
      // Pin the merge result first: a clean merge produces no `--diff-filter=U`
      // list, so without a pre/post diff the exclusion below would also drop
      // paths the resolver itself edited whenever base's incoming delta
      // happened to touch the same file, exempting them from both floors.
      // Same opt-in gate as the conflict branch above: `manual` can never push
      // this resolution, so starting the resolver only burns an agent stage
      // (and `stageTimeout` of wall clock) to reach a verdict already known.
      if (mode === "manual") return { ok: false, reason: "conflictResolution is manual" };
      const mergedSha = git.gitTry(["rev-parse", "HEAD"], scratch).out.trim();
      resolverBase = mergedSha;
      resolverRan = true;
      try {
        await adapters.get(resolver.agent).author(
          resolverPrompt({ branch, base, cls, failure, conflicts: [] }), scratch,
          { model: resolver.model, effort: resolver.effort, stageTimeoutMs: timeoutMs, baseBranch: base },
        );
      } catch (error) {
        // Same as the conflict path: nothing durable happened, so hand the next
        // seat an attempt when the pool has one.
        return { ok: false, retrySeat: resolvers.length > 1, reason: `resolver failed: ${errorText(error)}` };
      }
      const agentDiff = diffOut(git, scratch, [...SECURITY_RAW_ARGS, mergedSha]);
      if (!agentDiff.ok) return { ok: false, reason: agentDiff.reason };
      resolverPaths = parseRawPaths(agentDiff.out);
    }

    // Marker floor over BOTH resolver paths, not just the merge-conflict one.
    // `author()` commits whatever the agent left, and `git commit` succeeds with
    // raw `<<<<<<<` still in the file; on the clean REMOTE_CI_RED path there was
    // never a conflict, so nothing else would ever look. Markers rarely fail a
    // test suite and an allowlist-only resolution skips the audit round, so
    // unchecked they reach origin. Scanned over everything the resolver touched
    // (never a bare worktree grep — this repo's own fixtures contain marker
    // text).
    if (resolverPaths.length) {
      const markers = git.unresolvedConflictMarkers(scratch, resolverPaths);
      if (markers) return { ok: false, reason: `resolver left conflict markers: ${markers.split("\n")[0]}` };
    }

    // Gate + security scan on the RESOLUTION, not on base's whole incoming
    // delta: `preSha...HEAD` is everything base brought in PLUS whatever the
    // resolver did, so a routine base-side version bump that merged cleanly
    // would otherwise trip the same floors a genuine resolver edit deserves
    // to trip. Exclusion, not intersection — a resolver that ADDS a brand-new
    // protected path is in neither set and must still be caught.
    const resolutionDiff = diffOut(git, scratch, [...SECURITY_RAW_ARGS, `${preSha}...HEAD`]);
    if (!resolutionDiff.ok) return { ok: false, reason: resolutionDiff.reason };
    const baseDiff = diffOut(git, scratch, [...SECURITY_RAW_ARGS, `${preSha}...origin/${base}`]);
    if (!baseDiff.ok) return { ok: false, reason: baseDiff.reason };
    const rawPaths = parseRawPaths(resolutionDiff.out);
    const baseIncoming = new Set(parseRawPaths(baseDiff.out));
    const scanPaths = rawPaths.filter((p) => resolverPaths.includes(p) || !baseIncoming.has(p));

    const allowed = new Set(cfg.main?.autoResolveConflictPaths || []);
    const reviewPaths = scanPaths.filter((p) => !allowed.has(p));
    // Protected-path floor AFTER the allowlist, never before: `package.json`
    // and its lockfile are both protected paths AND the operator's default
    // `autoResolveConflictPaths` entries, so checking first would make every
    // routine version bump on base a terminal POLICY_PROTECTED_PATH and wedge
    // the pipeline. The allowlist is the operator's explicit opt-in for
    // exactly these paths; the CONTENT scan below still covers them.
    const prot = checkPaths(reviewPaths);
    if (!prot.ok) {
      return { ok: false, terminalClass: "POLICY_PROTECTED_PATH", reason: `protected paths touched: ${prot.violations.join(", ")}` };
    }
    // CONTENT attribution, the other half of the path exclusion above: diff from
    // the tree the RESOLVER started on (the pinned conflicted tree, or the clean
    // merge result), never from `preSha`. `preSha...HEAD` on a resolver-touched
    // path also carries every hunk base merged into that same file, so a secret
    // or a subprocess call base brought in would be scanned as the resolver's
    // work. `resolverBase` is null exactly when no resolver ran, and then there
    // is nothing to attribute — scan nothing rather than fall back to a range
    // that is all base.
    const finalDiff = scanPaths.length && resolverBase
      ? diffOut(git, scratch, [...SECURITY_DIFF_ARGS, resolverBase, "--", ...scanPaths])
      : { ok: true, out: "" };
    if (!finalDiff.ok) return { ok: false, reason: finalDiff.reason };
    const scanned = scanDiff(finalDiff.out, { ignore: cfg.security?.ignore ?? [], rawPaths: scanPaths });
    // The scan's `guardrail-touch` rule is a PATH floor over the same
    // `DEFAULT_PROTECTED` list `checkPaths` uses, so leaving it unfiltered
    // re-imposes on the allowlist exactly what the ordering above removed:
    // `package.json` and its lockfile are shipped `autoResolveConflictPaths`
    // defaults, and every routine version-bump resolution would terminate as
    // SECURITY_FINDING instead. Only the path floor is waived — the CONTENT
    // rules (secret-read, subprocess, network, ...) still apply to those files.
    const findings = scanned.findings.filter((f) => !(f.rule === "guardrail-touch" && allowed.has(f.file)));
    if (findings.length) {
      return { ok: false, terminalClass: "SECURITY_FINDING", reason: "security scan rejected the resolution", security: { ...scanned, findings } };
    }
    const testCmd = cfg.test === "auto" ? gate.detect(scratch) : cfg.test;
    if (!gate.run(testCmd, scratch, timeoutMs).pass) return { ok: false, reason: "gate red on the resolution" };

    // design §10A/review A6: an agent-authored resolution touching anything
    // outside the auto-approved allowlist gets one reviewer audit before it
    // ff's onto the shared branch — green tests prove the tree still works,
    // not that the resolver picked the right side of a conflict. The audit
    // reads `refs/heads/${scratchBranch}`, which IS the resolution (see the
    // file header). Confined-to-allowlist resolutions skip it: that is what
    // the allowlist is for.
    if (resolverRan && reviewPaths.length) {
      const reviewer = reviewerFor(cfg, resolver.agent, resolvers);
      if (!reviewer) return { ok: false, reason: `no conflict reviewer configured that differs from ${resolver.agent}` };
      let verdict;
      try {
        verdict = await adapters.get(reviewer.agent).audit(scratchBranch, scratch, {
          model: reviewer.model, effort: reviewer.effort, stageTimeoutMs: timeoutMs,
        });
      } catch (error) {
        return { ok: false, reason: `conflict-resolution audit failed: ${errorText(error)}` };
      }
      if (verdict?.decision !== "AGREE") {
        return { ok: false, reason: `conflict resolution audit rejected: ${verdict?.reason || "reviewer disagreed"}` };
      }
    }

    // `conflictResolution: "propose"` means draft a resolution and post it for
    // a human — never push it (docs/orch-manual.md §5.1). Gated on
    // `resolverRan`: a purely mechanical merge involves no agent, so blocking
    // it here would make integration repair a permanent no-op on every
    // default-config repo. Terminal, not a retry — one resolver+gate+audit
    // round per failure, not three before anyone reads the diff.
    if (resolverRan && mode !== "auto") {
      if (prNumber && gh) {
        try {
          gh(["pr", "comment", String(prNumber), "--body", redact(proposalComment({ mode, cls, paths: resolverPaths, resolver: resolver.agent }))]);
        } catch { /* best-effort — the run escalates below regardless */ }
      }
      return {
        ok: false,
        terminalClass: "REMOTE_REVIEW_REQUIRED",
        reason: "conflict resolution proposed for human approval (conflictResolution is not auto)",
      };
    }

    const resultSha = git.gitTry(["rev-parse", "HEAD"], scratch).out.trim();
    // A resolver stage has already been spent on this path, so `raced` is
    // passed through as-is: unlike `repairBehind`, a lost push race here does
    // NOT hand the attempt back. (Refining that is #569's problem, not this
    // slice's.)
    return await landRepairedTip(ctx, deps, { sha: resultSha });
  } finally {
    dropScratch(git, repo, scratch, scratchBranch);
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

// A peer's repair takes an agent stage plus a gate run, so re-polling readiness
// the instant we lose the lock just burns the controller's remedy loops on a PR
// that is still broken (readiness itself returns immediately on a red rollup and
// adds no wall clock).
// ponytail: fixed backoff, not exponential — the loop cap already bounds it. The
// ceiling that buys is ~MAX_REMEDY_LOOPS * 60s of contention tolerance, shared
// with every other remedy in the same run; a peer whose resolver runs the full
// `stageTimeout` can outlast it and leave this run at STOPPED_AT_CAP. Raise this
// (or make the loop budget per-remedy) if that shows up in practice.
const LOCK_RETRY_MS = 60_000;

// ...and a cap on how many times it does that. Handing the attempt back also
// drops the convergence entry, so nothing else bounds contention: the run would
// re-dispatch this remedy with `attempt` pinned at 0 until run-controller.js's
// MAX_REMEDY_LOOPS (32) ran out, ~32 minutes later, and report a bare
// STOPPED_AT_CAP that names no peer. Counted under its own key, not the
// `repair-lock` counter failure.js spends on the free re-polls BEFORE this
// remedy is ever dispatched — sharing that one would be exhausted on arrival
// and terminate on the first contention.
const LOCK_RETRY_CAP = 3;
const LOCK_RETRY_KEY = "repair-lock-wait";

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const BLOCKED = {
  POLICY_PROTECTED_PATH: "guardrail-path",
  SECURITY_FINDING: "security-finding",
};

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

function terminal(failure, outcome, record) {
  const blockedReason = BLOCKED[outcome.terminalClass];
  // A precondition failure (peer holds the lock, merge.lock timed out, no PR
  // number) started no agent and changed nothing — it must not burn an
  // attempt, same rule as remedies.js's `executed: false` path.
  const settled = outcome.precondition
    ? { ...record, attempt: Math.max(0, (record.attempt || 0) - 1) }
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
    return terminal(failure, { precondition: true, reason: `could not read the landed PR: ${errorText(error)}` }, record);
  }
  // Repair the branch the FAILING PR actually points at — a per-cycle PR
  // (`landing: "pr"`) is the cycle's own branch, not the integration branch.
  const branch = land?.branch || integrationBranch;
  if (!run?.repo || !run?.orchDir || !branch) {
    return terminal(failure, { precondition: true, reason: "branch context is missing" }, record);
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
    // Still a precondition failure — the attempt is refunded either way; what
    // the cap changes is that the run ends here, naming the peer, instead of
    // spinning until the controller's loop budget is gone.
    if (waited > LOCK_RETRY_CAP) return terminal(failure, { ...outcome, precondition: true }, record);
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
  // A resolver that threw spent an agent stage, so unlike contention it KEEPS
  // the attempt — `maxAttempts` is what bounds the failover, not the pool size.
  // Configuring a multi-seat `conflictResolutionResolvers` pool is the
  // operator's consent to spend that second stage. The last attempt is not
  // handed back: it reports the resolver's own error instead of the bare `ask`
  // the exhausted cap would produce.
  const maxAttempts = record.policy?.maxAttempts ?? policy?.maxAttempts ?? Infinity;
  if (outcome.retrySeat && (record.attempt || 0) < maxAttempts) {
    return { cycle, record: withoutLastFailure(record, failure, name) };
  }
  return terminal(failure, outcome, record);
}
