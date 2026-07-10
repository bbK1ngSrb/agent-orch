import fs from "node:fs";
import * as realScreen from "./screen.js";
import * as realInput from "./input.js";
import { render as realRender, snapshot as realSnapshot } from "../dashboard.js";
import { computeLayout } from "./layout.js";
import { reduceHistorySelection } from "./selection.js";
import { filterHistory } from "./filter.js";
import { visWidth, colorEnabled, box, table, C, STAGE_SYMBOL, VERDICT_SYMBOL, paint, formatTimestamp } from "./theme.js";

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

function valueText(value) {
  if (value == null || value === "") return "n/a";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function historyDetailRows(entry, index, count) {
  if (!entry) return [seg("(none)", C.muted)];
  const rows = [
    seg(`> selected row ${index + 1} of ${count}`),
    seg(`branch ${valueText(entry.branch)}`),
    seg(`time ${entry.ts ? formatTimestamp(entry.ts) : valueText(entry.ts)}`),
    seg(`sid ${valueText(entry.sid)}`),
    seg(`verdict ${valueText(entry.verdict)}${entry.resolved ? " (resolved)" : ""}`),
    seg(`rounds ${valueText(entry.rounds)}`),
    seg(`usage ${entry.tokens ? `${entry.tokens} tokens` : "n/a"}${entry.costUsd != null ? ` ${usd(entry.costUsd)}` : ""}`),
    seg("log tail", C.title),
  ];
  const logTail = entry.logTail || entry.log?.tail || entry.reason || "";
  rows.push(...String(logTail || "(not recorded in run history)").split("\n").slice(-6).map((line) => seg(line, logTail ? "" : C.muted)));
  rows.push(
    seg("stage breakdown", C.title),
    seg(`review ${valueText(entry.verdict)} after ${valueText(entry.rounds)} round(s)`),
    seg(`terminal ${entry.resolved ? "resolved stale red row" : valueText(entry.verdict)}`),
    seg("Esc/back returns", C.muted),
  );
  return rows;
}

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

function buildHelpFrame({ color, columns, rows }) {
  const help = box("HELP", [
    seg("? / Esc  close help"),
    seg("Tab      cycle focus"),
    seg("1/2/3    jump to panel"),
    seg("j/k      scroll focused panel"),
    seg("g/G      top / bottom"),
    seg("Enter    open history detail"),
    seg("Esc/back close history detail"),
    seg("r        refresh"),
    seg("q        quit"),
  ], { color, columns, minInner: 28, maxInner: Math.max(28, Math.min(52, columns - 4)) });
  return help.split("\n").slice(0, Math.max(1, rows)).map((line) => clip(line, columns)).join("\n");
}

function buildStructuredFrame(orchDir, snap, state, { color, columns, rows }) {
  const now = Date.now();
  // Filter narrows the history panel; selection/scroll all clamp to the
  // filtered set so the visible selection never points off-list.
  const history = filterHistory(snap.history, state.filter);
  state.lastHistoryCount = history.length;
  state.historySelection = reduceHistorySelection(state.historySelection, { type: "clamp" }, history.length);
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
    const when = c.lastUpdate ? `  ${formatTimestamp(c.lastUpdate)}` : "";
    return seg(`${c.branch}  [${stageText(c.stage)}${round}]  sid=${c.sid}${when}`, C.fail);
  }) : [];

  const historyTable = history.length ? table(
    ["", "TIME", "BRANCH", "VERDICT", "ROUNDS", "COST"],
    history.map((e) => {
      const usage = e.tokens ? `${e.tokens}tok${e.costUsd != null ? ` ${usd(e.costUsd)}` : ""}` : "";
      const selected = history.indexOf(e) === state.historySelection.selectedIndex ? ">" : "";
      return [
        selected,
        formatTimestamp(e.ts),
        e.branch,
        verdictText(e.verdict, color, e.resolved ? C.muted : VERDICT_COLOR[e.verdict] || ""),
        `${e.rounds}rnd`,
        usage,
      ];
    }),
    { columns, maxInner: Math.max(20, columns - 4) },
  ).split("\n") : [state.filter ? "(no matches)" : "(none)"];
  const historyRows = state.historySelection.detailOpen
    ? historyDetailRows(history[state.historySelection.selectedIndex], state.historySelection.selectedIndex, history.length)
    : plainRows(historyTable);
  const rowsByPanel = { live: liveRows, interrupted: interruptedRows, history: historyRows };

  if (state.historySelection.detailOpen) {
    state.panelScroll.history = 0;
  } else if (history.length) {
    const rect = layout.panels.history;
    const selectedLine = state.historySelection.selectedIndex + 2; // table header + divider
    const current = state.panelScroll.history || 0;
    if (selectedLine < current) state.panelScroll.history = selectedLine;
    else if (rect.bodyRows > 0 && selectedLine >= current + rect.bodyRows) {
      state.panelScroll.history = selectedLine - rect.bodyRows + 1;
    }
  }

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
    const detail = name === "history" && state.historySelection.detailOpen ? " DETAIL" : "";
    const title = `${focused}${PANEL_TITLE[name]}${detail} ${name === "live" ? snap.live.length : name === "interrupted" ? snap.interrupted.length : history.length}${warn}`;
    out.push(...panelLines(title, rowsByPanel[name], rect, {
      columns,
      color,
      borderCode: name === "interrupted" && snap.interrupted.length ? C.fail : C.border,
      scrollOffset: state.panelScroll[name] || 0,
    }));
  }
  out.push(footerText(state));
  return out.join("\n");
}

function footerText(arg = true) {
  const ts = new Date().toTimeString().slice(0, 8);
  // Two callers with different shapes: the structured frame passes the live
  // `state` object (carrying filter fields); the non-structured fallback passes
  // a boolean `controlsActive`. Normalize: an object means structured/active,
  // a boolean/undefined keeps main's active flag for the plain path.
  const state = arg && typeof arg === "object" ? arg : null;
  const active = state ? true : arg;
  if (!active) return `plain fallback · controls disabled · q quit · r refresh · refreshed ${ts}`;
  if (state?.filterMode) return `filter: ${state.filter}_ · Enter apply · Esc clear`;
  // `/ filter` hint and the active-filter label only exist in structured mode.
  const hint = state ? " · / filter" : "";
  const filterLabel = state?.filter ? ` · filter "${state.filter}"` : "";
  return `q quit · ? help · Tab focus · 1/2/3 panel · j/k scroll${hint} · r refresh · refreshed ${ts}${filterLabel}`;
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
  const state = {
    scrollOffset: 0,
    focus: "live",
    controlsActive: false,
    helpOpen: false,
    panelScroll: { live: 0, interrupted: 0, history: 0 },
    historySelection: reduceHistorySelection({}, {}, 0),
    filter: "",
    filterMode: false,
  };
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
      state.controlsActive = !useStructured || structuredFrame;
      if (!state.controlsActive) state.helpOpen = false;
      if (structuredFrame && state.helpOpen) text = buildHelpFrame({ color, columns: width, rows });
      text ??= String(render(orchDir, { color, columns: width, historyLimit, repo, checkHistory }));
      const lines = text.split("\n").map((l) => clip(l, width));
      const bodyRows = Math.max(0, rows - 1); // reserve one row for the footer
      const maxOffset = Math.max(0, lines.length - bodyRows);
      state.scrollOffset = Math.min(Math.max(0, state.scrollOffset), maxOffset);
      const window = lines.slice(state.scrollOffset, state.scrollOffset + bodyRows);
      const frame = structuredFrame ? lines.join("\n") : [...window, footerText(state.controlsActive)].join("\n");
      if (frame === prevFrame) return;
      prevFrame = frame;
      prevLineCount = screen.paintFrame(out, frame, prevLineCount);
    } catch (err) {
      fail(err);
    }
  }

  function dispatch(ev) {
    // Filter input mode: keys type into the query instead of firing shortcuts.
    // Ctrl-C still quits (it carries no printable value); Enter applies and
    // exits, Esc clears and exits, Backspace edits. `/` carries a printable
    // value, so it appends literally (branch names like `pr/done`). tick()
    // re-narrows the list and clamps the selection to the filtered set on
    // every change. This must run before the global shortcuts so `q`/`r`/`?`
    // type literally instead of firing quit/refresh/help.
    if (state.filterMode) {
      if (ev.type === "quit" && ev.ctrlC) { shutdown(0); return; }
      if (ev.type === "enter") state.filterMode = false;
      else if (ev.type === "esc") { state.filterMode = false; state.filter = ""; }
      else if (ev.type === "backspace") state.filter = state.filter.slice(0, -1);
      else if (typeof ev.value === "string" && ev.value.length === 1) state.filter += ev.value;
      else return; // ignore arrows/tab and other non-printable keys while typing
      tick();
      return;
    }
    if (ev.type === "quit") {
      shutdown(0);
      return;
    }
    if (ev.type === "refresh") {
      tick();
      return;
    }
    if (useStructured && !state.controlsActive) return;
    if (ev.type === "help") {
      state.helpOpen = !state.helpOpen;
      tick();
      return;
    }
    if (state.helpOpen && ev.type === "esc") {
      state.helpOpen = false;
      tick();
      return;
    }
    if (state.helpOpen) return;
    const scrollName = state.focus;
    if (useStructured && scrollName === "history" && ["up", "down", "top", "bottom", "enter", "esc", "left", "back"].includes(ev.type)) {
      state.historySelection = reduceHistorySelection(state.historySelection, ev, state.lastHistoryCount || 0);
      if (state.historySelection.detailOpen) state.panelScroll.history = 0;
      else if (["up", "down", "top", "bottom"].includes(ev.type)) state.panelScroll.history = state.historySelection.selectedIndex;
      tick();
      return;
    }
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
      case "filter":
        // Enter filter mode on the history panel (the only filtered list).
        // `quit`/`refresh` are handled earlier in dispatch, so they never
        // reach this switch.
        if (useStructured) { state.filterMode = true; state.focus = "history"; }
        tick();
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
