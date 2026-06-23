#!/usr/bin/env bash
#
# supervise.sh — minimal restart watchdog for a long-running command.
#
# Re-launches the command whenever it exits (crash, OOM, kill, terminal close),
# with backoff. NO stall guard: the auditor idles silently between run-files by
# design, so "no output" is not a hang. Stop with Ctrl-C.
#
# Usage:  supervise.sh [command ...]      (default: the auditor loop)
# Env:    BACKOFF (default 10s)  MAX_RESTARTS (default 0 = unlimited)
#         LOG_DIR (default ~/.claude/supervisor)  NAME (default auditor)
#
# ponytail: restart-on-exit only — that's the one failure mode a polling loop
# can't self-heal. Add a stall guard only if the supervised cmd can truly hang.

set -uo pipefail

NAME="${NAME:-auditor}"
BACKOFF="${BACKOFF:-10}"
MAX_RESTARTS="${MAX_RESTARTS:-0}"
LOG_DIR="${LOG_DIR:-$HOME/.claude/supervisor}"

DEFAULT_CMD=("$HOME/agent-orch/harness/auditor-loop.sh")
if [ "$#" -gt 0 ]; then CMD=("$@"); else CMD=("${DEFAULT_CMD[@]}"); fi

mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/${NAME}-$(date +%Y%m%d-%H%M%S).log"
ACTIVE_DIR="$LOG_DIR/active"; mkdir -p "$ACTIVE_DIR"
MARKER="$ACTIVE_DIR/$$.${NAME}"
printf '%s|%s|%s\n' "$NAME" "${CMD[*]}" "$(date +%s)" > "$MARKER"

log() { echo "[$(date '+%F %T')] $1" | tee -a "$LOG"; }
cleanup() { [ -n "${CHILD:-}" ] && kill "$CHILD" 2>/dev/null; rm -f "$MARKER"; }
trap cleanup EXIT INT TERM

log "supervise '$NAME' start: ${CMD[*]}"
log "log: $LOG"

restarts=0
while :; do
    "${CMD[@]}" >>"$LOG" 2>&1 &
    CHILD=$!
    wait "$CHILD"; rc=$?
    log "child exited rc=$rc"

    restarts=$(( restarts + 1 ))
    if [ "$MAX_RESTARTS" -gt 0 ] && [ "$restarts" -ge "$MAX_RESTARTS" ]; then
        log "hit MAX_RESTARTS=$MAX_RESTARTS — stopping. log: $LOG"; exit 1
    fi
    log "restart #$restarts in ${BACKOFF}s"
    sleep "$BACKOFF"
done
