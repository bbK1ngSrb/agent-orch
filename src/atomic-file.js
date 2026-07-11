import { randomUUID } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export function writeFileAtomic(path, data, deps = {}) {
  const tmp = deps.tmpName
    ? deps.tmpName(path)
    : join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  const write = deps.writeFileSync || writeFileSync;
  const rename = deps.renameSync || renameSync;
  const remove = deps.rmSync || rmSync;
  try {
    write(tmp, data);
    rename(tmp, path);
  } catch (err) {
    try {
      remove(tmp, { force: true });
    } catch {
      // Cleanup is best-effort; preserve the original write/rename failure.
    }
    throw err;
  }
}
