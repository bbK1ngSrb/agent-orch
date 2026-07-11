import { test } from "node:test";
import assert from "node:assert/strict";
import { pidAlive } from "../src/pid.js";

// Stub process.kill so the probe throws a chosen error code — the only way to
// exercise Windows-specific codes (e.g. EINVAL for a bogus pid) from any OS.
function withKillThrowing(code, fn) {
  const orig = process.kill;
  process.kill = () => { const e = new Error(`synthetic ${code}`); e.code = code; throw e; };
  try { return fn(); } finally { process.kill = orig; }
}

test("our own PID is alive", () => {
  assert.equal(pidAlive(process.pid), true);
});

test("ESRCH (no such process) means dead", () => {
  withKillThrowing("ESRCH", () => assert.equal(pidAlive(12345), false));
});

test("EPERM (exists, no permission to signal) means alive", () => {
  withKillThrowing("EPERM", () => assert.equal(pidAlive(12345), true));
});

test("any other error code means dead (Windows bogus-pid hardening)", () => {
  // On Windows, an out-of-range pid can throw codes other than ESRCH/EPERM
  // (e.g. EINVAL). Treating those as "alive" wedged reclaim behind pids that
  // never existed — the hardened probe only trusts EPERM as proof of life.
  withKillThrowing("EINVAL", () => assert.equal(pidAlive(999999999), false));
  withKillThrowing("UNKNOWN", () => assert.equal(pidAlive(999999999), false));
});

test("non-positive and non-integer pids are never alive", () => {
  // pid 0 / negative pids signal process groups on POSIX — process.kill(0, 0)
  // would "succeed" without answering whether any single process is alive.
  assert.equal(pidAlive(0), false);
  assert.equal(pidAlive(-1), false);
  assert.equal(pidAlive(NaN), false);
  assert.equal(pidAlive(1.5), false);
  assert.equal(pidAlive("42"), false);
});
