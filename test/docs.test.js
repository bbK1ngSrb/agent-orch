import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ORCH_DOC } from "../src/cli.js";
import { MAX_REDRIVE_ATTEMPTS } from "../src/deferred.js";
import { DEFAULT_PROTECTED } from "../src/intake/allowlist.js";
import { nativeAgents } from "../src/adapters/index.js";

const rootUrl = new URL("../", import.meta.url);
const rootDir = fileURLToPath(rootUrl);
const read = (rel) =>
  readFileSync(fileURLToPath(new URL(rel, rootUrl)), "utf8");

const pkg = JSON.parse(read("package.json"));
const claude = read("CLAUDE.md");
const readme = read("README.md");
const landing = read("docs/index.html");
const manual = read("docs/orch-manual.md");
const exampleConfig = read("orch.example.yml");
const coc = read("CODE_OF_CONDUCT.md");
const changelog = read("CHANGELOG.md");

const NUMBER_WORDS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight",
  "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen",
  "sixteen", "seventeen", "eighteen", "nineteen", "twenty",
];

test("the CLI bin is `orch`", () => {
  assert.deepEqual(Object.keys(pkg.bin), ["orch"]);
});

test("README does not promise install commands that resolve to a different npm package", () => {
  // `agent-orch` on npm is an unrelated package, and this CLI's bin is `orch`,
  // so these invocations would not run this project. Guard against regressions.
  assert.doesNotMatch(readme, /npx\s+agent-orch/);
  assert.doesNotMatch(readme, /npm\s+install\s+-g\s+agent-orch/);
});

test("README documents the `orch` CLI", () => {
  assert.match(readme, /orch\s+init/);
  assert.match(readme, /orch agent add <name>/);
});

test("docs explain that `orch pr --merge` pins the reviewed PR head (#421)", () => {
  // runPr() sends the fetched branch SHA to GitHub's merge endpoint. If a
  // contributor updates the PR during review, GitHub returns 409 and orch asks
  // the operator to audit the new head instead of merging unseen code.
  for (const doc of [readme, manual]) {
    assert.match(doc, /merge request[\s\S]{0,100}pinned|pins[\s\S]{0,100}merge request/i);
    assert.match(doc, /PR head[\s\S]{0,120}moves[\s\S]{0,160}re-run\s+`orch pr[^`]*--merge`/i);
    assert.match(doc, /new head is audited|agents never saw/i);
  }
});

test("the manual names the REST merge endpoint `orch pr --merge` uses (#421)", () => {
  // mergeDirect() PUTs repos/{owner}/{repo}/pulls/<n>/merge rather than
  // shelling out to `gh pr merge`, whose client-side precheck is blind to
  // ruleset bypasses and refuses merges the server would accept. A manual
  // that leaves this out sends readers to the wrong command when they debug
  // a refused merge.
  assert.match(manual, /pulls\/<n>\/merge/);
  assert.match(manual, /precheck[\s\S]{0,80}bypass|bypass[\s\S]{0,80}precheck/i);
});

test("docs list the built-in CLI adapters", () => {
  for (const doc of [readme, exampleConfig]) {
    assert.match(doc, /claude/);
    assert.match(doc, /codex/);
    assert.match(doc, /copilot/);
    assert.match(doc, /gemini/);
  }
});

test("docs document the dashboard --check-history flag", () => {
  // Shipped with `orch dashboard --check-history`; guard the prose docs against
  // drift from the CLI help/completion where the flag already lives.
  for (const doc of [readme, manual]) {
    assert.match(doc, /--check-history/);
  }
  // `--check-history` reconciles history at *display* time only: dashboard.js's
  // reconcileHistory returns fresh `{ ...e, resolved: true }` objects for the
  // render and never writes back to runs.jsonl. The docs must not imply an
  // on-disk rewrite/repair, or users will expect the history file to change.
  assert.doesNotMatch(manual, /rewrites stale red history/);
  assert.match(manual, /runs\.jsonl.*(untouched|unchanged)|(untouched|unchanged).*runs\.jsonl/i);
  assert.match(readme, /view-only|view only/i);
});

test("docs document the dashboard's cached state reads", () => {
  // perf(dashboard) (#438): snapshot() caches checkpoints/runs.jsonl/log tails
  // keyed on file stat (mtime+size+inode), and latestLog serves the tail from
  // the last 16 KiB of the round file instead of loading it whole. The docs
  // must note the cache so readers don't expect a full re-read on every
  // live-TUI poll.
  for (const doc of [readme, manual]) {
    assert.match(doc, /mtime\/size\/inode/);
    assert.match(doc, /16 KiB/);
  }
});

test("docs document the 'authored' checkpoint stage", () => {
  // fix(engine): the checkpoint's first write now lands at author-commit time
  // with stage "authored", so a cycle that died during round-1 review is
  // addressable by `orch continue <sid>` instead of reporting nothing to
  // resume. Docs must also say the stage grants no shortcut, or readers will
  // assume a resume after a round-1 crash skips review.
  for (const doc of [readme, manual]) {
    assert.match(doc, /"authored"/);
    assert.match(doc, /still\s+audits\s+and\s+still\s+gates\s+from\s+round\s+1/);
  }
});

test("the generated per-repo ORCH.md template documents all dashboard flags", () => {
  // `orch init` writes ORCH_DOC verbatim to .orch/ORCH.md and overwrites it on
  // every init, so it must track the CLI. The prose-docs test above only covers
  // README/manual and would miss the template drifting out of sync (it once
  // advertised only `--json`).
  assert.match(ORCH_DOC, /--json/);
  assert.match(ORCH_DOC, /--limit/);
  assert.match(ORCH_DOC, /--check-history/);
});

test("README documents bash completion install/update behavior", () => {
  assert.match(pkg.scripts.postinstall, /completion install/);
  assert.match(readme, /~\/\.orch\/completion\.bash/);
  assert.match(readme, /orch completion bash/);
  assert.match(readme, /orch completion install/);
});

test("npm pack dry-run excludes test files from the package", () => {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: rootDir,
    encoding: "utf8",
    env: {
      ...process.env,
      npm_config_cache: "/tmp/npm-cache-agent-orch",
      npm_config_loglevel: "silent",
      npm_config_update_notifier: "false",
    },
  });
  const [{ files }] = JSON.parse(out);
  assert.deepEqual(files.map((f) => f.path).filter((p) => p.endsWith(".test.js")), []);
});

test("README documents the auto docs-update feature and its loop guard", () => {
  assert.match(readme, /docs.autoUpdate/);
  assert.match(readme, /[Ll]oop guard/);
  assert.match(readme, /no-op/); // guard covers empty-diff merges too
});

test("prose docs describe the protected-path intake refusal and its override", () => {
  // The refusal is a hard stop on a command users ran successfully before, and
  // it fires at intake — no run, no branch, no DECISION.md to inspect. The
  // stderr line names `--allow-protected` as the remedy, so every surface a
  // reader consults for it must mention it, not just `--help`.
  for (const doc of [readme, manual, ORCH_DOC]) {
    assert.match(doc, /--allow-protected/);
    assert.match(doc, /protected path/i);
  }
  // "Unsatisfiable" is only true of a work order that REQUIRES a protected
  // change; an incidental mention run with the override can merge normally.
  assert.match(manual, /genuinely requires[\s\S]{0,80}unsatisfiable by\s+construction/i);
  // Correct mechanism (#406): guardrail-touch escalates first on an ordinary
  // protected-path diff. checkPaths is only the merge-boundary backstop (and
  // the unique `..` fail-closed). Do not pin checkPaths as the primary blocker.
  for (const doc of [manual, ORCH_DOC]) {
    assert.match(doc, /guardrail-touch/);
  }
  assert.match(manual, /guardrail-touch[\s\S]{0,120}fires first/i);
  assert.match(manual, /checkPaths[\s\S]{0,80}backstop/i);
  assert.doesNotMatch(
    manual,
    /security scan passes, and \*?then\*?[\s\S]{0,40}`checkPaths`/i,
  );
  assert.doesNotMatch(manual, /the boundary is `checkPaths`/i);
  // The manual's §2.14 list reads as exhaustive, so a new denylist entry that
  // never reaches the prose recreates this exact defect: a refusal the doc
  // says cannot happen.
  for (const p of DEFAULT_PROTECTED) assert.ok(manual.includes(p), `manual omits ${p}`);
  // A real guardrail change has no staged branch unless the operator passes
  // the override — prose that says "let the cycle escalate" without it
  // describes a workflow that never starts.
  for (const doc of [manual, ORCH_DOC]) {
    assert.match(doc, /--allow-protected[`']? to have orch stage it/i);
  }
});

test("every command surface documents `orch release`", () => {
  // The bookkeeping for a hand-landed escalation is only discoverable if the
  // doc that tells you to hand-merge also tells you to close the recovery.
  // ORCH_DOC ships verbatim into every initialized repo, so a command missing
  // from its list is missing for every user of that repo — that is how
  // `release` stayed absent there while README and the manual carried it.
  for (const doc of [readme, manual, ORCH_DOC]) {
    assert.match(doc, /orch release "/, "surface omits the orch release command");
  }
  assert.match(ORCH_DOC, /^- `orch release "<entry>"`/m);
  // The manual's Part 2 is the command reference; release needs its own
  // heading there, not just a mention inside the recovery procedure.
  assert.match(manual, /^### 2\.\d+ `orch release /m);
  // Claims that must stay true of src/git.js bumpVersion(): it refuses a dirty
  // tree and never tags (CI tags on push).
  for (const doc of [readme, manual]) {
    assert.match(doc, /clean working\s+tree/i);
    assert.match(doc, /not[*]{0,2} create (a |or push a )?git tag/i);
  }
});

test("`orch release` is never documented as unconditional recovery", () => {
  // finalize.js only bumps under cfg.release.autoBump, which config.js defaults
  // to false — but cli.js's release handler bumps unconditionally. So in a
  // default repo a hand merge skips *nothing*, and "always run orch release
  // afterwards" would manufacture a chore(release) commit that repo opted out
  // of. Every mention must therefore sit next to the autoBump caveat; a bare
  // presence check would pass on docs that mention autoBump elsewhere.
  const WINDOW = 700;
  for (const [name, doc] of [["README.md", readme], ["orch-manual.md", manual], ["ORCH_DOC", ORCH_DOC]]) {
    for (const m of doc.matchAll(/orch release/g)) {
      const near = doc.slice(Math.max(0, m.index - WINDOW), m.index + WINDOW);
      assert.match(
        near,
        /autoBump/,
        `${name}: 'orch release' at offset ${m.index} is not qualified by release.autoBump nearby`,
      );
    }
  }
  // And the asymmetry itself must be stated somewhere: the command ignores the
  // flag that decides whether a clean merge would have bumped at all.
  assert.match(manual, /never \*?reads\*? `release\.autoBump`|never consults `?autoBump/i);
});

test("roundCap docs describe total review rounds, not post-DISAGREE revisions only", () => {
  // Engine starts round at 1 and escalates when round >= roundCap, so the cap
  // counts the initial review. "author-revise rounds after a DISAGREE" would
  // under-count by one and mislead capacity planning (default 3 → 3 reviews /
  // 2 revisions, not 4 / 3). roundCap is the renamed key (#370); reviseCap is
  // now only the deprecated alias, so the docs must describe roundCap while
  // still telling readers reviseCap still works.
  assert.doesNotMatch(manual, /author-revise rounds happen after a\s+`DISAGREE`/i);
  assert.match(manual, /initial review is round\s+one, so 3 buys 3 reviews and 2 revisions/i);
  assert.match(manual, /old\s+name `reviseCap` still works/i);
  for (const src of [exampleConfig, read("src/cli.js")]) {
    assert.match(src, /roundCap:.*max review rounds incl\. the first/);
    assert.doesNotMatch(src, /roundCap:.*max revise rounds before escalation/);
  }
  assert.match(
    read("src/config-wizard.js"),
    /Maximum review rounds including the first/,
  );
});

test("manual documents the empty-diff escalation before each review round", () => {
  // engine.js escalates when the branch has no diff against its base instead of
  // sending an empty patch to a reviewer — an `AGREE` on nothing would otherwise
  // walk straight through the test gate to a merge of zero changes.
  const engine = read("src/engine.js");
  // The guard reads the round's memoized diff (keyed by the captured OID), so
  // it is the same file list the merge boundary later gates on.
  assert.match(engine, /changedFilesAt\(reviewedSha\)\.length === 0/);
  assert.match(engine, /author produced no changes — nothing to review/);
  // The manual hard-wraps at ~78 cols, so the quoted reason spans a line break.
  assert.match(manual, /author\s+produced\s+no\s+changes\s+—\s+nothing\s+to\s+review/);
  // The guard sits inside the round loop, so docs must say the check repeats.
  assert.match(manual, /Before each round/);
  // ...but it diffs the WHOLE branch against its base, so a revision that adds
  // nothing new still leaves round one's diff in place and the loop runs to the
  // cap (test/engine.test.js "DISAGREE until cap"). Docs must not claim the
  // guard stops every no-op revision.
  // Every space is \s+ so a reflow of the hard-wrapped manual can't turn these
  // red while the prose is still correct.
  assert.match(manual, /whole\s+branch\*?\s+against\s+its\s+base/);
  assert.match(manual, /adds\s+nothing\s+new\s+keeps\s+the\s+earlier\s+diff/);
  assert.match(manual, /still\s+runs\s+to\s+`roundCap`/);
  assert.doesNotMatch(manual, /a revision that changes nothing stops the loop/);
  // The top-level "what makes a cycle escalate" list must name it too.
  assert.match(manual, /an\s+author\s+that\s+produced\s+no\s+changes\s+at\s+all/);
});

test("orch.example.yml exposes security.ignore, commented out, with the sharp-edge warning", () => {
  // The escape hatch exists in the defaults but a user only ever sees the
  // example file, so it must appear there — and stay commented, since an
  // uncommented entry would hand every copier a live exemption.
  assert.match(exampleConfig, /#\s*security:/);
  assert.match(exampleConfig, /#\s+ignore:/);
  assert.doesNotMatch(exampleConfig, /^security:/m);
  assert.match(exampleConfig, /exempting a path skips EVERY security rule/i);
  assert.match(exampleConfig, /never\s+authored code/i);
});

test("docs do not claim the security scan covers every added line", () => {
  // addedCodeLines() drops markdown and docs paths before any rule runs, so an
  // empty security.ignore is NOT "everything is scanned".
  assert.doesNotMatch(manual, /Empty by default: everything is scanned/);
  for (const doc of [readme, manual, exampleConfig]) {
    assert.match(doc, /markdown and `docs\/\*\*` paths are dropped/);
  }
  for (const doc of [readme, manual]) {
    assert.match(doc, /guardrail file[^.]{0,60}under `docs\/`/);
    // Only `docs/CODEOWNERS` is a guardrail path under `docs/` (GUARDRAIL_PATH_RES
    // in src/security-review.js), so the docs must name it rather than
    // generalize to "guardrail files under `docs/`".
    assert.match(doc, /`docs\/CODEOWNERS` trips a\s+`guardrail-touch` finding/);
  }
});

test("docs document that the version bump on merge is opt-in via release.autoBump", () => {
  // finalize() only calls bumpVersion() when release.autoBump is true (default
  // off), so the prose must not promise an unconditional post-merge bump.
  for (const doc of [readme, manual, exampleConfig]) {
    assert.match(doc, /release\.autoBump|autoBump: false/);
  }
  for (const doc of [readme, manual]) {
    assert.match(doc, /release\.autoBump/);
    assert.match(doc, /[Oo]pt-in|off by default/);
  }
  // the FAQ answer must point at the flag, not just at merge modes
  const faqStart = manual.indexOf('"Why didn\'t my version get bumped?"');
  const faq = manual.slice(faqStart, manual.indexOf('"I ran `orch review`', faqStart));
  assert.match(faq, /release\.autoBump/);
});

test("docs do not promise a fallback bump outside the local integration path", () => {
  for (const doc of [readme, manual]) {
    assert.doesNotMatch(doc, /every merge is traceable to a version/);
    assert.doesNotMatch(doc, /version moves exactly once per landing/);
    assert.doesNotMatch(doc, /version-bump\.yml/);
  }
  assert.match(readme, /outside orch carries no version bump/);
  assert.match(manual, /outside the local integration path keeps\s+the existing package version/);
  assert.match(manual, /node scripts\/orch-release\.js/);
});

test("docs document main.autoMerge for the persistent integration PR", () => {
  for (const doc of [readme, manual, exampleConfig]) {
    assert.match(doc, /main\.autoMerge|autoMerge: false/);
  }
  assert.match(manual, /persistent `orch\/integration → main` PR/);
  assert.match(readme, /direct merge of that\s+persistent PR/);
});

test("docs explain main.autoMerge is pinned to the verified integration tip (#422 part 4)", () => {
  // tryMergeDirect / openIntegrationPr pass the tip this cycle pushed as sha=.
  // A concurrent peer that advances the head is legitimate green work — 409 is
  // logged once and that peer owns the newer tip; other errors stay swallowed.
  for (const doc of [readme, manual]) {
    assert.match(doc, /pinned to the\s+integration tip this cycle (?:pushed and )?verified/i);
    assert.match(
      doc,
      /integration advanced past\s+the commit this cycle verified/i,
    );
    assert.match(doc, /newer cycle will\s+merge it/i);
  }
  assert.match(manual, /sha=/);
});

test("docs explain merge: pr's one-shot direct fallback (#426)", () => {
  const sections = [
    readme.slice(readme.indexOf("**`merge: pr` — per-cycle PR mode."), readme.indexOf("## Version bump on merge")),
    manual.slice(manual.indexOf("### 3.3 `merge: pr`"), manual.indexOf("### 3.4 `merge-deferred`")),
  ];
  for (const section of sections) {
    assert.match(section, /one immediate REST\s+merge attempt/i);
    assert.match(section, /numeric PR (?:id|number)/i);
    assert.match(section, /pinned to the\s+exact reviewed commit OID/i);
    assert.match(section, /does not poll or\s+retry/i);
  }
  assert.doesNotMatch(manual, /one-shot[^.]{0,100}has no such fallback/i);
});

test("docs explain headless self-merge needs bypass or a second reviewer identity", () => {
  for (const doc of [readme, manual, ORCH_DOC]) {
    assert.match(doc, /approve its own PR|self-approval/);
    assert.match(doc, /bypass_actors/);
    assert.match(doc, /cross-audit/);
  }
  assert.match(manual, /GitHub approval is bypassed, not recorded/);
});

test("CLAUDE routes agent changes through the persistent integration PR", () => {
  assert.match(claude, /Agent-generated changes destined for `main` must start as a GitHub Issue/);
  assert.match(claude, /Never hand-author a direct agent PR to `main`/);
  assert.match(claude, /ambient\s+`gh` identity—the repo owner—not `orch\[bot\]`/);
  assert.match(claude, /does not allow a PR author\s+to approve its own PR/);
  assert.match(claude, /single persistent `orch\/integration → main` PR/);
  assert.match(claude, /trivial human\/owner chore or\s+documentation change may still use a direct owner PR/);
});

test("landing page is plain static HTML with social metadata", () => {
  assert.match(landing, /<meta property="og:title" content="orch - agents orchestration tool">/);
  assert.match(landing, /<meta property="og:description"/);
  assert.match(landing, /<meta property="og:image"/);
  assert.match(landing, /<meta name="twitter:card" content="summary_large_image">/);
  assert.match(landing, /Run local coding agents[\s\S]*cross-audit loop/);
  assert.match(landing, /npm install -g[\s\S]*@bbk1ng\/agent-orch/);
  assert.doesNotMatch(landing, /__bundler/);
  assert.doesNotMatch(landing, /<x-dc/i);
  assert.doesNotMatch(landing, /This page requires JavaScript to display/);
});

test("landing page includes mobile layout overrides", () => {
  assert.match(landing, /@media \(max-width: 640px\)/);
  assert.match(landing, /\.loop-grid, \.feature-grid \{ grid-template-columns: 1fr; \}/);
  assert.match(landing, /\.hero-actions \{ flex-direction: column; align-items: stretch; \}/);
  assert.match(landing, /\.command \{ grid-template-columns: 1fr; gap: 6px; \}/);
});

test("docs explain stale `orch continue` resume handling", () => {
  for (const doc of [readme, manual]) {
    assert.match(doc, /orch continue <sid>/);
    assert.match(doc, /stale/);
    assert.match(doc, /origin\/<branch>/);
    assert.match(doc, /check it out locally/);
  }
});

test("docs explain checkpoint verdicts are pinned to the branch head OID (#422)", () => {
  for (const doc of [readme, manual]) {
    assert.match(doc, /branch head commit OID/);
    assert.match(doc, /unverifiable/);
  }
  assert.match(manual, /rev-parse --verify refs\/heads\/<branch>/);
  assert.match(manual, /tag[\s\S]{0,60}share the branch's name/);
});

test("docs explain the round's single OID capture and consumption-time re-check (#422 part 5)", () => {
  for (const doc of [readme, manual]) {
    assert.match(doc, /captured once per review round/);
    assert.match(doc, /re-(?:checked|verified)[\s\S]{0,80}cached verdict is consumed/);
    assert.match(doc, /moves?[\s\S]{0,20}mid-round[\s\S]{0,120}launder\s+unaudited\s+content/);
  }
});

test("docs describe all pre-landing sync reconciliations", () => {
  for (const doc of [readme, manual]) {
    assert.match(
      doc,
      /`sync`[\s\S]{0,100}local `main` from\s+`origin\/main`[\s\S]{0,100}local `orch\/integration` from `origin\/orch\/integration`[\s\S]{0,100}`orch\/integration` from the base branch/,
    );
    assert.match(doc, /fast-forwards?[\s\S]{0,80}local integration branch/);
    assert.match(doc, /genuine divergence (?:instead )?demotes[\s\S]{0,20}`sync`/);
  }
});

test("the deleted orch-docs Action is not claimed anywhere (#402)", () => {
  // orch-docs.yml needed a self-hosted runner labelled `orch`; none was ever
  // registered, so every dispatch queued until GitHub cancelled it — 28
  // cancelled runs, zero successes, and no failure signal. It was deleted in
  // v0.4.211 and doc refresh now belongs solely to orch's local surface
  // (`docs.autoUpdate`). This test is inverted on purpose: the failure mode
  // worth guarding is a doc that promises an automation the repo does not have.
  assert.equal(existsSync(new URL(".github/workflows/orch-docs.yml", rootUrl)), false);
  // Naming the workflow *path* is how a doc presents it as live; both docs may
  // still mention the bare filename while explaining that it was removed.
  for (const doc of [readme, manual]) assert.doesNotMatch(doc, /workflows\/orch-docs\.yml/);
});

test("CODE_OF_CONDUCT gives an actionable private contact for enforcement", () => {
  const enforcement = coc.slice(coc.indexOf("## Enforcement"));
  assert.match(enforcement, /[\w.+-]+@[\w-]+\.[\w.-]+/); // a real email address
});

test("landing header version span matches package.json and the bump regex still matches it (#192)", () => {
  // The site is a built artifact; the release bump rewrites its header version
  // span in src/git.js. If the design tool re-exports with a different closing-
  // tag escaping, the bump regex silently no-ops and the version freezes — so
  // guard both the current value and that the regex actually matches it.
  assert.match(landing, new RegExp(`>v${pkg.version.replace(/\\./g, "\\.")}</span>`));
  const bumpRe = /v\d+\.\d+\.\d+(?=<(?:\\u002F|\\\/|\/)span>)/;
  assert.match(landing, bumpRe);
});

test("CHANGELOG documents the latest merged fixes", () => {
  const unreleased = changelog.slice(
    changelog.indexOf("## Unreleased"),
    changelog.indexOf("## 0.3.18"),
  );
  assert.match(unreleased, /numeric PR id/);
  assert.match(unreleased, /designer-template leftovers/);
  assert.match(unreleased, /escaping nested `<\/script>` close tags/);
});

test("docs document the automatic redrive of overlap-deferred cycles (#350)", () => {
  // finalize.js redriveDeferredPeers() rebases + re-gates an overlap-deferred
  // peer once the blocker lands. It shipped undocumented, and the FAQ told
  // users the only options were manual restructuring or accepting the deferral
  // as final — a user following that does work orch already does for them.
  for (const doc of [readme, manual]) {
    assert.match(doc, /redriv/i);
    // The redriven merge is re-gated, not trusted on its pre-rebase green run.
    assert.match(doc, /post-merge test gate|re-runs the merge and the test gate/);
    assert.match(doc, /gated, not(?: |\n *)trusted|gated, never(?: |\n *)trusted/);
    assert.match(doc, /cascade|deferred behind/i);
  }
  // finalize() returns on `cfg.merge === "pr"` before the lock, the overlap
  // guard, and deferred.record() — the redrive is local-integration-path only,
  // and §3.4 otherwise reads as "any merge mode".
  for (const doc of [readme, manual]) assert.match(doc, /`merge: pr`[\s\S]{0,40}no shared/);
  // The one-attempt cap is a source constant; docs must not promise retries.
  assert.equal(MAX_REDRIVE_ATTEMPTS, 1);
  for (const doc of [readme, manual]) assert.match(doc, /one automatic attempt/);
  // The `pr/*` head deletion in finalize.js is gated on `pr.prUrl` — a failed PR
  // bridge keeps the head AND the escalation PR, so the manual must not promise
  // cleanup unconditionally or a human reads a live PR as unfinished work.
  const finalize = readFileSync(new URL("src/finalize.js", rootUrl), "utf8");
  assert.match(finalize, /if \(pr\.prUrl && branch/);
  const redrive = manual.slice(manual.indexOf("Automatic redrive of `overlap`"));
  assert.match(redrive.slice(0, redrive.indexOf("\n**Takeaway")), /cleanup is \*\*conditional\*\*/);

  // The FAQ entry must lead with "wait", not with hand-restructuring the runs.
  const faq = manual.slice(manual.indexOf("Two cycles I ran at once"));
  const entry = faq.slice(0, faq.indexOf("\n- **"));
  assert.match(entry, /usually you do nothing/);
  assert.ok(
    entry.indexOf("usually you do nothing") < entry.indexOf("disjoint file scopes"),
    "the FAQ must lead with the automatic redrive, not with manual disjoint scoping",
  );
});

test("docs document the empty-diff escalation and CI tag derivation (#412/#409/#415/#416)", () => {
  // engine.js escalates before the first review round when the author branch
  // has no changes against the base; docs must not imply the review loop runs
  // to roundCap on an empty diff (#412).
  const engine = read("src/engine.js");
  assert.match(engine, /author produced no changes/);
  // Manual hard-wraps the quoted reason across lines; README keeps it on one.
  assert.match(readme, /author produced no changes/);
  assert.match(manual, /author\s+produced\s+no\s+changes/);
  for (const doc of [readme, manual]) {
    assert.match(doc, /empty diff/i);
  }
  // tag-release.yml derives tags from the push's commit range via
  // scripts/release-tags.js (#409) and aborts when that script crashes (#415).
  // The manual's "CI tags on push" line must say both, or a reader expects
  // tip-only tagging with silent-drop failure modes.
  assert.match(manual, /every version tagged, not just the tip/);
  assert.match(manual, /fails loudly/);
  assert.match(manual, /scripts\/release-tags\.js/);
  // #416: GITHUB_TOKEN is refused when pushing a tag whose history reaches a
  // workflow-file change — reachability alone, not new content. Docs that only
  // promise "CI tags on push" leave operators blind to permanent untagged
  // releases; the ready-to-apply fix is in PLANNED.md (workflow path is
  // protected from orch authorship).
  assert.match(manual, /GITHUB_TOKEN/);
  assert.match(manual, /\.github\/workflows\//);
  assert.match(manual, /#416|PLANNED\.md/);
  assert.match(read("PLANNED.md"), /#416 tag-release API ref creation/);
});

test("the landing page tracks recently shipped surfaces (#403/#335)", () => {
  // docs/index.html is hand-maintained (no generator), so it drifts. Its
  // commands section missed `orch release` (#403, v0.4.214), and the adapter
  // chips missed kimi (#335) while README and orch.example.yml already
  // listed it.
  assert.match(landing, /orch release/);
  // Derive the chip assertions from the adapter registry (the single source
  // of truth, src/adapters/index.js) instead of hardcoding names — a
  // hardcoded `kimi` check would drift silently again the moment adapter #8
  // lands. Same idiom as test/cli.test.js's scaffold "Built-in:" check.
  assert.ok(nativeAgents.length >= 4, "expected the native adapter set to be non-trivial");
  for (const name of nativeAgents) {
    assert.match(landing, new RegExp(`<span class="chip">${name}</span>`));
  }
  // The two shipped cycle commands the section dropped must stay listed or
  // the same drift recurs for the primary agent-change entry point.
  assert.match(landing, /orch issue &lt;n&gt;/);
  assert.match(landing, /orch continue &lt;sid&gt;/);
  // The section shows a curated subset — printUsage (src/cli.js) lists more
  // commands — so the eyebrow must not bill it as the whole surface, and the
  // heading's count must match the actual <div class="command"> blocks.
  assert.doesNotMatch(landing, /The whole surface/);
  const commandCount = (landing.match(/<div class="command">/g) || []).length;
  const word = NUMBER_WORDS[commandCount];
  assert.ok(word, `unexpected command count: ${commandCount}`);
  assert.match(landing, new RegExp(`<h2>${word[0].toUpperCase()}${word.slice(1)} commands</h2>`));
});

test("FUTURE.md records the #323 decision instead of planning the rejected design", () => {
  // #323 was closed by rejecting rich `agents:` entries at config validation
  // (a7aea98), the opposite of the rotation-pool design FUTURE.md listed as
  // the 1-month plan. The roadmap must not promise what validation refuses.
  const future = read("FUTURE.md");
  assert.doesNotMatch(future, /parse `agents:` entries as full role specs/);
  assert.match(future, /decided against[\s\S]{0,200}#323/);
  assert.match(future, /bare adapter names/);
});
