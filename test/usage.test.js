import { test } from "node:test";
import assert from "node:assert/strict";
import { totalUsage, formatInt, formatUsd, formatUsage } from "../src/usage.js";

// Hand-computed expectations from the format contracts — not observed from a run.
// formatUsd: sub-cent positive values use 4 decimals; everything else uses 2.
// totalUsage: costUsd is null until any run contributes a numeric costUsd.

test("totalUsage sums tokens and keeps costUsd null when no run is priced", () => {
  assert.deepEqual(totalUsage([]), { tokens: 0, costUsd: null });
  assert.deepEqual(totalUsage([{ tokens: 100 }, { tokens: 50 }]), { tokens: 150, costUsd: null });
  assert.deepEqual(totalUsage(), { tokens: 0, costUsd: null });
});

test("totalUsage sets hasCost when any run has a numeric costUsd (partial pricing)", () => {
  assert.deepEqual(
    totalUsage([{ tokens: 10, costUsd: 0.001 }, { tokens: 5 }]),
    { tokens: 15, costUsd: 0.001 },
  );
  assert.deepEqual(
    totalUsage([{ tokens: 1, costUsd: 0 }, { tokens: 2, costUsd: 0.02 }]),
    { tokens: 3, costUsd: 0.02 },
  );
});

test("totalUsage coerces non-numeric tokens to 0 and ignores non-number costUsd", () => {
  assert.deepEqual(totalUsage([{ tokens: "bad" }]), { tokens: 0, costUsd: null });
  assert.deepEqual(
    totalUsage([{ tokens: 10, costUsd: "0.5" }, { tokens: null }]),
    { tokens: 10, costUsd: null },
  );
});

test("formatUsd uses 4 decimals for sub-cent positives and 2 decimals otherwise", () => {
  const cases = [
    [0, "$0.00"],
    [0.004, "$0.0040"],
    [0.005, "$0.0050"],
    [0.0099, "$0.0099"],
    [0.01, "$0.01"],
    [0.04, "$0.04"],
    [1.2, "$1.20"],
    [1234.5, "$1234.50"],
    [-1, "$-1.00"],
    [NaN, "$0.00"],
    [null, "$0.00"],
    [undefined, "$0.00"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(formatUsd(input), expected, `formatUsd(${JSON.stringify(input)})`);
  }
});

test("formatInt rounds and inserts thousands separators", () => {
  assert.equal(formatInt(0), "0");
  assert.equal(formatInt(999), "999");
  assert.equal(formatInt(1000), "1,000");
  assert.equal(formatInt(2000), "2,000");
  assert.equal(formatInt(1234567), "1,234,567");
  assert.equal(formatInt(1.6), "2");
  assert.equal(formatInt(null), "0");
  assert.equal(formatInt(NaN), "0");
});

test("formatUsage omits cost when costUsd is null and includes it when priced", () => {
  assert.equal(formatUsage({ tokens: 2000, costUsd: null }), "2,000 tokens");
  assert.equal(formatUsage({ tokens: 2000, costUsd: 0.04 }), "2,000 tokens, ~$0.04");
  assert.equal(formatUsage({ tokens: 2000, costUsd: 0.005 }), "2,000 tokens, ~$0.0050");
  assert.equal(formatUsage({ tokens: 0 }), "0 tokens");
});
