import { globToRegExp } from "./scope.js";
import { DEFAULT_PROTECTED } from "./intake/allowlist.js";

// §3e: independent security gate. Static scan of the diff's CHANGED PATHS and
// ADDED lines for the classes of behavior that exfiltrate or self-modify,
// regardless of whether the change satisfies the (attacker-influenced)
// acceptance_criteria. The LLM reviewer can be fooled (Residual #3); this
// deterministic floor cannot be talked out of a DISAGREE.
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

// Git C-quotes paths containing non-ASCII or control characters in diff headers
// (`+++ "b/caf\303\251.yml"`), so unquote before the a//b/ prefix is stripped —
// a quoted guardrail path must not slip past the path-based floor.
function unquoteGitPath(s) {
  if (s.length < 2 || !s.startsWith('"') || !s.endsWith('"')) return s;
  // Octal escapes are the raw bytes of the UTF-8 path — decode them as bytes.
  const latin1 = s.slice(1, -1).replace(/\\([0-7]{3}|.)/g, (_, esc) => {
    if (/^[0-7]{3}$/.test(esc)) return String.fromCharCode(parseInt(esc, 8));
    if (esc === "n") return "\n";
    if (esc === "t") return "\t";
    return esc;
  });
  return Buffer.from(latin1, "latin1").toString("utf8");
}

// Parse a `--- a/<path>` / `+++ b/<path>` header into a repo-relative path
// (null for /dev/null or non-header lines). Reading BOTH headers matters: a
// deleted guardrail file has no added lines to scan — only its `--- a/` header
// carries the path.
function headerPath(l) {
  if (!l.startsWith("--- ") && !l.startsWith("+++ ")) return null;
  const p = unquoteGitPath(l.slice(4).trim());
  if (p === "/dev/null") return null;
  // Only trust the standard a//b/ prefixes; anything else is an unknown path,
  // which content scanning treats as scannable (fail closed).
  const m = p.match(/^[ab]\/([\s\S]*)$/);
  return m ? m[1] : null;
}

// A pure rename (100% similarity) or a mode-only change carries NO `---`/`+++`
// headers — git emits only the `diff --git a/<old> b/<new>` line plus, for a
// rename/copy, `rename from`/`rename to`. Parse those too, both sides: moving a
// file OUT of a guardrail path matters as much as moving one in. Paths may
// contain spaces, so the `a/`…` b/` split is greedy — the last ` b/` wins, which
// is right for the same-path and no-space cases and harmless otherwise (a
// mis-split path simply fails the guardrail globs, and the rename lines below
// carry the exact paths anyway). C-quoted `diff --git "a/…" "b/…"` lines are
// likewise left to the rename lines, which quote one path each.
const DIFF_GIT_RE = /^diff --git a\/(.*) b\/(.*)$/;
const RENAME_RE = /^(?:rename|copy) (?:from|to) (.+)$/;
function structuralPaths(l) {
  const g = l.match(DIFF_GIT_RE);
  if (g) return [unquoteGitPath(g[1]), unquoteGitPath(g[2])];
  const r = l.match(RENAME_RE);
  if (r) return [unquoteGitPath(r[1])];
  return [];
}

// The path-based floor: the same protected set orch enforces at intake, plus
// docs/CODEOWNERS — the third GitHub-valid CODEOWNERS location, which the docs
// exemption above would otherwise swallow. The globs are anchored, so
// examples/CODEOWNERS or a random `workflows/` dir do NOT match; only the live
// root / .github/ / docs/ guardrail locations trip it.
const GUARDRAIL_PATH_RES = [...DEFAULT_PROTECTED, "docs/CODEOWNERS"].map(globToRegExp);
function isGuardrailPath(file) {
  return !!file && GUARDRAIL_PATH_RES.some((re) => re.test(file));
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
      file = headerPath(l);
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

// `ignore` (#334): globs from `security.ignore` in orch.yml, for files that are
// build artifacts rather than authored code — e.g. a committed minified bundle,
// where RegExp#exec() receivers lose their regex-literal assignment to var
// renaming and always false-positive as subprocess spawns. Default is [] (scan
// everything); an unknown path (no `+++ b/` header) is never ignorable, and the
// config itself lives in `.orch/` where the secret-read rule + config load
// timing keep a same-cycle diff from widening its own exemptions.
export function scanDiff(diffText, { ignore = [] } = {}) {
  const findings = [];
  // Path-based floor (#345): touching a guardrail path trips guardrail-touch
  // regardless of added-line content — an ERR trap with no trigger string, or a
  // pure deletion with no added lines at all, would otherwise stay silent. Read
  // BOTH `--- a/` and `+++ b/` headers so deletions are caught, plus the
  // `diff --git` / `rename` lines so a pure rename — which emits no `---`/`+++`
  // at all — is caught too. Not subject to
  // `ignore`: a guardrail file is never a build artifact.
  const seen = new Set();
  for (const l of String(diffText).split("\n")) {
    const paths = [headerPath(l), ...structuralPaths(l)];
    for (const p of paths) {
      if (p && !seen.has(p) && isGuardrailPath(p)) {
        seen.add(p);
        findings.push({ rule: "guardrail-touch", line: "guardrail path changed", file: p });
      }
    }
  }
  const ignoreRes = ignore.map(globToRegExp);
  const entries = addedCodeLines(diffText)
    .filter(({ file }) => !(file && ignoreRes.some((re) => re.test(file))));
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

// Rank a finding for display: a hit INSIDE a guardrail file is the line that
// justifies the human gate, so it leads; authored (non-test) code next; a bare
// path string in a test fixture last. An unknown path counts as authored —
// the floor errs toward "look at this". Stable sort keeps insertion order
// within a rank.
function findingRank({ file }) {
  if (isGuardrailPath(file)) return 0;
  if (!isTestFile(file)) return 1;
  return 2;
}

// Render a scanDiff() DISAGREE for humans. Returns:
//   summary — one line for run logs and the CLI status line (kept short),
//   detail  — an educational markdown note for the escalation a person reads.
// The raw findings list repeats and interleaves rules; here we DEDUPE identical
// (file, line) pairs, GROUP by rule, RANK real edits above fixtures, TAG each
// shown line with its file, and CLIP long snippets so the note stays scannable.
// The detail explains *why* the scan can fire on lines that aren't dangerous (it
// matches added text, so a fixture that merely mentions a pattern trips it) and
// then gives a COMPUTED recommendation — a bare "decision needed" is useless
// friction, so the note names the likely verdict and the concrete next step.
export function formatSecurityFindings(findings, { maxPerRule = 5, maxLen = 100, mergeCmd = null } = {}) {
  const byRule = new Map(); // rule -> Map of dedupe key -> finding (insertion-ordered)
  for (const f of findings) {
    if (!byRule.has(f.rule)) byRule.set(f.rule, new Map());
    byRule.get(f.rule).set(`${f.file ?? ""}${f.line}`, f);
  }
  const total = [...byRule.values()].reduce((n, m) => n + m.size, 0);
  const counts = [...byRule].map(([rule, m]) => `${rule} ×${m.size}`).join(", ");
  const summary = `security scan blocked the merge — ${total} finding${total === 1 ? "" : "s"} (${counts})`;

  const clip = (s) => (s.length > maxLen ? s.slice(0, maxLen - 1) + "…" : s);
  const sections = [...byRule].map(([rule, map]) => {
    const entries = [...map.values()].sort((a, b) => findingRank(a) - findingRank(b));
    const shown = entries.slice(0, maxPerRule)
      .map((f) => `    ${f.file ? `\`${f.file}\`: ` : ""}${clip(f.line)}`);
    if (entries.length > maxPerRule) shown.push(`    …and ${entries.length - maxPerRule} more`);
    return `- **${rule}** — ${RULE_BLURB[rule] || "matched a risky pattern"}:\n${shown.join("\n")}`;
  });

  const detail = [
    "## Security scan blocked the merge",
    "",
    "orch runs a **deterministic security floor** over the changed paths and added",
    "lines of the final diff, independent of the LLM reviewer. Unlike the reviewer",
    "it cannot be talked out of a DISAGREE — it is the last gate before merge. Any",
    "diff touching a guardrail path is flagged, and any added line containing a",
    "risky pattern — whether real code or a string that merely *mentions* the",
    "pattern (a test fixture, a documentation example). It fails **closed**:",
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
