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

const { PAGES, siteHeaderHtml, bottomNavHtml, tabsHtml, mount, preserveScroll } = require("../public/nav.js");

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

test("nav: the header carries both slots on every page, empty by default", () => {
  for (const p of PAGES) {
    const html = siteHeaderHtml(p.id, "");
    for (const id of ["hdrSub", "hdrMeta"]) {
      assert.match(html, new RegExp(`<span class="sub" id="${id}"></span>`),
        `${p.id} is missing an empty #${id} slot`);
    }
  }
});

// The header ends at the tabs. A right-hand slot existed only to carry an
// "updated <time>" stamp on dashboard/sessions; that was dropped, so the slot
// would be dead DOM on all four pages.
test("nav: the header carries no slot after the tabs", () => {
  const html = siteHeaderHtml("dashboard", "Session hosts");
  assert.doesNotMatch(html, /hdrStatus/);
  assert.match(html, /<\/nav>\s*<\/div>$/, "the tabs must be the last thing in the header row");
});

test("nav: no page paints a last-refreshed stamp into the header", () => {
  for (const f of PAGE_FILES) {
    const src = fs.readFileSync(path.join(PUBLIC, f), "utf8");
    assert.doesNotMatch(src, /hdrStatus/, `${f} references the removed status slot`);
    assert.doesNotMatch(src, /"updated "/, `${f} still paints an "updated <time>" stamp`);
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

// The header row is centred in the --wrap column on EVERY page, sessions.html
// included. It once released --wrap there (to full-bleed its shell, since capped),
// which stretched the wordmark to x=20 and flung the tabs to the window edge —
// nothing like the board/usage header it is supposed to match.
test("nav: no page releases --wrap and stretches the header to the window edges", () => {
  for (const f of PAGE_FILES) {
    const src = fs.readFileSync(path.join(PUBLIC, f), "utf8");
    assert.doesNotMatch(src, /--wrap\s*:\s*(none|100%|auto)/,
      `${f} releases --wrap, which un-caps the shared header row`);
  }
});

// The header's bottom gap must stay a margin: .wrap pages' first content element
// carries its own top margin (.board-bar has 2px), which collapses with a margin
// and does NOT collapse with padding — the difference is a 2px content shift.
test("nav: the header's bottom gap is a margin, so it still collapses with content", () => {
  const css = fs.readFileSync(path.join(PUBLIC, "app.css"), "utf8");
  const rule = /\.site-header\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, "no .site-header rule");
  assert.match(rule[1], /margin-bottom:\s*20px/);
  const inner = /\.site-header-in\s*\{([^}]*)\}/.exec(css);
  assert.ok(inner, "no .site-header-in rule");
  assert.match(inner[1], /padding:\s*24px\s+20px\s+0\b/, "the row's bottom spacing must not be padding");
  assert.match(inner[1], /max-width:\s*var\(--wrap\)/);
});

// The header row is centred, so the column it centres in must not depend on
// whether a page is long enough to scroll. The dashboard always overflows and
// board/usage/sessions often don't: without a reserved gutter the dashboard
// centred in a 15px-narrower viewport and its header sat 7.5px left of theirs.
test("nav: the scrollbar gutter is reserved, so a scrolling page centres like a short one", () => {
  const css = fs.readFileSync(path.join(PUBLIC, "app.css"), "utf8");
  const html = /^html\s*\{([^}]*)\}/m.exec(css);
  assert.ok(html, "no html rule in app.css");
  assert.match(html[1], /scrollbar-gutter:\s*stable/);
});

test("nav: no page opts out of the reserved gutter", () => {
  for (const f of PAGE_FILES) {
    const src = fs.readFileSync(path.join(PUBLIC, f), "utf8");
    assert.doesNotMatch(src, /scrollbar-gutter\s*:\s*auto/,
      `${f} releases the scrollbar gutter, which shifts its header off every other page's`);
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

// --- preserveScroll: the one wrapper every recurring innerHTML repaint goes
// through so a beat can't reset the scroll (XERK-35). No jsdom here, so we drive
// it against a minimal fake DOM whose scrollTop/scrollLeft are plain properties
// — enough to pin the capture-then-restore contract and the two ways a scrolled
// node is matched across the swap (id anchor vs. structural child-index path).
function fakeEl(id) {
  return {
    id: id || "", children: [], parentNode: null, scrollTop: 0, scrollLeft: 0,
    append(...kids) { for (const k of kids) { k.parentNode = this; this.children.push(k); } },
    querySelectorAll() {                     // only "*" is ever asked for
      const out = [];
      (function walk(n) { for (const c of n.children) { out.push(c); walk(c); } })(this);
      return out;
    },
  };
}
function withFakeWindow(startY, run) {
  const savedWin = global.window, savedDoc = global.document, byId = {};
  let y = startY;
  const scrolls = [];
  global.window = {
    get scrollX() { return 0; }, get scrollY() { return y; },
    scrollTo(x, ny) { y = ny; scrolls.push(ny); },
  };
  global.document = { getElementById: (id) => byId[id] || null };
  try { return run({ byId, setY: (v) => { y = v; }, getY: () => y, scrolls }); }
  finally { global.window = savedWin; global.document = savedDoc; }
}

test("preserveScroll: null container still runs the paint once", () => {
  let n = 0;
  preserveScroll(null, () => { n++; });
  assert.equal(n, 1);
});

test("preserveScroll: restores window scroll a paint clamped to the top", () => {
  withFakeWindow(140, (ctx) => {
    const container = fakeEl();
    preserveScroll(container, () => { ctx.setY(0); });   // paint collapsed height
    assert.equal(ctx.getY(), 140);
    assert.deepEqual(ctx.scrolls, [140]);
  });
});

test("preserveScroll: leaves window scroll alone when the paint didn't move it", () => {
  withFakeWindow(90, (ctx) => {
    preserveScroll(fakeEl(), () => { /* no scroll change */ });
    assert.equal(ctx.scrolls.length, 0);                 // no needless scrollTo
  });
});

test("preserveScroll: restores a scrolled descendant matched by structural path", () => {
  withFakeWindow(0, () => {
    const container = fakeEl();
    const strip = fakeEl();                               // no id -> path-keyed
    strip.scrollLeft = 200; strip.scrollTop = 30;
    container.append(strip);
    preserveScroll(container, () => {                     // rebuild: fresh, reset node
      container.children = [];
      container.append(fakeEl());                         // same structural slot
    });
    assert.equal(container.children[0].scrollLeft, 200);
    assert.equal(container.children[0].scrollTop, 30);
  });
});

test("preserveScroll: an id anchor follows a reordered list to the right row", () => {
  withFakeWindow(0, (ctx) => {
    const container = fakeEl();
    const a = fakeEl("host-a"), b = fakeEl("host-b");
    b.scrollTop = 75;                                     // the scrolled one is 2nd
    container.append(a, b);
    preserveScroll(container, () => {                     // rebuild with order SWAPPED
      const a2 = fakeEl("host-a"), b2 = fakeEl("host-b");
      ctx.byId["host-a"] = a2; ctx.byId["host-b"] = b2;
      container.children = [];
      container.append(b2, a2);                           // b now first
    });
    // Structural position moved, but the id anchor put scrollTop back on host-b.
    assert.equal(ctx.byId["host-b"].scrollTop, 75);
    assert.equal(ctx.byId["host-a"].scrollTop, 0);
  });
});
