// Static-asset cacheability: fingerprinted URLs and conditional GETs (XERK-312).
//
// The shared stylesheet and scripts change with every deploy, and under a flat
// `max-age=300` a warm browser served the NEW html against the OLD app.css for
// up to five minutes — every page rendering unstyled for that window, after
// every deploy. The fix is that the pages link a content-hashed URL, so a new
// body is a new URL; these tests hold that end to end over the wire.
//
// Its own process because it asserts on the module's asset map as built at
// require time, and node:test with no npm, like the rest of the suite.

"use strict";

const os = require("os");
const fs = require("fs");
const path = require("path");
const http = require("http");
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.TURMA_TEST = "1";
process.env.TURMA_USER = "hubuser";
process.env.TURMA_PASSWORD = "hubpass";
process.env.TURMA_AGENT_TOKEN = "agenttok";

const tmp = (name) => path.join(os.tmpdir(), `turma-assets-${name}-${process.pid}.json`);
process.env.STATE_FILE = tmp("state");
process.env.DEVICES_FILE = tmp("devices");
process.env.TICKET_AGENTS_FILE = tmp("ticket-agents");
process.env.AUTOSTART_ORGS_FILE = tmp("autostart-orgs");
process.env.TICKET_MODELS_FILE = tmp("ticket-models");
process.env.ORG_COLORS_FILE = tmp("org-colors");
process.env.MIGRATE_SPOOL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "turma-assets-migrations-"));
process.env.ARCHIVE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "turma-assets-archive-"));
process.env.ARCHIVE_DB = path.join(process.env.ARCHIVE_DIR, "index.db");

const hub = require("../server.js");
const { STATIC_ASSETS, ASSET_URLS, IMMUTABLE_CACHE, REVALIDATE_CACHE, HTML_CACHE } = hub;

const PUBLIC = path.join(__dirname, "..", "public");
const PAGES = ["/", "/usage", "/sessions", "/board", "/login"];
const basic = (u, p) => "Basic " + Buffer.from(`${u}:${p}`).toString("base64");
const userHeaders = { authorization: basic("hubuser", "hubpass") };

let baseUrl;
test.before(async () => {
  await new Promise((r) => hub.server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${hub.server.address().port}`;
});
test.after(() => hub.server.close());

function request(pathName, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(baseUrl + pathName, { method: "GET", headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, raw: data, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

// ---- the map itself ---------------------------------------------------------

test("assets: every mutable asset has a fingerprinted twin served immutable", () => {
  // The set is the one the pages share. A new shared /*.js added to the pages
  // but not here is served under its bare name only, i.e. back to a TTL.
  assert.deepEqual(
    Object.keys(ASSET_URLS).sort(),
    ["/app.css", "/board.js", "/chat.js", "/nav.js", "/newticket.js", "/org.js"],
  );
  for (const [bare, hashed] of Object.entries(ASSET_URLS)) {
    assert.notEqual(hashed, bare, `${bare} was not fingerprinted`);
    // <name>.<12 hex>.<ext> — the hash sits before the extension so the type is
    // still readable off the URL and Content-Type still follows the map.
    assert.match(hashed, /^\/[\w-]+\.[0-9a-f]{12}\.(css|js)$/);
    assert.equal(STATIC_ASSETS[hashed].cache, IMMUTABLE_CACHE);
    assert.equal(STATIC_ASSETS[hashed].body.toString(), STATIC_ASSETS[bare].body.toString());
  }
});

test("assets: the fingerprint is of the CONTENT, so an edit moves the URL", () => {
  // The whole mechanism: same bytes -> same URL (caches keep working across a
  // deploy that didn't touch the file), different bytes -> different URL.
  const css = fs.readFileSync(path.join(PUBLIC, "app.css"));
  const crypto = require("crypto");
  const hash = (b) => crypto.createHash("sha256").update(b).digest("hex").slice(0, 12);
  assert.equal(ASSET_URLS["/app.css"], `/app.${hash(css)}.css`);
  assert.notEqual(hash(Buffer.concat([css, Buffer.from("\n.x{}\n")])), hash(css));
});

test("assets: the bare name keeps being served, revalidating rather than TTL'd", () => {
  // A browser holding a PRE-deploy page still links /app.css. Dropping the bare
  // name 404s that page's styling — the exact failure this ticket is about —
  // and a TTL on it re-opens the stale window.
  for (const bare of Object.keys(ASSET_URLS)) {
    assert.equal(STATIC_ASSETS[bare].cache, REVALIDATE_CACHE);
    assert.doesNotMatch(STATIC_ASSETS[bare].cache, /max-age=[1-9]/, `${bare} still carries a TTL`);
  }
});

// ---- the pages --------------------------------------------------------------

test("assets: every page links the fingerprinted URLs, never the bare ones", async () => {
  for (const page of PAGES) {
    // The login page redirects an authenticated visitor straight in, so it is
    // the one page fetched WITHOUT the cookie/credentials.
    const res = await request(page, page === "/login" ? {} : userHeaders);
    assert.equal(res.status, 200, page);
    for (const bare of Object.keys(ASSET_URLS)) {
      assert.ok(
        !res.raw.includes(`="${bare}"`),
        `${page} still links the un-fingerprinted ${bare}`,
      );
    }
    // Not every page loads every script (chat.js is the Sessions page's), but
    // all five share the stylesheet, so its hashed link must be on every one.
    assert.ok(res.raw.includes(`="${ASSET_URLS["/app.css"]}"`), `${page} lost its stylesheet`);
  }
});

test("assets: a page's prose naming a file is left alone by the rewrite", async () => {
  // The pages' comments talk about app.css and nav.js constantly. Rewriting
  // those would be harmless noise here but corrupts anything quoting a path.
  const res = await request("/sessions", userHeaders);
  assert.ok(res.raw.includes("app.css"), "sanity: the page mentions the file in prose");
  assert.ok(!/[\w-]+\.[0-9a-f]{12}\.(css|js)[^"']/.test(res.raw.replace(/="[^"]*"/g, "")),
    "a fingerprinted name leaked outside an attribute");
});

test("assets: the shells revalidate and answer a conditional GET with 304", async () => {
  for (const page of ["/", "/usage", "/sessions", "/board"]) {
    const first = await request(page, userHeaders);
    assert.equal(first.headers["cache-control"], HTML_CACHE, page);
    assert.ok(first.headers.etag, `${page} sent no ETag`);
    const again = await request(page, { ...userHeaders, "if-none-match": first.headers.etag });
    assert.equal(again.status, 304, `${page} re-sent a body it already holds`);
    assert.equal(again.raw, "");
    assert.equal(again.headers.etag, first.headers.etag);
  }
});

test("assets: a fingerprinted URL is immutable; the bare one revalidates", async () => {
  const hashed = await request(ASSET_URLS["/app.css"]);
  assert.equal(hashed.status, 200);
  assert.equal(hashed.headers["cache-control"], IMMUTABLE_CACHE);
  assert.equal(hashed.headers["content-type"], "text/css; charset=utf-8");

  const bare = await request("/app.css");
  assert.equal(bare.status, 200);
  assert.equal(bare.headers["cache-control"], REVALIDATE_CACHE);
  assert.equal(bare.raw, hashed.raw, "the two URLs must serve the same bytes");

  // Both are unauthenticated: the login page renders before any cookie exists.
  assert.equal((await request(ASSET_URLS["/nav.js"])).status, 200);
});

test("assets: a conditional GET for an asset is a 304, weak or listed", async () => {
  const first = await request("/app.css");
  const tag = first.headers.etag;
  assert.ok(tag, "no ETag, so every revalidation re-sends the whole stylesheet");
  for (const header of [tag, `W/${tag}`, `"other", ${tag}`, "*"]) {
    const res = await request("/app.css", { "if-none-match": header });
    assert.equal(res.status, 304, `If-None-Match: ${header}`);
    assert.equal(res.raw, "");
  }
  const stale = await request("/app.css", { "if-none-match": '"deadbeefcafe"' });
  assert.equal(stale.status, 200, "a cache holding the PREVIOUS body must get the new one");
  assert.ok(stale.raw.length > 0);
});

test("assets: icons and fonts still cache hard under their stable names", () => {
  for (const p of ["/favicon.svg", "/icon-512.png", "/fonts/inter-latin-wght-normal.woff2"]) {
    assert.equal(STATIC_ASSETS[p].cache, IMMUTABLE_CACHE, p);
    assert.ok(STATIC_ASSETS[p].etag, `${p} lost its ETag`);
  }
});

// ---- a fingerprint from a PREVIOUS release ----------------------------------

test("assets: a superseded fingerprint serves the current body, never a 404", async () => {
  // The one way fingerprinting can be WORSE than the TTL it replaces: a page a
  // cache handed back from before the deploy links last release's hashed URL.
  // A 404 there is a fully unstyled page — the exact failure being fixed.
  const stale = await request("/app.000000000000.css");
  assert.equal(stale.status, 200);
  assert.equal(stale.headers["cache-control"], REVALIDATE_CACHE, "a guessed URL must not cache hard");
  assert.equal(stale.raw, (await request(ASSET_URLS["/app.css"])).raw);
  assert.equal((await request("/nav.abcdef123456.js")).status, 200);
});

test("assets: the fallback widens the allowlist by nothing", async () => {
  // It reconstructs a BARE name and looks it up in the same map; anything else
  // must still miss. (404 for a GET no route claims, or the login redirect for
  // a path the authenticated routes below do — either way, not an asset.)
  for (const p of [
    "/secret.000000000000.js",          // not an allowlisted base name
    "/app.000000000000.txt",            // not an allowlisted type
    "/app.zzzzzzzzzzzz.css",            // not a hash
    "/app.0000.css",                    // wrong length
    "/sub/app.000000000000.css",        // not at the root
  ]) {
    const res = await request(p);
    assert.notEqual(res.status, 200, `${p} was served as an asset`);
  }
  assert.equal(hub.supersededAsset(ASSET_URLS["/app.css"]), null, "the current URL is not superseded");
  assert.equal(hub.supersededAsset("/constructor.000000000000.js"), null);
});
