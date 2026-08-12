import { appendCliOverrides, makeCliAdapter } from "./cli-adapter.js";

// grok CLI (xAI). `-p/--single <prompt>` is the headless single-turn mode. But
// headless still gates tool executions (Edit/Write/Bash) on approval by default,
// which would block the author stage — so --always-approve is required for
// unattended authoring, same rationale as claude's --dangerously-skip-permissions
// and gemini's --yolo. --effort carries the optional reasoning-effort role option.
export function buildArgs(prompt, _wd, opts = {}) {
  const args = ["-p", prompt, "--always-approve"];
  return appendCliOverrides(args, opts, { model: true, effort: true });
}

export default makeCliAdapter({ name: "grok", bin: "grok", buildArgs, capabilities: { model: true, effort: true } });
