// src/redact.js
// §3f: own every emitted channel. redact() is a heuristic secret scrubber
// (Residual #2 — pattern-based, raises cost, not a guarantee). publicSummary()
// is the only thing a public run posts: a fixed template of machine fields, so
// no attacker-influenced reviewer prose ever reaches a public surface.
export const SECRET_PATTERNS = [
  /gh[pousr]_[A-Za-z0-9]{36,}/g,            // GitHub PAT / OAuth / refresh
  /github_pat_[A-Za-z0-9_]{20,}/g,          // fine-grained PAT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,    // PEM private key header
  /sk-[A-Za-z0-9_-]{10,}/g,                 // generic provider key shape (incl. hyphenated sk-ant-.../sk-proj-...)
  /\bAKIA[0-9A-Z]{16}\b/g,                  // AWS access key id
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
];

export function hasSecret(text) {
  return SECRET_PATTERNS.some((re) => {
    re.lastIndex = 0;
    return re.test(String(text));
  });
}

export function redact(text) {
  let out = String(text);
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, "«redacted»");
  }
  return out;
}

export function publicSummary({ decision, green, branch, rounds }) {
  // No caller prose: every field is a constrained machine value.
  const d = decision === "AGREE" ? "AGREE" : "DISAGREE";
  return [
    `orch verdict: ${d}`,
    `tests: ${green ? "green" : "red"}`,
    `branch: ${String(branch).replace(/[^\w./-]/g, "")}`,
    `rounds: ${Number(rounds) || 0}`,
    `Full reviewer notes were sent to the maintainer's private channel.`,
  ].join("\n");
}
