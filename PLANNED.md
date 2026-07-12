# Planned

## Windows native release — shipped

Native Windows support landed and was confirmed on real Windows 10/11
hardware (not WSL) with agent-orch installed via `npm install -g` from a
built tarball. Confirmed working: `orch init --link`, `orch agent add`,
`orch task --dry` (agent rotation), a full real task cycle (author → review
→ revise → gate → escalate/merge, including a `.sh`-script test gate via Git
for Windows' bundled `sh.exe` association), and `orch update`.

Two real bugs were found and fixed along the way, both in the Windows
process-spawn path (`src/platform.js`, `src/agent-bin.js`, `src/gate.js`,
`src/adapters/cli-adapter.js`, `src/upgrade.js`):

- **#311** — `src/upgrade.js` spawned `npm` with a bare `execFileSync("npm",
  ...)`, which can't resolve Windows' `npm.cmd` shim (`CreateProcess` ignores
  `PATHEXT`). Fixed by routing through the same `portableSpawnSpec`/
  `resolveAgentBin` seam `gate.js` and `cli-adapter.js` already used.
- **#313** — the root cause `#311`'s first fix didn't fully address:
  `exeCandidates()` probed the bare extensionless binary name *before* trying
  `PATHEXT`-suffixed candidates. npm's own global bin directory ships both a
  bare `npm` (POSIX shim) and `npm.cmd` (the real Windows shim) side by
  side — Windows' `fs.accessSync` can't distinguish an executable file from a
  non-executable one (no POSIX exec bit), so the bare, unlaunchable file won
  the probe. Fixed by dropping the bare name from the Windows candidate list
  entirely.

The approach that actually landed differs from the two escalated branches
referenced in earlier drafts of this note
(`pr/claude/refactor-for-multi-platform-agnostic-rel-2623896-0`,
`pr/codex/refactor-for-multi-platform-agnostic-rel-2623896-1`, both since
abandoned) — those attempted hand-rolled `cmd.exe` caret-escaping or a
`shell: true` fallback. The shipped fix instead resolves the correct binary
path *before* spawning and stays shell-less on every platform, avoiding both
the quoting-correctness risk of caret-escaping and the shell-injection
surface of `shell: true`.

CI's Windows matrix leg (`npm-publish.yml`'s `pack-test` job) now also runs
`orch update --check` as part of every pre-publish pack-test, so this
regression class gets caught automatically before any future publish, not
just via manual testing.
