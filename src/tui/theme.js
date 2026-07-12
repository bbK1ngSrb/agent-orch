// Shared terminal color/box-drawing helpers, reused by cli.js (banner,
// merged-summary), notify.js (phase stream, escalation brief), and
// dashboard.js. Hand-rolled ANSI (no dependency) — see
// docs/superpowers/specs/2026-07-06-terminal-reskin-design.md for why.

// Some glyphs render 2 columns wide in a terminal (emoji, box-drawing
// pictographs, CJK/Hangul ideographs, fullwidth forms) while `.length` counts
// them as 1, which would misalign box borders. ANSI color codes are zero-width
// and stripped first.
const WIDE_GLYPH = /[\u{1100}-\u{11ff}\u{2e80}-\u{9fff}\u{ac00}-\u{d7a3}\u{ff00}-\u{ffef}⌚-⏿☀-➿\u{1f000}-\u{1faff}]/u;

export function visWidth(s) {
  const plain = s.replace(/\x1b\[[0-9;]*m/g, "");
  let w = 0;
  for (const ch of plain) w += WIDE_GLYPH.test(ch) ? 2 : 1;
  return w;
}

// ANSI palette (256-color). orch brand orange ≈ #ff8700 (208). ok/fail/warn
// approximate the mockup's green/red/amber; 8-color terminals degrade to the
// nearest base color via the 256→16 map, so it stays legible without truecolor.
export const C = {
  border: "38;5;130", title: "1;38;5;208", label: "2",
  agents: "38;5;214", author: "1;38;5;208", review: "38;5;179", flag: "38;5;220",
  ok: "38;5;71", fail: "38;5;167", warn: "38;5;221", muted: "38;5;243",
};

export const VERDICT_SYMBOL = { merged: "✓", pr: "!", escalated: "✗", "pr-fallback": "▲" };
export const STAGE_SYMBOL = { live: "●", authoring: "●", review: "●", test: "●" };

// paint() no-ops when color is off and always resets the span so color
// never bleeds into the box border.
export function paint(on, code, s) {
  return on && code && s ? `\x1b[${code}m${s}\x1b[0m` : s;
}

export function colorEnabled(stream) {
  return Boolean(stream && stream.isTTY) && process.env.NO_COLOR == null;
}

// Human-facing timestamp: Date or ISO string → "yyyy-mm-dd HH:mm" (UTC, to the
// minute). Only strings a person reads route through here; machine-facing
// timestamps (runs.jsonl, checkpoints, inflight) stay raw ISO. UTC so the
// displayed minute matches the stored `Z` value and tests stay timezone-free.
// Unparseable input passes through unchanged rather than showing "Invalid Date".
export function formatTimestamp(dateOrIso) {
  if (dateOrIso == null || dateOrIso === "") return "";
  const d = dateOrIso instanceof Date ? dateOrIso : new Date(dateOrIso);
  return Number.isNaN(d.getTime())
    ? String(dateOrIso)
    : d.toISOString().slice(0, 16).replace("T", " ");
}

// Truncate plain (ANSI-free) text to `width` display columns, ellipsis last.
// A non-positive width has no room for even the ellipsis glyph itself.
export function truncate(plain, width) {
  if (width <= 0) return "";
  let out = "", w = 0;
  for (const ch of plain) {
    const cw = WIDE_GLYPH.test(ch) ? 2 : 1;
    if (w + cw > width - 1) break;
    out += ch; w += cw;
  }
  return out + "…";
}

// Render one bordered row from colored segments [{code,text}], padded to
// `inner` display columns by visWidth (not .length). Overflow is truncated
// on the plain text with an ellipsis; that rare case drops color rather
// than miscount widths.
export function row(segs, inner, color) {
  const plain = segs.map((s) => s.text).join("");
  if (visWidth(plain) > inner) {
    // Strip ANSI first: history rows carry pre-painted verdict codes inside
    // s.text, and truncate() counts escape bytes as columns otherwise (misaligns
    // the right border). Overflow drops color — same tradeoff as table()'s clamp.
    const out = truncate(plain.replace(/\x1b\[[0-9;]*m/g, ""), inner);
    return `${paint(color, C.border, "│")} ${out}${" ".repeat(inner - visWidth(out))} ${paint(color, C.border, "│")}`;
  }
  const body = segs.map((s) => paint(color, s.code, s.text)).join("");
  const pad = " ".repeat(inner - visWidth(plain));
  return `${paint(color, C.border, "│")} ${body}${pad} ${paint(color, C.border, "│")}`;
}

// Full bordered box: top border with a centered title, one row per entry in
// rowsSegs, bottom border. Responsive to `opts.columns` (terminal width) but
// clamped between minInner and maxInner.
export function box(title, rowsSegs, opts = {}) {
  const { color = false, columns, minInner = 40, maxInner = 96 } = opts;
  const longest = Math.max(0, ...rowsSegs.map((segs) => visWidth(segs.map((s) => s.text).join(""))));
  const avail = Number.isFinite(columns) ? columns : 76;
  const inner = Math.max(Math.min(longest, maxInner), Math.min(maxInner, Math.max(minInner, avail - 4)));
  const dashes = inner + 2 - visWidth(title);
  const left = Math.max(0, Math.floor(dashes / 2)), right = Math.max(0, dashes - left);
  const top = paint(color, C.border, `╭${"─".repeat(left)}`) +
    paint(color, C.title, title) +
    paint(color, C.border, `${"─".repeat(right)}╮`);
  const bottom = paint(color, C.border, `╰${"─".repeat(inner + 2)}╯`);
  return [top, ...rowsSegs.map((segs) => row(segs, inner, color)), bottom].join("\n");
}

// Column-aligned, unbordered table. `rows` cells are colored as plain text
// by the caller before being passed in (this helper only handles alignment)
// EXCEPT verdict-shaped cells, which callers pass pre-painted — table()
// pads by visWidth so embedded ANSI doesn't break column math.
// When `opts.columns` (terminal width) is given, each rendered line is
// trimmed of trailing padding and clamped to min(maxInner, columns) — unlike
// box() there is no minimum floor, so the table never exceeds the terminal
// even below 40 columns; overflow is truncated on the plain text with an
// ellipsis, same tradeoff as row(). With `columns` undefined, output is
// unchanged.
export function table(headers, rows, opts = {}) {
  const { columns, maxInner = 96 } = opts;
  const cols = headers.length;
  const widths = Array.from({ length: cols }, (_, i) =>
    Math.max(visWidth(headers[i]), ...rows.map((r) => visWidth(r[i] ?? ""))));
  const line = (cells) => cells.map((c, i) =>
    c + " ".repeat(widths[i] - visWidth(c) + (i < cols - 1 ? 2 : 0))).join("");
  const limit = Number.isFinite(columns) ? Math.min(maxInner, columns) : null;
  const clamp = (l) => {
    if (limit == null) return l;
    const t = l.replace(/ +$/, "");
    return visWidth(t) <= limit ? t : truncate(t.replace(/\x1b\[[0-9;]*m/g, ""), limit);
  };
  return [line(headers), ...rows.map(line)].map(clamp).join("\n");
}
