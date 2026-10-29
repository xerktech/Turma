// XERK-2399: the sign-in page's post-login redirect (login.html's inline
// safeNext) must never leave the hub's origin. The page's script is inline, so
// the function is lifted out of the HTML and run against a stub `location`.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function loadSafeNext(origin) {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "login.html"), "utf8");
  const src = html.match(/function safeNext\(next\) \{[\s\S]*?\n  \}\n/);
  assert.ok(src, "login.html defines safeNext");
  return new Function("location", `${src[0]}; return safeNext;`)({ origin });
}

test("XERK-2399: login's next stays on the hub", () => {
  const safeNext = loadSafeNext("https://hub.example");
  assert.equal(safeNext("/board"), "/board");
  assert.equal(safeNext("/term/s1/?a=1#b"), "/term/s1/?a=1#b");
  for (const bad of ["//evil.example/", "/\\evil.example/", "/\t/evil.example/",
                     "/\n/evil.example", "https://evil.example/", "javascript:alert(1)",
                     "", null, undefined]) {
    assert.equal(safeNext(bad), "/", JSON.stringify(bad));
  }
});

test("XERK-2399: login.html redirects through safeNext", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "login.html"), "utf8");
  assert.match(html, /location\.replace\(safeNext\(/);
  assert.doesNotMatch(html, /next\.startsWith\("\/"\) \? next/);
});
