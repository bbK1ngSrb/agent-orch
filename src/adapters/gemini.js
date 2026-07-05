import { makeCliAdapter } from "./cli-adapter.js";

export function buildArgs(prompt, _wd, opts = {}) {
  const args = ["-p", prompt, "--yolo"];
  if (opts.model) args.push("--model", opts.model);
  return args;
}

export default makeCliAdapter({ name: "gemini", bin: "gemini", buildArgs });
