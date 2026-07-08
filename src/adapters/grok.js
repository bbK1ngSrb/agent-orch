import { makeCliAdapter } from "./cli-adapter.js";

// grok CLI (xAI). Headless `-p <prompt>` runs non-interactively, so — unlike
// claude/codex — there's no approval prompt to bypass. Model is optional.
export function buildArgs(prompt, _wd, opts = {}) {
  const args = ["-p", prompt];
  if (opts.model) args.push("--model", opts.model);
  return args;
}

export default makeCliAdapter({ name: "grok", bin: "grok", buildArgs });
