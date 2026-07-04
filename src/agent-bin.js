import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";

// Where agent CLIs usually live when the caller's PATH is degraded (wrappers,
// cron, hooks often drop ~/.local/bin): the user-local bin dir and the running
// node's own bin dir (covers `npm i -g` and nvm installs without spawning npm).
export const FALLBACK_BIN_DIRS = [join(homedir(), ".local", "bin"), dirname(process.execPath)];

// PATH lookup first; on miss, probe well-known install dirs and return the
// absolute path so spawns work even though PATH can't find the CLI. Null = nowhere.
// PATH is searched directly (no external `which`) so resolution works even when
// PATH is too degraded to find `which` itself.
export function resolveAgentBin(exe, dirs = FALLBACK_BIN_DIRS, envPath = process.env.PATH) {
  if (isAbsolute(exe)) {
    // Already resolved (e.g. by a prior preflight that rewrote adapter.bin):
    // just verify it's still executable instead of treating it as a PATH name.
    try { accessSync(exe, constants.X_OK); return exe; } catch { return null; }
  }
  for (const d of (envPath || "").split(delimiter)) {
    if (!d) continue;
    try { accessSync(join(d, exe), constants.X_OK); return exe; } catch { /* keep searching */ }
  }
  for (const d of dirs) {
    const p = join(d, exe);
    try { accessSync(p, constants.X_OK); return p; } catch { /* keep probing */ }
  }
  return null;
}
