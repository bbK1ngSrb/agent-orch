import { readFileSync } from "node:fs";
import { win32 as winPath } from "node:path";
import { spawnSync } from "node:child_process";

// Single seam for every POSIX/Windows behavioral fork. Anything that signals
// processes, probes PATH, or spawns npm-shim CLIs must go through here so the
// platform branch lives in one place instead of scattered per-caller.
export const IS_WINDOWS = process.platform === "win32";

const WIN_EXT_RE = /\.(exe|cmd|bat|com|ps1)$/i;

// Filenames to probe for `exe` on this platform. POSIX: the bare name. Windows:
// the bare name plus each PATHEXT extension (claude → claude.cmd etc.) — npm
// installs CLIs as .cmd shims, so an extensionless probe never finds them.
export function exeCandidates(exe, platform = process.platform, pathext = process.env.PATHEXT) {
  if (platform !== "win32" || WIN_EXT_RE.test(exe)) return [exe];
  const exts = (pathext || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  return [exe, ...exts.map((e) => exe + e.toLowerCase())];
}

// Kill a stalled agent and all its descendants. POSIX: SIGKILL the process
// group (callers spawn with detached:true so the child leads its own group).
// Windows: no process groups / no negative-pid semantics — taskkill /t walks
// the tree instead. Swallows "already gone": by kill time the pid may be reaped.
export function killTree(pid, platform = process.platform, deps = {}) {
  if (platform === "win32") {
    (deps.spawnSync || spawnSync)("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore" });
    return;
  }
  try { (deps.kill || process.kill)(-pid, "SIGKILL"); } catch { /* already gone */ }
}

// npm cmd-shims end in a line like: ... "%_prog%"  "%dp0%\node_modules\pkg\cli.js" %*
const CMD_SHIM_TARGET_RE = /"%dp0%\\([^"]+\.(?:cjs|mjs|js))"\s+%\*/i;
const CMD_META_RE = /[&|<>()^"%!\r\n]/;

function rejectCmdMeta(value) {
  if (CMD_META_RE.test(String(value))) {
    throw new Error(`unsafe Windows cmd fallback argument: ${String(value)}`);
  }
}

// Rewrite a spawn of a Windows .cmd/.bat npm shim into a direct
// `node <target.js>` spawn. Node ≥18.20 refuses to spawn .cmd/.bat without
// shell:true (CVE-2024-27980), and shell:true cannot safely carry the huge
// multi-line prompt argv through cmd.exe quoting — so we unwrap the shim and
// run its JS target with our own node. POSIX and native .exe pass through.
export function portableSpawnSpec(bin, args, platform = process.platform, read = readFileSync) {
  if (platform !== "win32" || !/\.(cmd|bat)$/i.test(bin)) return { bin, args };
  try {
    const m = read(bin, "utf8").match(CMD_SHIM_TARGET_RE);
    // win32 path ops explicitly: `bin` is a Windows path even when this branch
    // is exercised from POSIX tests, where the host path module would mis-split it.
    if (m) return { bin: process.execPath, args: [winPath.join(winPath.dirname(bin), m[1]), ...args] };
  } catch { /* unreadable shim: fall through */ }
  // ponytail: non-npm .cmd fallback goes through cmd.exe; argv with spaces may
  // not survive cmd re-parsing. Block command-control metacharacters rather
  // than trying to quote through cmd.exe re-parsing. Upgrade path: ship the
  // CLI as a native .exe.
  [bin, ...args].forEach(rejectCmdMeta);
  return { bin: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", bin, ...args] };
}
