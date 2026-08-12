import { git } from "./git.js";

const DOUBLE_STAR = "__ORCH_DOUBLE_STAR__";
export function globToRegExp(glob) {
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, DOUBLE_STAR)
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    // [\s\S] not . — JS `.` excludes line terminators (\n \r U+2028 U+2029)
    // unless the s (dotAll) flag is set, so a protected path containing any of
    // those would fail to match and the guardrail floor would return AGREE.
    .replaceAll(DOUBLE_STAR, "[\\s\\S]*");
  return new RegExp("^" + re + "$");
}

export function parseNumstat(numstat, ignore = []) {
  const globs = ignore.map(globToRegExp);
  let total = 0;
  for (const line of String(numstat).split("\n")) {
    if (!line.trim()) continue;
    const [added, deleted, ...rest] = line.split("\t");
    const file = rest.join("\t");
    if (added === "-" || deleted === "-") continue; // binary
    if (globs.some((re) => re.test(file))) continue;
    total += Number(added) + Number(deleted);
  }
  return total;
}

export function isDocsOnly(files, globs) {
  if (!files.length) return false;
  const res = globs.map(globToRegExp);
  return files.every((f) => res.some((re) => re.test(f)));
}

export function count(branch, cwd, ignore = [], base = "main") {
  const out = git(["diff", "--numstat", `${base}...${branch}`], cwd);
  return parseNumstat(out, ignore);
}
