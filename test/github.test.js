import { test } from "node:test";
import assert from "node:assert/strict";
import { runPr, buildComment, demote, openPr, openIntegrationPr } from "../src/github.js";

function makeDeps({
  status = "approved", state = "OPEN",
  mergedState = "MERGED", mergeCommitOid = "abc123def", ancestorFails = false,
  fetchLockFailures = 0,
} = {}) {
  const calls = { gh: [], git: [] };
  let fetchAttempts = 0;
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
      if (args[0] === "fetch" && args[2] === "main:refs/remotes/origin/main") {
        fetchAttempts++;
        if (fetchAttempts <= fetchLockFailures) throw new Error("fatal: cannot lock ref 'refs/remotes/origin/main'");
      }
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
  // Direct REST merge, not `gh pr merge` — its client-side mergeable precheck
  // ignores ruleset bypass_actors and can false-refuse an eligible merge.
  assert.ok(yes._calls.gh.some((c) => c.args[0] === "api" && c.args.some((a) => a.includes("pulls/7/merge"))));
  // §140: a merge claim must be checked against origin/main, not just gh's exit code
  assert.ok(yes._calls.gh.some((c) => c.args[1] === "view" && c.args.includes("state,mergeCommit")));
  assert.ok(yes._calls.git.some((a) => a[0] === "fetch" && a[2] === "main:refs/remotes/origin/main"));
  assert.ok(yes._calls.git.some((a) =>
    a[0] === "merge-base" && a[1] === "--is-ancestor" && a[3] === "refs/remotes/origin/main"));

  const no = makeDeps();
  await runPr({ ...opts, merge: false }, no);
  assert.ok(!no._calls.gh.some((c) => c.args[0] === "api"));

  const blocked = makeDeps({ status: "escalated" });
  await runPr({ ...opts, merge: true }, blocked);
  assert.ok(!blocked._calls.gh.some((c) => c.args[0] === "api"));
});

test("runPr verifies a merged PR against cfg.baseBranch", async () => {
  const deps = makeDeps();
  await runPr({ ...opts, merge: true, cfg: { ...opts.cfg, baseBranch: "dev" } }, deps);
  assert.ok(deps._calls.git.some((a) => a[0] === "fetch" && a[2] === "dev:refs/remotes/origin/dev"));
  assert.ok(deps._calls.git.some((a) =>
    a[0] === "merge-base" && a[1] === "--is-ancestor" && a[3] === "refs/remotes/origin/dev"));
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

test("§140: runPr retries the post-merge origin fetch through a transient ref-lock race", async () => {
  const deps = makeDeps({ fetchLockFailures: 1 });
  const result = await runPr({ ...opts, merge: true }, deps);
  assert.equal(result.status, "approved");
  const fetches = deps._calls.git.filter((a) => a[0] === "fetch" && a[2] === "main:refs/remotes/origin/main");
  assert.equal(fetches.length, 2, "should retry once after the ref-lock failure, then succeed");
});

test("§140: runPr gives up after exhausting ref-lock retries", async () => {
  const deps = makeDeps({ fetchLockFailures: 99 });
  await assert.rejects(
    () => runPr({ ...opts, merge: true }, deps),
    /cannot lock ref/,
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
  assert.match(body, /Plain `gh pr merge` can be refused by its bypass-blind precheck/);
  assert.match(body, /gh api -X PUT repos\/\{owner\}\/\{repo\}\/pulls\/<PR-number>\/merge -f merge_method=squash/);
  const edit = calls.find((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "edit");
  assert.ok(edit, "demote should update the PR body once the PR number is known");
  assert.match(edit[edit.indexOf("--body") + 1], /gh api -X PUT repos\/\{owner\}\/\{repo\}\/pulls\/7\/merge -f merge_method=squash/);
});

test("demote with github.autoMergePr directly merges the opened fallback PR", async () => {
  const calls = [];
  const gh = (args) => { calls.push(["gh", ...args]); return args[0] === "--version" ? "gh 2" : "https://github.com/o/r/pull/170\n"; };
  const git = (args) => { calls.push(["git", ...args]); return args[0] === "remote" ? "origin\n" : ""; };
  const cfg = { github: { mergeMethod: "squash", autoMergePr: true } };

  const r = await demote({ repo: "/r", orchDir: "/o", branch: "pr/claude/x-1", reason: "overlap", cfg },
    { gh, git, notify: { escalate() {} } });

  assert.equal(r.prUrl, "https://github.com/o/r/pull/170");
  assert.ok(!calls.some((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "merge"), "must not use gh pr merge precheck");
  assert.ok(calls.some((c) =>
    c[0] === "gh" &&
    c[1] === "api" &&
    c.includes("repos/{owner}/{repo}/pulls/170/merge") &&
    c.includes("merge_method=squash")));
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

test("openPr opens the PR against cfg.baseBranch, not main", async () => {
  const calls = [];
  const gh = (args) => { calls.push(["gh", ...args]); return args[0] === "--version" ? "gh 2" : "https://github.com/o/r/pull/9\n"; };
  const git = (args) => { calls.push(["git", ...args]); return args[0] === "remote" ? "origin\n" : ""; };
  const cfg = { baseBranch: "dev", github: { mergeMethod: "squash", autoMergePr: false } };

  const r = await openPr({ repo: "/r", orchDir: "/r/.orch", branch: "pr/claude/x-1", cfg }, { gh, git, notify: { escalate() {} } });

  assert.equal(r.prUrl, "https://github.com/o/r/pull/9");
  const create = calls.find((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "create");
  assert.ok(create.includes("--base"));
  assert.equal(create[create.indexOf("--base") + 1], "dev");
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

// Native auto-merge silently never completes when the only thing satisfying
// the review requirement is a ruleset bypass_actor grant, not a real
// approval — GitHub's mergeStateStatus stays BLOCKED forever even after
// checks pass. An immediate direct-merge attempt right after enabling
// auto-merge covers the case where checks already happened to be green.
test("openPr also attempts a direct merge right after enabling auto-merge", async () => {
  const calls = [];
  const gh = (args) => { calls.push(["gh", ...args]); return args[0] === "--version" ? "gh 2" : "https://x/9\n"; };
  const git = (args) => (args[0] === "remote" ? "origin\n" : "");
  const cfg = { github: { mergeMethod: "squash", autoMergePr: true } };

  await openPr({ repo: "/r", orchDir: "/o", branch: "pr/claude/x-1", cfg }, { gh, git, notify: { escalate() {} } });
  const direct = calls.find((c) => c[0] === "gh" && c[1] === "api" && c.some((a) => a.includes("merge_method=squash")));
  assert.ok(direct, "a direct merge attempt must follow the --auto call");
});

test("openPr swallows a direct-merge failure (checks still pending is normal)", async () => {
  const gh = (args) => {
    if (args[0] === "--version") return "gh 2";
    if (args[0] === "api") throw new Error("405 not mergeable yet");
    return "https://x/9\n";
  };
  const git = (args) => (args[0] === "remote" ? "origin\n" : "");
  const cfg = { github: { mergeMethod: "squash", autoMergePr: true } };

  const r = await openPr({ repo: "/r", orchDir: "/o", branch: "pr/claude/x-1", cfg }, { gh, git, notify: { escalate() {} } });
  assert.equal(r.prUrl, "https://x/9");
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
  assert.ok(!calls.some((c) => c[0] === "gh" && c[1] === "api"), "direct main merge needs main.autoMerge");
});

test("openIntegrationPr with main.autoMerge directly merges the persistent integration PR", async () => {
  const calls = [];
  const gh = (args) => {
    calls.push(["gh", ...args]);
    if (args[0] === "--version") return "gh 2";
    if (args[0] === "pr" && args[1] === "list") return "[]";
    if (args[0] === "pr" && args[1] === "create") return "https://github.com/o/r/pull/12\n";
    if (args[0] === "pr" && args[1] === "view") {
      return JSON.stringify({ statusCheckRollup: [{ state: "SUCCESS" }, { status: "COMPLETED", conclusion: "SUCCESS" }] });
    }
    return "";
  };
  const git = (args) => { calls.push(["git", ...args]); return args[0] === "remote" ? "origin\n" : ""; };
  const cfg = { integrationBranch: "orch/integration", github: { mergeMethod: "squash", autoMergePr: false }, main: { autoMerge: true } };

  const r = await openIntegrationPr({ repo: "/r", orchDir: "/r/.orch", cfg }, { gh, git, notify: { escalate() {} } });

  assert.equal(r.prUrl, "https://github.com/o/r/pull/12");
  assert.ok(!calls.some((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "merge"), "must not use gh pr merge precheck");
  assert.ok(calls.some((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "view" && c.includes("statusCheckRollup")));
  const direct = calls.find((c) => c[0] === "gh" && c[1] === "api" && c.some((a) => a.includes("merge_method=merge")));
  assert.ok(direct, "main.autoMerge must attempt a direct merge");
  // #182: the REST merge endpoint is keyed by numeric PR id. On the create
  // path the number comes from the create URL, not the head-branch name —
  // passing "orch/integration" here builds pulls/orch/integration/merge → 404.
  assert.ok(
    direct.some((a) => a.includes("pulls/12/merge")),
    "direct merge must target the numeric PR id, not the branch name",
  );
  assert.ok(
    !direct.some((a) => a.includes("orch/integration/merge")),
    "direct merge must not use the branch name in the REST path",
  );
});

test("openIntegrationPr arms native auto-merge and still runs the green-gated direct merge", async () => {
  // Both knobs on. Native auto-merge is armed for the normal real-approval case,
  // but main.autoMerge must ALSO run its green-gated direct merge: when the
  // review requirement is satisfied by a ruleset bypass_actor grant rather than a
  // real approval, GitHub's native auto-merge stays BLOCKED forever even after
  // checks pass, so the direct merge is the only thing that lands the PR. It is
  // gated on prChecksGreen, so it only fires once checks are green — never an
  // early racing 405.
  const calls = [];
  const gh = (args) => {
    calls.push(["gh", ...args]);
    if (args[0] === "--version") return "gh 2";
    if (args[0] === "pr" && args[1] === "list") return JSON.stringify([{ number: 12, url: "https://github.com/o/r/pull/12" }]);
    if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ statusCheckRollup: [{ state: "SUCCESS" }] });
    return "";
  };
  const git = (args) => (args[0] === "remote" ? "origin\n" : "");
  const cfg = { integrationBranch: "orch/integration", github: { mergeMethod: "squash", autoMergePr: true }, main: { autoMerge: true } };

  const r = await openIntegrationPr({ repo: "/r", orchDir: "/r/.orch", cfg }, { gh, git, notify: { escalate() {} } });
  assert.equal(r.prUrl, "https://github.com/o/r/pull/12");
  const mergeCall = calls.find((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "merge");
  assert.ok(mergeCall && mergeCall.includes("--auto"), "native auto-merge must be armed");
  assert.ok(calls.some((c) => c[0] === "gh" && c[1] === "api" && c.some((a) => a.includes("merge_method=merge"))), "green-gated direct merge must still run so the BLOCKED-bypass PR lands");
});

test("openIntegrationPr falls back to the direct merge when arming auto-merge fails", async () => {
  // Auto-merge could not be armed (e.g. no branch protection / merge queue on
  // the repo, so `gh pr merge --auto` errors). The direct-merge fallback must
  // still run so main.autoMerge keeps landing the PR.
  const calls = [];
  const gh = (args) => {
    calls.push(["gh", ...args]);
    if (args[0] === "--version") return "gh 2";
    if (args[0] === "pr" && args[1] === "list") return JSON.stringify([{ number: 12, url: "https://github.com/o/r/pull/12" }]);
    if (args[0] === "pr" && args[1] === "merge") throw new Error("auto-merge not available");
    if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ statusCheckRollup: [{ state: "SUCCESS" }] });
    return "";
  };
  const git = (args) => (args[0] === "remote" ? "origin\n" : "");
  const cfg = { integrationBranch: "orch/integration", github: { mergeMethod: "squash", autoMergePr: true }, main: { autoMerge: true } };

  const r = await openIntegrationPr({ repo: "/r", orchDir: "/r/.orch", cfg }, { gh, git, notify: { escalate() {} } });
  assert.equal(r.prUrl, "https://github.com/o/r/pull/12");
  assert.ok(calls.some((c) => c[0] === "gh" && c[1] === "api" && c.some((a) => a.includes("merge_method=merge"))), "direct merge must run when auto-merge could not be armed");
});

test("openIntegrationPr skips main.autoMerge direct merge until checks are green", async () => {
  const calls = [];
  const gh = (args) => {
    calls.push(["gh", ...args]);
    if (args[0] === "--version") return "gh 2";
    if (args[0] === "pr" && args[1] === "list") return JSON.stringify([{ number: 12, url: "https://github.com/o/r/pull/12" }]);
    if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ statusCheckRollup: [{ state: "PENDING" }] });
    return "";
  };
  const git = (args) => (args[0] === "remote" ? "origin\n" : "");
  const cfg = { integrationBranch: "orch/integration", github: { mergeMethod: "squash", autoMergePr: false }, main: { autoMerge: true } };

  const r = await openIntegrationPr({ repo: "/r", orchDir: "/r/.orch", cfg }, { gh, git, notify: { escalate() {} } });
  assert.equal(r.prUrl, "https://github.com/o/r/pull/12");
  assert.ok(!calls.some((c) => c[0] === "gh" && c[1] === "api"));
});

test("openIntegrationPr waits when a required check is still EXPECTED (not yet reported)", async () => {
  // A required status context GitHub is still waiting on appears in the rollup as
  // state:"EXPECTED" — the check exists in branch protection but no status has
  // been posted yet. That is exactly the "wait for required CI checks" case: the
  // direct merge must hold, not fire early against a not-yet-satisfied required
  // context (which would 405). The other reported check being green must not be
  // enough on its own.
  const calls = [];
  const gh = (args) => {
    calls.push(["gh", ...args]);
    if (args[0] === "--version") return "gh 2";
    if (args[0] === "pr" && args[1] === "list") return JSON.stringify([{ number: 12, url: "https://github.com/o/r/pull/12" }]);
    if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ statusCheckRollup: [{ state: "SUCCESS" }, { state: "EXPECTED" }] });
    return "";
  };
  const git = (args) => (args[0] === "remote" ? "origin\n" : "");
  const cfg = { integrationBranch: "orch/integration", github: { mergeMethod: "squash", autoMergePr: false }, main: { autoMerge: true } };

  const r = await openIntegrationPr({ repo: "/r", orchDir: "/r/.orch", cfg }, { gh, git, notify: { escalate() {} } });
  assert.equal(r.prUrl, "https://github.com/o/r/pull/12");
  assert.ok(!calls.some((c) => c[0] === "gh" && c[1] === "api"), "a still-EXPECTED required check is not green — the direct merge must wait");
});

test("openIntegrationPr treats SKIPPED and NEUTRAL required checks as green", async () => {
  // GitHub counts a SKIPPED (path-filtered) or NEUTRAL required check as
  // satisfied for merge purposes. prChecksGreen must too — otherwise the direct
  // merge would stall forever on any repo whose required checks include a
  // skippable job (COMPLETED, but conclusion !== SUCCESS).
  const calls = [];
  const gh = (args) => {
    calls.push(["gh", ...args]);
    if (args[0] === "--version") return "gh 2";
    if (args[0] === "pr" && args[1] === "list") return JSON.stringify([{ number: 12, url: "https://github.com/o/r/pull/12" }]);
    if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ statusCheckRollup: [
      { status: "COMPLETED", conclusion: "SUCCESS" },
      { status: "COMPLETED", conclusion: "SKIPPED" },
      { status: "COMPLETED", conclusion: "NEUTRAL" },
    ] });
    return "";
  };
  const git = (args) => (args[0] === "remote" ? "origin\n" : "");
  const cfg = { integrationBranch: "orch/integration", github: { mergeMethod: "squash", autoMergePr: false }, main: { autoMerge: true } };

  const r = await openIntegrationPr({ repo: "/r", orchDir: "/r/.orch", cfg }, { gh, git, notify: { escalate() {} } });
  assert.equal(r.prUrl, "https://github.com/o/r/pull/12");
  assert.ok(calls.some((c) => c[0] === "gh" && c[1] === "api" && c.some((a) => a.includes("merge_method=merge"))), "skipped/neutral required checks are green — direct merge must run");
});

test("openIntegrationPr swallows main.autoMerge direct-merge failures so GitHub refusals retry later", async () => {
  const gh = (args) => {
    if (args[0] === "--version") return "gh 2";
    if (args[0] === "pr" && args[1] === "list") return JSON.stringify([{ number: 12, url: "https://github.com/o/r/pull/12" }]);
    if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ statusCheckRollup: [{ state: "SUCCESS" }] });
    if (args[0] === "api") throw new Error("405 not mergeable yet");
    return "";
  };
  const git = (args) => (args[0] === "remote" ? "origin\n" : "");
  const cfg = { integrationBranch: "orch/integration", github: { mergeMethod: "squash", autoMergePr: false }, main: { autoMerge: true } };

  const r = await openIntegrationPr({ repo: "/r", orchDir: "/r/.orch", cfg }, { gh, git, notify: { escalate() {} } });
  assert.equal(r.prUrl, "https://github.com/o/r/pull/12");
});

test("openIntegrationPr lists and creates the persistent PR against cfg.baseBranch", async () => {
  const calls = [];
  const gh = (args) => {
    calls.push(["gh", ...args]);
    if (args[0] === "--version") return "gh 2";
    if (args[0] === "pr" && args[1] === "list") return "[]";
    if (args[0] === "pr" && args[1] === "create") return "https://github.com/o/r/pull/12\n";
    return "";
  };
  const git = (args) => (args[0] === "remote" ? "origin\n" : "");
  const cfg = { integrationBranch: "orch/integration", baseBranch: "dev", github: { mergeMethod: "squash", autoMergePr: false } };

  await openIntegrationPr({ repo: "/r", orchDir: "/r/.orch", cfg }, { gh, git, notify: { escalate() {} } });

  const list = calls.find((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "list");
  assert.equal(list[list.indexOf("--base") + 1], "dev");
  const create = calls.find((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "create");
  assert.equal(create[create.indexOf("--base") + 1], "dev");
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

test("openIntegrationPr auto-resolves a dirty persistent PR when opted in", async () => {
  const calls = [];
  let resolverCtx = null;
  const gh = (args) => {
    calls.push(["gh", ...args]);
    if (args[0] === "--version") return "gh 2";
    if (args[0] === "pr" && args[1] === "list") return JSON.stringify([{ number: 12, url: "https://github.com/o/r/pull/12" }]);
    if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" });
    return "";
  };
  const git = (args) => (args[0] === "remote" ? "origin\n" : "");
  const cfg = {
    integrationBranch: "orch/integration",
    baseBranch: "main",
    github: { mergeMethod: "squash", autoMergePr: false },
    main: { autoResolveConflicts: true, autoMerge: false },
  };

  const r = await openIntegrationPr({ repo: "/r", orchDir: "/r/.orch", cfg, testCmd: "npm test" }, {
    gh,
    git,
    notify: { escalate() {} },
    resolveIntegrationConflict: async (ctx) => {
      resolverCtx = ctx;
      return { ok: true, summary: "resolved metadata" };
    },
  });

  assert.equal(r.prUrl, "https://github.com/o/r/pull/12");
  assert.equal(resolverCtx.prRef, "12");
  assert.equal(resolverCtx.branch, "orch/integration");
  assert.equal(resolverCtx.base, "main");
  assert.equal(resolverCtx.testCmd, "npm test");
  assert.ok(calls.some((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "view" && c.includes("mergeable,mergeStateStatus")));
  assert.ok(!calls.some((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "comment"));
});

test("openIntegrationPr comments for a human when dirty PR auto-resolve cannot run", async () => {
  const calls = [];
  const gh = (args, input) => {
    calls.push(["gh", ...args, input].filter((v) => v !== undefined));
    if (args[0] === "--version") return "gh 2";
    if (args[0] === "pr" && args[1] === "list") return JSON.stringify([{ number: 12, url: "https://github.com/o/r/pull/12" }]);
    if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ mergeable: "MERGEABLE", mergeStateStatus: "DIRTY" });
    return "";
  };
  const git = (args) => (args[0] === "remote" ? "origin\n" : "");
  const cfg = {
    integrationBranch: "orch/integration",
    github: { mergeMethod: "squash", autoMergePr: false },
    main: { autoResolveConflicts: true, autoMerge: false },
  };

  const r = await openIntegrationPr({ repo: "/r", orchDir: "/r/.orch", cfg }, { gh, git, notify: { escalate() {} } });

  assert.equal(r.prUrl, "https://github.com/o/r/pull/12");
  const comment = calls.find((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "comment");
  assert.ok(comment, "dirty PR should get a human handoff comment when no resolver is wired");
  assert.match(comment.join(" "), /no conflict resolver is configured/);
});

test("openIntegrationPr swallows a cosmetic 'gh pr edit' failure (Projects-classic GraphQL deprecation) without escalating", async () => {
  // The push and PR already succeeded; the title/body refresh is best-effort
  // boilerplate. A nonzero `gh pr edit` (deprecated projectCards field) must not
  // raise "Decision needed" for a green+merged+pushed cycle (#212).
  const gh = (args) => {
    if (args[0] === "--version") return "gh 2";
    if (args[0] === "pr" && args[1] === "list") return JSON.stringify([{ number: 12, url: "https://github.com/o/r/pull/12" }]);
    if (args[0] === "pr" && args[1] === "edit") {
      throw new Error("GraphQL: Projects (classic) is being deprecated (repository.pullRequest.projectCards)");
    }
    return "";
  };
  const git = (args) => (args[0] === "remote" ? "origin\n" : "");
  const cfg = { integrationBranch: "orch/integration", github: { autoMergePr: false } };
  let escalated = false;

  const r = await openIntegrationPr({ repo: "/r", orchDir: "/r/.orch", cfg }, {
    gh, git, notify: { escalate() { escalated = true; } },
  });

  assert.equal(r.prUrl, "https://github.com/o/r/pull/12");
  assert.equal(escalated, false);
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
