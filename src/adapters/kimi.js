import { makeCliAdapter } from "./cli-adapter.js";

// kimi CLI (Moonshot AI). --print is the headless single-turn mode. Like the
// other CLIs, headless still gates tool executions (Edit/Write/Bash) on
// approval by default, which would hang/no-op the author stage — so --yolo
// auto-approves, same rationale as claude's --dangerously-skip-permissions and
// gemini's --yolo. Flags are best-effort against kimi's Claude-Code-style
// interface; no reasoning-effort flag exists, so the effort capability stays
// off and a configured effort fails loudly in assertSupported instead of being
// silently dropped.
export function buildArgs(prompt, _wd, opts = {}) {
  const args = ["--print", prompt, "--yolo"];
  if (opts.model) args.push("--model", opts.model);
  return args;
}

export default makeCliAdapter({ name: "kimi", bin: "kimi", buildArgs, capabilities: { model: true, effort: false } });
