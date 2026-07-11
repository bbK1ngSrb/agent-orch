import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, win32 } from "node:path";
import { exeCandidates } from "./platform.js";

// Where agent CLIs usually live when the caller's PATH is degraded (wrappers,
// cron, hooks often drop ~/.local/bin): the user-local bin dir and the running
// node's own bin dir (covers `npm i -g` and nvm installs without spawning npm).
// Windows has no ~/.local/bin convention — npm globals land in %APPDATA%\npm.
export const FALLBACK_BIN_DIRS = process.platform === "win32"
  ? [join(process.env.APPDATA || homedir(), "npm"), dirname(process.execPath)]
  : [join(homedir(), ".local", "bin"), dirname(process.execPath)];

// PATH lookup first; on miss, probe well-known install dirs and return the
// absolute path so spawns work even though PATH can't find the CLI. Null = nowhere.
// PATH is searched directly (no external `which`) so resolution works even when
// PATH is too degraded to find `which` itself. On Windows each probe also tries
// the PATHEXT extensions (npm ships CLIs as .cmd shims), and a PATH hit returns
// the absolute resolved path so callers can see the real extension and route
// .cmd shims through portableSpawnSpec.
export function resolveAgentBin(exe, dirs = FALLBACK_BIN_DIRS, envPath = process.env.PATH, platform = process.platform) {
  if (isAbsolute(exe)) {
    // Already resolved (e.g. by a prior preflight that rewrote adapter.bin):
    // just verify it's still executable instead of treating it as a PATH name.
    try { accessSync(exe, constants.X_OK); return exe; } catch { return null; }
  }
  const names = exeCandidates(exe, platform);
  const pathDelimiter = platform === "win32" ? win32.delimiter : delimiter;
  for (const d of (envPath || "").split(pathDelimiter)) {
    if (!d) continue;
    for (const name of names) {
      const p = join(d, name);
      try { accessSync(p, constants.X_OK); return platform === "win32" ? p : exe; } catch { /* keep searching */ }
    }
  }
  for (const d of dirs) {
    for (const name of names) {
      const p = join(d, name);
      try { accessSync(p, constants.X_OK); return p; } catch { /* keep probing */ }
    }
  }
  return null;
}
