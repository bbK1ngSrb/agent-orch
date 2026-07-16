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

// Mirror DEFAULTS.docs.paths (*.md, docs/**, **/*.md): markdown/docs prose cannot
// execute a secret read at runtime, so scanning it for path substrings only
// false-positives on legitimate documentation.
function isDocsPath(file) {
  if (!file) return false;
  if (file.endsWith(".md")) return true;
  if (file === "docs" || file.startsWith("docs/")) return true;
  return false;
}

// Yield added content lines paired with the current +++ b/<path> file context.
// Docs files are skipped — only code (and unknown-path) lines are scannable. The
// file travels with each line so a finding can say WHERE it came from — that is
// what lets the escalation note tell a test fixture apart from a real code path.
function addedCodeLines(diffText) {
  const out = [];
  let file = null;
  for (const l of String(diffText).split("\n")) {
    if (l.startsWith("+++ ")) {
      file = l.startsWith("+++ b/") ? l.slice(6) : null;
      continue;
    }
    if (l.startsWith("+") && !l.startsWith("+++") && !isDocsPath(file)) {
      out.push({ file, raw: l });
    }
  }
  return out;
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
  const entries = addedCodeLines(diffText);
  const regexVars = regexLiteralVars(entries.map((e) => e.raw));
  for (const { file, raw } of entries) {
    for (const { rule, re } of SECURITY_RULES) {
      if (re.test(raw)) findings.push({ rule, line: raw.slice(1).trim(), file });
    }
    if (isSubprocessCall(raw, regexVars)) {
      findings.push({ rule: "subprocess", line: raw.slice(1).trim(), file });
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

// A path whose secret-ish text is almost certainly a fixture rather than a live
// read: files under a test dir, or named *.test/*.spec. Docs are dropped before
// the scan even runs, so by the time a finding exists the only benign source
// left to recognise is a test. An unknown path (no `+++ b/` header) is treated
// as NOT a fixture, so the recommendation errs toward "look at this".
function isTestFile(file) {
  if (!file) return false;
  return /(^|\/)tests?\//.test(file) || /\.(test|spec)\.[cm]?jsx?$/.test(file);
}

// Compute the recommended path forward from WHERE the findings live. This is the
// verdict a human would otherwise have to ask for: all-fixtures → almost surely a
// false positive, safe to merge by hand; anything in a real code path → look
// before merging, it might be a genuine read.
function recommend(findings, mergeCmd) {
  const suspects = [...new Set(findings.map((f) => f.file).filter((f) => !isTestFile(f)))];
  const doMerge = mergeCmd ? `\`${mergeCmd}\`` : "merge by hand";
  if (suspects.length === 0) {
    const fixtures = [...new Set(findings.map((f) => f.file))].map((f) => `\`${f}\``).join(", ");
    return `**Recommendation:** likely a **false positive** — every flagged line lives in a test `
      + `file (${fixtures}), whose fixtures must contain these patterns to exercise the scan. `
      + `Skim the diff to confirm, then ${doMerge}.`;
  }
  const where = suspects.map((f) => `\`${f || "an unknown file"}\``).join(", ");
  return `**Recommendation:** **inspect before merging** — ${where} `
    + `${suspects.length === 1 ? "is a real code path" : "are real code paths"}, not a test fixture, so `
    + `the scan may have caught a genuine secret-read / network / subprocess. Do **not** merge until each `
    + `flagged line there is confirmed benign.`;
}

// Render a scanDiff() DISAGREE for humans. Returns:
//   summary — one line for run logs and the CLI status line (kept short),
//   detail  — an educational markdown note for the escalation a person reads.
// The raw findings list repeats and interleaves rules; here we DEDUPE identical
// lines, GROUP by rule, and CLIP long snippets so the note stays scannable. The
// detail explains *why* the scan can fire on lines that aren't dangerous (it
// matches added text, so a fixture that merely mentions a pattern trips it) and
// then gives a COMPUTED recommendation — a bare "decision needed" is useless
// friction, so the note names the likely verdict and the concrete next step.
export function formatSecurityFindings(findings, { maxPerRule = 5, maxLen = 100, mergeCmd = null } = {}) {
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
    recommend(findings, mergeCmd),
  ].join("\n");

  return { summary, detail };
}
