# Wire §3 security modules into the pipeline (closes #26)

Scope (user-selected): checkPaths, redact, publicSummary, lint-token (CI), workorder (--file).
**Deferred:** scanDiff — false-positives on orch's own child_process/fetch usage.

## Design — where each hooks in

### 1. checkPaths — §3c author-time protected-path gate  → `src/engine.js`
- After the author step, **task mode only**, before the scope gate.
- `const changed = git.changedFiles(repo, branch); const prot = checkPaths(changed);`
- `if (!prot.ok)` → `escalate(... "protected paths touched: <violations> — orch will not author guardrail files")`.
- Runs on resume too (outside the `if(!resume)` author block) so a resumed dangerous diff is still caught.
- Pure import: `import { checkPaths } from "./intake/allowlist.js"`. No dep injection (matches `isDocsOnly`).
- Existing engine tests stub `git.changedFiles → []` → `checkPaths([])` is ok → no behavior change.

### 2. workorder — §3a/§3b validated + fenced intake  → `src/cli.js` + `src/engine.js`
- `orch task --file X`: `X` is now an **untrusted JSON work order**, not free text (breaking, accepted).
  - `JSON.parse` (throw clear error on parse fail) → `validateWorkOrder` (throw on shape errors).
  - `task = workOrder.title` (drives slug/resume/branch — sanitized by `slugify`).
  - `authorPrompt = buildAuthorPrompt(workOrder)` (trusted frame + neutralized fence).
- Free-text `orch task "..."` unchanged: `task = rest.join(" ")`, `authorPrompt = task`.
- Engine: initial author uses `opts.authorPrompt || task`; revise still uses `verdict.reason`.
- All 5 work-order keys required (title/problem nonempty; the 3 arrays may be empty `[]`) — keep `workorder.js` unmodified.

### 3. redact + publicSummary — §3f own public output  → `src/github.js`
- `runPr` PR comment: body = `redact(buildComment(result, publicSummary({decision, green, branch, rounds})))`.
  - publicSummary provides the body (machine fields only); redact is the final scrub on the exact bytes sent to `gh`.
  - **Stop posting reviewer prose** (`readVerdict`) to the public PR — notes stay private in `.orch/reviews/`.
  - Remove now-dead `readVerdict` plumbing from `runPr`, `cli.githubDeps`, and the `readVerdict` fn in cli.js.
- `demote` auto-PR: `redact()` the body/title before `gh pr create` (defense-in-depth).
- `buildComment(result, summary)` kept; 2nd arg is now the machine summary, not verdict prose.

### 4. lint-token-step — §3g CI invariant  → `.github/workflows/ci.yml`
- Add step after `npm test`: `node scripts/lint-token-step.js .github/workflows/*.yml`.
- Verified: current workflows already pass the lint (exit 0), so CI won't break.

## TDD task list
- [ ] engine: author touches protected path → escalated ("protected paths") — NEW
- [ ] engine: initial author receives the fenced `authorPrompt` (assert FENCE markers) — NEW
- [ ] cli: `--file` invalid JSON throws; invalid shape throws; valid work order runs (dry) — NEW/UPDATE
- [ ] cli: UPDATE existing "--file loads task from file (dry)" → JSON work order
- [ ] github: runPr comment carries publicSummary machine fields, NOT reviewer prose — UPDATE
- [ ] github: redact scrubs a secret in posted comment + demote body — NEW
- [ ] implement engine/cli/github/ci changes
- [ ] full `npm test` green; `node scripts/lint-token-step.js .github/workflows/*.yml` ok
- [ ] update README/CLAUDE if they describe --file as free-text

## Notes / risk
- Behavior changes (accepted): `--file` now JSON; PR comments drop reviewer prose for a machine summary.
- Not touching protected modules themselves — only wiring callers.
- `.github/workflows/ci.yml` edit is a manual human edit (protected-path set governs orch-authored diffs, not this).

## Review (done)
- checkPaths wired at the **merge boundary** in engine (not first-pass) — covers initial author, every revise, resume, and `orch review` merges. Advisor caught the revise-bypass; fixed + test added.
- redact + publicSummary in github: `orch pr` posts a machine summary only (no reviewer prose); redact scrubs the bytes sent to gh; demote redacts title/body but keeps `--head` ref real. Dead `readVerdict` plumbing removed.
- workorder: `orch task --file X` is now an untrusted JSON work order — validated, fenced via buildAuthorPrompt; `task`=title (slug/resume), `authorPrompt`=fenced. Free-text `orch task "..."` unchanged.
- lint-token-step added as a CI step (§3g); current workflows pass.
- Verdict: 241/241 tests green; §3g lint exit 0; real `--file` dry run + non-JSON rejection verified.
- Deferred (tracked on #26): scanDiff — false-positives on orch's own child_process/fetch; `orch pr` diff has no deterministic floor yet.
