---
description: Run agent-orch — author + cross-audit + test-gate + merge
argument-hint: task "describe change" | review <branch> | init | --dry
allowed-tools: Bash(orch:*)
---

Run the agent-orch CLI in the current repo:

```
orch $ARGUMENTS
```

Execute it with Bash, then report the outcome: branch, reviewer verdict
(AGREE/DISAGREE), test-gate result, and whether it merged. On nonzero exit,
surface the error verbatim. If `$ARGUMENTS` is empty, run `orch task` with no
args so its usage message prints.
