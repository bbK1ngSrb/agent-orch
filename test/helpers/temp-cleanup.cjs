const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");

const temporaryDirectories = new Set();
const originalMkdtempSync = fs.mkdtempSync;

fs.mkdtempSync = (...args) => {
  const directory = originalMkdtempSync(...args);
  temporaryDirectories.add(directory);
  return directory;
};
syncBuiltinESMExports();

process.once("exit", () => {
  for (const directory of temporaryDirectories) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
    } catch {
      // Cleanup must not mask the test result.
    }
  }
});
