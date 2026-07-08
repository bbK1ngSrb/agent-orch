import { execFileSync } from "node:child_process";

const DOUBLE_STAR = "__ORCH_DOUBLE_STAR__";
export function globToRegExp(glob) {
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, DOUBLE_STAR)
    .replace(/\*/g, "[^/]*")
    .replaceAll(DOUBLE_STAR, ".*");
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
  const out = execFileSync("git", ["diff", "--numstat", `${base}...${branch}`], {
    cwd,
    encoding: "utf8",
  });
  return parseNumstat(out, ignore);
}
