# orch[bot] — GitHub App setup

Run orch's GitHub actions (triage, comments, labels, escalate, open PR) under a
named `orch[bot]` identity instead of your personal PAT. orch mints a
short-lived, repo-scoped installation token at runtime and feeds it to every
`gh` call via `GH_TOKEN` — no call-site changes, no long-lived secret on disk.

**Scope of this bot: label-only.** It opens PRs, comments, labels, and
escalates. It does **not** merge — a human merges. So it needs **no**
branch-protection bypass.

> Educational artifact — do not point this at a production repo (see LICENSE).

## 1. Create the App

GitHub → **Settings → Developer settings → GitHub Apps → New GitHub App**
(personal account is fine; an org App if the repo is org-owned).

| Field | Value |
|-|-|
| Name | `orch-bot` (shows as `orch[bot]`) |
| Homepage URL | the repo URL (any valid URL) |
| Webhook | **uncheck Active** — orch polls via `gh`, no webhook needed |

### Repository permissions (only these three)

| Permission | Access | Why |
|-|-|-|
| **Issues** | Read & write | triage, label, comment, close, reopen/escalate |
| **Pull requests** | Read & write | open PRs, comment, label |
| **Contents** | Read & write | push the PR head branch |

Leave everything else **No access**. Account permissions: none.

Create the App, then on its page note the **App ID** and **Generate a private
key** (downloads a `.pem` — store it outside the repo).

## 2. Install on the repo

App page → **Install App** → your account → **Only select repositories** →
pick `agent-orch` → Install. This creates the installation orch looks up.

## 3. Configure orch

Two env vars. `ORCH_APP_PRIVATE_KEY` may be the PEM path **or** the PEM text.

```sh
export ORCH_APP_ID=123456
export ORCH_APP_PRIVATE_KEY=/home/you/keys/orch-bot.private-key.pem   # path...
# or the inline PEM:
# export ORCH_APP_PRIVATE_KEY="$(cat orch-bot.private-key.pem)"
```

Keep the `.pem` out of the repo (it's not gitignored by accident — never commit
it). owner/repo are derived from the `origin` remote automatically.

## 4. Verify

```sh
orch pr <n>        # comment on the PR should now come from orch[bot]
```

If the App isn't configured (vars unset) or token minting fails, orch logs one
line and falls back to ambient `gh auth` — it never hard-depends on the App.
An explicit `GH_TOKEN` in the environment takes precedence and skips minting.

## How it works

`src/github-app.js`: App ID + key → RS256 app JWT (≤10 min) →
`GET /repos/{owner}/{repo}/installation` → `POST
/app/installations/{id}/access_tokens` → ~1h repo-scoped token, exported as
`GH_TOKEN`. `gh` (and `execFileSync`, which inherits `process.env`) pick it up
with no code change at the call sites.

## Upgrade path

To let `orch[bot]` **merge** (not just label), add it to the branch-protection
bypass list for `main` and have orch call `gh pr merge`. Deliberately out of
scope here — keep a human on the merge button for an educational harness.
