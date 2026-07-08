# Changelog

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
