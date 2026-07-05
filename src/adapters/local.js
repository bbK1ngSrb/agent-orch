import { makeCliAdapter } from "./cli-adapter.js";

// local-llm models: GGUFs served by an OpenAI-compatible llama-swap proxy on the
// maintainer's LAN, behind claude-code-router. `ccr code` drives the same headless claude CLI as the
// claude adapter, but routes the request to the local endpoint. `--model local,<name>`
// overrides ccr's default route, so each model registers as its own author/reviewer agent.
// Requires: ccr on PATH + ~/.claude-code-router/config.json defining provider `local`.
//
// `--bare` skips hooks/plugin-sync/CLAUDE.md-discovery: without it the headless
// claude CLI's system prompt runs ~47k tokens (this maintainer's full plugin/skill
// set), which blows past every 32k-ctx local model before the task prompt is even
// added (issue #113). `--bare` shrinks that enough for these models to respond.
const MODELS = ["qwen3-coder-30b", "deepseek-coder-v2-lite", "glm-4.5-air"];

function makeLocal(model) {
  const buildArgs = (prompt, _wd) => [
    "code",
    "--model",
    `local,${model}`,
    "--bare",
    "-p",
    "--dangerously-skip-permissions",
    prompt,
  ];
  return makeCliAdapter({ name: model, bin: "ccr", buildArgs });
}

export default Object.fromEntries(MODELS.map((m) => [m, makeLocal(m)]));
