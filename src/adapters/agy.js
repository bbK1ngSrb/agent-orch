import { makeCliAdapter } from "./cli-adapter.js";

export function buildArgs(prompt, _wd, opts = {}) {
  const args = ["-p", prompt];
  if (opts.model) args.push("--model", opts.model);
  return args;
}

const adapter = makeCliAdapter({ name: "agy", bin: "agy", buildArgs });

// Review-only (#272): headless `agy -p` ignores the process cwd — every file
// edit lands in agy's own scratch workspace (~/.gemini/antigravity-cli/scratch),
// never the worktree, and --add-dir doesn't change that. An author run would
// report success while the branch diff stays empty: a silent no-op, the worst
// failure mode for an authoring adapter. Refuse the author seat loudly instead.
// This is the single choke point every author path goes through — rotation,
// explicit --author, revise rounds, and conflict resolution all call
// adapter.author(). Audit stays available: a verdict needs no worktree writes.
adapter.author = async () => {
  throw new Error(
    "agy is review-only: headless agy edits its private scratch workspace instead of the worktree, " +
    "so authored changes would be silently dropped (#272). Use agy as a reviewer or pick another author.",
  );
};

export default adapter;
