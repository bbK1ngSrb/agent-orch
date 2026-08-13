import { globToRegExp } from "./scope.js";
import { DEFAULT_PROTECTED } from "./intake/allowlist.js";

// §3e: independent security gate. Static scan of the diff's CHANGED PATHS and
// ADDED lines for the classes of behavior that exfiltrate or self-modify,
// regardless of whether the change satisfies the (attacker-influenced)
// acceptance_criteria. The LLM reviewer can be fooled (Residual #3); this
// deterministic floor cannot be talked out of a DISAGREE.
export const SECURITY_RULES = [
  { rule: "env-read", re: /process\.env|import\.meta\.env|os\.environ|\$\{?GITHUB_TOKEN/ },
  // The dotenv alternative requires an opening quote so `process.env` — already
  // covered by env-read — does not also fire here; only quoted file paths match.
  { rule: "secret-read", re: /\.orch\/|id_rsa|\.ssh\/|secrets?\.|\.pem\b|PRIVATE KEY|["'`](?:[^"'`]*[/\\])?\.env\b|credentials?\//i },
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

function isCommentOnlyLine(line) {
  const content = String(line).replace(/^\+/, "").trim();
  return /^(?:\/\/|#|\*|\/\*)/.test(content);
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
// Unquote and strip the `a/` / `b/` prefix git puts on both sides of a header.
// Only the standard prefixes are trusted; anything else (including /dev/null)
// is an unknown path, which content scanning treats as scannable (fail closed).
// The parser above trusts git's canonical `a/`/`b/` prefixes, but those are a
// *config-dependent* default: `diff.noprefix=true` drops them and
// `diff.mnemonicPrefix=true` renames them (`c/`, `w/`, `i/`). These flags pin
// them back, so the TEXT parse sees the shape it models. That text parse is now
// the SECONDARY of the floor's two path sources: the primary is the structural
// read below (`SECURITY_RAW_ARGS` + `parseRawPaths`), which does not depend on
// prefix configuration at all. The floor takes the union of the two, so it can
// only ever flag more paths than either source alone.
// These flags stay mandatory for the CONTENT rules, which have no structural
// alternative — only the patch text carries added lines. `--no-ext-diff`:
// an external diff driver replaces git's output wholesale. `--no-textconv`:
// a textconv driver (`.gitattributes` + `diff.<driver>.textconv`) filters file
// CONTENTS before diffing, so the content rules would scan the filter's output
// instead of the real change — `--no-ext-diff` does not disable it.
export const SECURITY_DIFF_ARGS = ["--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/"];

// The STRUCTURAL read of the same diff: one NUL-delimited record per changed
// file, each carrying an explicit status code (`M`, `A`, `D`, `R100`, `C75`,
// `T`) and the raw path bytes. Because `-z` is in play, paths are not C-quoted
// and records carry their own delimiter, so none of the text parse's quoting /
// prefix / where-does-the-a-side-end ambiguities exist here.
export const SECURITY_RAW_ARGS = ["--no-ext-diff", "--raw", "-z", "--find-renames"];

// Turn `git diff --raw -z` output into the changed repo-relative paths.
// Each record is a `:<modes> <shas> <status>` field followed by one path field —
// or TWO for a rename/copy (`R100`, `C75`). Both sides of a rename are returned:
// moving a workflow file OUT of `.github/workflows/` detaches a required check,
// so the old path matters as much as the new one. Malformed or truncated input
// never throws; whatever parsed is returned (the floor's other source still runs).
export function parseRawPaths(rawText) {
  const out = [];
  const toks = String(rawText ?? "").split("\0");
  for (let i = 0; i < toks.length; i++) {
    if (!toks[i].startsWith(":")) continue;
    const status = toks[i].slice(toks[i].lastIndexOf(" ") + 1);
    const n = /^[RC]/.test(status) ? 2 : 1;
    for (let k = 0; k < n && i + 1 < toks.length; k++) {
      const p = toks[++i];
      if (p) out.push(p);
    }
  }
  return out;
}

function abPath(s) {
  const m = unquoteGitPath(s.trim()).match(/^[ab]\/([\s\S]*)$/);
  return m ? m[1] : null;
}

function headerPath(l) {
  if (!l.startsWith("--- ") && !l.startsWith("+++ ")) return null;
  return abPath(l.slice(4));
}

// A pure rename (100% similarity) or a mode-only change carries NO `---`/`+++`
// headers — git emits only the `diff --git <a-side> <b-side>` line plus, for a
// rename, `rename from`/`rename to`. Each side is C-quoted independently when it
// holds non-ASCII/control bytes, so the sides can be mixed
// (`diff --git "a/café.yml" b/plain.yml`); the pattern accepts either form.
//
// Only the b-side is read here. It is enough: the a-side of a modify/delete
// already comes from the `--- a/` header, and for a rename the OLD path — which
// matters as much as the new one, since moving a workflow out detaches a
// required check — comes from the exact, unambiguous `rename from` line.
// `copy from` is deliberately NOT matched: a copy does not modify its source,
// so flagging that path is a false guardrail-touch.
//
// Paths may contain spaces, so git's own line has no delimiter marking where
// the a-side ends and the b-side begins — a single guessed split point is
// unsound: a path containing a literal ` b/` (e.g. a mode-only change to
// `.github/workflows/x b/ci.yml`) mis-splits and then fails the guardrail
// globs, failing OPEN. Instead of guessing, EVERY ` b/` (or ` "b/`) position
// is tried as the split and each candidate b-side is checked. The true b-side
// is always among the candidates, and a spurious extra candidate can only
// over-flag — fail closed, the safe direction for the floor.
const DIFF_GIT_PREFIX = "diff --git ";
const DIFF_GIT_SPLIT_RE = / (?="?b\/)/g;
const RENAME_RE = /^rename (?:from|to) (.+)$/;
function structuralPaths(l) {
  if (l.startsWith(DIFF_GIT_PREFIX)) {
    const out = [];
    DIFF_GIT_SPLIT_RE.lastIndex = 0;
    let m;
    while ((m = DIFF_GIT_SPLIT_RE.exec(l))) {
      const p = abPath(l.slice(m.index + 1));
      if (p) out.push(p);
    }
    return out;
  }
  const r = l.match(RENAME_RE);
  return r ? [unquoteGitPath(r[1])] : [];
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
//
// `rawPaths` (#383): the paths from the structural read (`parseRawPaths` over
// `git diff` + SECURITY_RAW_ARGS). The guardrail floor runs over the UNION of
// those and the paths the text parse derives, deduped, so each guardrail path
// still yields exactly one finding. Union, not replacement: the structural
// source removes the config-dependence, the text source stays as belt-and-
// braces, and the floor can only flag more than before, never fewer. Omitting
// it leaves behaviour identical to the text-only floor.
export function scanDiff(diffText, { ignore = [], rawPaths = [] } = {}) {
  const findings = [];
  // Path-based floor (#345): touching a guardrail path trips guardrail-touch
  // regardless of added-line content — an ERR trap with no trigger string, or a
  // pure deletion with no added lines at all, would otherwise stay silent. Read
  // BOTH `--- a/` and `+++ b/` headers so deletions are caught, plus the
  // `diff --git` / `rename` lines so a pure rename — which emits no `---`/`+++`
  // at all — is caught too. Not subject to
  // `ignore`: a guardrail file is never a build artifact.
  const seen = new Set();
  const flagPath = (p) => {
    if (p && !seen.has(p) && isGuardrailPath(p)) {
      seen.add(p);
      findings.push({ rule: "guardrail-touch", line: "guardrail path changed", file: p });
    }
  };
  for (const p of rawPaths) flagPath(p);
  for (const l of String(diffText).split("\n")) {
    for (const p of [headerPath(l), ...structuralPaths(l)]) flagPath(p);
  }
  const ignoreRes = ignore.map(globToRegExp);
  const entries = addedCodeLines(diffText)
    .filter(({ file }) => !(file && ignoreRes.some((re) => re.test(file))));
  const regexVars = regexLiteralVars(entries.map((e) => e.raw));
  for (const { file, raw } of entries) {
    for (const { rule, re } of SECURITY_RULES) {
      if (rule === "secret-read" && isCommentOnlyLine(raw)) continue;
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
  "secret-read": "reads a secret or orch's own control state (`.orch/`, `.ssh/`, `.pem`, dotenv file, `credentials/`, PRIVATE KEY)",
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

// Rank a finding for display (every rule, including secret-read — #365). A hit
// INSIDE a guardrail file is the line that justifies the human gate, so it
// leads; authored (non-test) code next; a bare path string in a test fixture
// last. An unknown path counts as authored — the floor errs toward "look at
// this". Stable sort keeps insertion order within a rank.
function findingRank({ file }) {
  if (isGuardrailPath(file)) return 0;
  if (!isTestFile(file)) return 1;
  return 2;
}

// Location tag for one shown finding. The path always comes from the diff's
// `+++ b/<path>` context (or the path-based floor), never from text inside the
// matched line — a fixture that embeds `file: "src/engine.js"` must still tag
// as the test file that contains that string (#365). Test paths get an explicit
// "(fixture)" marker so a skimmer cannot confuse a nested `file:` in the line
// body with the finding's real location.
function findingLocation(f) {
  if (!f.file) return "";
  return isTestFile(f.file)
    ? `\`${f.file}\` (fixture): `
    : `\`${f.file}\`: `;
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
    // Rank applies to every rule (guardrail-touch, secret-read, …): real edits
    // lead, fixture-only mentions sink, then maxPerRule clips the tail.
    const entries = [...map.values()].sort((a, b) => findingRank(a) - findingRank(b));
    const shown = entries.slice(0, maxPerRule)
      .map((f) => `    ${findingLocation(f)}${clip(f.line)}`);
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
    "pattern (a test fixture, a documentation example). Within each rule, findings",
    "are listed real-edit first and test fixtures last, each tagged with the file",
    "the line actually lives in (fixtures are marked). It fails **closed**:",
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
