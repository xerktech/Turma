// XERK-2399: the sign-in page's post-login redirect (login.html's inline
// safeNext) must never leave the hub's origin. The page's script is inline, so
// the function is lifted out of the HTML and run against a stub `location`.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function loadSafeNext(origin, hash = "") {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "login.html"), "utf8");
  const src = html.match(/function safeNext\(next\) \{[\s\S]*?\n  \}\n/);
  assert.ok(src, "login.html defines safeNext");
  return new Function("location", `${src[0]}; return safeNext;`)({ origin, hash });
}

test("XERK-2399: login's next stays on the hub", () => {
  const safeNext = loadSafeNext("https://hub.example");
  assert.equal(safeNext("/board"), "/board");
  assert.equal(safeNext("/term/s1/?a=1#b"), "/term/s1/?a=1#b");
  for (const bad of ["//evil.example/", "/\\evil.example/", "/\t/evil.example/",
                     "/\n/evil.example", "https://evil.example/", "javascript:alert(1)",
                     "/.//evil.example/p", "/x/..//evil.example/p", "/%2e//evil.example/p",
                     "/..//evil.example/p", "/./\\evil.example/p", "/\t.//evil.example/p",
                     "", null, undefined]) {
    assert.equal(safeNext(bad), "/", JSON.stringify(bad));
  }
});

test("XERK-2399: login.html redirects through safeNext", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "login.html"), "utf8");
  assert.match(html, /location\.replace\(safeNext\(/);
  assert.doesNotMatch(html, /next\.startsWith\("\/"\) \? next/);
});

test("XERK-2399: a fragment the redirect dropped is handed on", () => {
  const safeNext = loadSafeNext("https://hub.example", "#h");
  assert.equal(safeNext("/term/s1/?q=1"), "/term/s1/?q=1#h");
  assert.equal(safeNext("/board#own"), "/board#own", "next's own fragment wins");
  assert.equal(safeNext("//evil.example/"), "/", "never carried onto a refusal");
});

// XERK-2576: a non-401 /api/login refusal shows the hub's own words + its wait.
function loadRefusalMessage() {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "login.html"), "utf8");
  const src = html.match(/function refusalMessage\(status, body, retryAfter\) \{[\s\S]*?\n  \}\n/);
  assert.ok(src, "login.html defines refusalMessage");
  return new Function(`${src[0]}; return refusalMessage;`)();
}

test("XERK-2576: a sign-in refusal reads in the hub's words with the Retry-After wait", () => {
  const msg = loadRefusalMessage();
  assert.equal(msg(503, { error: "too many sign-ins in progress — try again in a moment" }, "1"),
    "too many sign-ins in progress — try again in a moment (retry in 1s)");
  assert.equal(msg(429, { error: "too many failed sign-ins — try again later" }, "300"),
    "too many failed sign-ins — try again later (retry in 5 min)");
  assert.equal(msg(429, { error: "slow down" }, "61"), "slow down (retry in 2 min)");
  // No / unparseable / zero Retry-After: the hub's words alone.
  assert.equal(msg(429, { error: "slow down" }, null), "slow down");
  assert.equal(msg(429, { error: "slow down" }, "Wed, 21 Oct 2026 07:28:00 GMT"), "slow down");
  assert.equal(msg(429, { error: "slow down" }, "0"), "slow down");
  // No usable {error}: the bare status, never a blank box.
  assert.equal(msg(502, null, "5"), "Sign-in failed (HTTP 502). Please try again.");
  assert.equal(msg(500, { error: "   " }, null), "Sign-in failed (HTTP 500). Please try again.");
  assert.equal(msg(500, { error: 7 }, null), "Sign-in failed (HTTP 500). Please try again.");
});

test("XERK-2576: login.html routes non-401 refusals through refusalMessage", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "login.html"), "utf8");
  assert.match(html, /refusalMessage\(res\.status, body, res\.headers\.get\("Retry-After"\)\)/);
  assert.doesNotMatch(html, /"Sign-in failed\. Please try again\."/);
});
