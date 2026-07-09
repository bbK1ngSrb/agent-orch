#!/usr/bin/env bash
#
# auditor-loop.sh — fire a fresh `codex exec` audit per builder run-file.
#
# Watches docs/ for `task<N>-run<M>.md` that has no matching
# `task<N>-audit<M>.md`, runs codex once to audit task N against docs/plan.md,
# expects codex to write `docs/task<N>-audit<M>.md` ending with a
# `VERDICT: APPROVED|CHANGES` line, then commits + pushes it.
#
# One-shot per audit = fresh context each time, resilient to any single failure.
# Stop with Ctrl-C. Safe to restart: it only acts on run-files lacking audits.
#
# Usage:  ~/agent-orch/harness/auditor-loop.sh
# Env:    REPO (default ~/agent-orch)   POLL (default 20s)

set -uo pipefail

REPO="${REPO:-$HOME/agent-orch}"
DOCS="$REPO/docs"
POLL="${POLL:-20}"
PROMPT_TPL="$REPO/harness/audit-prompt.md"

command -v codex >/dev/null 2>&1 || { echo "codex not in PATH" >&2; exit 1; }
[ -f "$PROMPT_TPL" ] || { echo "missing $PROMPT_TPL" >&2; exit 1; }
cd "$REPO" || exit 1

echo "[auditor] watching $DOCS (poll ${POLL}s). Ctrl-C to stop."

while true; do
    git pull --rebase -q 2>/dev/null || true

    pend_n=""; pend_m=""
    # Oldest pending run-file first, so audits stay in task order.
    for run in $(ls -1 "$DOCS"/task*-run*.md 2>/dev/null | sort -V); do
        base="$(basename "$run")"
        [[ "$base" =~ ^task([0-9]+)-run([0-9]+)\.md$ ]] || continue
        n="${BASH_REMATCH[1]}"; m="${BASH_REMATCH[2]}"
        [ -f "$DOCS/task${n}-audit${m}.md" ] && continue
        pend_n="$n"; pend_m="$m"; break
    done

    if [ -z "$pend_n" ]; then
        sleep "$POLL"; continue
    fi

    out="$DOCS/task${pend_n}-audit${pend_m}.md"
    echo "[auditor] $(date '+%T') auditing task ${pend_n} run ${pend_m} -> codex"
    prompt="$(sed "s/{{N}}/${pend_n}/g; s/{{M}}/${pend_m}/g" "$PROMPT_TPL")"

    codex exec --cd "$REPO" --dangerously-bypass-approvals-and-sandbox "$prompt" \
        || echo "[auditor] WARN codex exited nonzero"

    if [ -f "$out" ]; then
        verdict="$(grep -oE 'VERDICT: (APPROVED|CHANGES)' "$out" | tail -1)"
        echo "[auditor] wrote $(basename "$out") — ${verdict:-NO VERDICT LINE}"
        git add "$out" \
          && git commit -q -m "audit: task${pend_n} run${pend_m} (${verdict:-?})" \
          && git push -q 2>/dev/null
        [ -n "$verdict" ] || echo "[auditor] WARN audit missing VERDICT line — builder may stall"
    else
        echo "[auditor] WARN codex did not create $out; retrying in ${POLL}s"
        sleep "$POLL"
    fi
done
