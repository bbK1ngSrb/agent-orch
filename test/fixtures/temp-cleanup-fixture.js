import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

test("creates a temporary directory", () => {
  mkdtempSync(`${tmpdir()}/orch-cleanup-`);
});
