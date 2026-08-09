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

// Every inline event handler, in BOTH quoting styles — a single-quoted
// `onclick='…'` decodes entities exactly the same way.
function inlineHandlers(src) {
  return [...src.matchAll(/on[a-z]+="[^"]*"/g), ...src.matchAll(/on[a-z]+='[^']*'/g)]
    .map((m) => m[0]);
}

// Names whose value derives from esc() — directly, or through any chain of
// assignments that interpolates such a name. A bare `esc(` anywhere in an
// initializer taints it, whatever else sits beside it.
function escDerived(src) {
  const BARE_ESC = /(?<![A-Za-z0-9_])esc\(/;
  // The initializer must stop at the NEXT declarator, not run to end of line.
  // A greedy `[^\n]*` swallowed the rest of the line and `matchAll` resumed
  // past it, so only the FIRST `name =` on any line was ever recorded — and
  // `const id = esc(s.id), idJs = escJs(s.id), key = escJs(a.key);` ships
  // today, so changing its THIRD declarator reintroduced the host-key XSS with
  // this guard green. `=(?![=>])` keeps arrow params and comparisons out.
  const assigns = [...src.matchAll(
    /(?:^|[\s(,;{])([A-Za-z_$][\w$]*)\s*=(?![=>])\s*((?:(?!,\s*[A-Za-z_$][\w$]*\s*=(?![=>]))[^\n])*)/g,
  )].map((m) => [m[1], m[2]]);
  const tainted = new Set(assigns.filter(([, init]) => BARE_ESC.test(init)).map(([n]) => n));
  for (let grew = true; grew; ) {
    grew = false;
    for (const [name, init] of assigns) {
      if (tainted.has(name)) continue;
      // Interpolation, and direct aliasing (`const key = hk`) — the two ways
      // the escaped value actually travels. Deliberately NOT every reference:
      // that tainted `escJs(a.key)` through the unrelated `key` in `a.key`.
      const alias = init.match(/^\s*([A-Za-z_$][\w$]*)\s*(?:[,;]|$)/);
      if (alias && tainted.has(alias[1])) { tainted.add(name); grew = true; continue; }
      for (const r of init.matchAll(/\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g)) {
        if (tainted.has(r[1])) { tainted.add(name); grew = true; break; }
      }
    }
  }
  return tainted;
}

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

  // The check above only ever saw a DIRECT `esc(` inside the attribute — and
  // every site that actually shipped the XSS reached the handler through a
  // local variable (`const key = esc(a.key)`, then `onclick="…('${key}')"`).
  // 20 vulnerable handlers passed it (XERK-235).
  //
  // Two later escapes shaped this: a declaration MIXING both escapers
  // (`const key = esc(a.key), rn = escJs(…)`) was whitewashed by a lookahead
  // that only asked whether `escJs(` appeared later on the line; and the
  // composer's real architecture never interpolates the escaped variable
  // directly — it builds `submit` from it and interpolates THAT. So: a bare
  // `esc(` anywhere in an initializer taints it whatever else is beside it, and
  // taint propagates through interpolation to a fixpoint.
  test(`${page}: no inline handler interpolates esc()-derived text`, () => {
    const html = fs.readFileSync(path.join(__dirname, "..", "public", page), "utf8");
    const bad = [];
    for (const h of inlineHandlers(html)) {
      for (const ref of h.matchAll(/\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g)) {
        if (escDerived(html).has(ref[1])) bad.push(`${ref[1]} in ${h.slice(0, 100)}`);
      }
    }
    assert.deepEqual(bad, [],
      "a handler interpolated esc()-derived text — it needs escJs, however many " +
      "assignments away the escaping happened");
  });

  // Guards the guard. Each case below is a real shape that escaped a previous
  // version of this detector, one of them proven live-exploitable with the
  // suite green.
  test(`${page}: the detector catches every shape that escaped it`, () => {
    const H = (body) => `function f(a, repo, s) {\n${body}\n}`;
    const shipped = H("  const key = esc(a.key), rn = esc(repo.name);\n" +
                      "  return `<button onclick=\"go('${key}','${rn}')\">x</button>`;");
    const mixedFirst = H("  const key = esc(a.key), rn = escJs(repo.name);\n" +
                         "  return `<button onclick=\"go('${key}')\">x</button>`;");
    const mixedTemplate = H("  const done = `r('${escJs(a.key)}','${esc(s.id)}')`;\n" +
                            "  return `<button onclick=\"${done}\">x</button>`;");
    const twoHop = H("  const hk = esc(a.key);\n" +
                     "  const submit = `startSession('${hk}')`;\n" +
                     "  return `<button onclick=\"${submit}\">x</button>`;");
    for (const [name, src] of Object.entries(
      { shipped, mixedFirst, mixedTemplate, twoHop })) {
      const t = escDerived(src);
      const hit = inlineHandlers(src).some((h) =>
        [...h.matchAll(/\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g)].some((m) => t.has(m[1])));
      assert.ok(hit, `the detector must flag the ${name} shape`);
    }
    // ...and must NOT flag a text-context esc() variable that no handler uses.
    const textOnly = H("  const id = esc(s.id), idJs = escJs(s.id);\n" +
                       "  return `<span>${id}</span><button onclick=\"go('${idJs}')\">x</button>`;");
    const t = escDerived(textOnly);
    assert.ok(t.has("id"), "an esc()-bound name is still derived");
    assert.ok(!t.has("idJs"), "an escJs-only binding must stay clean");
    const flagged = inlineHandlers(textOnly).some((h) =>
      [...h.matchAll(/\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g)].some((m) => t.has(m[1])));
    assert.ok(!flagged, "a text-only esc() variable must not fail the gate");
  });
}
