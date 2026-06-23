# agent-orch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a repo-agnostic, npx-installed CLI that runs two local coding agents (Claude, Codex) in an author→cross-audit→test-gate→local-merge loop on any git repo.

**Architecture:** A single Node (ESM) process per cycle. Leaf modules (`verdict`, `scope`, `gate`, `config`, `git`, `prompts`, `adapters`, `notify`) are pure/thin and unit-tested; `engine.js` is the state machine that composes them via **injected dependencies** so it can run fully stubbed under `ORCH_DRYRUN=1`. `cli.js` parses args and dispatches `init`/`task`/`review`.

**Tech Stack:** Node.js ≥ 18 (ESM), built-in `node:test` + `node:assert` (zero test deps), `node:child_process` for git + agent CLIs, `node:util.parseArgs` for args. Single runtime dependency: `yaml`.

## Global Constraints

- **Node ≥ 18** (for `util.parseArgs`, built-in `node:test`, `fs.cpSync`). `package.json` `engines.node: ">=18"`.
- **ESM only** — `package.json` `"type": "module"`, all imports use `node:` prefix for stdlib and `.js` extensions for local files.
- **Exactly one runtime dependency: `yaml`.** No commander/chalk/execa/glob/etc. Everything else is stdlib. (Ponytail: stdlib before deps.)
- **All paths in this plan are relative to the package root `agent-orch/`.** This directory is the standalone project that will become its own GitHub repo; build it as a self-contained package.
- **Agents never write `main`.** Only `engine.js` merges, only after the gate passes.
- **Command name** = `orch`; **package name** = `agent-orch`.
- **Verdict tokens** are the literal strings `AGREE` / `DISAGREE`.
- Tests run with `node --test`. Each task's final step commits with a Conventional Commit message.

---

### Task 1: Project scaffold + test runner

**Files:**
- Create: `agent-orch/package.json`
- Create: `agent-orch/bin/orch.js`
- Create: `agent-orch/src/version.js`
- Create: `agent-orch/test/smoke.test.js`
- Create: `agent-orch/.gitignore`

**Interfaces:**
- Produces: `VERSION` string export from `src/version.js`; runnable `bin/orch.js`.

- [ ] **Step 1: Write the failing test**

`agent-orch/test/smoke.test.js`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { VERSION } from "../src/version.js";

test("version is a semver string", () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent-orch && node --test`
Expected: FAIL — `Cannot find module '../src/version.js'`.

- [ ] **Step 3: Write minimal implementation**

`agent-orch/package.json`:
```json
{
  "name": "agent-orch",
  "version": "0.1.0",
  "description": "Run local coding agents in a cross-audit loop on any git repo",
  "type": "module",
  "bin": { "orch": "bin/orch.js" },
  "engines": { "node": ">=18" },
  "scripts": { "test": "node --test" },
  "license": "MIT",
  "dependencies": { "yaml": "^2.4.0" }
}
```

`agent-orch/src/version.js`:
```js
export const VERSION = "0.1.0";
```

`agent-orch/bin/orch.js`:
```js
#!/usr/bin/env node
import { main } from "../src/cli.js";
main(process.argv.slice(2)).catch((err) => {
  console.error(`orch: ${err.message}`);
  process.exit(1);
});
```

`agent-orch/.gitignore`:
```
node_modules/
.orch/
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent-orch && npm install && node --test`
Expected: PASS (1 test). `bin/orch.js` will fail to import `cli.js` until Task 11 — that is expected; only `node --test` must pass here.

- [ ] **Step 5: Commit**

```bash
git add agent-orch/package.json agent-orch/bin/orch.js agent-orch/src/version.js agent-orch/test/smoke.test.js agent-orch/.gitignore
git commit -m "chore(agent-orch): scaffold package + node:test runner"
```

---

### Task 2: `verdict.js` — parse AGREE/DISAGREE

**Files:**
- Create: `agent-orch/src/verdict.js`
- Test: `agent-orch/test/verdict.test.js`

**Interfaces:**
- Produces: `parseVerdict(text: string) -> { decision: "AGREE"|"DISAGREE", reason: string, raw: string }`. Fail-safe: missing/unparseable → `DISAGREE`.

- [ ] **Step 1: Write the failing test**

`agent-orch/test/verdict.test.js`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVerdict } from "../src/verdict.js";

test("parses trailing AGREE with reason", () => {
  const v = parseVerdict("Looks fine.\nAGREE the change is correct.");
  assert.equal(v.decision, "AGREE");
  assert.equal(v.reason, "the change is correct.");
});

test("parses DISAGREE and does not confuse it with AGREE substring", () => {
  const v = parseVerdict("I DISAGREE because tests are missing.");
  assert.equal(v.decision, "DISAGREE");
  assert.match(v.reason, /tests are missing/);
});

test("uses the LAST verdict token when several appear", () => {
  const v = parseVerdict("First I thought DISAGREE but on review AGREE done.");
  assert.equal(v.decision, "AGREE");
});

test("missing verdict is a fail-safe DISAGREE", () => {
  const v = parseVerdict("no verdict here");
  assert.equal(v.decision, "DISAGREE");
  assert.equal(v.reason, "unparseable verdict");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent-orch && node --test test/verdict.test.js`
Expected: FAIL — `Cannot find module '../src/verdict.js'`.

- [ ] **Step 3: Write minimal implementation**

`agent-orch/src/verdict.js`:
```js
// Parse the last standalone AGREE/DISAGREE token. `\bAGREE\b` does not match
// inside "DISAGREE" (no word boundary after the 'S'), so the two never collide.
export function parseVerdict(text) {
  const raw = String(text ?? "");
  const matches = [...raw.matchAll(/\b(AGREE|DISAGREE)\b/gi)];
  if (matches.length === 0) {
    return { decision: "DISAGREE", reason: "unparseable verdict", raw };
  }
  const last = matches[matches.length - 1];
  const decision = last[1].toUpperCase();
  const reason = raw.slice(last.index + last[0].length).trim() || "(no reason given)";
  return { decision, reason, raw };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent-orch && node --test test/verdict.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add agent-orch/src/verdict.js agent-orch/test/verdict.test.js
git commit -m "feat(agent-orch): verdict parser with fail-safe DISAGREE"
```

---

### Task 3: `prompts.js` + prompt templates

**Files:**
- Create: `agent-orch/src/prompts.js`
- Create: `agent-orch/src/prompts/author.md`
- Create: `agent-orch/src/prompts/review.md`
- Test: `agent-orch/test/prompts.test.js`

**Interfaces:**
- Produces: `renderTemplate(tpl: string, vars: object) -> string` (pure, `{{key}}` substitution); `render(name: string, vars: object) -> string` (reads `src/prompts/<name>.md`).

- [ ] **Step 1: Write the failing test**

`agent-orch/test/prompts.test.js`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderTemplate, render } from "../src/prompts.js";

test("renderTemplate substitutes known vars", () => {
  assert.equal(renderTemplate("hi {{name}}", { name: "x" }), "hi x");
});

test("renderTemplate leaves unknown placeholders intact", () => {
  assert.equal(renderTemplate("{{a}} {{b}}", { a: "1" }), "1 {{b}}");
});

test("review template mentions the verdict contract and the branch var", () => {
  const out = render("review", { branch: "pr/claude/x" });
  assert.match(out, /AGREE/);
  assert.match(out, /DISAGREE/);
  assert.match(out, /pr\/claude\/x/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent-orch && node --test test/prompts.test.js`
Expected: FAIL — `Cannot find module '../src/prompts.js'`.

- [ ] **Step 3: Write minimal implementation**

`agent-orch/src/prompts.js`:
```js
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

export function renderTemplate(tpl, vars = {}) {
  return String(tpl).replace(/\{\{(\w+)\}\}/g, (m, k) =>
    Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m
  );
}

export function render(name, vars = {}) {
  const tpl = readFileSync(join(HERE, "prompts", `${name}.md`), "utf8");
  return renderTemplate(tpl, vars);
}
```

`agent-orch/src/prompts/author.md`:
```markdown
You are an autonomous coding agent working in a git worktree.

Task: {{task}}

Rules:
- Make the SMALLEST change that fully accomplishes the task.
- Keep it to a few logical changes; do not refactor unrelated code.
- Add or update tests for the behavior you change.
- Commit your work in this worktree with a clear message. Do NOT touch `main`.
- Do not push. The orchestrator handles merging.
```

`agent-orch/src/prompts/review.md`:
```markdown
You are an adversarial code reviewer. Audit the branch `{{branch}}` against `main`.

Review ONLY — do not modify code. Check correctness, tests, scope, and whether
the change does what it claims. If the diff bundles more than ~3 logical changes,
that alone is grounds to reject (ask for a split).

End your response with EXACTLY ONE verdict token on its own:
- `AGREE` followed by a one-paragraph reason, if the change should merge.
- `DISAGREE` followed by a one-paragraph reason listing concrete findings.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent-orch && node --test test/prompts.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add agent-orch/src/prompts.js agent-orch/src/prompts/
git commit -m "feat(agent-orch): prompt templates + renderer"
```

---

### Task 4: `scope.js` — changed-line count vs main

**Files:**
- Create: `agent-orch/src/scope.js`
- Test: `agent-orch/test/scope.test.js`

**Interfaces:**
- Produces: `parseNumstat(numstat: string, ignore: string[]) -> number` (pure); `count(branch: string, cwd: string, ignore: string[]) -> number` (runs `git diff --numstat main...branch`).

- [ ] **Step 1: Write the failing test**

`agent-orch/test/scope.test.js`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNumstat } from "../src/scope.js";

const NUMSTAT = [
  "10\t5\tsrc/a.js",
  "3\t0\tpkg.lock",
  "-\t-\tbin/blob.png",   // binary -> skipped
  "2\t2\tdist/bundle.js",
].join("\n");

test("sums added+deleted, ignores binary", () => {
  assert.equal(parseNumstat(NUMSTAT, []), 10 + 5 + 3 + 0 + 2 + 2);
});

test("honors ignore globs including ** ", () => {
  assert.equal(parseNumstat(NUMSTAT, ["*.lock", "dist/**"]), 15);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent-orch && node --test test/scope.test.js`
Expected: FAIL — `Cannot find module '../src/scope.js'`.

- [ ] **Step 3: Write minimal implementation**

`agent-orch/src/scope.js`:
```js
import { execFileSync } from "node:child_process";

const DOUBLE_STAR = "__ORCH_DOUBLE_STAR__";
function globToRegExp(glob) {
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, DOUBLE_STAR)
    .replace(/\*/g, "[^/]*")
    .replaceAll(DOUBLE_STAR, ".*");
  return new RegExp("^" + re + "$");
}

export function parseNumstat(numstat, ignore = []) {
  const globs = ignore.map(globToRegExp);
  let total = 0;
  for (const line of String(numstat).split("\n")) {
    if (!line.trim()) continue;
    const [added, deleted, ...rest] = line.split("\t");
    const file = rest.join("\t");
    if (added === "-" || deleted === "-") continue; // binary
    if (globs.some((re) => re.test(file))) continue;
    total += Number(added) + Number(deleted);
  }
  return total;
}

export function count(branch, cwd, ignore = []) {
  const out = execFileSync("git", ["diff", "--numstat", `main...${branch}`], {
    cwd,
    encoding: "utf8",
  });
  return parseNumstat(out, ignore);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent-orch && node --test test/scope.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add agent-orch/src/scope.js agent-orch/test/scope.test.js
git commit -m "feat(agent-orch): scope line-count gate with glob ignore"
```

---

### Task 5: `gate.js` — detect + run the repo's test command

**Files:**
- Create: `agent-orch/src/gate.js`
- Test: `agent-orch/test/gate.test.js`

**Interfaces:**
- Produces: `detect(dir: string) -> string|null` (test command or null); `run(cmd: string, cwd: string) -> { pass: boolean, log: string }`.

- [ ] **Step 1: Write the failing test**

`agent-orch/test/gate.test.js`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detect, run } from "../src/gate.js";

function tmp() { return mkdtempSync(join(tmpdir(), "orch-gate-")); }

test("detects npm test from package.json", () => {
  const d = tmp();
  writeFileSync(join(d, "package.json"), JSON.stringify({ scripts: { test: "x" } }));
  assert.equal(detect(d), "npm test");
});

test("detects pytest from a tests/ dir", () => {
  const d = tmp();
  mkdirSync(join(d, "tests"));
  assert.equal(detect(d), "pytest -q");
});

test("detects go test from go.mod", () => {
  const d = tmp();
  writeFileSync(join(d, "go.mod"), "module x\n");
  assert.equal(detect(d), "go test ./...");
});

test("returns null when nothing detected", () => {
  assert.equal(detect(tmp()), null);
});

test("run reports pass/fail by exit code", () => {
  assert.equal(run("exit 0", tmp()).pass, true);
  assert.equal(run("exit 1", tmp()).pass, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent-orch && node --test test/gate.test.js`
Expected: FAIL — `Cannot find module '../src/gate.js'`.

- [ ] **Step 3: Write minimal implementation**

`agent-orch/src/gate.js`:
```js
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function safeRead(p) {
  try { return readFileSync(p, "utf8"); } catch { return ""; }
}

export function detect(dir) {
  const pkg = join(dir, "package.json");
  if (existsSync(pkg)) {
    try {
      const j = JSON.parse(readFileSync(pkg, "utf8"));
      if (j.scripts && j.scripts.test) return "npm test";
    } catch { /* fall through */ }
  }
  if (
    existsSync(join(dir, "pytest.ini")) ||
    existsSync(join(dir, "pyproject.toml")) ||
    existsSync(join(dir, "tests"))
  ) return "pytest -q";
  if (existsSync(join(dir, "go.mod"))) return "go test ./...";
  if (existsSync(join(dir, "Makefile")) && /^test:/m.test(safeRead(join(dir, "Makefile"))))
    return "make test";
  return null;
}

export function run(cmd, cwd) {
  const r = spawnSync(cmd, { cwd, shell: true, encoding: "utf8" });
  const log = (r.stdout || "") + (r.stderr || "");
  return { pass: r.status === 0, log };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent-orch && node --test test/gate.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add agent-orch/src/gate.js agent-orch/test/gate.test.js
git commit -m "feat(agent-orch): test-gate detection + runner"
```

---

### Task 6: `config.js` — load orch.yml + defaults + validate

**Files:**
- Create: `agent-orch/src/config.js`
- Test: `agent-orch/test/config.test.js`

**Interfaces:**
- Produces: `load(dir: string) -> cfg` where `cfg = { agents: string[], test: string, reviseCap: number, merge: "ff-only"|"no-ff", scope: { maxLines: number, ignore: string[] } }`. Throws `Error` on invalid config.

- [ ] **Step 1: Write the failing test**

`agent-orch/test/config.test.js`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "../src/config.js";

function tmp() { return mkdtempSync(join(tmpdir(), "orch-cfg-")); }

test("empty dir yields defaults", () => {
  const c = load(tmp());
  assert.deepEqual(c.agents, ["claude", "codex"]);
  assert.equal(c.reviseCap, 3);
  assert.equal(c.merge, "ff-only");
  assert.equal(c.scope.maxLines, 0);
});

test("user orch.yml overrides and deep-merges scope", () => {
  const d = tmp();
  writeFileSync(join(d, "orch.yml"), "merge: no-ff\nscope:\n  maxLines: 100\n");
  const c = load(d);
  assert.equal(c.merge, "no-ff");
  assert.equal(c.scope.maxLines, 100);
  assert.deepEqual(c.scope.ignore, ["*.lock", "dist/**", "*.snap"]); // default kept
});

test("invalid merge value throws", () => {
  const d = tmp();
  writeFileSync(join(d, "orch.yml"), "merge: rebase-please\n");
  assert.throws(() => load(d), /merge must be/);
});

test("empty agents list throws", () => {
  const d = tmp();
  writeFileSync(join(d, "orch.yml"), "agents: []\n");
  assert.throws(() => load(d), /agents/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent-orch && node --test test/config.test.js`
Expected: FAIL — `Cannot find module '../src/config.js'`.

- [ ] **Step 3: Write minimal implementation**

`agent-orch/src/config.js`:
```js
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const DEFAULTS = {
  agents: ["claude", "codex"],
  test: "auto",
  reviseCap: 3,
  merge: "ff-only",
  scope: { maxLines: 0, ignore: ["*.lock", "dist/**", "*.snap"] },
};

function validate(cfg) {
  if (!Array.isArray(cfg.agents) || cfg.agents.length < 1)
    throw new Error("orch.yml: agents must be a non-empty list");
  if (!["ff-only", "no-ff"].includes(cfg.merge))
    throw new Error("orch.yml: merge must be ff-only or no-ff");
  if (!Number.isInteger(cfg.reviseCap) || cfg.reviseCap < 1)
    throw new Error("orch.yml: reviseCap must be a positive integer");
  if (!Number.isInteger(cfg.scope.maxLines) || cfg.scope.maxLines < 0)
    throw new Error("orch.yml: scope.maxLines must be a non-negative integer");
}

export function load(dir) {
  let user = {};
  const p = join(dir, "orch.yml");
  if (existsSync(p)) user = parse(readFileSync(p, "utf8")) || {};
  const cfg = {
    ...DEFAULTS,
    ...user,
    scope: { ...DEFAULTS.scope, ...(user.scope || {}) },
  };
  validate(cfg);
  return cfg;
}

export { DEFAULTS };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent-orch && node --test test/config.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add agent-orch/src/config.js agent-orch/test/config.test.js
git commit -m "feat(agent-orch): config loader with defaults + validation"
```

---

### Task 7: `git.js` — worktree + branch + merge helpers

**Files:**
- Create: `agent-orch/src/git.js`
- Test: `agent-orch/test/git.test.js`

**Interfaces:**
- Produces:
  - `git(args: string[], cwd: string) -> string` (run git, return stdout trimmed)
  - `branchExists(repo: string, branch: string) -> boolean`
  - `createTaskBranch(repo: string, path: string, branch: string, base: string) -> void` (FAILS if `branch` already exists — `task` mode only)
  - `attachExistingBranch(repo: string, path: string, branch: string) -> void` (FAILS if `branch` does NOT exist — `review` mode only)
  - `pruneWorktree(repo: string, path: string) -> void`
  - `mergeIntoMain(repo: string, branch: string, mode: "ff-only"|"no-ff") -> { ok: boolean, reason: string }`

- [ ] **Step 1: Write the failing test**

`agent-orch/test/git.test.js`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, branchExists, createTaskBranch, attachExistingBranch, pruneWorktree, mergeIntoMain } from "../src/git.js";

function newRepo() {
  const d = mkdtempSync(join(tmpdir(), "orch-git-"));
  git(["init", "-b", "main"], d);
  git(["config", "user.email", "t@t"], d);
  git(["config", "user.name", "t"], d);
  writeFileSync(join(d, "a.txt"), "1\n");
  git(["add", "."], d);
  git(["commit", "-m", "init"], d);
  return d;
}

test("createTaskBranch lifecycle + ff-only merge", () => {
  const repo = newRepo();
  const wt = join(repo, ".orch", "wt", "b");
  createTaskBranch(repo, wt, "pr/claude/x", "main");
  writeFileSync(join(wt, "b.txt"), "2\n");
  git(["add", "."], wt);
  git(["commit", "-m", "add b"], wt);
  pruneWorktree(repo, wt);

  const r = mergeIntoMain(repo, "pr/claude/x", "ff-only");
  assert.equal(r.ok, true);
  assert.match(git(["log", "--oneline"], repo), /add b/);
});

test("createTaskBranch refuses an existing branch", () => {
  const repo = newRepo();
  git(["branch", "pr/claude/dup"], repo);
  assert.throws(() => createTaskBranch(repo, join(repo, ".orch/wt/d"), "pr/claude/dup", "main"), /already exists/);
});

test("attachExistingBranch refuses a missing branch (F5: no silent create)", () => {
  const repo = newRepo();
  assert.equal(branchExists(repo, "pr/claude/nope"), false);
  assert.throws(() => attachExistingBranch(repo, join(repo, ".orch/wt/n"), "pr/claude/nope"), /does not exist/);
});

test("ff-only merge fails (ok:false) when main moved", () => {
  const repo = newRepo();
  const wt = join(repo, ".orch", "wt", "c");
  createTaskBranch(repo, wt, "pr/claude/y", "main");
  writeFileSync(join(wt, "c.txt"), "3\n");
  git(["add", "."], wt);
  git(["commit", "-m", "add c"], wt);
  pruneWorktree(repo, wt);
  // move main forward so the branch no longer fast-forwards
  writeFileSync(join(repo, "a.txt"), "changed\n");
  git(["add", "."], repo);
  git(["commit", "-m", "move main"], repo);

  const r = mergeIntoMain(repo, "pr/claude/y", "ff-only");
  assert.equal(r.ok, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent-orch && node --test test/git.test.js`
Expected: FAIL — `Cannot find module '../src/git.js'`.

- [ ] **Step 3: Write minimal implementation**

`agent-orch/src/git.js`:
```js
import { execFileSync } from "node:child_process";

export function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function gitTry(args, cwd) {
  try {
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
    return { ok: true, out: "" };
  } catch (e) {
    return { ok: false, out: (e.stderr || e.stdout || e.message || "").toString() };
  }
}

export function branchExists(repo, branch) {
  return gitTry(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repo).ok;
}

// task mode: branch must NOT exist (orch owns it). Fail otherwise.
export function createTaskBranch(repo, path, branch, base) {
  if (branchExists(repo, branch)) throw new Error(`branch already exists: ${branch}`);
  git(["worktree", "add", "-b", branch, path, base], repo);
}

// review mode: branch MUST exist (human/other tool made it). Never create it.
export function attachExistingBranch(repo, path, branch) {
  if (!branchExists(repo, branch)) throw new Error(`branch does not exist: ${branch}`);
  git(["worktree", "add", path, branch], repo);
}

export function pruneWorktree(repo, path) {
  gitTry(["worktree", "remove", "--force", path], repo);
  gitTry(["worktree", "prune"], repo);
}

export function mergeIntoMain(repo, branch, mode) {
  const cur = git(["rev-parse", "--abbrev-ref", "HEAD"], repo);
  if (cur !== "main") {
    const co = gitTry(["checkout", "main"], repo);
    if (!co.ok) return { ok: false, reason: `cannot checkout main: ${co.out}` };
  }
  const flag = mode === "no-ff" ? "--no-ff" : "--ff-only";
  const m = gitTry(["merge", flag, branch], repo);
  return m.ok ? { ok: true, reason: "merged" } : { ok: false, reason: m.out.trim() };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent-orch && node --test test/git.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add agent-orch/src/git.js agent-orch/test/git.test.js
git commit -m "feat(agent-orch): git worktree + merge helpers"
```

---

### Task 8: `adapters/` — pluggable agent CLIs

**Files:**
- Create: `agent-orch/src/adapters/cli-adapter.js`
- Create: `agent-orch/src/adapters/claude.js`
- Create: `agent-orch/src/adapters/codex.js`
- Create: `agent-orch/src/adapters/index.js`
- Test: `agent-orch/test/adapters.test.js`

**Interfaces:**
- Consumes: `render` (Task 3), `parseVerdict` (Task 2).
- Produces:
  - `makeCliAdapter({ name, bin, buildArgs }) -> AgentAdapter`
  - `AgentAdapter = { name, author(task, wd): Promise<void>, audit(branch, wd): Promise<Verdict> }`
  - `get(name: string) -> AgentAdapter` from `index.js` (registry: `claude`, `codex`)
  - claude `buildArgs(prompt, wd) -> ["-p", prompt]`; codex `buildArgs(prompt, wd) -> ["exec", "--cd", wd, prompt]`

- [ ] **Step 1: Write the failing test**

`agent-orch/test/adapters.test.js`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { buildArgs as claudeArgs } from "../src/adapters/claude.js";
import { buildArgs as codexArgs } from "../src/adapters/codex.js";
import { get } from "../src/adapters/index.js";
import { makeCliAdapter } from "../src/adapters/cli-adapter.js";

test("claude buildArgs uses -p", () => {
  assert.deepEqual(claudeArgs("PROMPT", "/wd"), ["-p", "PROMPT"]);
});

test("audit is fail-safe DISAGREE when the agent exits nonzero (F4)", async () => {
  // Fake agent: prints a partial answer then exits 3. audit() must NOT throw.
  const adapter = makeCliAdapter({
    name: "boom",
    bin: "sh",
    buildArgs: () => ["-c", "echo 'thinking...'; exit 3"],
  });
  const v = await adapter.audit("pr/x/y", tmpdir());
  assert.equal(v.decision, "DISAGREE");
});

test("codex buildArgs uses exec --cd", () => {
  assert.deepEqual(codexArgs("PROMPT", "/wd"), ["exec", "--cd", "/wd", "PROMPT"]);
});

test("registry resolves known adapters and rejects unknown", () => {
  assert.equal(get("claude").name, "claude");
  assert.equal(get("codex").name, "codex");
  assert.throws(() => get("nope"), /unknown agent/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent-orch && node --test test/adapters.test.js`
Expected: FAIL — `Cannot find module '../src/adapters/claude.js'`.

- [ ] **Step 3: Write minimal implementation**

`agent-orch/src/adapters/cli-adapter.js`:
```js
import { execFileSync } from "node:child_process";
import { render } from "../prompts.js";
import { parseVerdict } from "../verdict.js";

const OPTS = { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 };

// Returns { out, ok }. On nonzero exit / crash, still captures whatever the
// agent printed so audit() can fail safely instead of throwing.
function runCapture(bin, args, cwd) {
  try {
    return { out: execFileSync(bin, args, { cwd, ...OPTS }), ok: true };
  } catch (e) {
    const out = `${e.stdout || ""}${e.stderr || ""}` || (e.message || "");
    return { out, ok: false };
  }
}

export function makeCliAdapter({ name, bin, buildArgs }) {
  return {
    name,
    async author(task, wd) {
      // Author must succeed; a failure here is a hard error (no commits made).
      execFileSync(bin, buildArgs(render("author", { task }), wd), { cwd: wd, ...OPTS });
    },
    async audit(branch, wd) {
      // F4: never throw. A crashed/nonzero agent yields a fail-safe DISAGREE.
      const { out } = runCapture(bin, buildArgs(render("review", { branch }), wd), wd);
      return parseVerdict(out); // unparseable/empty -> DISAGREE "unparseable verdict"
    },
  };
}
```

`agent-orch/src/adapters/claude.js`:
```js
import { makeCliAdapter } from "./cli-adapter.js";

export function buildArgs(prompt, _wd) {
  return ["-p", prompt];
}

export default makeCliAdapter({ name: "claude", bin: "claude", buildArgs });
```

`agent-orch/src/adapters/codex.js`:
```js
import { makeCliAdapter } from "./cli-adapter.js";

export function buildArgs(prompt, wd) {
  return ["exec", "--cd", wd, prompt];
}

export default makeCliAdapter({ name: "codex", bin: "codex", buildArgs });
```

`agent-orch/src/adapters/index.js`:
```js
import claude from "./claude.js";
import codex from "./codex.js";

const REGISTRY = { claude, codex };

export function get(name) {
  const a = REGISTRY[name];
  if (!a) throw new Error(`unknown agent: ${name}`);
  return a;
}

export function bins() {
  return Object.fromEntries(Object.values(REGISTRY).map((a) => [a.name, a.name]));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent-orch && node --test test/adapters.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add agent-orch/src/adapters/ agent-orch/test/adapters.test.js
git commit -m "feat(agent-orch): pluggable Claude + Codex adapters"
```

---

### Task 9: `notify.js` — terminal stream, round logs, decision brief

**Files:**
- Create: `agent-orch/src/notify.js`
- Test: `agent-orch/test/notify.test.js`

**Interfaces:**
- Produces:
  - `phase(msg: string) -> void` (stderr line, prefixed `▶`)
  - `writeRound(orchDir: string, branch: string, round: number, content: string) -> string` (writes `<orchDir>/reviews/<branch>/round-<n>.md`, returns path)
  - `buildDecisionBrief({ branch, reviewerCase, authorCase, diffSummary, rounds }) -> string` (pure markdown)
  - `escalate(orchDir: string, branch: string, brief: string) -> string` (writes `DECISION.md`, prints, returns path)

- [ ] **Step 1: Write the failing test**

`agent-orch/test/notify.test.js`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeRound, buildDecisionBrief } from "../src/notify.js";

test("writeRound creates nested round file", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-notify-"));
  const p = writeRound(d, "pr/claude/x", 2, "hello");
  assert.match(p, /reviews\/pr\/claude\/x\/round-2\.md$/);
  assert.equal(readFileSync(p, "utf8"), "hello");
});

test("decision brief contains both cases and the branch", () => {
  const md = buildDecisionBrief({
    branch: "pr/claude/x",
    reviewerCase: "missing tests",
    authorCase: "tests exist elsewhere",
    diffSummary: "1 file, +10 -2",
    rounds: 3,
  });
  assert.match(md, /pr\/claude\/x/);
  assert.match(md, /missing tests/);
  assert.match(md, /tests exist elsewhere/);
  assert.match(md, /3 rounds/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent-orch && node --test test/notify.test.js`
Expected: FAIL — `Cannot find module '../src/notify.js'`.

- [ ] **Step 3: Write minimal implementation**

`agent-orch/src/notify.js`:
```js
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function phase(msg) {
  process.stderr.write(`▶ ${msg}\n`);
}

export function writeRound(orchDir, branch, round, content) {
  const p = join(orchDir, "reviews", branch, `round-${round}.md`);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  return p;
}

export function buildDecisionBrief({ branch, reviewerCase, authorCase, diffSummary, rounds }) {
  return [
    `# Decision needed — ${branch}`,
    ``,
    `Stalemate after ${rounds} rounds. You arbitrate: merge as-is / revise / abandon.`,
    ``,
    `## Reviewer's case`,
    reviewerCase || "(none)",
    ``,
    `## Author's case`,
    authorCase || "(none)",
    ``,
    `## Diff`,
    diffSummary || "(none)",
    ``,
  ].join("\n");
}

export function escalate(orchDir, branch, brief) {
  const p = join(orchDir, "reviews", branch, "DECISION.md");
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, brief);
  process.stderr.write(`\n${brief}\n`);
  return p;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent-orch && node --test test/notify.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add agent-orch/src/notify.js agent-orch/test/notify.test.js
git commit -m "feat(agent-orch): local notify + decision brief"
```

---

### Task 10: `engine.js` — the cross-audit state machine

**Files:**
- Create: `agent-orch/src/engine.js`
- Test: `agent-orch/test/engine.test.js`

**Interfaces:**
- Consumes: all prior modules, injected via a `deps` object so tests stub them.
- Produces: `runCycle(opts, deps) -> Promise<Result>` where
  - `opts = { mode: "task"|"review", task, branch, authorName, reviewerName, cfg, orchDir, repo, worktree }`
  - **`mode: "task"`** — author writes the branch, then the cross-audit + revise loop runs (F1).
  - **`mode: "review"`** — **no author step, no revise**: attach the existing branch, audit ONCE, then merge-on-AGREE-or-escalate. A DISAGREE escalates immediately (rounds=1). Author agent is never invoked.
  - `Result = { status: "merged"|"escalated", reason: string, rounds: number }`
  - `deps = { adapters: { get }, git, gate, scope, notify }` (each matching earlier signatures). In production, `deps` is the real modules; in tests, stubs. The dry-run deps (Task 11) are just another stub set; `engine.js` itself contains no env checks — it only uses `deps`.

- [ ] **Step 1: Write the failing test**

`agent-orch/test/engine.test.js`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { runCycle } from "../src/engine.js";

function makeDeps({ verdicts, gatePass = true, mergeOk = true, testCmd = "echo" }) {
  const calls = { authors: 0, audits: 0, revises: 0 };
  const reviewer = {
    name: "rev",
    async audit() {
      calls.audits++;
      return verdicts[Math.min(calls.audits - 1, verdicts.length - 1)];
    },
  };
  const author = {
    name: "auth",
    async author() { calls.authors++; },
    async audit() { return { decision: "AGREE", reason: "", raw: "" }; },
  };
  // revise reuses author.author via engine; count via wrapper
  const adapters = { get: (n) => (n === "auth" ? author : reviewer) };
  const deps = {
    adapters,
    git: {
      createTaskBranch() {},
      attachExistingBranch() {},
      pruneWorktree() {},
      mergeIntoMain() { return mergeOk ? { ok: true, reason: "merged" } : { ok: false, reason: "non-ff" }; },
      git() { return "diff summary"; },
    },
    gate: { detect: () => testCmd, run: () => ({ pass: gatePass, log: "" }) },
    scope: { count: () => 0 },
    notify: { phase() {}, writeRound() { return "p"; }, buildDecisionBrief: () => "brief", escalate() { return "d"; } },
    _calls: calls,
  };
  return deps;
}

const opts = {
  task: "do x", branch: "pr/auth/x", authorName: "auth", reviewerName: "rev",
  cfg: { reviseCap: 3, merge: "ff-only", test: "auto", scope: { maxLines: 0, ignore: [] } },
  orchDir: "/o", repo: "/r", worktree: "/wt",
};

test("AGREE + green gate -> merged", async () => {
  const deps = makeDeps({ verdicts: [{ decision: "AGREE", reason: "ok", raw: "" }] });
  const r = await runCycle(opts, deps);
  assert.equal(r.status, "merged");
  assert.equal(deps._calls.authors, 1);
});

test("AGREE + red gate -> escalated, no merge", async () => {
  const deps = makeDeps({ verdicts: [{ decision: "AGREE", reason: "ok", raw: "" }], gatePass: false });
  const r = await runCycle(opts, deps);
  assert.equal(r.status, "escalated");
  assert.match(r.reason, /tests/i);
});

test("DISAGREE until cap -> escalated after reviseCap rounds", async () => {
  const deps = makeDeps({ verdicts: [{ decision: "DISAGREE", reason: "no", raw: "" }] });
  const r = await runCycle(opts, deps);
  assert.equal(r.status, "escalated");
  assert.equal(r.rounds, 3);
});

test("DISAGREE then AGREE -> merged on round 2", async () => {
  const deps = makeDeps({
    verdicts: [
      { decision: "DISAGREE", reason: "fix", raw: "" },
      { decision: "AGREE", reason: "ok", raw: "" },
    ],
  });
  const r = await runCycle(opts, deps);
  assert.equal(r.status, "merged");
  assert.equal(r.rounds, 2);
});

test("no test gate + AGREE -> escalated (refuse untested merge)", async () => {
  const deps = makeDeps({ verdicts: [{ decision: "AGREE", reason: "ok", raw: "" }], testCmd: null });
  const r = await runCycle({ ...opts, cfg: { ...opts.cfg, test: "auto" } }, deps);
  assert.equal(r.status, "escalated");
  assert.match(r.reason, /no test gate/i);
});

test("scope cap exceeded -> escalated before review", async () => {
  const deps = makeDeps({ verdicts: [{ decision: "AGREE", reason: "ok", raw: "" }] });
  deps.scope.count = () => 500;
  const r = await runCycle({ ...opts, cfg: { ...opts.cfg, scope: { maxLines: 100, ignore: [] } } }, deps);
  assert.equal(r.status, "escalated");
  assert.match(r.reason, /scope/i);
});

test("review mode never invokes the author (F1)", async () => {
  const deps = makeDeps({ verdicts: [{ decision: "AGREE", reason: "ok", raw: "" }] });
  const r = await runCycle({ ...opts, mode: "review" }, deps);
  assert.equal(r.status, "merged");
  assert.equal(deps._calls.authors, 0); // no author step, no revise
});

test("review mode escalates on first DISAGREE without revising (F1)", async () => {
  const deps = makeDeps({ verdicts: [{ decision: "DISAGREE", reason: "no", raw: "" }] });
  const r = await runCycle({ ...opts, mode: "review" }, deps);
  assert.equal(r.status, "escalated");
  assert.equal(r.rounds, 1);
  assert.equal(deps._calls.authors, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent-orch && node --test test/engine.test.js`
Expected: FAIL — `Cannot find module '../src/engine.js'`.

- [ ] **Step 3: Write minimal implementation**

`agent-orch/src/engine.js`:
```js
// Pure state machine. All side-effecting collaborators arrive via `deps`,
// so tests stub them and dry-run is just another set of stubs.
export async function runCycle(opts, deps) {
  const { mode = "task", task, branch, authorName, reviewerName, cfg, orchDir, repo, worktree } = opts;
  const { adapters, git, gate, scope, notify } = deps;
  const author = adapters.get(authorName);
  const reviewer = adapters.get(reviewerName);

  // F5: task mode owns a fresh branch; review mode requires an existing one.
  notify.phase(`worktree ${branch} (${mode})`);
  if (mode === "review") git.attachExistingBranch(repo, worktree, branch);
  else git.createTaskBranch(repo, worktree, branch, "main");

  try {
    // F1: author step + scope gate only in task mode. Review never writes.
    if (mode === "task") {
      notify.phase(`${author.name} authoring`);
      await author.author(task, worktree);

      // Scope gate (optional).
      if (cfg.scope.maxLines > 0) {
        const n = scope.count(branch, worktree, cfg.scope.ignore);
        if (n > cfg.scope.maxLines) {
          return escalate(notify, orchDir, branch, 1,
            `scope: ${n} changed lines exceed cap ${cfg.scope.maxLines} — split the PR`);
        }
      }
    }

    // Review mode escalates on first DISAGREE; task mode revises up to the cap.
    const cap = mode === "review" ? 1 : cfg.reviseCap;

    // Resolve the test command once.
    const testCmd = cfg.test === "auto" ? gate.detect(worktree) : cfg.test;

    let round = 1;
    for (;;) {
      notify.phase(`${reviewer.name} auditing (round ${round})`);
      const verdict = await reviewer.audit(branch, worktree);
      notify.writeRound(orchDir, branch, round,
        `# Round ${round}\n\nVerdict: ${verdict.decision}\n\n${verdict.reason}\n`);

      if (verdict.decision === "AGREE") {
        if (!testCmd) {
          return escalate(notify, orchDir, branch, round,
            "no test gate detected — set `test:` in orch.yml or merge manually");
        }
        notify.phase(`running gate: ${testCmd}`);
        const { pass } = gate.run(testCmd, worktree);
        if (!pass) {
          return escalate(notify, orchDir, branch, round,
            "AGREE but tests are red — not merging");
        }
        const m = git.mergeIntoMain(repo, branch, cfg.merge);
        if (!m.ok) {
          return escalate(notify, orchDir, branch, round,
            `merge failed (${m.reason}) — rebase ${branch} onto main`);
        }
        notify.phase(`merged ${branch}`);
        return { status: "merged", reason: "agreed + green + merged", rounds: round };
      }

      // DISAGREE — review mode (cap=1) escalates here on round 1, never revising.
      if (round >= cap) {
        const brief = notify.buildDecisionBrief({
          branch,
          reviewerCase: verdict.reason,
          authorCase: mode === "review" ? "(review-only; no author)" : "see prior rounds",
          diffSummary: safeDiff(git, repo, branch),
          rounds: round,
        });
        notify.escalate(orchDir, branch, brief);
        const why = mode === "review" ? "review verdict: DISAGREE" : "stalemate after cap";
        return { status: "escalated", reason: why, rounds: round };
      }

      notify.phase(`${author.name} revising (round ${round + 1})`);
      await author.author(`Revise per review findings:\n${verdict.reason}`, worktree);
      round += 1;
    }
  } finally {
    git.pruneWorktree(repo, worktree);
  }
}

function escalate(notify, orchDir, branch, round, reason) {
  notify.escalate(orchDir, branch, `# Escalation — ${branch}\n\n${reason}\n`);
  return { status: "escalated", reason, rounds: round };
}

function safeDiff(git, repo, branch) {
  try { return git.git(["diff", "--stat", `main...${branch}`], repo); }
  catch { return "(diff unavailable)"; }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent-orch && node --test test/engine.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add agent-orch/src/engine.js agent-orch/test/engine.test.js
git commit -m "feat(agent-orch): cross-audit state machine engine"
```

---

### Task 11: `cli.js` + `lock.js` — init / task / review, dry-run, lock & pause

**Files:**
- Create: `agent-orch/src/lock.js`
- Create: `agent-orch/src/cli.js`
- Create: `agent-orch/src/slug.js`
- Test: `agent-orch/test/lock.test.js`
- Test: `agent-orch/test/cli.test.js`

**Interfaces:**
- Consumes: `config.load`, `engine.runCycle`, `adapters` (get/bins), `git`, `gate`, `scope`, `notify`, `lock`.
- Produces (lock, F3):
  - `acquireLock(orchDir: string) -> boolean` (atomic create of `<orchDir>/lock`; false if already held)
  - `releaseLock(orchDir: string) -> void`
  - `isPaused(orchDir: string) -> boolean` (true if `<orchDir>/pause` exists)
- Produces:
  - `main(argv: string[]) -> Promise<void>` (entry from `bin/orch.js`)
  - `slugify(text: string) -> string` (branch-safe slug)
  - `nextAuthor(cfg, orchDir) -> { authorName, reviewerName }` (reads/writes `<orchDir>/last-author`)
  - `parse(argv) -> { command, rest, flags }`

- [ ] **Step 1a: Write the failing lock test**

`agent-orch/test/lock.test.js`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, releaseLock, isPaused } from "../src/lock.js";

test("acquireLock is exclusive until released", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-lock-"));
  assert.equal(acquireLock(d), true);
  assert.equal(acquireLock(d), false); // already held
  releaseLock(d);
  assert.equal(acquireLock(d), true); // free again
  releaseLock(d);
});

test("isPaused reflects the pause file", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-pause-"));
  assert.equal(isPaused(d), false);
  writeFileSync(join(d, "pause"), "");
  assert.equal(isPaused(d), true);
});
```

- [ ] **Step 1b: Implement `lock.js`**

`agent-orch/src/lock.js`:
```js
import { existsSync, mkdirSync, openSync, closeSync, rmSync } from "node:fs";
import { join } from "node:path";

// Atomic lock via O_EXCL file creation — fails if the lock already exists.
export function acquireLock(orchDir) {
  mkdirSync(orchDir, { recursive: true });
  try {
    closeSync(openSync(join(orchDir, "lock"), "wx")); // wx = create, fail if exists
    return true;
  } catch (e) {
    if (e.code === "EEXIST") return false;
    throw e;
  }
}

export function releaseLock(orchDir) {
  rmSync(join(orchDir, "lock"), { force: true });
}

export function isPaused(orchDir) {
  return existsSync(join(orchDir, "pause"));
}
```

- [ ] **Step 1c: Run the lock test**

Run: `cd agent-orch && node --test test/lock.test.js`
Expected: PASS (2 tests).

- [ ] **Step 2a: Write the failing cli test**

`agent-orch/test/cli.test.js`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir, cwd } from "node:process";
import { slugify, nextAuthor, parse, main } from "../src/cli.js";

test("slugify produces a branch-safe slug", () => {
  assert.equal(slugify("Fix the flaky test!!"), "fix-the-flaky-test");
});

test("--dry completes without any agent CLI on PATH (F2)", async () => {
  const d = mkdtempSync(join(tmpdir(), "orch-dry-"));
  const prev = cwd();
  chdir(d);
  try {
    process.exitCode = 0;
    await main(["task", "hello world", "--dry"]); // dryDeps: no real git/agent/test
    assert.notEqual(process.exitCode, 2); // not escalated
  } finally {
    chdir(prev);
    process.exitCode = 0;
  }
});

test("parse splits command, rest, and flags", () => {
  const p = parse(["task", "do x", "--dry"]);
  assert.equal(p.command, "task");
  assert.deepEqual(p.rest, ["do x"]);
  assert.equal(p.flags.dry, true);
});

test("nextAuthor alternates and persists last-author", () => {
  const d = mkdtempSync(join(tmpdir(), "orch-cli-"));
  const cfg = { agents: ["claude", "codex"] };
  const a = nextAuthor(cfg, d);
  assert.equal(a.authorName, "claude");
  assert.equal(a.reviewerName, "codex");
  assert.equal(readFileSync(join(d, "last-author"), "utf8").trim(), "claude");
  const b = nextAuthor(cfg, d);
  assert.equal(b.authorName, "codex"); // alternated
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent-orch && node --test test/cli.test.js`
Expected: FAIL — `Cannot find module '../src/cli.js'`.

- [ ] **Step 3: Write minimal implementation**

`agent-orch/src/slug.js`:
```js
export function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "task";
}
```

`agent-orch/src/cli.js`:
```js
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { load } from "./config.js";
import { runCycle } from "./engine.js";
import * as adapters from "./adapters/index.js";
import * as git from "./git.js";
import * as gate from "./gate.js";
import * as scope from "./scope.js";
import * as notify from "./notify.js";
import { acquireLock, releaseLock, isPaused } from "./lock.js";
import { slugify } from "./slug.js";
import { VERSION } from "./version.js";

export { slugify };

export function parse(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { dry: { type: "boolean" }, version: { type: "boolean" } },
  });
  return { command: positionals[0], rest: positionals.slice(1), flags: values };
}

export function nextAuthor(cfg, orchDir) {
  const f = join(orchDir, "last-author");
  const last = existsSync(f) ? readFileSync(f, "utf8").trim() : null;
  const i = last ? (cfg.agents.indexOf(last) + 1) % cfg.agents.length : 0;
  const authorName = cfg.agents[i];
  const reviewerName = cfg.agents[(i + 1) % cfg.agents.length] || authorName;
  mkdirSync(orchDir, { recursive: true });
  writeFileSync(f, authorName + "\n");
  return { authorName, reviewerName };
}

function preflight(cfg) {
  for (const name of cfg.agents) {
    const a = adapters.get(name); // throws on unknown
    try { execFileSync("which", [a.name], { stdio: "ignore" }); }
    catch { throw new Error(`agent CLI not found on PATH: ${a.name}`); }
  }
}

// F2: real collaborators, or fully stubbed ones under --dry / ORCH_DRYRUN=1.
// Dry deps touch NO real git, agent, or test process.
function realDeps() {
  return { adapters, git, gate, scope, notify };
}
function dryDeps() {
  const verdict = { decision: "AGREE", reason: "(dry-run: assumed agree)", raw: "" };
  return {
    adapters: { get: (n) => ({ name: n, async author() {}, async audit() { return verdict; } }) },
    git: {
      createTaskBranch() {}, attachExistingBranch() {}, pruneWorktree() {},
      mergeIntoMain() { return { ok: true, reason: "dry-run" }; },
      git() { return "(dry-run diff)"; },
    },
    gate: { detect: () => "true", run: () => ({ pass: true, log: "(dry-run)" }) },
    scope: { count: () => 0 },
    notify,
  };
}

export async function main(argv) {
  const { command, rest, flags } = parse(argv);
  if (flags.version || command === "version") { console.log(VERSION); return; }

  const repo = process.cwd();
  const orchDir = join(repo, ".orch");

  if (command === "init") {
    mkdirSync(orchDir, { recursive: true });
    const ex = join(repo, "orch.yml");
    if (!existsSync(ex)) {
      writeFileSync(ex, "# agent-orch config — all keys optional\nagents: [claude, codex]\ntest: auto\nreviseCap: 3\n");
    }
    const cfg = load(repo);
    preflight(cfg);
    console.log("orch: initialized (.orch/, orch.yml). Agent CLIs found.");
    return;
  }

  if (command === "task" || command === "review") {
    const cfg = load(repo);
    const dry = Boolean(flags.dry) || process.env.ORCH_DRYRUN === "1";
    if (!dry) preflight(cfg); // dry-run never shells out, so don't require CLIs

    // F3: operator kill switch + one-cycle-at-a-time lock.
    if (isPaused(orchDir)) throw new Error(".orch/pause present — orchestration paused");

    const mode = command; // "task" | "review"
    let authorName, reviewerName, branch, task;
    if (mode === "task") {
      task = rest.join(" ");
      if (!task) throw new Error('usage: orch task "describe the change"');
      ({ authorName, reviewerName } = nextAuthor(cfg, orchDir));
      branch = `pr/${authorName}/${slugify(task)}`;
    } else {
      branch = rest[0];
      if (!branch) throw new Error("usage: orch review <branch>");
      // audit-only: reviewer = first agent != branch author. authorName unused by engine.
      const branchAuthor = branch.split("/")[1];
      reviewerName = cfg.agents.find((a) => a !== branchAuthor) || cfg.agents[0];
      authorName = branchAuthor && cfg.agents.includes(branchAuthor) ? branchAuthor : cfg.agents[0];
      task = null;
    }
    const worktree = join(orchDir, "wt", branch.replace(/\//g, "_"));

    if (!acquireLock(orchDir)) throw new Error(".orch/lock held — another cycle is running");
    try {
      const result = await runCycle(
        { mode, task, branch, authorName, reviewerName, cfg, orchDir, repo, worktree },
        dry ? dryDeps() : realDeps()
      );
      console.log(`orch${dry ? " (dry)" : ""}: ${result.status} (${result.reason}) after ${result.rounds} round(s)`);
      if (result.status === "escalated") process.exitCode = 2;
    } finally {
      releaseLock(orchDir);
    }
    return;
  }

  console.log(`agent-orch ${VERSION}\nUsage:\n  orch init\n  orch task "change"\n  orch review <branch>\n  (flags: --dry, --version)`);
}
```

`review` is wired with `mode: "review"` (F1): the engine skips the author step and
escalates on the first DISAGREE — no author agent runs. `--dry`/`ORCH_DRYRUN=1`
selects `dryDeps()` (F2): no real git, agent, or test process executes.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent-orch && node --test test/cli.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Run the FULL suite + smoke the binary**

Run: `cd agent-orch && node --test && node bin/orch.js --version`
Expected: all tests PASS; `--version` prints `0.1.0`.

- [ ] **Step 6: Commit**

```bash
git add agent-orch/src/cli.js agent-orch/src/slug.js agent-orch/test/cli.test.js
git commit -m "feat(agent-orch): cli with init/task/review + preflight"
```

---

### Task 12: GitHub-ready packaging

**Files:**
- Create: `agent-orch/README.md`
- Create: `agent-orch/LICENSE`
- Create: `agent-orch/CONTRIBUTING.md`
- Create: `agent-orch/orch.example.yml`
- Create: `agent-orch/.github/workflows/ci.yml`

**Interfaces:** none (docs + CI).

- [ ] **Step 1: Write CI workflow**

`agent-orch/.github/workflows/ci.yml`:
```yaml
name: ci
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "20" }
      - run: npm ci || npm install
      - run: npm test
```

- [ ] **Step 2: Write README quickstart**

`agent-orch/README.md`:
```markdown
# agent-orch

Run two local coding agents (Claude, Codex) in a cross-audit loop on any git repo.
One authors a small change; the other audits it; on agreement + green tests it
merges to `main` locally; on disagreement it revises (capped); on stalemate it
asks you. All compute is local.

## Requirements
- Node ≥ 18
- At least one agent CLI on PATH: `claude` and/or `codex`

## Quickstart
```bash
cd your-repo
npx agent-orch init
npx agent-orch task "fix the flaky login test"
```

## Commands
- `orch init` — scaffold `orch.yml` + `.orch/`, verify agent CLIs.
- `orch task "..."` — author + cross-audit + test-gate + merge.
- `orch review <branch>` — audit an existing branch.

## Config (`orch.yml`, all optional)
See `orch.example.yml`. Most repos need no config.

## How it decides to merge
Merge happens only when the reviewer says `AGREE` **and** the repo's tests pass.
No test command detected → it refuses to auto-merge and tells you.

## License
MIT
```

- [ ] **Step 3: Write the remaining files**

`agent-orch/orch.example.yml`:
```yaml
# All keys optional. Defaults shown.
agents: [claude, codex]   # author alternates each cycle; the other audits
test: auto                # or an explicit command, e.g. "pytest -q"
reviseCap: 3              # max revise rounds before escalation
merge: ff-only            # or no-ff
scope:
  maxLines: 0             # 0 = disabled; >0 rejects oversized author commits
  ignore: ["*.lock", "dist/**", "*.snap"]
```

`agent-orch/CONTRIBUTING.md`:
```markdown
# Contributing

## Adding an agent adapter
1. Create `src/adapters/<name>.js`:
   ```js
   import { makeCliAdapter } from "./cli-adapter.js";
   export function buildArgs(prompt, wd) { return [/* your CLI's args */]; }
   export default makeCliAdapter({ name: "<name>", bin: "<binary>", buildArgs });
   ```
2. Register it in `src/adapters/index.js` (`REGISTRY`).
3. Add a `buildArgs` unit test in `test/adapters.test.js`.

The adapter contract: `author(task, wd)` makes commits in the worktree;
`audit(branch, wd)` returns a `Verdict` (it ends its output with `AGREE`/`DISAGREE`).

## Tests
`npm test` (uses built-in `node:test`). Keep modules pure where possible and
inject side effects so they stay unit-testable.
```

`agent-orch/LICENSE`: standard MIT license text, copyright holder `agent-orch contributors`, year 2026.

- [ ] **Step 4: Verify the whole suite still green**

Run: `cd agent-orch && node --test`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add agent-orch/README.md agent-orch/LICENSE agent-orch/CONTRIBUTING.md agent-orch/orch.example.yml agent-orch/.github/
git commit -m "docs(agent-orch): README, license, contributing, CI"
```

---

## Self-Review

**Spec coverage:**
- Repo-agnostic / local compute → Tasks 4–11 use only local git + CLIs. ✓
- Three-command surface (`init`/`task`/`review`) → Task 11. ✓
- Pluggable adapters, ship Claude+Codex → Task 8 + CONTRIBUTING (Task 12). ✓
- Author→audit→gate→merge state machine → Task 10. ✓
- Auto-detect test gate + refuse untested merge → Tasks 5, 10. ✓
- Capped revise loop + stalemate decision brief → Tasks 9, 10. ✓
- Scope cap OFF by default, opt-in → Tasks 6, 10. ✓
- Config defaults / minimum options → Task 6. ✓
- Safety: agents never merge, worktree isolation, ff-only/rebase escalate → Tasks 7, 10. ✓
- npx distribution + GitHub-ready → Tasks 1, 12. ✓
- Verdict contract fail-safe → Task 2. ✓
- Local-only monitoring/escalation → Task 9. ✓

**Audit fixes applied (2026-06-23, `agent-orch-audit-findings.md`):**
- **F1** — `review` is truly audit-only: engine `mode: "task"|"review"`; review skips the author step and escalates on first DISAGREE (Tasks 10, 11; tests assert 0 author calls).
- **F2** — dry-run wired: `--dry`/`ORCH_DRYRUN=1` selects `dryDeps()` (no real git/agent/test); CLI test proves it runs with no agent CLI present (Task 11).
- **F3** — lock + pause implemented: `lock.js` (`acquireLock`/`releaseLock`/`isPaused`), CLI acquires/releases around the cycle and honors `.orch/pause` (Task 11).
- **F4** — fail-safe verdict: adapter `audit()` captures crashed/nonzero output and returns `DISAGREE` instead of throwing (Task 8; test with `exit 3`).
- **F5** — branch safety: `createTaskBranch` (must not exist) vs `attachExistingBranch` (must exist); review never silently creates a branch (Task 7; tests).
- **F6** — scope sentinel: NUL replaced with visible `__ORCH_DOUBLE_STAR__` (Task 4).
- **F7** — legacy cross-audit docs restored (repo hygiene; both designs coexist).

**Remaining deliberate deferral:**
- Background watcher / `orch watch` auto-trigger — out of scope v1 (the pause file is also useful there). Documented in §13 of the design.

**Placeholder scan:** no TBD/TODO; every code step has complete code. ✓

**Type consistency:** `Verdict {decision,reason,raw}` consistent across Tasks 2, 8, 10. `mergeIntoMain` returns `{ok,reason}` in Task 7, consumed as `.ok`/`.reason` in Task 10. `runCycle(opts, deps)` with `mode` matches Tasks 10/11. `createTaskBranch`/`attachExistingBranch`/`branchExists` exported (Task 7) and consumed in engine (Task 10) + stubbed in its tests. `acquireLock`/`releaseLock`/`isPaused` exported (Task 11 `lock.js`) and imported in `cli.js`. ✓
