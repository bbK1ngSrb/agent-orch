# Planned

## #416 tag-release API ref creation — pending, owner must hand-land

**Not fixed.** The whole fix lives in `.github/workflows/tag-release.yml`, which
`src/intake/allowlist.js` marks as a protected path, so an orch cycle cannot
author it — the review-time guard rejects such a diff and the run can only end in
stalemate (see `docs/orch-manual.md` §2.14). The patch is written out here so the
owner can hand-land it, which is the documented recovery for exactly this case.

### The mechanism

GitHub refuses a **push** from a GitHub App identity — and `GITHUB_TOKEN` inside
Actions is one — when the pushed ref makes a change under `.github/workflows/`
reachable, unless the token carries the `workflow` scope. It is a supply-chain
guard: a token a workflow already holds must not be able to rewrite the workflows
that run next, or one compromised job could rewrite CI for every later run.

The subtlety is that the guard asks what the ref's history *contains*, not what
the push introduces. A tag introduces no content at all — it names a commit the
server already has — but the ref still reaches a commit that edited a workflow
file, so the guard fires. That is why, in run `30544887142`, `v0.4.215` was
accepted (its tip predates the workflow edit) and `v0.4.216` was rejected (it
descends from it), ten seconds after the very same commits had landed on `main`
by merge. `v0.4.216` was later tagged by hand with owner credentials, which are
not subject to this restriction.

There is **no `workflows:` key in a job's `permissions:` block**. The scope the
error names is a *token* scope (a PAT's `workflow`, or a GitHub App granted
Workflows: write) and cannot be requested from `GITHUB_TOKEN` by editing the YAML.
Raising `contents: write` higher does nothing.

Two things make this worse than a one-off. The idempotency check (does this
version's tag already exist?) never re-proposes a version the walk has passed, so
a dropped tag is permanent without hand repair — and it takes the GitHub Release
and the `npm-publish.yml` run with it, since that workflow takes a tag as its
required input. And the failure now correlates with exactly the releases most
worth shipping: any release whose history includes a CI change, i.e. every future
fix to this workflow. Because the loop aborts on the first rejection, such a push
ends **half-tagged**, which is the worst of the available outcomes.

### The patch

Add the token `gh` needs to the step's `env:`:

```yaml
        env:
          BEFORE: ${{ github.event.before }}
          AFTER: ${{ github.sha }}
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}   # gh api reads this
```

and replace the tagging loop:

```bash
          TAGS="$(node scripts/release-tags.js "$BEFORE" "$AFTER")"
          FAILED=0
          while read -r SHA TAG; do
            [ -n "${TAG:-}" ] || continue
            if git ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null 2>&1; then
              echo "tag $TAG already exists, skipping"
              continue
            fi
            # Creating the ref through the API points a name at a commit the
            # server already has, so nothing crosses the boundary the push guard
            # protects (#416). Record the failure and keep going: a half-applied
            # tag set is worse than a fully-attempted one that reports at the end.
            gh api "repos/$GITHUB_REPOSITORY/git/refs" \
              -f ref="refs/tags/$TAG" -f sha="$SHA" \
              || { echo "::error::could not create tag $TAG"; FAILED=1; }
          done <<< "$TAGS"
          exit "$FAILED"
```

Notes on the shape, since each line is load-bearing:

- The `git config user.name/user.email` lines and `git tag -a` become dead once
  the push is gone — drop them. Ref creation via the API produces a
  **lightweight** tag (a name pointing straight at the commit) rather than an
  annotated one (a tag *object* carrying a message). Nothing downstream reads the
  annotation: `npm-publish.yml` takes the tag name as input and re-checks
  `package.json` at that ref. If an annotated tag is ever wanted, it is two calls
  — `gh api .../git/tags` to create the tag object, then point the ref at that
  object's sha instead of `$SHA`.
- `gh api … || { …; FAILED=1; }` is deliberate. Under `set -e` a command on the
  left of `||` does not abort the shell, which is precisely what "report this one
  and try the rest" needs.
- `set -euo pipefail` and the assign-then-loop shape stay. That is a separate
  guard (#415): a substitution used as a redirection word is not a *simple
  command*, so errexit cannot see a crashed script there, and the loop would read
  an empty herestring and go green having tagged nothing.

### Ship it with a test

`test/tag-release-errexit.test.js` already parses the workflow and executes its
real `run:` block against stubbed binaries, so the case belongs there: stub `node`
to print two `<sha> <tag>` lines, `git` to succeed, and `gh` to fail while
appending to a counter file; then assert the block exits nonzero **and** that `gh`
was invoked twice. That second assertion is the one derived from the requirement —
it is what distinguishes "reported and continued" from today's "died on the
first". The two existing cases feed an empty tag list and never enter the loop, so
they stay green either way and prove nothing about this — the crash case still
exits nonzero on the `TAGS=` assignment, and the happy case reaches
`exit "$FAILED"` with `FAILED` still `0`. Neither needs a `gh` stub, because with
an empty list `gh` is never reached.

### Verify against a real push before believing it

The API route is a well-founded inference, not a verified fact — the guard's exact
surface is documented for pushes, not for ref creation. The first real push after
landing this must be one whose range **includes a `.github/workflows/` change**;
any other push proves nothing, because the pre-fix code already worked for those.

If the API turns out to be refused too, the fallback is a credentials change
rather than a syntax one: run the step under the `orch-bot` GitHub App already
wired into this repo for merges, which can be granted Workflows: write.

Related: #409 (the push-range walk this failure sits on top of) and #415 (the same
step swallowing a script crash — the silent version of the same half-done result).

## Windows native release — shipped

Native Windows support landed and was confirmed on real Windows 10/11
hardware (not WSL) with agent-orch installed via `npm install -g` from a
built tarball. Confirmed working: `orch init --link`, `orch agent add`,
`orch task --dry` (agent rotation), a full real task cycle (author → review
→ revise → gate → escalate/merge, including a `.sh`-script test gate via Git
for Windows' bundled `sh.exe` association), and `orch update`.

Two real bugs were found and fixed along the way, both in the Windows
process-spawn path (`src/platform.js`, `src/agent-bin.js`, `src/gate.js`,
`src/adapters/cli-adapter.js`, `src/upgrade.js`):

- **#311** — `src/upgrade.js` spawned `npm` with a bare `execFileSync("npm",
  ...)`, which can't resolve Windows' `npm.cmd` shim (`CreateProcess` ignores
  `PATHEXT`). Fixed by routing through the same `portableSpawnSpec`/
  `resolveAgentBin` seam `gate.js` and `cli-adapter.js` already used.
- **#313** — the root cause `#311`'s first fix didn't fully address:
  `exeCandidates()` probed the bare extensionless binary name *before* trying
  `PATHEXT`-suffixed candidates. npm's own global bin directory ships both a
  bare `npm` (POSIX shim) and `npm.cmd` (the real Windows shim) side by
  side — Windows' `fs.accessSync` can't distinguish an executable file from a
  non-executable one (no POSIX exec bit), so the bare, unlaunchable file won
  the probe. Fixed by dropping the bare name from the Windows candidate list
  entirely.

The approach that actually landed differs from the two escalated branches
referenced in earlier drafts of this note
(`pr/claude/refactor-for-multi-platform-agnostic-rel-2623896-0`,
`pr/codex/refactor-for-multi-platform-agnostic-rel-2623896-1`, both since
abandoned) — those attempted hand-rolled `cmd.exe` caret-escaping or a
`shell: true` fallback. The shipped fix instead resolves the correct binary
path *before* spawning and stays shell-less on every platform, avoiding both
the quoting-correctness risk of caret-escaping and the shell-injection
surface of `shell: true`.

CI's Windows matrix leg (`npm-publish.yml`'s `pack-test` job) now also runs
`orch update --check` as part of every pre-publish pack-test, so this
regression class gets caught automatically before any future publish, not
just via manual testing.
