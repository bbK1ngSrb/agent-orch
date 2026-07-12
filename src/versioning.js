// src/versioning.js
//
// package.json#version stays real, un-encoded 3-part semver. The patch field
// (z) is read as `z*100 + cc`: the last two digits are a merge-bump counter
// (one per landed merge — plain +1, decimal carry rolls cc 99->00 into z for
// free, see src/git.js's bumpVersion, unchanged by this file), the digits
// above that are a publish-bump counter, advanced only here, only by an
// actual `npm publish`.
//
// If cc reaches 99 before a real publish happens, the next merge's plain +1
// carries into z on its own — by design, not a bug: that many merges without
// a publish means a publish is overdue anyway.

export function nextPublishPatch(patch) {
  return (Math.floor(patch / 100) + 1) * 100;
}

export function bumpPublish(versionString) {
  const parts = String(versionString ?? "").split(".");
  if (parts.length !== 3 || parts.some((p) => !/^\d+$/.test(p))) {
    throw new Error(`cannot parse version: ${versionString}`);
  }
  const [x, y, patch] = parts.map(Number);
  return `${x}.${y}.${nextPublishPatch(patch)}`;
}
