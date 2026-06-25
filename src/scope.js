import { execFileSync } from "node:child_process";

const DOUBLE_STAR = "__ORCH_DOUBLE_STAR__";
function globToRegExp(glob) {
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, DOUBLE_STAR)
    .replace(/\*/g, "[^/]*")
    .replaceAll(DOUBLE_STAR, ".*");
  return new RegExp("^" + re + "$");
}

// Sum added+deleted lines from `git diff --numstat`, skipping binaries and
// files matching any `ignore` glob.
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

// Count non-ignored changed lines for branch vs main, for the scope gate.
export function count(branch, cwd, ignore = []) {
  const out = execFileSync("git", ["diff", "--numstat", `main...${branch}`], {
    cwd,
    encoding: "utf8",
  });
  return parseNumstat(out, ignore);
}
