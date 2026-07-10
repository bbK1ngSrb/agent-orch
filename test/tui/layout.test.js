import { test } from "node:test";
import assert from "node:assert/strict";
import { computeLayout } from "../../src/tui/layout.js";

for (const columns of [100, 90, 70]) {
  test(`structured layout fits ${columns} columns`, () => {
    for (const liveCount of [0, 1, 24]) {
      const layout = computeLayout({ columns, rows: 24, liveCount, interruptedCount: 2, focus: "live" });
      assert.equal(layout.fallback, false);
      assert.equal(layout.panels.live.focused, true);
      assert.ok(layout.panels.live.height >= Math.floor((24 - 3) * 0.6));
      assert.equal(layout.footer.start, 23);
      assert.equal(layout.panels.history.end, 23);
    }
  });
}

test("empty interrupted panel collapses to a title line", () => {
  const layout = computeLayout({ columns: 100, rows: 24, liveCount: 1, interruptedCount: 0, focus: "history" });
  assert.equal(layout.panels.interrupted.collapsed, true);
  assert.equal(layout.panels.interrupted.height, 1);
});

test("narrow terminals signal plain-scroll fallback", () => {
  const layout = computeLayout({ columns: 50, rows: 24, liveCount: 24, interruptedCount: 1, focus: "live" });
  assert.equal(layout.fallback, true);
  assert.equal(layout.minColumns, 60);
});

test("unfocused overflowing panels expose peek hints", () => {
  const layout = computeLayout({ columns: 90, rows: 12, liveCount: 24, interruptedCount: 0, focus: "history" });
  assert.equal(layout.panels.live.peek, true);
  assert.ok(layout.panels.live.hint > 0);
});
