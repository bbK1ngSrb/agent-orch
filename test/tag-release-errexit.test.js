// #415: tag-release.yml must ABORT when scripts/release-tags.js exits nonzero.
// The regression it guards is a shell subtlety, not a logic error: `set -e` only
// reacts to a failing *simple command*, so feeding the loop from a substitution
// (`done <<< "$(node …)"`, or `done < <(node …)`) discards the exit code — the
// loop then reads an empty herestring, tags nothing, and the job goes green.
//
// So this runs the workflow's real `run:` block with `node` stubbed to fail, and
// asserts the block exits nonzero. A regex would only catch the one spelling;
// executing it catches any respelling that reintroduces the swallow.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

const WORKFLOW = new URL("../.github/workflows/tag-release.yml", import.meta.url);

function runBlock() {
  const wf = parse(readFileSync(WORKFLOW, "utf8"));
  const step = wf.jobs.tag.steps.find((s) => typeof s.run === "string");
  assert.ok(step, "tag-release.yml has a step with a run: block");
  return step.run;
}

// `git` is stubbed to succeed so the only thing that can fail is the script, and
// `node` to fail so it does. Both must be found before the real ones on PATH.
function stubDir(nodeExit) {
  const dir = mkdtempSync(join(tmpdir(), "tagrel-"));
  for (const [name, body] of [
    ["git", "#!/bin/sh\nexit 0\n"],
    ["node", `#!/bin/sh\necho "release-tags.js blew up" >&2\nexit ${nodeExit}\n`],
  ]) {
    const p = join(dir, name);
    writeFileSync(p, body);
    chmodSync(p, 0o755);
  }
  return dir;
}

function execBlock(nodeExit) {
  const dir = stubDir(nodeExit);
  return spawnSync("bash", ["-c", runBlock()], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, BEFORE: "0".repeat(40), AFTER: "f".repeat(40) },
    encoding: "utf8",
  });
}

test("a crashed release-tags.js fails the step instead of tagging nothing quietly",
  { skip: process.platform === "win32" ? "POSIX shell stubs" : false }, () => {
    const r = execBlock(7);
    // Hand-derived from the requirement: the step must not report success when the
    // script that decides what to tag never produced a list.
    assert.notEqual(r.status, 0, `expected nonzero exit, got ${r.status}\n${r.stdout}${r.stderr}`);
  });

test("the happy path still runs the loop",
  { skip: process.platform === "win32" ? "POSIX shell stubs" : false }, () => {
    const dir = stubDir(0); // node exits 0 printing nothing → empty list, no tags
    const r = spawnSync("bash", ["-c", runBlock()], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, BEFORE: "0".repeat(40), AFTER: "f".repeat(40) },
      encoding: "utf8",
    });
    assert.equal(r.status, 0, `expected clean exit, got ${r.status}\n${r.stdout}${r.stderr}`);
  });
