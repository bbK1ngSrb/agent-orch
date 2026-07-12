#!/usr/bin/env node
// Post a short X (Twitter) announcement after a successful npm publish.
//
// Usage:
//   node src/announce-release.js v0.4.1
//
// Required env (OAuth 1.0a user-context tokens for @agentorchbot):
//   X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET
//
// Optional env:
//   GITHUB_REPOSITORY  — owner/repo for the release URL (default: bbk1ng/agent-orch)
//   DRY_RUN=1          — print the tweet and exit without posting
//
// Designed to run from .github/workflows/npm-publish.yml after the release job.
// Pure Node (no deps): OAuth 1.0a signing + fetch to POST /2/tweets.
// Under src/ (not scripts/): /scripts is gitignored except lint-token-step.js.

import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), ".."); // repo root
const TWEET_URL = "https://api.x.com/2/tweets";
// X counts most URLs as 23 chars (t.co). Keep total under 280 with that in mind.
const X_URL_LENGTH = 23;
const MAX_TWEET = 280;

export function parseTag(tag) {
  const raw = String(tag || "").trim();
  if (!/^v?\d+\.\d+\.\d+$/.test(raw)) {
    throw new Error(`invalid tag: ${tag} (expected vX.Y.Z)`);
  }
  const version = raw.startsWith("v") ? raw.slice(1) : raw;
  return { tag: `v${version}`, version };
}

/** Pull the body under `## X.Y.Z` until the next `## ` heading. */
export function extractChangelogSection(changelog, version) {
  const lines = String(changelog || "").split(/\r?\n/);
  const header = `## ${version}`;
  let i = lines.findIndex((l) => l === header || l.startsWith(`${header} `) || l.startsWith(`${header}—`) || l.startsWith(`${header} —`));
  if (i < 0) return "";
  i += 1;
  const body = [];
  for (; i < lines.length; i++) {
    if (/^## /.test(lines[i])) break;
    body.push(lines[i]);
  }
  return body.join("\n").trim();
}

/** Prefer the first bullet; fall back to the first non-empty paragraph line. */
export function pickBlurb(section) {
  const lines = String(section || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const bullet = lines.find((l) => /^[-*]\s+/.test(l));
  let text = bullet ? bullet.replace(/^[-*]\s+/, "") : (lines[0] || "");
  // Strip markdown links [label](url) → label
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  // Strip bare issue/PR refs noise slightly: keep #308 but drop long trailing URLs
  text = text.replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim();
  return text;
}

export function tweetWeight(text) {
  // Approximate X weighting: non-URL text as-is; http(s) URLs count as X_URL_LENGTH.
  let weight = 0;
  let i = 0;
  const s = String(text);
  const re = /https?:\/\/[^\s]+/g;
  let m;
  let last = 0;
  while ((m = re.exec(s)) !== null) {
    weight += [...s.slice(last, m.index)].length;
    weight += X_URL_LENGTH;
    last = m.index + m[0].length;
  }
  weight += [...s.slice(last)].length;
  return weight;
}

export function truncateToWeight(text, max = MAX_TWEET) {
  if (tweetWeight(text) <= max) return text;
  // Drop graphemes from the end until it fits, leaving room for ellipsis.
  const chars = [...text];
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = chars.slice(0, mid).join("").replace(/\s+$/, "") + "…";
    if (tweetWeight(candidate) <= max) lo = mid;
    else hi = mid - 1;
  }
  return chars.slice(0, lo).join("").replace(/\s+$/, "") + "…";
}

export function composeTweet({ version, blurb, releaseUrl, packageName = "@bbk1ng/agent-orch" }) {
  const install = `npm i -g ${packageName}`;
  const header = `agent-orch v${version}`;
  const footer = `${install}\n${releaseUrl}`;
  // Layout:
  //   agent-orch vX.Y.Z
  //
  //   <blurb>
  //
  //   npm i -g @bbk1ng/agent-orch
  //   <release url>
  const withBlurb = (b) => (b
    ? `${header}\n\n${b}\n\n${footer}`
    : `${header}\n\n${footer}`);

  let text = withBlurb(blurb);
  if (tweetWeight(text) <= MAX_TWEET) return text;

  // Prefer install + release URL; binary-search a blurb prefix that fits.
  if (blurb) {
    const chars = [...blurb];
    let lo = 0;
    let hi = chars.length;
    let best = "";
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const candidate = mid < chars.length
        ? chars.slice(0, mid).join("").replace(/\s+$/, "") + "…"
        : blurb;
      const trial = withBlurb(candidate);
      if (tweetWeight(trial) <= MAX_TWEET) {
        best = candidate;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (best) return withBlurb(best);
  }
  return truncateToWeight(withBlurb(""), MAX_TWEET);
}

export function buildTweetFromRepo({ tag, root = ROOT, repository }) {
  const { version } = parseTag(tag);
  const repo = repository || process.env.GITHUB_REPOSITORY || "bbk1ng/agent-orch";
  const releaseUrl = `https://github.com/${repo}/releases/tag/v${version}`;
  let blurb = "";
  const changelogPath = join(root, "CHANGELOG.md");
  if (existsSync(changelogPath)) {
    const section = extractChangelogSection(readFileSync(changelogPath, "utf8"), version);
    blurb = pickBlurb(section);
  }
  return composeTweet({ version, blurb, releaseUrl });
}

function percentEncode(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function oauthHeader(method, url, consumerKey, consumerSecret, token, tokenSecret) {
  const oauth = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: token,
    oauth_version: "1.0",
  };
  // For application/json bodies, only oauth_* params enter the signature base.
  const paramString = Object.keys(oauth)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(oauth[k])}`)
    .join("&");
  const base = [method.toUpperCase(), percentEncode(url), percentEncode(paramString)].join("&");
  const signingKey = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  oauth.oauth_signature = crypto.createHmac("sha1", signingKey).update(base).digest("base64");
  const header = "OAuth " + Object.keys(oauth)
    .sort()
    .map((k) => `${percentEncode(k)}="${percentEncode(oauth[k])}"`)
    .join(", ");
  return header;
}

export async function postTweet(text, creds, { fetchImpl = globalThis.fetch } = {}) {
  const { apiKey, apiSecret, accessToken, accessTokenSecret } = creds;
  for (const [name, val] of [
    ["X_API_KEY", apiKey],
    ["X_API_SECRET", apiSecret],
    ["X_ACCESS_TOKEN", accessToken],
    ["X_ACCESS_TOKEN_SECRET", accessTokenSecret],
  ]) {
    if (!val) throw new Error(`missing ${name}`);
  }
  const auth = oauthHeader("POST", TWEET_URL, apiKey, apiSecret, accessToken, accessTokenSecret);
  const res = await fetchImpl(TWEET_URL, {
    method: "POST",
    headers: {
      Authorization: auth,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text }),
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`X API ${res.status}: ${body}`);
  }
  let parsed;
  try { parsed = JSON.parse(body); } catch { parsed = { raw: body }; }
  return parsed;
}

export function readCredsFromEnv(env = process.env) {
  return {
    apiKey: env.X_API_KEY || "",
    apiSecret: env.X_API_SECRET || "",
    accessToken: env.X_ACCESS_TOKEN || "",
    accessTokenSecret: env.X_ACCESS_TOKEN_SECRET || "",
  };
}

export function credsPresent(creds) {
  return Boolean(creds.apiKey && creds.apiSecret && creds.accessToken && creds.accessTokenSecret);
}

async function main(argv = process.argv.slice(2)) {
  const tag = argv[0] || process.env.TAG_REF;
  if (!tag) {
    console.error("usage: node src/announce-release.js vX.Y.Z");
    process.exit(2);
  }
  const text = buildTweetFromRepo({ tag, root: ROOT });
  console.log("--- tweet ---");
  console.log(text);
  console.log("-------------");
  console.log(`weight≈${tweetWeight(text)} / ${MAX_TWEET}`);

  if (process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true") {
    console.log("DRY_RUN set; not posting");
    return;
  }

  const creds = readCredsFromEnv();
  if (!credsPresent(creds)) {
    console.log("X secrets not configured; skipping announce");
    return;
  }

  const result = await postTweet(text, creds);
  const id = result?.data?.id;
  if (id) {
    console.log(`posted: https://x.com/i/web/status/${id}`);
  } else {
    console.log("posted:", JSON.stringify(result));
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error(err?.stack || err);
    process.exit(1);
  });
}
