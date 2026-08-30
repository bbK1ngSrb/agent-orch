#!/usr/bin/env bash
#
# orch-loop.sh — run orch, but wait out Claude usage limits and auto-resume.
#
# orch classifies a usage limit on either seat as AGENT_QUOTA and escalates
# (exit 2); the author seat used to throw instead (exit 1). Either way a single
# orch run still STOPS when the limit is hit, so this wrapper gates each run on
# quota with a cheap pre-flight probe — when the 5h limit is up, it sleeps until
# reset (parsed from the CLI message, else a fixed poll) and retries, so a
# single invocation survives the limit window.
#
# Resume: a run KILLED by the limit (no orch result at all) still leaves its sid
# in .orch/resume/, so the retry reattaches the branch and continues from the
# author's committed work instead of re-authoring (issue #24). A run that orch
# now ESCALATES as AGENT_QUOTA is a completed result, so it clears its resume
# record like every other escalation and the retry starts a fresh cycle; any
# wip(author) commit is still on the branch for a human or a later `orch continue`.
#
# Usage:   orch-loop.sh [orch args ...]        e.g.  orch-loop.sh task
#          orch-loop.sh --selftest             run internal assertions, exit
# Env:     ORCH_CMD   command to run orch         (default: orch)
#          PROBE_CMD  cheap quota probe           (default: claude -p ok)
#          POLL       re-probe interval, seconds  (default: 900 = 15m)
#          MAX_WAITS  give up after N limit waits  (default: 0 = unlimited)
#
set -uo pipefail

ORCH_CMD="${ORCH_CMD:-orch}"
PROBE_CMD="${PROBE_CMD:-claude -p ok}"
POLL="${POLL:-900}"
MAX_WAITS="${MAX_WAITS:-0}"

log() { echo "[$(date '+%F %T')] $1" >&2; }

# True if text looks like a Claude usage/rate-limit message.
# Retry only for the orch statuses that can represent quota deaths, and only
# when the probe still reports a limit. Other nonzero statuses are terminal.
is_quota_exit() {
    case "$1" in
        1|2) is_limit "$2" ;;
        *)   return 1 ;;
    esac
}

is_limit() {
    grep -qiE 'usage limit|rate.?limit|limit (will )?reset|resets? at|429|overloaded' <<<"$1"
}

# Echo seconds to sleep before retrying, given a limit message. Prefers an
# explicit reset time (unix epoch, or "reset at H[:MM]am/pm"); falls back to POLL.
# ponytail: time-string parsing is fragile across CLI versions — POLL fallback
# means we always recover within one poll even when the parse misses.
sleep_secs() {
    local msg="$1" now epoch hh mm
    now=$(date +%s)
    # 1) bare 10-digit unix epoch in the message
    epoch=$(grep -oE '\b1[0-9]{9}\b' <<<"$msg" | head -n1)
    if [ -n "$epoch" ] && [ "$epoch" -gt "$now" ]; then
        echo $(( epoch - now + 30 )); return
    fi
    # 2) "reset at 3pm" / "reset at 3:30 am"
    if [[ "$msg" =~ reset[[:space:]]+at[[:space:]]+([0-9]{1,2})(:([0-9]{2}))?[[:space:]]*([apAP][mM]) ]]; then
        hh="${BASH_REMATCH[1]}"; mm="${BASH_REMATCH[3]:-00}"
        local ampm="${BASH_REMATCH[4],,}"
        [ "$ampm" = pm ] && [ "$hh" -lt 12 ] && hh=$(( hh + 12 ))
        [ "$ampm" = am ] && [ "$hh" -eq 12 ] && hh=0
        # Claude states the reset in UTC ("reset at 3pm (UTC)"). Resolve the wall
        # time in the zone the message names, not the host's local zone — else a
        # non-UTC host computes the wrong target and oversleeps (see issue #21).
        # ponytail: only UTC/GMT recognized (that's what the CLI emits); any other
        # explicit offset would need a real tz parse — POLL fallback still bounds it.
        # NB: TZ="" means UTC on glibc, not local — so only export TZ for the UTC
        # case and run a bare `date` (host local zone) otherwise.
        local target
        if [[ "$msg" =~ (UTC|GMT) ]]; then
            target=$(TZ=UTC date -d "today ${hh}:${mm}" +%s 2>/dev/null) || target=""
        else
            target=$(date -d "today ${hh}:${mm}" +%s 2>/dev/null) || target=""
        fi
        if [ -n "$target" ]; then
            [ "$target" -le "$now" ] && target=$(( target + 86400 ))  # already passed -> tomorrow
            echo $(( target - now + 30 )); return
        fi
    fi
    echo "$POLL"
}

# Block until the probe succeeds (quota available). Only loops on a limit
# signature — any other probe outcome returns so orch can surface the real error.
wait_for_quota() {
    local out rc waits=0 nap
    while :; do
        out=$($PROBE_CMD 2>&1); rc=$?
        if [ "$rc" -eq 0 ] && ! is_limit "$out"; then
            return 0
        fi
        if ! is_limit "$out"; then
            log "probe failed (rc=$rc) but not a limit — proceeding, orch will surface it"
            return 0
        fi
        waits=$(( waits + 1 ))
        if [ "$MAX_WAITS" -gt 0 ] && [ "$waits" -gt "$MAX_WAITS" ]; then
            log "hit MAX_WAITS=$MAX_WAITS — giving up"; return 1
        fi
        nap=$(sleep_secs "$out")
        log "usage limit (wait #$waits) — sleeping ${nap}s until reset"
        sleep "$nap"
    done
}

main() {
    while :; do
        # Manual kill-switch wins: stop the loop, don't fight it.
        if [ -f .orch/pause ]; then
            log ".orch/pause present — stopping loop"; exit 0
        fi
        wait_for_quota || exit 1

        log "running: $ORCH_CMD $*"
        $ORCH_CMD "$@"; rc=$?

        case "$rc" in
            0)  log "orch finished (rc=$rc)"; exit 0 ;;   # done: approved / merged
            5)  # ACTION_REQUIRED: the cycle succeeded and is waiting on one
                # human gesture, such as merging an approved `orch pr`.
                log "orch finished — waiting on a human action (rc=$rc)"; exit 0 ;;
            *)  # Exit 1 is the historical author failure; exit 2 is the
                # AGENT_QUOTA escalation. The limit probe distinguishes those
                # quota deaths from ordinary failures within those statuses.
                out=$($PROBE_CMD 2>&1)
                if is_quota_exit "$rc" "$out"; then
                    log "orch exit $rc was a usage limit — will wait & resume"
                    continue
                fi
                log "orch exit $rc is a real error (not quota) — stopping"; exit "$rc" ;;
        esac
    done
}

selftest() {
    local f
    is_limit "Claude usage limit reached. Your limit will reset at 3pm (UTC)." || { echo "FAIL detect text"; exit 1; }
    is_limit "Error 429: rate limit exceeded" || { echo "FAIL detect 429"; exit 1; }
    is_limit "build completed successfully" && { echo "FAIL false-positive"; exit 1; }
    is_quota_exit 1 "Claude usage limit reached" || { echo "FAIL retry exit 1"; exit 1; }
    is_quota_exit 2 "Claude usage limit reached" || { echo "FAIL retry exit 2"; exit 1; }
    is_quota_exit 3 "Claude usage limit reached" && { echo "FAIL retry exit 3"; exit 1; }
    is_quota_exit 4 "Claude usage limit reached" && { echo "FAIL retry exit 4"; exit 1; }
    is_quota_exit 5 "Claude usage limit reached" && { echo "FAIL retry exit 5"; exit 1; }
    # #575: a blocked run must never be retried as a quota death. That outcome
    # moved from exit 3 to exit 6, so assert the code it actually uses now —
    # exit 3 above is the concurrency refusal, a different outcome entirely.
    is_quota_exit 6 "Claude usage limit reached" && { echo "FAIL retry exit 6"; exit 1; }
    is_quota_exit 0 "Claude usage limit reached" && { echo "FAIL retry on success"; exit 1; }
    # An ordinary escalation (exit 2, no limit in the probe) must STOP the wrapper.
    is_quota_exit 2 "build completed successfully" && { echo "FAIL retry non-limit"; exit 1; }
    # epoch parse: 1h in the future -> ~3630s (+30 grace)
    local future; future=$(( $(date +%s) + 3600 ))
    f=$(sleep_secs "limit reset $future"); [ "$f" -gt 3600 ] && [ "$f" -lt 3700 ] || { echo "FAIL epoch parse ($f)"; exit 1; }
    # no parseable time -> POLL fallback
    POLL=900 f=$(sleep_secs "usage limit reached, try later"); [ "$f" -eq 900 ] || { echo "FAIL poll fallback ($f)"; exit 1; }
    # am/pm parse returns something positive and < 24h
    f=$(sleep_secs "your limit will reset at 3pm"); [ "$f" -gt 0 ] && [ "$f" -le 86430 ] || { echo "FAIL ampm parse ($f)"; exit 1; }
    # UTC marker honored regardless of host TZ (issue #21): under a non-UTC zone,
    # "reset at 3pm (UTC)" must target 15:00 UTC, not 15:00 local. Compare against
    # an independent 15:00-UTC computation; allow 60s for grace + clock drift.
    local want got delta
    want=$(TZ=UTC date -d "today 15:00" +%s); now=$(date +%s)
    [ "$want" -le "$now" ] && want=$(( want + 86400 ))
    want=$(( want - now + 30 ))
    got=$(TZ="America/New_York" sleep_secs "Your limit will reset at 3pm (UTC)")
    delta=$(( got - want )); delta=${delta#-}
    [ "$delta" -le 60 ] || { echo "FAIL utc tz (got=$got want=$want)"; exit 1; }
    echo "selftest OK"
}

if [ "${1:-}" = "--selftest" ]; then selftest; exit 0; fi
main "$@"
