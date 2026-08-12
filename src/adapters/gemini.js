import { appendCliOverrides, makeCliAdapter } from "./cli-adapter.js";

export function buildArgs(prompt, _wd, opts = {}) {
  const args = ["-p", prompt, "--yolo"];
  return appendCliOverrides(args, opts, { model: true });
}

export default makeCliAdapter({ name: "gemini", bin: "gemini", buildArgs, capabilities: { model: true, effort: false } });
