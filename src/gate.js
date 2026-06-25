import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

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

export function run(cmd, cwd) {
  const r = spawnSync(cmd, { cwd, shell: true, encoding: "utf8" });
  const log = (r.stdout || "") + (r.stderr || "");
  return { pass: r.status === 0, log };
}
