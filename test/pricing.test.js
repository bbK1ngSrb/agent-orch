import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateCostUsd } from "../src/pricing.js";

test("estimateCostUsd prices known models from input/output tokens", () => {
  assert.equal(estimateCostUsd("claude-opus-4-8", { inputTokens: 1_000_000, outputTokens: 0 }), 15);
  assert.equal(estimateCostUsd("claude-opus-4-8", { inputTokens: 0, outputTokens: 1_000_000 }), 75);
});

test("estimateCostUsd matches models regardless of dot/dash variant", () => {
  assert.equal(
    estimateCostUsd("claude-opus-4.8", { inputTokens: 1_000_000, outputTokens: 0 }),
    estimateCostUsd("claude-opus-4-8", { inputTokens: 1_000_000, outputTokens: 0 }),
  );
});

test("estimateCostUsd returns null for an unknown model instead of guessing", () => {
  assert.equal(estimateCostUsd("mystery-model", { inputTokens: 1000, outputTokens: 1000 }), null);
  assert.equal(estimateCostUsd(null, { inputTokens: 1000, outputTokens: 1000 }), null);
});
