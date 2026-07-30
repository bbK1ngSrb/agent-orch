// #409: a push to main can carry MORE THAN ONE `chore(release)` commit, because
// orch batches finished cycles on orch/integration and lands them in one PR
// merge. tag-release.yml used to read only the package.json version present when
// the push landed — a snapshot of the state AFTER the push, not the set of
// versions the push introduced — so every intermediate release went untagged, and
// the idempotency check (does the current version's tag exist?) never revisits it.
// This lists every version a push introduced as `<sha> <tag>` lines, oldest first.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const RELEASE_RE = /^chore\(release\): (v\d+\.\d+\.\d+)$/;
const ZERO_SHA = /^0*$/;

// Pure rule, so it is testable without a git fixture. `log` is the oldest-first
// output of `git log --reverse --format='%H %s'` over the push range; `head` and
// `headVersion` are the pushed tip and its package.json version.
//
// The tip is ALWAYS included (that is the pre-#409 behaviour, kept as the safety
// net): a release can land under a squashed subject the release-commit pattern
// cannot see — e.g. v0.4.211 was tagged from "chore: delete orch-docs.yml (#402)
// and cut v0.4.211". Dropping the tip in favour of pattern matching alone would
// fix the intermediate versions by breaking the ordinary single-release push.
//
// Each tag points at the commit that introduced its version, not at the tip.
// That matters downstream: npm-publish.yml checks out the tag ref and fails
// unless package.json there equals the tag, which only holds at that commit.
export function releaseTags(log, head, headVersion) {
  const out = [];
  const seen = new Set();
  for (const line of String(log).split("\n")) {
    const [sha, ...rest] = line.trim().split(" ");
    const m = RELEASE_RE.exec(rest.join(" "));
    if (!sha || !m || seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push(`${sha} ${m[1]}`);
  }
  const headTag = `v${headVersion}`;
  if (head && !seen.has(headTag)) out.push(`${head} ${headTag}`);
  return out;
}

function main(argv) {
  const [before, after] = argv.slice(2);
  const version = JSON.parse(readFileSync("package.json", "utf8")).version;
  // `github.event.before` is all-zeros on a branch's first push, and is not
  // fetchable if the old tip was removed — either way there is no range to walk,
  // so fall back to the tip alone (the pre-#409 behaviour).
  let log = "";
  if (before && !ZERO_SHA.test(before)) {
    try {
      execFileSync("git", ["cat-file", "-e", `${before}^{commit}`], { stdio: "ignore" });
      log = execFileSync("git", ["log", "--reverse", "--format=%H %s", `${before}..${after}`],
        { encoding: "utf8" });
    } catch {
      log = "";
    }
  }
  process.stdout.write(releaseTags(log, after, version).join("\n") + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv);
