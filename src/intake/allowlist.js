// §3c + §7: author-time enforcement of the protected-path set. A work order
// whose diff touches any protected path is rejected before authoring — the same
// set CODEOWNERS guards at review time. Denylist (protected) not allowlist
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

/** Strip git-diff a/ or b/ prefix, then ./ prefix. */
function normalizePath(p) {
  return p.replace(/^[ab]\//, "").replace(/^\.\//, "");
}

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
