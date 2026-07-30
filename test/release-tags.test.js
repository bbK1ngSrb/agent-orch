import { test } from "node:test";
import assert from "node:assert/strict";
import { releaseTags } from "../scripts/release-tags.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
const TIP = "c".repeat(40);

// #409's exact shape: PR #408 pushed two release commits at once. Expected values
// are hand-derived from the requirement (tag EVERY version the push introduced,
// oldest first, each at its own commit), not read back off an implementation.
test("a push carrying two release commits tags both, oldest first", () => {
  const log = [`${A} chore(release): v0.4.212`, `${B} chore(release): v0.4.213`, `${TIP} orch: integrate (#408)`].join("\n");
  assert.deepEqual(releaseTags(log, TIP, "0.4.213"), [`${A} v0.4.212`, `${B} v0.4.213`]);
});

// Pre-#409 behaviour, kept: v0.4.211 landed as a squash whose subject is not a
// `chore(release)` line, so only the tip's package.json version identifies it.
test("a release squashed under another subject is still tagged at the tip", () => {
  const log = `${TIP} chore: delete orch-docs.yml (#402) and cut v0.4.211`;
  assert.deepEqual(releaseTags(log, TIP, "0.4.211"), [`${TIP} v0.4.211`]);
});

test("the tip is not tagged twice when it is itself the release commit", () => {
  assert.deepEqual(releaseTags(`${TIP} chore(release): v0.5.0`, TIP, "0.5.0"), [`${TIP} v0.5.0`]);
});

// First push / unfetchable `before`: the CLI hands over an empty log, and the tip
// alone must still be tagged.
test("an empty range falls back to the tip version", () => {
  assert.deepEqual(releaseTags("", TIP, "1.2.3"), [`${TIP} v1.2.3`]);
});

test("non-release commits contribute no tags", () => {
  const log = [`${A} fix: something`, `${B} chore(release): not-a-version`].join("\n");
  assert.deepEqual(releaseTags(log, TIP, "0.4.213"), [`${TIP} v0.4.213`]);
});
