import { appendCliOverrides, makeCliAdapter } from "./cli-adapter.js";

// The author runs headless in a throwaway worktree, so it must write without an
// interactive approval prompt (which would hang a `-p` run and silently no-op the
// author step). Two layers, because either can be unavailable:
//   --allowedTools: whitelists the write/commit tools so they run without a prompt
//     even when permission mode is forced to default. This is the layer that works
//     under CLAUDE_CODE_SUBPROCESS_ENV_SCRUB (env-scrub hardening), which strips the
//     flag below and would otherwise leave the author unable to edit files.
//   --dangerously-skip-permissions: full bypass when env-scrub is NOT in effect.
const ALLOWED_TOOLS = "Edit,Write,Read,Bash,Glob,Grep";
export function buildArgs(prompt, _wd, opts = {}) {
  const args = ["-p", "--allowedTools", ALLOWED_TOOLS, "--dangerously-skip-permissions"];
  appendCliOverrides(args, opts, { model: true, effort: true });
  args.push(prompt);
  return args;
}

export default makeCliAdapter({ name: "claude", bin: "claude", buildArgs, capabilities: { model: true, effort: true } });
