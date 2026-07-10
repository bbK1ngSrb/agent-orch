// GitHub App auth (optional). Mints a short-lived installation access token so
// orch's `gh` shell-outs act as `orch[bot]` instead of a human PAT. Zero new
// deps: Node's crypto signs the RS256 app JWT, global fetch hits the REST API.
//
// Flow: App ID + private key → app JWT (RS256, ≤10min) → look up the repo's
// installation → POST for an installation token (~1h, repo-scoped). The token
// is injected as GH_TOKEN in cli.js; `gh` honors it with no call-site changes.
//
// Design: label-only bot — the App is granted issues:RW, pull_requests:RW,
// contents:RW (no branch-protection bypass). orch opens/labels/comments; a
// human or explicit ruleset bypass merges. See docs/orch-manual.md.
import crypto from "node:crypto";
import { readFileSync, existsSync } from "node:fs";

const b64url = (s) => Buffer.from(s).toString("base64url");

// Sign an App JWT. GitHub caps `exp` at 10 minutes and rejects future `iat`,
// so back-date 30s for clock skew and expire at 9 minutes.
export function appJwt(appId, privateKeyPem, now = Math.floor(Date.now() / 1000)) {
  if (!appId || !privateKeyPem) throw new Error("appJwt: appId and privateKeyPem required");
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: now - 30, exp: now + 540, iss: String(appId) }));
  const data = `${header}.${payload}`;
  const sig = crypto.sign("RSA-SHA256", Buffer.from(data), privateKeyPem).toString("base64url");
  return `${data}.${sig}`;
}

async function api(path, token, method, fetchImpl) {
  const res = await fetchImpl(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "agent-orch",
    },
  });
  if (!res.ok) throw new Error(`GitHub ${method} ${path} → ${res.status} ${await res.text()}`);
  return res.json();
}

// Mint an installation token scoped to owner/repo. Throws on any HTTP failure
// (caller falls back to ambient gh auth). `fetchImpl`/`now` injected for tests.
export async function installationToken({ appId, privateKey, owner, repo, fetchImpl = fetch, now } = {}) {
  if (!owner || !repo) throw new Error("installationToken: owner and repo required");
  const jwt = appJwt(appId, privateKey, now);
  const inst = await api(`/repos/${owner}/${repo}/installation`, jwt, "GET", fetchImpl);
  const tok = await api(`/app/installations/${inst.id}/access_tokens`, jwt, "POST", fetchImpl);
  return tok.token;
}

// Read App creds from env, or null if App auth isn't configured. The private
// key may be the PEM itself or a path to a .pem file.
export function appCredsFromEnv(env = process.env) {
  const appId = env.ORCH_APP_ID;
  let privateKey = env.ORCH_APP_PRIVATE_KEY;
  if (!appId || !privateKey) return null;
  if (!privateKey.includes("BEGIN") && existsSync(privateKey)) privateKey = readFileSync(privateKey, "utf8");
  return { appId, privateKey };
}

// owner/repo from a git remote URL (ssh or https form).
export function parseRepoSlug(remoteUrl) {
  const m = String(remoteUrl).trim().match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/);
  if (!m) throw new Error(`cannot parse owner/repo from remote: ${remoteUrl}`);
  return { owner: m[1], repo: m[2] };
}
