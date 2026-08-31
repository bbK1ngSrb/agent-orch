#!/usr/bin/env node
// Success-metric audit: node scripts/v2-metrics.mjs [.orch dir] [--json]
//
// The CLI v2 programme (docs/cli-v2-proposal.md §7) was justified by one
// number: how many runs finish unattended. This script measures it, because
// nothing else can — the dashboard's `cleanUnattendedCycles` in `kpi.json` is a
// consecutive STREAK reset by every escalation, so it answers "how many in a
// row right now", not "how many out of how many".
//
// It reads two stores and joins them:
//   .orch/run-records/*.json  one file per RUN — outcome, exit, readiness, human
//   .orch/runs.jsonl          one line per CYCLE — verdict, tokens, cost
//
// Three measures, straight from proposal §7:
//
//   clean unattended (criterion 1) — `outcome === "reached"` and the run asked
//     a human nothing (`human.replies` empty). A run that reached its goal only
//     after someone replied on GitHub is a success, but not an unattended one.
//
//   false ready / false merged (criterion 2) — a run that exited 0 without the
//     evidence that would justify it: no readiness observation, or, for a
//     `--until merged` run, no verified-ancestor merge commit. "Zero" is the
//     target; anything
//     above it means orch reported success it did not verify, which is the one
//     failure mode a loop must never have. Runs on a repo with no remote to
//     read are counted apart (`localReady`) rather than blamed for it.
//
//   duplicate merge requests (criterion 3) — `merge.requests[]` ordinals must
//     be contiguous from 1. A gap or repeat means a retry re-requested a merge
//     that GitHub had already accepted.
//
// Exit code is 0 unless a false ready/merged or a duplicate request is found:
// this is an audit, and a violated invariant should fail a pipeline.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const json = args.includes("--json");
const orchDir = args.find((a) => !a.startsWith("--")) || ".orch";

function runRecords(dir) {
  let names = [];
  try {
    names = readdirSync(join(dir, "run-records")).filter((n) => n.endsWith(".json"));
  } catch { return []; }
  return names.flatMap((name) => {
    try {
      return [JSON.parse(readFileSync(join(dir, "run-records", name), "utf8"))];
    } catch {
      // A half-written record is a corrupt sample, not a reason to abandon the
      // audit — the same self-heal stance sid-store.js takes on read.
      return [];
    }
  });
}

function cycles(dir) {
  let text = "";
  try { text = readFileSync(join(dir, "runs.jsonl"), "utf8"); } catch { return []; }
  return text.split("\n").filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

// A run is unattended if it never consumed a human reply. `human` exists as
// soon as orch ASKED, so the question is whether anyone answered.
const unattended = (record) => !(record.human?.replies?.length > 0);

// design §16: the observation the run controller stores on a green terminal.
// `remoteGate: false` means there was no remote to read, which is a different
// claim from "we exited 0 without looking".
const observed = (record) => Boolean(record.readiness && record.readiness.ready);
const localOnly = (record) => record.readiness?.remoteGate === false;
// A merge commit oid alone is only GitHub's word for it. The proof a `merged`
// run owes is ANCESTRY: `verifiedAncestorAt` is stamped by landing.js only
// after `git merge-base --is-ancestor <mergeCommit> origin/<base>` has passed
// (landing.js:85-117). Accepting the oid on its own would let a record that
// never ran that check audit clean — the one thing this measure exists to
// catch. Both are required: an ancestry stamp with nothing to point at is
// equally unproven.
const mergeProof = (record) => Boolean(record.merge?.mergeCommit && record.merge?.verifiedAncestorAt);

function ordinalsContiguous(requests = []) {
  return requests.every((request, index) => Number(request.ordinal) === index + 1);
}

export function audit(dir = ".orch") {
  const records = runRecords(dir);
  const lines = cycles(dir);
  const terminal = records.filter((r) => r.outcome);
  const reached = terminal.filter((r) => r.outcome === "reached");
  const green = terminal.filter((r) => r.exit === 0);

  const falseReady = [];
  const falseMerged = [];
  const localReady = [];
  for (const record of green) {
    // Anything that landed owes ancestry proof, whatever else it claims. Keyed
    // on the merge commit as well as the policy because `policy` is nullable
    // (`run-record.js:29`) and only ever copied forward from a record that
    // already had one, so a policy-less record must not slip the check.
    const merged = record.policy?.until === "merged" || Boolean(record.merge?.mergeCommit);
    // The proof test runs FIRST. A base landing (integration === base) exits 0
    // with `LOCAL_OBSERVATION`, whose `remoteGate: false` is not a statement
    // about ancestry — landing.js:262 returns `merged` without verifying any
    // (#636). Bucketing on that first would let an unproven landing audit
    // clean, which is the one thing this measure exists to catch.
    if (merged && !mergeProof(record)) { falseMerged.push(record.runId); continue; }
    if (localOnly(record)) { localReady.push(record.runId); continue; }
    if (!observed(record)) { (merged ? falseMerged : falseReady).push(record.runId); continue; }
  }

  const duplicateMergeRequests = terminal
    .filter((r) => r.merge?.requests && !ordinalsContiguous(r.merge.requests))
    .map((r) => r.runId);

  const readyRuns = terminal.filter((r) => (r.policy?.until || "once") === "ready");
  const cleanUnattended = reached.filter(unattended);

  return {
    orchDir: dir,
    runs: terminal.length,
    cycles: lines.length,
    reached: reached.length,
    cleanUnattended: cleanUnattended.length,
    // The §7 target is expressed over `--until ready` runs specifically.
    readyRuns: readyRuns.length,
    cleanUnattendedReadyRate: readyRuns.length
      ? Number((readyRuns.filter((r) => r.outcome === "reached" && unattended(r)).length / readyRuns.length).toFixed(3))
      : null,
    localReady: localReady.length,
    falseReady,
    falseMerged,
    duplicateMergeRequests,
    // Redrive lines (design §16) are cheap to count and tell you how often a
    // deferred peer had to be retried at all.
    redriveCycles: lines.filter((l) => l.redrive).length,
    ok: falseReady.length === 0 && falseMerged.length === 0 && duplicateMergeRequests.length === 0,
  };
}

// Importable (the test calls audit() directly) and runnable. ponytail: one
// flag, so argv is read by hand rather than through a parser.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = audit(orchDir);
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`orch v2 metrics — ${report.orchDir}`);
    console.log(`  runs (terminal):        ${report.runs}  (cycles recorded: ${report.cycles})`);
    console.log(`  reached goal:           ${report.reached}`);
    console.log(`  clean unattended:       ${report.cleanUnattended}`);
    console.log(`  --until ready rate:     ${report.cleanUnattendedReadyRate ?? "n/a"} over ${report.readyRuns} runs`);
    console.log(`  green, no remote gate:  ${report.localReady}`);
    console.log(`  redrive cycles:         ${report.redriveCycles}`);
    console.log(`  false ready:            ${report.falseReady.length ? report.falseReady.join(", ") : "none"}`);
    console.log(`  false merged:           ${report.falseMerged.length ? report.falseMerged.join(", ") : "none"}`);
    console.log(`  duplicate merge reqs:   ${report.duplicateMergeRequests.length ? report.duplicateMergeRequests.join(", ") : "none"}`);
  }
  process.exit(report.ok ? 0 : 1);
}
