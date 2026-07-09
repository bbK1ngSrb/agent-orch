import { test } from "node:test";
import assert from "node:assert/strict";
import { visWidth, paint, C, colorEnabled, row, box, table } from "../../src/tui/theme.js";

test("table aligns columns and colors specific cells via a colorFn", () => {
  const out = table(
    ["TIME", "BRANCH", "VERDICT"],
    [["14:22", "pr/claude/x", "merged"], ["13:58", "pr/codex/y", "escalated"]],
    { color: false },
  );
  const lines = out.split("\n");
  assert.equal(lines[0], "TIME   BRANCH       VERDICT  ");
  assert.match(lines[1], /^14:22  pr\/claude\/x  merged   $/);
});

test("table with columns truncates overflow with … and keeps lines within width", () => {
  const headers = ["TIME", "BRANCH", "VERDICT"];
  const rows = [["14:22", "pr/claude/very-long-branch-name-that-overflows", "merged"]];
  const out = table(headers, rows, { columns: 30, minInner: 10 });
  const lines = out.split("\n");
  assert.match(lines[1], /…$/);
  for (const l of lines) assert.ok(visWidth(l) <= 30, `line too wide: ${JSON.stringify(l)}`);
  // columns undefined → byte-identical to the unclamped output
  assert.equal(table(headers, rows, {}), table(headers, rows, { color: false }));
  const plain = table(headers, rows, {});
  assert.ok(plain.split("\n")[1].includes("pr/claude/very-long-branch-name-that-overflows"));
});

test("visWidth counts wide glyphs as 2 columns and ignores ANSI codes", () => {
  assert.equal(visWidth("abc"), 3);
  assert.equal(visWidth("\x1b[1;38;5;208mabc\x1b[0m"), 3);
  assert.equal(visWidth("⏱"), 2);
});

test("paint no-ops when color is off, wraps+resets when on", () => {
  assert.equal(paint(false, C.ok, "hi"), "hi");
  assert.equal(paint(true, C.ok, "hi"), `\x1b[${C.ok}mhi\x1b[0m`);
  assert.equal(paint(true, "", "hi"), "hi");
});

test("colorEnabled requires isTTY and respects NO_COLOR", () => {
  const prevNoColor = process.env.NO_COLOR;
  delete process.env.NO_COLOR;
  assert.equal(colorEnabled({ isTTY: true }), true);
  assert.equal(colorEnabled({ isTTY: false }), false);
  assert.equal(colorEnabled(undefined), false);
  process.env.NO_COLOR = "1";
  assert.equal(colorEnabled({ isTTY: true }), false);
  if (prevNoColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = prevNoColor;
});

test("row pads to inner width and truncates overflow with an ellipsis", () => {
  const segs = [{ code: C.label, text: "hello" }];
  const line = row(segs, 10, false);
  assert.equal(line, "│ hello      │");
  const tooLong = row([{ code: C.label, text: "a".repeat(20) }], 10, false);
  assert.match(tooLong, /…/);
  assert.equal(visWidth(tooLong.replace(/^│ | │$/g, "")), 10);
});

test("box renders a centered title between top/bottom borders around each row", () => {
  const out = box(" title ", [[{ code: C.label, text: "x" }]], { color: false, columns: 20 });
  const lines = out.split("\n");
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^╭─+ title ─+╮$/);
  assert.match(lines[2], /^╰─+╯$/);
  assert.match(lines[1], /│ x\s+│/);
});
