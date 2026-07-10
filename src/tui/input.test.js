import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { start, normalizeKey } from "./input.js";

// Fake stdin: an EventEmitter with the tty surface start() touches.
function fakeStdin() {
  const s = new EventEmitter();
  s.isTTY = true;
  s.rawMode = null;
  s.resumed = false;
  s.paused = false;
  s.setRawMode = (v) => {
    s.rawMode = v;
  };
  s.resume = () => {
    s.resumed = true;
  };
  s.pause = () => {
    s.paused = true;
  };
  return s;
}

test("normalizeKey maps arrows, vim keys, and controls", () => {
  assert.deepEqual(normalizeKey(null, { name: "down" }), { type: "down" });
  assert.deepEqual(normalizeKey(null, { name: "up" }), { type: "up" });
  assert.deepEqual(normalizeKey(null, { name: "left" }), { type: "left" });
  assert.deepEqual(normalizeKey(null, { name: "right" }), { type: "right" });
  assert.deepEqual(normalizeKey("j", {}), { type: "down" });
  assert.deepEqual(normalizeKey("k", {}), { type: "up" });
  assert.deepEqual(normalizeKey("g", {}), { type: "top" });
  assert.deepEqual(normalizeKey("G", {}), { type: "bottom" });
  assert.deepEqual(normalizeKey("r", {}), { type: "refresh" });
  assert.deepEqual(normalizeKey("q", {}), { type: "quit" });
  assert.deepEqual(normalizeKey("2", {}), { type: "panel", index: 1 });
  assert.deepEqual(normalizeKey(null, { name: "tab" }), { type: "tab" });
  assert.deepEqual(normalizeKey(null, { name: "tab", shift: true }), { type: "shift-tab" });
  assert.deepEqual(normalizeKey(null, { name: "return" }), { type: "enter" });
  assert.deepEqual(normalizeKey(null, { name: "escape" }), { type: "esc" });
  assert.deepEqual(normalizeKey("x", {}), { type: "char", value: "x" });
});

test("Ctrl-C normalizes to quit under raw mode", () => {
  assert.deepEqual(normalizeKey(null, { ctrl: true, name: "c" }), {
    type: "quit",
    ctrlC: true,
  });
});

test("start streams normalized keypresses and enters raw mode", () => {
  const stdin = fakeStdin();
  const events = [];
  const stop = start(stdin, (e) => events.push(e));

  assert.equal(stdin.rawMode, true);
  assert.equal(stdin.resumed, true);

  stdin.emit("keypress", "j", { name: "j" });
  stdin.emit("keypress", null, { name: "up" });
  stdin.emit("keypress", "q", { name: "q" });
  stdin.emit("keypress", null, { ctrl: true, name: "c" });

  assert.deepEqual(events, [
    { type: "down" },
    { type: "up" },
    { type: "quit" },
    { type: "quit", ctrlC: true },
  ]);

  stop();
  assert.equal(stdin.rawMode, false);
  assert.equal(stdin.paused, true);

  // Listener removed: further keypresses are ignored.
  stdin.emit("keypress", "j", { name: "j" });
  assert.equal(events.length, 4);
});

test("start is a no-op on a non-TTY stdin", () => {
  const stdin = fakeStdin();
  stdin.isTTY = false;
  const events = [];
  const stop = start(stdin, (e) => events.push(e));
  stdin.emit("keypress", "j", { name: "j" });
  assert.equal(stdin.rawMode, null);
  assert.equal(events.length, 0);
  stop();
});
