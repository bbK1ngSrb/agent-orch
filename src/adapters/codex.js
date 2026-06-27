import { makeCliAdapter } from "./cli-adapter.js";

// --dangerously-bypass-approvals-and-sandbox: same rationale as the claude
// adapter — when codex is the author it must write headlessly; the default
// on-request approval would block. Harmless for the read-only audit pass.
export function buildArgs(prompt, wd, opts = {}) {
  const args = ["exec", "--cd", wd, "--dangerously-bypass-approvals-and-sandbox"];
  if (opts.model) args.push("--model", opts.model);
  // codex has no --effort flag; reasoning effort is a config override.
  if (opts.effort) args.push("-c", `model_reasoning_effort="${opts.effort}"`);
  args.push(prompt);
  return args;
}

export default makeCliAdapter({ name: "codex", bin: "codex", buildArgs });
