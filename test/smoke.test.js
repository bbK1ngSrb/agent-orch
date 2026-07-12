import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

test("package.json#version is valid 3-part semver", () => {
  assert.match(pkgVersion, /^\d+\.\d+\.\d+$/);
});
