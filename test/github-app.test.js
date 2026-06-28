import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { appJwt, installationToken, appCredsFromEnv, parseRepoSlug } from "../src/github-app.js";

// One RSA keypair for the whole suite — keygen is the slow part.
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs1", format: "pem" });

test("appJwt: three base64url segments, verifiable RS256 signature", () => {
  const now = 1_700_000_000;
  const jwt = appJwt("12345", pem, now);
  const [h, p, sig] = jwt.split(".");
  assert.equal(jwt.split(".").length, 3);

  const ok = crypto.verify("RSA-SHA256", Buffer.from(`${h}.${p}`),
    publicKey, Buffer.from(sig, "base64url"));
  assert.ok(ok, "signature must verify against the public key");

  const header = JSON.parse(Buffer.from(h, "base64url"));
  const payload = JSON.parse(Buffer.from(p, "base64url"));
  assert.deepEqual(header, { alg: "RS256", typ: "JWT" });
  assert.equal(payload.iss, "12345");
  assert.equal(payload.iat, now - 30, "iat back-dated for clock skew");
  assert.ok(payload.exp - payload.iat <= 600, "exp within GitHub's 10-min cap");
});

test("appJwt: throws without creds", () => {
  assert.throws(() => appJwt("", pem), /appId and privateKeyPem required/);
  assert.throws(() => appJwt("1", ""), /appId and privateKeyPem required/);
});

test("installationToken: looks up installation then mints scoped token", async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push(`${opts.method} ${url}`);
    assert.match(opts.headers.Authorization, /^Bearer /);
    if (url.endsWith("/repos/acme/widget/installation"))
      return { ok: true, json: async () => ({ id: 999 }) };
    if (url.endsWith("/app/installations/999/access_tokens"))
      return { ok: true, json: async () => ({ token: "ghs_secret" }) };
    throw new Error(`unexpected url ${url}`);
  };
  const tok = await installationToken({ appId: "1", privateKey: pem, owner: "acme", repo: "widget", fetchImpl, now: 1 });
  assert.equal(tok, "ghs_secret");
  assert.deepEqual(calls, [
    "GET https://api.github.com/repos/acme/widget/installation",
    "POST https://api.github.com/app/installations/999/access_tokens",
  ]);
});

test("installationToken: surfaces HTTP failures (caller falls back)", async () => {
  const fetchImpl = async () => ({ ok: false, status: 404, text: async () => "Not Found" });
  await assert.rejects(
    installationToken({ appId: "1", privateKey: pem, owner: "a", repo: "b", fetchImpl, now: 1 }),
    /→ 404 Not Found/);
});

test("appCredsFromEnv: null when unconfigured, inline PEM passthrough", () => {
  assert.equal(appCredsFromEnv({}), null);
  assert.equal(appCredsFromEnv({ ORCH_APP_ID: "1" }), null);
  const creds = appCredsFromEnv({ ORCH_APP_ID: "1", ORCH_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\nx" });
  assert.equal(creds.appId, "1");
  assert.match(creds.privateKey, /BEGIN RSA PRIVATE KEY/);
});

test("parseRepoSlug: ssh and https forms", () => {
  assert.deepEqual(parseRepoSlug("git@github.com:bbK1ngSrb/agent-orch.git"), { owner: "bbK1ngSrb", repo: "agent-orch" });
  assert.deepEqual(parseRepoSlug("https://github.com/bbK1ngSrb/agent-orch"), { owner: "bbK1ngSrb", repo: "agent-orch" });
  assert.deepEqual(parseRepoSlug("https://github.com/bbK1ngSrb/agent-orch.git\n"), { owner: "bbK1ngSrb", repo: "agent-orch" });
  assert.throws(() => parseRepoSlug("https://gitlab.com/x/y.git"), /cannot parse/);
});
