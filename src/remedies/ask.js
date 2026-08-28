import { redact } from "../redact.js";
import { collaboratorPermission, commentOnce, createPr, findPrByHead, listComments } from "../github.js";
import { raiseMaxAttempts } from "../failure.js";

const MAX_ADDENDUM = 4 * 1024;
const MAX_POLL_SECONDS = 10 * 60;
const WRITE_PERMISSIONS = new Set(["admin", "write"]);

function nowMs(deps) {
  const value = deps?.now ? deps.now() : Date.now();
  const ms = value instanceof Date ? value.getTime() : Number(value);
  return Number.isFinite(ms) ? ms : Date.now();
}

export function canWrite(permission) {
  return Boolean(permission) && permission.ok !== false
    && WRITE_PERMISSIONS.has(String(permission.permission || "").toLowerCase());
}

export function parseReply(body) {
  const raw = String(body || "");
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^orch:\s*(retry(?:\s+(\d+))?|abandon)\s*$/i);
    if (!match) continue;
    if (match[1].toLowerCase().startsWith("retry")) return { command: "retry", count: Math.min(3, Math.max(1, Number(match[2]) || 1)) };
    return { command: "abandon", count: 0 };
  }
  const text = raw.trim().slice(0, MAX_ADDENDUM);
  return text ? { command: "addendum", text } : null;
}

export function askComment({ runId, attempt, maxAttempts, until, failure, record, deadline }) {
  const tried = (record?.failures || [])
    .map((entry) => `${entry.remedy || "attempt"}: ${entry.class || entry.fingerprint || "failure"}`)
    .join(", ") || "the current cycle";
  const summary = String(failure?.summary || failure?.reason || "no automatic remedy remains").trim();
  const branch = String(runId || "").replace(/[^\w./-]/g, "");
  return [
    "**orch needs a decision**",
    "",
    `run: \`${branch}\`, attempt ${attempt}/${maxAttempts}, goal \`--until ${until || "ready"}\``,
    "",
    `What happened: ${failure?.class || "unknown"} — ${summary}`,
    `What orch tried: ${tried}`,
    "Evidence: see the branch and the private `.orch/reviews/` decision files.",
    "",
    "Reply (users with write access only), one of:",
    "- `orch: retry` — try again with the same work order (`orch: retry 2` grants two more attempts)",
    "- `orch: abandon` — stop; orch will leave the branch",
    "- anything else — treated as new instructions appended to the work order",
    "",
    `orch will wait until ${new Date(deadline).toISOString()}, then exit 4; resume with \`orch continue ${branch}\`.`,
  ].join("\n");
}

function resolveChannel(run, deps, base) {
  const kind = run?.source?.kind || run?.command || run?.channel;
  if (kind === "issue" || run?.closes != null || run?.source?.issue != null)
    return { kind: "issue", target: Number(run.closes ?? run.source.issue), url: run.source?.url || null };
  if (kind === "pr" || run?.prNumber != null || run?.source?.pr != null) {
    const target = Number(run.prNumber ?? run.source.pr);
    return { kind: "pr", target, url: run.source?.url || null };
  }
  if (!run?.branch) return null;
  const existing = findPrByHead(run.branch, base, { includeDraft: true }, deps);
  if (existing) return { kind: "draft-pr", target: existing.number, url: existing.url };
  const created = createPr({
    head: run.branch,
    base,
    title: `orch: ${run.task || "task"} (question)`,
    body: "orch is asking for a human decision before continuing.",
    draft: true,
  }, deps);
  return created?.number ? { kind: "draft-pr", target: created.number, url: created.url } : null;
}

function blocked(failure, reason, record, blockedReason = "no-channel") {
  return {
    result: {
      state: "BLOCKED", outcome: "blocked", exit: 3,
      blockedReason, failureClass: failure?.class, failure,
      reason: `ask remedy blocked: ${reason}`,
    },
    record,
  };
}

function timedOut(failure, runId, human, record) {
  return {
    result: {
      state: "WAIT_TIMEOUT", outcome: "wait-timeout", exit: 4,
      failureClass: "HUMAN_TIMEOUT", failure,
      reason: `human decision timed out; resume with \`orch continue ${runId}\``,
      resumeCommand: `orch continue ${runId}`,
      human,
    },
    record: { ...record, human },
  };
}

function timeoutComment(runId, human) {
  return `orch: human wait timed out; resume with \`orch continue ${runId}\` (the late reply will still be checked).`;
}

function stoppedAtCap(failure, human, record) {
  return {
    result: {
      state: "STOPPED_AT_CAP", outcome: "stopped-at-cap", exit: 2,
      failureClass: failure?.class, failure,
      reason: "human retry ceiling reached", human,
    },
    record: { ...record, human },
  };
}

async function findReply(channel, human, deps, permissionCache) {
  const comments = listComments(channel.target, { since: human.askedAt }, deps)
    .filter((comment) => Number(comment.id) > Number(human.askCommentId || 0))
    .sort((a, b) => Number(a.id) - Number(b.id));
  for (const comment of comments) {
    const body = String(comment.body || "");
    if (body.includes("<!-- orch:") || String(comment.user?.type || "").toLowerCase() === "bot") continue;
    const login = comment.user?.login || comment.author?.login;
    if (!login) continue;
    let permission = permissionCache.get(login);
    if (!permission) {
      permission = collaboratorPermission(login, deps);
      if (!permission || permission.ok === false) continue;
      permissionCache.set(login, permission);
    }
    if (!canWrite(permission)) continue;
    const reply = parseReply(body);
    if (!reply) continue;
    return { comment, reply, login };
  }
  return null;
}

export function createAskRemedy({ run, getRun, deps = {}, runCycle, reauthor } = {}) {
  const permissionCache = new Map();
  return (context) => askRemedy({
    ...context,
    run: getRun ? getRun() : run,
    deps,
    runCycle,
    reauthor,
    permissionCache,
  });
}

export async function askRemedy({ failure, record = {}, policy = {}, run, deps = {}, runCycle, reauthor, permissionCache = new Map() }) {
  const runId = record.runId || run?.runId || run?.sid;
  const base = run?.cfg?.baseBranch || policy.baseBranch || "main";
  let channel;
  try {
    channel = record.human?.target
      ? record.human
      : run?.human?.target
        ? run.human
        : resolveChannel(run, deps, base);
  } catch (error) {
    return blocked(failure, error?.message || "GitHub channel is unavailable", record);
  }
  if (!channel?.target) return blocked(failure, "no GitHub issue, PR, or draft PR channel is available", record);

  const clock = nowMs(deps);
  const maxAttempts = record.policy?.maxAttempts ?? policy.maxAttempts ?? 3;
  const attempt = record.attempt || 0;
  const waitHours = Math.max(0.000001, Number(record.policy?.humanWaitHours ?? policy.humanWaitHours ?? 24) || 24);
  const previousHuman = record.human?.askCommentId ? record.human : null;
  // A timed-out question remains the reply cursor even if a resumed attempt
  // advanced the counter. Once a reply is journaled, start a new question so
  // the old `orch: retry`/`abandon` command cannot be consumed twice.
  const existing = previousHuman
    && !previousHuman.replies?.some((reply) => Number(reply.id) > Number(previousHuman.askCommentId))
    ? previousHuman
    : null;
  const askedAt = existing?.askedAt || new Date(clock).toISOString();
  const existingDeadline = existing?.deadline ? new Date(existing.deadline).getTime() : NaN;
  const deadline = Number.isFinite(existingDeadline) && existingDeadline > clock
    ? existing.deadline
    : new Date(clock + waitHours * 60 * 60 * 1000).toISOString();
  const marker = `${runId}:ask:${attempt}:${deadline}`;
  let human = {
    channel: channel.kind,
    target: channel.target,
    url: channel.url || existing?.url || (channel.kind === "draft-pr" ? channel.url : null),
    askCommentId: existing?.askCommentId || null,
    askedAt,
    deadline,
    attempt,
    replies: [...(previousHuman?.replies || [])],
  };

  try {
    if (!human.askCommentId) {
      const posted = commentOnce({
        kind: channel.kind === "draft-pr" ? "pr" : channel.kind,
        target: channel.target,
        body: redact(askComment({ runId, attempt, maxAttempts, until: policy.until, failure, record, deadline })),
        marker,
      }, deps);
      if (!posted?.id) return blocked(failure, "GitHub did not return the question comment id", { ...record, human }, "no-channel");
      human.askCommentId = posted.id;
    }
  } catch (error) {
    return blocked(failure, error?.message || "could not post the GitHub question", record);
  }

  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let interval = Math.max(1, Number(policy.pollSeconds || 30));
  for (;;) {
    let reply;
    try {
      reply = await findReply(channel, human, deps, permissionCache);
    } catch (error) {
      return blocked(failure, error?.message || "could not read GitHub replies", { ...record, human }, "cannot-verify-authorization");
    }
    if (reply?.blocked) return blocked(failure, reply.reason, { ...record, human }, "cannot-verify-authorization");
    if (reply?.reply) {
      const journal = {
        id: reply.comment.id, user: reply.login, at: reply.comment.created_at || new Date(nowMs(deps)).toISOString(),
        command: reply.reply.command, text: redact(reply.reply.text || ""),
      };
      human = { ...human, replies: [...human.replies, journal] };
      if (reply.reply.command === "abandon") {
        return blocked(failure, "human requested abandon", { ...record, human }, "human-abandon");
      }
      if (reply.reply.command === "addendum") {
        if (typeof reauthor !== "function") return blocked(failure, "reauthor is unavailable", { ...record, human }, "no-channel");
        return reauthor({
          failure,
          record: { ...record, human, attempt: (record.attempt || 0) + 1 },
          addendum: reply.reply.text,
          addendumAuthor: reply.login,
          addendumAt: journal.at,
          revise: true,
        });
      }
      const baseMaxAttempts = record.policy?.baseMaxAttempts ?? policy.baseMaxAttempts ?? maxAttempts;
      const raised = raiseMaxAttempts({
        maxAttempts,
        baseMaxAttempts: Number.isFinite(baseMaxAttempts) ? baseMaxAttempts : 3,
        grantedExtra: record.policy?.grantedExtra || 0,
      }, reply.reply.count);
      if (!raised.granted) return stoppedAtCap(failure, human, { ...record, human });
      const nextRecord = {
        ...record,
        attempt: (record.attempt || 0) + 1,
        human,
        policy: { ...(record.policy || policy), maxAttempts: raised.maxAttempts, baseMaxAttempts, grantedExtra: raised.grantedExtra },
      };
      if (typeof runCycle !== "function") return blocked(failure, "fresh cycle is unavailable", nextRecord, "no-channel");
      return { cycle: await runCycle({ fresh: true }), record: nextRecord };
    }
    if (nowMs(deps) >= new Date(deadline).getTime()) {
      try {
        commentOnce({
          kind: channel.kind === "draft-pr" ? "pr" : channel.kind,
          target: channel.target,
          body: redact(timeoutComment(runId, human)),
          marker: `${runId}:timeout:${attempt}`,
        }, deps);
      } catch {
        // The timeout remains the authoritative outcome even if the optional
        // explanatory comment cannot be posted.
      }
      return timedOut(failure, runId, human, { ...record, human });
    }
    await sleep(interval * 1000);
    interval = Math.min(interval * 2, MAX_POLL_SECONDS);
  }
}
