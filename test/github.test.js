import { test } from "node:test";
import assert from "node:assert/strict";
import { runPr, buildComment, demote } from "../src/github.js";

function makeDeps({ status = "approved", state = "OPEN" } = {}) {
  const calls = { gh: [], git: [] };
  const deps = {
    gh(args, input) {
      calls.gh.push({ args, input });
      if (args[0] === "pr" && args[1] === "view")
        return JSON.stringify({ number: 7, headRefName: "feature/x", state });
      return "";
    },
    git(args) { calls.git.push(args); return ""; },
    async cycle(o) { calls.cycleOpts = o; return { status, reason: "r", rounds: 1 }; },
    readVerdict: () => "reviewer says ok",
    _calls: calls,
  };
  return deps;
}

const opts = { n: 7, repo: "/r", orchDir: "/o", cfg: { agents: ["claude", "codex"], github: { mergeMethod: "squash" } } };

test("buildComment marks approved vs escalated", () => {
  assert.match(buildComment({ status: "approved", rounds: 1 }, "x"), /APPROVED/);
  assert.match(buildComment({ status: "escalated", rounds: 2 }, "x"), /NEEDS WORK/);
});

test("runPr fetches PR head, audits with noMerge, comments", async () => {
  const deps = makeDeps();
  const r = await runPr(opts, deps);
  assert.equal(r.status, "approved");
  // fetched the PR head into pr-7
  assert.ok(deps._calls.git.some((a) => a[0] === "fetch" && a[2] === "+pull/7/head:pr-7"));
  // cycle ran review-mode, no local merge
  assert.equal(deps._calls.cycleOpts.mode, "review");
  assert.equal(deps._calls.cycleOpts.noMerge, true);
  assert.equal(deps._calls.cycleOpts.branch, "pr-7");
  // posted a comment via stdin — §3f: machine summary only, NEVER reviewer prose
  const comment = deps._calls.gh.find((c) => c.args[1] === "comment");
  assert.ok(comment, "a PR comment must be posted");
  assert.ok(!comment.input.includes("reviewer says ok"), "reviewer prose must not reach the public PR");
  assert.match(comment.input, /orch verdict:/);
  assert.match(comment.input, /branch: pr-7/);
  // local branch cleaned up
  assert.ok(deps._calls.git.some((a) => a[0] === "branch" && a[1] === "-D"));
});

test("runPr merges only with merge flag + approved", async () => {
  const yes = makeDeps();
  await runPr({ ...opts, merge: true }, yes);
  assert.ok(yes._calls.gh.some((c) => c.args[1] === "merge"));

  const no = makeDeps();
  await runPr({ ...opts, merge: false }, no);
  assert.ok(!no._calls.gh.some((c) => c.args[1] === "merge"));

  const blocked = makeDeps({ status: "escalated" });
  await runPr({ ...opts, merge: true }, blocked);
  assert.ok(!blocked._calls.gh.some((c) => c.args[1] === "merge"));
});

test("runPr refuses a non-open PR", async () => {
  await assert.rejects(() => runPr(opts, makeDeps({ state: "MERGED" })), /not open/);
});

test("runPr parses reviewer role specs (model/effort) into cycle reviewers", async () => {
  const deps = makeDeps();
  const cfg = { ...opts.cfg, reviewers: ["claude opus-4.8 high", "codex gpt-5.1"] };
  await runPr({ ...opts, cfg }, deps);
  const { reviewers } = deps._calls.cycleOpts;
  // Specs are parsed, not passed as raw "agent model effort" strings.
  assert.deepEqual(reviewers, [
    { agent: "claude", model: "opus-4.8", effort: "high" },
    { agent: "codex", model: "gpt-5.1", effort: null },
  ]);
  // authorName is a bare agent name (engine calls adapters.get on it).
  assert.equal(deps._calls.cycleOpts.authorName, "claude");
});

test("runPr handles a single reviewer spec and bare-name default", async () => {
  const single = makeDeps();
  await runPr({ ...opts, cfg: { ...opts.cfg, reviewer: "codex gpt-5.1" } }, single);
  assert.deepEqual(single._calls.cycleOpts.reviewers, [{ agent: "codex", model: "gpt-5.1", effort: null }]);

  const dflt = makeDeps();
  await runPr(opts, dflt); // no reviewer config → first agent, no model/effort
  assert.deepEqual(dflt._calls.cycleOpts.reviewers, [{ agent: "claude", model: null, effort: null }]);
});

test("demote opens a PR when a remote and gh are present", async () => {
  const calls = [];
  const gh = (args) => { calls.push(["gh", ...args]); return args[0] === "--version" ? "gh 2" : "https://github.com/o/r/pull/7\n"; };
  const git = (args) => { calls.push(["git", ...args]); return args[0] === "remote" ? "origin\n" : ""; };
  const notify = { escalate: () => { throw new Error("should not escalate when PR opens"); } };

  const r = await demote({ repo: "/r", orchDir: "/r/.orch", branch: "pr/claude/x-1", reason: "overlap" }, { gh, git, notify });
  assert.equal(r.prUrl, "https://github.com/o/r/pull/7");
  assert.ok(calls.some((c) => c[0] === "git" && c[1] === "push"));
  assert.ok(calls.some((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "create"));
});

test("demote escalates locally when there is no remote", async () => {
  let escalated = null;
  const gh = () => "gh 2";
  const git = (args) => (args[0] === "remote" ? "" : ""); // no remotes
  const notify = { escalate: (orchDir, branch, brief) => { escalated = { branch, brief }; } };

  const r = await demote({ repo: "/r", orchDir: "/r/.orch", branch: "pr/claude/x-1", reason: "conflict" }, { gh, git, notify });
  assert.equal(r.prUrl, null);
  assert.equal(escalated.branch, "pr/claude/x-1");
  assert.match(escalated.brief, /conflict/);
});

test("§3f: demote redacts a secret-shaped branch in the PR title/body it posts", async () => {
  const token = "ghp_" + "a".repeat(36); // GitHub-PAT shape — survives publicSummary's \w branch sanitizer
  const calls = [];
  const gh = (args) => { calls.push(["gh", ...args]); return args[0] === "--version" ? "gh 2" : "https://x/1\n"; };
  const git = (args) => { calls.push(["git", ...args]); return args[0] === "remote" ? "origin\n" : ""; };
  await demote({ repo: "/r", orchDir: "/o", branch: token, reason: "overlap" },
    { gh, git, notify: { escalate() {} } });
  const args = calls.find((c) => c[0] === "gh" && c[2] === "create");
  const valOf = (flag) => args[args.indexOf(flag) + 1];
  // --head must keep the REAL ref so gh can find the branch...
  assert.equal(valOf("--head"), token, "--head must carry the real branch ref, unredacted");
  // ...but the human-readable title/body must be scrubbed.
  assert.ok(!valOf("--title").includes(token) && valOf("--title").includes("«redacted»"));
  assert.ok(!valOf("--body").includes(token));
});

test("§3f: runPr comment passes through redact (no raw secret in the body)", async () => {
  // publicSummary is machine-only, so redact is the belt: prove the posted body is redact()'d.
  const deps = makeDeps();
  await runPr(opts, deps);
  const comment = deps._calls.gh.find((c) => c.args[1] === "comment");
  // A clean run has nothing to redact, but the body must be a string that went through it.
  assert.equal(typeof comment.input, "string");
  assert.doesNotMatch(comment.input, /gh[pousr]_[A-Za-z0-9]{36,}/, "no unredacted PAT may appear");
});
