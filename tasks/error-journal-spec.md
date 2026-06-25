# Error Journal — Spec

**Date:** 2026-06-25
**Status:** Spec, pending build
**Scope:** New collaborator + write points in `engine.js`. No change to merge logic.

## Goal

Give `orch` a **persistent, append-only record of every failure** across cycles —
escalations, red-test gates, scope rejections, merge failures, and agent crashes —
so the human (and the self-improvement loop) can see recurring patterns instead of
re-discovering them one branch at a time.

## Why

Today every failure lands in a **per-branch, throwaway** location:

- `notify.escalate()` writes `.orch/reviews/<branch>/DECISION.md`.
- `notify.writeRound()` writes `.orch/reviews/<branch>/round-N.md`.
- Adapter crashes and thrown errors surface only on stderr, then vanish.

Nothing survives across branches. There is no "what keeps going wrong here?" view.
`WORKFLOW-ORCHESTRATION.md` already mandates a self-improvement loop on
`tasks/lessons.md`; the error journal is the **raw-data feed** for that loop.

## What gets journaled

One entry per terminal-failure event. The `escalate(...)` / failure points in
`engine.js`, plus uncaught adapter errors:

| Event           | Trigger in `engine.js`                              |
|-----------------|-----------------------------------------------------|
| `scope`         | changed lines exceed `scope.maxLines`               |
| `no-test-gate`  | AGREE but no test command detected                  |
| `tests-red`     | AGREE but `gate.run()` fails                         |
| `merge-failed`  | `git.mergeIntoMain()` returns `\!ok`                 |
| `stalemate`     | DISAGREE persists past `reviseCap`                   |
| `agent-error`   | adapter `author()`/`audit()` throws                 |

Successful merges are **not** journaled — this is an *error* journal, kept small and
signal-dense. (A full run log is out of scope; see below.)

## Storage

Two files under `.orch/`, both append-only, both git-ignorable:

- **`.orch/journal.jsonl`** — machine-readable, one JSON object per line. The source
  of truth; cheap to append, cheap to `grep`/`jq`, safe under the global lock.
- **`.orch/journal.md`** — human-readable mirror, newest entry appended last. Rendered
  from the same record at write time (no separate render step to drift).

Per-branch `DECISION.md` / `round-N.md` stay exactly as they are — the journal links
to them by path, it does not replace them.

## Record schema

```jsonc
{
  "ts": "2026-06-25T14:21:09Z",    // ISO-8601, UTC
  "branch": "pr/claude/fix-login", // branch under cycle
  "event": "tests-red",            // one of the events above
  "round": 2,                      // review round at failure
  "reason": "AGREE but tests are red — not merging",
  "detail": ".orch/reviews/pr_.../DECISION.md"  // path to fuller artifact, or null
}
```

`ts` is the only field the journal generates; everything else the engine already has
in hand at the failure point.

## Surface

A read command — no new write command (writes are automatic):

```
orch journal            # print the last N error entries (default 20), newest last
orch journal --all      # print the whole journal
orch journal --branch B # filter to one branch
```

Implementation: read `journal.jsonl`, format like `journal.md` rows. No DB, no index.

## Write path

A `journal.record(orchDir, entry)` helper lives in `notify.js` (same module that owns
`.orch/` writes). `engine.js` calls it from the existing `escalate()` helper and from
a `catch` around the author/audit calls — so every existing failure exit also journals,
in one place each. Writes are `appendFileSync` (atomic enough under the per-repo lock).

## Out of scope (YAGNI)

- Full success/run log or metrics — only failures are journaled.
- Rotation / pruning — append-only; revisit only if real files get large.
- Cross-repo aggregation, dashboards, or any network surface.
- Auto-editing `tasks/lessons.md` — the journal *feeds* that loop, a human still curates.

## Testing

- `notify.record()` — unit: appends one valid JSONL line + one `journal.md` row; second
  call appends, does not overwrite.
- `engine.js` dry-run — assert each failure branch (`scope`, `no-test-gate`, `tests-red`,
  `merge-failed`, `stalemate`, `agent-error`) emits exactly one journal entry with the
  right `event`.
- `orch journal` — unit: reads back written entries, `--branch` filters correctly.
