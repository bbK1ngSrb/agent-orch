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
// This slice (P6 split 4a) repairs REMOTE_BEHIND only: GitHub's server-side
// update-branch, a gate run on the result, and the landing below. NO agent runs
// anywhere in it. The resolver paths (REMOTE_CONFLICTING / REMOTE_CI_RED) are
// #569; until they land, `repairIntegration` says so rather than pretending.
//
// Work still runs in a scratch worktree checked out on a throwaway LOCAL
// branch, never in the persistent integration worktree `finalize` owns and
// never detached: the gate must see the repaired tip, and #569's `audit(branch,
// wd)` renders a prompt naming `refs/heads/<branch>` — a detached scratch would
// have the reviewer audit the PRE-repair tip and fail open.
import { join } from "node:path";
import * as lockDefault from "./lock.js";
import { LOCK_NAMES } from "./lock.js";
import { updateBranch } from "./github.js";

// git's own wording for "someone else moved the ref under you", across the
// versions/locales that keep the English message: the only push failure a
// retry can clear. Matched against `gitTry`'s `.out`, which carries stderr
// (git.js:62) — that is where git writes the rejection.
const PUSH_RACE_RE = /non-fast-forward|fetch first|stale info|remote contains work/i;

function errorText(error) {
  return String(error?.message || error || "unknown error").trim();
}

// #56/#58: every stage this file starts must carry the same wall-clock watchdog
// cli.js passes to the cycle's own stages — a hung test command here would
// otherwise stall an unattended `--until` run while holding
// `integration-repair.lock`. Two call sites today (see LOCKED_STAGES).
function stageTimeoutMs(cfg) {
  return cfg.stageTimeout > 0 ? cfg.stageTimeout * 60_000 : 0;
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
    // REMOTE_CONFLICTING / REMOTE_CI_RED need a resolver agent, a security
    // scan and an audit — P6 split 4b (#569). Reporting that plainly is still
    // strictly better than the pre-#551 state, where no executor was
    // registered at all and every one of these classes resolved terminal.
    return { ok: false, reason: `${ctx.class} repair is not implemented in this slice (#569)` };
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
// across, in order:
//   1. the gate run on the updated tip, in `repairBehind`      — `stageTimeout`
//   2. the `merge.lock` acquire, in `landRepairedTip`          — see below
//   3. the gate re-run on the merged tree, in `landRepairedTip` — `stageTimeout`
// Step 3 exists only when the local merge was a real merge rather than a
// fast-forward; the cap is deliberately sized for that worst path, since a
// shorter one would make the loser of a concurrent repair give up mid-peer-
// repair — and §10A makes this remedy `ready`'s only path to its goal.
// Two `stageTimeout` windows, not the four an earlier round counted: this slice
// has no resolver stage and no reviewer audit under the lock. #569 puts them
// back and must raise `LOCKED_STAGES` with them.
// The peer's plain git work (fetch, update-branch, reconcile, merge, push) is
// left unmodelled: it carries no watchdog and no bound worth guessing at, and
// `MIN_LOCK_RETRIES` is the floor that covers it when `stageTimeout` is small.
// `stageTimeout: 0` means no watchdog at all and an unbounded peer hold; that
// floor is the arbitrary compromise there, since waiting forever is not one.
const MIN_LOCK_RETRIES = 10;
// `merge.lock` is taken INSIDE the held `integration-repair.lock`, and its wait
// carries no `stageTimeout` — it is bounded by `acquireBlocking`'s own default
// (src/lock.js:117, 5 minutes). Counted separately because a peer can spend it
// on top of both gate runs, and at small `stageTimeout` values the two windows
// alone already eat the whole cap.
const MERGE_LOCK_WAIT_MS = 300_000;
// Every stage the peer can run while holding `integration-repair.lock` — one
// per `stageTimeoutMs(cfg)` call site under that lock. Bump this with any new
// one.
const LOCKED_STAGES = 2;
// Counted under its own key, not the `repair-lock` counter failure.js spends on
// the free re-polls BEFORE this remedy is ever dispatched — sharing that one
// would arrive already exhausted and terminate on the first contention.
const LOCK_RETRY_KEY = "repair-lock-wait";

function lockRetryCap(cfg) {
  return Math.max(MIN_LOCK_RETRIES, Math.ceil((LOCKED_STAGES * stageTimeoutMs(cfg) + MERGE_LOCK_WAIT_MS) / LOCK_RETRY_MS));
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

function terminal(failure, outcome, record) {
  // A precondition failure (peer holds the lock, merge.lock timed out, no PR
  // number) started no agent and changed nothing — it must not burn an
  // attempt, same rule as remedies.js's `executed: false` path.
  const settled = outcome.precondition
    ? { ...record, attempt: Math.max(0, (record.attempt || 0) - 1) }
    : record;
  return {
    result: {
      state: "STOPPED_AT_CAP", outcome: "stopped-at-cap", exit: 2,
      failureClass: failure?.class,
      failure,
      reason: `integration repair failed: ${outcome.reason}`,
    },
    record: settled,
  };
}

export function createIntegrationRepairRemedy({ run, deps, resolveLanded, gh }) {
  return (context) => integrationRepairRemedy({ ...context, run, deps, resolveLanded, gh });
}

export async function integrationRepairRemedy({ failure, record, cycle, name, run, deps, resolveLanded, gh }) {
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
    //
    // The convergence entry goes back too, and for the same reason the attempt
    // does: this run repaired nothing. Retained, it makes `resumeTerminal`'s
    // fresh attempt budget useless — `orch continue` re-reads a PR that is
    // still BEHIND, `chooseRemedy` sees a two-long equal-fingerprint streak
    // ending in `integration-repair`, filters that remedy out (failure.js:203)
    // and resolves terminal. Since §10A makes it the only remedy for the class,
    // the PR could then never be repaired at all. `resumeTerminal` clears
    // `retries` but not `failures`, so this is the only place to drop it.
    if (waited > lockRetryCap(cfg)) {
      return terminal(failure, { ...outcome, precondition: true }, withoutLastFailure(record, failure, name));
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
  return terminal(failure, outcome, record);
}
