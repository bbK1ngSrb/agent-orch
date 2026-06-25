import { makeCliAdapter } from "./cli-adapter.js";

// local-llm models: GGUFs served by llama-swap (OpenAI API, http://192.168.10.60:8080)
// behind claude-code-router. `ccr code` drives the same headless claude CLI as the
// claude adapter, but routes the request to the local endpoint. `--model local,<name>`
// overrides ccr's default route, so each model registers as its own author/reviewer agent.
// Requires: ccr on PATH + ~/.claude-code-router/config.json defining provider `local`.
const MODELS = ["qwen3-coder-30b", "deepseek-coder-v2-lite", "glm-4.5-air"];

function makeLocal(model) {
  const buildArgs = (prompt, _wd) => [
    "code",
    "--model",
    `local,${model}`,
    "-p",
    "--dangerously-skip-permissions",
    prompt,
  ];
  return makeCliAdapter({ name: model, bin: "ccr", buildArgs });
}

export default Object.fromEntries(MODELS.map((m) => [m, makeLocal(m)]));
