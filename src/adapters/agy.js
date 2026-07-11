import { makeCliAdapter } from "./cli-adapter.js";

export function buildArgs(prompt, _wd, opts = {}) {
  const args = ["-p", prompt];
  if (opts.model) args.push("--model", opts.model);
  return args;
}

const adapter = makeCliAdapter({ name: "agy", bin: "agy", buildArgs, capabilities: { model: true, effort: false } });

// Review-only (#272): headless `agy -p` ignores the process cwd and performs
// every file edit inside its own scratch workspace (~/.gemini/antigravity-cli/
// scratch/) — `--add-dir` doesn't change that, and workspace binding is driven
// by agy's own --project session state, not cwd. Authoring with it is a silent
// no-op: agy reports success, the worktree never changes, and the cycle sees an
// empty diff with no error pointing at the real cause. Refuse the author seat
// loudly instead. Auditing is unaffected — it only reads the branch and prints
// a verdict, so the scratch-workspace quirk can't corrupt it.
adapter.author = async () => {
  throw new Error(
    "agy cannot author: headless `agy -p` writes edits to its private scratch workspace " +
    "(~/.gemini/antigravity-cli/scratch/), never the worktree, so authored changes silently " +
    "vanish (#272). Configure agy as a reviewer only.",
  );
};

export default adapter;
