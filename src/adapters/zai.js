import { buildArgs } from "./claude.js";
import { makeCliAdapter } from "./cli-adapter.js";

export { buildArgs };

const adapter = makeCliAdapter({
  name: "zai",
  bin: "claude",
  buildArgs,
  env: {
    ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
    // Explicit role-spec --model wins on argv; these only pin z.ai's defaults:
    // flagship for foreground work, cheap Air for Claude's background calls.
    ANTHROPIC_MODEL: "glm-5.3",
    ANTHROPIC_SMALL_FAST_MODEL: "glm-4.5-air",
    ANTHROPIC_API_KEY: undefined,
    get ANTHROPIC_AUTH_TOKEN() {
      return process.env.ZAI_API_KEY;
    },
  },
  capabilities: { model: true, effort: false },
});

Object.defineProperty(adapter, "disabled", {
  enumerable: true,
  get() {
    return process.env.ZAI_API_KEY ? undefined : "ZAI_API_KEY is not set";
  },
});

export default adapter;
