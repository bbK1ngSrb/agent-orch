// test/workorder.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateWorkOrder } from "../src/intake/workorder.js";

const good = {
  title: "Crash on empty config",
  problem: "orch throws when .orch/orch.yml is absent",
  repro_steps: ["run orch with no config"],
  suspected_paths: ["src/config.js"],
  acceptance_criteria: ["orch exits 0 with a default config"],
};

test("accepts a well-formed work order", () => {
  const r = validateWorkOrder(good);
  assert.equal(r.ok, true);
  assert.deepEqual(r.workOrder, good);
});

test("rejects a missing required field", () => {
  const { title, ...rest } = good;
  const r = validateWorkOrder(rest);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("title")));
});

test("rejects wrong type (problem not a string)", () => {
  const r = validateWorkOrder({ ...good, problem: 42 });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("problem")));
});

test("rejects a non-string array element", () => {
  const r = validateWorkOrder({ ...good, repro_steps: ["ok", 7] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("repro_steps")));
});

test("rejects empty title or problem", () => {
  assert.equal(validateWorkOrder({ ...good, title: "   " }).ok, false);
  assert.equal(validateWorkOrder({ ...good, problem: "" }).ok, false);
});

test("strips unknown fields rather than trusting them", () => {
  const r = validateWorkOrder({ ...good, evil: "rm -rf /" });
  assert.equal(r.ok, true);
  assert.equal("evil" in r.workOrder, false);
});

test("rejects non-object input", () => {
  assert.equal(validateWorkOrder(null).ok, false);
  assert.equal(validateWorkOrder("a string").ok, false);
});
