import { makeCliAdapter } from "./cli-adapter.js";

// kimi CLI (kimi-code, Moonshot AI). -p/--prompt is the headless single-turn
// mode ("run one prompt non-interactively and print the response"). Unlike the
// other CLIs, no approval-bypass flag is passed: kimi-code 0.27.0 rejects the
// combination outright ("error: Cannot combine --prompt with --yolo", same for
// --auto) because prompt mode already auto-approves tool executions — verified
// live by having `kimi -p` write a file into cwd with no extra flags. No
// reasoning-effort flag exists, so the effort capability stays off and a
// configured effort fails loudly in assertSupported instead of being silently
// dropped.
export function buildArgs(prompt, _wd, opts = {}) {
  const args = ["-p", prompt];
  if (opts.model) args.push("--model", opts.model);
  return args;
}

export default makeCliAdapter({ name: "kimi", bin: "kimi", buildArgs, capabilities: { model: true, effort: false } });
