export function slugify(text) {
  // Slice to the length cap BEFORE stripping hyphens: stripping first and then
  // slicing can cut off mid-run, landing the 40-char boundary right on a hyphen
  // that the earlier strip never saw (it wasn't trailing yet). Slicing first
  // means the strip runs on the final string, so it always catches a hyphen
  // the cut exposed at the new edge.
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 40)
    .replace(/^-+|-+$/g, "") || "task";
}
