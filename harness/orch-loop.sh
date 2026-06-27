#!/usr/bin/env bash
#
# orch-loop.sh — run orch, but wait out Claude usage limits and auto-resume.
#
# orch shells out to the `claude` CLI and has NO quota handling: a usage-limit
# hit mid-audit is masked as a DISAGREE, and mid-author it throws (exit 1).
# This wrapper gates each run on quota with a cheap pre-flight probe — when the
# 5h limit is up, it sleeps until reset (parsed from the CLI message, else a
# fixed poll) and retries, so a single invocation survives the limit window.
#
# Usage:   orch-loop.sh [orch args ...]        e.g.  orch-loop.sh task
#          orch-loop.sh --selftest             run internal assertions, exit
# Env:     ORCH_CMD   command to run orch         (default: orch)
#          PROBE_CMD  cheap quota probe           (default: claude -p ok)
#          POLL       re-probe interval, seconds  (default: 900 = 15m)
#          MAX_WAITS  give up after N limit waits  (default: 0 = unlimited)
#
# ponytail: probe-gate + exit-code disambiguation only. It does NOT fix orch's
# mid-audit DISAGREE-masking (that's an orch code change). If you need audits to
# also pause on quota, make src/adapters/cli-adapter.js:runCapture detect the
# limit string and rethrow instead of returning ok:false.

set -uo pipefail

ORCH_CMD="${ORCH_CMD:-orch}"
PROBE_CMD="${PROBE_CMD:-claude -p ok}"
POLL="${POLL:-900}"
MAX_WAITS="${MAX_WAITS:-0}"

log() { echo "[$(date '+%F %T')] $1" >&2; }

# True if text looks like a Claude usage/rate-limit message.
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
        local target; target=$(date -d "today ${hh}:${mm}" +%s 2>/dev/null) || target=""
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
            0|2)  log "orch finished (rc=$rc)"; exit "$rc" ;;   # done: approved / verdict
            *)    # hard error — quota during author looks like this. Re-probe to tell
                  # a limit apart from a genuine bug.
                  out=$($PROBE_CMD 2>&1)
                  if is_limit "$out"; then
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
    # epoch parse: 1h in the future -> ~3630s (+30 grace)
    local future; future=$(( $(date +%s) + 3600 ))
    f=$(sleep_secs "limit reset $future"); [ "$f" -gt 3600 ] && [ "$f" -lt 3700 ] || { echo "FAIL epoch parse ($f)"; exit 1; }
    # no parseable time -> POLL fallback
    POLL=900 f=$(sleep_secs "usage limit reached, try later"); [ "$f" -eq 900 ] || { echo "FAIL poll fallback ($f)"; exit 1; }
    # am/pm parse returns something positive and < 24h
    f=$(sleep_secs "your limit will reset at 3pm"); [ "$f" -gt 0 ] && [ "$f" -le 86430 ] || { echo "FAIL ampm parse ($f)"; exit 1; }
    echo "selftest OK"
}

if [ "${1:-}" = "--selftest" ]; then selftest; exit 0; fi
main "$@"
