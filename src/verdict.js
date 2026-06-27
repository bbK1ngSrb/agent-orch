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
  // The prompt asks reviewers to put the reason AFTER the token, but models
  // routinely conclude WITH the token (reasoning first, verdict last). Prefer
  // text after the token; fall back to the text before it so a reason-before-
  // verdict response isn't silently discarded as "(no reason given)".
  const after = raw.slice(last.index + last[0].length).trim();
  const before = raw.slice(0, last.index).trim();
  const reason = after || before || "(no reason given)";
  return { decision, reason, raw };
}
