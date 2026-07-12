#!/usr/bin/env node
// Publish-bump: node scripts/orch-release.js
//
// Snaps package.json's patch field to the next multiple of 100 (the "z" half
// of the x.y.zcc scheme — see src/versioning.js), mirrors it into
// package-lock.json, commits as `chore(release): vX.Y.Z`, and tags. Does NOT
// push and does NOT publish — review the commit/tag, then push and dispatch
// npm-publish.yml yourself. Deliberately manual: publishing to the public
// npm registry is a separate, explicit act, not something this script chains
// into automatically.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { bumpPublish } from "../src/versioning.js";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const version = bumpPublish(pkg.version);

pkg.version = version;
writeFileSync("package.json", `${JSON.stringify(pkg, null, 2)}\n`);

if (existsSync("package-lock.json")) {
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  lock.version = version;
  if (lock.packages?.[""]) lock.packages[""].version = version;
  writeFileSync("package-lock.json", `${JSON.stringify(lock, null, 2)}\n`);
}

execFileSync("git", ["add", "package.json", "package-lock.json"], { stdio: "inherit" });
execFileSync("git", ["commit", "-m", `chore(release): v${version}`], { stdio: "inherit" });
execFileSync("git", ["tag", "-a", `v${version}`, "-m", `v${version}`], { stdio: "inherit" });

console.log(`\nv${version} committed and tagged locally.`);
console.log(`Review it, then:  git push && git push origin v${version}`);
console.log(`Then dispatch npm-publish.yml with tag: v${version}`);
