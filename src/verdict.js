// Parse the last standalone AGREE/DISAGREE token. `\bAGREE\b` does not match
// inside "DISAGREE" (no word boundary after the 'S'), so the two never collide.
export function parseVerdict(text) {
  const raw = String(text ?? "");
  const matches = [...raw.matchAll(/\b(AGREE|DISAGREE)\b/gi)];
  if (matches.length === 0) {
    return { decision: "DISAGREE", reason: "unparseable verdict", raw };
  }
  const last = matches[matches.length - 1];
  const decision = last[1].toUpperCase();
  const reason = raw.slice(last.index + last[0].length).trim() || "(no reason given)";
  return { decision, reason, raw };
}
