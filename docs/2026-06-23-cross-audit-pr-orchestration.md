# Cross-Audit PR Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On every push of a `pr/<author>/<topic>` branch to the local bare repo, headlessly run the *opposite* agent (claude↔codex) as an adversarial reviewer; auto-merge on AGREE + green `deploy.sh`; run a capped revise loop on disagreement; hand a pros/cons brief to the human on a 3-round stalemate.

**Architecture:** A bare-repo `post-receive` hook filters `pr/*` refs, enforces the line-count cap, then detaches `pr-orchestrator.sh`. The orchestrator runs a state machine (review → merge | revise | escalate) entirely on the `rdp` host, driving headless `codex exec` / `claude -p` in throwaway worktrees. All scripts are versioned in the work tree under `ops/pr-orchestration/`; `install.sh` deploys the hook into the bare repo. Verdicts are stored out-of-band so they never re-trigger the hook.

**Tech Stack:** Bash, git (worktrees, hooks, trailers), `flock`, `setsid` (reuse `claude-supervisor` detach pattern), telegram MCP via a notify shim, plain-bash `test_*.sh` self-checks (no bats — YAGNI).

## Global Constraints

- Bare repo (`origin`): `/mnt/nas-soul/nfs/stepa.local/repos/unilever.git`. Work tree: `/mnt/nas-soul/nfs/stepa.local/work/unilever`.
- PRs live on the bare repo only — **never GitHub** (it is a `--mirror`; PRs get clobbered).
- Existing `post-receive` content `git push --mirror https://github.com/bbK1ngSrb/unilever.git` **must be preserved** — chain, do not replace.
- PR branch name: `pr/<author>/<topic>`, `<author> ∈ {claude, codex}`. Reviewer = opposite agent.
- **Scope cap:** changed lines vs `main` (`added+deleted` from `git diff --numstat main...<branch>`, minus paths in `pr-scope.ignore`) **< 100** = hard hook gate. **≤ 3 logical changes** = reviewer judgment (verdict criterion, not mechanical).
- **Merge gate:** auto-merge requires `AGREE` **and** `deploy.sh` exit 0. Agents never push `main`; only the orchestrator (via `deploy.sh`) publishes.
- **Revise cap:** 3 rounds. 3rd `DO NOT AGREE` → no more rounds → human decision brief.
- Kill switch: `.pr-pause` in work-tree root → hook no-ops.
- One agent at a time: global `flock`.
- Bot commits carry trailers `Review-Bot: <name>` / `Revise-Bot: <name>` + `Round: N`. Hook skips pushes whose tip carries either bot trailer (the running orchestrator owns the loop).
- Verdict contract: reviewer log ends with `AGREE` or `DO NOT AGREE`; prints `RUN COMPLETE` only on full agreement (reuse existing review-prompt sentinel).
- Round state: file `$STATE_DIR/<sanitized-branch>.round` (deviation from spec's `refs/pr-state`: a plain file is simpler and equally durable — noted).
- Agent binaries injectable for tests: `CLAUDE_BIN` (default `claude`), `CODEX_BIN` (default `codex`); `DEPLOY_CMD` (default `./deploy.sh`); `PR_DRYRUN=1` stubs merge/deploy/push.

## File Structure

```
ops/pr-orchestration/
  lib/common.sh          # paths, logging, lock, state file, trailer + render helpers
  lib/verdict-parse.sh   # AGREE / DO NOT AGREE / sentinel extraction
  lib/pr-scope.sh        # changed-line count + <100 gate
  lib/notify.sh          # telegram ping shim (no-op if unconfigured)
  review-prompt.md       # adversarial prompt template (branch-parameterized)
  run-reviewer.sh        # codex exec / claude -p in worktree -> verdict log
  run-author-revise.sh   # author agent applies findings, commits (trailers), pushes
  pr-orchestrator.sh     # state machine
  post-receive           # hook source (installed into bare repo)
  install.sh             # install hook + create dirs/gitignore
  pr-scope.ignore        # globs excluded from line count (lockfiles, generated)
tests/pr-orchestration/
  fixtures/              # sample verdict logs, fake agent stubs
  test_verdict_parse.sh
  test_pr_scope.sh
  test_orchestrator_dryrun.sh
  test_post_receive_filter.sh
```

---

### Task 1: Scaffolding + `lib/common.sh`

**Files:**
- Create: `ops/pr-orchestration/lib/common.sh`
- Create: `ops/pr-orchestration/pr-scope.ignore`
- Test: `tests/pr-orchestration/test_common.sh`

**Interfaces:**
- Produces (sourced by every script): env `BARE_REPO`, `WORK_TREE`, `STATE_DIR`, `WT_ROOT`, `LOCK_FILE`; functions `pr_log <msg>`, `sanitize_branch <branch>` (echoes `pr-claude-topic`), `round_get <branch>` (echoes int, 0 if none), `round_set <branch> <n>`, `tip_trailer <worktree> <key>` (echoes trailer value of HEAD), `render_prompt <template> <branch> <author> <reviewer> <round>` (echoes template with `{{BRANCH}}/{{AUTHOR}}/{{REVIEWER}}/{{ROUND}}` substituted).

- [ ] **Step 1: Write the failing test**

```bash
#!/usr/bin/env bash
# tests/pr-orchestration/test_common.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
export STATE_DIR="$(mktemp -d)"
source ops/pr-orchestration/lib/common.sh

[ "$(sanitize_branch pr/claude/foo-bar)" = "pr-claude-foo-bar" ] || { echo "sanitize FAIL"; exit 1; }
[ "$(round_get pr/claude/foo)" = "0" ] || { echo "round default FAIL"; exit 1; }
round_set pr/claude/foo 2
[ "$(round_get pr/claude/foo)" = "2" ] || { echo "round set/get FAIL"; exit 1; }
out="$(render_prompt ops/pr-orchestration/review-prompt.md pr/claude/foo claude codex 1)"
echo "$out" | grep -q "pr/claude/foo" || { echo "render BRANCH FAIL"; exit 1; }
echo "$out" | grep -q "codex" || { echo "render REVIEWER FAIL"; exit 1; }
echo "test_common PASS"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/pr-orchestration/test_common.sh`
Expected: FAIL — `common.sh: No such file or directory`.

- [ ] **Step 3: Write `pr-scope.ignore` and `lib/common.sh`**

`ops/pr-orchestration/pr-scope.ignore`:
```
*.lock
poetry.lock
package-lock.json
shared/src/unilever_shared/_version.py
```

`ops/pr-orchestration/lib/common.sh`:
```bash
#!/usr/bin/env bash
# Shared paths + helpers for PR orchestration. Source me; do not execute.
set -euo pipefail

BARE_REPO="${BARE_REPO:-/mnt/nas-soul/nfs/stepa.local/repos/unilever.git}"
WORK_TREE="${WORK_TREE:-/mnt/nas-soul/nfs/stepa.local/work/unilever}"
STATE_DIR="${STATE_DIR:-$HOME/.local/state/pr-orchestration}"
WT_ROOT="${WT_ROOT:-$WORK_TREE/work/.pr-wt}"
LOCK_FILE="${LOCK_FILE:-$STATE_DIR/orchestrator.lock}"
mkdir -p "$STATE_DIR" "$WT_ROOT"

pr_log() { echo "[$(date -u +%H:%M:%S)] $*" >&2; }

sanitize_branch() { echo "${1//\//-}"; }

round_get() {
    local f="$STATE_DIR/$(sanitize_branch "$1").round"
    [ -f "$f" ] && cat "$f" || echo 0
}
round_set() { echo "$2" > "$STATE_DIR/$(sanitize_branch "$1").round"; }

# Trailer value of HEAD in a given worktree ("" if absent).
tip_trailer() {
    git -C "$1" log -1 --format='%(trailers:key='"$2"',valueonly)' 2>/dev/null | head -1
}

render_prompt() {
    sed -e "s|{{BRANCH}}|$2|g" -e "s|{{AUTHOR}}|$3|g" \
        -e "s|{{REVIEWER}}|$4|g" -e "s|{{ROUND}}|$5|g" "$1"
}
```

Note: `render_prompt` reads `review-prompt.md` (created in Task 5). For this test a minimal stub is fine — create `ops/pr-orchestration/review-prompt.md` now containing one line `PR {{BRANCH}} author {{AUTHOR}} reviewer {{REVIEWER}} round {{ROUND}}`; Task 5 replaces it with the full prompt.

- [ ] **Step 4: Run test to verify it passes**

Run: `bash tests/pr-orchestration/test_common.sh`
Expected: PASS — `test_common PASS`.

- [ ] **Step 5: Commit**

```bash
git add ops/pr-orchestration/lib/common.sh ops/pr-orchestration/pr-scope.ignore \
        ops/pr-orchestration/review-prompt.md tests/pr-orchestration/test_common.sh
git commit -m "feat(pr-orch): scaffolding + common lib"
```

---

### Task 2: `lib/verdict-parse.sh`

**Files:**
- Create: `ops/pr-orchestration/lib/verdict-parse.sh`
- Create: `tests/pr-orchestration/fixtures/verdict_agree.log`, `verdict_disagree.log`, `verdict_malformed.log`
- Test: `tests/pr-orchestration/test_verdict_parse.sh`

**Interfaces:**
- Produces: `parse_verdict <logfile>` — echoes `AGREE` | `DISAGREE` | `MALFORMED`; exit 0 for AGREE, 1 for DISAGREE, 2 for MALFORMED. AGREE requires both a final `AGREE` (not `DO NOT AGREE`) and the `RUN COMPLETE` sentinel.

- [ ] **Step 1: Write the failing test + fixtures**

`tests/pr-orchestration/fixtures/verdict_agree.log`:
```
F1 typed schema: AGREE — no change required.
...
RUN COMPLETE
```
`tests/pr-orchestration/fixtures/verdict_disagree.log`:
```
F2 mercata policy: DO NOT AGREE — missing legacy filename fallback.
```
`tests/pr-orchestration/fixtures/verdict_malformed.log`:
```
the agent crashed halfway and printed nothing useful
```

`tests/pr-orchestration/test_verdict_parse.sh`:
```bash
#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/../.."
source ops/pr-orchestration/lib/verdict-parse.sh
fx=tests/pr-orchestration/fixtures

r=$(parse_verdict "$fx/verdict_agree.log"); [ "$r" = AGREE ] || { echo "agree FAIL ($r)"; exit 1; }
r=$(parse_verdict "$fx/verdict_disagree.log"); [ "$r" = DISAGREE ] || { echo "disagree FAIL ($r)"; exit 1; }
r=$(parse_verdict "$fx/verdict_malformed.log"); [ "$r" = MALFORMED ] || { echo "malformed FAIL ($r)"; exit 1; }
echo "test_verdict_parse PASS"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/pr-orchestration/test_verdict_parse.sh`
Expected: FAIL — `verdict-parse.sh: No such file or directory`.

- [ ] **Step 3: Write `lib/verdict-parse.sh`**

```bash
#!/usr/bin/env bash
# parse_verdict <logfile> -> echo AGREE|DISAGREE|MALFORMED, exit 0|1|2
parse_verdict() {
    local log="$1"
    [ -s "$log" ] || { echo MALFORMED; return 2; }
    if grep -qi "DO NOT AGREE" "$log"; then echo DISAGREE; return 1; fi
    if grep -q "RUN COMPLETE" "$log" && grep -qw "AGREE" "$log"; then
        echo AGREE; return 0
    fi
    echo MALFORMED; return 2
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash tests/pr-orchestration/test_verdict_parse.sh`
Expected: PASS — `test_verdict_parse PASS`.

- [ ] **Step 5: Commit**

```bash
git add ops/pr-orchestration/lib/verdict-parse.sh tests/pr-orchestration/test_verdict_parse.sh tests/pr-orchestration/fixtures/verdict_*.log
git commit -m "feat(pr-orch): verdict parser"
```

---

### Task 3: `lib/pr-scope.sh`

**Files:**
- Create: `ops/pr-orchestration/lib/pr-scope.sh`
- Test: `tests/pr-orchestration/test_pr_scope.sh`

**Interfaces:**
- Consumes: `pr-scope.ignore` (Task 1).
- Produces: `scope_lines <repo> <base> <branch>` — echoes summed `added+deleted` across `git diff --numstat <base>...<branch>`, excluding paths matching any glob in `pr-scope.ignore`. `scope_ok <repo> <base> <branch>` — exit 0 if `< 100`, exit 1 otherwise.

- [ ] **Step 1: Write the failing test**

```bash
#!/usr/bin/env bash
# tests/pr-orchestration/test_pr_scope.sh
set -uo pipefail
cd "$(dirname "$0")/../.."
SRC="$(pwd)/ops/pr-orchestration"
tmp="$(mktemp -d)"; cd "$tmp"
git init -q; git config user.email t@t; git config user.name t
cp "$SRC/pr-scope.ignore" .
printf 'base\n' > a.txt; git add .; git commit -qm base
git switch -qc pr/claude/x
# 50 changed lines -> under cap
for i in $(seq 1 50); do echo "line $i"; done > a.txt
printf 'ignored\n%s\n' "$(seq 1 500)" > poetry.lock   # must be excluded
git add .; git commit -qm change
source "$SRC/lib/pr-scope.sh"
n=$(scope_lines . main pr/claude/x)
[ "$n" -lt 100 ] && [ "$n" -ge 49 ] || { echo "count FAIL ($n)"; exit 1; }
scope_ok . main pr/claude/x || { echo "scope_ok FAIL"; exit 1; }
# now blow past 100
for i in $(seq 1 200); do echo "l $i"; done > a.txt; git commit -qam big
scope_ok . main pr/claude/x && { echo "scope_ok should FAIL"; exit 1; }
echo "test_pr_scope PASS"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/pr-orchestration/test_pr_scope.sh`
Expected: FAIL — `pr-scope.sh: No such file or directory`.

- [ ] **Step 3: Write `lib/pr-scope.sh`**

```bash
#!/usr/bin/env bash
# Changed-line scope gate. Source me.
# scope_lines <repo> <base> <branch>; scope_ok <repo> <base> <branch>
_scope_ignore_file() {
    # ignore file sits next to this lib's parent (ops/pr-orchestration/pr-scope.ignore)
    local here; here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
    echo "$here/pr-scope.ignore"
}
scope_lines() {
    local repo="$1" base="$2" branch="$3" ign total=0
    ign="$(_scope_ignore_file)"
    while read -r add del path; do
        [ "$add" = "-" ] && continue          # binary file: skip
        local skip=0 g
        if [ -f "$ign" ]; then
            while read -r g; do [ -z "$g" ] && continue
                case "$path" in $g) skip=1; break;; esac
                case "$path" in */$g) skip=1; break;; esac
            done < "$ign"
        fi
        [ "$skip" = 1 ] && continue
        total=$(( total + add + del ))
    done < <(git -C "$repo" diff --numstat "$base...$branch")
    echo "$total"
}
scope_ok() { [ "$(scope_lines "$1" "$2" "$3")" -lt 100 ]; }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash tests/pr-orchestration/test_pr_scope.sh`
Expected: PASS — `test_pr_scope PASS`.

- [ ] **Step 5: Commit**

```bash
git add ops/pr-orchestration/lib/pr-scope.sh tests/pr-orchestration/test_pr_scope.sh
git commit -m "feat(pr-orch): line-count scope gate"
```

---

### Task 4: `lib/notify.sh` (telegram shim)

**Files:**
- Create: `ops/pr-orchestration/lib/notify.sh`
- Test: `tests/pr-orchestration/test_notify.sh`

**Interfaces:**
- Produces: `notify <emoji> <message>` — appends a line to `$STATE_DIR/notify.log` and, if `PR_NOTIFY_CMD` is set, pipes `"<emoji> <message>"` to it. Never fails the caller (returns 0 even if the command errors). Real telegram wiring is `PR_NOTIFY_CMD` (set at install to a telegram-send one-liner); unset = log-only.

- [ ] **Step 1: Write the failing test**

```bash
#!/usr/bin/env bash
# tests/pr-orchestration/test_notify.sh
set -uo pipefail
cd "$(dirname "$0")/../.."
export STATE_DIR="$(mktemp -d)"
source ops/pr-orchestration/lib/common.sh
source ops/pr-orchestration/lib/notify.sh
export PR_NOTIFY_CMD="cat >> $STATE_DIR/sent.txt"
notify "✅" "merged pr/claude/x" || { echo "notify returned nonzero"; exit 1; }
grep -q "merged pr/claude/x" "$STATE_DIR/notify.log" || { echo "log FAIL"; exit 1; }
grep -q "merged pr/claude/x" "$STATE_DIR/sent.txt" || { echo "send FAIL"; exit 1; }
PR_NOTIFY_CMD="false" notify "x" "y" || { echo "must not fail caller"; exit 1; }
echo "test_notify PASS"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/pr-orchestration/test_notify.sh`
Expected: FAIL — `notify.sh: No such file or directory`.

- [ ] **Step 3: Write `lib/notify.sh`**

```bash
#!/usr/bin/env bash
# notify <emoji> <message> — log + optional external send. Never fails caller.
notify() {
    local line="$1 $2"
    echo "[$(date -u +%FT%TZ)] $line" >> "$STATE_DIR/notify.log" 2>/dev/null || true
    if [ -n "${PR_NOTIFY_CMD:-}" ]; then
        printf '%s\n' "$line" | bash -c "$PR_NOTIFY_CMD" >/dev/null 2>&1 || true
    fi
    return 0
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash tests/pr-orchestration/test_notify.sh`
Expected: PASS — `test_notify PASS`.

- [ ] **Step 5: Commit**

```bash
git add ops/pr-orchestration/lib/notify.sh tests/pr-orchestration/test_notify.sh
git commit -m "feat(pr-orch): notify shim"
```

---

### Task 5: `review-prompt.md` (adversarial template)

**Files:**
- Modify: `ops/pr-orchestration/review-prompt.md` (replace the Task-1 stub)
- Test: `tests/pr-orchestration/test_prompt_render.sh`

**Interfaces:**
- Consumes: `render_prompt` (Task 1).
- Produces: a prompt that, after render, contains the branch, the reviewer name, the `≤3 logical changes` rule, the `<100 lines` note, and the exact verdict contract (`AGREE`/`DO NOT AGREE` + `RUN COMPLETE`). No `{{...}}` placeholders remain after render.

- [ ] **Step 1: Write the failing test**

```bash
#!/usr/bin/env bash
# tests/pr-orchestration/test_prompt_render.sh
set -uo pipefail
cd "$(dirname "$0")/../.."
export STATE_DIR="$(mktemp -d)"
source ops/pr-orchestration/lib/common.sh
out="$(render_prompt ops/pr-orchestration/review-prompt.md pr/codex/y codex claude 2)"
echo "$out" | grep -q "pr/codex/y" || { echo "branch FAIL"; exit 1; }
echo "$out" | grep -qi "3 logical change" || { echo "logical-change rule FAIL"; exit 1; }
echo "$out" | grep -q "RUN COMPLETE" || { echo "sentinel FAIL"; exit 1; }
echo "$out" | grep -q "{{" && { echo "unrendered placeholder FAIL"; exit 1; }
echo "test_prompt_render PASS"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/pr-orchestration/test_prompt_render.sh`
Expected: FAIL — Task-1 stub lacks `3 logical change` / `RUN COMPLETE`.

- [ ] **Step 3: Write the full `review-prompt.md`**

```markdown
# Adversarial PR Review — {{REVIEWER}} reviewing {{BRANCH}}

You are an adversarial senior engineer. You are **{{REVIEWER}}**, auditing a PR
authored by **{{AUTHOR}}**. This is review round {{ROUND}} (max 3).

You are in a checked-out worktree of branch `{{BRANCH}}`. Review the diff against
`main`:

```bash
git diff main...HEAD
```

Required checks:
- Correctness and behavior preservation; missing call-site migrations.
- Weak or false-positive tests; error-policy regressions.
- Data/workbook compatibility (SAP material normalization, EAN-as-string, pricing
  formulas — see CLAUDE.md invariants).
- **Scope: the PR must contain at most 3 logical changes.** More than 3 → `DO NOT
  AGREE` with reason "split into smaller PRs". (The line-count cap of <100 lines is
  already enforced upstream; you judge logical-change count.)
- Unnecessary scope or abstraction.

For each finding give exact file/line/symbol, severity, and the required change.

Conclude with one of:
- `DO NOT AGREE` — list the exact required revisions. Do NOT print the sentinel.
- `AGREE` — every change is correct and within scope; no revision required.

Print this exact line on its own, only when you fully AGREE and require no change:

RUN COMPLETE
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash tests/pr-orchestration/test_prompt_render.sh`
Expected: PASS — `test_prompt_render PASS`.

- [ ] **Step 5: Commit**

```bash
git add ops/pr-orchestration/review-prompt.md tests/pr-orchestration/test_prompt_render.sh
git commit -m "feat(pr-orch): adversarial review prompt"
```

---

### Task 6: `run-reviewer.sh`

**Files:**
- Create: `ops/pr-orchestration/run-reviewer.sh`
- Create: `tests/pr-orchestration/fixtures/fake-agent.sh`
- Test: `tests/pr-orchestration/test_run_reviewer.sh`

**Interfaces:**
- Consumes: `common.sh`, `render_prompt`, agent binaries via `CLAUDE_BIN`/`CODEX_BIN`.
- Produces: `run-reviewer.sh <reviewer> <worktree> <branch> <author> <round>` — renders the prompt, runs the reviewer CLI in `<worktree>`, tees output to `$STATE_DIR/<sanitized>-rN-review.log`, echoes that log path on stdout. Reviewer runs read-only (no commit/push here).

- [ ] **Step 1: Write the failing test + fake agent**

`tests/pr-orchestration/fixtures/fake-agent.sh`:
```bash
#!/usr/bin/env bash
# Fake agent: emits whatever $FAKE_VERDICT_FILE contains, ignores the prompt.
cat "${FAKE_VERDICT_FILE:?}"
```

`tests/pr-orchestration/test_run_reviewer.sh`:
```bash
#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/../.."
export STATE_DIR="$(mktemp -d)"
chmod +x tests/pr-orchestration/fixtures/fake-agent.sh
export CODEX_BIN="$(pwd)/tests/pr-orchestration/fixtures/fake-agent.sh"
export FAKE_VERDICT_FILE="$(pwd)/tests/pr-orchestration/fixtures/verdict_agree.log"
wt="$(mktemp -d)"   # stand-in worktree
logpath="$(bash ops/pr-orchestration/run-reviewer.sh codex "$wt" pr/claude/x claude 1)"
[ -f "$logpath" ] || { echo "no log written"; exit 1; }
grep -q "RUN COMPLETE" "$logpath" || { echo "verdict not captured"; exit 1; }
echo "test_run_reviewer PASS"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/pr-orchestration/test_run_reviewer.sh`
Expected: FAIL — `run-reviewer.sh: No such file or directory`.

- [ ] **Step 3: Write `run-reviewer.sh`**

```bash
#!/usr/bin/env bash
# run-reviewer.sh <reviewer> <worktree> <branch> <author> <round> -> echo logpath
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/lib/common.sh"
reviewer="$1" wt="$2" branch="$3" author="$4" round="$5"
CLAUDE_BIN="${CLAUDE_BIN:-claude}"; CODEX_BIN="${CODEX_BIN:-codex}"
prompt="$(render_prompt "$HERE/review-prompt.md" "$branch" "$author" "$reviewer" "$round")"
log="$STATE_DIR/$(sanitize_branch "$branch")-r${round}-review.log"
pr_log "reviewer=$reviewer branch=$branch round=$round wt=$wt"
case "$reviewer" in
    claude) ( cd "$wt" && "$CLAUDE_BIN" -p "$prompt" ) >"$log" 2>&1 || true ;;
    codex)  ( cd "$wt" && "$CODEX_BIN" exec "$prompt" ) >"$log" 2>&1 || true ;;
    *) echo "unknown reviewer: $reviewer" >&2; exit 2 ;;
esac
echo "$log"
```

Note: the fake agent is invoked as `fake-agent.sh exec <prompt>` for codex — it ignores args, so the test passes. Real `codex exec` / `claude -p` honor the prompt.

- [ ] **Step 4: Run test to verify it passes**

Run: `bash tests/pr-orchestration/test_run_reviewer.sh`
Expected: PASS — `test_run_reviewer PASS`.

- [ ] **Step 5: Commit**

```bash
git add ops/pr-orchestration/run-reviewer.sh tests/pr-orchestration/fixtures/fake-agent.sh tests/pr-orchestration/test_run_reviewer.sh
git commit -m "feat(pr-orch): headless reviewer wrapper"
```

---

### Task 7: `run-author-revise.sh`

**Files:**
- Create: `ops/pr-orchestration/run-author-revise.sh`
- Test: `tests/pr-orchestration/test_run_author_revise.sh`

**Interfaces:**
- Consumes: `common.sh`, agent binaries, a verdict log path.
- Produces: `run-author-revise.sh <author> <worktree> <branch> <round> <verdict-log>` — runs the author CLI in `<worktree>` with a revise prompt embedding the verdict, then commits all changes with trailers `Revise-Bot: <author>` + `Round: <round+1>` and pushes the branch to `BARE_REPO`. In `PR_DRYRUN=1` mode it skips the push. Echoes the new round number.

- [ ] **Step 1: Write the failing test**

```bash
#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/../.."
export STATE_DIR="$(mktemp -d)" PR_DRYRUN=1
chmod +x tests/pr-orchestration/fixtures/fake-agent.sh
# fake author edits a file instead of emitting a verdict:
cat > "$STATE_DIR/fake-author.sh" <<'EOF'
#!/usr/bin/env bash
echo "revised per review" >> revised.txt
EOF
chmod +x "$STATE_DIR/fake-author.sh"
export CLAUDE_BIN="$STATE_DIR/fake-author.sh"
wt="$(mktemp -d)"; cd "$wt"; git init -q; git config user.email t@t; git config user.name t
echo base > f.txt; git add .; git commit -qm base; git switch -qc pr/claude/x; cd - >/dev/null
echo "F2: DO NOT AGREE - fix fallback" > "$STATE_DIR/v.log"
newround="$(bash ops/pr-orchestration/run-author-revise.sh claude "$wt" pr/claude/x 1 "$STATE_DIR/v.log")"
[ "$newround" = 2 ] || { echo "round FAIL ($newround)"; exit 1; }
git -C "$wt" log -1 --format='%(trailers:key=Revise-Bot,valueonly)' | grep -q claude || { echo "trailer FAIL"; exit 1; }
test -f "$wt/revised.txt" || { echo "edit not committed"; exit 1; }
echo "test_run_author_revise PASS"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/pr-orchestration/test_run_author_revise.sh`
Expected: FAIL — script missing.

- [ ] **Step 3: Write `run-author-revise.sh`**

```bash
#!/usr/bin/env bash
# run-author-revise.sh <author> <worktree> <branch> <round> <verdict-log> -> echo new round
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/lib/common.sh"
author="$1" wt="$2" branch="$3" round="$4" vlog="$5"
CLAUDE_BIN="${CLAUDE_BIN:-claude}"; CODEX_BIN="${CODEX_BIN:-codex}"
newround=$(( round + 1 ))
verdict="$(cat "$vlog")"
prompt="You are ${author}. A reviewer rejected your PR ${branch} (round ${round}).
Apply the required revisions below, changing only what is needed. Do not exceed
3 logical changes or 100 changed lines total.

--- REVIEW ---
${verdict}
--- END REVIEW ---"
pr_log "revise author=$author branch=$branch -> round $newround"
case "$author" in
    claude) ( cd "$wt" && "$CLAUDE_BIN" -p "$prompt" ) >>"$STATE_DIR/$(sanitize_branch "$branch")-r${newround}-revise.log" 2>&1 || true ;;
    codex)  ( cd "$wt" && "$CODEX_BIN" exec "$prompt" ) >>"$STATE_DIR/$(sanitize_branch "$branch")-r${newround}-revise.log" 2>&1 || true ;;
    *) echo "unknown author: $author" >&2; exit 2 ;;
esac
git -C "$wt" add -A
git -C "$wt" commit -q -m "revise: address round ${round} review

Revise-Bot: ${author}
Round: ${newround}" || pr_log "nothing to commit"
if [ "${PR_DRYRUN:-0}" != 1 ]; then
    git -C "$wt" push "$BARE_REPO" "HEAD:$branch"
fi
round_set "$branch" "$newround"
echo "$newround"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash tests/pr-orchestration/test_run_author_revise.sh`
Expected: PASS — `test_run_author_revise PASS`.

- [ ] **Step 5: Commit**

```bash
git add ops/pr-orchestration/run-author-revise.sh tests/pr-orchestration/test_run_author_revise.sh
git commit -m "feat(pr-orch): author revise wrapper"
```

---

### Task 8: `pr-orchestrator.sh` (state machine)

**Files:**
- Create: `ops/pr-orchestration/pr-orchestrator.sh`
- Test: `tests/pr-orchestration/test_orchestrator_dryrun.sh`

**Interfaces:**
- Consumes: all libs + `run-reviewer.sh`, `run-author-revise.sh`, `parse_verdict`, `notify`.
- Produces: `pr-orchestrator.sh <branch> <author> <reviewer>` — drives the loop. In `PR_DRYRUN=1`: worktree add/merge/`deploy.sh`/push are stubbed via `MERGE_CMD`/`DEPLOY_CMD` env hooks so the state machine is testable. Writes outcome to `$STATE_DIR/<sanitized>.outcome` (`MERGED` | `ESCALATED_STALEMATE` | `ESCALATED_DEPLOY_FAIL` | `ESCALATED_MALFORMED`). Builds `DECISION.md` on stalemate.

- [ ] **Step 1: Write the failing test**

```bash
#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
run_case() {  # <verdict-file> -> echo outcome
    export STATE_DIR="$(mktemp -d)" PR_DRYRUN=1
    export MERGE_CMD="true" DEPLOY_CMD="true"           # merge ok, tests green
    [ -n "${DEPLOY_FAIL:-}" ] && export DEPLOY_CMD="false"
    export REVIEWER_STUB="$1"
    # stub run-reviewer/run-author-revise via PATH shim dir
    shim="$(mktemp -d)"
    cat > "$shim/run-reviewer.sh" <<EOF
#!/usr/bin/env bash
cp "$1" "\$STATE_DIR/captured.log"; echo "\$STATE_DIR/captured.log"
EOF
    cat > "$shim/run-author-revise.sh" <<'EOF'
#!/usr/bin/env bash
r="$4"; echo $(( r + 1 ))
EOF
    chmod +x "$shim"/*.sh
    PR_ORCH_BINDIR="$shim" bash "$ROOT/ops/pr-orchestration/pr-orchestrator.sh" pr/claude/x claude codex >/dev/null 2>&1 || true
    cat "$STATE_DIR/$(echo pr-claude-x).outcome"
}
o=$(run_case "$ROOT/tests/pr-orchestration/fixtures/verdict_agree.log");    [ "$o" = MERGED ] || { echo "AGREE->MERGED FAIL ($o)"; exit 1; }
o=$(DEPLOY_FAIL=1 run_case "$ROOT/tests/pr-orchestration/fixtures/verdict_agree.log"); [ "$o" = ESCALATED_DEPLOY_FAIL ] || { echo "deploy-fail FAIL ($o)"; exit 1; }
o=$(run_case "$ROOT/tests/pr-orchestration/fixtures/verdict_disagree.log"); [ "$o" = ESCALATED_STALEMATE ] || { echo "3xDISAGREE->STALEMATE FAIL ($o)"; exit 1; }
echo "test_orchestrator_dryrun PASS"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/pr-orchestration/test_orchestrator_dryrun.sh`
Expected: FAIL — orchestrator missing.

- [ ] **Step 3: Write `pr-orchestrator.sh`**

```bash
#!/usr/bin/env bash
# pr-orchestrator.sh <branch> <author> <reviewer>
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
BINDIR="${PR_ORCH_BINDIR:-$HERE}"   # tests override with stubs
source "$HERE/lib/common.sh"
source "$HERE/lib/verdict-parse.sh"
source "$HERE/lib/notify.sh"
branch="$1" author="$2" reviewer="$3"
san="$(sanitize_branch "$branch")"
outcome_file="$STATE_DIR/$san.outcome"
MERGE_CMD="${MERGE_CMD:-}"; DEPLOY_CMD="${DEPLOY_CMD:-./deploy.sh}"

finish() { echo "$1" > "$outcome_file"; notify "$2" "$branch: $1"; exit 0; }

# Serialize: one agent at a time.
exec 9>"$LOCK_FILE"; flock 9

# Worktree of the PR branch (real run); dry-run uses a temp dir.
if [ "${PR_DRYRUN:-0}" = 1 ]; then wt="$(mktemp -d)"; else
    wt="$WT_ROOT/$san"; rm -rf "$wt"
    git -C "$BARE_REPO" worktree add --force "$wt" "$branch"
fi

round_set "$branch" 1
notify "🔎" "review started ($reviewer auditing $branch)"

while :; do
    round="$(round_get "$branch")"
    log="$("$BINDIR/run-reviewer.sh" "$reviewer" "$wt" "$branch" "$author" "$round")"
    set +e; verdict="$(parse_verdict "$log")"; set -e

    if [ "$verdict" = AGREE ]; then
        notify "✅" "AGREE round $round — running deploy.sh gate"
        if [ "${PR_DRYRUN:-0}" = 1 ]; then
            ${MERGE_CMD:-true} && ${DEPLOY_CMD:-true} \
                && finish MERGED "🚀" || finish ESCALATED_DEPLOY_FAIL "⚠️"
        else
            mwt="$WT_ROOT/main"; rm -rf "$mwt"
            git -C "$BARE_REPO" worktree add --force "$mwt" main
            if git -C "$mwt" merge --ff-only "$branch" \
               && ( cd "$mwt" && eval "$DEPLOY_CMD" ); then
                finish MERGED "🚀"
            else
                git -C "$mwt" reset --hard ORIG_HEAD 2>/dev/null || true
                finish ESCALATED_DEPLOY_FAIL "⚠️"
            fi
        fi
    fi

    if [ "$verdict" = MALFORMED ]; then
        notify "⚠️" "reviewer output malformed round $round"
        finish ESCALATED_MALFORMED "⚠️"
    fi

    # DISAGREE
    if [ "$round" -ge 3 ]; then
        # Build pros/cons decision brief from the standing objection + last revise log.
        brief="$STATE_DIR/$san-DECISION.md"
        {
            echo "# DECISION NEEDED — $branch (stalemate after 3 rounds)"
            echo; echo "## Reviewer ($reviewer) objection — pros/cons of enforcing"
            echo '```'; tail -40 "$log"; echo '```'
            echo "## Author ($author) last rebuttal — pros/cons of merging as-is"
            echo '```'; tail -40 "$STATE_DIR/$san-r${round}-revise.log" 2>/dev/null; echo '```'
            echo "## Diff summary"; echo '```'
            git -C "$wt" diff --stat main...HEAD 2>/dev/null
            echo '```'
            echo "Decide: merge as-is / revise per reviewer / abandon."
        } > "$brief"
        notify "🧑‍⚖️" "stalemate — human decision needed: $brief"
        finish ESCALATED_STALEMATE "🧑‍⚖️"
    fi

    notify "✏️" "DO NOT AGREE round $round — author revising"
    "$BINDIR/run-author-revise.sh" "$author" "$wt" "$branch" "$round" "$log" >/dev/null
    round_set "$branch" "$(( round + 1 ))"
done
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash tests/pr-orchestration/test_orchestrator_dryrun.sh`
Expected: PASS — `test_orchestrator_dryrun PASS`.

- [ ] **Step 5: Commit**

```bash
git add ops/pr-orchestration/pr-orchestrator.sh tests/pr-orchestration/test_orchestrator_dryrun.sh
git commit -m "feat(pr-orch): orchestrator state machine"
```

---

### Task 9: `post-receive` hook

**Files:**
- Create: `ops/pr-orchestration/post-receive`
- Test: `tests/pr-orchestration/test_post_receive_filter.sh`

**Interfaces:**
- Consumes: `common.sh`, `pr-scope.sh`, `notify`, `pr-orchestrator.sh`.
- Produces: a `post-receive` that, per pushed ref line on stdin: ignores non-`pr/*` refs; no-ops on `.pr-pause`; no-ops when the tip carries a `Review-Bot`/`Revise-Bot` trailer; rejects (notify, no launch) when `scope_ok` fails; else launches the orchestrator detached. After processing all refs it runs the preserved mirror push exactly once. Routing dir overridable via `PR_ORCH_HOME` (test injects a fake orchestrator + sets `MIRROR_CMD=true`).

- [ ] **Step 1: Write the failing test**

```bash
#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
tmp="$(mktemp -d)"; cd "$tmp"
git init -q --bare bare.git
wt="$tmp/wt"; git clone -q bare.git wt; cd wt; git config user.email t@t; git config user.name t
echo base > f.txt; git add .; git commit -qm base; git push -q origin HEAD:main
export STATE_DIR="$tmp/state"; mkdir -p "$STATE_DIR"
export BARE_REPO="$tmp/bare.git" WORK_TREE="$wt"
export PR_ORCH_HOME="$ROOT/ops/pr-orchestration"
export MIRROR_CMD="true"   # don't actually push to GitHub in test
# fake orchestrator records that it was launched
export PR_ORCH_LAUNCH="echo launched:\$1 >> $STATE_DIR/launched.txt"
hook="$ROOT/ops/pr-orchestration/post-receive"

# 1. push to main -> NOT launched
echo "0 1 refs/heads/main" | bash "$hook"
[ -f "$STATE_DIR/launched.txt" ] && { echo "main should not launch"; exit 1; }
# 2. push pr/claude/x small -> launched
git switch -qc pr/claude/x; echo "a" >> f.txt; git commit -qam x
new=$(git rev-parse HEAD)
echo "0 $new refs/heads/pr/claude/x" | bash "$hook"
grep -q "launched:pr/claude/x" "$STATE_DIR/launched.txt" || { echo "pr should launch"; exit 1; }
# 3. .pr-pause -> no launch
: > "$wt/.pr-pause"; rm -f "$STATE_DIR/launched.txt"
echo "0 $new refs/heads/pr/claude/x" | bash "$hook"
[ -f "$STATE_DIR/launched.txt" ] && { echo "pause should block"; exit 1; }
rm -f "$wt/.pr-pause"
echo "test_post_receive_filter PASS"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/pr-orchestration/test_post_receive_filter.sh`
Expected: FAIL — hook missing.

- [ ] **Step 3: Write `post-receive`**

```bash
#!/usr/bin/env bash
# Installed into <bare>/hooks/post-receive. Chains PR trigger + mirror push.
set -uo pipefail
HOME_DIR="${PR_ORCH_HOME:-/mnt/nas-soul/nfs/stepa.local/work/unilever/ops/pr-orchestration}"
source "$HOME_DIR/lib/common.sh"
source "$HOME_DIR/lib/pr-scope.sh"
source "$HOME_DIR/lib/notify.sh"
MIRROR_CMD="${MIRROR_CMD:-git push --mirror https://github.com/bbK1ngSrb/unilever.git}"

refs="$(cat)"   # consume stdin once; mirror push below needs no stdin
while read -r _old new ref; do
    [ -z "${ref:-}" ] && continue
    case "$ref" in refs/heads/pr/*) : ;; *) continue ;; esac
    branch="${ref#refs/heads/}"
    author="$(echo "$branch" | cut -d/ -f2)"
    case "$author" in claude) reviewer=codex ;; codex) reviewer=claude ;; *) continue ;; esac

    [ -f "$WORK_TREE/.pr-pause" ] && { pr_log "paused"; continue; }

    # Loop guard: skip pushes whose tip is a bot commit (orchestrator owns the loop).
    if git -C "$BARE_REPO" log -1 --format='%(trailers:key=Revise-Bot,valueonly)%(trailers:key=Review-Bot,valueonly)' "$new" 2>/dev/null | grep -q .; then
        pr_log "bot commit — no re-trigger"; continue
    fi

    # Scope hard gate (<100 lines vs main).
    if ! scope_ok "$BARE_REPO" main "$branch"; then
        notify "🚫" "$branch exceeds 100 changed lines — split the PR"; continue
    fi

    # Launch detached (test overrides via PR_ORCH_LAUNCH).
    if [ -n "${PR_ORCH_LAUNCH:-}" ]; then
        bash -c "$PR_ORCH_LAUNCH" _ "$branch"
    else
        setsid bash -c 'exec "$0" "$@"' "$HOME_DIR/pr-orchestrator.sh" \
            "$branch" "$author" "$reviewer" </dev/null >>"$STATE_DIR/launch.out" 2>&1 &
    fi
    pr_log "launched orchestrator for $branch ($reviewer reviews)"
done <<< "$refs"

# Preserve the original mirror push (runs once, regardless of refs).
eval "$MIRROR_CMD" || pr_log "mirror push failed"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash tests/pr-orchestration/test_post_receive_filter.sh`
Expected: PASS — `test_post_receive_filter PASS`.

- [ ] **Step 5: Commit**

```bash
git add ops/pr-orchestration/post-receive tests/pr-orchestration/test_post_receive_filter.sh
git commit -m "feat(pr-orch): post-receive trigger (chains mirror push)"
```

---

### Task 10: `install.sh` + docs + full suite

**Files:**
- Create: `ops/pr-orchestration/install.sh`
- Create: `ops/pr-orchestration/README.md`
- Modify: `.gitignore` (add `work/.pr-wt/`)
- Test: `tests/pr-orchestration/test_install.sh`

**Interfaces:**
- Produces: `install.sh` — backs up the bare repo's current `post-receive` to `post-receive.orig` (once), installs `ops/pr-orchestration/post-receive` into `<bare>/hooks/post-receive` (executable), creates `$STATE_DIR`, and prints the `PR_NOTIFY_CMD` line to add for telegram. Idempotent.

- [ ] **Step 1: Write the failing test**

```bash
#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/../.."
ROOT="$(pwd)"; tmp="$(mktemp -d)"
git init -q --bare "$tmp/bare.git"
printf '#!/bin/bash\ngit push --mirror https://github.com/bbK1ngSrb/unilever.git\n' > "$tmp/bare.git/hooks/post-receive"
export BARE_REPO="$tmp/bare.git" STATE_DIR="$tmp/state"
bash ops/pr-orchestration/install.sh
test -x "$tmp/bare.git/hooks/post-receive" || { echo "hook not installed/exec"; exit 1; }
grep -q "PR_ORCH_HOME\|HOME_DIR" "$tmp/bare.git/hooks/post-receive" || { echo "wrong hook content"; exit 1; }
test -f "$tmp/bare.git/hooks/post-receive.orig" || { echo "original not backed up"; exit 1; }
grep -q "git push --mirror" "$tmp/bare.git/hooks/post-receive.orig" || { echo "backup wrong"; exit 1; }
bash ops/pr-orchestration/install.sh   # idempotent: backup not overwritten with the new hook
grep -q "git push --mirror" "$tmp/bare.git/hooks/post-receive.orig" || { echo "idempotency FAIL"; exit 1; }
echo "test_install PASS"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/pr-orchestration/test_install.sh`
Expected: FAIL — `install.sh` missing.

- [ ] **Step 3: Write `install.sh` + README + gitignore**

`ops/pr-orchestration/install.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/lib/common.sh"
hooks="$BARE_REPO/hooks"; dst="$hooks/post-receive"
mkdir -p "$hooks" "$STATE_DIR"
# Back up the existing hook once (never overwrite an existing backup).
if [ -f "$dst" ] && [ ! -f "$dst.orig" ] && ! grep -q "PR_ORCH_HOME" "$dst"; then
    cp "$dst" "$dst.orig"
    echo "backed up existing hook -> $dst.orig"
fi
install -m 0755 "$HERE/post-receive" "$dst"
echo "installed PR-trigger hook -> $dst"
echo "To enable telegram pings, export in the hook env:"
echo "  PR_NOTIFY_CMD='<your telegram-send one-liner reading the message on stdin>'"
```

`ops/pr-orchestration/README.md` (one paragraph + usage):
```markdown
# PR Cross-Audit Orchestration
Push `pr/<author>/<topic>` (author ∈ claude|codex) to the bare repo. The opposite
agent audits headlessly; AGREE + green `deploy.sh` auto-merges to main; 3 failed
rounds escalate a pros/cons brief. Install: `BARE_REPO=… ./install.sh`. Pause:
`touch .pr-pause` in the work tree. Logs + verdicts under `$STATE_DIR`
(`~/.local/state/pr-orchestration`). See the design spec and plan in
`docs/superpowers/`.
```

Append to `.gitignore`:
```
work/.pr-wt/
```

- [ ] **Step 4: Run the whole suite**

Run:
```bash
for t in tests/pr-orchestration/test_*.sh; do echo "== $t =="; bash "$t" || exit 1; done
```
Expected: every `test_* PASS`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add ops/pr-orchestration/install.sh ops/pr-orchestration/README.md .gitignore tests/pr-orchestration/test_install.sh
git commit -m "feat(pr-orch): installer + docs + gitignore worktree root"
```

---

## Manual validation (after the suite is green)

Not automatable in CI — run once by hand on `rdp`:

1. `BARE_REPO=/mnt/nas-soul/nfs/stepa.local/repos/unilever.git ops/pr-orchestration/install.sh`
2. Create a tiny real PR: `git switch -c pr/codex/smoke`, change <100 lines, push to origin.
3. Confirm: telegram "review started" ping, a worktree under `work/.pr-wt/`, a verdict log in `$STATE_DIR`, and either an auto-merge+deploy or an escalation.
4. Verify `git log origin/main` still mirrors to GitHub (original hook preserved).
5. `touch .pr-pause`; push again; confirm no orchestrator launch. Remove it.

## Self-Review

- **Spec coverage:** §2 naming→Task 9 routing; §3 scope cap→Task 3 (lines) + Task 5 prompt (logical); §4 trigger→Task 9; §5 state machine→Task 8; §6 safety rails (ff-only, deploy gate, kill switch, lock)→Tasks 8–9; §7 stalemate brief→Task 8; §8 components→Tasks 1–9; §9 invocation→Tasks 6–7; §10 testing→every task's test + Task 10 suite; install/preserve-mirror→Tasks 9–10. No gap.
- **Placeholders:** none — every script is complete code.
- **Type/name consistency:** `sanitize_branch`, `round_get/set`, `render_prompt`, `parse_verdict`, `scope_ok/scope_lines`, `notify`, trailer keys `Review-Bot`/`Revise-Bot`/`Round`, outcomes `MERGED|ESCALATED_*` used identically across tasks.
- **Deviation noted:** round state is a `$STATE_DIR/*.round` file, not `refs/pr-state` (spec §5) — simpler, equally durable.
