import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../../src/tui/loop.js";

// fs.watch on a nonexistent path throws synchronously → the loop disables the
// watcher and relies on the interval, so no real filesystem watch is created.
const ORCH_DIR = "/no/such/orch-loop-test";

function makeScreen() {
  const s = {
    painted: [],
    current: "",
    enterCalls: 0,
    leaveCalls: 0,
    enter() {
      s.enterCalls++;
    },
    leave() {
      s.leaveCalls++;
    },
    paintFrame(_out, text) {
      s.painted.push(String(text));
      s.current = String(text);
      return String(text).split("\n").length;
    },
    linePaints: [],
    paintLineAt(_out, row, text) {
      s.linePaints.push([row, String(text)]);
      // Keep the composed frame current: a footer-only repaint replaces one row.
      const lines = s.current.split("\n");
      lines[row - 1] = String(text);
      s.current = lines.join("\n");
    },
    registerRestore() {
      return () => {};
    },
  };
  return s;
}

function makeInput() {
  const inp = {
    stopCalls: 0,
    onKey: null,
    start(_stdin, onKey) {
      inp.onKey = onKey;
      return () => {
        inp.stopCalls++;
      };
    },
  };
  return inp;
}

function makeOut(columns = 80, rows = 24, isTTY = false) {
  const o = new EventEmitter();
  o.columns = columns;
  o.rows = rows;
  o.isTTY = isTTY;
  o.writes = [];
  o.write = (str) => {
    o.writes.push(str);
    return true;
  };
  return o;
}

function setup(opts = {}) {
  const screen = makeScreen();
  const input = makeInput();
  const out = makeOut(opts.columns, opts.rows, opts.isTTY);
  const exits = [];
  const exit = (code) => exits.push(code);
  const handle = run(ORCH_DIR, {
    screen,
    input,
    out,
    stdin: {},
    exit,
    refreshMs: 1_000_000, // effectively no interval firing during the test
    render: opts.render,
    snapshot: opts.snapshot,
  });
  return { screen, input, out, exits, handle };
}

function structuredSnapshot(liveCount = 8) {
  const live = Array.from({ length: liveCount }, (_, i) => ({
    sid: `sid-${i}`,
    branch: `pr/live-${i}`,
    pid: 100 + i,
    startedAt: "2026-07-10T10:00:00.000Z",
    stage: "authoring",
    round: null,
    lastUpdate: "2026-07-10T10:00:00.000Z",
    log: null,
  }));
  return {
    live,
    interrupted: [{
      sid: "halted",
      branch: "pr/interrupted",
      stage: "review",
      round: 2,
      lastUpdate: "2026-07-10T10:01:00.000Z",
    }],
    history: [
      {
        ts: "2026-07-10T10:02:00.000Z",
        branch: "pr/done",
        sid: "sid-done",
        verdict: "merged",
        rounds: 1,
        tokens: 100,
        costUsd: 0.01,
      },
      {
        ts: "2026-07-10T10:03:00.000Z",
        branch: "pr/needs-work",
        sid: "sid-work",
        verdict: "escalated",
        rounds: 3,
        reason: "reviewer found a defect",
      },
    ],
    metrics: {
      total: 2,
      merged: 1,
      successRate: 0.5,
      totalTokens: 100,
      totalCostUsd: 0.01,
      cleanUnattendedCycles: 1,
    },
  };
}

test("tick paints a frame from the injected render, with a footer", () => {
  let text = "L1\nL2\nL3";
  const { screen, handle } = setup({ render: () => text, rows: 24, columns: 80 });

  // Initial paint happened on run(); change render and re-tick to observe it.
  text = "A1\nA2";
  handle.tick();

  const frame = screen.painted.at(-1);
  assert.match(frame, /A1/);
  assert.match(frame, /A2/);
  assert.match(frame, /q quit · \? help · Tab focus · 1\/2\/3 panel · j\/k scroll · r refresh · refreshed /);

  handle.shutdown(0); // remove process listeners registered by run()
});

test("run forwards historyLimit/repo/checkHistory into render", () => {
  let seen = null;
  const render = (_dir, o) => { seen = o; return "x"; };
  const handle = run(ORCH_DIR, {
    screen: makeScreen(), input: makeInput(), out: makeOut(80, 24),
    stdin: {}, exit: () => {}, refreshMs: 1_000_000, render,
    historyLimit: 5, repo: "/some/repo", checkHistory: true,
  });
  assert.equal(seen.historyLimit, 5);
  assert.equal(seen.repo, "/some/repo");
  assert.equal(seen.checkHistory, true);
  handle.shutdown(0);
});

test("a down key raises scrollOffset (clamped to content)", () => {
  const render = () => "l0\nl1\nl2\nl3\nl4"; // 5 content lines
  const { input, handle } = setup({ render, rows: 3, columns: 80 }); // bodyRows = 2

  assert.equal(handle.state.scrollOffset, 0);
  input.onKey({ type: "down" });
  assert.equal(handle.state.scrollOffset, 1);
  input.onKey({ type: "down" });
  assert.equal(handle.state.scrollOffset, 2);

  handle.shutdown(0);
});

test("unfocused history overflow shows the '... N more' hint", () => {
  // 10 history entries against a 12-row terminal: the history panel gets its
  // 3-row minimum (1 body row) while LIVE holds focus, so most entries are
  // hidden. Before historyCount was threaded into computeLayout() the hint
  // could never fire for history (its count was hardcoded to 0).
  const snap = structuredSnapshot(1);
  snap.history = Array.from({ length: 10 }, (_, i) => ({
    ts: `2026-07-10T10:0${i % 10}:00.000Z`,
    branch: `pr/done-${i}`,
    sid: `sid-${i}`,
    verdict: "merged",
    rounds: 1,
  }));
  const { screen, handle } = setup({ snapshot: () => snap, rows: 12, columns: 90 });

  assert.equal(handle.state.focus, "live");
  assert.match(screen.painted.at(-1), /\.\.\. \d+ more/);

  handle.shutdown(0);
});

test("structured loop cycles focus with Tab and jumps to interrupted with 2", () => {
  const { input, handle } = setup({
    snapshot: () => structuredSnapshot(),
    rows: 18,
    columns: 90,
  });

  assert.equal(handle.state.focus, "live");
  input.onKey({ type: "tab" });
  assert.equal(handle.state.focus, "interrupted");
  input.onKey({ type: "shift-tab" });
  assert.equal(handle.state.focus, "live");
  input.onKey({ type: "panel", index: 1 });
  assert.equal(handle.state.focus, "interrupted");

  handle.shutdown(0);
});

test("structured live rows render a detached log path without undefined fields", () => {
  const snap = structuredSnapshot(1);
  snap.live[0].detachedLog = "/tmp/detached.log";
  const { screen, handle } = setup({ snapshot: () => snap, rows: 18, columns: 90 });
  const frame = screen.painted.at(-1);

  assert.match(frame, /log \/tmp\/detached\.log/);
  assert.doesNotMatch(frame, /log undefined: undefined/);
  handle.shutdown(0);
});

test("structured scroll changes only the focused panel", () => {
  const { input, handle } = setup({
    snapshot: () => structuredSnapshot(20),
    rows: 12,
    columns: 90,
  });

  input.onKey({ type: "down" });
  assert.equal(handle.state.panelScroll.live, 1);
  assert.equal(handle.state.panelScroll.interrupted, 0);

  input.onKey({ type: "panel", index: 2 });
  input.onKey({ type: "bottom" });
  assert.ok(handle.state.panelScroll.history >= 0);
  assert.equal(handle.state.panelScroll.interrupted, 0);

  handle.shutdown(0);
});

test("structured history selection is visible, opens detail, and returns to the same row", () => {
  const { screen, input, handle } = setup({
    snapshot: () => structuredSnapshot(),
    rows: 24,
    columns: 100,
  });

  input.onKey({ type: "panel", index: 2 });
  assert.match(screen.painted.at(-1), /> +2026-07-10 10:02 +pr\/done/);

  input.onKey({ type: "down" });
  assert.equal(handle.state.historySelection.selectedIndex, 1);
  assert.match(screen.painted.at(-1), /> +2026-07-10 10:03 +pr\/needs-work/);

  input.onKey({ type: "enter" });
  assert.equal(handle.state.historySelection.detailOpen, true);
  assert.match(screen.painted.at(-1), /HISTORY DETAIL/);
  assert.match(screen.painted.at(-1), /> selected row 2 of 2/);
  assert.match(screen.painted.at(-1), /reviewer found a defect/);

  input.onKey({ type: "esc" });
  assert.deepEqual(handle.state.historySelection, { selectedIndex: 1, detailOpen: false });
  assert.match(screen.painted.at(-1), /> +2026-07-10 10:03 +pr\/needs-work/);

  handle.shutdown(0);
});

test("filter mode narrows history live and clamps the selection to the subset", () => {
  const { screen, input, handle } = setup({
    snapshot: () => structuredSnapshot(),
    rows: 24,
    columns: 100,
  });

  // Select the last history row, then enter filter mode via `/`.
  input.onKey({ type: "panel", index: 2 });
  input.onKey({ type: "down" });
  assert.equal(handle.state.historySelection.selectedIndex, 1);

  input.onKey({ type: "filter" });
  assert.equal(handle.state.filterMode, true);
  assert.equal(handle.state.focus, "history");

  // Type "done": only pr/done matches, so the selection clamps 1 → 0.
  for (const ch of "done") input.onKey({ type: "char", value: ch });
  assert.equal(handle.state.filter, "done");
  assert.equal(handle.state.historySelection.selectedIndex, 0);
  const frame = screen.current; // last keystrokes may only repaint the footer row
  assert.match(frame, /pr\/done/);
  assert.doesNotMatch(frame, /pr\/needs-work/);
  assert.match(frame, /filter: done_/);

  handle.shutdown(0);
});

test("filter with no matches shows a no-matches state; Esc clears it", () => {
  const { screen, input, handle } = setup({
    snapshot: () => structuredSnapshot(),
    rows: 24,
    columns: 100,
  });

  input.onKey({ type: "filter" });
  for (const ch of "zzz") input.onKey({ type: "char", value: ch });
  assert.match(screen.painted.at(-1), /\(no matches\)/);

  input.onKey({ type: "esc" });
  assert.equal(handle.state.filter, "");
  assert.equal(handle.state.filterMode, false);
  assert.match(screen.painted.at(-1), /pr\/needs-work/);

  handle.shutdown(0);
});

test("in filter mode shortcut letters type literally but Ctrl-C still quits", () => {
  const { input, handle, exits } = setup({
    snapshot: () => structuredSnapshot(),
    rows: 24,
    columns: 100,
  });

  input.onKey({ type: "filter" });
  // 'r' normally refreshes; carrying a printable value, it must append instead.
  input.onKey({ type: "refresh", value: "r" });
  assert.equal(handle.state.filter, "r");

  input.onKey({ type: "quit", ctrlC: true });
  assert.deepEqual(exits, [0]);
});

test("in filter mode `/` types literally instead of exiting (branch names like pr/done)", () => {
  const { input, handle } = setup({
    snapshot: () => structuredSnapshot(),
    rows: 24,
    columns: 100,
  });

  input.onKey({ type: "filter" });
  // `/` enters as a filter event carrying a printable value; inside filter mode
  // it must append rather than apply-and-exit, so `pr/done` is typeable.
  for (const ch of "pr") input.onKey({ type: "char", value: ch });
  input.onKey({ type: "filter", value: "/" });
  for (const ch of "done") input.onKey({ type: "char", value: ch });
  assert.equal(handle.state.filter, "pr/done");
  assert.equal(handle.state.filterMode, true);

  handle.shutdown(0);
});

test("structured scrollbar replaces the right border when color is enabled", () => {
  const { screen, handle } = setup({
    snapshot: () => structuredSnapshot(20),
    rows: 12,
    columns: 90,
    isTTY: true,
  });

  const frame = screen.painted.at(-1);
  const scrollbarLines = frame.split("\n")
    .filter((line) => line.includes("┃"))
    .map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));

  assert.ok(scrollbarLines.length > 0, "scrollbar thumb rendered");
  for (const line of scrollbarLines) {
    assert.match(line, /┃$/, "thumb replaces the final border");
    assert.doesNotMatch(line, /┃.*│/, "thumb is not injected into body text");
  }

  handle.shutdown(0);
});

test("zero pseudo-TTY dimensions still paint the body", () => {
  // A pty spawned without a winsize ioctl reports columns/rows as 0. Before the
  // dimension guard this made bodyRows 0 (and clipped every line to width 0),
  // painting a blank body — worse than the old one-shot default.
  const render = () => "R1\nR2\nR3";
  const { screen, handle } = setup({ render, columns: 0, rows: 0 });
  const frame = screen.painted.at(-1);
  assert.match(frame, /R1/);
  assert.match(frame, /R2/);
  assert.match(frame, /R3/);
  handle.shutdown(0);
});

test("structured help toggles with ? and closes with Esc", () => {
  const { screen, input, handle } = setup({
    snapshot: () => structuredSnapshot(),
    rows: 18,
    columns: 90,
  });

  input.onKey({ type: "help" });
  assert.equal(handle.state.helpOpen, true);
  assert.match(screen.painted.at(-1), /HELP/);
  assert.match(screen.painted.at(-1), /Tab +cycle focus/);
  assert.match(screen.painted.at(-1), /Enter +open history detail/);

  input.onKey({ type: "esc" });
  assert.equal(handle.state.helpOpen, false);
  assert.doesNotMatch(screen.painted.at(-1), /HELP/);

  input.onKey({ type: "help" });
  assert.equal(handle.state.helpOpen, true);
  input.onKey({ type: "help" });
  assert.equal(handle.state.helpOpen, false);

  handle.shutdown(0);
});

test("structured controls are inert when narrow fallback renders plain output", () => {
  const { screen, input, handle } = setup({
    snapshot: () => structuredSnapshot(),
    render: () => "plain dashboard\nline two",
    rows: 18,
    columns: 40,
  });
  const before = JSON.stringify(handle.state);

  input.onKey({ type: "tab" });
  input.onKey({ type: "panel", index: 2 });
  input.onKey({ type: "down" });
  input.onKey({ type: "help" });
  input.onKey({ type: "enter" });

  assert.equal(JSON.stringify(handle.state), before);
  assert.match(screen.painted.at(-1), /plain fallback · controls disabled · q quit · r refresh · refreshed /);
  assert.doesNotMatch(screen.painted.at(-1), /HELP/);

  handle.shutdown(0);
});

test("a quit key leaves the screen and then exits 0", () => {
  const { screen, input, exits } = setup({ render: () => "x", rows: 24, columns: 80 });

  input.onKey({ type: "quit" });

  assert.equal(screen.leaveCalls, 1);
  assert.deepEqual(exits, [0]);
});

test("a render that throws mid-tick restores the terminal and exits 1", () => {
  const screen = makeScreen();
  const input = makeInput();
  const out = makeOut();
  const exits = [];
  const boom = () => {
    throw new Error("boom");
  };

  // run()'s first tick throws → fail() path.
  run(ORCH_DIR, {
    screen,
    input,
    out,
    stdin: {},
    exit: (c) => exits.push(c),
    refreshMs: 1_000_000,
    render: boom,
  });

  assert.equal(screen.leaveCalls, 1, "alt-screen restored");
  assert.equal(input.stopCalls, 1, "raw-mode stopped");
  assert.deepEqual(exits, [1]);
  assert.ok(
    out.writes.some((w) => /boom/.test(w)),
    "error printed to the primary screen",
  );
});

test("an unchanged body is not repainted when only the footer clock advances", () => {
  // Freeze Date so the frame is deterministic, then advance it past a second
  // boundary: only the footer row may be repainted, in place. Live rows embed
  // an elapsed mm:ss, so the snapshot has no live entries to keep the body
  // stable across the clock advance.
  const RealDate = Date;
  let now = RealDate.parse("2026-07-10T10:00:00.000Z");
  class FakeDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  globalThis.Date = FakeDate;
  try {
    const { screen, handle } = setup({ snapshot: () => structuredSnapshot(0), rows: 24, columns: 100 });
    const paints = screen.painted.length;
    const footerRow = screen.painted.at(-1).split("\n").length;

    now += 2000; // cross a seconds boundary: only the footer clock changes
    handle.tick();
    assert.equal(screen.painted.length, paints, "body not repainted");
    assert.equal(screen.linePaints.length, 1, "footer repainted in place");
    const [row, text] = screen.linePaints[0];
    assert.equal(row, footerRow, "footer row is the last painted row");
    assert.match(text, /refreshed \d\d:\d\d:02/);

    handle.tick(); // same second again: nothing repaints at all
    assert.equal(screen.painted.length, paints);
    assert.equal(screen.linePaints.length, 1);

    handle.shutdown(0);
  } finally {
    globalThis.Date = RealDate;
  }
});

test("writes under checkpoints/ and inflight/ trigger a repaint", async () => {
  // A non-recursive fs.watch on orchDir alone misses these subdirectories, so
  // the loop watches them too. Uses real fs plus the watcher's 100ms debounce;
  // the poll interval is disabled so only the watcher can cause a repaint.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-loop-watch-"));
  fs.mkdirSync(path.join(dir, "checkpoints"));
  fs.mkdirSync(path.join(dir, "inflight"));
  let text = "before";
  const screen = makeScreen();
  const handle = run(dir, {
    screen,
    input: makeInput(),
    out: makeOut(80, 24),
    stdin: {},
    exit: () => {},
    refreshMs: 1_000_000,
    render: () => text,
  });
  try {
    text = "after checkpoint";
    fs.writeFileSync(path.join(dir, "checkpoints", "cp.json"), "{}");
    await new Promise((r) => setTimeout(r, 400));
    assert.match(screen.painted.at(-1), /after checkpoint/, "checkpoints/ write repaints");

    text = "after inflight";
    fs.writeFileSync(path.join(dir, "inflight", "inf.json"), "{}");
    await new Promise((r) => setTimeout(r, 400));
    assert.match(screen.painted.at(-1), /after inflight/, "inflight/ write repaints");
  } finally {
    handle.shutdown(0);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
