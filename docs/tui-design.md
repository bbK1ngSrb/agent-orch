# `orch dashboard` — Live TUI design

Status: accepted (design panel, 2026-07-10). Supersedes the one-shot static print for
interactive terminals. Basis: `docs/superpowers/specs/2026-07-06-terminal-reskin-design.md`.

## Goal
Turn `orch dashboard` from a single static print into a full-screen, live-refreshing terminal
UI (lazygit/k9s/htop class) **with zero new npm dependencies** — built on Node built-ins
(`tty`, `node:readline`, `fs.watch`) plus the existing hand-rolled ANSI helpers in
`src/tui/theme.js`, driven entirely by the existing pure `dashboard.snapshot()` data model.

## Non-negotiable constraints
- **Zero new dependencies.** `package.json`/`package-lock.json` are orch protected-paths and the
  repo is deliberately dep-free (`theme.js:3-4`). No Ink, no blessed, no node-pty.
- **`snapshot()` is the single data source.** The loop never reads `.orch/` directly.
- **Scriptable path untouched.** `--json`, piped/redirected, non-TTY, and `--once` output stay
  byte-identical to today's `render()`. The live view activates only on an interactive TTY.
- **Terminal is always restored** (cursor, raw-mode, alt-screen) on quit / SIGINT / SIGTERM /
  uncaughtException — the #1 TUI bug class.

## Runtime architecture (built-ins only)
- **Alt-screen**: enter `\x1b[?1049h` + hide cursor `\x1b[?25l`; exit shows cursor then leaves
  alt-screen (order matters). Shell scrollback is preserved.
- **Paint**: NOT `\x1b[2J` per frame (flicker). Cursor home `\x1b[H`, write each line + `\x1b[K`
  (erase-to-EOL); if the frame shrank, `\x1b[J` clears the tail. Track only `previousLineCount`.
  Skip the write entirely when the rendered string equals the previous frame.
- **Refresh**: `setInterval(tick, refreshMs)` (default 1000ms). `tick` = `snapshot()` → build text →
  paint. Best-effort `fs.watch(orchDir)` (try/catch, non-recursive, debounced ~100ms) only kicks an
  early tick; **the timer is the correctness guarantee** — `fs.watch` is unreliable on the NFS mount
  this repo runs from and may silently no-op.
- **Input**: gate on `stdin.isTTY`; `setRawMode(true)`; `node:readline.emitKeypressEvents(stdin)`
  parses arrows/vim keys/escapes correctly across terminals. **Ctrl-C arrives as keypress `0x03`,
  not SIGINT, under raw mode** — must be handled explicitly or the user is trapped.
- **Resize**: `process.stdout.on('resize', debounce(tick, 50))` (Node updates `columns`/`rows`
  before firing; no manual SIGWINCH). Reflow = re-run the pure text builder with new width.
- **Shutdown**: one idempotent `shutdown()` (guard `let done=false`): clear timer, close watcher,
  raw-mode off, remove listeners, show cursor, leave alt-screen, THEN exit/print. `process.on('exit')`
  does a **synchronous** restore; SIGINT/SIGTERM/uncaughtException/unhandledRejection all route through
  shutdown so a mid-tick throw can never leave the terminal wedged.

## Module layout (all under the auto-mergeable set)
```
src/tui/
  theme.js   (existing — extend table() with a columns clamp mirroring box(); add symbol maps)
  screen.js  (new — alt-screen/cursor/clear primitives + idempotent restore registration)
  input.js   (new — raw-mode lifecycle + keypress normalization via node:readline)
  layout.js  (new — pure panel geometry from columns/rows/counts; min-width fallback)
  loop.js    (new — composes the above: timer, tick, key dispatch, resize, signal/error restore)
```
Every module takes injected stream/emitter objects (default to the real ones) so node:test can
drive them with fakes — same DI pattern `test/dashboard.test.js` already uses.

## Interaction model (read-only by default)
Keymap (normal mode; conventions from lazygit/k9s/tig):
`j`/`↓` `k`/`↑` move · `g`/`G` top/bottom · `Tab`/`Shift-Tab` cycle panel · `1`/`2`/`3` jump to
Live/Interrupted/History · `Enter` drill into row · `Esc` peel one level · `/` filter active panel ·
`f` follow-mode in log detail · `r` force refresh · `p` pause/resume refresh (screen only — NOT the
`.orch/pause` kill switch) · `+`/`-` refresh interval · `?` help overlay · `q` quit · `Ctrl-C` hard quit.
Filter mode swallows all printable keys until Enter/Esc so typing never triggers commands.

**Read-only floor.** Nothing in the TUI shells out or mutates `.orch/`. Interrupted-cycle detail
*displays* the literal `orch continue <sid>` string and the checkpoint path for the user to copy —
never executes them. Any state-mutating action (run continue, kill a pid, write `.orch/pause`) is
explicitly out of scope and, if ever added, must be a separate opt-in flag with confirmation.

## Layout & visual language
Stacked full-width panels (branch names are long): header/title + one-line status strip
(`LIVE n · INTERRUPTED n · RUNS n · MERGED n (x%) · TOKENS · COST` from `metrics()`), then
LIVE CYCLES, INTERRUPTED, RUN HISTORY, pinned footer help bar. The **focused** panel gets a row
floor (~60% of the elastic area); others shrink to a peek with a "… N more" hint. INTERRUPTED
panel border turns red + `⚠` the instant it is non-empty — "needs a human" outranks everything.
Reflow tiers: <90 cols drop `pid=`/fold COST; <70 drop inline log tail; <50 single-panel mode;
below `box()`'s min inner width fall back to the plain scrolling `render()` refreshed on interval.

**Color is decoration, never the only signal.** Reuse `theme.C`; add symbol prefixes so states
survive `NO_COLOR`/non-color terminals and so `escalated` vs `pr-fallback` (both `C.fail`) stay
distinct: `● live` `✓ merged` `! pr` `✗ escalated` `▲ pr-fallback`, stage words always spelled out.

## Improvements over the current static render
Continuous refresh (no manual re-run) · elapsed duration (`00:42`) instead of raw ISO `since` ·
interrupted cycles get visual priority · scrollable/focusable panels (usable at scale) ·
always-visible metrics strip · full log-tail drill-down (vs today's single last line) · keyboard
affordances · clean terminal lifecycle.

## Task breakdown (ordered; each an independent PR that never breaks `orch dashboard`)
1. **Width-aware `table()` + honor `columns` in `render()`** — fix the dropped `opts.columns`
   param; add clamp/truncate to `table()` mirroring `box()`. Pure improvement to one-shot output.
2. **No-color-safe symbols** — `VERDICT_SYMBOL`/`STAGE_SYMBOL` in `theme.js`, wired into `render()`.
3. **`src/tui/screen.js`** — alt-screen/cursor/clear primitives + idempotent restore (unwired).
4. **`src/tui/input.js`** — raw-mode lifecycle + keypress normalization, Ctrl-C-as-keypress (unwired).
5. **`src/tui/loop.js` v1** — live poll loop reusing `render()`, line-scroll, footer, resize, and the
   full clean-shutdown/signal/error restore. Library-only, injectable, not yet wired to the CLI.
6. **Wire `src/cli.js`** — default `orch dashboard` → live loop when `stdout.isTTY && stdin.isTTY &&
   !--json && !--once`; else static byte-identical. Add `--once`/`--plain` + `--refresh-ms`, update
   `printUsage()` and `src/completion.js`.
7. **Structured panels + status strip + focus/scroll** — `src/tui/layout.js` geometry, three
   focusable panels, metrics strip, elapsed-time, scrollbar; `Tab`/`1`-`3`/`j`/`k`/`g`/`G`.
8. **Drill-down detail + `/` filter + `?` help overlay** — `Enter` full-log detail with `f` follow,
   substring filter, centered help box; `Esc` peels one level. Display-only `orch continue <sid>`.

Delivering 1-6 alone yields a working live TUI; 7-8 are the richer interactive layer.
