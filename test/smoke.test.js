import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { VERSION } from "../src/version.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

test("version is a semver string", () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
});

// Dual source of truth: npm identity lives in package.json; `orch --version`
// (and the banner) read src/version.js. Automatic patch bumps keep both in
// sync, but a manual minor/major release can forget version.js — as 0.4.0 did
// (#308). Fail loudly if they drift.
test("src/version.js matches package.json#version", () => {
  assert.equal(VERSION, pkgVersion);
});
