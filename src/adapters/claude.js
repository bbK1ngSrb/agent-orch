import { makeCliAdapter } from "./cli-adapter.js";

export function buildArgs(prompt, _wd) {
  return ["-p", prompt];
}

export default makeCliAdapter({ name: "claude", bin: "claude", buildArgs });
