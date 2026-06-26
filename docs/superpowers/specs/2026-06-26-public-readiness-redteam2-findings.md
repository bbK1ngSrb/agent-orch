# Red-Team Pass 2 — Findings on the NEW Topology

**Spec:** `docs/superpowers/specs/2026-06-26-public-readiness-security-core-design.md`
**Scope of this pass:** the deployment-topology additions (T1 two-repo clean-room, T2 per-issue ephemeral container) and the issue→private bridge.

## Verdict (header)

Two gaps confirmed against spec text. The topology's containment model has a consistent blind spot: it wraps **automated** handling of attacker-influenced content (T2 / §3) but never wraps the two paths where untrusted/public-originated code reaches a **secret-bearing context by another route** — (a) a human maintainer fetching/testing a fork PR, and (b) the author phase running inside the *private* checkout under bridge Model 1. Both falsify a stated guarantee (line 41 blast-radius; Residual #1 "bounds loss"). Neither is fatal to the four-layer architecture; both require a containment rule + a re-scope of Residual #1. One disputed leg of Gap 1 (mandatory back-flow / "defeats one-way direction") is rejected as incorrect — publish is deliberately one-way orphan/squash with independent histories (line 38).

---

## Gap A — Author phase under bridge Model 1 runs over the unscrubbed private tree (model-egress exfil of the root of trust)

- **Severity:** High
- **Lens:** issue-bridge
- **Sections:** T1 bridge Model 1 / Open-Q #1 (line 254); Residual #1 (line 210); §3d author phase (line 147); T2 seed=code-only (line 47); line 38 (what the private tree commits).

**Attack.** Open-Q #1 presents "read-only-untrusted-pull (full §3 private-side)" as a viable bridge model. Under it, the private-side container is seeded per T2 line 47 = "fresh checkout at `main`" — but private `main` is the unscrubbed root of trust: line 38 enumerates NAS paths, homelab IPs, `.orch/` creds, handles, self-hosted-runner CI all committed in that tree. The §3a extractor is secret-free, but the **author phase (§3d)** must reach its model endpoint (egress to the model proxy is open by design, line 147). An attacker's free-text `acceptance_criteria[]`/`problem` (the injection channel Residual #1 concedes can never fully close) drives the author to read the private tree and encode homelab IPs / `.orch/` contents / internal paths into the model prompt — exfiltrating via the one channel the spec admits stays open. No env secret or token was injected; the container is "secret-free" exactly as specified, yet the crown jewels leave, because "secret-free" strips injected env but not the **committed sensitive tree** the author legitimately reads.

**Why the spec fails.** Residual #1 is declared an accepted limit on the explicit premise that the sandboxed author reads only public-repo data, so "stripping write token + secrets bounds loss." Model 1 silently violates that premise by moving the author into the private checkout, and the spec never re-evaluates Residual #1 for the private side. "Treated untrusted" (line 40) controls the *input* prose; it does nothing about the author's *read scope* over the tree it is seeded from.

**Defender note.** Confirmed: line 38 tracks homelab IPs/NAS paths in the private tree; line 147 keeps model egress open; Residual #9 (injected secrets) and §3f (output-channel redaction) cover neither the model-egress proxy nor the read-scope problem. The "bounds loss" rationale silently assumes the public tree and is never re-scoped private-side. This is genuinely open as written.

**Concrete amendment.** Never run an author phase with model egress inside a checkout of the private tree. If issue-driven authoring must touch private code under Model 1, seed the private-side container only from a scrubbed/synthetic subset (reuse the pre-publish scrub gate, line 38), or — preferred — do not author private-side at all (resolve Open-Q #1 toward human-curated-crossing / cross-reviewed-diff). Re-scope Residual #1 to state explicitly that its "bounds loss" rationale holds ONLY where the author's read surface is already-public data.

---

## Gap B — Maintainer fetching/testing an untrusted fork PR executes attacker code in the secret-bearing host

- **Severity:** Medium
- **Lens:** t1-cleanroom
- **Sections:** T1 (one-way publish, line 39); §5 human-merge (lines 183–187); adversary model (line 94, admits fork PRs); §3d auto-executing surfaces (line 151); blast-radius claim (line 41); fork-PR policy deferred (line 265).

**Attack.** The adversary model (line 94) admits anonymous fork PRs on the public repo. T2/§3 containment covers only the **automated** public-side runs; §5 human-merge never sandboxes the maintainer's manual review. To review or test a candidate fork PR the maintainer does `git fetch && npm test` (or build) in their working checkout — and `conftest.py`, `Makefile` targets, `package.json` scripts, and postinstall hooks (the exact auto-executing surfaces §3d enumerates, line 151) run with full network, host secrets, and LAN reach (NAS, Home Assistant, Cloudflare per the maintainer's tooling). No `--network none`, no egress proxy, no secret-free container applies to a human's local fetch+test. This is a public→host code-execution path that needs no merge and is independent of clone directory.

**Why the spec fails.** §3/T2 model only automated runs as the execution boundary; the line-41 guarantee ("secrets and infra are on the other side of a repo boundary the attacker cannot reach") is stated unconditionally but is falsified by the human review/test path, which the spec never contains.

**Why Medium (and disputed legs rejected).** The primary orch pipeline merges from sandbox-gated, summary-only PRs (§3f/§5), so fetch+test is not *mandated* by the automated flow — the gap is sharpest only for human fork PRs whose review procedure is explicitly deferred to the separate checklist spec (line 265). The red-team's secondary legs — "mandatory back-flow re-imports injected code" and "defeats the one-way direction" — are **wrong**: publish is deliberately one-way orphan/squash with independent histories (line 38), so accepted public changes do not have to flow back into private to keep histories aligned. Only the pre-merge local-fetch leg stands.

**Concrete amendment.** Add a security-core rule: any fetch of public-originated code (fork-PR branch, or issue-derived code) must be reviewed/tested only inside the same secret-free, egress-denied ephemeral container used for automated runs — never in the secret-bearing private/working tree. Qualify the line-41 blast-radius claim to apply to the automated pipeline only, and list the human review/test path as an explicit surface the fork-PR-policy spec must contain. Optionally add a process/CI check that no public ref is fetched into a secret-bearing context.

---

## Cross-cutting invariant

Both gaps are instances of one missing invariant: **public-originated code must never execute in a secret-bearing or unscrubbed-private context, whether the executor is the automated pipeline, the author phase, or a human.** T2 enforces this for automated runs only. The spec should state the invariant once and enforce it across all three executors.

## Residual-risk additions recommended

1. Re-scope Residual #1: the model-egress "bounds loss" rationale assumes a public-only read surface; an author phase over any unscrubbed/secret-bearing tree (e.g. private-side Model 1) voids the bound and must be excluded by construction.
2. Human review/test of untrusted fork PRs is a host-level code-execution surface (postinstall/conftest/Makefile/npm scripts) outside T2; until the fork-PR-policy spec lands, it is mitigated only by maintainer discipline (sandboxed review), and the line-41 blast-radius guarantee holds only for the automated pipeline.
