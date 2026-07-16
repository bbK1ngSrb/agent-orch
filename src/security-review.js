// §3e: independent security gate. Static scan of ADDED diff lines for the
// classes of behavior that exfiltrate or self-modify, regardless of whether the
// change satisfies the (attacker-influenced) acceptance_criteria. The LLM
// reviewer can be fooled (Residual #3); this deterministic floor cannot be
// talked out of a DISAGREE.
export const SECURITY_RULES = [
  { rule: "env-read", re: /process\.env|import\.meta\.env|os\.environ|\$\{?GITHUB_TOKEN/ },
  { rule: "secret-read", re: /\.orch\/|id_rsa|\.ssh\/|secrets?\.|\.pem\b|PRIVATE KEY/i },
  { rule: "network", re: /\bfetch\s*\(|node:net\b|node:dns\b|node:https?\b|require\(\s*["']https?["']\s*\)|XMLHttpRequest|\.connect\s*\(/ },
  { rule: "guardrail-touch", re: /branchProtection|CODEOWNERS|orch-pr\.yml|workflows\// },
];

const SUBPROCESS_MODULE_RE = /child_process|execSync|execFileSync|spawnSync|\bspawn\s*\(/i;
const EXEC_CALL_RE = /(?:([A-Za-z_$][\w$]*)\.)?\bexec\s*\(/gi;
// A receiver is only trusted as RegExp#exec() when *this diff* shows it assigned
// straight from a regex literal — matching on receiver name alone (e.g. "re", "regex")
// lets an attacker rename a child_process handle to slip past the filter.
const REGEX_LITERAL_ASSIGN_RE = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\/(?:[^/\\\n]|\\.)+\/[a-z]*\s*[;,)]/;

// Added lines: start with a single '+' but not the '+++' file header.
function addedLines(diffText) {
  return String(diffText)
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"));
}

function regexLiteralVars(lines) {
  const names = new Set();
  for (const line of lines) {
    const m = line.slice(1).match(REGEX_LITERAL_ASSIGN_RE);
    if (m) names.add(m[1]);
  }
  return names;
}

function isSubprocessCall(line, regexVars) {
  if (SUBPROCESS_MODULE_RE.test(line)) return true;
  EXEC_CALL_RE.lastIndex = 0;
  let m;
  while ((m = EXEC_CALL_RE.exec(line))) {
    const receiver = m[1];
    if (!receiver || !regexVars.has(receiver)) return true;
  }
  return false;
}

export function scanDiff(diffText) {
  const findings = [];
  const lines = addedLines(diffText);
  const regexVars = regexLiteralVars(lines);
  for (const line of lines) {
    for (const { rule, re } of SECURITY_RULES) {
      if (re.test(line)) findings.push({ rule, line: line.slice(1).trim() });
    }
    if (isSubprocessCall(line, regexVars)) {
      findings.push({ rule: "subprocess", line: line.slice(1).trim() });
    }
  }
  return { decision: findings.length ? "DISAGREE" : "AGREE", findings };
}

// Plain-English gloss of each rule, for the escalation note. A reader who has
// never seen the rule names should still understand what class of behavior the
// scan objected to.
const RULE_BLURB = {
  "secret-read": "reads a secret or orch's own control state (`.orch/`, `.ssh/`, `.pem`, PRIVATE KEY)",
  "env-read": "reads environment variables or a GitHub token",
  network: "opens a network connection (fetch / net / dns / http)",
  subprocess: "spawns a subprocess (child_process / exec / spawn)",
  "guardrail-touch": "edits a guardrail file (branch protection, CODEOWNERS, workflows)",
};

// Render a scanDiff() DISAGREE for humans. Returns:
//   summary — one line for run logs and the CLI status line (kept short),
//   detail  — an educational markdown note for the escalation a person reads.
// The raw findings list repeats and interleaves rules; here we DEDUPE identical
// lines, GROUP by rule, and CLIP long snippets so the note stays scannable. The
// detail also explains *why* the scan can fire on lines that aren't dangerous:
// it matches added text, so a test fixture or a doc that merely mentions a
// pattern trips it. Naming that up front lets a reader tell a false positive
// from a real hit without re-deriving it each time.
export function formatSecurityFindings(findings, { maxPerRule = 5, maxLen = 100 } = {}) {
  const byRule = new Map(); // rule -> Set of unique offending lines (insertion-ordered)
  for (const { rule, line } of findings) {
    if (!byRule.has(rule)) byRule.set(rule, new Set());
    byRule.get(rule).add(line);
  }
  const total = [...byRule.values()].reduce((n, s) => n + s.size, 0);
  const counts = [...byRule].map(([rule, s]) => `${rule} ×${s.size}`).join(", ");
  const summary = `security scan blocked the merge — ${total} finding${total === 1 ? "" : "s"} (${counts})`;

  const clip = (s) => (s.length > maxLen ? s.slice(0, maxLen - 1) + "…" : s);
  const sections = [...byRule].map(([rule, set]) => {
    const lines = [...set];
    const shown = lines.slice(0, maxPerRule).map((l) => `    ${clip(l)}`);
    if (lines.length > maxPerRule) shown.push(`    …and ${lines.length - maxPerRule} more`);
    return `- **${rule}** — ${RULE_BLURB[rule] || "matched a risky pattern"}:\n${shown.join("\n")}`;
  });

  const detail = [
    "## Security scan blocked the merge",
    "",
    "orch runs a **deterministic security floor** over the added lines of the final diff,",
    "independent of the LLM reviewer. Unlike the reviewer it cannot be talked out of a",
    "DISAGREE — it is the last gate before merge. It matches *text*, so it flags any added",
    "line containing a risky pattern whether that line is real code or a string that merely",
    "*mentions* the pattern (a test fixture, a documentation example). It fails **closed**:",
    "it would rather over-block than let something slip through.",
    "",
    "**What tripped it:**",
    "",
    ...sections,
    "",
    "**How to proceed:**",
    "",
    "- If a flagged line is real code that reads a secret, opens the network, or spawns a",
    "  subprocess, the scan did its job — change the code.",
    "- If every flagged line is a **test fixture or documentation** that only contains the",
    "  pattern as text (common when editing the security tests, or docs about `.orch/`), it",
    "  is a false positive. Read the diff to confirm, then merge by hand.",
  ].join("\n");

  return { summary, detail };
}
