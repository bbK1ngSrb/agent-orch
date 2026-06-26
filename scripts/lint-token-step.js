// §3g: structural invariant — the write token never coexists with authored-code
// execution in one job. Pure rule (lintWorkflow) + thin CLI. Residual #5: this
// lint is load-bearing; a regression silently reopens the exfil hole.
import { readFileSync } from "node:fs";
import { parse } from "yaml";

const AUTHORED_RUN = /\bnpm\s+test\b|\bnode\s+--test\b|bin\/orch\.js|\borch\s+(task|review|pr)\b|\bgate\.run\b/;
const TOKEN_SECRET = /secrets\.GITHUB_TOKEN|secrets\.GH_TOKEN|\bGH_TOKEN\b/;

function jobIsTokenBearing(job) {
  const perms = job.permissions || {};
  if (perms.contents === "write" || perms["pull-requests"] === "write") return true;
  for (const step of job.steps || []) {
    if (TOKEN_SECRET.test(step.run || "")) return true;
  }
  return false;
}

function jobRunsAuthoredCode(job) {
  for (const step of job.steps || []) {
    if (AUTHORED_RUN.test(step.run || "")) return true;
    // A checkout of any ref other than main pulls attacker-controlled code in.
    const uses = step.uses || "";
    if (uses.includes("actions/checkout")) {
      const ref = step.with && step.with.ref;
      if (ref && ref !== "main") return true;
    }
  }
  return false;
}

export function lintWorkflow(workflowObj) {
  const violations = [];
  const jobs = (workflowObj && workflowObj.jobs) || {};
  for (const [name, job] of Object.entries(jobs)) {
    if (jobIsTokenBearing(job) && jobRunsAuthoredCode(job)) {
      violations.push(`job "${name}": holds write token AND runs authored code`);
    }
  }
  return { ok: violations.length === 0, violations };
}

function main(argv) {
  const files = argv.slice(2);
  let bad = false;
  for (const f of files) {
    const { ok, violations } = lintWorkflow(parse(readFileSync(f, "utf8")));
    if (!ok) {
      bad = true;
      for (const v of violations) process.stderr.write(`${f}: ${v}\n`);
    }
  }
  if (bad) process.exit(1);
  process.stdout.write("token-step invariant: ok\n");
}

// Run as a CLI only when invoked directly, never on import (keeps the rule pure).
if (import.meta.url === `file://${process.argv[1]}`) main(process.argv);
