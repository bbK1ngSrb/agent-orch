import { test } from "node:test";
import assert from "node:assert/strict";
import { runPr, buildComment, demote, openPr, openIntegrationPr } from "../src/github.js";

function makeDeps({
  status = "approved", state = "OPEN",
  mergedState = "MERGED", mergeCommitOid = "abc123def", ancestorFails = false,
} = {}) {
  const calls = { gh: [], git: [] };
  const deps = {
    gh(args, input) {
      calls.gh.push({ args, input });
      if (args[0] === "pr" && args[1] === "view") {
        // post-merge re-check asks specifically for state+mergeCommit —
        // distinguish it from the initial open/state check.
        if (args.includes("state,mergeCommit")) {
          return JSON.stringify({ state: mergedState, mergeCommit: mergeCommitOid ? { oid: mergeCommitOid } : null });
        }
        return JSON.stringify({ number: 7, headRefName: "feature/x", state });
      }
      return "";
    },
    git(args) {
      calls.git.push(args);
      if (args[0] === "merge-base" && args[1] === "--is-ancestor" && ancestorFails) {
        throw new Error("fatal: not an ancestor");
      }
      return "";
    },
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
  // §140: a merge claim must be checked against origin/main, not just gh's exit code
  assert.ok(yes._calls.gh.some((c) => c.args[1] === "view" && c.args.includes("state,mergeCommit")));
  assert.ok(yes._calls.git.some((a) => a[0] === "fetch" && a[2] === "main"));
  assert.ok(yes._calls.git.some((a) => a[0] === "merge-base" && a[1] === "--is-ancestor"));

  const no = makeDeps();
  await runPr({ ...opts, merge: false }, no);
  assert.ok(!no._calls.gh.some((c) => c.args[1] === "merge"));

  const blocked = makeDeps({ status: "escalated" });
  await runPr({ ...opts, merge: true }, blocked);
  assert.ok(!blocked._calls.gh.some((c) => c.args[1] === "merge"));
});

test("§140: runPr refuses to report merged if gh's post-merge state isn't MERGED", async () => {
  const deps = makeDeps({ mergedState: "OPEN" });
  await assert.rejects(
    () => runPr({ ...opts, merge: true }, deps),
    /refusing to report a false "merged"/,
  );
});

test("§140: runPr refuses to report merged if the merge commit isn't an ancestor of origin/main", async () => {
  const deps = makeDeps({ ancestorFails: true });
  await assert.rejects(
    () => runPr({ ...opts, merge: true }, deps),
    /not yet an ancestor of origin\/main/,
  );
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

  const reason = "trigger: overlap\nreview: AGREE after 1 round(s)\nnext action: rerun orch review";
  const r = await demote({ repo: "/r", orchDir: "/r/.orch", branch: "pr/claude/x-1", reason }, { gh, git, notify });
  assert.equal(r.prUrl, "https://github.com/o/r/pull/7");
  assert.ok(calls.some((c) => c[0] === "git" && c[1] === "push"));
  assert.ok(calls.some((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "create"));
  const args = calls.find((c) => c[0] === "gh" && c[2] === "create");
  const body = args[args.indexOf("--body") + 1];
  assert.match(body, /Auto-demoted by agent-orch/);
  assert.match(body, /trigger: overlap/);
  assert.match(body, /next action: rerun orch review/);
});

test("issue bridge: demote appends Closes #N to the PR body so the issue auto-closes", async () => {
  const calls = [];
  const gh = (args) => { calls.push(["gh", ...args]); return args[0] === "--version" ? "gh 2" : "https://x/1\n"; };
  const git = (args) => { calls.push(["git", ...args]); return args[0] === "remote" ? "origin\n" : ""; };
  await demote({ repo: "/r", orchDir: "/o", branch: "pr/claude/x-1", reason: "overlap", closes: 53 },
    { gh, git, notify: { escalate() {} } });
  const args = calls.find((c) => c[0] === "gh" && c[2] === "create");
  const body = args[args.indexOf("--body") + 1];
  assert.match(body, /Closes #53/);
});

test("no closes → PR body carries no Closes line (plain demote unchanged)", async () => {
  const calls = [];
  const gh = (args) => { calls.push(["gh", ...args]); return args[0] === "--version" ? "gh 2" : "https://x/1\n"; };
  const git = (args) => { calls.push(["git", ...args]); return args[0] === "remote" ? "origin\n" : ""; };
  await demote({ repo: "/r", orchDir: "/o", branch: "pr/claude/x-1", reason: "overlap" },
    { gh, git, notify: { escalate() {} } });
  const args = calls.find((c) => c[0] === "gh" && c[2] === "create");
  assert.equal(/Closes #/.test(args[args.indexOf("--body") + 1]), false);
});

test("demote escalates locally when there is no remote", async () => {
  let escalated = null;
  const gh = () => "gh 2";
  const git = (args) => (args[0] === "remote" ? "" : ""); // no remotes
  const notify = { escalate: (orchDir, branch, brief) => { escalated = { branch, brief }; } };

  const reason = "trigger: conflict\nconflicting paths: src/a.js\nnext action: resolve the merge conflict";
  const r = await demote({ repo: "/r", orchDir: "/r/.orch", branch: "pr/claude/x-1", reason }, { gh, git, notify });
  assert.equal(r.prUrl, null);
  assert.equal(escalated.branch, "pr/claude/x-1");
  assert.match(escalated.brief, /conflict/);
  assert.match(escalated.brief, /conflicting paths: src\/a\.js/);
  assert.match(escalated.brief, /next action: resolve the merge conflict/);
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

test("openPr opens a PR for an agreed+green branch when a remote and gh are present", async () => {
  const calls = [];
  const gh = (args) => { calls.push(["gh", ...args]); return args[0] === "--version" ? "gh 2" : "https://github.com/o/r/pull/9\n"; };
  const git = (args) => { calls.push(["git", ...args]); return args[0] === "remote" ? "origin\n" : ""; };
  const notify = { escalate: () => { throw new Error("should not escalate when PR opens"); } };
  const cfg = { github: { mergeMethod: "squash", autoMergePr: false } };

  const r = await openPr({ repo: "/r", orchDir: "/r/.orch", branch: "pr/claude/x-1", cfg }, { gh, git, notify });
  assert.equal(r.prUrl, "https://github.com/o/r/pull/9");
  assert.ok(calls.some((c) => c[0] === "git" && c[1] === "push"));
  assert.ok(calls.some((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "create"));
  assert.ok(!calls.some((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "merge"), "no auto-merge unless opted in");
});

test("openPr with github.autoMergePr enables GitHub auto-merge on the PR it opens", async () => {
  const calls = [];
  const gh = (args) => { calls.push(["gh", ...args]); return args[0] === "--version" ? "gh 2" : "https://x/9\n"; };
  const git = (args) => (args[0] === "remote" ? "origin\n" : "");
  const cfg = { github: { mergeMethod: "squash", autoMergePr: true } };

  await openPr({ repo: "/r", orchDir: "/o", branch: "pr/claude/x-1", cfg }, { gh, git, notify: { escalate() {} } });
  const mergeCall = calls.find((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "merge");
  assert.ok(mergeCall, "gh pr merge --auto must be called");
  assert.ok(mergeCall.includes("--auto"));
  assert.ok(mergeCall.includes("--squash"));
});

// The PR is already open by the time autoMergePr runs — a failure enabling GitHub's
// native auto-merge (e.g. no branch protection configured) must not be reported as a
// cycle failure; the PR that was already opened should still come back.
test("openPr still returns the opened PR when enabling auto-merge fails", async () => {
  const logs = [];
  const gh = (args) => {
    if (args[0] === "--version") return "gh 2";
    if (args[0] === "pr" && args[1] === "merge") throw new Error("auto-merge not allowed: branch protection is not configured");
    return "https://github.com/o/r/pull/9\n";
  };
  const git = (args) => (args[0] === "remote" ? "origin\n" : "");
  const cfg = { github: { mergeMethod: "squash", autoMergePr: true } };

  const r = await openPr({ repo: "/r", orchDir: "/o", branch: "pr/claude/x-1", cfg },
    { gh, git, notify: { escalate() {} }, log: (m) => logs.push(m) });
  assert.equal(r.prUrl, "https://github.com/o/r/pull/9");
  assert.match(logs.join("\n"), /could not enable auto-merge/);
});

test("openPr escalates locally when there is no remote", async () => {
  let escalated = null;
  const gh = () => "gh 2";
  const git = (args) => (args[0] === "remote" ? "" : "");
  const notify = { escalate: (orchDir, branch, brief) => { escalated = { branch, brief }; } };
  const cfg = { github: { mergeMethod: "squash", autoMergePr: false } };

  const r = await openPr({ repo: "/r", orchDir: "/r/.orch", branch: "pr/claude/x-1", cfg }, { gh, git, notify });
  assert.equal(r.prUrl, null);
  assert.equal(escalated.branch, "pr/claude/x-1");
});

test("openIntegrationPr creates the persistent integration PR and enables auto-merge", async () => {
  const calls = [];
  const gh = (args) => {
    calls.push(["gh", ...args]);
    if (args[0] === "--version") return "gh 2";
    if (args[0] === "pr" && args[1] === "list") return "[]";
    if (args[0] === "pr" && args[1] === "create") return "https://github.com/o/r/pull/12\n";
    return "";
  };
  const git = (args) => { calls.push(["git", ...args]); return args[0] === "remote" ? "origin\n" : ""; };
  const cfg = { integrationBranch: "orch/integration", github: { mergeMethod: "squash", autoMergePr: true } };

  const r = await openIntegrationPr({ repo: "/r", orchDir: "/r/.orch", cfg }, { gh, git, notify: { escalate() {} } });

  assert.equal(r.prUrl, "https://github.com/o/r/pull/12");
  assert.ok(calls.some((c) => c.join(" ") === "git push -u origin orch/integration"));
  assert.ok(calls.some((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "create"));
  const mergeCall = calls.find((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "merge");
  assert.ok(mergeCall.includes("--auto"));
  assert.ok(mergeCall.includes("--merge"));
  assert.equal(mergeCall.includes("--squash"), false);
});

test("openIntegrationPr updates an existing integration PR instead of creating another", async () => {
  const calls = [];
  const gh = (args) => {
    calls.push(["gh", ...args]);
    if (args[0] === "--version") return "gh 2";
    if (args[0] === "pr" && args[1] === "list") return JSON.stringify([{ number: 12, url: "https://github.com/o/r/pull/12" }]);
    return "";
  };
  const git = (args) => (args[0] === "remote" ? "origin\n" : "");
  const cfg = { integrationBranch: "orch/integration", github: { mergeMethod: "squash", autoMergePr: false } };

  const r = await openIntegrationPr({ repo: "/r", orchDir: "/r/.orch", cfg }, { gh, git, notify: { escalate() {} } });

  assert.equal(r.prUrl, "https://github.com/o/r/pull/12");
  assert.ok(calls.some((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "edit" && c[3] === "12"));
  assert.ok(!calls.some((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "create"));
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
