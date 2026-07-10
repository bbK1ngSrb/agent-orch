import { test } from "node:test";
import assert from "node:assert/strict";
import { enter, leave, paintFrame, registerRestore } from "../../src/tui/screen.js";

function fakeOut() {
  const writes = [];
  return {
    writes,
    write(s) {
      writes.push(s);
    },
  };
}

test("enter switches to alt-screen and hides the cursor", () => {
  const out = fakeOut();
  enter(out);
  assert.deepEqual(out.writes, ["\x1b[?1049h", "\x1b[?25l"]);
});

test("leave shows the cursor before leaving alt-screen", () => {
  const out = fakeOut();
  leave(out);
  assert.deepEqual(out.writes, ["\x1b[?25h", "\x1b[?1049l"]);
});

test("paintFrame homes cursor, erases each line, and returns line count", () => {
  const out = fakeOut();
  const count = paintFrame(out, "one\ntwo", 2);
  assert.equal(count, 2);
  assert.deepEqual(out.writes, [
    "\x1b[H",
    "one",
    "\x1b[K",
    "\n",
    "two",
    "\x1b[K",
  ]);
});

test("paintFrame clears the tail only when the frame shrinks", () => {
  const sameOrLarger = fakeOut();
  assert.equal(paintFrame(sameOrLarger, "one\ntwo\nthree", 2), 3);
  assert.equal(sameOrLarger.writes.includes("\x1b[J"), false);

  const smaller = fakeOut();
  assert.equal(paintFrame(smaller, "one", 3), 1);
  assert.equal(smaller.writes.at(-1), "\x1b[J");
});

test("registerRestore restores synchronously at most once and unregisters idempotently", () => {
  const out = fakeOut();
  const unregister = registerRestore(out);
  process.emit("exit");
  process.emit("exit");
  assert.deepEqual(out.writes, ["\x1b[?25h", "\x1b[?1049l"]);
  unregister();
  unregister();

  const removed = fakeOut();
  const unregisterRemoved = registerRestore(removed);
  unregisterRemoved();
  process.emit("exit");
  assert.deepEqual(removed.writes, []);
});
