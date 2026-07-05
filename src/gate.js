import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { portableSpawnSpec } from "./platform.js";
import { resolveAgentBin } from "./agent-bin.js";

function safeRead(p) {
  try { return readFileSync(p, "utf8"); } catch { return ""; }
}

export function detect(dir) {
  const pkg = join(dir, "package.json");
  if (existsSync(pkg)) {
    try {
      const j = JSON.parse(readFileSync(pkg, "utf8"));
      if (j.scripts && j.scripts.test) return "npm test";
    } catch { /* fall through */ }
  }
  if (
    existsSync(join(dir, "pytest.ini")) ||
    existsSync(join(dir, "pyproject.toml")) ||
    existsSync(join(dir, "tests"))
  ) return "pytest -q";
  if (existsSync(join(dir, "go.mod"))) return "go test ./...";
  if (existsSync(join(dir, "Makefile")) && /^test:/m.test(safeRead(join(dir, "Makefile"))))
    return "make test";
  return null;
}

// ponytail: quote-aware argv split, no shell operators (| && ; $() redirects).
// A `test:` needing a pipeline must call a script. Upgrade path: drop a
// run-tests.sh in the repo and set `test: ./run-tests.sh`.
export function splitArgs(cmd) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(cmd)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

// Shell-less spawn spec for the test command — metacharacters in the
// configured command must stay literal argv on every platform. Windows:
// PATH-resolve argv[0] so npm .cmd shims are found (npm → npm.cmd), then
// portableSpawnSpec unwraps the shim into a direct `node <target>` spawn
// instead of routing the command through cmd.exe.
export function spawnSpec(argv, platform = process.platform, deps = {}) {
  if (platform !== "win32") return { bin: argv[0], args: argv.slice(1) };
  const resolve = deps.resolve || resolveAgentBin;
  const bin = resolve(argv[0]) || argv[0];
  return portableSpawnSpec(bin, argv.slice(1), platform, deps.read);
}

export function run(cmd, cwd) {
  const argv = splitArgs(cmd || "");
  if (argv.length === 0) return { pass: false, log: "empty test command" };
  const spec = spawnSpec(argv);
  const r = spawnSync(spec.bin, spec.args, { cwd, encoding: "utf8" });
  const log = (r.stdout || "") + (r.stderr || "") + (r.error ? String(r.error.message) : "");
  return { pass: r.status === 0, log };
}
