import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanDiff, formatSecurityFindings, parseRawPaths, SECURITY_DIFF_ARGS, SECURITY_RAW_ARGS } from "../src/security-review.js";
import { git } from "../src/git.js";

const clean = `--- a/src/config.js
+++ b/src/config.js
@@ -1,3 +1,4 @@
 export function load() {
+  return { ok: true };
 }`;

test("clean diff → AGREE", () => {
  const r = scanDiff(clean);
  assert.equal(r.decision, "AGREE");
  assert.deepEqual(r.findings, []);
});

test("reading process.env → DISAGREE", () => {
  const d = `+++ b/src/x.js\n+  const k = process.env.GITHUB_TOKEN;`;
  const r = scanDiff(d);
  assert.equal(r.decision, "DISAGREE");
  assert.ok(r.findings.some((f) => f.rule === "env-read"));
});

test("opening network → DISAGREE", () => {
  for (const snippet of [
    `+  const res = await fetch("http://evil.test");`,
    `+  import net from "node:net";`,
    `+  require("https").get(url);`,
  ]) {
    const r = scanDiff(`+++ b/src/x.js\n${snippet}`);
    assert.equal(r.decision, "DISAGREE", snippet);
  }
});

test("spawning a subprocess → DISAGREE", () => {
  const d = `+++ b/test/x.test.js\n+  const { execSync } = require("child_process");`;
  assert.equal(scanDiff(d).decision, "DISAGREE");
});

test("bare exec()/spawn() calls still flagged (subprocess)", () => {
  for (const snippet of [
    `+  exec("rm -rf /");`,
    `+  spawn("sh", ["-c", cmd]);`,
  ]) {
    const r = scanDiff(`+++ b/src/x.js\n${snippet}`);
    assert.equal(r.decision, "DISAGREE", snippet);
    assert.ok(r.findings.some((f) => f.rule === "subprocess"), snippet);
  }
});

test("aliased child_process calls (cp.exec/child.spawn) still flagged (subprocess)", () => {
  for (const snippet of [
    `+  cp.exec("rm -rf /", cb);`,
    `+  child.spawn("sh", ["-c", cmd]);`,
  ]) {
    const r = scanDiff(`+++ b/src/x.js\n${snippet}`);
    assert.equal(r.decision, "DISAGREE", snippet);
    assert.ok(r.findings.some((f) => f.rule === "subprocess"), snippet);
  }
});

// --- fix: RegExp#exec() false positive ---
test("RegExp#exec() and String#match-style .exec() do not trip subprocess rule", () => {
  const d = `+++ b/test/cli.test.js
+  const re = /"([^"]*)"|'([^']*)'|\\S+/g;
+  let m;
+  while ((m = re.exec(body))) tokens.push(m[1] ?? m[2] ?? m[0]);`;
  const r = scanDiff(d);
  assert.equal(r.decision, "AGREE");
  assert.deepEqual(r.findings, []);
});

test("receiver-name aliasing (re.exec/regex.exec) without a regex-literal assignment is still flagged", () => {
  for (const snippet of [
    `+  re.exec(command);`,
    `+  regex.exec(command);`,
    `+  matcher.exec(body);`,
    `+  tokenPattern.exec(input);`,
  ]) {
    const r = scanDiff(`+++ b/src/x.js\n${snippet}`);
    assert.equal(r.decision, "DISAGREE", snippet);
    assert.ok(r.findings.some((f) => f.rule === "subprocess"), snippet);
  }
});

test("ignores removed and context lines", () => {
  const d = `+++ b/src/x.js
-  const k = process.env.SECRET;
   const y = fetch(url);`;
  // The env read is a '-' removal; fetch is a context line (leading space).
  assert.equal(scanDiff(d).decision, "AGREE");
});

test("does not flag the +++ file header itself", () => {
  const d = `+++ b/src/process.env.helper.js\n+  return 1;`;
  assert.equal(scanDiff(d).decision, "AGREE");
});

// --- FIX 4: secret-read rule ---
test("reading .orch/ creds → DISAGREE (secret-read)", () => {
  const d = `+++ b/src/x.js\n+  const k = readFileSync(".orch/last-author");`;
  const r = scanDiff(d);
  assert.equal(r.decision, "DISAGREE");
  assert.ok(r.findings.some((f) => f.rule === "secret-read"));
});

test("reading .ssh private key → DISAGREE (secret-read)", () => {
  const d = `+++ b/src/x.js\n+  fs.readFileSync("/home/u/.ssh/id_rsa");`;
  const r = scanDiff(d);
  assert.equal(r.decision, "DISAGREE");
  assert.ok(r.findings.some((f) => f.rule === "secret-read"));
});

test("reading a dotenv file → DISAGREE (secret-read)", () => {
  const d = `+++ b/src/x.js\n+  const k = readFileSync(".env");`;
  const r = scanDiff(d);
  assert.equal(r.decision, "DISAGREE");
  assert.ok(r.findings.some((f) => f.rule === "secret-read"));
});

test("reading a dotenv variant path → DISAGREE (secret-read)", () => {
  const d = `+++ b/src/x.js\n+  const k = readFileSync("../.env.production");`;
  const r = scanDiff(d);
  assert.equal(r.decision, "DISAGREE");
  assert.ok(r.findings.some((f) => f.rule === "secret-read"));
});

test("reading from a credentials directory → DISAGREE (secret-read)", () => {
  const d = `+++ b/src/x.js\n+  const k = readFileSync("credentials/token");`;
  const r = scanDiff(d);
  assert.equal(r.decision, "DISAGREE");
  assert.ok(r.findings.some((f) => f.rule === "secret-read"));
});

test("template-literal env access does NOT trip secret-read (env-read only)", () => {
  const d = "+++ b/src/x.js\n+  log(`env=${process.env.NODE_ENV}`);";
  const r = scanDiff(d);
  assert.equal(r.decision, "DISAGREE");
  assert.ok(r.findings.some((f) => f.rule === "env-read"));
  assert.ok(!r.findings.some((f) => f.rule === "secret-read"));
});

// --- FIX 4: guardrail-touch rule ---
test("writing to a workflow file → DISAGREE (guardrail-touch)", () => {
  const d = `+++ b/src/x.js\n+  fs.writeFileSync(".github/workflows/ci.yml", x);`;
  const r = scanDiff(d);
  assert.equal(r.decision, "DISAGREE");
  assert.ok(r.findings.some((f) => f.rule === "guardrail-touch"));
});

test("patching CODEOWNERS → DISAGREE (guardrail-touch)", () => {
  const d = `+++ b/src/x.js\n+  patch("CODEOWNERS");`;
  const r = scanDiff(d);
  assert.equal(r.decision, "DISAGREE");
  assert.ok(r.findings.some((f) => f.rule === "guardrail-touch"));
});

// --- docs-path skip: prose mentioning secret paths must not false-positive ---
test("markdown mentioning .orch/orch.yml → AGREE (docs-only, no secret-read)", () => {
  const d = `+++ b/docs/orch-manual.md
+Appends an agent to the \`.orch/orch.yml\` rotation pool, adding it as a new item (\`- name\`).`;
  const r = scanDiff(d);
  assert.equal(r.decision, "AGREE");
  assert.deepEqual(r.findings, []);
});

test("README.md mentioning .ssh/id_rsa and process.env → AGREE", () => {
  const d = `+++ b/README.md
+Set up SSH with \`~/.ssh/id_rsa\` and never commit process.env secrets.`;
  const r = scanDiff(d);
  assert.equal(r.decision, "AGREE");
  assert.deepEqual(r.findings, []);
});

test("mixed diff: docs mention OK, code secret-read still DISAGREE", () => {
  const d = `+++ b/docs/orch-manual.md
+Documents \`.orch/orch.yml\` for operators.
+++ b/src/x.js
+  const k = readFileSync(".orch/last-author");`;
  const r = scanDiff(d);
  assert.equal(r.decision, "DISAGREE");
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].rule, "secret-read");
  assert.match(r.findings[0].line, /last-author/);
});

test("nested **/*.md path (src/nested/y.md) is docs-skipped", () => {
  const d = `+++ b/src/nested/y.md
+See \`.orch/orch.yml\` and PRIVATE KEY handling.`;
  assert.equal(scanDiff(d).decision, "AGREE");
});

// --- formatSecurityFindings: dedupe, group, clip, summarize -----------------
test("formatSecurityFindings dedupes, groups by rule, and counts", () => {
  const findings = [
    { rule: "secret-read", line: "read .orch/x" },
    { rule: "secret-read", line: "read .orch/x" }, // dupe → collapsed
    { rule: "secret-read", line: "read .ssh/id_rsa" },
    { rule: "env-read", line: "process.env.TOKEN" },
  ];
  const { summary, detail } = formatSecurityFindings(findings);
  assert.equal(summary, "security scan blocked the merge — 3 findings (secret-read ×2, env-read ×1)");
  assert.match(detail, /\*\*secret-read\*\*/);
  assert.match(detail, /\*\*env-read\*\*/);
  // dupe appears once
  assert.equal((detail.match(/read \.orch\/x/g) || []).length, 1);
});

test("formatSecurityFindings clips long lines and caps per-rule with a +N more", () => {
  const findings = Array.from({ length: 8 }, (_, i) => ({ rule: "network", line: `fetch call ${i}` }));
  findings.push({ rule: "network", line: "x".repeat(200) });
  const { summary, detail } = formatSecurityFindings(findings, { maxPerRule: 5, maxLen: 40 });
  assert.match(summary, /network ×9/);
  assert.match(detail, /…and 4 more/);       // 9 unique, 5 shown
  assert.ok(!detail.includes("x".repeat(60))); // long line was clipped
});

test("formatSecurityFindings singularizes a lone finding", () => {
  const { summary } = formatSecurityFindings([{ rule: "subprocess", line: "execSync(x)" }]);
  assert.equal(summary, "security scan blocked the merge — 1 finding (subprocess ×1)");
});

// --- recommendation: verdict computed from the flagged files ----------------
test("scanDiff threads the file path into each finding", () => {
  const d = `+++ b/src/x.js\n+  const k = readFileSync(".orch/last-author");`;
  const r = scanDiff(d);
  assert.equal(r.findings[0].file, "src/x.js");
});

test("recommends merge-by-hand when every finding is in a test fixture", () => {
  const findings = [
    { rule: "secret-read", line: "read .orch/x", file: "test/security-review.test.js" },
    { rule: "env-read", line: "process.env.X", file: "test/cli.test.js" },
  ];
  const { detail } = formatSecurityFindings(findings, { mergeCmd: "gh pr merge 328 --squash --admin" });
  assert.match(detail, /likely a \*\*false positive\*\*/);
  assert.match(detail, /gh pr merge 328 --squash --admin/);
});

test("recommends inspection when a real code path is flagged", () => {
  const findings = [
    { rule: "secret-read", line: "read .orch/x", file: "test/x.test.js" },
    { rule: "secret-read", line: "readFileSync('.orch/last-author')", file: "src/engine.js" },
  ];
  const { detail } = formatSecurityFindings(findings);
  assert.match(detail, /inspect before merging/);
  assert.match(detail, /`src\/engine\.js`/);
  assert.ok(!detail.includes("false positive"));
});

test("an unknown-file finding (no +++ header) errs toward inspection", () => {
  const { detail } = formatSecurityFindings([{ rule: "network", line: "fetch(x)", file: null }]);
  assert.match(detail, /inspect before merging/);
});

// #334: security.ignore — committed build artifacts (minified bundles) can be
// deliberately exempted; everything else stays scanned, fail-closed.
test("ignore glob exempts a matching file's findings", () => {
  const d = `+++ b/dist/bundle.min.js\n+var a=/x/;a.exec(l);r.exec(s);`;
  assert.equal(scanDiff(d).decision, "DISAGREE"); // default: no ignores
  const r = scanDiff(d, { ignore: ["dist/**"] });
  assert.equal(r.decision, "AGREE");
  assert.deepEqual(r.findings, []);
});

test("ignore glob does not exempt non-matching files", () => {
  const d = [
    `+++ b/dist/bundle.min.js`,
    `+r.exec(s);`,
    `+++ b/src/x.js`,
    `+const k = process.env.GITHUB_TOKEN;`,
  ].join("\n");
  const r = scanDiff(d, { ignore: ["dist/**"] });
  assert.equal(r.decision, "DISAGREE");
  assert.deepEqual(r.findings.map((f) => f.file), ["src/x.js"]);
});

test("unknown-path lines (no +++ b/ header) are never ignorable", () => {
  const d = `--- a/whatever\n+r.exec(s);`;
  const r = scanDiff(d, { ignore: ["**"] });
  assert.equal(r.decision, "DISAGREE");
});

// --- #345: path-based guardrail floor ---------------------------------------
test("guardrail file flagged by PATH even with no trigger string in added lines", () => {
  const d = `--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -1,2 +1,3 @@
 on: push
+  trap 'echo failed' ERR`;
  const r = scanDiff(d);
  assert.equal(r.decision, "DISAGREE");
  assert.ok(r.findings.some((f) => f.rule === "guardrail-touch" && f.file === ".github/workflows/ci.yml"));
});

test("CODEOWNERS flagged at all three GitHub-valid locations", () => {
  for (const p of ["CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"]) {
    const d = `--- a/${p}\n+++ b/${p}\n@@ -1 +1 @@\n+* @bbk1ng`;
    const r = scanDiff(d);
    assert.equal(r.decision, "DISAGREE", p);
    assert.ok(r.findings.some((f) => f.rule === "guardrail-touch" && f.file === p), p);
  }
});

test("docs exemption does not swallow docs/CODEOWNERS (path scan × docs skip interaction)", () => {
  // Content would be docs-skipped; the path-based floor must still fire.
  const d = `--- a/docs/CODEOWNERS\n+++ b/docs/CODEOWNERS\n@@ -1 +1 @@\n+* @bbk1ng`;
  const r = scanDiff(d);
  assert.equal(r.decision, "DISAGREE");
  assert.deepEqual(r.findings, [{ rule: "guardrail-touch", line: "guardrail path changed", file: "docs/CODEOWNERS" }]);
  // …while ordinary docs stay exempt.
  const docs = `--- a/docs/guide.md\n+++ b/docs/guide.md\n@@ -1 +1 @@\n+See \\.orch/orch.yml.`;
  assert.equal(scanDiff(docs).decision, "AGREE");
});

test("guardrail DELETION (no added lines) is still flagged", () => {
  const d = `--- a/.github/workflows/ci.yml
+++ /dev/null
@@ -1,2 +0,0 @@
-on: push
-jobs: {}`;
  const r = scanDiff(d);
  assert.equal(r.decision, "DISAGREE");
  assert.ok(r.findings.some((f) => f.rule === "guardrail-touch" && f.file === ".github/workflows/ci.yml"));
});

test("pure rename of a guardrail file (100% similarity, no ---/+++ headers) is flagged", () => {
  const d = `diff --git a/.github/workflows/ci.yml b/.github/workflows/ci2.yml
similarity index 100%
rename from .github/workflows/ci.yml
rename to .github/workflows/ci2.yml`;
  const r = scanDiff(d);
  assert.equal(r.decision, "DISAGREE");
  // BOTH sides matter: renaming a workflow away detaches a required check just
  // as surely as renaming one in.
  for (const p of [".github/workflows/ci.yml", ".github/workflows/ci2.yml"]) {
    assert.ok(r.findings.some((f) => f.rule === "guardrail-touch" && f.file === p), p);
  }
});

test("rename OUT of a guardrail path is flagged from the old side alone", () => {
  const d = `diff --git a/.github/workflows/ci.yml b/tmp/ci.yml
similarity index 100%
rename from .github/workflows/ci.yml
rename to tmp/ci.yml`;
  const r = scanDiff(d);
  assert.equal(r.decision, "DISAGREE");
  assert.deepEqual(r.findings, [
    { rule: "guardrail-touch", line: "guardrail path changed", file: ".github/workflows/ci.yml" },
  ]);
});

test("mode-only change to a guardrail file (no ---/+++ headers) is flagged", () => {
  const d = `diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml
old mode 100644
new mode 100755`;
  const r = scanDiff(d);
  assert.equal(r.decision, "DISAGREE");
  assert.deepEqual(r.findings, [
    { rule: "guardrail-touch", line: "guardrail path changed", file: ".github/workflows/ci.yml" },
  ]);
});

// Real `git diff` output: git C-quotes each side of the `diff --git` line
// independently, so a non-ASCII path arrives as `"a/…" "b/…"` — and a mode-only
// change emits no `---`/`+++` and no rename lines, leaving that one line as the
// only record of the path.
test("mode-only change to a QUOTED (non-ASCII) guardrail path is flagged", () => {
  const d = `diff --git "a/.github/workflows/caf\\303\\251.yml" "b/.github/workflows/caf\\303\\251.yml"
old mode 100644
new mode 100755`;
  const r = scanDiff(d);
  assert.equal(r.decision, "DISAGREE");
  assert.deepEqual(r.findings, [
    { rule: "guardrail-touch", line: "guardrail path changed", file: ".github/workflows/café.yml" },
  ]);
});

// A path containing a literal ` b/` makes git's `diff --git` line ambiguous:
// no single split point is right for every case. Trying EVERY ` b/` position
// as the split puts the true path among the candidates, so a mode-only change
// to such a guardrail file can no longer mis-split its way to AGREE.
test("mode-only change to a guardrail path containing a literal ' b/' is flagged", () => {
  const d = `diff --git a/.github/workflows/x b/ci.yml b/.github/workflows/x b/ci.yml
old mode 100644
new mode 100755`;
  const r = scanDiff(d);
  assert.equal(r.decision, "DISAGREE");
  assert.deepEqual(r.findings, [
    { rule: "guardrail-touch", line: "guardrail path changed", file: ".github/workflows/x b/ci.yml" },
  ]);
});

// …and the same ambiguity on an ORDINARY path must not over-flag: none of the
// candidate splits is a guardrail path, so the change stays AGREE.
test("mode-only change to an ordinary path containing ' b/' stays AGREE", () => {
  const d = `diff --git a/src/x b/y.js b/src/x b/y.js
old mode 100644
new mode 100755`;
  assert.equal(scanDiff(d).decision, "AGREE");
});

// A copy does NOT modify its source, so `copy from <guardrail path>` must not
// trip the floor — unlike `rename from`, where the old path really did change.
test("copying a guardrail file OUT to an ordinary path stays AGREE", () => {
  const d = `diff --git "a/.github/workflows/caf\\303\\251.yml" b/tmp-ci.yml
old mode 100755
new mode 100644
similarity index 100%
copy from ".github/workflows/caf\\303\\251.yml"
copy to tmp-ci.yml`;
  assert.equal(scanDiff(d).decision, "AGREE");
});

// A PARTIAL copy (<100% similarity) does emit `---`/`+++`, so the pre-existing
// header scan still flags the source. That FP is out of scope here — the header
// path predates the structural parse and errs toward escalation — but pin it so
// the difference between the two copy forms is visible rather than assumed.
test("partial copy out of a guardrail path still trips the pre-existing header scan", () => {
  const d = `diff --git "a/.github/workflows/caf\\303\\251.yml" b/tmp-ci.yml
similarity index 80%
copy from ".github/workflows/caf\\303\\251.yml"
copy to tmp-ci.yml
--- "a/.github/workflows/caf\\303\\251.yml"
+++ b/tmp-ci.yml
@@ -6,3 +6,4 @@ jobs:
       - run: echo bye
+      - run: echo extra`;
  const r = scanDiff(d);
  assert.equal(r.decision, "DISAGREE");
  assert.deepEqual(r.findings, [
    { rule: "guardrail-touch", line: "guardrail path changed", file: ".github/workflows/café.yml" },
  ]);
});

// …but the suppression must not swallow the destination: copying a file INTO a
// guardrail path adds a live workflow and still has to be flagged.
test("copying an ordinary file INTO a guardrail path is flagged", () => {
  const d = `diff --git a/src/a.js b/.github/workflows/copied.yml
similarity index 100%
copy from src/a.js
copy to .github/workflows/copied.yml`;
  const r = scanDiff(d);
  assert.equal(r.decision, "DISAGREE");
  assert.deepEqual(r.findings, [
    { rule: "guardrail-touch", line: "guardrail path changed", file: ".github/workflows/copied.yml" },
  ]);
});

test("renaming an ordinary file stays AGREE", () => {
  const d = `diff --git a/src/a.js b/src/b.js
similarity index 100%
rename from src/a.js
rename to src/b.js`;
  assert.equal(scanDiff(d).decision, "AGREE");
});

test("quoted (non-ASCII) guardrail path header is still flagged", () => {
  const d = `--- "a/.github/workflows/caf\\303\\251.yml"
+++ "b/.github/workflows/caf\\303\\251.yml"
@@ -1 +1,2 @@
 on: push
+  trap 'echo failed' ERR`;
  const r = scanDiff(d);
  assert.equal(r.decision, "DISAGREE");
  assert.ok(r.findings.some((f) => f.rule === "guardrail-touch" && f.file === ".github/workflows/café.yml"));
});

test("path floor does not over-match guardrail names in arbitrary directories", () => {
  for (const p of ["examples/CODEOWNERS", "sub/orch-pr.yml", "fixtures/workflows/ci.yml"]) {
    const d = `--- a/${p}\n+++ b/${p}\n@@ -1 +1 @@\n+plain text, no risky strings`;
    assert.equal(scanDiff(d).decision, "AGREE", p);
  }
});

// Guardrail paths whose names contain line terminators: text headers cannot
// carry them (split on \n), but rawPaths from `git diff --raw -z` can. ** must
// match those bytes or the floor returns AGREE for a real protected-path touch.
test("rawPaths: protected path with line terminators → guardrail-touch", () => {
  for (const p of [
    ".github/workflows/a\nb.yml",
    ".github/workflows/a\rb.yml",
    ".github/workflows/a\u2028b.yml",
    ".github/workflows/a\u2029b.yml",
  ]) {
    const r = scanDiff("", { rawPaths: [p] });
    assert.equal(r.decision, "DISAGREE", JSON.stringify(p));
    assert.ok(r.findings.some((f) => f.rule === "guardrail-touch" && f.file === p), JSON.stringify(p));
  }
});

test("path-based guardrail finding is not exempted by security.ignore", () => {
  const d = `--- a/CODEOWNERS\n+++ b/CODEOWNERS\n@@ -1 +1 @@\n+* @bbk1ng`;
  assert.equal(scanDiff(d, { ignore: ["CODEOWNERS", "**"] }).decision, "DISAGREE");
});

// --- #345 / #365: rank real edits above fixtures, tag each line with its file
test("formatSecurityFindings ranks a guardrail-path hit above a fixture-only mention", () => {
  const findings = [
    { rule: "guardrail-touch", line: "mention of .github/workflows/x.yml in a fixture", file: "test/x.test.js" },
    { rule: "guardrail-touch", line: "guardrail path changed", file: ".github/workflows/x.yml" },
  ];
  const { detail } = formatSecurityFindings(findings);
  const iReal = detail.indexOf("`.github/workflows/x.yml`: guardrail path changed");
  const iFixture = detail.indexOf("`test/x.test.js` (fixture):");
  assert.ok(iReal !== -1, "guardrail hit tagged with its file");
  assert.ok(iFixture !== -1, "fixture hit tagged with its file + (fixture)");
  assert.ok(iReal < iFixture, "guardrail hit surfaces above the fixture");
});

test("formatSecurityFindings ranks authored code above test fixtures", () => {
  const findings = [
    { rule: "secret-read", line: "read .orch/x", file: "test/x.test.js" },
    { rule: "secret-read", line: "readFileSync('.orch/last-author')", file: "src/engine.js" },
  ];
  const { detail } = formatSecurityFindings(findings);
  assert.ok(detail.indexOf("`src/engine.js`:") < detail.indexOf("`test/x.test.js` (fixture):"));
  // Authored paths are plain; test paths are marked so a nested `file:` in the
  // line body cannot be mistaken for the finding's location (#365).
  assert.match(detail, /`src\/engine\.js`:\s*readFileSync/);
  assert.match(detail, /`test\/x\.test\.js` \(fixture\):/);
  assert.ok(!detail.includes("`src/engine.js` (fixture):"));
});

// #365: secret-read still matches text, so fixtures fire — but the *location*
// must be the file the text lives in, and real reads must lead the report.
test("secret-read fixture lines attribute to the test file, not nested paths in the line", () => {
  // Real git-style outer diff of a test that embeds a mini-diff and a hand-built
  // finding object mentioning src/engine.js — the sharp edge from #365.
  const d = [
    "diff --git a/test/security-review.test.js b/test/security-review.test.js",
    "--- a/test/security-review.test.js",
    "+++ b/test/security-review.test.js",
    "@@ -1,0 +1,6 @@",
    "+test(\"mixed\", () => {",
    "+  const d = `+++ b/src/engine.js",
    "++  const k = readFileSync(\".orch/last-author\");`;",
    "+  const findings = [",
    "+    { rule: \"secret-read\", line: \"readFileSync('.orch/last-author')\", file: \"src/engine.js\" },",
    "+  ];",
    "+});",
  ].join("\n");
  const r = scanDiff(d);
  const secret = r.findings.filter((f) => f.rule === "secret-read");
  assert.ok(secret.length >= 1, "fixture text still trips secret-read (not suppressed)");
  for (const f of secret) {
    assert.equal(f.file, "test/security-review.test.js",
      `must attribute to the test file, got ${f.file} for line: ${f.line}`);
    assert.notEqual(f.file, "src/engine.js");
  }
  const { detail } = formatSecurityFindings(r.findings);
  assert.match(detail, /`test\/security-review\.test\.js` \(fixture\):/);
  // Location tag is the test file — never a bare `src/engine.js:` lead-in.
  assert.ok(!detail.includes("`src/engine.js`:"));
});

test("scanDiff+format: real secret-read leads fixture noise for the same rule", () => {
  const d = [
    "+++ b/src/engine.js",
    "+  const k = readFileSync(\".orch/last-author\");",
    "+++ b/test/security-review.test.js",
    "+  // See .orch/orch.yml in a docs-only example",
    "+  const probe = \"read .orch/x\";",
  ].join("\n");
  const r = scanDiff(d);
  assert.equal(r.decision, "DISAGREE");
  const secret = r.findings.filter((f) => f.rule === "secret-read");
  assert.ok(secret.some((f) => f.file === "src/engine.js"));
  assert.ok(secret.some((f) => f.file === "test/security-review.test.js"));
  const { detail } = formatSecurityFindings(r.findings);
  const iReal = detail.indexOf("`src/engine.js`:");
  const iFixture = detail.indexOf("`test/security-review.test.js` (fixture):");
  assert.ok(iReal !== -1, "real hit present");
  assert.ok(iFixture !== -1, "fixture hit present and marked");
  assert.ok(iReal < iFixture, "real secret-read surfaces above fixture mentions");
});

// Regression (real git): the parser trusts `a/`/`b/` prefixes, but `diff.noprefix=true`
// is valid config that drops them — a mode-only workflow change then emits only
// `diff --git .github/workflows/ci.yml .github/workflows/ci.yml`, matching no header
// and no `b/` side, so the floor would approve a guardrail edit. The producer must
// pin the prefixes with SECURITY_DIFF_ARGS.
test("SECURITY_DIFF_ARGS keeps the floor working under diff.noprefix", () => {
  const repo = mkdtempSync(join(tmpdir(), "orch-secdiff-"));
  git(["init", "-b", "main"], repo);
  git(["config", "user.email", "t@t"], repo);
  git(["config", "user.name", "t"], repo);
  git(["config", "diff.noprefix", "true"], repo);            // valid config, defeats a/ b/
  mkdirSync(join(repo, ".github/workflows"), { recursive: true });
  writeFileSync(join(repo, ".github/workflows/ci.yml"), "on: push\n");
  git(["add", "."], repo);
  git(["commit", "-m", "init"], repo);
  git(["switch", "-c", "feature"], repo);
  git(["update-index", "--chmod=+x", ".github/workflows/ci.yml"], repo);  // mode-only change
  git(["commit", "-m", "chmod"], repo);

  const unguarded = git(["diff", "main...feature"], repo);
  assert.equal(scanDiff(unguarded).decision, "AGREE", "documents the fail-open the flags close");

  const guarded = git(["diff", ...SECURITY_DIFF_ARGS, "main...feature"], repo);
  assert.equal(scanDiff(guarded).decision, "DISAGREE");
  assert.equal(scanDiff(guarded).findings[0].file, ".github/workflows/ci.yml");
});

// Regression (real git): `--no-ext-diff` does NOT disable textconv — a
// `.gitattributes` driver plus `diff.<driver>.textconv` filters file contents
// before diffing, so the content rules would scan the filter's output and an
// added `process.env.GITHUB_TOKEN` line disappears from the diff. The producer
// must pin `--no-textconv` via SECURITY_DIFF_ARGS.
test("SECURITY_DIFF_ARGS keeps the floor working under a textconv driver", () => {
  const repo = mkdtempSync(join(tmpdir(), "orch-secdiff-"));
  git(["init", "-b", "main"], repo);
  git(["config", "user.email", "t@t"], repo);
  git(["config", "user.name", "t"], repo);
  writeFileSync(join(repo, ".gitattributes"), "*.js diff=redact\n");
  git(["config", "diff.redact.textconv", "echo REDACTED"], repo);  // blanks file contents
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src/x.js"), "export const a = 1;\n");
  git(["add", "."], repo);
  git(["commit", "-m", "init"], repo);
  git(["switch", "-c", "feature"], repo);
  writeFileSync(join(repo, "src/x.js"), "export const a = 1;\nconst k = process.env.GITHUB_TOKEN;\n");
  git(["add", "."], repo);
  git(["commit", "-m", "add token read"], repo);

  const unguarded = git(["diff", "main...feature"], repo);
  assert.equal(scanDiff(unguarded).decision, "AGREE", "documents the fail-open the flag closes");

  const guarded = git(["diff", ...SECURITY_DIFF_ARGS, "main...feature"], repo);
  const r = scanDiff(guarded);
  assert.equal(r.decision, "DISAGREE");
  assert.ok(r.findings.some((f) => f.rule === "env-read" && f.file === "src/x.js"));
});

// ---- #383: the structural path source ---------------------------------------
// The five known text-parse bypasses (quoting, `diff.noprefix`, mnemonic
// prefixes, ext-diff/textconv drivers, a path containing the guessed ` b/`
// delimiter) all live in ONE job: which files did this diff touch. `--raw -z`
// answers that structurally — NUL-delimited records, explicit status code, raw
// unquoted path bytes — so none of those knobs can move the answer.

const rawRec = (status, ...paths) => `:100644 100644 aaaaaaa bbbbbbb ${status}\0${paths.join("\0")}\0`;

test("parseRawPaths reads every status code", () => {
  const raw = rawRec("M", "src/m.js") + rawRec("A", "src/a.js") + rawRec("D", "src/d.js")
    + rawRec("T", "src/t.js") + rawRec("R100", "old.yml", "new.yml") + rawRec("C75", "src.js", "copy.js");
  assert.deepEqual(parseRawPaths(raw),
    ["src/m.js", "src/a.js", "src/d.js", "src/t.js", "old.yml", "new.yml", "src.js", "copy.js"]);
});

test("parseRawPaths returns BOTH sides of a rename", () => {
  // Moving a workflow OUT of .github/workflows/ detaches a required check, so the
  // old path matters as much as the new one — the text parse only sees the b-side.
  const paths = parseRawPaths(rawRec("R100", ".github/workflows/ci.yml", "docs/ci.yml"));
  assert.deepEqual(paths, [".github/workflows/ci.yml", "docs/ci.yml"]);
});

test("parseRawPaths keeps spaces and non-ASCII bytes intact", () => {
  // This is what -z buys: the record delimiter is NUL, so git does not C-quote
  // the path and no space is a field boundary.
  const raw = rawRec("M", ".github/workflows/my ci.yml") + rawRec("M", ".github/workflows/café.yml");
  assert.deepEqual(parseRawPaths(raw), [".github/workflows/my ci.yml", ".github/workflows/café.yml"]);
});

test("parseRawPaths never throws on malformed or truncated input", () => {
  assert.deepEqual(parseRawPaths(""), []);
  assert.deepEqual(parseRawPaths(null), []);
  assert.deepEqual(parseRawPaths("not a raw record at all"), []);
  // A rename record cut off after the old path yields what parsed, no throw.
  assert.deepEqual(parseRawPaths(":100644 100644 aaa bbb R100\0old.yml"), ["old.yml"]);
});

test("rawPaths flags a guardrail path the text parse cannot see", () => {
  // Round-2 bypass, end to end on REAL git output: `diff.noprefix=true` is valid
  // repo config that drops the a//b/ prefixes the text parse requires, and the
  // change is mode-only so there are no ---/+++ headers either. The structural
  // read is immune to both.
  const repo = mkdtempSync(join(tmpdir(), "orch-secraw-"));
  git(["init", "-b", "main"], repo);
  git(["config", "user.email", "t@t"], repo);
  git(["config", "user.name", "t"], repo);
  git(["config", "diff.noprefix", "true"], repo);
  mkdirSync(join(repo, ".github/workflows"), { recursive: true });
  writeFileSync(join(repo, ".github/workflows/ci.yml"), "on: push\n");
  git(["add", "."], repo);
  git(["commit", "-m", "init"], repo);
  git(["switch", "-c", "feature"], repo);
  git(["update-index", "--chmod=+x", ".github/workflows/ci.yml"], repo);
  git(["commit", "-m", "chmod"], repo);

  const unguarded = git(["diff", "main...feature"], repo);
  assert.equal(scanDiff(unguarded).decision, "AGREE", "documents the fail-open rawPaths closes");

  const rawPaths = parseRawPaths(git(["diff", ...SECURITY_RAW_ARGS, "main...feature"], repo));
  const r = scanDiff(unguarded, { rawPaths });
  assert.equal(r.decision, "DISAGREE");
  assert.deepEqual(r.findings,
    [{ rule: "guardrail-touch", line: "guardrail path changed", file: ".github/workflows/ci.yml" }]);
});

test("rawPaths and the text parse are UNIONed and deduped", () => {
  const text = `--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -1 +1,2 @@
 on: push
+  # tweak`;
  const r = scanDiff(text, { rawPaths: [".github/workflows/ci.yml", ".github/workflows/release.yml"] });
  const touch = r.findings.filter((f) => f.rule === "guardrail-touch");
  assert.equal(touch.length, 2, "the shared path yields one finding, not two");
  assert.deepEqual(touch.map((f) => f.file).sort(),
    [".github/workflows/ci.yml", ".github/workflows/release.yml"]);
  // A non-guardrail raw path is not a finding on its own — the floor is path-scoped.
  assert.deepEqual(scanDiff("", { rawPaths: ["src/x.js"] }).findings, []);
});

test("omitting rawPaths leaves scanDiff byte-identical to the text-only floor", () => {
  const text = `--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -1 +1,3 @@
 on: push
+  run: echo $GITHUB_TOKEN
+++ b/src/x.js
+  await fetch("http://evil.test");`;
  const expected = [
    { rule: "guardrail-touch", line: "guardrail path changed", file: ".github/workflows/ci.yml" },
    { rule: "env-read", line: "run: echo $GITHUB_TOKEN", file: ".github/workflows/ci.yml" },
    { rule: "network", line: 'await fetch("http://evil.test");', file: "src/x.js" },
  ];
  assert.deepEqual(scanDiff(text).findings, expected);
  assert.deepEqual(scanDiff(text, { ignore: [] }).findings, expected);
  assert.deepEqual(scanDiff(text, { rawPaths: [] }).findings, expected);
});

test("a real git rename yields BOTH sides through rawPaths", () => {
  // #364's originating case, on real git output: a 100%-similarity move of a
  // workflow file. Asserting the parsed paths (not just the findings) means a
  // desync in the R-record layout shows up here rather than silently eating the
  // NEXT record — the fail-open this whole change exists to close.
  const repo = mkdtempSync(join(tmpdir(), "orch-secraw-mv-"));
  git(["init", "-b", "main"], repo);
  git(["config", "user.email", "t@t"], repo);
  git(["config", "user.name", "t"], repo);
  mkdirSync(join(repo, ".github/workflows"), { recursive: true });
  mkdirSync(join(repo, "docs"), { recursive: true });
  writeFileSync(join(repo, ".github/workflows/ci.yml"), "on: push\njobs: {}\n");
  writeFileSync(join(repo, "docs/keep.md"), "x\n");
  git(["add", "."], repo);
  git(["commit", "-m", "init"], repo);
  git(["switch", "-c", "feature"], repo);
  git(["mv", ".github/workflows/ci.yml", "docs/ci.yml"], repo);
  git(["commit", "-m", "move the workflow out"], repo);

  const rawPaths = parseRawPaths(git(["diff", ...SECURITY_RAW_ARGS, "main...feature"], repo));
  assert.deepEqual(rawPaths.sort(), [".github/workflows/ci.yml", "docs/ci.yml"]);
  const r = scanDiff(git(["diff", ...SECURITY_DIFF_ARGS, "main...feature"], repo), { rawPaths });
  assert.equal(r.decision, "DISAGREE");
  assert.ok(r.findings.some((f) => f.file === ".github/workflows/ci.yml"), "old path flagged");
});
