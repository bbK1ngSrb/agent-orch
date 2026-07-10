import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { run } from "../../src/tui/loop.js";

// fs.watch on a nonexistent path throws synchronously → the loop disables the
// watcher and relies on the interval, so no real filesystem watch is created.
const ORCH_DIR = "/no/such/orch-loop-test";

function makeScreen() {
  const s = {
    painted: [],
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
      return String(text).split("\n").length;
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

function makeOut(columns = 80, rows = 24) {
  const o = new EventEmitter();
  o.columns = columns;
  o.rows = rows;
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
  const out = makeOut(opts.columns, opts.rows);
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
  });
  return { screen, input, out, exits, handle };
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
  assert.match(frame, /q quit · ↑↓ scroll · r refresh · refreshed /);

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
