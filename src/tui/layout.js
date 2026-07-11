const MIN_STRUCTURED_COLUMNS = 60;
const FIXED_ROWS = 3; // header, status strip, footer
const PANEL_ORDER = ["live", "interrupted", "history"];

function clampInt(n, min, max) {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function emptyInterruptedHeight(count) {
  return count > 0 ? 3 : 1;
}

function distribute(extra, panels, sizes, caps) {
  let remaining = extra;
  while (remaining > 0) {
    let changed = false;
    for (const name of panels) {
      if (remaining <= 0) break;
      if (caps[name] <= 0) continue;
      sizes[name]++;
      caps[name]--;
      remaining--;
      changed = true;
    }
    if (!changed) break;
  }
}

export function computeLayout({ columns, rows, liveCount = 0, interruptedCount = 0, historyCount = 0, focus = "live" } = {}) {
  const width = clampInt(columns, 0, 9999);
  const height = clampInt(rows, 0, 9999);
  const activeFocus = PANEL_ORDER.includes(focus) ? focus : "live";
  const fallback = width < MIN_STRUCTURED_COLUMNS;

  const layout = {
    fallback,
    columns: width,
    rows: height,
    minColumns: MIN_STRUCTURED_COLUMNS,
    order: PANEL_ORDER.slice(),
    header: { start: 0, end: Math.min(1, height), height: height > 0 ? 1 : 0 },
    status: { start: Math.min(1, height), end: Math.min(2, height), height: height > 1 ? 1 : 0 },
    footer: { start: Math.max(0, height - 1), end: height, height: height > 0 ? 1 : 0 },
    panels: {},
  };
  if (fallback) return layout;

  const elastic = Math.max(0, height - FIXED_ROWS);
  const counts = { live: liveCount, interrupted: interruptedCount, history: historyCount };
  const min = {
    // An empty LIVE panel keeps its three-row "(none)" block rather than
    // collapsing: LIVE is the primary, default-focused panel, and an explicit
    // "(none)" tells the operator the system is idle — a collapsed panel is
    // indistinguishable from a rendering bug. Only INTERRUPTED (an
    // exception-state panel) collapses when empty.
    live: 3,
    interrupted: emptyInterruptedHeight(interruptedCount),
    history: 3,
  };
  const sizes = { ...min };
  let extra = Math.max(0, elastic - Object.values(sizes).reduce((a, b) => a + b, 0));

  const focusFloor = Math.min(elastic, Math.max(sizes[activeFocus], Math.floor(elastic * 0.6)));
  const focusNeed = Math.max(0, focusFloor - sizes[activeFocus]);
  const giveFocus = Math.min(extra, focusNeed);
  sizes[activeFocus] += giveFocus;
  extra -= giveFocus;

  distribute(extra, PANEL_ORDER, sizes, {
    live: Math.max(0, liveCount + 2 - sizes.live),
    interrupted: interruptedCount > 0 ? Math.max(0, interruptedCount + 2 - sizes.interrupted) : 0,
    history: Math.max(0, 8 - sizes.history),
  });
  extra = Math.max(0, elastic - Object.values(sizes).reduce((a, b) => a + b, 0));
  sizes[activeFocus] += extra;

  let start = 2;
  for (const name of PANEL_ORDER) {
    const size = Math.max(0, Math.min(sizes[name], height - 1 - start));
    const bodyRows = Math.max(0, size - 2);
    const count = counts[name] || 0;
    layout.panels[name] = {
      start,
      end: start + size,
      height: size,
      bodyRows,
      focused: name === activeFocus,
      collapsed: name === "interrupted" && interruptedCount === 0,
      peek: name !== activeFocus && count > bodyRows,
      hint: name !== activeFocus && count > bodyRows ? count - bodyRows : 0,
    };
    start += size;
  }
  return layout;
}
