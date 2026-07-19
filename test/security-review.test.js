import { test } from "node:test";
import assert from "node:assert/strict";
import { scanDiff, formatSecurityFindings } from "../src/security-review.js";

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
