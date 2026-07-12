import { test } from "node:test";
import assert from "node:assert/strict";
import { nextPublishPatch, bumpPublish } from "../src/versioning.js";

test("nextPublishPatch snaps forward to the next multiple of 100", () => {
  assert.equal(nextPublishPatch(0), 100);
  assert.equal(nextPublishPatch(1), 100);
  assert.equal(nextPublishPatch(99), 100);
  assert.equal(nextPublishPatch(100), 200);
  assert.equal(nextPublishPatch(150), 200);
  assert.equal(nextPublishPatch(1999), 2000);
});

test("bumpPublish resets cc to 00 and advances z", () => {
  assert.equal(bumpPublish("0.4.1"), "0.4.100");
  assert.equal(bumpPublish("0.4.100"), "0.4.200");
  assert.equal(bumpPublish("1.2.50"), "1.2.100");
});

test("bumpPublish throws on unparsable input", () => {
  assert.throws(() => bumpPublish("not-a-version"), /parse/);
  assert.throws(() => bumpPublish("0.4"), /parse/);
  assert.throws(() => bumpPublish("0.4.1.0"), /parse/);
});
