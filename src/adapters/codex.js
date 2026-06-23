import { makeCliAdapter } from "./cli-adapter.js";

export function buildArgs(prompt, wd) {
  return ["exec", "--cd", wd, prompt];
}

export default makeCliAdapter({ name: "codex", bin: "codex", buildArgs });
