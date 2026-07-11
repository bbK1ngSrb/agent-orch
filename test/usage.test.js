import { test } from "node:test";
import assert from "node:assert/strict";
import { formatUsage, totalUsage } from "../src/usage.js";

test("totalUsage sums tokens and known costs only", () => {
  assert.deepEqual(totalUsage([
    { tokens: 1200, costUsd: 0.03 },
    { tokens: "800" },
    { tokens: 0, costUsd: 0.01 },
  ]), { tokens: 2000, costUsd: 0.04 });
  assert.deepEqual(totalUsage([{ tokens: 5 }]), { tokens: 5, costUsd: null });
});

test("formatUsage keeps existing token and cost display", () => {
  assert.equal(formatUsage({ tokens: 2000, costUsd: 0.04 }), "2,000 tokens, ~$0.04");
  assert.equal(formatUsage({ tokens: 50, costUsd: 0.004 }), "50 tokens, ~$0.0040");
  assert.equal(formatUsage({ tokens: 0, costUsd: null }), "0 tokens");
});
