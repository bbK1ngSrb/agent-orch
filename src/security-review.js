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
