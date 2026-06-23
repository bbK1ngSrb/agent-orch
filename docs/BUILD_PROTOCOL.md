# agent-orch — Headless Build Protocol

You are a headless coding agent building the `agent-orch` CLI in this repo
(`~/agent-orch`, cwd). You run unattended under a supervisor that may kill and
RESUME you at any time. Therefore: **never rely on memory. Recover all state from
files in `docs/` on every (re)start.** Be idempotent — never redo finished work.

## Source of truth
- `docs/plan.md` — the implementation plan: 13 ordered tasks, each with TDD steps
  and complete code. Follow it EXACTLY, step by step, in order.
- `docs/design.md` — the design spec (context only).
- Do not invent scope. Do not skip steps. Run every test the plan lists.

## Signaling files (the handshake with the external auditor)
For task N, attempt M (M starts at 1):
- After you finish implementing task N (all its plan steps pass locally), you
  signal "ready for audit" by writing an EMPTY file `docs/task<N>-run<M>.md`.
- An external auditor then writes `docs/task<N>-audit<M>.md`. You wait for it.
- The audit file ends with a line `VERDICT: APPROVED` or `VERDICT: CHANGES`.
  - `APPROVED` → the task is done. Write `docs/task<N>-complete.md` (see below),
    then move to task N+1.
  - `CHANGES` → read the findings, fix them, then start attempt M+1: write
    `docs/task<N>-run<M+1>.md` and wait for `docs/task<N>-audit<M+1>.md`.
- `docs/task<N>-complete.md` is detailed Markdown documenting what task N did:
  files created/changed, what each does, the tests added and their results
  (paste the `node --test` summary), and any decisions or deviations.

## State recovery (run this logic at every start)
1. List `docs/`. For each task 1..13 determine status:
   - `docs/task<N>-complete.md` exists → task N is DONE. Skip it.
   - else if the highest `docs/task<N>-run<M>.md` has a matching
     `docs/task<N>-audit<M>.md` you have NOT yet acted on → act on that verdict.
   - else if a `run<M>` exists without its `audit<M>` → you are WAITING; poll.
   - else → task N is the current task to implement from scratch.
2. The current task = the lowest N that is not DONE. Resume there.

## The per-task loop
For the current task N:
1. Implement every step in `docs/plan.md` for task N (write the failing test,
   run it, implement, run until green, commit — exactly as the plan says).
   Use real git commits with the messages the plan specifies.
2. Run the FULL suite (`node --test`) and confirm green before signalling.
3. `git add -A && git commit` your work, then `git push` (origin/main).
4. Write the empty run file and push it:
   `touch docs/task<N>-run<M>.md && git add docs/task<N>-run<M>.md && git commit -m "chore: task<N> run<M> ready for audit" && git push`
5. WAIT for the audit (poll in short bursts — see below).
6. Read `docs/task<N>-audit<M>.md`:
   - `VERDICT: APPROVED` → write `docs/task<N>-complete.md`, commit + push, go to N+1.
   - `VERDICT: CHANGES` → apply every finding, then go to step 2 with M = M+1.

## How to wait for the audit (do NOT block in one long command)
The supervisor treats >15 min of no output as a stall. Poll in ~3-minute bursts
so output keeps flowing and restarts are harmless. Run this command, then react:

```bash
N=<task>; M=<attempt>
for i in $(seq 1 18); do
  if [ -f "docs/task${N}-audit${M}.md" ]; then echo "AUDIT_FOUND"; break; fi
  sleep 10
done
[ -f "docs/task${N}-audit${M}.md" ] || echo "STILL_WAITING"
```

- Prints `AUDIT_FOUND` → read the audit file and act.
- Prints `STILL_WAITING` → run the SAME command again (keep polling). Do a
  `git pull --rebase` once before each poll burst in case the auditor pushes the
  file to the remote instead of writing it locally.

## Completion
When `docs/task13-complete.md` exists (all 13 tasks audited + approved), print
this EXACT line by itself and nothing else — it is the only signal that you are
fully done:

```
RUN COMPLETE
```

Until then, NEVER print that line. Keep working or keep polling.

## Rules
- One task at a time, in order. Do not start task N+1 until task N has a
  `complete.md`.
- Commit frequently (the plan's commit steps are mandatory). Push after each
  commit so the auditor and the human can see progress.
- If a plan step's command fails, debug and fix it before moving on — do not
  fake a pass. If truly blocked, write `docs/task<N>-run<M>.md` anyway with a
  one-line note of the blocker appended, and wait for auditor guidance.
- Never print the sentinel except at the very end.
