import { makeCliAdapter } from "./cli-adapter.js";

// --dangerously-skip-permissions: the agent runs headless in a throwaway
// worktree, so it must write without an interactive approval prompt (which
// would hang a non-interactive `-p` run and silently no-op the author step).
export function buildArgs(prompt, _wd) {
  return ["-p", "--dangerously-skip-permissions", prompt];
}

export default makeCliAdapter({ name: "claude", bin: "claude", buildArgs });
