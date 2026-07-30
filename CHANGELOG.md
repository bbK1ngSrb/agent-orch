# Changelog

## v0.4.215 — 2026-07-30
- auto-docs ms7hmnqz0 update documentation to reflect the latest merged changes

## v0.4.214 — 2026-07-30
- escalation recoveries that are hand-landed leave no release trace — add an `orch release` command that does finalize()'s bookkeeping (closes [#403](https://github.com/bbk1ng/agent-orch/issues/403))

## v0.4.213 — 2026-07-30
- the `sync` demote trigger has three causes but README and the manual document only one (closes [#401](https://github.com/bbk1ng/agent-orch/issues/401))

## v0.4.212 — 2026-07-30
- the protected-path intake refusal and --allow-protected are documented only in --help, not in README or the manual (closes [#400](https://github.com/bbk1ng/agent-orch/issues/400))

## v0.4.211 — 2026-07-30
- intake: a work order that names a protected path is refused before the cycle starts, instead of running to a three-round stalemate the guardrail floor made inevitable. `--allow-protected` overrides, because the scan is textual and an incidental mention of a filename should not lock you out (closes [#395](https://github.com/bbk1ng/agent-orch/issues/395))
- finalize: local `orch/integration` is fast-forwarded from `origin/orch/integration` before landing. A human who hand-merges an escalated branch straight onto origin (the documented recovery) left the local ref behind, and the next cycle merged onto that stale base, passed the gate — a stale tree is self-consistent — then had its PR push rejected as non-fast-forward, blaming the PR bridge instead of the base. Genuine divergence now demotes rather than guessing at a merge base (closes [#396](https://github.com/bbk1ng/agent-orch/issues/396))
- ci: `orch-docs.yml` deleted. It required a self-hosted runner labelled `orch` and none was ever registered, so every dispatch queued until GitHub cancelled it — 28 cancelled runs, zero successes, and no failure signal to say the doc refresh was not happening. Doc refresh now belongs solely to orch's local surface (`docs.autoUpdate` in `.orch/orch.yml`), which runs where the agent CLIs actually live (closes [#402](https://github.com/bbk1ng/agent-orch/issues/402))
- release: this entry also covers the two items above landing untraced. Both were hand-merged after escalating on the guardrail path floor, and the version bump lives inside `finalize()`, so neither bumped the version nor wrote a changelog line — see [#403](https://github.com/bbk1ng/agent-orch/issues/403) for the structural fix

## v0.4.210 — 2026-07-29
- conflict listing splits git output on newlines — a crafted filename can fake a metadata-only conflict and skip the reviewer (closes [#390](https://github.com/bbk1ng/agent-orch/issues/390))
- ci: `version-bump.yml` removed, and three doc surfaces that described it as a working safety net corrected. The Action never completed a bump and could not: GitHub Actions lacked permission to open its bump PR (closes [#394](https://github.com/bbk1ng/agent-orch/issues/394), [#388](https://github.com/bbk1ng/agent-orch/issues/388))

## v0.4.209 — 2026-07-27
- security-review: the guardrail path floor reads git's structural diff (`git diff --raw -z`) alongside the header-text parse and takes the union — header parsing alone failed open five ways (`diff.noprefix`/mnemonic prefixes, C-quoted paths, a path containing a literal `" b/"`, and mode-only changes with no `---`/`+++` headers). A failed structural read now fails closed rather than open, and rename/copy records contribute both paths (closes [#372](https://github.com/bbk1ng/agent-orch/issues/372))
- security-review: `globToRegExp` compiled `**` to `.*`, which in JavaScript never matches a line terminator, and `changedFiles` read `diff --name-only` without `-z` — so a protected path whose filename legally contains `\n`, `\r`, U+2028 or U+2029 matched no glob and the floor reported that nothing protected was touched. `**` now compiles to `[\s\S]*`, and `changedFiles` reads `-z` and splits on NUL with no `.trim()`, which also stops corrupting filenames with leading or trailing spaces (closes [#383](https://github.com/bbk1ng/agent-orch/issues/383))
- finalize: the automatic redrive of overlap-deferred cycles never ran. A cycle deregisters from `.orch/inflight` only after `finalize()` returns, so the live-peer scan inside `finalize()` always matched the landing cycle itself on exactly the paths that caused the deferral. Already-landed sids are now excluded from that scan (closes [#387](https://github.com/bbk1ng/agent-orch/issues/387))
- docs: the security scan's two gates are described separately — the added-line content scan still exempts markdown and `docs/**`, but the path-based floor over changed paths has covered `docs/CODEOWNERS` since #366, so the README, manual and `orch.example.yml` no longer claim a hole that is closed (closes [#386](https://github.com/bbk1ng/agent-orch/issues/386))

## v0.4.208 — 2026-07-26
- dirty-merge fallback opens a per-change agent PR against main, which repo policy explicitly forbids (closes [#376](https://github.com/bbk1ng/agent-orch/issues/376))

## v0.4.207 — 2026-07-26
- reviseCap is documented as counting revise rounds but the code counts total review rounds — off-by-one in the manual and --help text (closes [#369](https://github.com/bbk1ng/agent-orch/issues/369))

## v0.4.206 — 2026-07-24
- Auto-rebase + re-gate merge-deferred peers after a cycle lands (Tier-1 self-progress, no resolver) (closes [#350](https://github.com/bbk1ng/agent-orch/issues/350))

## v0.4.205 — 2026-07-24
- docs: expose security.ignore in orch.example.yml and state the built-in docs exemption honestly (closes [#352](https://github.com/bbk1ng/agent-orch/issues/352))

## v0.4.204 — 2026-07-24
- split issue 345 per kimi review in pr/claude/security-floor-report-the-real-guardrail-434415-0
- rename the `pr-fallback` verdict to `merge-deferred` and add a top-level run `trigger` (`overlap`, `dirty-merge`, `integration-test`, `lock`, or `sync`) (closes [#349](https://github.com/bbk1ng/agent-orch/issues/349))

## v0.4.203 — 2026-07-24
- automated merge-bump (version-bump.yml safety net)

## v0.4.202 — 2026-07-19
- feat: `kimi` adapter (kimi-code, Moonshot AI) — headless `-p` prompt mode, no bypass flag (kimi rejects `--prompt` + `--yolo`; prompt mode already auto-approves tools), `effort` capability off ([#335](https://github.com/bbk1ng/agent-orch/pull/335))

## v0.4.201 — 2026-07-16
- Rotation pool treats model/effort role specs as literal agent names (closes [#323](https://github.com/bbk1ng/agent-orch/issues/323))

## v0.4.200 — 2026-07-12
- feat: x.y.zcc versioning scheme — the patch field's last two digits are a merge-bump counter, the digits above that a publish-bump counter. See the "Version bump on merge" section of the README.
- fix: eliminate `src/version.js` as a second, hand-synced version source (closes the #308 drift class) — `orch --version` now reads `package.json` directly and displays it with a `v` prefix.
- fix: native Windows support — `orch update` was broken by two related bugs in the process-spawn path (#311, #313), both fixed and confirmed on real Windows 10/11 hardware. See PLANNED.md for the full writeup.
- fix: `scripts/orch-release.js` now also syncs `docs/index.html`'s version span on a publish-bump, matching what the merge-bump path already did (#192) — found while cutting this release.
- ci: `version-bump.yml` bumps the merge counter automatically for any merge to `main` that doesn't already carry its own version change. `npm-publish.yml`'s pack-test job now runs `orch update --check` on every OS, closing the CI gap that let #311/#313 ship.

## 0.4.1 — 2026-07-12
- fix: sync `src/version.js` with `package.json` so `orch --version` matches the npm release (closes [#308](https://github.com/bbk1ng/agent-orch/issues/308)). The 0.4.0 publish bumped the package identity and docs but left the runtime `VERSION` constant at 0.3.51; add a smoke test that fails CI if the two drift again.

## 0.4.0 — 2026-07-12

The audit release: closes out the 2026-07-11 implementation plan — all 9 HIGH
findings landed and re-verified by a second landing audit
(`docs/high-severity-landing-audit-2026-07-12-revision-2.md`). Extended notes:
`docs/release-notes-v0.4.0.md`.

Everything merged since 0.3.51:

- fix: land remaining HIGH audit items A1 (modern hyphenated `sk-*` key redaction) and A6+B4 (agent-add confirm path forwards real flags, sets exit code 2 on escalation) ([#304](https://github.com/bbk1ng/agent-orch/pull/304))
- fix: land batch remnants B2 (`sid` in recordTerminal's runs.jsonl payload), C5 (slugify slice-before-strip), C10 (dashboard splits PRs-opened from merged), C11 (TUI width math for CJK/Hangul/fullwidth), C12 (truncate width≤0 guard) ([#305](https://github.com/bbk1ng/agent-orch/pull/305))
- docs: v0.4.0 documentation refresh — 8 drift fixes across README, manual, and site, incl. documenting the security-scan gate, the config wizard, live-TUI default, and correcting `orch review`'s merge semantics ([#306](https://github.com/bbk1ng/agent-orch/pull/306))
- fix(verdict): prefer line-leading AGREE/DISAGREE token over a prose mention ([#303](https://github.com/bbk1ng/agent-orch/pull/303), closes [#301](https://github.com/bbk1ng/agent-orch/issues/301))
- fix(review-log): distinguish reviewer crash (ERROR) from editorial DISAGREE ([#302](https://github.com/bbk1ng/agent-orch/pull/302), closes [#299](https://github.com/bbk1ng/agent-orch/issues/299))
- fix(security-review): close subprocess-detection bypass via renamed `child_process` handles ([#300](https://github.com/bbk1ng/agent-orch/pull/300))
- feat(cli): honor `--reviewer`-only for `task`/`issue`, not just `review` (D2) ([#298](https://github.com/bbk1ng/agent-orch/pull/298))
- fix(config): normalize wizard writes and restore schema parity; canonicalize legacy `main.autoResolveConflicts` ([#296](https://github.com/bbk1ng/agent-orch/pull/296))
- fix(agy): refuse both author and reviewer seats — headless `agy` ignores cwd and would review scratch-dir state instead of the branch ([#293](https://github.com/bbk1ng/agent-orch/pull/293), see [#272](https://github.com/bbk1ng/agent-orch/issues/272), [#292](https://github.com/bbk1ng/agent-orch/issues/292))

## 0.3.51 — 2026-07-11
- pr/claude/high-depends-none-batch-4-ship-the-high--3123061-0 (closes [#261](https://github.com/bbk1ng/agent-orch/issues/261))

## 0.3.50 — 2026-07-11
- pr/claude/high-depends-d3-batch-7-finish-the-tui-l-3123087-0 (closes [#264](https://github.com/bbk1ng/agent-orch/issues/264))

## 0.3.49 — 2026-07-11
- pr/codex/medium-depends-none-batch-11-close-the-r-2275757-0 (closes [#268](https://github.com/bbk1ng/agent-orch/issues/268))

## 0.3.48 — 2026-07-11
- [HIGH][depends:none] Batch 5: stop usage accounting from inflating cost and hiding unpriced models (closes [#262](https://github.com/bbk1ng/agent-orch/issues/262))

## 0.3.47 — 2026-07-11
- [HIGH][depends:D1] Batch 2: make release auto-bumping opt-in instead of unconditional (closes [#259](https://github.com/bbk1ng/agent-orch/issues/259))

## 0.3.46 — 2026-07-11
- [MEDIUM][depends:D4] Batch 8: harden adapter process launching and headless approval behavior (closes [#265](https://github.com/bbk1ng/agent-orch/issues/265))

## 0.3.45 — 2026-07-11
- [HIGH][depends:none] Batch 6: consolidate pidAlive so Windows liveness checks agree (closes [#263](https://github.com/bbk1ng/agent-orch/issues/263))

## 0.3.44 — 2026-07-11
- pr/codex/read-docs-mplementation-plan-2026-07-11--960718-0

## 0.3.43 — 2026-07-10
- orch issue: auto-close the work order when it lands on `main` via the integration bridge PR (closes [#253](https://github.com/bbk1ng/agent-orch/issues/253))

## 0.3.42 — 2026-07-10
- Format dates/times as human-readable `yyyy-mm-dd HH:mm` in all user-facing output (closes [#244](https://github.com/bbk1ng/agent-orch/issues/244))

## 0.3.41 — 2026-07-10
- orch: auto-update BEHIND-but-clean integration PR in the normal loop (no manual 'Update branch') (closes [#249](https://github.com/bbk1ng/agent-orch/issues/249))

## 0.3.40 — 2026-07-10
- orch: verify headless self-merge works via orch-bot's existing ruleset bypass (no --admin, no 2nd bot) (closes [#250](https://github.com/bbk1ng/agent-orch/issues/250))

## 0.3.39 — 2026-07-10
- Headless overnight orch: planner + DAG + diverse-retry (design + tracking) (closes [#231](https://github.com/bbk1ng/agent-orch/issues/231))

## 0.3.38 — 2026-07-10
- feat(tui): help overlay + narrow-terminal control guard (split from #210) (closes [#240](https://github.com/bbk1ng/agent-orch/issues/240))

## 0.3.37 — 2026-07-10
- feat(tui): dashboard drill-down detail view (split from #210) (closes [#238](https://github.com/bbk1ng/agent-orch/issues/238))

## 0.3.36 — 2026-07-10
- feat(tui): structured panels + status strip + focus/scroll (closes [#209](https://github.com/bbk1ng/agent-orch/issues/209))

## 0.3.35 — 2026-07-10
- feat(cli): live TUI default for orch dashboard on interactive TTY (closes [#208](https://github.com/bbk1ng/agent-orch/issues/208))

## 0.3.34 — 2026-07-10
- Interactive `orch config` wizard: arrow-key config builder with per-option explanations and validate() gate (closes [#226](https://github.com/bbk1ng/agent-orch/issues/226))

## 0.3.33 — 2026-07-10
- orch: PR-bridge escalates on non-fatal 'gh pr edit' failure (Projects-classic GraphQL deprecation) (closes [#225](https://github.com/bbk1ng/agent-orch/issues/225))

## 0.3.32 — 2026-07-10
- feat(tui): loop.js — v1 live poll loop (flat scroll, clean shutdown) (closes [#207](https://github.com/bbk1ng/agent-orch/issues/207))

## 0.3.31 — 2026-07-10
- file enhancement. To have orch config [--config--file <file.yml] that will interactevly fulfill and save yml with options. need to have error gate, and to load possible options to be pircked by left, right arrow, and confiremd by enter. like it is in claude code. each option change need to have explantion. just detailed issue. no implementation

## 0.3.30 — 2026-07-10
- feat: check npm for newer version on each run (cached, non-blocking) (closes [#200](https://github.com/bbk1ng/agent-orch/issues/200))

## 0.3.29 — 2026-07-10
- feat(dashboard): no-color-safe verdict/stage symbols (closes [#204](https://github.com/bbk1ng/agent-orch/issues/204))

## 0.3.28 — 2026-07-10
- orch: wait for required CI checks before attempting merge (avoid racing 405) (closes [#212](https://github.com/bbk1ng/agent-orch/issues/212))

## 0.3.27 — 2026-07-10
- test/notify.test.js escalate colorization test fails when NO_COLOR is set in the environment (closes [#219](https://github.com/bbk1ng/agent-orch/issues/219))

## 0.3.26 — 2026-07-09
- auto-docs mre4m7tb0 update documentation to reflect the latest merged changes

## 0.3.25 — 2026-07-09
- feat(dashboard): width-aware table() + honor columns in render() (closes [#203](https://github.com/bbk1ng/agent-orch/issues/203))

## 0.3.24 — 2026-07-09
- orch: auto-merge own green integration→main PR via App bypass (drop manual --admin step) (closes [#213](https://github.com/bbk1ng/agent-orch/issues/213))

## 0.3.23 — 2026-07-09
- docs: live-TUI dashboard design doc (docs/tui-design.md) (closes [#202](https://github.com/bbk1ng/agent-orch/issues/202))

## 0.3.22 — 2026-07-09
- auto-docs mrdzlaa40 update documentation to reflect the latest merged changes

## 0.3.21 — 2026-07-09
- dashboard: reconcile stale red history verdicts (orch dashboard --check-history) (closes [#197](https://github.com/bbk1ng/agent-orch/issues/197))

## 0.3.20 — 2026-07-09
- refactor pr 190, based on review verdict. DISAGREE: The landing-page rewrite itself appears to remove the broken generated runtime and anchors resolve, but the branch weakens a regression test in the exact area it touches: after moving from escaped bundled HTML to plain HTML, the dead-placeholder-link assertion is stale and would miss the plain regression it claims to prevent.

## Unreleased
- Fix the landing-page version bump: the release step's span regex expected a `/`-escaped `</span>`, but the re-exported bundle now uses a literal `</span>`, so the header version froze at v0.3.18 while the package bumped on. Broaden the lookahead to accept literal/escaped variants, resync the header to the current version, and add a test so a future format change fails loudly (fixes [#192](https://github.com/bbk1ng/agent-orch/issues/192)).
- Fix the persistent integration PR auto-merge path to direct-merge the numeric PR id after creating the PR, not the `orch/integration` branch name (fixes [#182](https://github.com/bbk1ng/agent-orch/issues/182)).
- Clean up the landing page export: remove unbaked designer-template leftovers, replace dead placeholder links, and avoid inaccurate all-local privacy claims.
- Fix the landing page bundle bootstrap by escaping nested `</script>` close tags inside the embedded template (fixes [#185](https://github.com/bbk1ng/agent-orch/issues/185)).

## 0.3.18 — 2026-07-08
- auto-docs mrc8xriq0 update documentation to reflect the latest merged changes

## 0.3.17 — 2026-07-08
- Landing page v2: mobile-responsive layout + no-JS/crawler content fallback (closes [#141](https://github.com/bbk1ng/agent-orch/issues/141))

## 0.3.16 — 2026-07-08
- PR-fallback output is a raw machine dump, not teaching-toned prose (closes [#173](https://github.com/bbk1ng/agent-orch/issues/173))

## 0.3.15 — 2026-07-08
- Approved+green PR-fallbacks that are clean vs main are never auto-merged; manual gh pr merge refused by bypass-blind precheck (closes [#171](https://github.com/bbk1ng/agent-orch/issues/171))

## 0.3.14 — 2026-07-08
- auto-docs mrbxg6l80 update documentation to reflect the latest merged changes

## 0.3.13 — 2026-07-08
- orch/integration chronically diverges from main, forcing manual reset --hard + force-push (closes [#172](https://github.com/bbk1ng/agent-orch/issues/172))

## 0.3.12 — 2026-07-08
- Document the configurable `baseBranch` config key (default `main`) across README, `.orch/ORCH.md`, `docs/orch-manual.md`, and the config example — the trunk orch reads from, diffs against, and opens PRs to. The key shipped in [#154](https://github.com/bbk1ng/agent-orch/pull/154) but only reached the example YAML; the prose docs still described `main` as hardcoded. A repo whose `main` is deploy-only can set `baseBranch: dev` and orch tracks `dev` everywhere; `integrationBranch` (the local merge target) is unchanged.

## 0.3.11 — 2026-07-08
- Fix mistagged `v0.3.10`: the git tag pointed at commit 18f3817 ("Update version to 0.3.10 (#155)"), whose `package.json` had never actually been bumped past 0.2.16 — the version-bump PR's title didn't match its diff. This left `npm-publish`'s tag/package.json consistency check permanently failing and the release stuck three versions behind `main`. The bad tag is protected by a repo ruleset and can't be deleted/moved, so this release exists solely to give the real 0.3.x code a valid, correctly-tagged version to publish under.

## 0.2.16 — 2026-07-06
- Add `orch continue <sid>` to resume interrupted/stalled runs (closes [#125](https://github.com/bbk1ng/agent-orch/issues/125), [#129](https://github.com/bbk1ng/agent-orch/issues/129))
- Persist author/reviewer roles per run so `orch continue` can reuse or override them (closes [#126](https://github.com/bbk1ng/agent-orch/issues/126))

## 0.2.15 — 2026-07-05
- auto-docs mr806ow00 update documentation to reflect the latest merged changes

## 0.2.14 — 2026-07-05
- orch agent build ignores --author/--reviewer role overrides (closes [#117](https://github.com/bbk1ng/agent-orch/issues/117))

## 0.2.13 — 2026-07-05
- auto-docs mr7tienq0 update documentation to reflect the latest merged changes

## 0.2.12 — 2026-07-05
- auto-docs mr7tdwvt0 update documentation to reflect the latest merged changes

## 0.2.11 — 2026-07-05
- fetchOriginMain has no retry on ref-lock race, demotes cycle to pr-fallback (closes [#112](https://github.com/bbk1ng/agent-orch/issues/112))

## 0.2.10 — 2026-07-05
- pr/codex/changelog-entries-use-raw-branch-names-i-3031398-0 (closes #107)

## 0.2.9 — 2026-07-05
- pr/codex/escalated-approved-crashed-cycles-never--2735699-0 (closes #106)

## 0.2.8 — 2026-07-04
- pr/claude/auto-docs-mr6yfds80-update-documentation-2548509-0

## 0.2.7 — 2026-07-04
- pr/codex/demote-escalation-output-too-terse-for-h-2523553-0 (closes #102)

## 0.2.6 — 2026-07-04
- pr/claude/auto-docs-mr6o1ntq0-update-documentation-2173998-0

## 0.2.5 — 2026-07-04
- pr/codex/silence-spurious-no-such-remote-origin-n-2154426-0

## 0.2.4 — 2026-07-04
- pr/copilot/docs-only-add-a-reference-to-the-compani-2095951-0

## 0.2.3 — 2026-07-04
- pr/codex/auto-docs-mr6bvb570-update-documentation-1671052-0

## 0.2.2 — 2026-07-04
- pr/claude/agent-cli-resolution-fails-when-path-lac-1613238-0 (closes #91)

## 0.2.1 — 2026-07-04
- pr/claude/changedsince-reverse-diff-false-overlap--1531103-0 (closes #89)

## 0.2.0 — 2026-07-04
- First public release. Repo flipped public: full-history secret/leak audit, GitHub metadata redactions, CI workflows gated to trusted authors, secret scanning + push protection enabled, social preview added.

## 0.1.8 — 2026-07-03
- pr/codex/free-main-from-the-integration-worktree--459556-0

## 0.1.7 — 2026-07-03
- pr/codex/fix-trust-gap-from-docs-red-team-report--1361829-0: verify merged commits reach origin; keep finalize local-only on merge failure (red-team report docs/red-team-report-2026-07-02.md, trust gap)
- pr/codex/cost-tracking-and-reviewer-catch-rate-lo-11197-0: report per-cycle token/$ cost and log every review outcome (AGREE/DISAGREE) for catch-rate measurement (red-team report, A1/A5)

## 0.1.6 — 2026-07-02
- pr/claude/finalize-s-advance-main-ref-step-still-s-1150585-0 (closes #80)

## 0.1.5 — 2026-07-02
- pr/claude/self-bootstrap-agent-adapters-orch-agent-1076225-0 (closes #69)

## 0.1.4 — 2026-07-02
- pr/claude/dashboard-live-status-logs-metrics-view-107565-0 (closes #64)

## 0.1.3 — 2026-07-02
- pr/claude/cost-tracking-per-cycle-token-accounting-4187998-0 (closes #66)

## 0.1.2 — 2026-07-02
- pr/claude/test-cli-test-js-hardcodes-agent-orch-0--4143771-0 (closes #75)

## 0.1.1 — 2026-07-02
- pr/claude/crash-recovery-resume-mid-cycle-after-a--4032757-0 (closes #67)
