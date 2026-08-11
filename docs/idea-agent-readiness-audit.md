# Findings — how orch handles an unavailable agent today

Companion to [idea-agent-quota-exclusion.md](idea-agent-quota-exclusion.md), which
proposes the fix. This file records what the code actually does **now**, from a
read-only audit on 2026-08-11, so the fix is designed against verified behavior
rather than assumption. Every claim below carries a `file:line` citation; where an
earlier note in this repo was imprecise, the correction is called out.

## Why this was audited

Three unrelated agent failures in one afternoon, all while running the optimization
issue queue (#438–#446):

| Failure text | Where it hit | What orch did |
|---|---|---|
| `You've hit your session limit · resets 3:20am` | claude, mid-author | aborted, exit 1 |
| `Selected model is at capacity` | codex, mid-author | aborted, exit 1 |
| `403 … You've reached your usage limit for this billing cycle` (2026-08-01) | kimi, mid-review | aborted, exit 1 |

Each cost a worktree setup and left an empty `pr/<agent>/<slug>-<sid>-0` branch
behind. The third one is the case that motivated the quota-exclusion idea; the
first two are new, and — see below — neither is even *detected* by the mechanism
that idea assumes exists.

## What the code does today

### Preflight checks executable bits, nothing else

`preflight(cfg, orchDir, opts)` (`src/cli.js:532`) runs before every cycle
(`cli.js:1049, 1146, 1156, 1340, 1564, 1667`) and, per agent, does exactly three
things: reject an unknown adapter name (`cli.js:534`), reject a statically
`disabled` adapter (`cli.js:535`, e.g. `agy` at `src/adapters/agy.js:30`), and
resolve the binary with `resolveAgentBin` (`src/agent-bin.js:21`) — a PATH plus
fallback-dir scan using `accessSync(p, X_OK)`. Then it probes `.orch/` for
writability (`cli.js:545-553`).

It never spawns the agent. No `--version`, no auth check, no quota check. A CLI
that is installed but logged out, unauthenticated, or already at capacity passes
preflight and fails later, mid-cycle, after the worktree exists.
`src/detect.js:23` (`orch init`'s probe) is the same PATH-only check.

### Limit detection exists — but only on the reviewer seat

```js
const LIMIT_RE = /usage limit|rate.?limit|limit (will )?reset|resets? at|\b429\b|overloaded/i;
export function isUsageLimit(text) { return LIMIT_RE.test(text || ""); }
```
(`src/adapters/cli-adapter.js:33-36`)

`isUsageLimit` has exactly one caller: `runCapture` (`cli-adapter.js:287-289`),
which is used by `audit()` (`cli-adapter.js:472`). On a match it rethrows
`usage limit hit: …`.

**`author()` never consults it.** It calls `runAgent` directly and, on any
failure, throws `result.out || "Command failed: …"` (`cli-adapter.js:449`) — with
no inspection of the cause. Rate limit, expired login, provider capacity, or a
genuine crash are one undifferentiated failure on the author path.

This corrects a claim in the sibling idea doc and in `FUTURE.md`, both of which say
orch "already detects the condition" without qualification. It detects it for
**reviewers only**.

### The regex misses two of the three real failures

`LIMIT_RE` matches the literal phrases `usage limit`, `rate limit`/`ratelimit`,
`limit reset`/`limit will reset`, `resets at`, `429`, and `overloaded`. It does
**not** match:

- `Selected model is at capacity` — no substring hits. (`overloaded` is present,
  but that is different wording.)
- `You've hit your session limit` — "session limit" is not in the pattern.
- a bare `403` — already noted in the quota-exclusion doc.

Of the three failures in the table above, only kimi's matched, and only because its
message happened to contain the words "usage limit".

### No fallback to another agent, on either seat

Rotation (`src/cli.js:490-527`, `cfg.agents[(i+1) % cfg.agents.length]`) decides who
is picked for the *next invocation*; it is not a retry path. `runCycle` opens a
`try` at `engine.js:114` whose only companion is a `finally` that prunes the
worktree (`engine.js:367-370`) — there is no `catch`, so any throw from `author()`
(`engine.js:124`, `engine.js:363`) leaves `runCycle` uncaught, reaches
`bin/orch.js:3-6`, and exits 1.

The only agent-swap mechanism is manual and reviewer-only: `orch continue
--reviewer <agent>` (`cli.js:1549-1555`), whose purpose is documented at
`engine.js:162-165`. There is no equivalent for a failed author — the expensive
stage cannot be handed to a different agent without re-running from scratch.

### Exit codes conflate causes

- **0** — `merged` / `approved`.
- **2** — `escalated` / `merge-deferred` (`cli.js:1199, 1221, 1422, 1442, 1646,
  1678`). This bucket holds *both* a real quality DISAGREE after `roundCap` *and*
  `agentError` — a reviewer that crashed or returned "at capacity"
  (`cli-adapter.js:505`). "The reviewer disagreed with the code" and "the reviewer
  never ran" are the same exit code, separated only by free text in `reason`.
- **1** — every uncaught throw, funnelled through one generic handler
  (`bin/orch.js:3-6`): agent binary missing, adapter disabled, `.orch` unwritable,
  lock contention, concurrency cap, **any** author-side failure, and reviewer-side
  usage limits. "Infrastructure unavailable" and "orch has a bug" are
  indistinguishable to a caller or a script.

There is no `AGENT_UNAVAILABLE` status or exit code.

### Retry/backoff lives outside the tool

`harness/orch-loop.sh` is the actual wait-and-resume mechanism: it pre-probes with
`claude -p ok`, sleeps until reset, and re-invokes `orch` (`orch-loop.sh:104-126`).
Three caveats: it is not installed or invoked by `orch` itself (users must run the
wrapper instead of `orch`), its `is_limit()` (`orch-loop.sh:39`) is a hand-copied
duplicate of `LIMIT_RE` with the same blind spots, and its header comment
(`orch-loop.sh:5-9`) still describes a mid-audit limit as "masked as a DISAGREE" —
stale, since the same commit (`ea22c3a`) that added the wrapper also added the
`runCapture` rethrow that stopped the masking. It is also claude-specific.

### No configuration surface

`DEFAULTS` (`src/config.js:6-53`) has no `limitPattern`, no `retries`, no
`fallbackAgents`, no auth or quota key; neither does a live `.orch/orch.yml`.
`LIMIT_RE` is hardcoded and non-overridable. `stageTimeout` (default 25 min) is a
*hang* watchdog — it kills a child that stops producing output and resolves
`ok: false`; it has no bearing on recognizing an auth or capacity error, which
typically fails fast.

## Gap list

1. Author-seat failures are never classified — no limit detection at all.
2. `LIMIT_RE` misses "at capacity", "session limit", and bare `403`.
3. No automatic fallback to the next agent in the pool on either seat.
4. Exit 1 conflates infrastructure unavailability with genuine bugs; exit 2
   conflates reviewer crash with reviewer disagreement.
5. Preflight cannot see auth or quota state — failures surface only after the
   worktree is created, leaving an empty branch behind.
6. Retry logic is in an external, claude-specific bash wrapper with a duplicated
   regex and a stale comment.

## What this implies for the parked fix

[idea-agent-quota-exclusion.md](idea-agent-quota-exclusion.md) proposes moving
detection into the adapter contract as a per-agent `limitPattern`/`isLimit(text)`
and dropping an exhausted agent from the pool mid-run. This audit supports that
direction and adds three constraints:

- The hook must be consulted on the **author** path too, not just `runCapture` —
  otherwise the most expensive stage stays unprotected.
- "Unavailable" is broader than "out of quota": provider capacity errors carry no
  quota semantics and no reset time, so a design keyed on "wait until reset" needs
  a second branch for "try someone else now".
- Dropping an agent mid-run only helps if the *author* seat can be reassigned;
  today even the manual escape hatch (`orch continue --reviewer`) covers reviewers
  only.

A cheap independent improvement, orthogonal to all of the above: give
"agent unavailable" its own exit code, so a queue runner can skip and continue
instead of guessing from message text.
