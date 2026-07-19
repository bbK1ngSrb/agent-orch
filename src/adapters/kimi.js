import { makeCliAdapter } from "./cli-adapter.js";

// kimi CLI (kimi-code, Moonshot AI). -p/--prompt is the headless single-turn
// mode ("run one prompt non-interactively and print the response"). Like the
// other CLIs, headless still gates tool executions (Edit/Write/Bash) on
// approval by default, which would hang/no-op the author stage — so --yolo
// auto-approves, same rationale as claude's --dangerously-skip-permissions and
// gemini's --yolo. Flags verified against kimi-code 0.27.0 --help; no
// reasoning-effort flag exists, so the effort capability stays off and a
// configured effort fails loudly in assertSupported instead of being silently
// dropped.
export function buildArgs(prompt, _wd, opts = {}) {
  const args = ["-p", prompt, "--yolo"];
  if (opts.model) args.push("--model", opts.model);
  return args;
}

export default makeCliAdapter({ name: "kimi", bin: "kimi", buildArgs, capabilities: { model: true, effort: false } });
