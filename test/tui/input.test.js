import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { start } from "../../src/tui/input.js";

function fakeStdin({ isTTY = true } = {}) {
  const stdin = new EventEmitter();
  stdin.isTTY = isTTY;
  stdin.rawModeCalls = [];
  stdin.setRawMode = (v) => stdin.rawModeCalls.push(v);
  stdin.resumed = false;
  stdin.paused = false;
  stdin.resume = () => {
    stdin.resumed = true;
  };
  stdin.pause = () => {
    stdin.paused = true;
  };
  return stdin;
}

function collect(stdin) {
  const events = [];
  const stop = start(stdin, (e) => events.push(e));
  return { events, stop };
}

test("start gates on isTTY", () => {
  const stdin = fakeStdin({ isTTY: false });
  const { events, stop } = collect(stdin);
  stdin.emit("keypress", "j", { name: "j" });
  assert.deepEqual(events, []);
  assert.deepEqual(stdin.rawModeCalls, []);
  stop();
});

test("start enables raw mode and resumes the stream", () => {
  const stdin = fakeStdin();
  collect(stdin);
  assert.deepEqual(stdin.rawModeCalls, [true]);
  assert.equal(stdin.resumed, true);
});

test("normalizes vim keys and arrows", () => {
  const stdin = fakeStdin();
  const { events } = collect(stdin);
  stdin.emit("keypress", "j", { name: "j" });
  stdin.emit("keypress", undefined, { name: "down" });
  stdin.emit("keypress", "k", { name: "k" });
  stdin.emit("keypress", undefined, { name: "up" });
  stdin.emit("keypress", "g", { name: "g" });
  stdin.emit("keypress", "G", { name: "g", shift: true });
  assert.deepEqual(
    events.map((e) => e.type),
    ["down", "down", "up", "up", "top", "bottom"],
  );
});

test("normalizes tab, shift-tab, enter, esc, refresh, quit", () => {
  const stdin = fakeStdin();
  const { events } = collect(stdin);
  stdin.emit("keypress", "\t", { name: "tab", shift: false });
  stdin.emit("keypress", undefined, { name: "tab", shift: true });
  stdin.emit("keypress", "\r", { name: "return" });
  stdin.emit("keypress", undefined, { name: "escape" });
  stdin.emit("keypress", "r", { name: "r" });
  stdin.emit("keypress", "q", { name: "q" });
  assert.deepEqual(
    events.map((e) => e.type),
    ["tab", "shift-tab", "enter", "esc", "refresh", "quit"],
  );
});

test("Ctrl-C normalizes to quit with ctrlC flag", () => {
  const stdin = fakeStdin();
  const { events } = collect(stdin);
  stdin.emit("keypress", "\x03", { name: "c", ctrl: true });
  assert.deepEqual(events, [{ type: "quit", ctrlC: true }]);
});

test("unmapped printable keys become char events", () => {
  const stdin = fakeStdin();
  const { events } = collect(stdin);
  stdin.emit("keypress", "x", { name: "x" });
  assert.deepEqual(events, [{ type: "char", value: "x" }]);
});

test("stop restores cooked mode, pauses, and removes the listener idempotently", () => {
  const stdin = fakeStdin();
  const { events, stop } = collect(stdin);
  stop();
  stop();
  assert.deepEqual(stdin.rawModeCalls, [true, false]);
  assert.equal(stdin.paused, true);
  assert.equal(stdin.listenerCount("keypress"), 0);
  stdin.emit("keypress", "j", { name: "j" });
  assert.deepEqual(events, []);
});
