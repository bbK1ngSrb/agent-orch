import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { maybeNotifyUpdate, UPDATE_CHECK_CACHE_FILE } from "../src/update-check.js";

function freshHome() {
  return mkdtempSync(join(tmpdir(), "orch-update-home-"));
}

function cacheDir(home) {
  const dir = join(home, ".orch");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function stderrSink() {
  let text = "";
  return {
    stream: { isTTY: true, write: (chunk) => { text += chunk; } },
    text: () => text,
  };
}

test("newer latest notifies", async () => {
  const err = stderrSink();
  await maybeNotifyUpdate({
    current: "1.0.0",
    cacheDir: cacheDir(freshHome()),
    fetchLatest: async () => "1.0.1",
    stderr: err.stream,
    env: {},
  });
  assert.match(err.text(), /agent-orch 1\.0\.1 available \(you have 1\.0\.0\)/);
});

test("equal or older latest is silent", async () => {
  for (const latest of ["1.0.0", "0.9.9"]) {
    const err = stderrSink();
    await maybeNotifyUpdate({
      current: "1.0.0",
      cacheDir: cacheDir(freshHome()),
      fetchLatest: async () => latest,
      stderr: err.stream,
      env: {},
    });
    assert.equal(err.text(), "");
  }
});

test("fresh cache notifies without network call", async () => {
  const dir = cacheDir(freshHome());
  writeFileSync(join(dir, UPDATE_CHECK_CACHE_FILE), JSON.stringify({ latest: "2.0.0", checkedAt: 1000 }));
  const err = stderrSink();
  let calls = 0;
  await maybeNotifyUpdate({
    current: "1.0.0",
    now: 2000,
    cacheDir: dir,
    fetchLatest: async () => { calls++; return "3.0.0"; },
    stderr: err.stream,
    env: {},
  });
  assert.equal(calls, 0);
  assert.match(err.text(), /agent-orch 2\.0\.0 available/);
});

test("environment opt-outs are silent", async () => {
  for (const key of ["ORCH_NO_UPDATE_CHECK", "NO_UPDATE_NOTIFIER", "CI"]) {
    const err = stderrSink();
    let calls = 0;
    await maybeNotifyUpdate({
      current: "1.0.0",
      cacheDir: cacheDir(freshHome()),
      fetchLatest: async () => { calls++; return "2.0.0"; },
      stderr: err.stream,
      env: { [key]: "1" },
    });
    assert.equal(calls, 0);
    assert.equal(err.text(), "");
  }
});

test("network error is silent and does not throw", async () => {
  const err = stderrSink();
  await maybeNotifyUpdate({
    current: "1.0.0",
    cacheDir: cacheDir(freshHome()),
    fetchLatest: async () => { throw new Error("offline"); },
    stderr: err.stream,
    env: {},
  });
  assert.equal(err.text(), "");
});

test("non-awaited CLI path spawns child, caches, then next run notifies", async () => {
  const root = mkdtempSync(join(tmpdir(), "orch-update-cli-"));
  const home = freshHome();
  const stub = join(root, "stub-https.mjs");
  writeFileSync(stub, `
import https from "node:https";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

https.get = (_url, _opts, cb) => {
  const req = new EventEmitter();
  req.destroy = (err) => { if (err) process.nextTick(() => req.emit("error", err)); return req; };
  process.nextTick(() => {
    const res = new Readable({ read() {} });
    res.setEncoding = () => {};
    cb(res);
    res.push(JSON.stringify({ version: "9.9.9" }));
    res.push(null);
  });
  return req;
};
`);

  const env = {
    HOME: home,
    PATH: process.env.PATH,
    NODE_OPTIONS: `--import=${stub}`,
  };
  const cli = resolve("bin/orch.js");
  execFileSync(process.execPath, [cli, "init"], { cwd: root, env, encoding: "utf8" });

  const file = join(home, ".orch", UPDATE_CHECK_CACHE_FILE);
  for (let i = 0; i < 50 && !existsSync(file); i++) await delay(50);
  assert.equal(existsSync(file), true);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).latest, "9.9.9");

  const result = spawnSync(process.execPath, [cli, "dashboard"], {
    cwd: root,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Run history/);
  assert.match(result.stderr, /agent-orch 9\.9\.9 available/);

  const json = spawnSync(process.execPath, [cli, "dashboard", "--json"], {
    cwd: root,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(json.status, 0);
  assert.doesNotThrow(() => JSON.parse(json.stdout));
  assert.equal(json.stderr, "");
});
