#!/usr/bin/env node
// Point git at the committed hooks in githooks/ so every clone gets the
// protected-branch-deletion guard. Runs from npm's "prepare" script, which
// fires on a dev `npm install` in this repo but not when consumers install
// the published package. No-op anywhere that isn't a git checkout (CI
// tarball builds, `npm pack` extracts).
import { execFileSync } from "node:child_process";

try {
  execFileSync("git", ["rev-parse", "--git-dir"], { stdio: "ignore" });
  execFileSync("git", ["config", "core.hooksPath", "githooks"], { stdio: "ignore" });
} catch {
  // not a git checkout — nothing to install
}
