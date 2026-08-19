import { isDocsOnly } from "./scope.js";
import { checkPaths } from "./intake/allowlist.js";
import { buildRevisionPrompt } from "./intake/workorder.js";
import { scanDiff, formatSecurityFindings, parseRawPaths, SECURITY_DIFF_ARGS, SECURITY_RAW_ARGS } from "./security-review.js";
import { formatUsage, totalUsage } from "./usage.js";

const RAW_OUTPUT_TAIL_CHARS = 12_000;
const STAGE_RESULT_MAX_CHARS = 200;

function oneLineStageResult(detail) {
  const line = String(detail).replace(/\s+/g, " ").trim();
  return line.length > STAGE_RESULT_MAX_CHARS
    ? `${line.slice(0, STAGE_RESULT_MAX_CHARS - 1)}…`
    : line;
}

function rawOutputTail(raw) {
  const text = String(raw ?? "");
  if (!text) return "(empty)";
  return text.length > RAW_OUTPUT_TAIL_CHARS ? text.slice(-RAW_OUTPUT_TAIL_CHARS) : text;
}

function roundRawOutput(verdicts) {
  return verdicts.map((v) => `## ${v.reviewer}\n\n${rawOutputTail(v.raw)}\n`).join("\n\n");
}

// Pure state machine. All side-effecting collaborators arrive via `deps`,
// so tests stub them and dry-run is just another set of stubs.
export async function runCycle(opts, deps) {
  const { mode = "task", task, branch, authorName, reviewerName, cfg, orchDir, repo, worktree, noMerge = false, sid, resume = false } = opts;
  const { adapters, git, gate, scope, notify, finalize, inflight, checkpoint } = deps;
  const baseBranch = cfg.baseBranch || "main";
  // Cycles land on integrationBranch but used to branch from baseBranch, so work
  // authored while the integration PR sits open never saw what already landed —
  // the first meeting was the merge, after review and after the gate. Base the
  // cycle on integration whenever it is strictly ahead of base; every other case
  // (missing, level, diverged) falls back to baseBranch, i.e. today's behavior.
  // cfg.baseBranch stays the PR target and the trunk — this only moves the
  // branch point and the diff comparisons.
  const cycleBase = resolveCycleBase(git, repo, baseBranch, cfg.integrationBranch);
  // Role specs carry optional model/effort. Fall back to bare names so callers
  // that pass only authorName/reviewerNames (e.g. the PR bridge) keep working.
  const authorSpec = opts.author || { agent: authorName };
  const author = adapters.get(authorSpec.agent);
  // #56: per-stage watchdog. cfg.stageTimeout is in minutes (0 = off); pass it to
  // every stage in ms so a stalled author/reviewer is killed instead of hanging.
  const stageTimeoutMs = cfg?.stageTimeout > 0 ? cfg.stageTimeout * 60_000 : 0;
  const authorOpts = { model: authorSpec.model, effort: authorSpec.effort, stageTimeoutMs };
  const reviewerSpecs = opts.reviewers || (opts.reviewerNames || [reviewerName]).map((name) => ({ agent: name }));
  const reviewers = reviewerSpecs.map((s) => ({
    name: s.agent, adapter: adapters.get(s.agent), opts: { model: s.model, effort: s.effort, stageTimeoutMs },
  }));
  // Codex review (#126 stalemate): `orch continue --reviewer <x>` is a one-run
  // override — reviewerSpecs above reflects it so the override actually gets
  // used. But the checkpoint is what a LATER plain `continue` (no override)
  // will read back as "the persisted roles". If this run is killed after
  // writing a checkpoint but before finishing, the checkpoint must still hold
  // the ORIGINAL roles, not this run's override, or the override quietly
  // becomes permanent. The caller passes the original roles as
  // opts.persistAuthor/persistReviewers when they differ from what's actually
  // running this cycle; other callers (task/issue, no override concept) leave
  // them unset and get the same value both ways.
  const persistAuthor = opts.persistAuthor || authorSpec;
  const persistReviewers = opts.persistReviewers || reviewerSpecs;
  const runStats = [];
  const reviewOutcomes = [];
  const done = (result) => {
    const usage = totalUsage(runStats);
    const final = { ...result, runStats, usage, usageSummary: formatUsage(usage) };
    recordReviewOutcomes(deps.reviewLog, orchDir, reviewOutcomes, final);
    return final;
  };
  const recordTerminal = (result) => {
    const usage = totalUsage(runStats);
    // No `closes` here on purpose: runCycle only ever records THIS cycle, so the
    // realDeps stamp fills it in. (Redrive enters at finalize, never through here.)
    notify.recordRun?.(orchDir, {
      ts: new Date().toISOString(), branch, sid, verdict: result.status, reason: result.reason, rounds: result.rounds,
      ...(usage.tokens ? { tokens: usage.tokens } : {}),
      ...(usage.costUsd != null ? { costUsd: usage.costUsd } : {}),
    });
    return done(result);
  };
  const recordUsage = (role, agent, result, fallbackModel = null) => {
    const usage = result?.usage || {};
    const tokens = Number(usage.tokens) || 0;
    if (tokens <= 0) return;
    const entry = { role, agent, model: usage.model || fallbackModel || "default", tokens };
    if (usage.inputTokens) entry.inputTokens = usage.inputTokens;
    if (usage.outputTokens) entry.outputTokens = usage.outputTokens;
    if (usage.cachedTokens) entry.cachedTokens = usage.cachedTokens;
    if (typeof usage.costUsd === "number") entry.costUsd = usage.costUsd;
    runStats.push(entry);
  };

  // F5: task mode owns a fresh branch; review mode requires an existing one.
  // A resumed task (#24) re-attaches the quota-aborted branch — its authored
  // commits are already there, so we skip the initial author step below.
  notify.phase("worktree", `${branch} (${mode}${resume ? ", resume" : ""}${cycleBase !== baseBranch ? `, base ${cycleBase}` : ""})`);
  if (mode === "review" || resume) git.attachExistingBranch(repo, worktree, branch);
  else git.createTaskBranch(repo, worktree, branch, cycleBase, `${process.pid}\n${sid}`);

  const baseSha = git.git(["rev-parse", cycleBase], repo);

  // #422: the branch head for one review round. Checkpoints carry it so a resume
  // can prove the recorded verdict belongs to the content the branch holds NOW.
  // Capture it once per round, then reuse it through audit, gate, checkpoint,
  // security/path reads, and finalize. Read from `repo`: a linked worktree's
  // commits land on the shared refs/heads entry. Unreadable → null, which the
  // resume check treats as "cannot verify".
  // The ref is fully qualified (`refs/heads/<branch>`, with `--verify` so an
  // ambiguous or missing ref fails instead of guessing): a bare name goes
  // through git's disambiguation order, which prefers `refs/tags/<name>` over
  // `refs/heads/<name>`. A tag sharing the branch's name would otherwise pin the
  // checkpoint to the tag's commit — the branch could move freely and the resume
  // would still see a "match", defeating the integrity check entirely.
  const branchOid = () => {
    try { return git.git(["rev-parse", "--verify", `refs/heads/${branch}`], repo); }
    catch { return null; }
  };

  // The changed-file list is asked for three times per round (inflight paths,
  // the empty-diff guard, the pre-merge overlap/protected-path signals) and each
  // ask forks a `git diff`. Memoize on the commit the answer belongs to: an OID
  // is immutable, so a hit is the same diff by construction, and a revise moves
  // the branch to a new OID and therefore misses. No OID (unreadable ref) means
  // no cache key we can trust — spawn and don't store.
  const filesByOid = new Map();
  const changedFilesAt = (oid) => {
    if (!oid) return git.changedFiles(repo, branch, cycleBase);
    if (!filesByOid.has(oid)) filesByOid.set(oid, git.changedFiles(repo, oid, cycleBase));
    return filesByOid.get(oid);
  };

  // The branch tip right after the author committed, when we already read it for
  // the checkpoint. Reused as the cache key below so publishing the paths costs
  // no extra ref read; null (resume, review mode, no checkpoint dep) just means
  // "no key we can trust" and the diff runs uncached.
  let authoredOid = null;

  try {
    // F1: author step + scope gate only in task mode. Review never writes.
    if (mode === "task") {
      // On resume the author's work is already committed on the branch — skip
      // re-authoring and go straight to audit. The scope gate below still runs,
      // so a too-big resumed diff is caught even if quota aborted before it ran.
      if (!resume) {
        checkpoint?.record(orchDir, sid, { branch, round: 1, stage: "started", closes: opts.closes || null, author: persistAuthor, reviewers: persistReviewers });
        notify.phase("author", `${author.name} authoring`);
        // §3b: for untrusted intake (work order), the author runs against a
        // fenced prompt; free-text tasks pass through unchanged.
        const authored = await author.author(opts.authorPrompt || task, worktree, authorOpts);
        recordUsage("author", author.name, authored, authorOpts.model);
        notify.phase("author", `${author.name} completed`, "ok");
        // Record the committed work NOW: a crash during round-1 review would
        // otherwise leave neither a checkpoint (first write is post-audit) nor
        // an inflight record (deregistered on every exit), making the branch
        // invisible to `orch continue`. "authored" grants no shortcut — it sets
        // neither pendingVerdict nor skipTest, so a resume still audits and
        // gates from round 1 (#422 OID binding unaffected).
        authoredOid = branchOid();
        checkpoint?.record(orchDir, sid, { branch, oid: authoredOid, round: 1, stage: "authored", closes: opts.closes || null, author: persistAuthor, reviewers: persistReviewers });
      }

      // Scope gate (optional).
      if (cfg.scope.maxLines > 0) {
        const n = scope.count(branch, worktree, cfg.scope.ignore, cycleBase);
        if (n > cfg.scope.maxLines) {
          return recordTerminal(escalate(notify, orchDir, branch, 1,
            `scope: ${n} changed lines exceed cap ${cfg.scope.maxLines} — split the PR`));
        }
      }
    }

    // Publish changed paths for peer overlap checks (best-effort; finalize re-reads at land time).
    if (inflight) inflight.setPaths(orchDir, sid, changedFilesAt(authoredOid), baseSha);

    // Review mode escalates on first DISAGREE; task mode revises up to the cap.
    const cap = mode === "review" ? 1 : cfg.roundCap;

    // Resolve the test command once.
    const testCmd = cfg.test === "auto" ? gate.detect(worktree) : cfg.test;

    // Crash recovery: on a resumed cycle, pick up the last checkpoint instead of
    // re-auditing rounds already decided. `stage: "tested"` means AGREE + gate
    // already passed — skip straight past both; `stage: "reviewed"` means the
    // round's verdict is known — skip that round's audit call only.
    //
    // Codex review (#126 stalemate, round 3): that shortcut silently defeats
    // `orch continue --reviewer <x>` — the whole point of the override is to
    // swap in a working reviewer when the ORIGINAL one crashed/rate-limited
    // (which is exactly how a "reviewed" checkpoint with a DISAGREE/agentError
    // verdict gets left behind — engine.js writes the checkpoint before
    // checking for agentError and escalating). Trusting that cached verdict
    // means the swapped-in reviewer never actually runs; the resume just
    // replays the old broken reviewer's failure. When an override was
    // requested, still resume at the recorded round number (still valid,
    // still useful), but skip the pendingVerdict shortcut and force a fresh
    // audit call with the (now-different) reviewers.
    //
    // #422: the branch NAME is not enough. A verdict is earned by specific
    // content, and a branch can move between the crash and `orch continue` (a
    // manual commit, a rebase, another cycle's revise). So the checkpoint also
    // pins the head commit OID: honour the cached verdict only when the branch
    // still points at that exact commit. Mismatch — or a missing `oid`, which is
    // what a checkpoint written by an older orch looks like — means we cannot
    // prove the verdict fits, so we fail closed: resume at the recorded round,
    // but re-audit and re-gate it. Costs one extra audit; never inherits a
    // verdict earned by different code.
    let round = 1;
    let pendingVerdict = null;
    let skipTest = false;
    let cachedOid = null;
    if (resume) {
      const ck = checkpoint?.lookup(orchDir, sid);
      if (ck && ck.branch === branch) {
        round = ck.round;
        if (!opts.reviewerOverride) {
          cachedOid = ck.oid || null;
          if (ck.stage === "tested") {
            pendingVerdict = { decision: "AGREE", reason: ck.reason || "" };
            skipTest = true;
          } else if (ck.stage === "reviewed") {
            pendingVerdict = { decision: ck.decision, reason: ck.reason || "" };
          }
        }
      }
    }

    for (;;) {
      // The round's single branch-ref read: once captured, reviewedSha binds the
      // empty-diff guard, the audit, gate, checkpoint writes, security reads and
      // merge to the same commit even if the branch moves later.
      const reviewedSha = branchOid();
      if (changedFilesAt(reviewedSha).length === 0) {
        return recordTerminal(escalate(notify, orchDir, branch, round,
          "author produced no changes — nothing to review"));
      }

      // Re-check a cached shortcut at consumption, not only at resume entry.
      if (pendingVerdict && (!reviewedSha || !cachedOid || cachedOid !== reviewedSha)) {
        pendingVerdict = null;
        skipTest = false;
      }

      let verdict;
      if (pendingVerdict) {
        verdict = pendingVerdict;
        pendingVerdict = null;
      } else {
        notify.phase("review", `${reviewers.map((r) => r.name).join(", ")} auditing (round ${round})`);
        const verdicts = await Promise.all(reviewers.map(async (reviewer) => ({
          reviewer: reviewer.name,
          model: reviewer.opts.model,
          ...(await reviewer.adapter.audit(branch, worktree, { ...reviewer.opts, round })),
        })));
        for (const v of verdicts) recordUsage("reviewer", v.reviewer, v, v.model);
        const disagree = verdicts.filter((v) => v.decision !== "AGREE");
        reviewOutcomes.push(...verdicts.map((v) => ({
          branch,
          round,
          reviewer: v.reviewer,
          model: v.model || null,
          // Log decision is AGREE | DISAGREE | ERROR (#299). ERROR is metrics-only:
          // control flow below still treats agentError as DISAGREE + fast-escalate.
          // Crash/stall is not an editorial rejection — do not count it as DISAGREE.
          decision: v.agentError ? "ERROR" : (v.decision === "AGREE" ? "AGREE" : "DISAGREE"),
          agentError: Boolean(v.agentError),
        })));
        verdict = {
          decision: disagree.length ? "DISAGREE" : "AGREE",
          reason: verdicts.map((v) => `## ${v.reviewer}\n\n${v.decision}: ${v.reason}`).join("\n\n"),
        };
        for (const v of verdicts) {
          const decision = v.decision === "AGREE" ? "AGREE" : "DISAGREE";
          notify.phase("review",
            oneLineStageResult(`${v.reviewer} round ${round} — ${decision}: ${v.reason || "(no reason)"}`),
            decision === "AGREE" ? "ok" : "fail");
        }
        notify.writeRound(orchDir, branch, round,
          `# Round ${round}\n\nVerdict: ${verdict.decision}\n\nCost: ${formatUsage(totalUsage(runStats))}\n\n${verdict.reason}\n`);
        notify.writeRoundRaw?.(orchDir, branch, round, roundRawOutput(verdicts));
        checkpoint?.record(orchDir, sid, { branch, oid: reviewedSha, round, stage: "reviewed", decision: verdict.decision, reason: verdict.reason, closes: opts.closes || null, author: persistAuthor, reviewers: persistReviewers });

        // #33: a crashed/nonzero reviewer (agentError) is not a code defect, so
        // revising the author would burn the whole loop for nothing. Escalate
        // immediately — the reason carries the #31 stderr tail (bad model id, etc).
        const agentErrors = disagree.filter((v) => v.agentError);
        if (agentErrors.length) {
          const reason = `agent error: ${agentErrors.map((v) => `${v.reviewer} ${v.reason}`).join("; ")}`;
          return recordTerminal(escalate(notify, orchDir, branch, round, reason));
        }
      }

      if (verdict.decision === "AGREE") {
        if (!testCmd) {
          return recordTerminal(escalate(notify, orchDir, branch, round,
            "no test gate detected — set `test:` in orch.yml or merge manually"));
        }
        let pass;
        if (skipTest) {
          pass = true;
          skipTest = false;
        } else {
          notify.phase("gate", `running: ${testCmd}`);
          ({ pass } = gate.run(testCmd, worktree, stageTimeoutMs));
          notify.phase("gate", testCmd, pass ? "ok" : "fail");
          if (pass) checkpoint?.record(orchDir, sid, { branch, oid: reviewedSha, round, stage: "tested", reason: verdict.reason, closes: opts.closes || null, author: persistAuthor, reviewers: persistReviewers });
        }
        if (!pass) {
          return recordTerminal(escalate(notify, orchDir, branch, round,
            "AGREE but tests are red — not merging"));
        }
        // §3e: deterministic security floor on the FINAL diff, at the same
        // approve/merge boundary as the §3c protected-path gate below. The LLM
        // reviewer can be talked out of a DISAGREE; this scan cannot. It runs
        // before the noMerge return so the PR-bridge approval is gated too.
        // Fail closed: a diff we cannot read is a diff we do not approve.
        // Two reads of the same diff: the PATCH (added lines, for the content
        // rules) and the STRUCTURAL `--raw -z` listing (changed paths, for the
        // guardrail floor — no prefix/quoting config can blind it). Both are in
        // the one try: a partial view is not a view we scan on.
        if (!reviewedSha) {
          return recordTerminal(escalate(notify, orchDir, branch, round,
            `security scan: could not read reviewed branch head refs/heads/${branch} — failing closed, not merging`));
        }
        let finalDiff, rawPaths;
        try {
          finalDiff = git.git(["diff", ...SECURITY_DIFF_ARGS, `${cycleBase}...${reviewedSha}`], repo);
          rawPaths = parseRawPaths(git.git(["diff", ...SECURITY_RAW_ARGS, `${cycleBase}...${reviewedSha}`], repo));
        } catch (e) {
          return recordTerminal(escalate(notify, orchDir, branch, round,
            `security scan: could not read the final diff (${e.message}) — failing closed, not merging`));
        }
        const security = scanDiff(finalDiff, { ignore: cfg.security?.ignore ?? [], rawPaths });
        if (security.decision !== "AGREE") {
          // summary → the concise reason kept in run logs / the CLI status line;
          // detail → the grouped, deduped, educational note a human reads.
          const { summary, detail } = formatSecurityFindings(security.findings);
          return recordTerminal(escalate(notify, orchDir, branch, round, summary, detail));
        }
        // PR-bridge audit: report the verdict, let GitHub own the merge. Reviews
        // are kept (not cleaned) so the caller can quote them in a PR comment.
        if (noMerge) {
          return recordTerminal({ status: "approved", reason: "agreed + green (no merge)", rounds: round });
        }
        // Compute the loop-guard signals BEFORE finalize: a ff merge makes
        // main...branch empty, so reading it post-merge always yields [].
        const changed = changedFilesAt(reviewedSha);
        // §3c: protected-path floor at the MERGE boundary. Gating the FINAL diff
        // (not just round 1) covers the initial author, every revise, resume, and
        // an `orch review` merge — the same set CODEOWNERS guards at review time.
        // The agent can't be trusted to comply voluntarily, so the deterministic
        // gate, not the prompt, is what keeps guardrail files out of main.
        const prot = checkPaths(changed);
        if (!prot.ok) {
          return recordTerminal(escalate(notify, orchDir, branch, round,
            `protected paths touched: ${prot.violations.join(", ")} — orch will not merge guardrail files`));
        }
        const docsOnly = isDocsOnly(changed, cfg.docs.paths);
        const noop = changed.length === 0;
        const fin = await finalize({
          repo, orchDir, branch, reviewedSha, sid, baseSha, paths: changed,
          testCmd, cfg, rounds: round, task, closes: opts.closes || null, runStats,
        }, deps);
        const label = fin.status === "merged" ? `merged ${branch}`
          : fin.status === "pr" ? `opened PR for ${branch}`
          : fin.status === "merge-deferred" ? `deferred merge for ${branch} (${fin.trigger})`
          : `escalated ${branch} (${fin.reason})`;
        notify.phase("merge", label);
        return done({
          status: fin.status, reason: fin.reason, trigger: fin.trigger, prUrl: fin.prUrl,
          rounds: round, docsOnly, noop,
        });
      }

      // DISAGREE — review mode (cap=1) escalates here on round 1, never revising.
      if (round >= cap) {
        const brief = notify.buildDecisionBrief({
          branch,
          reviewerCase: verdict.reason,
          authorCase: mode === "review" ? "(review-only; no author)" : "see prior rounds",
          diffSummary: safeDiff(git, repo, branch, cycleBase),
          rounds: round,
        });
        notify.escalate(orchDir, branch, brief);
        const why = mode === "review" ? "review verdict: DISAGREE" : "stalemate after cap";
        return recordTerminal({ status: "escalated", reason: why, rounds: round });
      }

      // Count the round BEFORE the author runs, and checkpoint it immediately.
      // The old order incremented after `author.author()` returned and left the
      // persist to the next loop's post-audit write, so a crash anywhere in that
      // window (the revise itself is the minutes-long part) resumed at the
      // pre-increment round and handed the cycle one extra revision past
      // `roundCap`. Counting first errs the safe way: a revise that crashes
      // before committing costs a round rather than granting one. Like
      // "authored", this stage grants no shortcut — a resume re-audits and
      // re-gates, so no `oid` pin is needed (there is no cached verdict to pin).
      round += 1;
      notify.phase("revise", `${author.name} revising (round ${round})`);
      checkpoint?.record(orchDir, sid, { branch, round, stage: "revising", closes: opts.closes || null, author: persistAuthor, reviewers: persistReviewers });
      const revised = await author.author(buildRevisionPrompt(verdict.reason), worktree, authorOpts);
      recordUsage("author", author.name, revised, authorOpts.model);
    }
  } finally {
    git.pruneWorktree(repo, worktree);
  }
}

// `reason` is the short line kept in the returned result (logs, status line);
// `body` is what the escalation note shows — defaults to `reason` for the many
// callers that have only a one-liner, but the security gate passes a richer
// educational detail so the human-facing note reads as more than a jammed string.
function escalate(notify, orchDir, branch, round, reason, body = reason) {
  notify.escalate(orchDir, branch, `# Escalation — ${branch}\n\n${body}\n`);
  return { status: "escalated", reason, rounds: round };
}

// The base a cycle is actually cut from and diffed against: integrationBranch
// when it contains baseBranch and holds at least one commit base does not,
// otherwise baseBranch. Local refs only — no fetch on this path. Any ref we
// cannot read resolves to baseBranch, so ambiguity keeps the old behavior.
function resolveCycleBase(git, repo, base, integration) {
  if (!integration || integration === base) return base;
  try {
    // --quiet so a missing integration branch (the normal case on a fresh clone)
    // exits 1 silently instead of printing `fatal:` on every cycle; fully
    // qualified so a same-named tag cannot stand in for the branch.
    const tip = git.git(["rev-parse", "--verify", "--quiet", `refs/heads/${integration}`], repo);
    const baseTip = git.git(["rev-parse", "--verify", "--quiet", `refs/heads/${base}`], repo);
    if (tip === baseTip) return base;
    // Nonzero exit (base not contained → diverged) throws and falls through.
    git.git(["merge-base", "--is-ancestor", baseTip, tip], repo);
    return integration;
  } catch { return base; }
}

function safeDiff(git, repo, branch, base = "main") {
  try { return git.git(["diff", "--stat", `${base}...${branch}`], repo); }
  catch { return "(diff unavailable)"; }
}

function recordReviewOutcomes(reviewLog, orchDir, reviewOutcomes, result) {
  if (!reviewLog?.record || !reviewOutcomes.length) return;
  const ts = new Date().toISOString();
  const defectLaterSurfaced = !["merged", "approved", "pr"].includes(result.status)
    && !/^agent error:/.test(result.reason || "")
    && !/^no test gate detected/.test(result.reason || "");
  reviewLog.record(orchDir, reviewOutcomes.map((entry) => ({
    ts,
    ...entry,
    terminalStatus: result.status,
    terminalReason: result.reason,
    terminalRounds: result.rounds,
    defectLaterSurfaced,
  })));
}
