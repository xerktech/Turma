// Unit tests for the shared "New ticket" control (public/newticket.js) — the
// tracker's one write path, moved out of the board page and into the site
// header so a ticket can be created from any page (XERK-150).
//
// Dual-exported like nav.js/org.js/board.js, so the pure half (label splitting,
// the button markup) is tested by direct require and the imperative half through
// a hand-rolled document shim, the same shape org.test.js/nav.test.js use for
// mount(). node:test, no npm.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// newticket.js reads window.TurmaBoard for the form vocabulary (createFormHtml,
// mergeSites), so board.js has to be on the global before it loads — the script
// order every page uses.
global.window = global.window || {};
global.window.TurmaBoard = require("../public/board.js");
const NT = require("../public/newticket.js");

const PUBLIC = path.join(__dirname, "..", "public");
const PAGE_FILES = ["index.html", "sessions.html", "board.html", "usage.html"];

const agent = (key, siteKey) => ({
  key, device: key, online: true, sessions: [],
  jira: siteKey ? { siteKey, available: true, tickets: [] } : null,
});

// ---- label splitting (pure) -------------------------------------------------

test("newticket: Jira labels split on whitespace AND commas, deduped and capped", () => {
  assert.deepEqual(NT.splitLabels("alpha, beta gamma", "jira"), ["alpha", "beta", "gamma"]);
  assert.deepEqual(NT.splitLabels("a a b", "jira"), ["a", "b"]);
  assert.deepEqual(NT.splitLabels("  ", "jira"), []);
  assert.deepEqual(NT.splitLabels("", "jira"), []);
  const many = Array.from({ length: 30 }, (_, i) => "l" + i).join(",");
  assert.equal(NT.splitLabels(many, "jira").length, 20);
});

test("newticket: Azure tags split on commas only (a tag can carry spaces)", () => {
  assert.deepEqual(NT.splitLabels("needs review, in progress", "azure"),
    ["needs review", "in progress"]);
});

// ---- dirty-close guard (pure) -----------------------------------------------

test("newticket: createDirty is true only while un-created text would be lost (XERK-218)", () => {
  const st = (values, created) => ({ values, created });
  assert.equal(NT.createDirty(null), false);
  assert.equal(NT.createDirty(st({ summary: "", description: "", labels: "" })), false);
  assert.equal(NT.createDirty(st({ summary: "  ", description: " ", labels: "" })), false);
  assert.equal(NT.createDirty(st({ summary: "t" })), true);
  assert.equal(NT.createDirty(st({ description: "d" })), true);
  assert.equal(NT.createDirty(st({ labels: "l" })), true);
  // The created screen is never dirty — the ticket exists, nothing is lost.
  assert.equal(NT.createDirty(st({ summary: "t" }, { key: "T-1" })), false);
});

// ---- button markup (pure) ---------------------------------------------------

test("newticket: the button carries the data hook the click handler binds on", () => {
  const html = NT.buttonHtml();
  assert.match(html, /class="newticket-btn"/);
  assert.match(html, /data-newticket/);
  assert.match(html, /New ticket/);
});

// ---- mounted behaviour ------------------------------------------------------

// The smallest document newticket.js's mount()/update() need: an #hdrNewTicket
// slot, a body to append the modal to, and enough element shape for the button
// and modal wiring. Elements track their appended children and their innerHTML
// so a test can read what was painted.
function mountNT() {
  function makeEl() {
    const el = {
      children: [], _listeners: {}, dataset: {}, className: "", id: "",
      hidden: false, innerHTML: "",
      firstElementChild: null,
      classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } },
      style: {},
      appendChild(c) { this.children.push(c); c.parentNode = this; if (!this.firstElementChild) this.firstElementChild = c; return c; },
      removeChild(c) { this.children = this.children.filter(x => x !== c); c.parentNode = null; },
      replaceChildren() { this.children = []; },
      setAttribute(k, v) { this["_attr_" + k] = v; },
      addEventListener(t, fn) { (this._listeners[t] ||= []).push(fn); },
      querySelector: () => null,
      set innerHTMLSetter(v) {},
    };
    return el;
  }
  const slot = makeEl();
  const body = makeEl();
  // createElement returns an element; when innerHTML is set on the button holder
  // we hand back a stand-in button so firstElementChild is non-null.
  const button = makeEl();
  const doc = {
    getElementById: (id) => (id === "hdrNewTicket" ? slot : null),
    body,
    createElement() {
      const el = makeEl();
      // The mount does holder.innerHTML = buttonHtml(); firstElementChild —
      // emulate by exposing a prepared button on the next innerHTML write.
      Object.defineProperty(el, "innerHTML", {
        get() { return el._html || ""; },
        set(v) { el._html = v; if (/newticket-btn/.test(v)) el.firstElementChild = button; },
        configurable: true,
      });
      return el;
    },
    addEventListener() {},
    // anyBackdropOpen() looks for a visible .td-backdrop; reflect the backdrops
    // actually appended under the body so td-open removal is exercised honestly.
    querySelector: () => body.children.find(c => c.className === "td-backdrop" && !c.hidden) || null,
  };
  NT.mount(doc);
  return { slot, body, button, doc };
}

test("newticket: the button is hidden until an org reports, then appears", () => {
  const { slot, button } = mountNT();
  // Fresh mount: nothing reported, so the button isn't in the slot (the slot is
  // :empty and collapses).
  assert.equal(slot.children.length, 0);
  // An org reports — the button joins the slot.
  NT.update({ agents: [agent("h1", "acme.atlassian.net")] });
  assert.deepEqual(slot.children, [button]);
  // Every org leaves — the button is pulled back out.
  NT.update({ agents: [agent("h1", null)] });
  assert.equal(slot.children.length, 0);
});

test("newticket: the modal backdrop is created under the body, hidden", () => {
  const { body } = mountNT();
  assert.equal(body.children.length, 1);
  const backdrop = body.children[0];
  assert.equal(backdrop.className, "td-backdrop");
  assert.equal(backdrop.id, "createBackdrop");
  assert.equal(backdrop.hidden, true);
});

test("newticket: clicking the button opens the form against the reporting org", () => {
  const { body, button } = mountNT();
  NT.update({ agents: [agent("h1", "acme.atlassian.net")] });
  const backdrop = body.children[0];
  const panel = backdrop.children[0];
  // Fire the button's click handler.
  for (const fn of button._listeners.click || []) fn({});
  assert.equal(backdrop.hidden, false);
  assert.equal(body.classList.contains("td-open"), true);
  // The form painted into the panel is the New-ticket modal.
  assert.match(panel.innerHTML, /New ticket/);
});

test("newticket: a dirty close arms the discard confirm; a clean one just closes (XERK-218)", () => {
  const { body, button } = mountNT();
  NT.update({ agents: [agent("h1", "acme.atlassian.net")] });
  const backdrop = body.children[0];
  const panel = backdrop.children[0];
  const open = () => { for (const fn of button._listeners.click || []) fn({}); };
  const clickBackdrop = () => {
    for (const fn of backdrop._listeners.click || []) fn({ target: backdrop });
  };
  const clickPanel = (hook) => {
    for (const fn of panel._listeners.click || []) {
      fn({ target: { closest: (sel) => (sel.includes(hook) ? {} : null) } });
    }
  };

  // Clean form: a backdrop click closes it outright, as before.
  open();
  assert.equal(backdrop.hidden, false);
  clickBackdrop();
  assert.equal(backdrop.hidden, true);

  // Dirty form: type a title (the input listener syncs it into state)...
  open();
  panel.querySelector = (sel) => (sel === "[data-cf-summary]" ? { value: "draft" } : null);
  for (const fn of panel._listeners.input || []) {
    fn({ target: { closest: () => ({}) } });
  }
  // ...then a close request arms the in-form confirm instead of closing.
  clickBackdrop();
  assert.equal(backdrop.hidden, false);
  assert.match(panel.innerHTML, /Discard this ticket\?/);
  // Keep editing disarms and the form stays up.
  clickPanel("data-cf-keep");
  assert.equal(backdrop.hidden, false);
  assert.doesNotMatch(panel.innerHTML, /Discard this ticket\?/);
  // Arm again; a second close request (Escape/backdrop/Cancel) confirms it.
  clickBackdrop();
  assert.equal(backdrop.hidden, false);
  clickBackdrop();
  assert.equal(backdrop.hidden, true);

  // Arm once more via Cancel, and the explicit Discard button closes too.
  open();
  panel.querySelector = (sel) => (sel === "[data-cf-summary]" ? { value: "draft" } : null);
  for (const fn of panel._listeners.input || []) {
    fn({ target: { closest: () => ({}) } });
  }
  clickPanel("data-cf-cancel");
  assert.equal(backdrop.hidden, false);
  assert.match(panel.innerHTML, /Discard this ticket\?/);
  clickPanel("data-cf-discard");
  assert.equal(backdrop.hidden, true);
});

// ---- wiring: every page carries it ------------------------------------------

test("newticket: every page loads newticket.js after org.js", () => {
  for (const f of PAGE_FILES) {
    const html = fs.readFileSync(path.join(PUBLIC, f), "utf8");
    const order = [...html.matchAll(/<script src="\/(board|nav|org|newticket)\.js"><\/script>/g)].map(m => m[1]);
    // board.js first (its vocabulary), nav.js before both (it builds the slots),
    // org.js before newticket.js (newticket reads TurmaOrg for the current scope).
    assert.deepEqual(order, ["board", "nav", "org", "newticket"], f);
  }
});

test("newticket: every page feeds it the heartbeat via TurmaNewTicket.update", () => {
  for (const f of ["index.html", "sessions.html", "usage.html", "board.html"]) {
    const html = fs.readFileSync(path.join(PUBLIC, f), "utf8");
    assert.match(html, /TurmaNewTicket\.update\(data\)/, f);
  }
});

test("newticket: the hub actually serves every /*.js the pages load", () => {
  // A shared script that isn't in server.js's HASHED_ASSETS 404s in the browser,
  // taking its whole module (and every page's render) down — nav.js/org.js are
  // registered by hand, so a new one is easy to forget. Guard the whole class.
  // HASHED_ASSETS specifically, not the STATIC_ASSETS map it feeds: that list is
  // also what gives a script its fingerprinted URL, and one registered only as a
  // plain entry is served under a mutable name again (XERK-312).
  const server = fs.readFileSync(path.join(PUBLIC, "..", "server.js"), "utf8");
  const served = new Set([...server.matchAll(/\["(\/[\w-]+\.js)",/g)].map(m => m[1]));
  for (const f of PAGE_FILES) {
    const html = fs.readFileSync(path.join(PUBLIC, f), "utf8");
    for (const m of html.matchAll(/<script src="(\/[\w-]+\.js)">/g)) {
      assert.ok(served.has(m[1]), `${f} loads ${m[1]} but server.js STATIC_ASSETS doesn't serve it`);
    }
  }
});

test("newticket: the header carries the #hdrNewTicket slot, before the tabs", () => {
  const nav = require("../public/nav.js");
  const html = nav.siteHeaderHtml("board", "sub");
  assert.match(html, /id="hdrNewTicket"/);
  assert.ok(html.indexOf('id="hdrNewTicket"') < html.indexOf('<nav class="nav-tabs">'),
    "the new-ticket slot must sit before the tabs — the header ends at the tabs");
});

test("newticket: the board no longer owns the button or its modal markup", () => {
  const html = fs.readFileSync(path.join(PUBLIC, "board.html"), "utf8");
  assert.doesNotMatch(html, /id="newTicket"|id="createBackdrop"|id="createPanel"|board-newticket/);
  const css = fs.readFileSync(path.join(PUBLIC, "app.css"), "utf8");
  assert.doesNotMatch(css, /\.board-newticket/);
});
