// Unit tests for the shared site chrome (public/nav.js): the header and phone
// bottom-nav that every page mounts. The point of the module is that all four
// pages get the SAME header, so these tests assert the invariants that drift
// broke last time — one tab list, one active tab, identical slots everywhere —
// rather than the exact markup. node:test, no npm, same pattern as board.test.js.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { PAGES, siteHeaderHtml, bottomNavHtml, tabsHtml, mount } = require("../public/nav.js");

const PUBLIC = path.join(__dirname, "..", "public");
const PAGE_FILES = ["index.html", "sessions.html", "board.html", "usage.html"];

test("nav: every page's tab is in the list, once", () => {
  const ids = PAGES.map(p => p.id);
  assert.deepEqual(ids, ["dashboard", "sessions", "board", "usage"]);
  assert.equal(new Set(ids).size, ids.length);
});

test("nav: exactly one tab is marked active, and only the named one", () => {
  for (const p of PAGES) {
    const html = tabsHtml(p.id);
    assert.equal((html.match(/class="active"/g) || []).length, 1);
    assert.match(html, new RegExp(`<a href="${p.href.replace("/", "\\/")}" class="active">`));
  }
  // An unknown/absent page (e.g. a page that forgot data-page) simply lights
  // nothing up rather than throwing or defaulting to Dashboard.
  assert.equal((tabsHtml("").match(/class="active"/g) || []).length, 0);
});

test("nav: the header is identical across pages apart from the active tab and the sub slot", () => {
  const norm = h => h.replace(/ class="active"/g, "").replace(/<span class="sub" id="hdrSub">[^<]*</, "<span class=\"sub\" id=\"hdrSub\"><");
  const rendered = PAGES.map(p => norm(siteHeaderHtml(p.id, "whatever " + p.id)));
  for (const html of rendered) assert.equal(html, rendered[0]);
});

test("nav: the header carries all three slots on every page, empty by default", () => {
  for (const p of PAGES) {
    const html = siteHeaderHtml(p.id, "");
    for (const id of ["hdrSub", "hdrMeta", "hdrStatus"]) {
      assert.match(html, new RegExp(`<span class="sub" id="${id}"></span>`),
        `${p.id} is missing an empty #${id} slot`);
    }
  }
});

test("nav: the sub slot is escaped — it is page-authored text, not markup", () => {
  const html = siteHeaderHtml("board", '<img src=x onerror="alert(1)">');
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
});

test("nav: the bottom nav mirrors the tab list, in order, with the same active page", () => {
  const html = bottomNavHtml("usage");
  const hrefs = [...html.matchAll(/<a href="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(hrefs, PAGES.map(p => p.href));
  assert.equal((html.match(/class="active"/g) || []).length, 1);
  assert.match(html, /<a href="\/usage" class="active">/);
  for (const p of PAGES) assert.match(html, new RegExp(`>\\s*${p.label}\\s*</a>`));
});

test("nav: mount fills the header and bottom-nav placeholders from the header's data attrs", () => {
  const els = {
    siteHeader: { dataset: { page: "board", sub: "Jira board" }, innerHTML: "" },
    bottomNav: { innerHTML: "" },
  };
  mount({ getElementById: id => els[id] || null });
  assert.match(els.siteHeader.innerHTML, /<a href="\/board" class="active">Board<\/a>/);
  assert.match(els.siteHeader.innerHTML, /id="hdrSub">Jira board</);
  assert.match(els.bottomNav.innerHTML, /<a href="\/board" class="active">/);
});

test("nav: mount is a no-op on a page with no header placeholder (login)", () => {
  assert.doesNotThrow(() => mount({ getElementById: () => null }));
});

// The whole point is that no page hand-rolls its own copy again.
test("nav: every page mounts the shared chrome and hand-rolls none of it", () => {
  for (const f of PAGE_FILES) {
    const src = fs.readFileSync(path.join(PUBLIC, f), "utf8");
    assert.match(src, /<header class="site-header" id="siteHeader"[\s\S]*?data-page="/,
      `${f} does not mount the shared header`);
    assert.match(src, /<nav class="bottom-nav" id="bottomNav"><\/nav>/, `${f} does not mount the shared bottom nav`);
    assert.equal((src.match(/<script src="\/nav\.js">/g) || []).length, 1,
      `${f} should load nav.js exactly once`);
    assert.doesNotMatch(src, /class="nav-tabs"/, `${f} still hand-rolls the tab list`);
    assert.doesNotMatch(src, /class="wordmark"[^>]*>\s*<img/, `${f} still hand-rolls the wordmark`);
    assert.doesNotMatch(src, /api\/logout/, `${f} still hand-rolls the sign-out link`);
  }
});

test("nav: each page declares its own sub-header text and its own tab", () => {
  const subs = new Map();
  for (const f of PAGE_FILES) {
    const src = fs.readFileSync(path.join(PUBLIC, f), "utf8");
    const page = /data-page="([^"]+)"/.exec(src);
    assert.ok(page, `${f} has no data-page`);
    assert.ok(PAGES.some(p => p.id === page[1]), `${f} names an unknown page "${page[1]}"`);
    const sub = /data-sub="([^"]*)"/.exec(src);
    assert.ok(sub && sub[1].trim(), `${f} has no page-specific sub-header text`);
    subs.set(f, sub[1]);
  }
  assert.equal(new Set(subs.values()).size, PAGE_FILES.length, "two pages share a sub-header");
});
