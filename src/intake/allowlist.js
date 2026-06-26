// §3c + §7: author-time enforcement of the protected-path set. A work order
// whose diff touches any protected path is rejected before authoring — the same
// set CODEOWNERS guards at review time. Denylist (protected) not allowlist
// (safe): the safe surface is "everything else", and new ordinary files must
// not need a config edit to be writable.
import { globToRegExp } from "../scope.js";

export const DEFAULT_PROTECTED = [
  ".github/workflows/**",
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

export function checkPaths(changedFiles, protectedGlobs = DEFAULT_PROTECTED) {
  const res = protectedGlobs.map(globToRegExp);
  const violations = changedFiles.filter((f) => res.some((re) => re.test(f)));
  return { ok: violations.length === 0, violations };
}
