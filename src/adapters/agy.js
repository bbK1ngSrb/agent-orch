import { makeCliAdapter } from "./cli-adapter.js";

export function buildArgs(prompt, _wd, opts = {}) {
  const args = ["-p", prompt];
  if (opts.model) args.push("--model", opts.model);
  return args;
}

const adapter = makeCliAdapter({ name: "agy", bin: "agy", buildArgs, capabilities: { model: true, effort: false } });

// Disabled in both seats (#272, #296): headless `agy -p` ignores the process
// cwd and operates inside its own scratch workspace (~/.gemini/antigravity-cli/
// scratch/) — `--add-dir` doesn't change that, and workspace binding is driven
// by agy's own --project session state, not cwd. Authoring with it is a silent
// no-op: agy reports success, the worktree never changes, and the cycle sees an
// empty diff with no error pointing at the real cause. audit() spawns agy the
// same way (runCapture with cwd: wd) — if agy can't see the worktree to write
// to it, it can't see the worktree to read the diff either, so a reviewer run
// would judge stale/empty scratch-dir state instead of the actual branch,
// producing an unrelated or rubber-stamp verdict with no error surfaced.
// Refuse both seats loudly instead.
const REFUSAL =
  "agy cannot be used: headless `agy -p` operates inside its private scratch workspace " +
  "(~/.gemini/antigravity-cli/scratch/), never the worktree passed as cwd, so it can " +
  "neither author changes (#272) nor reliably review a branch's actual diff (#296). " +
  "Do not configure agy in any seat.";
// Set so preflight() can reject a config naming agy in any seat before a
// cycle ever spins up a worktree (rather than crashing mid-run inside a
// try/catch that wasn't built to expect author()/audit() to throw).
adapter.disabled = REFUSAL;
adapter.author = async () => {
  throw new Error(REFUSAL);
};
adapter.audit = async () => {
  throw new Error(REFUSAL);
};

export default adapter;
