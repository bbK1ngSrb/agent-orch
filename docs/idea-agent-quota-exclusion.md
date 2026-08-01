# Idea — drop quota-exhausted agents from the rotation pool

Parked for v0.5. Came out of a real failure on 2026-08-01: two consecutive cycles
died because the rotation pool handed work to an agent whose billing quota was
exhausted.

## What happened

Running `#422 Part 5` and `#426` in parallel, both cycles drew `kimi` from the
`agents:` pool and both died on the same error:

```
error: failed to run prompt: provider.api_error: 403 You've reached your usage
limit for this billing cycle. Your quota will be refreshed in the next cycle.
```

`#426` lost its author stage outright. `Part 5` was worse: `grok` **completed**
authoring, the commit landed on the branch, and then `kimi` drew the reviewer seat
and 403'd — so a finished piece of work was stranded on a branch with no verdict.
Recovering it needed `orch review <branch> --reviewer codex`, because `orch
continue` could not help (see "Related gap" below).

The workaround was manual: pass explicit `--author`/`--reviewer` role specs, then
edit `kimi` out of `agents:` in `.orch/orch.yml` by hand.

## The signal already exists

This is not a detection problem. `src/adapters/cli-adapter.js:30`:

```js
const LIMIT_RE = /usage limit|rate.?limit|limit (will )?reset|resets? at|\b429\b|overloaded/i;
```

and line 248 turns a match into `throw new Error("usage limit hit: …")`. orch
recognises the condition perfectly well — it just has no response other than
aborting the whole cycle. The idea is to use a signal already in hand, not to add
a new one.

(Note the regex has no `\b403\b`; today's match came from the phrase "usage limit"
in kimi's message text. A provider that returns a bare 403 with different wording
would slip past. See "Detection belongs in the adapter" below — widening the shared
regex is the lesser fix.)

## Detection belongs in the adapter, not one shared regex

`LIMIT_RE` is a single pattern trying to cover claude, codex, grok, kimi, copilot,
gemini and agy. Each CLI words its quota error differently — kimi says "You've
reached your usage limit", Claude says "resets at", and a provider that returns a
bare `403 Forbidden` with no prose matches nothing at all and surfaces as a generic
agent error. One regex per orch, for N providers whose error text orch does not
control, only degrades as agents are added.

The adapter contract already carries exactly this kind of per-agent knowledge:

```js
export default makeCliAdapter({ name: "codex", bin: "codex", buildArgs,
                                capabilities: { model: true, effort: true } });
```

Adding a `limitPattern` (or `isLimit(text)`) alongside `capabilities`, defaulting to
the shared `LIMIT_RE` when omitted, puts the knowledge where the provider-specific
knowledge already lives. No new concept — the same shape as `capabilities`, which
every adapter already declares.

`orch agent build <name>` should scaffold the field, so a new adapter is born with a
place for it rather than silently inheriting a regex that may not match its CLI.

**Honest limit on the scaffolding half:** the agent writing a new adapter usually
cannot know the CLI's quota wording, because that text is only observable by
exhausting the quota. So `agent build` can realistically emit a placeholder plus the
shared default and a comment along the lines of "fill this in the first time you see
a real limit error from this CLI". That is still a clear win: it turns an invisible
per-agent gap in a shared regex into a visible empty field in the adapter file.

This is not a separate feature from the exclusion work — excluding an agent on quota
exhaustion is worthless if the exhaustion is not recognised in the first place.
Detection is the prerequisite half.

## Two options, and why one is weaker

**A. Probe each agent before the cycle starts.** Ask every pooled agent something
trivial, drop the ones that error, then begin.

Rejected. Today's Part 5 failure is the counter-example: `grok` authored
successfully and `kimi` failed *afterwards*, at the review stage. A pre-flight
probe minutes earlier would have reported "kimi OK" and been wrong by the time it
mattered. Quota is state that changes underneath you, so an early check is a guess
that costs one real API call per agent per cycle and still cannot prevent the
mid-cycle case. It also burns quota to discover quota.

**B. Exclude on failure, mid-run.** Catch the usage-limit throw at the rotation
site, drop that agent from the pool for the remainder of the run, re-draw, carry
on.

Preferred. The failure itself is free, always current, and covers both the
dead-on-arrival agent and the one that dies mid-cycle with a single mechanism.
Roughly ten lines at the draw site plus a set of excluded names held for the
duration of the run.

## The open question — scope of the exclusion

In-run only is small and stateless: the exclusion set lives in memory and dies
with the process. Covers the common case (a cycle, or a batch of parallel cycles,
that would otherwise all trip over the same dead agent).

Cross-run needs state in `.orch/` plus an expiry policy, and the expiry is the part
that rots. There is no reliable TTL to read off the error text: kimi's quota is
billing-cycle based (could be weeks), Claude's resets hourly and actually says
"resets at" in the message. Get this wrong in the safe direction and you are still
running a three-agent pool next month for no reason.

Suggested split: build the in-run version first, and only add persistence if the
same agent keeps costing whole cycles across separate invocations. If persistence
does happen, prefer parsing an explicit reset time when the provider gives one
(`resets? at` is already in `LIMIT_RE`) and falling back to a short, conservative
cooldown rather than an indefinite ban.

## Related gap, worth its own issue

When the Part 5 cycle died during round-1 review, it left an authored branch with a
real commit and **no checkpoint or inflight record** — `checkpoint.record` only
runs after an audit completes. So:

```
$ orch continue 4182882-0 --reviewer codex
orch: no checkpoint or inflight record for sid 4182882-0 — nothing to resume
```

The work existed and was recoverable, but not by the command built for recovering
it. A crash inside the round-1 review window is exactly when resume should help and
currently cannot. Fixing that is independent of the quota work.
