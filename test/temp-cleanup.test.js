import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cleanupModule = fileURLToPath(new URL("./helpers/temp-cleanup.cjs", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/temp-cleanup-fixture.js", import.meta.url));

test("test runner temp directories are removed when the test process exits", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(packageJson.scripts.test, /--require=\.\/test\/helpers\/temp-cleanup\.cjs/);

  const privateTempDir = mkdtempSync(join(tmpdir(), "orch-cleanup-test-"));
  execFileSync(process.execPath, [
    `--require=${cleanupModule}`,
    "--test",
    fixture,
  ], {
    encoding: "utf8",
    env: { TMPDIR: privateTempDir },
  });

  assert.deepEqual(
    readdirSync(privateTempDir).filter((entry) => entry.startsWith("orch-")),
    [],
  );
});
