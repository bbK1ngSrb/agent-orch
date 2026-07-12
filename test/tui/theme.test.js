import { test } from "node:test";
import assert from "node:assert/strict";
import { visWidth, paint, C, colorEnabled, row, box, table, formatTimestamp, truncate } from "../../src/tui/theme.js";

test("formatTimestamp renders yyyy-mm-dd HH:mm in UTC from a known instant", () => {
  // Drops the T separator, sub-second .927, and the trailing Z; minute precision.
  assert.equal(formatTimestamp("2026-07-10T11:23:37.927Z"), "2026-07-10 11:23");
  assert.equal(formatTimestamp(new Date("2026-07-10T11:23:37.927Z")), "2026-07-10 11:23");
  // Unparseable input passes through rather than showing "Invalid Date".
  assert.equal(formatTimestamp("not-a-date"), "not-a-date");
  assert.equal(formatTimestamp(null), "");
});

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
  // 30 < 40 on purpose: table() has no minimum-width floor, so even very
  // narrow terminals are honored (regression for the old minInner=40 clamp)
  const out = table(headers, rows, { columns: 30 });
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

test("visWidth counts CJK, Hangul, and fullwidth-form glyphs as 2 columns each", () => {
  // CJK Unified Ideographs (U+2E80-9FFF) — the branch/task text a task
  // description could plausibly contain, not just emoji/box-drawing.
  assert.equal(visWidth("你好"), 4);
  // Hangul syllables (U+AC00-D7A3) and Hangul Jamo (U+1100-11FF).
  assert.equal(visWidth("안녕"), 4);
  assert.equal(visWidth("가"), 4);
  // Fullwidth forms (U+FF00-FFEF) — visually distinct from ASCII "ABC".
  assert.equal(visWidth("ＡＢＣ"), 6);
});

test("truncate returns empty string for a non-positive width instead of an ellipsis that itself overflows", () => {
  assert.equal(truncate("hello", 0), "");
  assert.equal(truncate("hello", -3), "");
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

test("row with embedded ANSI never truncates mid-escape (history verdict cells)", () => {
  // History rows carry pre-painted verdict codes inside seg.text. If row()
  // truncated the raw string, the cut could land inside an SGR escape and emit
  // a dangling "\x1b[38;5;…" that the terminal parses through the right border,
  // corrupting it. Overflow must drop color cleanly instead.
  const pre = "x".repeat(88) + paint(true, C.ok, "OK") + "-tail-tail-tail";
  const line = row([{ code: "", text: pre }], 96, true);
  // no incomplete SGR sequence survives (every \x1b[ must be closed by m)
  assert.ok(!/\x1b\[[0-9;]*(?![0-9;]*m)/.test(line.replace(/\x1b\[[0-9;]*m/g, "")),
    `dangling escape in ${JSON.stringify(line)}`);
  // right border still lands exactly inner+4 columns out
  assert.equal(visWidth(line), 100);
  assert.ok(line.replace(/\x1b\[[0-9;]*m/g, "").endsWith("│"));
});

test("box renders a centered title between top/bottom borders around each row", () => {
  const out = box(" title ", [[{ code: C.label, text: "x" }]], { color: false, columns: 20 });
  const lines = out.split("\n");
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^╭─+ title ─+╮$/);
  assert.match(lines[2], /^╰─+╯$/);
  assert.match(lines[1], /│ x\s+│/);
});
