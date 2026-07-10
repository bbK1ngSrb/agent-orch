import fs from "node:fs";
import * as realScreen from "./screen.js";
import * as realInput from "./input.js";
import { render as realRender, snapshot as realSnapshot } from "../dashboard.js";
import { visWidth, colorEnabled } from "./theme.js";

// Clip one line to `width` display columns (visWidth-aware). Lines that fit
// pass through untouched so color survives; the rare overflow strips ANSI and
// hard-truncates — same "drop color rather than miscount" tradeoff theme.js
// makes. render() already clamps to `columns`, so this is a safety net.
function clip(line, width) {
  if (!Number.isFinite(width) || visWidth(line) <= width) return line;
  const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
  let out = "", w = 0;
  for (const ch of plain) {
    const cw = visWidth(ch);
    if (w + cw > width) break;
    out += ch;
    w += cw;
  }
  return out;
}

// Trailing-edge debounce; the timer is unref'd so it never keeps the loop
// alive on its own (the interval is the correctness guarantee).
function debounce(fn, ms) {
  let t = null;
  return () => {
    if (t) clearTimeout(t);
    t = setTimeout(fn, ms);
    if (t.unref) t.unref();
  };
}

// v1 live dashboard: poll render() on an interval, clip to width, show a
// scroll window with a pinned footer, and always restore the terminal on
// quit/signal/error. Every collaborator is injected (defaulting to the real
// module/stream) so node:test drives it with fakes and no real TTY.
export function run(orchDir, opts = {}) {
  const {
    screen = realScreen,
    input = realInput,
    render = realRender,
    snapshot = realSnapshot, // part of the v1 seam; render() is the data path today
    out = process.stdout,
    stdin = process.stdin,
    exit = (code) => process.exit(code),
    refreshMs = 1000,
    historyLimit,
    repo = null,
    checkHistory = false,
  } = opts;
  void snapshot;

  const color = colorEnabled(out);
  const state = { scrollOffset: 0 };
  let prevFrame = null;
  let prevLineCount = 0;

  function footer() {
    const ts = new Date().toTimeString().slice(0, 8);
    return `q quit · ↑↓ scroll · r refresh · refreshed ${ts}`;
  }

  // Build the composed frame and paint it, skipping the write when nothing
  // changed. Any throw (e.g. a mid-tick render error) routes through fail()
  // so the terminal is never left in raw-mode/alt-screen.
  function tick() {
    try {
      // Real pseudo-TTYs (pty spawned without a winsize ioctl) report columns/rows
      // as 0 or undefined. Treat any non-positive dimension as "unknown" and fall
      // back — else width 0 clips every line away and rows 0 makes bodyRows 0,
      // both of which paint a blank body. 80 cols is the classic terminal default.
      const width = Number.isFinite(out.columns) && out.columns > 0 ? out.columns : 80;
      const text = String(render(orchDir, { color, columns: width, historyLimit, repo, checkHistory }));
      const lines = text.split("\n").map((l) => clip(l, width));
      const rows = Number.isFinite(out.rows) && out.rows > 0 ? out.rows : lines.length + 1;
      const bodyRows = Math.max(0, rows - 1); // reserve one row for the footer
      const maxOffset = Math.max(0, lines.length - bodyRows);
      state.scrollOffset = Math.min(Math.max(0, state.scrollOffset), maxOffset);
      const window = lines.slice(state.scrollOffset, state.scrollOffset + bodyRows);
      const frame = [...window, footer()].join("\n");
      if (frame === prevFrame) return;
      prevFrame = frame;
      prevLineCount = screen.paintFrame(out, frame, prevLineCount);
    } catch (err) {
      fail(err);
    }
  }

  function dispatch(ev) {
    switch (ev.type) {
      case "up":
        state.scrollOffset -= 1;
        tick();
        break;
      case "down":
        state.scrollOffset += 1;
        tick();
        break;
      case "top":
        state.scrollOffset = 0;
        tick();
        break;
      case "bottom":
        state.scrollOffset = Infinity; // tick() clamps to maxOffset
        tick();
        break;
      case "refresh":
        tick();
        break;
      case "quit":
        shutdown(0);
        break;
    }
  }

  // --- lifecycle wiring ---
  screen.enter(out);
  const unregisterRestore = screen.registerRestore(out);
  const stopInput = input.start(stdin, dispatch);
  const timer = setInterval(tick, refreshMs);
  if (timer.unref) timer.unref();

  let watcher = null;
  try {
    watcher = fs.watch(orchDir, debounce(tick, 100));
    watcher.on("error", () => {}); // NFS: silently disabled on failure
  } catch {
    watcher = null; // fs.watch unreliable on NFS; the interval covers us
  }

  const onResize = debounce(tick, 50);
  out.on("resize", onResize);
  const onSigint = () => shutdown(0);
  const onSigterm = () => shutdown(0);
  const onUncaught = (err) => fail(err);
  const onUnhandled = (err) => fail(err);
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onUnhandled);

  // Idempotent teardown: undo everything the loop registered and restore the
  // terminal. Guarded by `done` so signal + error + quit can't double-restore.
  let done = false;
  function teardown() {
    if (done) return;
    done = true;
    clearInterval(timer);
    if (watcher) {
      try {
        watcher.close();
      } catch {
        // already gone
      }
    }
    stopInput();
    out.off("resize", onResize);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    process.off("uncaughtException", onUncaught);
    process.off("unhandledRejection", onUnhandled);
    screen.leave(out);
    unregisterRestore();
  }

  function shutdown(code) {
    teardown();
    exit(code);
  }

  // On error: restore the terminal, print the error to the primary screen,
  // then exit non-zero.
  function fail(err) {
    teardown();
    try {
      out.write(`${err && err.stack ? err.stack : err}\n`);
    } catch {
      // primary screen unavailable; nothing more to do
    }
    exit(1);
  }

  tick(); // first paint
  return { tick, dispatch, shutdown, state };
}
