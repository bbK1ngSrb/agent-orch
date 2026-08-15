import { buildArgs } from "./claude.js";
import { makeCliAdapter } from "./cli-adapter.js";

export { buildArgs };

const adapter = makeCliAdapter({
  name: "zai",
  bin: "claude",
  buildArgs,
  env: {
    ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
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
