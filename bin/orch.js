#!/usr/bin/env node
import { main } from "../src/cli.js";
import { renderHelp } from "../src/schema.js";
main(process.argv.slice(2)).catch((err) => {
  console.error(`orch: ${err.message}`);
  // Usage errors exit 64 (sysexits EX_USAGE) and blocked runs 3, so a script
  // can tell "you typed it wrong" and "capacity/policy said no" apart from the
  // catch-all 1. An unrecognised command also gets the usage text, on stderr.
  if (err.showUsage) console.error(renderHelp());
  process.exit(err.exit || 1);
});
