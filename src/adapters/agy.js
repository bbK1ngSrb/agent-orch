import { makeCliAdapter } from "./cli-adapter.js";

export function buildArgs(prompt, _wd, opts = {}) {
  const args = ["-p", prompt];
  if (opts.model) args.push("--model", opts.model);
  return args;
}

const adapter = makeCliAdapter({ name: "agy", bin: "agy", buildArgs });

// Review-only (#272): headless `agy -p` performs every file operation inside
// its own scratch workspace (~/.gemini/antigravity-cli/scratch/) and ignores
// the process working directory — `--add-dir` doesn't change that, and no CLI
// flag binds a headless session to a real directory. Authoring would end as a
// silent no-op: agy reports success, the worktree never changes, and orch
// commits an empty diff. Refuse the author seat with a hard error instead —
// a loud failure the run log can explain beats a confidently empty branch.
// Auditing only needs agy to read the diff and print a verdict, so it stays.
adapter.reviewOnly = true;
adapter.author = async () => {
  throw new Error(
    "agy cannot author: headless `agy -p` edits its own scratch workspace, never the worktree (#272) — use agy as a reviewer only",
  );
};

export default adapter;
