#!/usr/bin/env node
import { main } from "../src/cli.js";
import { EXIT_CODES } from "../src/exit-codes.js";
import { renderHelp } from "../src/schema.js";
main(process.argv.slice(2)).catch((err) => {
  console.error(`orch: ${err.message}`);
  // Usage errors exit 64 (sysexits EX_USAGE); run outcomes use the shared table
  // so a script can distinguish capacity, policy, and unexpected failures.
  if (err.showUsage || err.helpFor) console.error(renderHelp(err.helpFor));
  process.exit(err.exit || EXIT_CODES.ERROR);
});
