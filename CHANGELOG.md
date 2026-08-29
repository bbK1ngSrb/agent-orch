# Changelog

## v0.4.363 — 2026-08-29
- docs: add the v0.5.0 documentation set as drafts under `docs/drafts/`

## v0.4.362 — 2026-08-29
- feat: rotate configured role pools (closes [#532](https://github.com/bbk1ng/agent-orch/issues/532))
- **BREAKING (config):** `authors:` and `reviewers:` are now rotation pools, not frozen seats
  (see [#603](https://github.com/bbk1ng/agent-orch/issues/603)). Two previously-valid configs
  change behaviour: `authors: [claude]` + `reviewers: [claude]` now fails to load
  (`authors[0] (claude) has no reviewer with a different agent`), and
  `authors: [claude, codex]` + `reviewers: [claude, codex]` no longer fans out to one full cycle
  per author — it seats one rotating author/reviewer pair per cycle.

## v0.4.361 — 2026-08-29
- fix(rotate): use configured model ladders (closes [#567](https://github.com/bbk1ng/agent-orch/issues/567))

## v0.4.360 — 2026-08-28
- CLI v2 P11 config keys in warn mode, config --check/--json, gateTimeout; retry wrapper for orch's own gh calls with escalation spill-to-file

## v0.4.359 — 2026-08-28
- REVIEW_STALEMATE 'three fresh rounds' acceptance criterion unreachable on the default two-agent pool, untested at pool>=3 (closes [#550](https://github.com/bbk1ng/agent-orch/issues/550))

## v0.4.358 — 2026-08-28
- fix(cli): require .orch for detach (closes [#596](https://github.com/bbk1ng/agent-orch/issues/596))

## v0.4.357 — 2026-08-28
- fix(pr): fail closed on lookup errors (closes [#593](https://github.com/bbk1ng/agent-orch/issues/593))

## v0.4.356 — 2026-08-28
- fix: orch pr rejects a missing branch as a usage error before probing the environment

## v0.4.355 — 2026-08-28
- cli: --detach runs a cycle in the background and shows it in the dashboard

## v0.4.354 — 2026-08-28
- fix(mcp): default PR reviews to once (closes [#594](https://github.com/bbk1ng/agent-orch/issues/594))

## v0.4.353 — 2026-08-28
- fix(security): fence untrusted CI failure text out of the integration-repair resolver prompt (closes #577)

## v0.4.352 — 2026-08-28
- fix(pr): persist resume push authority (closes [#525](https://github.com/bbk1ng/agent-orch/issues/525))

## v0.4.351 — 2026-08-28
- feat: add head-bound merged landing (closes [#524](https://github.com/bbk1ng/agent-orch/issues/524))

## v0.4.350 — 2026-08-28
- fix: honor retry budgets before pending asks (closes [#523](https://github.com/bbk1ng/agent-orch/issues/523))

## v0.4.349 — 2026-08-27
- fix(repair): preserve proposed resolutions (closes [#578](https://github.com/bbk1ng/agent-orch/issues/578))

## v0.4.348 — 2026-08-27
- CLI v2: unify orch pr --merge's prChecksGreen with readiness.js's §9 rule 4 checks predicate (closes [#545](https://github.com/bbk1ng/agent-orch/issues/545))

## v0.4.347 — 2026-08-27
- CHANGELOG entries are derived from issue titles, so a fix is described as the defect it fixed (closes [#582](https://github.com/bbk1ng/agent-orch/issues/582))

## v0.4.346 — 2026-08-27
- fix(schema): `orch pr` now rejects `--until ready|merged` instead of accepting and ignoring them; `--until once` stays valid because a PR audit is a single pass (closes [#546](https://github.com/bbk1ng/agent-orch/issues/546))

## v0.4.345 — 2026-08-27
- feat(integration-repair): resolve and prove a conflict before it lands (#569)

## v0.4.344 — 2026-08-27
- A cycle killed after an agent usage limit records no run outcome, leaving resumable work with nothing pointing at it (closes [#537](https://github.com/bbk1ng/agent-orch/issues/537))

## v0.4.343 — 2026-08-27
- orch continue loops forever on "worktree already exists" when a killed run leaves a directory git no longer has registered (closes [#540](https://github.com/bbk1ng/agent-orch/issues/540))

## v0.4.342 — 2026-08-27
- CLI v2 P6 split 3b/4 — rotate the exhausted seat (§8b) (closes [#570](https://github.com/bbk1ng/agent-orch/issues/570))

## v0.4.341 — 2026-08-26
- orch-loop.sh retries a terminal BLOCKED (exit 3) as if it were a quota death (closes [#575](https://github.com/bbk1ng/agent-orch/issues/575))

## v0.4.340 — 2026-08-26
- feat(quota): detect and classify a provider quota death on both seats (#554)

## v0.4.339 — 2026-08-26
- fix(security): secret-read requires read-shaped context, not a path mention (#560)

## v0.4.338 — 2026-08-26
- unresolvedConflictMarkers() fails open: a git grep error is reported as 'no conflict markers' (closes [#568](https://github.com/bbk1ng/agent-orch/issues/568))

## v0.4.337 — 2026-08-26
- CLI v2 P6 split 4a/4 — integration repair: land a verified tip (§10A) (closes [#555](https://github.com/bbk1ng/agent-orch/issues/555))

## v0.4.336 — 2026-08-24
- CLI v2 P6 split 2/4 — rebase + repair (§8a): rebase onto the landing base, implement repair mode (closes [#553](https://github.com/bbk1ng/agent-orch/issues/553))

## v0.4.335 — 2026-08-24
- run-controller never acts on a chooseRemedy decision — free-retry counter is never incremented, so no remedy is reachable (closes [#564](https://github.com/bbk1ng/agent-orch/issues/564))

## v0.4.334 — 2026-08-24
- #557 z.ai model defaults pinned (glm-5.3 / glm-4.5-air); #558 orch release bumps on the integration worktree

## v0.4.333 — 2026-08-24
- hand-landed #552 — lock scheme (P6 split 1/4): merge.lock scoped to the git write, non-blocking integration-repair.lock, ownership check

## v0.4.332 — 2026-08-23
- CLI v2 P3 — Structured failure classes, fingerprints, remedy chooser; fix round drift (closes [#519](https://github.com/bbk1ng/agent-orch/issues/519))

## v0.4.331 — 2026-08-23
- CLI v2 P2 — Durable run record (.orch/run-records/<runId>.json) with lineage and resume-with-fresh-budget (closes [#518](https://github.com/bbk1ng/agent-orch/issues/518))

## v0.4.330 — 2026-08-23
- Path traversal in sid-store: an unsanitised sid escapes the record store and silently deletes files outside it (closes [#538](https://github.com/bbk1ng/agent-orch/issues/538))

## v0.4.329 — 2026-08-22
- The reviewer never receives the work order, so it cannot check a change against its requirement — and its unconditional ~3-logical-change rule blocks any planned large slice (closes [#535](https://github.com/bbk1ng/agent-orch/issues/535))

## v0.4.328 — 2026-08-19
- Cycles are authored against main but land on orch/integration, so parallel work never sees already-integrated changes (closes [#515](https://github.com/bbk1ng/agent-orch/issues/515))

## v0.4.327 — 2026-08-18
- hand-landed: cap the test gate with stageTimeout so a hung suite cannot hold merge.lock (closes #505)

## v0.4.326 — 2026-08-18
- hand-landed: allowlist the env handed to agent subprocesses, keeping GH_TOKEN out (closes #502)

## v0.4.325 — 2026-08-18
- Integration-PR body refresh silently drops Closes lines when gh pr edit fails on deprecated projectCards (closes [#512](https://github.com/bbk1ng/agent-orch/issues/512))

## v0.4.324 — 2026-08-18
- hand-landed: agent add honors --config-file and --dry (closes #498)

## v0.4.323 — 2026-08-18
- hand-landed: honor --dry on init/pr/release/agent add (closes #497)

## v0.4.322 — 2026-08-18
- Only --merge gets cross-command flag validation; every other misapplied flag is silently ignored (closes [#500](https://github.com/bbk1ng/agent-orch/issues/500))

## v0.4.321 — 2026-08-18
- Unrecognized orch command falls through to usage text and exits 0 (closes [#499](https://github.com/bbk1ng/agent-orch/issues/499))

## v0.4.320 — 2026-08-18
- Checkpoint stage "authored" is missing from dashboard.js/theme.js stage-label maps (closes [#507](https://github.com/bbk1ng/agent-orch/issues/507))

## v0.4.319 — 2026-08-18
- Round counter can drift on crash-during-revise, softening roundCap by one round on resume (closes [#506](https://github.com/bbk1ng/agent-orch/issues/506))

## v0.4.318 — 2026-08-18
- orch pr <n> --merge never checks CI/status checks before merging (unlike the integration-PR path) (closes [#508](https://github.com/bbk1ng/agent-orch/issues/508))

## v0.4.317 — 2026-08-18
- hand-landed: log unexpected direct-merge failures instead of swallowing them (closes #504)

## v0.4.316 — 2026-08-18
- pushAndCreatePr has no find-or-create check; a re-run on an already-PR'd branch crashes the whole process (closes [#503](https://github.com/bbk1ng/agent-orch/issues/503))

## v0.4.315 — 2026-08-15
- honor adapter disabled flag in agent detection (#492)

## v0.4.314 — 2026-08-15
- add per-adapter env overrides and a zai (GLM) adapter (#491)

## v0.4.313 — 2026-08-14
- Docs describe the integration/base merge as squash-specific; it fires on any divergence (closes [#487](https://github.com/bbk1ng/agent-orch/issues/487))

## v0.4.312 — 2026-08-14
- CHANGELOG entry falls back to the branch slug when a cycle has no title or work order (closes [#486](https://github.com/bbk1ng/agent-orch/issues/486))

## v0.4.311 — 2026-08-14
- harden comment-only secret scan (closes #482)

## v0.4.310 — 2026-08-14
- A cycle whose author throws (provider quota/auth error) leaves no trace in either dashboard view — no run row and no checkpoint (closes [#484](https://github.com/bbk1ng/agent-orch/issues/484))

## v0.4.309 — 2026-08-14
- pr/claude/auto-docs-mss7n3w70-update-documentation-2771831-0

## v0.4.308 — 2026-08-14
- document the `--dry` author-rotation guarantee (#471) and the integration/base reconciliation that repairs a diverged history with a merge commit

## v0.4.307 — 2026-08-13
- update documentation to reflect the latest merged changes: the --dry rotation fix (#471), the secret-read comment skip (#480), and that squash merging is disabled repo-wide in favour of merge commits (#478)

## v0.4.306 — 2026-08-13
- fix(security-review): skip comment-only added lines for the secret-read rule (#480)

## v0.4.305 — 2026-08-13
- docs: qualify the --dry "writes nothing under .orch/" claim and pin it with tests (#471)

## v0.4.304 — 2026-08-13
- Test gap: reconcileIntegrationToBase's merge-conflict path is uncovered (closes [#477](https://github.com/bbk1ng/agent-orch/issues/477))

## v0.4.303 — 2026-08-13
- reconcileIntegrationToBase is fast-forward-only, so it silently no-ops after every squash-merge and the next cycle demotes on dirty-merge (closes [#475](https://github.com/bbk1ng/agent-orch/issues/475))

## v0.4.302 — 2026-08-13
- fix(cli): orch task --dry no longer advances the author rotation or creates .orch (#471)

## v0.4.301 — 2026-08-13
- Land #466 (SECURITY.md supported-versions), #467 (docs drift: ORCH_NO_UPDATE_CHECK, adapter lede, command count), #464 (shared MCP stdio server, sid-correlated)

## v0.4.253 — 2026-08-12
- cleanup: lock.acquireBlocking blocks the event loop with synchronous Atomics.wait polling (impact verified LOW — one cycle per process) (closes [#446](https://github.com/bbk1ng/agent-orch/issues/446))

## v0.4.252 — 2026-08-12
- cleanup: preserve public API contracts and clarify merge verification (closes [#445](https://github.com/bbk1ng/agent-orch/issues/445))

## v0.4.251 — 2026-08-12
- dedup shared orchestration helpers (#443)

## v0.4.250 — 2026-08-12
- docs+cli: document running issues in sequence, and name the issue number in the run summary (closes [#451](https://github.com/bbk1ng/agent-orch/issues/451))

## v0.4.249 — 2026-08-12
- hasEscalationDecision fails open: an unresolvable check reads as 'never escalated' and allows the resume (closes [#459](https://github.com/bbk1ng/agent-orch/issues/459))

## v0.4.248 — 2026-08-11
- orch issue <n> resumes an escalated checkpoint: skips the author stage, ignores the edited issue body, and lets one AGREE overturn a two-reviewer DISAGREE (closes [#454](https://github.com/bbk1ng/agent-orch/issues/454))

## v0.4.247 — 2026-08-11
- sid-store refactor narrowed three exception guards: unguarded self-heal rmSync, scanDir swallowing all readdir errors, inflight.setPaths write outside its race guard (closes [#453](https://github.com/bbk1ng/agent-orch/issues/453))

## v0.4.246 — 2026-08-11
- auto-docs msp19s0w0 update documentation to reflect the latest merged changes

## v0.4.245 — 2026-08-11
- refactor: four hand-rolled copies of the sid-keyed JSON store with already-diverged corrupt-file policy (rmSync vs silent-skip) (closes [#442](https://github.com/bbk1ng/agent-orch/issues/442))

## v0.4.244 — 2026-08-11
- test: coverage gaps that block safe optimization — usage.js (money display) untested, compareVersions indirect-only, buildRevisionPrompt fencing unverified, writeFileAtomic symlink contract tested 3x at wrong layer (closes [#444](https://github.com/bbk1ng/agent-orch/issues/444))

## v0.4.243 — 2026-08-11
- auto-docs msnxppv20 update documentation to reflect the latest merged changes

## v0.4.242 — 2026-08-11
- perf: appendCapturedOutput does an unamortized ~1MB copy on every chunk once output crosses the cap (benchmarked 0.35ms/call, linear) (closes [#440](https://github.com/bbk1ng/agent-orch/issues/440))

## v0.4.241 — 2026-08-11
- orch continue cannot resume a cycle that died between author-completion and the first audit — committed work exists but no checkpoint or inflight record does (closes [#431](https://github.com/bbk1ng/agent-orch/issues/431))

## v0.4.240 — 2026-08-11
- perf: TUI render loop — footer clock defeats dirty-check, unbatched paintFrame writes, O(n²) history index, quadratic ANSI walk, fs.watch misses checkpoints/inflight (closes [#439](https://github.com/bbk1ng/agent-orch/issues/439))

## v0.4.239 — 2026-08-10
- perf: dashboard snapshot re-reads all state files from disk on every tick (runs.jsonl parsed twice/sec, no mtime cache, full log reads for a 12-line tail) (closes [#438](https://github.com/bbk1ng/agent-orch/issues/438))

## v0.4.238 — 2026-08-01
- auto-docs msakj2kr0 update documentation to reflect the latest merged changes

## v0.4.237 — 2026-08-01
- auto-docs msajx8jg0 update documentation to reflect the latest merged changes

## v0.4.236 — 2026-08-01
- Bind the resume checkpoints to the reviewed commit identity (issue #422, Part 5 — supersedes the earlier Part 5 attempt). Branch `pr/grok/re-check-the-resume-oid-where-the-cached-4182882-0` already implements HALF of this and was rejected in review; read it for context but implement the whole requirement below. Do not simply re-apply it. What that branch got right (keep this behaviour): the cached-verdict shortcut is re-validated at the point it is CONSUMED, not only at resume entry (`if (resume)` block, engine.js). Entry-time match alone lets the branch move between the check and the moment `pendingVerdict` / `skipTest` are honoured. What it missed, and why it was rejected — the checkpoint-laundering race: // engine.js — BOTH record sites checkpoint?.record(orchDir, sid, { branch, oid: branchOid(), round, stage: "reviewed", ... }); if (pass) checkpoint?.record(orchDir, sid, { branch, oid: branchOid(), round, stage: "tested", ... }); `branchOid()` is a FRESH `rev-parse` executed at record time. The verdict and the gate result were earned on the commit that was audited and tested; the OID written down is whatever the ref points at a moment later. If the branch moves in between, orch stamps unaudited, ungated content as `stage: "tested"` — and a later `orch continue` then trusts that checkpoint and skips both audit and gate for it. The pin launders the thing it exists to prevent. This is inherited from Part 3, which already landed on main. It is in scope here: it is the same resume-integrity boundary, and Part 5 cannot honestly claim "one commit identity per cycle" while it stands. Required changes: 1. Capture the reviewed commit identity ONCE per round, early enough that the audit, the gate, both checkpoint writes, the §3e/§3c reads and the merge all refer to the same value. Part 1 already introduced `reviewedSha` for the scan/merge boundary — extend that single value backwards to cover the round, rather than adding another capture site. 2. Both `checkpoint.record` calls store that value, NOT a fresh `branchOid()` read. 3. The consumption-point re-validation from the earlier attempt is kept: a cached shortcut is honoured only when the branch still points at the OID the checkpoint recorded. 4. Mismatch or unreadable at any of these points → drop the shortcut, re-audit and re-gate. Never inherit a verdict earned on other content. 5. There must be exactly ONE `rev-parse` of the branch ref per round. If you find yourself adding a second, the design is wrong — that multiplicity is the entire bug class #422 exists to remove. Tests (test/engine.test.js): - UPDATE the existing checkpoint-shortcut tests, do NOT delete them: unchanged-branch case must still assert zero audits and zero gate runs. - ADD: branch moves between the resume check and the consumption point → shortcut refused, audit and gate run. - ADD: branch moves between the gate passing and the checkpoint write → the recorded `oid` is the tested commit, NOT the new head. This is the laundering case; cover it explicitly. - ADD: unreadable OID fails closed. Scope: src/engine.js and test/engine.test.js. src/checkpoint.js needs no change — its payload already carries `oid`. Do NOT touch src/finalize.js, src/deferred.js, src/github.js or src/git.js.

## v0.4.235 — 2026-08-01
- openPr passes a branch name to mergeDirect's numeric prRef → swallowed 404, auto-merge fallback silently dead on merge: pr (sibling of #182) (closes [#426](https://github.com/bbk1ng/agent-orch/issues/426))

## v0.4.234 — 2026-08-01
- bind the approve/merge boundary to one reviewed commit OID (#422 parts 1+2)

## v0.4.233 — 2026-08-01
- auto-docs msad18y30 update documentation to reflect the latest merged changes

## v0.4.232 — 2026-08-01
- auto-docs msac1jf20 update documentation to reflect the latest merged changes

## v0.4.231 — 2026-08-01
- auto-docs msabvqxz0 update documentation to reflect the latest merged changes

## v0.4.230 — 2026-08-01
- auto-docs msabql7c0 update documentation to reflect the latest merged changes

## v0.4.229 — 2026-08-01
- auto-docs msabejhv0 update documentation to reflect the latest merged changes

## v0.4.228 — 2026-08-01
- Pin the remaining mergeDirect call sites to the integration tip (issue #422, Part 4 of 4 — implement ONLY this part). Context: #421 already added an optional `sha` argument to mergeDirect (src/github.js:20) and used it on the `orch pr --merge` path (src/github.js ~210). Two callers still merge unpinned: - tryMergeDirect (src/github.js:63-65) — the BEHIND-refresh / main.autoMerge path - src/github.js ~318 — the fresh-create autoMergePr path Both merge the persistent `orch/integration -> main` PR. This is NOT a copy of the #421 fix. Get the trade-off right: The persistent PR is DESIGNED to accumulate work from several cycles. A concurrent cycle landing on orch/integration between this cycle's push and its merge attempt is legitimate green work that passed its own review, security floor and test gate — not an intruder. So pinning must NOT mean "refuse forever when the tip moved". It means: this call merges the commit THIS cycle verified; if the branch has advanced, the cycle that advanced it owns merging the newer tip. That is already the existing retry-next-cycle design — the pin only makes it explicit. Required changes: 1. Both call sites pass the integration tip SHA that this cycle pushed. finalize.js already computes that SHA (`const sha = git.git(["rev-parse", "HEAD"], integration)`); thread it to openIntegrationPr rather than re-deriving it somewhere else if that is clean. 2. Distinguish a 409 (head moved) from the other swallowed failures. Both call sites currently swallow EVERY error, which is correct today because "checks still pending" is the expected outcome — but once a sha is sent, a 409 would become indistinguishable from a pending-checks no-op, and the integration PR would silently stop auto-merging with nothing logged. That is the failure mode to avoid. 3. On 409: log once with a clear reason (e.g. "integration advanced past the commit this cycle verified — the newer cycle will merge it"). Do NOT escalate. Do NOT retry in-process. The cycle's status is unaffected: it is still `merged`, the PR is still reported. 4. Every other error stays swallowed exactly as today. This must not turn a benign pending-checks no-op into cycle noise. Tests (test/github.test.js): - ADD a test that both call sites send `sha=<the integration tip>`. - ADD a test that a 409 from the direct merge leaves the cycle result untouched (still merged, prUrl still returned) AND emits the log line. - ADD/keep coverage that a non-409 failure is still swallowed silently. Scope: src/github.js, src/finalize.js (only if needed to thread the SHA), test/github.test.js. Do NOT touch src/engine.js, src/checkpoint.js or src/deferred.js — those are Parts 1, 2 and 3 of the same issue, handled in separate cycles. Out of scope, do not fix here: src/github.js ~318 passes `branch` (a branch NAME) as mergeDirect's prRef, which needs a numeric PR id. That is a suspected regression of #182 and is being tracked separately. Leave that argument as-is.

## v0.4.227 — 2026-08-01
- Pin the resume checkpoint to a commit OID (issue #422, Part 3 of 4 — implement ONLY this part). Problem: src/checkpoint.js:12-19 stores branch, round, stage and prose, but no commit OID. On resume, src/engine.js:152 checks only `ck.branch === branch`, so a `stage: "tested"` checkpoint becomes pendingVerdict AGREE with skipTest=true (engine.js:155-157) for whatever the branch points at NOW. A branch that moved between the crash and `orch continue` inherits a verdict earned by different content. The current skip is DELIBERATE and a test asserts it by name. Do NOT remove it. Make it conditional. Required changes: 1. checkpoint.record() stores the branch head OID alongside the existing fields. 2. engine.js compares that OID (in addition to the branch name) when deciding whether to honour a checkpoint on resume. 3. On match: behaviour is identical to today. 4. On mismatch: drop the pendingVerdict/skipTest shortcut and re-audit + re-gate the round normally. Resume still works; it just refuses to inherit a stale verdict. 5. A checkpoint written by an older version has no OID field. Treat a missing OID as "cannot verify, do not shortcut" (fail closed). The cost is one extra audit on a resume spanning an upgrade. Tests: - UPDATE test/engine.test.js:739-751 ("crash recovery: a tested checkpoint skips both audit and gate on resume") so it still asserts zero audits and zero gate runs for the UNCHANGED-branch case. Do not delete it. - ADD a sibling test for the moved-branch case: the shortcut is dropped, the round is re-audited and re-gated. - ADD a test for the legacy no-OID checkpoint failing closed. Scope: src/checkpoint.js, src/engine.js, test/engine.test.js only. Do not touch src/github.js, src/finalize.js or src/deferred.js — those are Parts 1, 2 and 4 of the same issue and are being handled in separate cycles.

## v0.4.226 — 2026-08-01
- auto-docs msa94mce0 update documentation to reflect the latest merged changes

## v0.4.225 — 2026-08-01
- orch pr --merge merges the PR's current head, not the reviewed snapshot (TOCTOU: no sha pin on the REST merge) (closes [#421](https://github.com/bbk1ng/agent-orch/issues/421))

## v0.4.224 — 2026-07-30
- tag-release cannot push a tag whose history contains a workflow-file change: GITHUB_TOKEN is refused, and v0.4.216 was left untagged (closes [#416](https://github.com/bbk1ng/agent-orch/issues/416))

## v0.4.223 — 2026-07-30
- auto-docs ms7n5j200 update documentation to reflect the latest merged changes

## v0.4.222 — 2026-07-30
- auto-docs ms7n2g8e0 update documentation to reflect the latest merged changes

## v0.4.221 — 2026-07-30
- auto-docs ms7mxt8j0 update documentation to reflect the latest merged changes

## v0.4.220 — 2026-07-30
- auto-docs ms7mnjbi0 update documentation to reflect the latest merged changes

## v0.4.219 — 2026-07-30
- auto-docs ms7midpr0 update documentation to reflect the latest merged changes

## v0.4.218 — 2026-07-30
- orch runs the full review loop on an empty author diff, then reports it as "stalemate after cap" (closes [#412](https://github.com/bbk1ng/agent-orch/issues/412))

## v0.4.217 — 2026-07-30
- tag-release now fails loudly when release-tags.js crashes instead of tagging nothing (closes #415)

## v0.4.216 — 2026-07-30
- tag-release now tags every version a push introduces, not just the final one (closes #409)

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
