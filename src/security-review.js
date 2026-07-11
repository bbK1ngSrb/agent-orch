// §3e: independent security gate. Static scan of ADDED diff lines for the
// classes of behavior that exfiltrate or self-modify, regardless of whether the
// change satisfies the (attacker-influenced) acceptance_criteria. The LLM
// reviewer can be fooled (Residual #3); this deterministic floor cannot be
// talked out of a DISAGREE.
export const SECURITY_RULES = [
  { rule: "env-read", re: /process\.env|import\.meta\.env|os\.environ|\$\{?GITHUB_TOKEN/ },
  { rule: "secret-read", re: /\.orch\/|id_rsa|\.ssh\/|secrets?\.|\.pem\b|PRIVATE KEY/i },
  { rule: "network", re: /\bfetch\s*\(|node:net\b|node:dns\b|node:https?\b|require\(\s*["']https?["']\s*\)|XMLHttpRequest|\.connect\s*\(/ },
  { rule: "subprocess", re: /child_process|execSync|execFileSync|spawnSync|\bspawn\s*\(|(?<!\b(?:re|regex|regexp|pattern|rx)\.)\bexec\s*\(/i },
  { rule: "guardrail-touch", re: /branchProtection|CODEOWNERS|orch-pr\.yml|workflows\// },
];

// Added lines: start with a single '+' but not the '+++' file header.
function addedLines(diffText) {
  return String(diffText)
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"));
}

export function scanDiff(diffText) {
  const findings = [];
  for (const line of addedLines(diffText)) {
    for (const { rule, re } of SECURITY_RULES) {
      if (re.test(line)) findings.push({ rule, line: line.slice(1).trim() });
    }
  }
  return { decision: findings.length ? "DISAGREE" : "AGREE", findings };
}
