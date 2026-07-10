# Changelog

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
