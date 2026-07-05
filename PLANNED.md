# Planned

## Windows native release

Cross-platform (Windows) support is on the radar but not landing soon.

Three independent attempts (2 by Claude, 1 by Codex) got as far as review
`AGREE` and still didn't merge — not because the code was wrong, but because
every attempt has to touch files orch refuses to auto-merge (`.github/workflows/**`,
`package.json`): CI needs a Windows job, and a real release needs a packaging
workflow. That's an orch guardrail working as intended, not a bug — but it means
this needs a human to actually land it.

Biggest gotcha found so far: **spawning `.cmd`/`.bat` shims on Windows**. Node's
`spawn()` refuses to exec them directly (`EINVAL`) — npm-global CLIs (`claude`,
`codex`) install as exactly that on Windows. Two fixes were tried:

- Route through `cmd.exe` with hand-rolled caret-escaping (correct, but it's
  custom quoting logic ported from `cross-spawn` — easy to get subtly wrong).
- Just set `shell: true` (simpler, but shells out, so args need to stay
  internally-controlled, never user input).

Also: PATH resolution needs PATHEXT-aware probing (`claude` on Windows is really
`claude.cmd`), and killing a hung agent needs `taskkill /T /F` since Windows has
no process groups to `SIGKILL`.

If someone wants to pick this up: the two escalated branches
(`pr/claude/refactor-for-multi-platform-agnostic-rel-2623896-0`,
`pr/codex/refactor-for-multi-platform-agnostic-rel-2623896-1`) have working
starting points — CI matrix + spawn fix in the first, release packaging
workflow in the second. They overlap on `agent-bin.js`/`cli-adapter.js` and need
reconciling, not a straight merge. Contributions welcome.
