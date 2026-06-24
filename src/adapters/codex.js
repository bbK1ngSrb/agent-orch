import { makeCliAdapter } from "./cli-adapter.js";

// --dangerously-bypass-approvals-and-sandbox: same rationale as the claude
// adapter — when codex is the author it must write headlessly; the default
// on-request approval would block. Harmless for the read-only audit pass.
export function buildArgs(prompt, wd) {
  return ["exec", "--cd", wd, "--dangerously-bypass-approvals-and-sandbox", prompt];
}

export default makeCliAdapter({ name: "codex", bin: "codex", buildArgs });
