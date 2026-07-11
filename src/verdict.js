// Parse AGREE/DISAGREE from reviewer output. Prefer the last line-leading token
// (the review prompt asks for the verdict as the first word of a line) so prose
// mentions of the vocabulary later in analysis cannot flip a real speech-act.
// Fall back to the last standalone word-boundary token when no line-leading
// match exists (models that bury the verdict mid-sentence). `\bAGREE\b` does
// not match inside "DISAGREE", so the two never collide.
export function parseVerdict(text) {
  const raw = String(text ?? "");
  // Line-leading: optional indent, then AGREE|DISAGREE as the first word.
  const lineAnchored = [...raw.matchAll(/^[ \t]*(AGREE|DISAGREE)\b/gim)];
  const matches =
    lineAnchored.length > 0
      ? lineAnchored
      : [...raw.matchAll(/\b(AGREE|DISAGREE)\b/gi)];
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
