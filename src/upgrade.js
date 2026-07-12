import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { VERSION } from "./version.js";
import { portableSpawnSpec } from "./platform.js";
import { resolveAgentBin } from "./agent-bin.js";
import { C, colorEnabled, paint } from "./tui/theme.js";
import { compareVersions } from "./update-check.js";

const PACKAGE = "@bbk1ng/agent-orch";
const INSTALL_CMD = ["npm", "install", "-g", `${PACKAGE}@latest`];

// Shell-less spawn spec for npm. Windows installs npm as a .cmd shim that a
// bare execFileSync("npm", ...) can't spawn (CreateProcess ignores PATHEXT →
// ENOENT), so resolve the real shim path first and let portableSpawnSpec
// unwrap it into a direct `node <npm-cli.js>` spawn. POSIX passes through.
export function execSpec(cmd, args, deps = {}) {
  const bin = (deps.resolve || resolveAgentBin)(cmd) || cmd;
  return portableSpawnSpec(bin, args, deps.platform, deps.read);
}

function defaultExec(cmd, args = []) {
  const spec = execSpec(cmd, args);
  return execFileSync(spec.bin, spec.args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function resolveInstall(exec = defaultExec) {
  let linked = "";
  try { linked = exec("npm", ["ls", "-g", "--link", "--parseable"]); } catch { linked = ""; }
  const root = exec("npm", ["root", "-g"]).trim();
  const path = join(root, "@bbk1ng", "agent-orch");
  const stat = lstatSync(path);
  const realPath = stat.isSymbolicLink() ? realpathSync(path) : path;
  const linkedPaths = new Set(String(linked).split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
  return {
    type: stat.isSymbolicLink() || linkedPaths.has(path) || linkedPaths.has(realPath) ? "linked" : "registry",
    path,
    realPath,
  };
}

function latestVersion(exec) {
  return String(exec("npm", ["view", PACKAGE, "version"])).trim();
}

function explainError(e) {
  const msg = String(e?.message || e);
  if (e?.code === "EACCES" || /EACCES|permission denied/i.test(msg)) {
    return "permission denied updating the global npm install. Fix npm global permissions or use your Node version manager, then retry.";
  }
  return msg.split("\n")[0] || "upgrade failed";
}

export async function runUpgrade(opts = {}) {
  const {
    current = VERSION,
    exec = defaultExec,
    resolveInstall: resolve = () => resolveInstall(exec),
    stdout = process.stdout,
    flags = {},
  } = opts;
  const write = (line) => stdout.write(`${line}\n`);
  const color = colorEnabled(stdout);

  let install;
  try {
    install = resolve();
  } catch (e) {
    write(`${paint(color, C.fail, "orch upgrade:")} could not resolve global install (${explainError(e)})`);
    process.exitCode = 1;
    return { status: "error" };
  }

  if (install.type === "linked") {
    const path = install.realPath || install.path;
    write(`${paint(color, C.warn, "orch upgrade:")} linked dev install detected at ${path}`);
    write(`Run \`git pull\` in ${path} instead.`);
    return { status: "linked", install };
  }

  let target;
  try {
    target = latestVersion(exec);
  } catch (e) {
    write(`${paint(color, C.fail, "orch upgrade:")} could not check latest npm version (${explainError(e)})`);
    process.exitCode = 1;
    return { status: "error", install };
  }

  write(`orch upgrade: ${current} -> ${target}`);
  if (compareVersions(current, target) >= 0) {
    write(`${paint(color, C.ok, "orch upgrade:")} already latest`);
    return { status: "current", current, target, install };
  }

  if (flags.check) {
    write(`${paint(color, C.warn, "orch upgrade:")} upgrade available`);
    return { status: "available", current, target, install };
  }

  const commandText = INSTALL_CMD.join(" ");
  if (flags.dry) {
    write(`orch upgrade: would run \`${commandText}\``);
    return { status: "dry", current, target, install, command: commandText };
  }

  try {
    exec(INSTALL_CMD[0], INSTALL_CMD.slice(1));
    write(`${paint(color, C.ok, "orch upgrade:")} updated to latest`);
    return { status: "upgraded", current, target, install, command: commandText };
  } catch (e) {
    write(`${paint(color, C.fail, "orch upgrade:")} ${explainError(e)}`);
    process.exitCode = 1;
    return { status: "error", current, target, install, command: commandText };
  }
}
