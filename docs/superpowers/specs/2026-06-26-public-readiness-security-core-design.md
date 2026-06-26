# Public-Readiness Security Core — Design

**Status:** Red-teamed twice (6 lenses / 11 gaps, then 5 scoped lenses / 2 gaps + advisor). Topology (two-repo clean-room + per-issue ephemeral container) folded and hardened. Converged → user review → plan.
**Date:** 2026-06-26
**Scope:** Security core only. Governance / legal / release-hygiene split to a separate checklist spec (see Non-goals).

---

## Positioning (binding design constraint)

agent-orch ships **for educational purposes only**. README + LICENSE state plainly: **DO NOT USE IN PRODUCTION. No warranty. No liability.** Teaching artifact for autonomous-agent orchestration patterns, not a supported product.

The disclaimer covers *users who run orch on their own repos*. It does **not** excuse us from one duty: **the public repo + its automation must not become an attack vector against the maintainer's own infrastructure, secrets, or the upstream project.** "No liability to users" ≠ "we may ship a self-compromising bot." The threat model targets that duty.

---

## Problem

We want agent-orch largely self-developed and auto-healing once public: incoming **issues** and **feature requests** drive orch to author fixes/features, audit them, gate on tests, surface PRs. The moment intake is public, every input is attacker-controlled. An issue body becomes an agent prompt; orch's lineage (`orch-pr.yml`) already wields `contents:write` + `pull-requests:write`. Untrusted input reaching an agent with write authority — or running as authored code next to secrets — is the central hazard. This spec defines the trust boundary, the deployment topology, and the containment that let public intake exist without handing an attacker the keys.

---

## Red-team correction (why this spec is shaped the way it is)

A first draft drew the trust boundary around **untrusted prose extraction**. Adversarial review proved that boundary is misplaced: the trusted pipeline **executes attacker-influenced code** (`gate.run()` runs authored tests; the agent CLI runs Bash) and **emits attacker-influenced text** (verdict, PR body, commit) **while holding the write token + model keys** — all *before* the human-merge gate. A schema-valid work order pointing at an ordinary `tests/` path is enough: the authored test runs in the secret-bearing runner and exfiltrates the token.

**Correction:** the secret-free, egress-denied, ephemeral boundary wraps **any execution or emission of attacker-influenced content — not just prose extraction.** The four-layer skeleton (trigger gate / privilege separation / economic caps / human-merge) is right; the boundary is redrawn (§3). The **deployment topology** below makes that boundary physical.

---

## Deployment topology (clean-room + ephemeral container)

Two structural decisions move containment from "configured correctly" to "physically enforced."

### T1. Two-repo clean-room split
- **Private repo (current):** where the maintainer + orch develop "offline" with full workflow/secrets. The root of trust. Never auto-runs public-supplied code.
- **Public repo:** the user-facing face. Secret-free. Handles public issues/feature-requests. Runs orch only in the secret-free sandbox below.
- **Seed, don't fork.** The public repo is an **independent repo seeded from a clean checkout**, **not** a GitHub fork (a fork keeps a network link — PRs/insights flow upstream, the relationship is visible). Publish via **orphan-branch / squash** — one clean root commit, **not** a copied `.git` history. History carries NAS paths, homelab IPs, `.orch/` creds, handles, self-hosted-runner CI → must be scrubbed before first publish (audit: paths, hostnames, any token ever committed, internal workflow files).
- **Direction is one-way.** Private → public **publish** (private keeps public as a push remote for offline-developed work). Public → private is **read-only issue pull only**. Public never pushes/PRs into private.
- **The issue→private bridge is a trust boundary** (open decision — see Open questions). If public issue text is ingested into private and auto-run with secrets, the §3 hole is rebuilt private-side. So ingested issues are either pulled **read-only and treated as untrusted** (full §3 applies private-side) **or** human-curated across the boundary (issue text = untrusted reference, never an authoritative goal). **Hard constraint either way: no author phase ever runs over the unscrubbed private `main`** (it carries homelab IPs / `.orch` creds), because the model-egress channel (Residual #1) would exfiltrate exactly that. If the pull model is chosen, the private-side author container is seeded only from a **scrubbed/synthetic subset** (reuse the pre-publish scrub gate), never private `main`. Recommended resolution: **human-curated-crossing, author public-side only** — do not author private-side at all.
- **Blast radius:** worst case on the **automated pipeline** = public-repo defacement, not homelab/secret compromise — secrets and infra sit behind a repo boundary the attacker cannot reach. This guarantee is **scoped to the automated pipeline.** It does **not** cover a maintainer who locally fetches+tests an untrusted fork PR: `postinstall`/`conftest`/`Makefile`/npm scripts then execute against host secrets and the LAN, outside T2 (see §5).

### T2. Per-issue ephemeral container (the concrete §3 sandbox)
Lifecycle: **clean checkout at `main` → fresh container → ingest issue/PR input → resolve or drop → emit PR/commit → destroy container.** Properties: no persistence (no cross-issue contamination, no cache-poisoning), execution isolation (authored test/build code runs in a throwaway).

A container is a security boundary **only** if configured as one:
- **Seed = code only.** Fresh checkout at `main`, never the maintainer's working tree. **No secrets, no write `GITHUB_TOKEN`, no host bind-mounts, no Docker socket, no SSH-agent forward.** Isolation = exactly what you keep out.
- **Build from protected `main`, never the candidate branch.** The container/sandbox build definition (Dockerfile, setup/harness scripts) is taken from `main`, so issue N's run cannot edit its own sandbox before it is contained. The build definition is in the protected-path set (§7).
- **Egress default-deny.** Author phase: allowlist **only** the egress proxy that holds the model key (§3d) — the key is never in the container. Test/build phase: **`--network none`**. Either way the LAN (NAS, Home Assistant at 192.168.x) is blocked — a container on host shares the LAN by default; this is the #1 self-host risk.
- **Prefer GitHub-hosted ephemeral over self-hosted-on-`rdp`** — off the maintainer's infra, no LAN, disposable VM, smaller escape surface. If self-hosted is unavoidable: rootless + userns, seccomp, drop caps, read-only rootfs, `--network none` + egress proxy. Containers aren't VMs; untrusted code wants gVisor/Kata-grade isolation. (Prior sandbox runs on this host already hit userns/EROFS/phantom-mount issues — self-host is the harder, riskier path.)
- **The container isolates EXECUTION; the emitted commit does NOT inherit trust.** Delete-container ≠ trust-the-diff. The PR/patch is still attacker-influenced and must pass §3c allowlist + §3e security review + §3f egress scrub + human-merge.

T1 and T2 are complementary axes: **T2 = how a single run is isolated; T1 = where secrets live + blast radius.** Combined target: public clean-room repo → per-issue GitHub-hosted ephemeral container (secret-free, egress-locked) → emit PR → §3 output gating → human-merge on public.

---

## Goals

1. Public intake drives orch **without** untrusted input gaining write, merge, secret, or self-modification authority — including via authored code the pipeline executes.
2. **Defense-in-depth (approach C):** trigger gate + privilege-separated *execution and emission* + economic caps + minimal token perms + no self-merge.
3. **Root of trust = the private repo,** physically outside what public attackers reach. Gates orch can rewrite are not gates.
4. Any handling of attacker-influenced content (extraction, authored-code execution, test/build) runs in a **secret-free, egress-denied, ephemeral container**.
5. The write token materializes **only** at a PR-creation step that provably executes no authored code.
6. Abuse (spam, dupe, economic-DoS) bounded by cheap pre-gates + hard caps, not maintainer vigilance.
7. Vulnerability reports → **private** channel, never public-issue → public auto-patch.
8. Every autonomous action recorded to a **tamper-evident, append-only, external** sink (the private repo is the natural one).

## Non-goals

- Governance / community files, legal disclaimer wording, semver / changelog / release automation — separate **public-readiness checklist** spec.
- Auto-merge from public-triggered runs (locked out; human-merge-only at launch).
- Self-hosted runner as the *default* for public jobs (allowed only hardened, as fallback — T2).
- Determinism / reproducibility of agent output.

---

## Locked decisions

| Decision | Choice | Rationale |
|---|---|---|
| Spec scope | Security core only | Separate exploit holes from polish |
| Merge authority (public) | **Human-merge-only** | Smallest blast radius |
| Runner (public) | **GitHub-hosted ephemeral container** | Off-infra, disposable, no LAN |
| Topology | **Two-repo clean-room (seed-not-fork, one-way publish)** | Secrets behind a repo boundary attackers can't reach |
| Run isolation | **Per-issue ephemeral container, secret-free, egress-deny** | Authored code runs in a throwaway with no LAN/secret reach |
| Containment architecture | **Approach C**, boundary at execution/emission | Autonomous-by-design can't rely on a single human/gate |

---

## 1. Trust boundary & threat model

**Assets:** (a) maintainer infra/secrets (NAS, homelab, real API keys, write token); (b) integrity of public `main`; (c) integrity of the **private repo** (root of trust); (d) orch's guardrail logic (§7); (e) the audit trail.

**Adversary:** anonymous user who can open issues/comments and fork PRs on the **public** repo. Cannot push to base, apply labels (collaborator-only), satisfy required review, reach the private repo, or reach the maintainer's LAN (if T2 egress holds).

**Entry points:**

| Surface | Trust | Today | Under this spec |
|---|---|---|---|
| Fork PR code (`ci.yml`) | Untrusted | inherited read | pin explicit read-only perms |
| `orch-pr.yml` (`contents:write`+`pull-requests:write`) | Collaborator-gated | exists | unchanged; **never** wired to untrusted triggers |
| **Issue / feature-request intake → orch** | **Untrusted** | does not exist | net-new; §3 + T2 govern it |
| **Public→private issue bridge** | **Untrusted** | does not exist | read-only/untrusted or human-curated (T1) |
| `claude.yml` (issue/comment, OAuth secret) | Token-gated, **no author gate** | exists | add `author_association` gate |

**Primary threats:**
1. **Prompt injection → write/merge/exfil.**
2. **Economic DoS.**
3. **Self-modification** of orch's own gates/auth/audit/workflows (§7).
4. **Exfiltration via output channels** (verdict, PR body, commit, branch, comment).
5. **Audit tampering.**
6. **Privileged execution of authored / dependency-pulled artifacts** — the pipeline *executes* code it authored (`gate.run()`, agent-CLI Bash) and deps it installs, before merge.
7. **Container escape / LAN pivot** — authored code in a self-hosted or mis-scoped container escaping to host, or reaching NAS/Home Assistant over the LAN. Mitigated by T2 (off-infra GH-hosted, egress-deny, hardened runtime).

---

## 2. Trigger / gate flow (layer 1 — human firewall at trigger)

Nothing fires orch on public intake until a **collaborator** applies a trigger label (e.g. `orch:approved`) — collaborator-only, same as `orch-review`. A **cheap pre-gate** (classifier/heuristic, no code-writing agent) runs first: drop spam/dupes, flag vague/no-repro → auto-comment, never reaching orch. Bounds triage + starves economic-DoS.

Layer 1 is necessary, **not sufficient** — a maintainer can be socially engineered into approving. Layers 2–4 must hold regardless.

Add an `author_association` gate (`OWNER`/`MEMBER`/`COLLABORATOR`) to `claude.yml` before any OAuth-secret step. Intake workflow `permissions:` pinned minimal — **no `contents: write`, no secrets** — regardless of label state.

---

## 3. Privilege-separated execution & emission (layer 2 — core containment)

The boundary wraps **all handling of attacker-influenced content**, realized as the per-issue ephemeral container (T2). Inside: secret-free, egress-denied, ephemeral. Write token + model keys exist **only** outside it, at a step running no authored code.

### 3a. Untrusted extraction (in-container, read-only, secret-free)
- Fresh container, **zero secrets**. Input: raw issue text. Output: schema-validated **work order** `{ title, problem, repro_steps[], suspected_paths[], acceptance_criteria[] }`.
- Only the work-order object crosses. No PR bodies/comments written here.

### 3b. Work-order fields are attacker-shaped reference data, NOT a goal
"Raw prose never crosses" was **false**: `acceptance_criteria[]`/`repro_steps[]`/`problem` are NL instruction strings that cross and become the author's goal. Schema checks *shape*, never *semantics* — malicious intent phrased as a plausible "requirement" (e.g. "log full runtime config on error" → dumps `process.env`).
- Treat free-text fields as **untrusted quoted reference**, not the spec.
- The author's actual goal is re-derived by a trusted prompt the attacker fields cannot rewrite; attacker text is context, not the success oracle.

### 3c. Path allowlist (static write-location control — necessary, not sufficient)
Issue-derived work touches only ordinary source/test paths; **never** the protected-path set (§7). Work orders targeting `.github/workflows/**`, gate/auth/audit modules, or manifests → rejected. Allowlisting `tests/` still permits executing code → see 3d.

### 3d. Sandboxed execution of authored code (the critical fix — realized by T2)
Two distinct phases run **in the per-issue ephemeral container** (T2): secret-free, destroyed after. They have **different network postures** — conflating them undefines the boundary at exactly the point attacker code runs.

**Author phase (needs the model, NOT the model key).**
- The author agent must reach its model endpoint, but the **model key never enters the container env**. It lives in the **egress proxy**: the container authenticates to the proxy with a scoped, model-only credential; the proxy injects the real key server-side and never echoes it back. Egress is allowlisted to the proxy only — no LAN, no write token, no audit-sink credential.

**Test/build phase (§3d core — fully offline).**
- `gate.run()` (test/build) and any agent-CLI Bash over the produced diff run with **`--network none`** — no proxy, no model, no network at all. The diff already exists; execution needs zero egress. Only **pass/fail** crosses back.
- Covers auto-executing test config too: `conftest.py`, `Makefile` test targets, `package.json` scripts, new `test/*.test.js` — auto-discovered/imported = arbitrary code execution, here with no network and no secret.
- Dependency installs for the build resolve through a **read-only, allowlisted package mirror** (not open egress); a malicious dep via a "feature request" reaches no secret, no LAN, no arbitrary host.

### 3e. Independent security review (reviewer.audit becomes a security gate)
- Security review **independent of the work order**: DISAGREE on any diff that reads secrets/`process.env`, opens network egress, spawns subprocesses in tests, or touches protected/guardrail behavior — **regardless** of acceptance_criteria conformance.
- Reviewer is **not** prompted with attacker-influenced acceptance_criteria as its oracle.

### 3f. Output-egress control (own every emitted channel)
Every emitted channel (verdict, PR body, commit message, branch name, comment) passes **secret-detection/redaction** before leaving. Public-triggered runs post **only a fixed-template machine summary** (AGREE/DISAGREE + green/red + machine fields); free-form reviewer prose → maintainer-private channel, never a public surface.

### 3g. Token-bearing step runs no authored code (structural invariant)
Per-run write token exists **only** at the PR-creation step, which executes none of the authored code. Enforce with a **CI lint** — the invariant is structural, not prose.

---

## 4. Economic & runaway caps (layer 3)

Existing: `reviseCap`, `scope.maxLines`, O_EXCL lock, pause file, GH concurrency, fork gate. **Add:**

| Cap | Mechanism | Why |
|---|---|---|
| Rate limit | N runs / window, **per-author and per-repo** | Economic-DoS |
| Token budget | Hard per-run ceiling; abort on exceed | Cost runaway |
| Timeout | Wall-clock kill per phase (+ container max-lifetime) | Hung process |
| Max-attempts | Reuse `reviseCap`; exhaustion → **escalate**, no loop | Fix-A-breaks-B |
| Concurrency | GH concurrency + lock; serialize overlapping-path work | PR storms |
| Re-trigger guard | Ignore comment-edit/re-label re-fires beyond window | Replay |

On breach: stop, comment diagnosis, escalate. Never silently retry.

---

## 5. Merge gate & rollback (layer 4)

- **Human-merge-only** for public PRs. Orch opens PR, posts fixed-template summary (§3f), stops. Maintainer merges.
- **Reviewing/testing untrusted code is a host code-execution surface.** A maintainer who fetches an untrusted fork PR (or any public-originated branch) and runs its tests locally executes `postinstall`/`conftest`/`Makefile`/npm scripts against host secrets + LAN — outside T2. Mandate: such review/test runs **only inside the same secret-free, egress-denied ephemeral container** the automated pipeline uses, never in the secret-bearing working tree. (Full fork-PR contribution policy → separate checklist spec; this is the security-floor.)
- Branch protection requires review on public `main`; autonomous runs cannot satisfy it (§7).
- Post-merge CI on `main` + documented rollback (revert PR). Auto-merge out of scope at launch.

---

## 6. Security-disclosure pipeline

- `SECURITY.md` + GitHub **private vulnerability reporting**.
- A vuln report **must not** flow public-issue → public auto-patch (broadcasts the 0-day + ships the fix in the open). Private channel, human-handled, coordinated. Orch auto-heal is **not** wired to security reports.

---

## 7. Guardrail integrity — root of trust outside the editable repo

**Self-referential hazard:** orch edits the repo that contains its own gates/auth/audit/workflows. Topology T1 makes the root of trust **physically external** — the **private repo** holds the real gates and never auto-runs public code; the public repo is downstream. Even a fully-compromised public-side run cannot reach private gates. On top of that, enforce structurally on the public repo:

- **Platform enforcement, not orch's code:** branch protection on public `main` (required human review, no force-push, no bot bypass); **CODEOWNERS** over the protected-path set (`.github/workflows/**`, `src/gate.js`, `src/verdict.js`, trigger glue, audit module, `package.json`/lockfiles, **the container/sandbox build definition — Dockerfile, setup/harness scripts**) — autonomous runs cannot self-approve. The §3c allowlist enforces the same set at author time. A PR that subtly weakens the sandbox is thus an edit to a protected path (human review required), not ordinary tooling that rides through.
- **Supply-chain hardening:** **SHA-pin** all third-party actions to full 40-char SHAs (`actions/checkout`, `actions/setup-node`, `anthropics/claude-code-action`) in every workflow holding the write token or secrets; Renovate raises action updates as **PRs** (no automerge for actions or the protected set).
- **Tamper-evident external audit sink:** mirror every autonomous action to an **append-only external sink** — the **private repo** (or a write-only log repo/retained Actions artifacts outside the editable tree). "Why did orch do X" survives an attacker who controls the public editable tree.

---

## Residual risks (accepted limits of approach C)

1. **Model-API egress.** A sandboxed author still needs its model endpoint; an injection can encode repo-readable data into prompts. Stripping write token + secrets bounds loss — **but only when the author's read surface is already-public data.** Reading any unscrubbed/secret-bearing tree (e.g. a private-side author over private `main`) voids the bound: the egress channel would exfiltrate the root of trust. Excluded by construction (T1 hard constraint). The channel can't fully close without crippling the author.
2. **Redaction is heuristic.** Secret-shaped scanning is pattern-based, bypassable (base64/stego/novel formats). Raises cost, not a guarantee.
3. **LLM reviewer fallible.** The independent security reviewer is an LLM; a subtle diff that fooled the author may fool it. Defense-in-depth, not proof.
4. **Containment vs capability (core tension).** The more the work order is reduced to closed-vocabulary + template-derived instructions, the less faithfully orch auto-heals complex public bugs. Maximal containment degrades the feature it enables — a deliberate trade.
5. **Step-separation is a structural invariant.** Safety depends on the token-bearing step running no authored code; a regression silently reopens the hole → the §3g CI lint is load-bearing.
6. **Layer-1 label gate stays socially-engineerable** — layers 2–4 must hold; precondition unchanged.
7. **Pinning ≠ trusting upstream.** SHA-pin stops tag-repoint, not a compromised pinned release. The agent-CLI + dep tree remain trusted, out of scope.
8. **Container escape.** Containers aren't VMs; a kernel/runtime exploit defeats T2 isolation. GH-hosted (off-infra) bounds the loss to a disposable VM; self-hosted risks host + LAN → only hardened (gVisor/Kata/rootless+userns+egress-proxy).
9. **Bridge discipline (T1).** The one-way publish + read-only-untrusted issue pull is a discipline a CI/process check must enforce; a future "auto-run ingested issues with secrets" silently rebuilds the private-side hole.
10. **Clean-room leakage.** Seed-not-fork + history-scrub depends on a thorough pre-publish audit; a missed secret/path/handle in history or config leaks once, permanently (public + indexed).
11. **Human-review code-execution surface.** Reviewing/testing untrusted fork PRs runs host-level code (`postinstall`/`conftest`/`Makefile`/npm) outside T2. Mitigated only by the §5 sandboxed-review mandate until the fork-PR-policy spec lands; the §3 automated-pipeline guarantees do not extend to ad-hoc local testing.

---

## Tests

- **Injection corpus:** write/merge/exfil/self-modify attempts → untrusted tier never writes; protected paths rejected; **authored exfil code in an allowed path (`tests/`) runs in a secret-free, egress-denied container and cannot reach a token or the LAN** (the §3d/T2 regression).
- **Path allowlist:** work order targeting `.github/workflows/**`/gate/manifests → rejected.
- **Egress:** trusted-tier output with secret-shaped material → redacted/blocked; public PR surface fixed-template only. **Container network: attempt to reach 192.168.x / non-allowlisted host → blocked.**
- **Independent reviewer:** diff satisfying acceptance_criteria but reading `process.env`/opening network/spawning test subprocess → DISAGREE.
- **Caps:** mass-issue load → per-author + per-repo rate-limit trips; runaway loop → max-attempts escalates; container exceeds max-lifetime → killed.
- **Token-step lint:** CI fails if authored-code execution enters the token-bearing step.
- **Clean-room:** pre-publish scrub audit catches seeded secrets/paths/handles/history.
- **Audit:** tamper attempt on public-side log → external (private) sink retains true record.

## Files likely touched (confirmed in plan)

- New intake workflow (`.github/workflows/orch-intake.yml`) — minimal perms, label-gated.
- Per-issue ephemeral-container harness (seed-clean-main, secret-free, egress-deny, destroy-after) wrapping extraction + `gate.run()` + agent-CLI.
- New untrusted-extraction module (work-order schema + extraction).
- `src/engine.js` — work order as reference-not-goal; allowlist; route execution through container.
- `src/verdict.js` / reviewer prompt — independent security review.
- Egress-redaction + fixed-template output module (`src/notify.js` / new).
- `src/config.js` — caps (per-author/per-repo rate, token budget, timeout, container lifetime), allowlist, re-trigger guard.
- External audit-sink integration (private repo).
- CI lint for the token-step invariant (§3g).
- SHA-pin + author-gate workflows (`claude.yml`, `claude-code-review.yml`, `orch-pr.yml`); Renovate action-update config.
- Clean-room publish tooling (orphan-branch/squash + pre-publish scrub audit).
- `SECURITY.md`, `CODEOWNERS`, branch-protection settings.
- `README` + `LICENSE` — educational/no-liability disclaimer.

---

## Open questions

1. **Issue→private bridge model:** read-only-untrusted-pull (full §3 private-side, author seeded from scrubbed subset only) vs human-curated-crossing (author public-side only)? **Red-team recommends human-curated-crossing** — never author over the private tree. Confirm before plan.
2. Untrusted-extraction classifier — cheap model call vs rule-based heuristic?
3. External audit sink — private repo directly, or a dedicated write-only log target?
4. Path control — allowlist (safe paths) vs denylist (protected set)?
5. Concrete rate-limit thresholds.
6. Container runtime if self-host is ever needed — gVisor vs Kata vs rootless+userns.

---

## What this spec does NOT cover (→ separate checklist spec)

LICENSE selection, CONTRIBUTING, CODE_OF_CONDUCT, legal disclaimer wording, semver policy, CHANGELOG, release automation, fork-PR contribution policy, general repo hygiene.
