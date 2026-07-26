// Parse AGREE/DISAGREE from reviewer output. Prefer the last line-leading token
// (the review prompt asks for the verdict as the first word of a line) so prose
// mentions of the vocabulary later in analysis cannot flip a real speech-act.
// Fall back to the last standalone word-boundary token when no line-leading
// match exists (models that bury the verdict mid-sentence). `\bAGREE\b` does
// not match inside "DISAGREE", so the two never collide.
//
// `anchored` reports WHICH rule matched, so callers can decide how much to trust
// the result. A word-boundary-only match is weak evidence: an adapter that echoes
// the review prompt into its transcript before dying reproduces the verdict
// vocabulary from prompts/review.md verbatim, and the fallback then reads the
// instruction bullet as the reviewer's own speech-act. Line-anchored matches are
// not reachable that way (the prompt's tokens sit mid-bullet, behind "- `").
export function parseVerdict(text) {
  const raw = String(text ?? "");
  // Line-leading: optional indent, then AGREE|DISAGREE as the first word.
  const lineAnchored = [...raw.matchAll(/^[ \t]*(AGREE|DISAGREE)\b/gim)];
  const anchored = lineAnchored.length > 0;
  const matches = anchored
    ? lineAnchored
    : [...raw.matchAll(/\b(AGREE|DISAGREE)\b/gi)];
  if (matches.length === 0) {
    return { decision: "DISAGREE", reason: "unparseable verdict", raw, anchored: false };
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
  return { decision, reason, raw, anchored };
}
