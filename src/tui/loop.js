import fs from "node:fs";
import * as realScreen from "./screen.js";
import * as realInput from "./input.js";
import { render as realRender, snapshot as realSnapshot } from "../dashboard.js";
import { computeLayout } from "./layout.js";
import { visWidth, colorEnabled, box, table, C, STAGE_SYMBOL, VERDICT_SYMBOL, paint } from "./theme.js";

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

const PANEL_ORDER = ["live", "interrupted", "history"];
const PANEL_TITLE = { live: "LIVE", interrupted: "INTERRUPTED", history: "HISTORY" };
const VERDICT_COLOR = { merged: C.ok, pr: C.warn, escalated: C.fail, "pr-fallback": C.fail };

function pct(n) { return n == null ? "n/a" : `${Math.round(n * 100)}%`; }
function usd(n) { return n == null ? "n/a" : `$${n.toFixed(4)}`; }
function mmss(startedAt, now) {
  const t = Date.parse(startedAt);
  if (!Number.isFinite(t)) return "??:??";
  const secs = Math.max(0, Math.floor((now - t) / 1000));
  return `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`;
}
function stageText(stage) { return `${STAGE_SYMBOL[stage] || ""} ${stage}`.trim(); }
function verdictText(verdict, color, colorCode) {
  return `${VERDICT_SYMBOL[verdict] || ""} ${paint(color, colorCode, verdict)}`.trim();
}
function seg(text, code = "") { return [{ code, text }]; }
function plainRows(lines) { return lines.map((text) => seg(text)); }

function ansiIndexForPlainIndex(line, plainIndex) {
  let plain = 0;
  for (let i = 0; i < line.length;) {
    const ansi = line.slice(i).match(/^\x1b\[[0-9;]*m/);
    if (ansi) {
      i += ansi[0].length;
      continue;
    }
    if (plain === plainIndex) return i;
    const width = line.codePointAt(i) > 0xffff ? 2 : 1;
    i += width;
    plain += width;
  }
  return -1;
}

function addScrollbar(lines, rect, total, offset, color) {
  if (!rect.focused || total <= rect.bodyRows || rect.bodyRows <= 0 || lines.length < 3) return lines;
  const thumb = Math.max(1, Math.floor((rect.bodyRows / total) * rect.bodyRows));
  const maxTop = Math.max(0, rect.bodyRows - thumb);
  const top = Math.round((offset / Math.max(1, total - rect.bodyRows)) * maxTop);
  return lines.map((line, idx) => {
    const bodyIdx = idx - 1;
    if (bodyIdx < top || bodyIdx >= top + thumb) return line;
    const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
    const pos = ansiIndexForPlainIndex(line, plain.lastIndexOf("│"));
    if (pos < 0) return line;
    const bar = paint(color, C.title, "┃");
    return `${line.slice(0, pos)}${bar}${line.slice(pos + 1)}`;
  });
}

function panelLines(title, rows, rect, { columns, color, borderCode = C.border, scrollOffset = 0 }) {
  if (rect.height <= 0) return [];
  if (rect.height === 1) return [clip(title, columns)];
  const visible = rows.slice(scrollOffset, scrollOffset + rect.bodyRows);
  while (visible.length < rect.bodyRows) visible.push(seg(""));
  if (rect.peek && visible.length) visible[visible.length - 1] = seg(`... ${rect.hint} more`, C.muted);
  let out = box(title, visible, { color, columns }).split("\n").slice(0, rect.height);
  if (borderCode !== C.border) {
    out = out.map((line) => line
      .replace(/[╭╮╰╯─│]/g, (ch) => paint(color, borderCode, ch)));
  }
  return addScrollbar(out, rect, rows.length, scrollOffset, color);
}

function buildStructuredFrame(orchDir, snap, state, { color, columns, rows }) {
  const now = Date.now();
  const layout = computeLayout({
    columns,
    rows,
    liveCount: snap.live.length,
    interruptedCount: snap.interrupted.length,
    focus: state.focus,
  });
  if (layout.fallback) return null;

  const liveRows = snap.live.length ? snap.live.flatMap((c) => {
    const round = c.round != null ? ` r${c.round}` : "";
    const out = [
      seg(`${c.branch}  [${stageText(c.stage)}${round}]  ${mmss(c.startedAt, now)}  sid=${c.sid}`),
    ];
    if (c.log) out.push(seg(`log ${c.log.file}: ${String(c.log.tail).split("\n").pop()}`, C.muted));
    return out;
  }) : [seg("(none)", C.muted)];

  const interruptedRows = snap.interrupted.length ? snap.interrupted.map((c) => {
    const round = c.round != null ? ` r${c.round}` : "";
    const when = c.lastUpdate ? `  ${c.lastUpdate}` : "";
    return seg(`${c.branch}  [${stageText(c.stage)}${round}]  sid=${c.sid}${when}`, C.fail);
  }) : [];

  const historyTable = snap.history.length ? table(
    ["TIME", "BRANCH", "VERDICT", "ROUNDS", "COST"],
    snap.history.map((e) => {
      const usage = e.tokens ? `${e.tokens}tok${e.costUsd != null ? ` ${usd(e.costUsd)}` : ""}` : "";
      return [
        e.ts,
        e.branch,
        verdictText(e.verdict, color, e.resolved ? C.muted : VERDICT_COLOR[e.verdict] || ""),
        `${e.rounds}rnd`,
        usage,
      ];
    }),
    { columns, maxInner: Math.max(20, columns - 4) },
  ).split("\n") : ["(none)"];
  const historyRows = plainRows(historyTable);
  const rowsByPanel = { live: liveRows, interrupted: interruptedRows, history: historyRows };

  for (const name of PANEL_ORDER) {
    const rect = layout.panels[name];
    const max = Math.max(0, rowsByPanel[name].length - rect.bodyRows);
    state.panelScroll[name] = Math.min(Math.max(0, state.panelScroll[name] || 0), max);
  }

  const m = snap.metrics;
  const status = `LIVE ${snap.live.length} · INTERRUPTED ${snap.interrupted.length} · RUNS ${m.total} · MERGED ${m.merged} (${pct(m.successRate)}) · TOKENS ${m.totalTokens} · COST ${usd(m.totalCostUsd)}`;
  const out = [
    clip(`orch dashboard - ${orchDir}`, columns),
    clip(status, columns),
  ];
  for (const name of PANEL_ORDER) {
    const rect = layout.panels[name];
    const focused = rect.focused ? "*" : " ";
    const warn = name === "interrupted" && snap.interrupted.length ? " ! " : " ";
    const title = `${focused}${PANEL_TITLE[name]} ${name === "live" ? snap.live.length : name === "interrupted" ? snap.interrupted.length : snap.history.length}${warn}`;
    out.push(...panelLines(title, rowsByPanel[name], rect, {
      columns,
      color,
      borderCode: name === "interrupted" && snap.interrupted.length ? C.fail : C.border,
      scrollOffset: state.panelScroll[name] || 0,
    }));
  }
  out.push(footerText());
  return out.join("\n");
}

function footerText() {
  const ts = new Date().toTimeString().slice(0, 8);
  return `q quit · Tab focus · 1/2/3 panel · j/k scroll · r refresh · refreshed ${ts}`;
}

// Live dashboard loop: poll the dashboard state, paint a bounded frame, and
// always restore the terminal on quit/signal/error. Every collaborator is
// injected (defaulting to the real module/stream) so node:test drives it with
// fakes and no real TTY.
export function run(orchDir, opts = {}) {
  const {
    screen = realScreen,
    input = realInput,
    render = realRender,
    snapshot = realSnapshot,
    out = process.stdout,
    stdin = process.stdin,
    exit = (code) => process.exit(code),
    refreshMs = 1000,
    historyLimit,
    repo = null,
    checkHistory = false,
  } = opts;
  const color = colorEnabled(out);
  const useStructured = render === realRender || snapshot !== realSnapshot;
  const state = { scrollOffset: 0, focus: "live", panelScroll: { live: 0, interrupted: 0, history: 0 } };
  let prevFrame = null;
  let prevLineCount = 0;

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
      const rows = Number.isFinite(out.rows) && out.rows > 0 ? out.rows : 24;
      let text = null;
      let structuredFrame = false;
      if (useStructured) {
        text = buildStructuredFrame(
          orchDir,
          snapshot(orchDir, { historyLimit, repo, checkHistory }),
          state,
          { color, columns: width, rows },
        );
        structuredFrame = text != null;
      }
      text ??= String(render(orchDir, { color, columns: width, historyLimit, repo, checkHistory }));
      const lines = text.split("\n").map((l) => clip(l, width));
      const bodyRows = Math.max(0, rows - 1); // reserve one row for the footer
      const maxOffset = Math.max(0, lines.length - bodyRows);
      state.scrollOffset = Math.min(Math.max(0, state.scrollOffset), maxOffset);
      const window = lines.slice(state.scrollOffset, state.scrollOffset + bodyRows);
      const frame = structuredFrame ? lines.join("\n") : [...window, footerText()].join("\n");
      if (frame === prevFrame) return;
      prevFrame = frame;
      prevLineCount = screen.paintFrame(out, frame, prevLineCount);
    } catch (err) {
      fail(err);
    }
  }

  function dispatch(ev) {
    const scrollName = state.focus;
    switch (ev.type) {
      case "up":
        if (useStructured) state.panelScroll[scrollName] -= 1;
        else state.scrollOffset -= 1;
        tick();
        break;
      case "down":
        if (useStructured) state.panelScroll[scrollName] += 1;
        else state.scrollOffset += 1;
        tick();
        break;
      case "top":
        if (useStructured) state.panelScroll[scrollName] = 0;
        else state.scrollOffset = 0;
        tick();
        break;
      case "bottom":
        if (useStructured) state.panelScroll[scrollName] = Infinity;
        else state.scrollOffset = Infinity; // tick() clamps to maxOffset
        tick();
        break;
      case "tab":
      case "shift-tab": {
        const idx = PANEL_ORDER.indexOf(state.focus);
        const step = ev.type === "tab" ? 1 : -1;
        state.focus = PANEL_ORDER[(idx + step + PANEL_ORDER.length) % PANEL_ORDER.length];
        tick();
        break;
      }
      case "panel":
        if (PANEL_ORDER[ev.index]) state.focus = PANEL_ORDER[ev.index];
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
