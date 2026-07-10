// Pure history-list filter. Narrows rows to those whose branch, verdict
// (status), or sid contains the query as a case-insensitive substring. An
// empty/whitespace query matches everything, so clearing the query restores
// the full list. No TTY, no state — the loop owns the query string.
export function filterHistory(rows = [], query = "") {
  if (!Array.isArray(rows)) return [];
  const q = String(query).trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) =>
    [r?.branch, r?.verdict, r?.sid]
      .some((v) => String(v ?? "").toLowerCase().includes(q)),
  );
}
