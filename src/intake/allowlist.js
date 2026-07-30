// §3c + §7: the protected-path set. A work order whose diff touches any
// protected path is refused at intake if its text names one, and refused again
// at the merge boundary if the diff reaches that far — the same set CODEOWNERS
// guards at review time. Denylist (protected) not allowlist
// (safe): the safe surface is "everything else", and new ordinary files must
// not need a config edit to be writable.
import { globToRegExp } from "../scope.js";

export const DEFAULT_PROTECTED = [
  ".github/workflows/**",
  ".github/actions/**",
  "src/gate.js",
  "src/verdict.js",
  "src/notify.js",
  "src/intake/**",
  "src/security-review.js",
  "package.json",
  "package-lock.json",
  "Dockerfile",
  "sandbox/**",
  "CODEOWNERS",
  ".github/CODEOWNERS",
];

// Input contract: `changedFiles` are RELATIVE paths (git `diff --name-only`
// style). We still normalise a leading git-diff a/ or b/ prefix, a ./ prefix,
// and a leading slash, so an absolute path (e.g. a cwd-prefixed path from an OS
// hook) can never slip a protected file past the glob match — the gate is
// fail-open on a miss, so an unmatched absolute path would otherwise pass.
function normalizePath(p) {
  return p
    .replace(/^\/+/, "")
    .replace(/^[ab]\//, "")
    .replace(/^\.\//, "");
}

// Called once, at the merge boundary (engine.js). It is the BACKSTOP, not the
// first line of defence: `scanDiff`'s `guardrail-touch` floor scans the same set
// (plus docs/CODEOWNERS) and escalates earlier in engine.js, so an ordinary
// guardrail diff never reaches here. Do not delete it as unreachable — it is the
// only one of the two that fails closed on a `..` traversal segment, which the
// security floor's path globs would not match.
export function checkPaths(changedFiles, protectedGlobs = DEFAULT_PROTECTED) {
  const res = protectedGlobs.map(globToRegExp);
  const violations = changedFiles.filter((f) => {
    // Fail closed on path traversal — report original input.
    if (f.split("/").some((seg) => seg === "..")) return true;
    // Normalise git-diff prefixes before matching; violations keep original value.
    const norm = normalizePath(f);
    return res.some((re) => re.test(norm));
  });
  return { ok: violations.length === 0, violations };
}

// Intake-time text scan (#394): a work order that NAMES a protected path almost
// always requires a change to it, and such a diff is stopped before it can merge
// — so the run is a guaranteed stalemate discovered only after the round
// cap has burned a full author + audit cycle. This is a cheap literal scan, not
// intent detection: tokenise the free text and report any token that is (or
// points into) a protected path. A bare mention of a protected `dir/**` stem
// (".github/workflows") matches too, since `**` needs a trailing segment.
// Returns the matched path mentions, de-duplicated.
export function findProtectedMentions(text, protectedGlobs = DEFAULT_PROTECTED) {
  const res = protectedGlobs.map(globToRegExp);
  const stems = protectedGlobs.filter((g) => g.endsWith("/**")).map((g) => g.slice(0, -3));
  const mentions = new Set();
  for (const raw of String(text).split(/[\s"'`()\[\]{}<>]+/)) {
    // Strip sentence punctuation glued to a path token; keep leading dots
    // (.github/...) and let normalizePath handle /, ./, a/, b/ prefixes.
    const token = raw.replace(/^[,:;]+|[,.;:]+$/g, "");
    if (!token || token.split("/").some((seg) => seg === "..")) continue;
    const norm = normalizePath(token);
    if (!norm) continue;
    if (res.some((re) => re.test(norm)) || stems.includes(norm)) mentions.add(norm);
  }
  return [...mentions];
}
