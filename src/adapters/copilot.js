import { makeCliAdapter } from "./cli-adapter.js";

export function buildArgs(prompt, wd, opts = {}) {
  const args = ["-p", prompt, "--allow-all-tools", "--allow-all-paths", "--add-dir", wd];
  if (opts.model) args.push("--model", opts.model);
  return args;
}

export default makeCliAdapter({ name: "copilot", bin: "copilot", buildArgs, capabilities: { model: true, effort: false } });
