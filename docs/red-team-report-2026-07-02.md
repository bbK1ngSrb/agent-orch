# Red Team Report — agent-orch

**Date:** 2026-07-02
**Method:** CIA Red Team tradecraft, four adversarial passes run in strict sequence: Key Assumptions Check → Pre-Mortem → Hostile Competitor → 1-Star Review → Synthesis.
**Inputs:** full repo (README, docs/, src/, CHANGELOG, LICENSE), all 44 GitHub issues (all closed), 35 PRs (30 merged), and the operator's session memory covering every failure and recovery since 2026-06-23.

---

## Step 0 — The idea, one paragraph

**agent-orch (`orch`)** is a Node CLI that pairs two AI coding agents on any git repo: one authors a small change, the other cross-audits it, tests gate the result, and on agreement + green tests it merges to `main` — locally by default, with revise rounds capped and stalemates escalated to the human. It targets a solo developer / homelab operator automating small code changes across their own repos, with GitHub issue and PR bridges for issue-to-merge cycles. It is explicitly an educational artifact (PolyForm Noncommercial, "run inside a sandboxed environment", zero-liability disclaimer). Success in 6 months looks like: `orch issue <n>` reliably lands unattended cycles across the operator's repos with no silent merge corruption, cheap enough per cycle that dispatching it beats doing the change by hand.

---

## Step 1 — Key Assumptions Check

*Persona: CIA Red Team analyst. Not evaluating whether the idea is good — auditing the assumptions it stands on.*

### The assumptions (12)

| # | Assumption | Tier |
|---|-----------|------|
| A1 | A second AI cross-auditing the first catches a meaningful share of real defects (reviewer independence produces error detection, not correlated blindness). | **LOAD-BEARING** |
| A2 | Green tests mean the change is safe to merge — even though the agents write both the code *and* the tests that gate it. | **LOAD-BEARING** |
| A3 | The git plumbing around autonomous local merges (integration worktree, locks, concurrent cycles, NFS) can be made reliable enough to trust unattended. | **LOAD-BEARING** |
| A4 | When orch reports "merged", the commit is actually on `main`/`origin/main` — the tool's self-reporting is honest. | **LOAD-BEARING** |
| A5 | Two frontier-model agents per small change costs less than the human attention it saves. | **LOAD-BEARING** |
| A6 | The self-hosting loop (orch developing orch) converges — agent-built fixes reduce the defect rate faster than agent-built features add to it. | **LOAD-BEARING** |
| A7 | Vendor agent CLIs (`claude`, `codex`) remain stable, scriptable interfaces (flags, stdin behavior, headless modes). | IMPORTANT |
| A8 | Tasks stay small — agents respect scope, and `scope.maxLines` escalation actually contains sprawl. | IMPORTANT |
| A9 | Concurrent cycles on one repo is a real need for a solo operator, worth the lock/worktree/race complexity it bought. | IMPORTANT |
| A10 | Escalation to the human is rare enough that the loop is genuinely autonomous, not a slow way to ask for help. | IMPORTANT |
| A11 | The educational-artifact framing works — people who run it actually sandbox it. | IMPORTANT |
| A12 | The noncommercial license costs nothing because there is no commercial ambition. | MINOR |

### Evidence tests for the load-bearing six

- **A1 (cross-audit catches defects):** *What would prove it wrong:* cycles where the reviewer said AGREE and the merged change was later found defective. **That evidence exists in this repo.** The merge-integrity defect chain (#68 orphan, #76/#77/#78/#80) lived in code that passed authored-and-audited cycles; issue #77 was a duplicate of #76 filed by a cycle's *own author agent mid-task* — the agents did not even have shared awareness of the defect they were duplicating. No catch-rate has ever been measured: there is no count of "reviewer found real bug author missed" vs "reviewer rubber-stamped". **Operating on faith.**
- **A2 (green tests gate safety):** *Proof it's wrong:* defects that shipped through green suites. Also exists — every bug in the #76–#80 chain passed the full suite (331+ tests at the time). The suite is large (91 test files) but it is substantially agent-written, testing the behaviors agents thought to test. Test count is being used as a proxy for safety; the failures that mattered were in paths no test covered (detached integration worktree HEAD, ref-advance-after-merge).
- **A3 (local-merge plumbing can be trusted):** *Proof it's wrong:* the operational record. **On 2026-07-02, ~5 of ~10 `orch issue` cycles required manual git recovery (cherry-pick or ff+push) despite orch reporting success.** The root cause (#80, detached integration-worktree HEAD) is fixed but has survived roughly one cycle of validation. The operator's own standing rule — *"verify every 'merged' claim before trusting it"* — is written into session memory. A tool whose output must be independently verified every run has not yet earned assumption A3.
- **A4 (honest self-reporting):** *Proof it's wrong:* #78 — `finalize()` could silently fail to advance/push local `main` after building a correct merge commit **while reporting false success**. Fixed to throw honestly, but the failure mode (report success, deliver nothing) is the worst possible one for a trust product, and it shipped.
- **A5 (cost < value):** *Proof it's wrong would be:* per-cycle $ cost vs. an estimate of the human minutes saved. The repo has a cost-tracking issue (filed, escalated, retried) but **no working per-cycle accounting exists**. Known aggregate: agent spend around ~$1,073–$1,787/week at the model tiers considered. Whether a 12-line diff reviewed by a frontier model is cheaper than 90 seconds of human glance has never been measured. **Operating on faith.**
- **A6 (self-hosting converges):** *Proof it's wrong:* the defect-discovery rate over time. 44 issues in ~10 days, a large fraction filed against orch's own merge machinery, several *created by orch cycles themselves* (#77). The loop currently manufactures a meaningful share of its own work. Converging or compounding is genuinely undecided — but it is being *assumed* converging.

**Analyst's note:** A1 and A5 are the product thesis — "cross-audit is worth two agents' cost." Neither has a single measured data point. Everything else is engineering; those two are the idea.

---

## Step 2 — The Pre-Mortem

*It is 2027-12. agent-orch failed. Not "did okay" — burned. This is the honest post-mortem, written in past tense.*

### Months 1–3: the warning signs we ignored

The signs were in our own memory files. By July 2026 the operator had a standing personal rule: *verify every "merged" claim with `git fetch origin main && git log origin/main` before trusting it.* We read that sentence and did not hear what it said — the product's single deliverable, a trustworthy merge, was already being manually re-verified on every run by the only user on earth. Half the cycles in the July 2nd session needed hand recovery. We treated each recovery as a bug to fix (and fixed them — #76, #78, #80, fast, competently) instead of as a verdict on the architecture. We kept score in tests passed (331! 400!) rather than in the only metric that mattered: *consecutive unattended cycles with zero manual git surgery.* That number never got above single digits, and nobody was tracking it.

### Months 4–9: the decisions that made it worse

Feature velocity stayed spectacular because orch was building orch: dashboard, cost tracking, cheap-agent dispatch, Linear bridge, agent registry. Every feature added surface to the same fragile core — more code paths that could touch `.orch/integration`, more concurrent-cycle interleavings, more states crash-recovery had to reconstruct. The test suite doubled, but the agents wrote the tests for the code the agents wrote; coverage grew where implementation grew, not where risk lived. Meanwhile the cost question stayed unanswered. Weekly token spend crossed four figures and the response was to route to cheaper models — which quietly degraded the reviewer, the one component whose quality was the entire thesis. Nobody noticed, because reviewer catch-rate had never been measured, so it couldn't be seen falling.

### Months 10–15: the point of no return

Two things happened in the same month. First, a vendor CLI update changed headless behavior again (the July stdin-hang, #58, had been the rehearsal) and both adapters needed emergency rework — a week of maintenance that produced zero user-visible value. Second, and fatally: orch was finally pointed at a repo that *mattered* — not agent-orch itself, but a real project — and a stale-base race variant nobody had seen on the dogfood repo silently discarded an afternoon of already-tested work. It was recovered from reflog, but that was the last time orch ran on anything except itself. From then on agent-orch was a tool whose only production workload was its own development: a snake fed exclusively on its tail.

### Months 16–18: the collapse and what it cost

The platforms shipped the loop natively. GitHub's coding agent reviewed its own PRs with a second model; the agent CLIs grew built-in pair-review modes; every one of them merged via PRs — never touching a local `main` — so the entire class of problems orch had spent its life heroically solving simply did not exist for them. The noncommercial license meant no path to users who might have funded the maintenance. The operator, doing the honest math — hours spent maintaining orch versus hours orch saved — archived the repo. Cost: roughly six months of evenings, a four-figure monthly token bill at peak, and the opportunity cost of the projects not built. The 91 test files remain a genuinely good education in autonomous-merge failure modes, which is what the README had promised all along.

**The root cause was building autonomy on top of a merge pipeline its only operator had already learned not to trust — every "merged" required manual verification, so the tool never actually delivered the unattended-ness that was its entire reason to exist.**

---

## Step 3 — The Hostile Competitor

*Persona: competitor with $50M, world-class talent, 90 days, personal grudge.*

### Days 1–30: study, copy, reposition

Your repo is public and your issues are a gift — 44 closed issues are a complete map of every landmine in autonomous merging, annotated with root causes. My team reads them in an afternoon. We extract the two real ideas (author/reviewer role split with revise cap; test-gated auto-merge) and note that both are **prompt-and-glue patterns, not technology** — there is no model, no dataset, no protocol here that takes more than a week to reimplement. Then we make the one design decision that deletes 60% of your codebase: **we never merge locally. PRs only.** Your lock files, integration worktrees, detached-HEAD reattachment, stale-base races, diverged-main recovery, ff-only fallbacks — all of it exists only because you chose to advance a local `main` autonomously. GitHub's merge queue does that job with a decade of hardening. We ship the cross-audit loop as a GitHub Action: `uses: rival/pair-review@v1`. Zero install, zero git surgery possible.

### Days 31–60: launch the better version

We launch with the three things you don't have: (1) **a measured catch-rate dashboard** — every review logged as caught-real-bug / rubber-stamp / false-alarm, so users see exactly what the second agent buys them (the number you never collected); (2) **per-cycle cost accounting** with model routing tuned against that catch-rate, so "is this worth two agents" is answered on screen; (3) **provider-agnostic adapters maintained by a team**, so when a vendor CLI breaks stdin handling on a Tuesday, the fix ships Wednesday, not whenever your evenings allow. Pricing: free for open source. Your PolyForm Noncommercial license means you cannot even respond commercially.

### Days 61–90: starve

I don't need to attack you; I need to attack your oxygen, which is *attention*. I sponsor the "autonomous PR review" pattern into the agent vendors' own docs and cookbooks, so the default answer to "how do I get two agents to check each other" is a platform feature, not your CLI. I hire the two or three people who ever opened a PR against your repo. And I quote your own README in every comparison page: *"zero liability for token expenses, infinite API loops, accidental data loss."* You wrote my marketing copy — an educational artifact that disclaims data loss, next to a hosted product with an SLA.

**What you're uniquely vulnerable to that you probably don't see:** your moat is upside-down. The hardest, best engineering in your repo (concurrency, locks, crash recovery, merge integrity) is all *cost*, paid to sustain a design choice (local merges) that your users didn't ask for and that platforms have already solved with PRs. You are proud of exactly the code I get to not write.

**The weakness that lets me win is that orch's hardest-won engineering solves a self-imposed problem — safe autonomous local merges — that disappears entirely for anyone who just uses PRs, which the platforms already do natively.**

---

## Step 4 — The 1-Star Review

*Persona: customer who spent real money and real time, and feels cheated. The tweet that got 10,000 likes:*

> ⭐ agent-orch review, 1/5:
>
> Paid two frontier models to babysit each other so I wouldn't have to babysit them. Ran 10 cycles. Terminal proudly printed "merged (agreed + green + merged)" — folks, FIVE of those merges did not exist. Not on main. Not on origin. Vibes-based version control.
>
> So now my "autonomous" workflow is: run orch, watch it declare victory, then personally `git fetch && git log origin/main` like a divorce lawyer checking receipts, then cherry-pick my own robot's homework out of a detached HEAD in a hidden worktree called `.orch/integration` which, by the way, PERMANENTLY SQUATS my main branch so `git switch main` just... fails.
>
> The README says "zero liability for accidental data loss." Incredible. The one thing I wanted was the merge. The merge was the product. I paid $40 in tokens for a machine to tell me a thing happened that did not happen. I could have hallucinated success myself for free.
>
> Docs are lovely though. Great changelog. Very detailed record of all the ways it lost my commits. 1 star.

**The quote-tweets:**

> 💬 "It escalated a 6-line diff to me after 3 revise rounds because two AIs couldn't agree on a variable name. I am the human-in-the-loop for a philosophical dispute between robots I am paying by the token." — @shipitfriday

> 💬 "Mine filed a GitHub issue about a bug, and then a second cycle filed a duplicate of that issue, authored by the agent that was supposed to be fixing it. My repo is now a group chat between models." — @yakshaver_dev

> 💬 "The install guide's step 1 is basically 'run this in a sandbox because it may enter infinite API loops.' That's not a disclaimer, that's a confession with a package.json." — @opsgremlin

**The single thing that made me feel cheated was being told "merged" by a tool whose entire job — the whole product, the one promise — was to be trustworthy about exactly that word.**

---

## Step 5 — Synthesis

The four closing lines, side by side:

- **Root cause (pre-mortem):** autonomy was built on a merge pipeline the operator had already learned not to trust — the standing rule "verify every merged claim" meant the product never delivered unattended-ness at all.
- **Competitive weakness (hostile competitor):** the hardest engineering in the repo defends a self-imposed problem; PR-only merging — which platforms do natively — makes orch's local-merge machinery, and the value of having built it, evaporate.
- **Trust gap (1-star review):** the tool reported "merged" when it hadn't. For a product whose deliverable *is* the merge, one false success costs more trust than fifty honest escalations.
- **Load-bearing assumptions with no evidence (assumptions check):** A1 — the cross-audit catch-rate has never been measured (and the recorded evidence points the other way: audited cycles shipped the integrity bugs); A5 — per-cycle cost vs. human attention saved has never been measured. These two *are* the thesis, and both are running on faith.

### Fixable near-term (execution problems)

1. **Trust gap — fixable, and mostly built.** `merge: pr` already exists in orch.yml; the #80 worktree fix is in. Two concrete moves: make orch verify its own claim (post-merge `merge-base --is-ancestor` against `origin/main` before printing "merged" — internalize the operator's manual ritual), and track the real KPI: consecutive unattended cycles without manual git recovery. Consider making `merge: pr` the default and local-merge the opt-in — the failure record argues the default is backwards.
2. **A5 (cost) — fixable.** The cost-tracking issue is already filed; per-cycle token/$ next to each verdict turns faith into a number.
3. **A1 (catch-rate) — fixable and highest-value.** Log every review outcome as caught-real-defect / agreed-clean / false-alarm. A month of data either proves the thesis or kills it; both outcomes are wins.

### Suggests the idea itself needs to change

- **Local auto-merge-to-main as the core design.** Every severe defect in the project's history (#52, #53, #68, #76, #77, #78, #80, the integration-worktree squatting from #44) traces to this one choice. The pre-mortem's root cause, the competitor's kill-shot, and the angry customer's complaint are all the same sentence. The cross-audit *loop* is the idea worth keeping; the local merge is the part the evidence keeps voting against.
- **The unmeasured thesis.** If a month of catch-rate data shows the reviewer mostly rubber-stamps, the honest product is one agent + tests + human glance, and the two-agent framing — not its execution — was the error. That data doesn't exist yet, and until it does, agent-orch is an engineering success attached to an unvalidated premise.

### Scope fairness

Judged as what its README claims — an educational artifact about autonomous agent orchestration — agent-orch is *succeeding*: 44 issues opened and closed in ~10 days, root causes found and fixed, an unusually honest failure record. This report judges it against the harder standard its 6-month success criterion implies (trusted unattended cycles), because that is the standard the idea itself sets. The gap between those two framings is exactly where the red-team findings live.
