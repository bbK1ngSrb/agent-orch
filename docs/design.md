# agent-orch — Design Spec

**Date:** 2026-06-23
**Status:** Design, pending user review
**Working name:** `agent-orch` (npm package) / `orch` (command). Rename freely.

**Goal:** A repo-agnostic, open-source tool that runs **two or more locally-installed
coding agents** (Claude, Codex, …) in a **cross-audit loop** on any local git repo.
One agent authors a small change on a branch; the other audits it; on agreement +
green tests the tool merges to `main` locally; on disagreement it runs a capped
revise loop; on stalemate it escalates to the human. Install from source
(`npm install -g .`), then `orch task "fix X"`.

This generalizes the homelab `cross-audit-pr-orchestration` design by **stripping all
deployment-specific plumbing** (NAS bare repo, `deploy.sh`, GitHub `--mirror`,
`post-receive` hook, telegram). Nothing here connects to that setup.

---

## 1. Constraints & principles

- **Repo-agnostic.** Works on any local git repo. No assumptions about remote,
  CI provider, or project language.
- **Agent compute is local.** Agents run as locally-installed CLIs on the user's
  machine. The optional GitHub PR bridge shells out to authenticated `gh` only to
  fetch PR heads, post verdict comments, and merge approved PRs.
- **Two PR surfaces.** `orch task` still creates local branches
  `pr/<author>/<topic>` and merges locally. `orch pr <n>` audits an existing
  GitHub PR without touching local `main`; GitHub owns the comment and merge.
- **Trivial deploy/usage.** Install from source (`npm install -g .` exposes the
  `orch` bin) — no separate runtime (Node is already present for the agent CLIs).
  Most repos need zero config.
- **Minimum options.** Every config key has a smart default. A working setup is an
  empty `orch.yml` (or none at all).
- **Safety rails.** Agents never write `main`. Only the engine merges, only after the
  test gate passes. Each cycle is isolated in a throwaway worktree.

## 2. Surface (the whole CLI)

```
orch init              # scaffold orch.yml + .orch/, verify agent CLIs on PATH
orch task "fix X"      # author + cross-audit + gate + merge — one cycle
orch review <branch>   # audit-only on an existing branch (no author step)
orch pr <n> [--merge]  # audit a GitHub PR via gh, comment the verdict, optionally merge
```

Four commands. `task` is the full local loop; `review` audits an existing local
branch; `pr` is the GitHub PR bridge via `gh`.

## 3. Agent model

- **Pluggable adapters.** Each agent backend implements a small contract:

  ```
  AgentAdapter {
    author(task: string, workdir: string): Promise<void>   // make commits in workdir
    audit(branch: string, workdir: string): Promise<Verdict> // read-only, return verdict
  }
  Verdict = { decision: "AGREE" | "DISAGREE", reason: string, raw: string }
  ```

- Ship two adapters: `claude` (`claude -p` in the worktree) and `codex`
  (`codex exec --cd <worktree>`). Community can add Gemini/Aider/etc. by dropping a
  new adapter — documented in `CONTRIBUTING.md`.
- **Roles per cycle:** `author` = the next agent in `agents:`; `reviewer` = the other.
  Author alternates between cycles so neither agent only ever writes or only ever
  reviews. Cross-vendor audit is the point — diversity catches more. Alternation is
  stateless across runs except for a one-line marker `.orch/last-author`; absent →
  first agent in `agents:` authors.
- **Explicit / parallel roles:** pin roles with `author:`/`reviewer:` (set both or
  neither) to skip rotation. The plural `authors:`/`reviewers:` lists fan out: each
  author writes its own `pr/<author>/<slug>` branch, and every reviewer audits each
  branch *except* the one whose author it is. CLI flags `--author(s)`/`--reviewer(s)`
  (comma-separated) override `orch.yml` for a single run.
- **`review <branch>` (audit-only):** every configured agent except the branch author
  audits; with the default two agents that's the single opposite agent. Merge on
  unanimous `AGREE` + green gate, same rails as `task`.
- **Reviewer is read-only on code.** Its only product is the verdict. The author
  adapter is the only one that writes/commits.

## 4. Cycle state machine (`engine.js`)

```
orch task "fix X"
   │  author = next agent, reviewer = the other
   ▼
[1] git worktree + branch  pr/<author>/<slug>   (.orch/wt/<branch>/)
   │
   ▼
[2] author agent works in worktree → commits
   │
   ▼
[3] scope check (optional, off by default) — over cap → escalate "split PR", STOP
   │
   ▼
[4] reviewer audits read-only → Verdict (AGREE | DISAGREE + reason)
   │
   ├─ AGREE ──► test gate (auto-detected cmd) in worktree
   │              ├─ pass ──► merge branch into main
   │              │            ├─ ff-only ok ──► ✅ merged, prune worktree, STOP
   │              │            ├─ non-ff ──► attempt rebase onto main
   │              │            │              ├─ clean ──► merge, STOP
   │              │            │              └─ conflict ──► escalate, STOP
   │              │            └─ (merge: ff-only default; no-ff configurable)
   │              └─ fail ──► escalate "AGREE but tests red", no merge, STOP
   │
   └─ DISAGREE ─► round < reviseCap (default 3)?
                    yes ─► author revises applying findings, commits, round+1 → back to [4]
                    no  ─► build decision brief → escalate, STOP
   │
   every transition → terminal stream + .orch/reviews/<branch>/round-N.md
```

- **Round counter** tracked in-process and stamped in each revise commit trailer
  (`Round: N`). Hard cap `reviseCap` (default 3).
- **Verdict storage:** `.orch/reviews/<branch>/round-N.md` (gitignored working area,
  not committed to the branch, so it never pollutes the merge).

## 5. Auto-monitoring (all local)

Four monitored signals, no cloud:

1. **Agent-vs-agent verdict** — the reviewer monitors the author's output; the
   AGREE/DISAGREE decision drives the loop.
2. **Test gate** — the orchestrator monitors the result objectively; a wrong reviewer
   is caught because merge requires `AGREE ∧ tests green`.
3. **Self-healing** — disagreement triggers a capped author-revise loop before any
   human is involved.
4. **Escalation** — on stalemate (cap hit), tests-red-on-agree, or merge conflict:
   print a **decision brief** to the terminal and write
   `.orch/reviews/<branch>/DECISION.md`, then exit code 2.

> **Default (flag to change): escalation is terminal + local file only.** No desktop
> notification dependency. A `--notify` opt-in (node desktop notification) can ship
> later if wanted.

**Decision brief** (stalemate) presents both sides so the human arbitrates:
reviewer's standing objection (pros/cons), author's last rebuttal (pros/cons), diff
summary, links to each round. Choices: merge as-is / revise / abandon.

## 6. Test gate (repo-agnostic)

- **Auto-detect** the test command in priority order:
  1. `orch.yml` `test:` override (if set)
  2. `package.json` `scripts.test`
  3. `pytest` if `pytest.ini`/`pyproject`/`tests/` present
  4. `go test ./...` if `go.mod`
  5. `make test` if a `test` target exists
- If none detected and none configured → **warn and treat the gate as
  unavailable**: the engine refuses auto-merge and escalates ("no test gate; merge
  manually"). Merging untested code silently would break the core safety promise.
- Override is one line: `test: "pnpm test --run"`.

## 7. Configuration (`orch.yml` — all optional)

```yaml
agents: [claude, codex]   # order; author alternates per cycle. ≥1 required to run.
# author: claude          # pin roles (set both or neither) to skip rotation
# reviewer: codex
# authors: [claude, codex]    # parallel: each writes its own branch
# reviewers: [claude, codex]  # each audits every branch except its own author's
test: auto                # auto-detect, or an explicit command string
reviseCap: 3              # max revise rounds before escalation
merge: ff-only            # or "no-ff"
scope:                    # small-PR discipline — OFF by default
  maxLines: 0             # 0 = disabled; >0 = reject author commits exceeding it
  ignore: ["*.lock", "dist/**", "*.snap"]
```

> **Default (flag to change): scope cap OFF.** The homelab design hard-capped 100
> changed lines; for a general tool that would surprise users. Opt-in by setting
> `scope.maxLines`. When enabled, the reviewer also applies the soft "≤3 logical
> changes" criterion as a review rule.

## 8. Components (isolated, unit-testable)

| Module | Job | Interface |
|---|---|---|
| `cli.js` | parse argv, dispatch `init`/`task`/`review`, preflight (CLIs on PATH) | argv |
| `engine.js` | the §4 state machine | `run(task, cfg)` |
| `adapters/claude.js`, `adapters/codex.js` | shell out to each agent CLI | `AgentAdapter` (§3) |
| `adapters/index.js` | registry; resolve names from `agents:` | `get(name)` |
| `gate.js` | detect + run the repo's test command | `detect(repo)`, `run(wd) → {pass, log}` |
| `scope.js` | changed-line count vs `main`, honor ignore globs | `count(branch) → n` |
| `verdict.js` | parse `AGREE`/`DISAGREE` + reason from agent output | `parse(text) → Verdict` |
| `git.js` | worktree create/prune, branch, merge (ff-only/rebase) | thin wrappers |
| `github.js` | fetch GitHub PR heads, run review-only cycles, comment/merge via `gh` | `runPr(opts, deps)` |
| `config.js` | load `orch.yml`, apply defaults, validate | `load(dir) → cfg` |
| `notify.js` | terminal stream, write `round-N.md`, build/emit decision brief | `phase()`, `escalate()` |
| `prompts/author.md`, `prompts/review.md` | prompt templates, branch-parameterized | template render |

## 9. Verdict contract

The review prompt instructs the reviewer to end its output with exactly one of
`AGREE` or `DISAGREE`, followed by a one-paragraph reason. `verdict.js` parses the
last such token. Malformed/missing verdict → treated as `DISAGREE` with reason
"unparseable verdict" (fail-safe: never auto-merges on ambiguous output).

## 10. Safety rails (local)

- Agents never write `main`; only the engine merges, only after the gate passes.
- Each cycle runs in a throwaway worktree `.orch/wt/<branch>/`, pruned after.
- **Global lock** `.orch/lock` (flock) — one cycle at a time per repo.
- **Kill switch** — `.orch/pause` file present, or Ctrl-C, aborts cleanly.
- `merge: ff-only` default; non-ff → rebase attempt → conflict → escalate (engine
  never resolves conflicts itself).

## 11. Distribution / GitHub-ready

- Install from source (`npm install -g .`); run via the `orch` bin. Not published
  to npm — the `agent-orch` name there is an unrelated package.
- Prereq: at least one agent CLI (`claude` and/or `codex`) on PATH — documented in
  README, verified at `init` and at `task`/`review` preflight.
- Repo ships: `README.md` (quickstart), `LICENSE` (MIT), `CONTRIBUTING.md` (adapter
  authoring guide), `orch.example.yml`, and CI that runs the tool's own unit tests.

## 12. Testing

- `verdict.js` — unit: AGREE / DISAGREE / malformed / missing → correct Verdict.
- `scope.js` — unit: synthetic diffs around the cap, ignore globs honored.
- `gate.js` — unit: detection matrix (npm / pytest / go / make / none).
- `git.js` — unit/integration on a temp repo: worktree lifecycle, ff vs non-ff merge.
- `engine.js` — **dry-run** (`ORCH_DRYRUN=1` stubs adapters, gate, merge): assert the
  state machine takes the correct branch for each (verdict × round × gate-result)
  combination, including the cap-hit stalemate brief and the no-test-gate escalation.

## 13. Out of scope (YAGNI)

- Background daemon / file-watcher auto-trigger (`orch watch`) — later opt-in.
- Cloud-hosted agent execution. The PR workflow requires a trusted self-hosted
  runner because PR tests and agent CLIs run locally on that runner.
- More than one concurrent cycle per repo (global lock).
- Autonomous task-picking (the human supplies the task string).
- Desktop/Slack/telegram notifications (terminal + local file only at v1).

## 14. Defaults chosen (flag on review)

- **Scope cap OFF** by default (opt-in via `scope.maxLines`).
- **Escalation = terminal + local `DECISION.md`** only; no notification dependency.
- **Merge = ff-only**, rebase fallback, conflict → escalate.
- **reviseCap = 3.**
- **Author alternates** between cycles.
