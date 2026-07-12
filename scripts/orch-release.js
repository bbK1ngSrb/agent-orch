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

// The GitHub Pages site (docs/index.html) hard-codes the version in a
// `>vX.Y.Z</span>` and nothing else touches it, so it must be bumped here too (#192).
const sitePath = "docs/index.html";
let siteBumped = false;
if (existsSync(sitePath)) {
  const html = readFileSync(sitePath, "utf8");
  const next = html.replace(/v\d+\.\d+\.\d+(?=<(?:\\u002F|\\\/|\/)span>)/, `v${version}`);
  if (next !== html) {
    writeFileSync(sitePath, next);
    siteBumped = true;
  }
}

const addFiles = ["package.json"];
if (existsSync("package-lock.json")) addFiles.push("package-lock.json");
if (siteBumped) addFiles.push("docs/index.html");
execFileSync("git", ["add", ...addFiles], { stdio: "inherit" });
execFileSync("git", ["commit", "-m", `chore(release): v${version}`], { stdio: "inherit" });
execFileSync("git", ["tag", "-a", `v${version}`, "-m", `v${version}`], { stdio: "inherit" });

console.log(`\nv${version} committed and tagged locally.`);
console.log(`Review it, then:  git push && git push origin v${version}`);
console.log(`Then dispatch npm-publish.yml with tag: v${version}`);
