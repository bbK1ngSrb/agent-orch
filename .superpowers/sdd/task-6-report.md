# Task 6: Token-Step Invariant Lint Rule — Report

## Summary

Implemented the pure lint rule and CLI for the token-step invariant (§3g): structural check that no single CI job both holds write token **and** runs authored code.

**Status:** DONE  
**Commit:** `d9c6efd`  
**Branch:** feat/public-readiness-js-core  

---

## Files Created

1. **`scripts/lint-token-step.js`** (58 lines)
   - Pure function `lintWorkflow(workflowObj) → { ok, violations }`
   - Detects token-bearing jobs: permissions `contents: write` or `pull-requests: write`, or `secrets.GITHUB_TOKEN`/`GH_TOKEN` reference
   - Detects authored-code execution: `npm test`, `node --test`, `bin/orch.js`, `orch task|review|pr`, `gate.run`, or checkout of non-`main` ref
   - Thin CLI wrapper (`main()`) reads + parses YAML, exits non-zero on violation
   - Guard: `if (import.meta.url === file://...)` prevents auto-execution on import

2. **`test/lint-token-step.test.js`** (60 lines)
   - 6 test cases exercising the rule:
     - Safe workflow (token job with no authored code) → PASS
     - Token job + `npm test` → VIOLATION
     - Token job + agent CLI → VIOLATION
     - Token job + non-main checkout → VIOLATION
     - Token-secret reference + authored code → VIOLATION
     - Empty workflow → PASS

---

## Test Execution

### Unit Tests (task-specific)

```bash
$ node --test test/lint-token-step.test.js
```

Output:
```
✔ token job that runs no authored code → ok (1.342418ms)
✔ token job that also runs the test gate → violation (0.21333ms)
✔ token job that runs the agent CLI → violation (0.133508ms)
✔ token job that checks out a non-main ref → violation (0.136153ms)
✔ a job referencing secrets.GITHUB_TOKEN counts as token-bearing (0.164585ms)
✔ empty / job-less workflow → ok (0.109609ms)

ℹ tests 6
ℹ pass 6
ℹ fail 0
ℹ duration_ms 158.800669
```

**Result:** ✓ All 6 tests PASS

### Full Test Suite

```bash
$ npm test
```

Summary (last 5 lines):
```
ℹ tests 122
ℹ suites 0
ℹ pass 122
ℹ fail 0
ℹ duration_ms 298.14265
```

**Result:** ✓ All 122 tests PASS (existing 87 + new 6 lintWorkflow + others; no regressions)

---

## Implementation Notes

### Regex Patterns

Both regexes copied verbatim from the brief:

- **`AUTHORED_RUN`:** `/\bnpm\s+test\b|\bnode\s+--test\b|bin\/orch\.js|\borch\s+(task|review|pr)\b|\bgate\.run\b/`
  - Matches: `npm test`, `node --test`, path containing `bin/orch.js`, CLI invocations, gate runner
  
- **`TOKEN_SECRET`:** `/secrets\.GITHUB_TOKEN|secrets\.GH_TOKEN|\bGH_TOKEN\b/`
  - Matches: template variable references and direct env var references

### Job Analysis

1. **Token-bearing detection (`jobIsTokenBearing`):**
   - Scans permissions object for `contents: write` or `pull-requests: write`
   - Scans all steps for `TOKEN_SECRET` in `run:` field
   - Returns false if neither condition is met

2. **Authored-code detection (`jobRunsAuthoredCode`):**
   - Scans all steps for `AUTHORED_RUN` in `run:` field
   - Special case: `actions/checkout` with `ref ≠ main` counts as authored-code pull
   - Returns false if no conditions are met

3. **Invariant check (`lintWorkflow`):**
   - Iterates all jobs
   - Flags any job where both `jobIsTokenBearing()` AND `jobRunsAuthoredCode()` return true
   - Returns `{ ok: boolean, violations: string[] }`

### No-Execute Guard

```javascript
if (import.meta.url === `file://${process.argv[1]}`) main(process.argv);
```

This ensures:
- Direct CLI invocation: `node scripts/lint-token-step.js file.yml` → runs `main()`
- Test imports: `import { lintWorkflow } from "...js"` → does NOT run CLI
- Tests exercise the pure rule without filesystem side effects

---

## Self-Review

✓ **Spec coverage:** §3g token-step invariant fully implemented as specified. Regexes match exactly. Test cases cover all branches of the rule (token-bearing detection, authored-code detection, coexistence violation, safe jobs, empty workflow).

✓ **Code quality:**
  - Pure function + thin CLI wrapper (separation of concerns)
  - Early returns for clarity
  - Comprehensive comments explaining the security invariant
  - No external dependencies beyond `yaml` (already in package.json)

✓ **Type consistency:** Return signature `{ ok, violations }` matches brief and task 3 (`checkPaths`). Consistent with scan/lint result shapes across the codebase.

✓ **Test coverage:** 
  - 6 test cases: all rule conditions, safe case, empty workflow
  - No flakiness, no environmental dependencies
  - All pass on first run

✓ **No regressions:** Full suite (122 tests) passes. No changes to existing code.

✓ **Commit hygiene:** Single commit with clear message. Both files added with force-add (scripts/ is in .gitignore as a safety measure, but this file is load-bearing security).

---

## Commit Details

```
commit d9c6efd
Author: Boris Milinkovic <bmilinkovic@gmail.com>
Date:   [timestamp]

    feat: token-step invariant lint rule (security-core 3g)
    
    - Pure function lintWorkflow() checks token-bearing + authored-code coexistence
    - Detects write permissions, token-secret references, and unsafe checkouts
    - Thin CLI wrapper for workflow file linting
    - 6 unit tests, all passing
    - No regressions to existing 116 tests

Files changed:
  scripts/lint-token-step.js (58 lines, new)
  test/lint-token-step.test.js (60 lines, new)
```

---

## Handoff

This task delivers the **pure rule layer** for §3g (token-step invariant). The follow-on plan will:

1. **Container/sandbox harness + intake workflow (T2, §3a–§3d, §2):** Wire `lint-token-step.js` CLI into `.github/workflows/orch-intake.yml` to enforce at CI time
2. **End-to-end injection-corpus regression:** Run authored exfil code in network-sandboxed container, verify it cannot reach token or LAN
3. **Platform hardening (§7, §6):** Branch protection, CODEOWNERS, action SHA-pinning, etc.

The rule is **load-bearing** per residual #5: a regression in this logic silently reopens the exfil hole. All 6 unit tests must pass to verify correctness before integration.

---

## Fix wave — final-review I1/I2 hardening

**Commit:** `ef9baa2`  
**Branch:** feat/public-readiness-js-core  
**Date:** 2026-06-26

### Changes

| Fix | Severity | File(s) touched | Description |
|-----|----------|-----------------|-------------|
| FIX 1 | Important | `src/intake/allowlist.js`, `test/allowlist.test.js` | `normalizePath()` strips `a/`/`b/` git-diff prefixes and `./` prefix before glob matching; fail-closed on `..` traversal segments; violations array reports original input strings |
| FIX 2 | Important | `src/intake/allowlist.js`, `test/allowlist.test.js` | Added `.github/actions/**` to `DEFAULT_PROTECTED`; test asserts `.github/actions/evil/action.yml` is rejected |
| FIX 3 | Important | `test/allowlist.test.js` | Characterisation tests assert `DEFAULT_PROTECTED` rejects `src/intake/workorder.js`, `src/security-review.js`, `CODEOWNERS`, `.github/CODEOWNERS` |
| FIX 4 | Important | `test/security-review.test.js` | Tests assert `secret-read` rule fires on `.orch/` creds and `.ssh/id_rsa`; `guardrail-touch` rule fires on `workflows/` and `CODEOWNERS` — no regex changes needed |
| FIX 5 | should-fix | `test/redact.test.js` | `hasSecret`/`redact` tests for `github_pat_`, `sk-`, `AKIA`, JWT — patterns already existed, tests were missing |
| FIX 6 | Minor | `src/redact.js`, `test/redact.test.js` | `publicSummary` branch field constrained via `String(branch).replace(/[^\w./-]/g, "")` to strip spaces/newlines/`$()` |

### Test run

```bash
$ npm test
ℹ tests 142
ℹ pass 142
ℹ fail 0
```

All 142 tests pass (prior: 122). 20 new tests added across allowlist (12), security-review (4), redact (4).
