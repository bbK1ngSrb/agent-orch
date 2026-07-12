import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseTag,
  extractChangelogSection,
  pickBlurb,
  tweetWeight,
  truncateToWeight,
  composeTweet,
  buildTweetFromRepo,
  postTweet,
  credsPresent,
} from "../src/announce-release.js";

test("parseTag accepts v-prefixed and bare semver", () => {
  assert.deepEqual(parseTag("v1.2.3"), { tag: "v1.2.3", version: "1.2.3" });
  assert.deepEqual(parseTag("1.2.3"), { tag: "v1.2.3", version: "1.2.3" });
  assert.throws(() => parseTag("v1.2"), /invalid tag/);
});

test("extractChangelogSection returns body until next heading", () => {
  const md = `# Changelog

## 0.4.1 — 2026-07-12
- fix: sync version.js (closes #308)

## 0.4.0 — 2026-07-12
- big release
`;
  assert.match(extractChangelogSection(md, "0.4.1"), /sync version\.js/);
  assert.equal(extractChangelogSection(md, "0.4.1").includes("0.4.0"), false);
  assert.equal(extractChangelogSection(md, "9.9.9"), "");
});

test("pickBlurb prefers first bullet and strips markdown links", () => {
  const section = `
Some intro paragraph.

- fix: sync \`src/version.js\` with package.json ([#308](https://github.com/bbk1ng/agent-orch/issues/308))
- other
`;
  assert.equal(
    pickBlurb(section),
    "fix: sync `src/version.js` with package.json (#308)",
  );
});

test("composeTweet stays under 280 and includes install + release url", () => {
  const text = composeTweet({
    version: "0.4.1",
    blurb: "fix: orch --version matches npm package",
    releaseUrl: "https://github.com/bbk1ng/agent-orch/releases/tag/v0.4.1",
  });
  assert.match(text, /^agent-orch v0\.4\.1\n/);
  assert.match(text, /npm i -g @bbk1ng\/agent-orch/);
  assert.match(text, /releases\/tag\/v0\.4\.1/);
  assert.ok(tweetWeight(text) <= 280, text);
});

test("composeTweet truncates a very long blurb instead of overflowing", () => {
  const blurb = "x".repeat(500);
  const text = composeTweet({
    version: "1.0.0",
    blurb,
    releaseUrl: "https://github.com/bbk1ng/agent-orch/releases/tag/v1.0.0",
  });
  assert.ok(tweetWeight(text) <= 280);
  assert.match(text, /npm i -g/);
  assert.match(text, /…/);
});

test("tweetWeight counts URLs as 23 chars", () => {
  const url = "https://github.com/bbk1ng/agent-orch/releases/tag/v0.4.1";
  assert.equal(tweetWeight(url), 23);
  assert.equal(tweetWeight(`hi ${url}`), 3 + 23);
});

test("truncateToWeight appends ellipsis within budget", () => {
  const out = truncateToWeight("abcdefghij", 6);
  assert.ok(tweetWeight(out) <= 6);
  assert.match(out, /…$/);
});

test("buildTweetFromRepo reads CHANGELOG from a fixture tree", () => {
  const dir = mkdtempSync(join(tmpdir(), "announce-"));
  writeFileSync(
    join(dir, "CHANGELOG.md"),
    `# Changelog\n\n## 0.4.1 — 2026-07-12\n- fix: sync version.js\n`,
  );
  const text = buildTweetFromRepo({
    tag: "v0.4.1",
    root: dir,
    repository: "bbk1ng/agent-orch",
  });
  assert.match(text, /agent-orch v0\.4\.1/);
  assert.match(text, /sync version\.js/);
});

test("postTweet sends OAuth header and JSON body", async () => {
  let seen;
  const fetchImpl = async (url, opts) => {
    seen = { url, opts };
    return {
      ok: true,
      status: 201,
      text: async () => JSON.stringify({ data: { id: "123", text: "hi" } }),
    };
  };
  const result = await postTweet("hello world", {
    apiKey: "k",
    apiSecret: "s",
    accessToken: "t",
    accessTokenSecret: "ts",
  }, { fetchImpl });
  assert.equal(seen.url, "https://api.x.com/2/tweets");
  assert.equal(seen.opts.method, "POST");
  assert.match(seen.opts.headers.Authorization, /^OAuth /);
  assert.match(seen.opts.headers.Authorization, /oauth_signature=/);
  assert.equal(seen.opts.body, JSON.stringify({ text: "hello world" }));
  assert.equal(result.data.id, "123");
});

test("postTweet surfaces API errors", async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 403,
    text: async () => '{"detail":"forbidden"}',
  });
  await assert.rejects(
    () => postTweet("x", {
      apiKey: "k", apiSecret: "s", accessToken: "t", accessTokenSecret: "ts",
    }, { fetchImpl }),
    /X API 403/,
  );
});

test("credsPresent requires all four secrets", () => {
  assert.equal(credsPresent({
    apiKey: "a", apiSecret: "b", accessToken: "c", accessTokenSecret: "d",
  }), true);
  assert.equal(credsPresent({
    apiKey: "a", apiSecret: "b", accessToken: "c", accessTokenSecret: "",
  }), false);
});
