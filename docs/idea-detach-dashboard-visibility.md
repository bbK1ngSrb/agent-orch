# Idea: run multiple orch cycles from one terminal (#planned v0.5)

Motivating case: user wants to fire off 3 `orch task`/`orch issue` cycles
without opening 3 terminal tabs, and see all 3 as "running" in `orch
dashboard` the same way finished runs show up in history.

## Panel discussion (4 stances)

**Feature advocate**: build `--detach` as a first-class flag on `orch task`/
`orch issue`. Spawn a background child, redirect stdout to a log file,
register PID + session id + status into the existing `runs.jsonl` registry
so `orch dashboard` shows it identically to attached runs (`detached: true`
field, no separate visual tier). Needs companion commands: `orch attach
<sid>` (tail log live, Ctrl-C detaches again without killing), `orch logs
<sid>` (one-shot), `orch kill <sid>` (SIGTERM + mark `killed`, no zombie
rows). MVP = detach + registry + attach + kill.

**Maintainer skeptic**: don't build it, or not now. `--detach` means orch
owns process lifecycle — reparenting, PID reuse after reboot, unbounded log
growth, double-launch races on registry writes. We already solved the two
underlying problems better and separately: the stage watchdog handles
stalled processes (SIGKILL + timeout), and `orch continue <sid>` handles
"walk away and come back" via checkpoint/resume — which survives a reboot,
not just a closed terminal. `nohup orch task ... & disown` or tmux gets 90%
of this for free using OS primitives we don't have to test or own bugs in.
Single-dep educational project — every dependency on OS process semantics
we take on is exactly the complexity "single dep" exists to avoid.

**Reliability/ops lens**: ship with hard rails or don't ship. Real risk
isn't worktree isolation (orch already does that per-cycle) — it's removing
the human backstop. Today, 3 terminal tabs means a person notices a stuck
merge and intervenes; 3 detached background PIDs from one shell means nobody
is watching `HEAD` if any step ever touches the shared checkout. Also:
concurrent LLM CLI calls (rate limits, cost blowout on a spiraling cycle),
concurrent git processes fighting over `.git/index.lock`. Must answer
explicitly whether children survive parent-shell death (if not, `--detach`
is pointless; if so, need to find/kill them without reconstructing which
shell spawned what). Non-negotiable before shipping: per-repo serialization
(one detached cycle at a time per repo, others queue), global concurrency
cap, a real kill-switch that reaps the process group, staleness/heartbeat
detection in the dashboard.

**YAGNI minimalist**: don't build spawn/supervise code at all. The one-liner
already solves it:
```sh
for c in "fix auth bug" "add rate limiting" "update deps"; do
  nohup orch task "$c" > "logs/$(date +%s)-orch.log" 2>&1 & disown
done
```
or `tmux new-session -d -s orch1 'orch task "..."'` for attach/reattach.
Zero new orch code, zero new flag, zero new failure surface. If dashboard
blindness is the actual complaint, that's a *discovery* gap not a
*supervision* gap: have the dashboard scan the runs registry / session dirs
for entries with a live PID, mark them "running (detached)" regardless of
whether the process was launched via nohup, tmux, systemd, or `orch
--detach` — read-only, few-line addition to code the dashboard already owns.

## Where it landed

Real fork is spawn-and-own (advocate + ops: full control loop, but ops's
price tag is a genuine supervision subsystem) vs. discover-and-observe
(skeptic + minimalist: shell already spawns/attaches/kills correctly, orch
should only read).

Recommended default: build the discover-only version first — dashboard
marks any run with a live PID as "running" whether launched via `nohup`,
`tmux`, or a future `orch --detach`. Ship a `nohup` one-liner in the README
for "3 from one terminal" today. Only add `orch kill <sid>` later, and only
if `pgrep`/`tmux attach` in practice proves annoying enough to justify it —
that's the one piece worth owning even under the minimal design, since it's
a single small command with no spawning/lifecycle code behind it. Skip a
`--detach` flag entirely unless discovery-only doesn't scratch the itch.
