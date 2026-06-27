import { test } from "node:test";
import assert from "node:assert/strict";
import { newSid } from "../src/sid.js";

test("newSid is unique per call and carries the pid", () => {
  const a = newSid();
  const b = newSid();
  assert.notEqual(a, b);
  assert.ok(a.startsWith(String(process.pid) + "-"));
  assert.match(a, /^\d+-[0-9a-z]+$/);
});
