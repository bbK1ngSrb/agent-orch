import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import https from "node:https";
import { spawn } from "node:child_process";
import { C, colorEnabled, paint } from "./tui/theme.js";

const PACKAGE = "@bbk1ng/agent-orch";
const CACHE_FILE = "update-check.json";
const DAY_MS = 24 * 60 * 60 * 1000;

export function defaultCacheDir() {
  return join(homedir(), ".orch");
}

export function compareVersions(a, b) {
  const pa = String(a || "").split(".").map((p) => Number.parseInt(p, 10) || 0);
  const pb = String(b || "").split(".").map((p) => Number.parseInt(p, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

function cachePath(cacheDir) {
  return join(cacheDir, CACHE_FILE);
}

function readCache(cacheDir) {
  try {
    const parsed = JSON.parse(readFileSync(cachePath(cacheDir), "utf8"));
    if (!parsed || typeof parsed.latest !== "string" || !Number.isFinite(parsed.checkedAt)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(cacheDir, cache) {
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(cachePath(cacheDir), `${JSON.stringify(cache, null, 2)}\n`);
}

export async function fetchLatestFromNpm({ timeoutMs = 1500 } = {}) {
  return await new Promise((resolve, reject) => {
    const req = https.get(`https://registry.npmjs.org/${encodeURIComponent(PACKAGE)}/latest`, {
      timeout: timeoutMs,
      headers: { accept: "application/json", "user-agent": "agent-orch-update-check" },
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try {
          const version = JSON.parse(body).version;
          if (typeof version !== "string" || !version) throw new Error("missing version");
          resolve(version);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("update check timed out")));
    req.on("error", reject);
  });
}

export async function checkForUpdate({ current, now = Date.now(), cacheDir = defaultCacheDir(), fetchLatest = fetchLatestFromNpm } = {}) {
  const ts = typeof now === "number" ? now : Number(new Date(now));
  const cached = readCache(cacheDir);
  if (cached && ts - cached.checkedAt < DAY_MS) {
    return { latest: cached.latest, checkedAt: cached.checkedAt, fromCache: true, updateAvailable: compareVersions(cached.latest, current) > 0 };
  }

  try {
    const latest = await fetchLatest();
    writeCache(cacheDir, { latest, checkedAt: ts });
    return { latest, checkedAt: ts, fromCache: false, updateAvailable: compareVersions(latest, current) > 0 };
  } catch {
    return null;
  }
}

function shouldSkip({ env, stdout, json }) {
  return Boolean(env.ORCH_NO_UPDATE_CHECK || env.NO_UPDATE_NOTIFIER || env.CI || env.NODE_TEST_CONTEXT || (json && stdout && !stdout.isTTY));
}

function notice({ current, latest, stderr }) {
  const color = colorEnabled(stderr);
  stderr.write(`${paint(color, C.warn, "^")} agent-orch ${latest} available (you have ${current}) - run \`orch upgrade\`\n`);
}

function spawnChecker({ current, cacheDir, spawnFn, env }) {
  const script = process.argv[1];
  if (!script) return;
  try {
    const child = spawnFn(process.execPath, [script, "__update-check-child", current, cacheDir], {
      detached: true,
      stdio: "ignore",
      env,
    });
    child.unref();
  } catch {
    // Update checks must never affect the user's command.
  }
}

export async function maybeNotifyUpdate({
  current,
  now = Date.now(),
  cacheDir = defaultCacheDir(),
  fetchLatest,
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  json = false,
  spawnFn = spawn,
} = {}) {
  if (shouldSkip({ env, stdout, json })) return null;

  const cached = readCache(cacheDir);
  if (cached && compareVersions(cached.latest, current) > 0) {
    notice({ current, latest: cached.latest, stderr });
  }

  const ts = typeof now === "number" ? now : Number(new Date(now));
  if (cached && ts - cached.checkedAt < DAY_MS) {
    return { latest: cached.latest, fromCache: true, updateAvailable: compareVersions(cached.latest, current) > 0 };
  }

  if (fetchLatest) {
    const result = await checkForUpdate({ current, now: ts, cacheDir, fetchLatest });
    if (!cached && result?.updateAvailable) notice({ current, latest: result.latest, stderr });
    return result;
  }

  spawnChecker({ current, cacheDir, spawnFn, env });
  return null;
}

export async function runUpdateCheckChild({ current, cacheDir = defaultCacheDir(), now = Date.now(), fetchLatest } = {}) {
  await checkForUpdate({ current, cacheDir, now, fetchLatest });
}

export const UPDATE_CHECK_CACHE_FILE = CACHE_FILE;
