# Implementation Plan — Reconciled Codebase Audit (2026-07-11)

## What this document is

This is the single, orch-ready correction plan produced by reconciling two independent
audits of the same tree:

- **`claude-codebase-audit-2026-07-11.md`** — eight fresh-eyes auditors + a four-verifier
  adversarial pass. 33 findings (7 HIGH, 14 MEDIUM, 18 LOW). Already internally verified.
- **`codex-codebase-audit-2026-07-11.md`** — a second-opinion audit. 6 findings
  (2 HIGH, 2 MEDIUM, 2 LOW). *Not* run through the Claude wave's adversarial verification.

Every Codex finding that is **unique** (not already in the Claude report) was
re-verified against the source before inclusion here — the grep/read receipts are in the
reconciliation notes below. This matters because the most important finding in the whole
audit — a security control that is silently never invoked — came from the Codex pass, not
the Claude wave. Two independent audits caught things one could not.

The plan is organized as **orch work orders**: each batch is sized to one `orch` cycle /
one PR, files are listed so concurrent cycles stay off shared files, and each carries the
acceptance tests that gate the merge. Items that require a **human design decision** before
orch can author them are marked ⚑ — do not hand those to `orch task` blind; decide the
intent first (they are collected in § *Decisions needed* at the end).

Finding IDs: `A*`/`B*`/`C*` are carried verbatim from the Claude report so its detail
still resolves. `X*` are the Codex-unique findings folded in here. Where the two audits
found the same thing, the fold is noted (Codex #3→A4, #5→B11, #6a→C14).

Test suite at plan time: **670/670 passing** — every defect below coexists with a green
suite. That is the whole lesson of the audit: these are the bugs that hide behind green.

---

## Reconciliation summary (what changed vs. the two source reports)

| Source finding | Disposition | Verification receipt |
|---|---|---|
| Codex #1 — security scanner not enforced | **PROMOTED to X1, top priority** | `grep -rn scanDiff src/` → only caller is `test/security-review.test.js`; `src/` has zero. Confirmed dead. |
| Codex #2 — release files bump every integration | **X2, HIGH but ⚑ design decision** | `finalize.js:133` calls `git.bumpVersion(integration, …)` unconditionally on the post-merge-test-pass path. Real — but intended for *this* repo. |
| Codex #3 — wizard inverts legacy conflict setting | **FOLDED into A4** | Both fixes require exporting the module-private `normalizeMainConfig` (confirmed private at `config.js:159`). Do them in one cycle. |
| Codex #4 — docs workflow pushes wrong branch | **X3, MEDIUM** | `orch-docs.yml:58` runs `git push origin HEAD:main` after `orch task`, whose output lands on `orch/integration`, not `HEAD`. Confirmed. |
| Codex #5 — src test ships in npm | **SAME as B11** | Identical finding; Codex adds the correct caveat that `.npmignore` alone can't fix it because `package.json#files` includes all of `src`. Adopt B11 with that caveat. |
| Codex #6 — `bins()` dead + `spawnDocsTask` fd leak | **`bins()` = C14; fd leak = new X4 (LOW)** | `cli.js:54` `openSync(...)` for the detached docs child is never closed in the parent. Confirmed. |
| Claude A1–C18 (minus the folds above) | **carried as-is** | Already adversarially verified in the source report. |

Net: **37 distinct findings** — 8 HIGH (7 Claude + X1; X2 is HIGH-but-gated), 15 MEDIUM,
18 LOW — down to 34 work items after folding the three overlaps.

---

## X1 (was Codex #1) — HIGH — The deterministic security scanner is never invoked

**Where:** `src/security-review.js` (`scanDiff`), `src/engine.js` (`runCycle`), `src/finalize.js`.
**What:** `scanDiff()` is a deterministic pattern scanner meant to be a *floor* the merge
path cannot talk its way past — it flags added lines that read secrets/env, open network
connections, spawn subprocesses, or mutate guardrails. Its **only** caller in the whole
repo is its own test file. `runCycle()` enforces protected-*path* rules but never runs the
scanner over the final patch. So a task that plants one of those risky behaviors can collect
reviewer approval, pass the test gate, and merge with the security control sitting unused.
**Why it's the top fix:** This is the one finding that is *worse* than any single-line bug,
and it is exactly the class of defect a code-vs-code audit exists to catch — nothing crashes,
the tests are green, the control simply does nothing. It is also the finding the larger
Claude wave missed (it verified "no shell injection" but never checked whether the scanner
is wired), which is the argument for keeping a second independent auditor.
**Fix direction:** Immediately before finalization — on **both** the normal `finalize()`
path and the `noMerge`/PR-bridge approval return — obtain the full base→task-branch diff,
run `scanDiff()`, and escalate-without-merging on any finding. Treat an *unavailable* diff
as fail-closed (escalate), because the gate cannot prove an unseen patch safe.
**Acceptance tests:** Final diffs containing (a) env/secret read, (b) network open,
(c) subprocess spawn, (d) guardrail mutation each escalate and never call `finalize()`.
Drive at least one risky case through the `noMerge` PR-bridge path — it must escalate, not
approve. A clean diff still finalizes normally.

---

## HIGH severity — the Claude-verified set (fix-first)

Full mechanism + fix for each is in `claude-codebase-audit-2026-07-11.md` under the same ID;
condensed here so the plan is self-contained.

- **A1 — `redact.js` misses modern key formats.** `/sk-[A-Za-z0-9]{20,}/` never matches
  `sk-ant-api03-…` or `sk-proj-…` (hyphenated segments break the 20-char run). `redact()` is
  the only scrubber before public PR/issue text. **Fix:** broaden to `/sk-[A-Za-z0-9_-]{10,}/g`;
  add regression tests with realistic fake keys for both providers. `src/redact.js:10`.
- **A2 — `parseRunUsage` double-counts tokens + text overwrites parsed model.** Regex
  fallbacks run *on top of* parsed JSON (`+=`) → clean 2× token inflation; any plain-text
  `model: X` overwrites the JSON model, corrupting cost accounting. **Fix:** run regex path
  only when JSON parsing yielded nothing. `src/adapters/cli-adapter.js:150-206`.
- **A3 — three divergent `pidAlive` implementations.** `git.js` is Windows-hardened (alive
  iff `EPERM`); `inflight.js:47` and `lock.js:39-53` keep the pre-fix logic → a garbage
  numeric pid wedges the concurrency cap and the repo lock forever on Windows. **Fix:**
  extract one shared `pidAlive`; import in all three; test a non-ESRCH/non-EPERM code.
- **A4 (+ Codex #3) — config wizard: 4 unsettable keys, skips business validation, and can
  invert the legacy conflict alias.** The wizard calls bare `validate()` (type checks only),
  never the loader's `normalizeMainConfig()` (business rules like "resolver ≠ any
  reviewer/agent"), so it can rewrite a semantically-broken file as valid — and, per Codex
  #3, it serializes *both* `autoResolveConflicts: true` and `conflictResolution: manual`, so
  a reload flips auto-resolution off. **Fix (order matters):** (1) **export**
  `normalizeMainConfig` from `config.js` (currently private at `:159`); (2) have the wizard
  run it before `validate()` on every write; (3) serialize only the canonical
  `conflictResolution` field, not the deprecated alias; (4) add catalog entries for the four
  missing `main.*` keys. Acceptance: a config with only `autoResolveConflicts: true`
  round-trips to `conflictResolution: auto` with the alias dropped and auto-resolution still on.
- **A5 ⚑ — `printUsage`'s own example throws.** Help prints `orch task … --reviewer "codex"`;
  `task` rejects reviewer-only. **Decision:** either give `task` `allowReviewerOnly: true`
  (probably right — "rotation author, forced reviewer") or fix the example. Add a test that
  runs every printUsage example through the parser. `cli.js:1452` vs `:972`.
- **A6 + B4 — `orch agent add` confirm-path discards `--dry`/`--config-file` and never sets
  the escalation exit code.** `buildFn(name, { …, flags: {} })` forces empty flags → a
  confirmed `--dry` build does a **real** build (worktree/branch/merge), and CI sees exit 0
  on an escalated build. **Fix:** forward the real `flags`; mirror the sibling's
  `exitCode = 2` check. One code path, one PR. `cli.js:952` vs `:929`/`:935`.
- **A7 — TUI "… N more" history overflow hint can never fire.** `computeLayout()` hardcodes
  `history: 0`; overflowing history rows are invisible with no indicator. **Fix:** thread
  `historyCount` through `computeLayout` from `buildStructuredFrame`; add the layout test.
  `tui/layout.js:50`, `tui/loop.js:155-161`.

---

## X2 (was Codex #2) — HIGH ⚑ — Release files bump on every integration

**Where:** `src/finalize.js:133`, `src/git.js` (`bumpVersion`), `src/config.js`, `.orch/orch.yml`.
**What:** Every successful post-merge-test integration calls `git.bumpVersion(integration, …)`,
which edits+commits `package.json`, `package-lock.json`, `CHANGELOG.md`, `src/version.js`,
and the version in `docs/index.html`. A *generic* orchestration tool creating release
commits in every repo it touches is a policy imposition.
**Why this is ⚑ not a straight bug:** For *this* repo the per-merge bump is the intended,
documented policy (integration-path bump is how a merged sha maps to a bumped
`orch --version`). So the correct change is to make it **opt-in**, not to remove it.
**Fix direction (pending the decision below):** add a top-level `release.autoBump` boolean
defaulting to `false`; expose it in the wizard; call `bumpVersion()` only when enabled; set
it `true` in this repo. **Snag to resolve first:** `.orch/orch.yml` is git-ignored, so
enabling it "in this repo" doesn't propagate to clones — deciding *where* this repo's policy
lives is part of the decision (see § *Decisions needed*).
**Acceptance tests:** default / `false` → finalize does **not** call `bumpVersion()`;
`true` → calls it exactly once.

---

## MEDIUM severity

Carried from the Claude report unless marked. Full detail under the same ID there.

- **X3 (Codex #4) — docs workflow pushes the wrong branch.** `.github/workflows/orch-docs.yml:58`
  runs `git push origin HEAD:main` after `orch task`, but task output lands on
  `orch/integration` via the PR bridge, not on the checkout's `HEAD` — the push publishes
  nothing while the job reports success. **Fix:** drop the direct `HEAD:main` push; let
  `orch task` own integration publication through its PR bridge; keep `contents: write`
  (still needed to push `orch/integration`). Acceptance: workflow contains no `HEAD:main`
  push; token-step invariant still holds; a comment documents that `orch task` owns publish.
- **B1 — `globToRegExp` mistranslates `?`.** `?` survives as a regex quantifier, not glob
  "exactly one char"; silently wrong matching for `scope.ignore`/`docs.paths`/`cheap.paths`.
  **Fix:** `.replace(/\?/g, "[^/]")` + test. `src/scope.js:4-10`.
- **B2 — `runs.jsonl` `sid` written by 3 of 4 writers.** `engine.js`'s `recordTerminal`
  omits `sid`, so abnormally-ended runs are un-correlatable — the ones you most want to
  trace. One-line fix (`sid` already in scope). `engine.js:56-61`.
- **B3 (+ C17) — version comparison implemented twice, divergently.** `update-check.js`
  `compareVersions` (variable-length, but `parseInt` truncates prereleases) vs `upgrade.js`
  `cmpVersion` (hardcoded 3 segments). **Fix:** one shared comparator, unify on
  variable-length, handle prerelease; edge-case tests.
- **B5 — `orch task --file wo.json "stray"` silently drops the positional.** **Fix:** throw
  when `--file` and a positional are combined. `cli.js:996-1005`.
- **B6 — Windows `.cmd`/`.bat` fallback re-opens the cmd.exe quoting hazard.** Silent
  fallback spawns `cmd.exe /c` with unescaped metachars. **Fix:** warn on the fallback
  branch; escape/reject `& | ^ %`. `platform.js:41-52`.
- **B7 — agent stdout/stderr accumulate unbounded.** `maxBuffer` only reaches the
  `execFileSync` git calls, not the `spawn`ed agent; a runaway CLI can OOM the orchestrator
  (watchdog guards time, nothing guards volume). **Fix:** cap accumulation (first+last N MB).
  `cli-adapter.js`.
- **B8 — `model`/`effort` role options silently vanish on half the adapters.** `local` accepts
  neither; gemini/copilot/agy drop `effort`; config validates the *string* but not per-adapter
  support. **Fix:** per-adapter capability declaration + warn/error at parse time.
- **B9 ⚑ — unattended-approval bypass inconsistency.** `agy.js` passes no headless-approval
  flag (behavior unverified); only `claude.js` scopes its bypass with `--allowedTools`.
  **Fix:** test agy's real headless behavior once, then add flag or exonerating comment; add
  tool-scoping where CLIs support it, one comment where they don't.
- **B10 — pricing table can't price most adapters.** 4 entries for 6 adapters + 3 local
  models → `null` cost masquerades as free. **Fix:** add representative entries and render
  "unpriced" when no entry exists. `pricing.js`.
- **B11 (= Codex #5) — `src/tui/input.test.js` ships in the npm tarball.** It's the only test
  under `src/` (all others under `test/`). **Fix (Codex's caveat adopted):** *move* it to
  `test/tui/input.test.js` (or exclude `src/**/*.test.js` from `package.json#files`) —
  `.npmignore` alone cannot fix it because `files` includes all of `src`. Add a
  `npm pack --dry-run --json` assertion that no packed path ends in `.test.js`.
- **B12 — `orch init` SCAFFOLD drifted from `orch.example.yml`.** SCAFFOLD lacks `baseBranch`
  despite a comment claiming parity. **Fix:** generate SCAFFOLD from the example, or add a
  key-set-equality test. `cli.js:93-120`.
- **B13 ⚑ — dead ternary: empty LIVE panel never collapses.** `min.live = liveCount>0 ? 3 : 3`.
  **Decision:** collapse-when-empty (`? 3 : 1`) or keep the asymmetry and delete the dead
  conditional. `tui/layout.js:52,84`.
- **B14 — test-coverage holes** on `config-wizard` pair branch, `update-check` network-error
  paths, and `github.js` `pr-fallback` branch. Close in one testing pass.

---

## LOW severity — hygiene, dead code, edge guards

All carried from the Claude report (IDs unchanged) plus one Codex-unique addition (X4).
Mostly deletions and one-liners; safe to batch late.

- **X4 (Codex #6b) — `spawnDocsTask` leaks a parent-side fd.** `cli.js:54` `openSync(…auto-docs.log…)`
  is duplicated into the detached child but never closed in the parent → repeated docs spawns
  leak descriptors in the long-lived process. **Fix:** close the parent's fd in a `finally`
  after spawn; the child keeps its dup. Test: fd is closed even when spawn throws.
- **C1** dead "landed overlap" machinery (`finalize.js:92` `[]`, orphaned `changedSince`).
- **C2** triplicated `totalUsage`/`formatInt`/`formatUsd` → extract `src/usage.js`.
- **C3** four orphaned `git.js` exports + unreachable `moveMainToOrigin` `"reset"` (destructive
  `reset --hard`+`clean -fd`) branch — prioritize deleting the dead hard-reset path.
- **C4** redundant double directory scan in `finalize.js:85-90`.
- **C5** `slugify` can emit a trailing hyphen → `.slice(0,40).replace(/-+$/,"")`.
- **C6** crash-recovery state files written non-atomically (`checkpoint`/`resume`/`inflight`)
  → temp+`renameSync`. Defeats crash recovery in the crash it exists for.
- **C7** `refreshFallbackPrBody` bare-catch fails silently, leaving literal `<PR-number>` in
  the PR body → thread a `log`.
- **C8** NaN-tolerant `--limit abc` ≡ "everything" → `Number.isFinite && >0`.
- **C9** `orch pr <n>` skips the `^\d+$` check `orch issue <n>` does.
- **C10** dashboard "MERGED" label counts `pr`-verdict runs → rename or split.
- **C11** `visWidth` misses CJK/Hangul/fullwidth → extend `WIDE_GLYPH` or document ASCII-only.
- **C12** `truncate` overflows budget at width ≤ 0 → guard `width<=0 → ""`.
- **C13** legit $0 cost collapses to `null` (`num(...) || null`) → `Number.isFinite`.
- **C14 (= Codex #6a)** dead `bins()` export in `adapters/index.js:24-26` → delete.
- **C15** Windows PATH test builds `envPath` with POSIX delimiter → import `win32.delimiter`.
- **C16** `orch.example.yml:54` sets `conflictResolutionResolvers: [claude]` uncommented as if
  default (code default `null`) → comment out / annotate.
- **C17** prerelease-blind version compare → folded into B3.
- **C18** duplicated reviewer-fallback expression in `cli.js` (~`:1071`, ~`:1240`) → one helper.

---

## Implementation order — orch work orders

Each batch is one `orch` cycle / one PR. Files are listed to keep concurrent cycles off
shared files. Batches 1–4 carry design decisions (⚑) — settle those first (§ below), then
the `orch task` line is ready to paste. Later batches are mechanical and can run in parallel
where their file sets don't overlap.

**Batch 1 — X1 security-gate enforcement** *(do first, alone — touches the merge path)*
Wire `scanDiff()` into finalization on both the normal and `noMerge`/PR-bridge paths,
fail-closed on unavailable diff. Files: `src/engine.js`, `src/finalize.js`,
`src/security-review.js` (no logic change), `test/engine.test.js`, `test/finalize.test.js`.
Highest value, security-critical, and it changes the merge path — keep it isolated so its
tests aren't racing another cycle.

**Batch 2 ⚑ — X2 release opt-in** *(needs Decision D1 first)*
`release.autoBump` (default `false`) gate around `bumpVersion()`; wizard entry; enable for
this repo per D1. Files: `src/config.js`, `src/config-wizard.js`, `src/finalize.js`,
`.orch/orch.yml` (+ D1's chosen tracked location), `test/finalize.test.js`.
Shares `config.js`/`config-wizard.js` with Batch 3 — **run these two serially**.

**Batch 3 ⚑ — A4 + Codex #3 config subsystem** *(needs Decision D2 for A5)*
Export `normalizeMainConfig`; wizard runs it pre-write; serialize canonical
`conflictResolution` only; add the 4 missing catalog keys; A5 example/parser parity + test;
B12 SCAFFOLD parity test; C16. Files: `src/config.js`, `src/config-wizard.js`, `src/cli.js`,
`orch.example.yml`. Serialize with Batch 2 (shared config files).

**Batch 4 — security/correctness quick wins** *(small diffs, high value)*
A1 (redact), A6+B4 (agent-add flags + exit code), B2 (`sid`), B5, C5, C8, C9.
Files: `src/redact.js`, `src/cli.js`, `src/engine.js`, `src/slug.js`.

**Batch 5 — usage/pricing accounting**
A2 (parseRunUsage fallback gating), B10 (unpriced indicator), C13.
Files: `src/adapters/cli-adapter.js`, `src/pricing.js`, `src/dashboard.js`.

**Batch 6 — pidAlive consolidation**
A3 + synthetic-error-code test. Files: new shared module, `src/git.js`, `src/inflight.js`,
`src/lock.js`.

**Batch 7 ⚑ — TUI pass** *(B13 needs Decision D3)*
A7 (historyCount threading + test), B13, C10, C11, C12.
Files: `src/tui/layout.js`, `src/tui/loop.js`, `src/tui/theme.js`, `src/dashboard.js`.

**Batch 8 ⚑ — adapter hardening** *(B9 needs a real-CLI test)*
B6 (cmd.exe fallback warning), B7 (output cap), B8 (capability matrix), B9 (agy).
Files: `src/platform.js`, `src/adapters/cli-adapter.js`, all `src/adapters/*`.

**Batch 9 — CI / packaging / infra**
X3 (docs workflow), B11 (move input.test.js + pack assertion), X4 (spawnDocsTask fd),
C15. Files: `.github/workflows/orch-docs.yml`, `src/tui/input.test.js`→`test/tui/`,
`src/cli.js`, `test/platform.test.js`.

**Batch 10 — dead-code sweep + dedup** *(mostly deletions; last, one PR)*
C1, C2, C3, C4, C14, C18, B3+C17 (version-compare consolidation).
Broad but low-risk. Files: `engine.js`, `finalize.js`, `git.js`, `adapters/index.js`,
`update-check.js`, `upgrade.js`, `cli.js`, new `src/usage.js`.

**Batch 11 — remaining test coverage + atomic writes**
B14 (wizard pair branch, update-check units, pr-fallback comment test), C6 (atomic state
writes + kill-mid-write test), C7. Files: `checkpoint.js`, `resume.js`, `inflight.js`,
`github.js`, test files.

**Batch 12 — B1 scope glob fix**
B1 (`globToRegExp()` `?` -> `[^/]` + regression test). Files: `src/scope.js`,
`test/scope.test.js`.

Rough effort: Batch 1 and Batches 4–6 are each afternoon-size; 2–3 and 7–8 carry the
design decisions; 9–11 are mechanical.

---

## Decisions needed (settle before handing the ⚑ batches to orch)

Orch authors code; it should not guess policy. Four calls:

- **D1 (X2, Batch 2) — where does "this repo bumps versions" live?** `release.autoBump`
  defaults `false`, but `.orch/orch.yml` is git-ignored, so setting it there doesn't reach
  clones or CI checkouts. Options: (a) track a committed `orch.yml` layer for this repo;
  (b) accept that only local runs bump and document it; (c) keep bump unconditional for this
  repo and make the flag purely a downstream-clone courtesy. Pick one before Batch 2.
- **D2 (A5, Batch 3) — is reviewer-only meaningful for `orch task`?** Likely yes ("use the
  rotation's author, force this reviewer"). If yes, give `task` `allowReviewerOnly: true`
  and keep the example; if no, fix the example. Either way the parity test ships.
- **D3 (B13, Batch 7) — should the empty LIVE panel collapse** like the interrupted panel
  (`? 3 : 1`) or stay a fixed 3-row "(none)"? Decide, then either change the ternary or
  delete it — don't leave the no-op.
- **D4 (B9, Batch 8) — agy headless behavior:** requires one real-CLI test run before the fix
  can choose "add the bypass flag" vs "add the exonerating comment". Assign that probe to a
  human/CLI-having runner, not to orch.

---

## Verified-clean (do not re-audit)

From the Claude wave, explicitly checked and sound — carried forward so no cycle re-walks them:
no shell injection on POSIX or the primary Windows path (array-args spawns, no `shell:true`);
`lock.js` CAS-by-rename + O_EXCL create; inflight register/deregister and merge-lock try/finally
pairing; `github-app.js` JWT timing; intake `neutralizeFence` + allowlist path-traversal
fail-closed; `notify.reviewsDir()` traversal guard; `tui/selection.js` clamping,
`tui/screen.js` raw-mode restore, `loop.js` scrollbar math; `verdict.js` `\bAGREE\b`
word-boundary; per-test `mkdtempSync` isolation, no leaked children, no skipped tests.
**Dropped in verification:** "`orch pr --reviewer` always throws" — already fixed 2026-07-03
(`c392e805`).

**Caveat on "clean":** the Claude wave's clean-list vouches for *shell* injection but did
**not** cover the X1 gap (the scanner being unwired) — a reminder that "no injection found"
and "the deterministic scanner runs" are two different guarantees.
