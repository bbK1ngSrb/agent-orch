import { test } from "node:test";
import assert from "node:assert/strict";
import { enter, leave, paintFrame, paintLineAt, registerRestore } from "../../src/tui/screen.js";

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

test("paintFrame homes cursor and paints the whole frame in one batched write", () => {
  const out = fakeOut();
  const count = paintFrame(out, "one\ntwo", 2);
  assert.equal(count, 2);
  assert.deepEqual(out.writes, ["\x1b[Hone\x1b[K\ntwo\x1b[K"]);
});

test("paintFrame clears the tail only when the frame shrinks", () => {
  const sameOrLarger = fakeOut();
  assert.equal(paintFrame(sameOrLarger, "one\ntwo\nthree", 2), 3);
  assert.equal(sameOrLarger.writes.includes("\x1b[J"), false);
  assert.equal(sameOrLarger.writes[0].includes("\x1b[J"), false);

  const smaller = fakeOut();
  assert.equal(paintFrame(smaller, "one", 3), 1);
  assert.deepEqual(smaller.writes, ["\x1b[Hone\x1b[K\x1b[J"]);
});

test("paintLineAt repaints one row in place", () => {
  const out = fakeOut();
  paintLineAt(out, 12, "footer text");
  assert.deepEqual(out.writes, ["\x1b[12;1Hfooter text\x1b[K"]);
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
