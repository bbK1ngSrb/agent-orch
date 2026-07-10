import { test } from "node:test";
import assert from "node:assert/strict";
import { reduceHistorySelection } from "../../src/tui/selection.js";

test("history selection reducer moves, opens detail, and returns to the same row", () => {
  let state = reduceHistorySelection({}, {}, 3);
  assert.deepEqual(state, { selectedIndex: 0, detailOpen: false });

  state = reduceHistorySelection(state, { type: "down" }, 3);
  assert.deepEqual(state, { selectedIndex: 1, detailOpen: false });

  state = reduceHistorySelection(state, { type: "down" }, 3);
  assert.deepEqual(state, { selectedIndex: 2, detailOpen: false });

  state = reduceHistorySelection(state, { type: "down" }, 3);
  assert.deepEqual(state, { selectedIndex: 2, detailOpen: false });

  state = reduceHistorySelection(state, { type: "enter" }, 3);
  assert.deepEqual(state, { selectedIndex: 2, detailOpen: true });

  state = reduceHistorySelection(state, { type: "up" }, 3);
  assert.deepEqual(state, { selectedIndex: 1, detailOpen: true });

  state = reduceHistorySelection(state, { type: "esc" }, 3);
  assert.deepEqual(state, { selectedIndex: 1, detailOpen: false });
});

test("history selection reducer clamps when rows shrink", () => {
  const state = reduceHistorySelection({ selectedIndex: 5, detailOpen: true }, { type: "clamp" }, 2);
  assert.deepEqual(state, { selectedIndex: 1, detailOpen: true });

  const empty = reduceHistorySelection(state, { type: "enter" }, 0);
  assert.deepEqual(empty, { selectedIndex: 0, detailOpen: false });
});
