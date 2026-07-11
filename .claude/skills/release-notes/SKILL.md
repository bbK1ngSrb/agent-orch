---
name: release-notes
description: Generate release notes for agent-orch from git history since the last tag. Groups Conventional-Commit subjects into Added / Fixed / Changed / Internal, links PRs and Closes-#refs, and writes a CHANGELOG-ready block. Use when cutting a release or the user says "release notes", "changelog", "what changed since last tag".
disable-model-invocation: true
---

# release-notes

User-invoked. Produce release-note prose for agent-orch from commits since the
last tag. The npm-OIDC publish + GH Release backfill are already automated — this
only writes the human-facing notes.

## Steps

1. **Find range.** Last tag → HEAD:
   ```bash
   git fetch --tags --quiet
   LAST=$(git describe --tags --abbrev=0)
   NEXT=$(node -p "require('./package.json').version")   # target version
   git log --no-merges --pretty='%h%x09%s%x09%b' "$LAST"..HEAD
   ```
   If `package.json` version equals `$LAST` with no `v`, the bump hasn't landed —
   ask which version this release is.

2. **Group** each subject by Conventional-Commit type:
   - `feat:` → **Added**
   - `fix:` → **Fixed**
   - `perf:`/`refactor:` behavior-affecting → **Changed**
   - `chore:`/`test:`/`docs:`/`ci:`/`build:` → **Internal** (collapse; omit if noisy)
   - Drop `chore(release):` bump commits entirely.

3. **Enrich** each line: keep the short hash, append PR number if the subject has
   `(#NN)`, and surface `Closes #NN` from the body. Rewrite terse subjects into a
   one-line user-facing sentence (what changed + why it matters) — this repo is an
   educational artifact, so a reader who didn't write the code should understand it.

4. **Emit** a block ready to paste at the top of `CHANGELOG.md`:
   ```markdown
   ## v<NEXT> — <YYYY-MM-DD>

   ### Added
   - <sentence> (#PR, `hash`)

   ### Fixed
   - <sentence> (#PR, `hash`)

   ### Changed
   - <sentence> (#PR, `hash`)
   ```
   Omit empty sections. Get the date from `date +%F` (do not guess).

## Rules
- Facts only — every line traces to a real commit; never invent a change.
- No secrets, no internal paths in user-facing notes.
- Show the block; ask before writing to `CHANGELOG.md`.
