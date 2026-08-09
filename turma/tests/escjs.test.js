// Regression tests for escJs — the escaper the pages must use for a value that
// lands inside an inline `on*="..."` handler (XERK-235).
//
// A full QA pass proved a ZERO-CLICK stored XSS here: esc() turns `'` into
// `&#39;`, but the HTML parser decodes entities in an attribute value BEFORE
// the handler source is compiled, so the quote comes back and the JS string
// closes. An agent-supplied repo directory name (raw os.listdir output, never
// validated) containing `');...//` ran attacker JS in the operator's
// authenticated browser on page load, with the session cookie for the whole
// hub API.
//
// These tests do what a browser does — HTML-decode the attribute, then compile
// it as JS — so they fail if escJs ever regresses to entity escaping.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const PAGES = ["index.html", "sessions.html"];

function loadEscapers(page) {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", page), "utf8");
  const escJs = html.match(/function escJs\(s\) \{[\s\S]*?\n\}/);
  const esc = html.match(/function esc\(s\) \{[\s\S]*?\n\}/);
  assert.ok(escJs, `${page} must define escJs`);
  assert.ok(esc, `${page} must define esc`);
  return {
    escJs: new Function(`${escJs[0]}; return escJs;`)(),
    esc: new Function(`${esc[0]}; return esc;`)(),
  };
}

// What a browser does to an attribute value before compiling the handler.
function htmlDecode(s) {
  return s
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

// Emit the handler the way the pages do, decode it the way a browser does, run
// it, and report what the handler received and whether anything else executed.
function runHandler(escaped) {
  const js = htmlDecode(`repoToggle('${escaped}', true)`);
  const seen = [];
  const repoToggle = (v) => seen.push(v);
  const boom = () => seen.push("EXECUTED");
  // eslint-disable-next-line no-new-func
  new Function("repoToggle", "alert", "__x", js)(repoToggle, boom, { push: boom });
  return seen;
}

const PAYLOADS = [
  "x');window.__x.push('pwned');//",  // the exact zero-click payload
  "x'),alert(1),('",
  "x'); alert(1);//",
  "x\\');alert(1);//",                // escaped-quote variant
  '"><img src=x onerror=alert(1)>',
  "</script><script>alert(1)</script>",
  "repo's-name",                      // an ordinary apostrophe must still work
  "plain-repo",
  "ünïcödé-repo",
];

for (const page of PAGES) {
  test(`${page}: escJs blocks handler-attribute injection and passes the value through`, () => {
    const { escJs } = loadEscapers(page);
    for (const payload of PAYLOADS) {
      const seen = runHandler(escJs(payload));
      assert.deepEqual(
        seen, [payload],
        `escJs(${JSON.stringify(payload)}) must reach the handler intact and run nothing else`,
      );
    }
  });

  test(`${page}: escJs leaves nothing that can close the attribute or the string`, () => {
    const { escJs } = loadEscapers(page);
    for (const payload of PAYLOADS) {
      const out = escJs(payload);
      // After escaping, the only quotes/angles/ampersands left must be inside a
      // backslash escape — i.e. there are none of these raw characters at all.
      assert.equal(/['"<>&]/.test(out), false,
        `escJs(${JSON.stringify(payload)}) still contains a raw delimiter: ${out}`);
    }
  });

  test(`${page}: esc() alone is NOT safe here — the defect this replaced`, () => {
    // Proves the tests above are actually testing something: the old escaper
    // lets the payload run once the browser decodes the entity.
    const { esc } = loadEscapers(page);
    const seen = runHandler(esc("x'),alert(1),('"));
    assert.ok(seen.includes("EXECUTED"),
      "esc() should still demonstrate the injection — if not, this test is no longer meaningful");
  });

  test(`${page}: no inline handler interpolates esc() any more`, () => {
    const html = fs.readFileSync(path.join(__dirname, "..", "public", page), "utf8");
    const bad = [];
    for (const m of html.matchAll(/on[a-z]+="[^"]*"/g)) {
      if (/(?<![A-Za-z0-9_])esc\(/.test(m[0])) bad.push(m[0].slice(0, 120));
    }
    assert.deepEqual(bad, [],
      "an on*= handler must use escJs; esc() is entity escaping and does not survive attribute decoding");
  });
}
