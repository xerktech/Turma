// Unit tests for the shared org filter (public/org.js) — the header control
// that scopes EVERY page to one tracker org (XERK-62), replacing the board's
// own chip strip.
//
// The module is dual-exported like nav.js/board.js, so the pure half (which org
// a host belongs to, how a stale pick self-heals, the control's markup) is
// tested by direct require with no DOM. The imperative half is driven through a
// hand-rolled document shim, the same shape nav.test.js uses for mount().
// node:test, no npm.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// org.js reads window.TurmaBoard for the org vocabulary, so board.js has to be
// on the global before it loads — exactly the script order every page uses.
global.window = global.window || {};
global.window.TurmaBoard = require("../public/board.js");
const Org = require("../public/org.js");

const PUBLIC = path.join(__dirname, "..", "public");
const PAGE_FILES = ["index.html", "sessions.html", "board.html", "usage.html"];

const agent = (key, siteKey) => ({
  key, device: key, online: true, sessions: [],
  jira: siteKey ? { siteKey, available: true, tickets: [] } : null,
});
const site = (siteKey, tickets = 0) => ({
  siteKey, orgName: "", online: true, hosts: [siteKey + "-host"],
  tickets: Array.from({ length: tickets }, (_, i) => ({ key: "K-" + i })),
  lastFetched: null,
});

// ---- which org a host belongs to -------------------------------------------

test("org: a host's org is its jira block's siteKey; no block means no org", () => {
  assert.equal(Org.siteKeyOf(agent("a", "acme.atlassian.net")), "acme.atlassian.net");
  assert.equal(Org.siteKeyOf(agent("b", null)), "");
  assert.equal(Org.siteKeyOf(null), "");
  assert.equal(Org.siteKeyOf({ jira: {} }), "");
});

test("org: an empty filter is every host, incl. hosts with no org at all", () => {
  const agents = [agent("a", "acme.atlassian.net"), agent("b", null)];
  assert.deepEqual(Org.filterAgents(agents, ""), agents);
  assert.deepEqual(Org.filterAgents(agents), agents);
  assert.deepEqual(Org.filterAgents(null, ""), []);
});

test("org: a named filter keeps that org's hosts and drops the rest", () => {
  const a = agent("a", "acme.atlassian.net");
  const b = agent("b", "dev.azure.com/other");
  const c = agent("c", null);
  assert.deepEqual(Org.filterAgents([a, b, c], "acme.atlassian.net"), [a]);
  assert.deepEqual(Org.filterAgents([a, b, c], "dev.azure.com/other"), [b]);
  // A host with no tracker creds belongs to no org, so a named scope excludes
  // it — it isn't quietly folded into whichever org happens to be picked.
  assert.deepEqual(Org.filterAgents([a, b, c], "nobody.atlassian.net"), []);
});

// ---- a stale pick self-heals ------------------------------------------------

test("org: a pick for an org nobody reports doesn't apply", () => {
  const sites = [site("acme.atlassian.net")];
  assert.equal(Org.effectiveKey("acme.atlassian.net", sites), "acme.atlassian.net");
  // The whole fleet would otherwise vanish behind a filter with no chip left to
  // clear it — the one way an operator could lock themselves out of every page.
  assert.equal(Org.effectiveKey("gone.atlassian.net", sites), "");
  assert.equal(Org.effectiveKey("acme.atlassian.net", []), "");
  assert.equal(Org.effectiveKey("", sites), "");
});

// ---- the control's markup ---------------------------------------------------

test("org: the button reads 'All orgs' unscoped and the org's name when scoped", () => {
  const sites = [site("acme.atlassian.net", 3)];
  const colors = window.TurmaBoard.orgColorMap(["acme.atlassian.net"]);
  const all = Org.buttonHtml(sites, "", colors, false);
  assert.match(all, />All orgs</);
  assert.doesNotMatch(all, /class="org-btn scoped"/);

  const scoped = Org.buttonHtml(sites, "acme.atlassian.net", colors, false);
  // Labelled by org NAME, while the value it filters on stays the full siteKey.
  assert.match(scoped, />acme</);
  assert.match(scoped, /class="org-btn scoped"/);
  assert.match(scoped, /aria-expanded="false"/);
  assert.match(Org.buttonHtml(sites, "", colors, true), /aria-expanded="true"/);
});

test("org: the menu lists All orgs plus every reporting org, with ticket counts", () => {
  const sites = [site("acme.atlassian.net", 3), site("dev.azure.com/xerk", 4)];
  const colors = window.TurmaBoard.orgColorMap(sites.map(s => s.siteKey));
  const html = Org.menuHtml(sites, "", colors, {}, () => "");
  assert.equal((html.match(/data-org-key=/g) || []).length, 3);
  assert.match(html, /data-org-key=""[\s\S]*?All orgs[\s\S]*?<span class="chip-n">7<\/span>/);
  assert.match(html, /data-org-key="acme\.atlassian\.net"/);
  assert.match(html, /data-org-key="dev\.azure\.com\/xerk"/);
});

test("org: exactly one menu row is checked, and only the picked one", () => {
  const sites = [site("acme.atlassian.net"), site("dev.azure.com/xerk")];
  const colors = window.TurmaBoard.orgColorMap(sites.map(s => s.siteKey));
  for (const key of ["", "acme.atlassian.net", "dev.azure.com/xerk"]) {
    const html = Org.menuHtml(sites, key, colors, {}, () => "");
    assert.equal((html.match(/aria-checked="true"/g) || []).length, 1);
    assert.equal((html.match(/class="org-row active"/g) || []).length, 1);
  }
});

test("org: each org row carries its auto-start switch, reflecting the hub map", () => {
  const sites = [site("acme.atlassian.net"), site("dev.azure.com/xerk")];
  const colors = window.TurmaBoard.orgColorMap(sites.map(s => s.siteKey));
  const html = Org.menuHtml(sites, "", colors, { "acme.atlassian.net": true }, () => "");
  // One switch per ORG — never on the "All orgs" row, which is a scope, not an
  // org the hub can be opted in for.
  assert.equal((html.match(/data-org-auto=/g) || []).length, 2);
  assert.match(html, /data-org-auto="acme\.atlassian\.net" aria-pressed="true"/);
  assert.match(html, /data-org-auto="dev\.azure\.com\/xerk" aria-pressed="false"/);
  assert.equal((html.match(/org-chip-auto on/g) || []).length, 1);
});

test("org: an org with no online host is marked stale, with how old its report is", () => {
  const offline = Object.assign(site("acme.atlassian.net"), { online: false, lastFetched: "x" });
  const colors = window.TurmaBoard.orgColorMap(["acme.atlassian.net"]);
  const html = Org.menuHtml([offline, site("dev.azure.com/xerk")], "", colors, {}, () => "4m");
  assert.match(html, /⚠ offline · synced 4m ago/);
  assert.equal((html.match(/chip-stale/g) || []).length, 1);
});

test("org: the menu only exists while it's open", () => {
  const sites = [site("acme.atlassian.net")];
  const colors = window.TurmaBoard.orgColorMap(["acme.atlassian.net"]);
  assert.doesNotMatch(Org.controlHtml(sites, "", colors, {}, false, () => ""), /org-menu/);
  assert.match(Org.controlHtml(sites, "", colors, {}, true, () => ""), /org-menu/);
});

test("org: org names and site keys are escaped into the markup", () => {
  const evil = Object.assign(site('a"><script>x</script>'), { orgName: "<b>boom</b>" });
  const colors = window.TurmaBoard.orgColorMap([evil.siteKey]);
  const html = Org.menuHtml([evil], "", colors, {}, () => "");
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /<b>boom<\/b>/);
  assert.match(html, /&lt;b&gt;boom&lt;\/b&gt;/);
});

// ---- mounted behaviour ------------------------------------------------------

// The smallest document that org.js's mount() and paint() need: an #hdrOrg slot
// and the three listener registrations it makes.
function mountOrg({ storedOrg = null, storedBoardOrg = null } = {}) {
  const store = {};
  if (storedOrg !== null) store[Org.KEY] = storedOrg;
  if (storedBoardOrg !== null) store[Org.LEGACY_KEY] = storedBoardOrg;
  const slot = {
    innerHTML: "", _listeners: {},
    addEventListener(t, fn) { (this._listeners[t] ||= []).push(fn); },
    contains: () => true,
  };
  const doc = {
    getElementById: (id) => (id === "hdrOrg" ? slot : null),
    addEventListener() {},
  };
  global.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
  };
  global.window.addEventListener = () => {};
  Org.mount(doc);
  // Click the control the way a browser would: an event whose target closest()s
  // to the element carrying the data attribute.
  const click = (attr, value) => {
    const target = {
      dataset: { orgKey: value, orgAuto: value },
      classList: { contains: () => false },
      closest: (sel) => (sel === `[${attr}]` ? target : null),
    };
    for (const fn of slot._listeners.click || []) fn({ target });
  };
  return { slot, store, click };
}

test("org: a stored pick is read at mount, and applies once its org reports", () => {
  const { slot } = mountOrg({ storedOrg: "acme.atlassian.net" });
  // Nothing reported yet: the slot stays empty (and collapses) rather than
  // offering a menu whose only entry is "All orgs".
  assert.equal(slot.innerHTML, "");
  assert.equal(Org.get(), "");
  Org.update({ agents: [agent("a", "acme.atlassian.net")] });
  assert.equal(Org.get(), "acme.atlassian.net");
  assert.match(slot.innerHTML, /class="org-btn scoped"/);
});

test("org: an existing board-only pick is migrated to the shared key", () => {
  const { store } = mountOrg({ storedBoardOrg: "acme.atlassian.net" });
  Org.update({ agents: [agent("a", "acme.atlassian.net")] });
  // The operator's board filter follows them onto every page instead of
  // silently resetting to "all orgs" on upgrade.
  assert.equal(Org.get(), "acme.atlassian.net");
  assert.equal(store[Org.KEY], "acme.atlassian.net");
});

test("org: picking an org persists it and notifies every page that asked", () => {
  const { store, click } = mountOrg();
  const seen = [];
  Org.subscribe((k) => seen.push(k));
  Org.update({ agents: [agent("a", "acme.atlassian.net"), agent("b", "dev.azure.com/xerk")] });
  click("data-org-key", "acme.atlassian.net");
  assert.equal(Org.get(), "acme.atlassian.net");
  assert.equal(store[Org.KEY], "acme.atlassian.net");
  assert.deepEqual(seen, ["acme.atlassian.net"]);
  // Re-picking the scope already showing is a no-op, not a second repaint.
  click("data-org-key", "acme.atlassian.net");
  assert.deepEqual(seen, ["acme.atlassian.net"]);
});

test("org: a pick whose org stops reporting stops applying, keeping the stored value", () => {
  const { store, click } = mountOrg();
  Org.update({ agents: [agent("a", "acme.atlassian.net"), agent("b", "dev.azure.com/xerk")] });
  click("data-org-key", "acme.atlassian.net");
  // That host goes away entirely (removed, not merely offline).
  Org.update({ agents: [agent("b", "dev.azure.com/xerk")] });
  assert.equal(Org.get(), "");
  assert.equal(store[Org.KEY], "acme.atlassian.net");  // it comes back when the host does
  Org.update({ agents: [agent("a", "acme.atlassian.net"), agent("b", "dev.azure.com/xerk")] });
  assert.equal(Org.get(), "acme.atlassian.net");
});

test("org: the menu opens on the button and closes on a pick", () => {
  const { slot, click } = mountOrg();
  Org.update({ agents: [agent("a", "acme.atlassian.net")] });
  assert.doesNotMatch(slot.innerHTML, /org-menu/);
  click("data-org-toggle", "");
  assert.match(slot.innerHTML, /org-menu/);
  click("data-org-key", "acme.atlassian.net");
  assert.doesNotMatch(slot.innerHTML, /org-menu/);
});

test("org: a beat that changes nothing doesn't rewrite the control", () => {
  const { slot } = mountOrg();
  const data = { agents: [agent("a", "acme.atlassian.net")] };
  Org.update(data);
  const painted = slot.innerHTML;
  let writes = 0;
  Object.defineProperty(slot, "innerHTML", {
    get: () => painted, set: () => { writes++; },
  });
  // The 1s beat must not churn the DOM under an open menu / a hovered row.
  Org.update(data);
  Org.update(data);
  assert.equal(writes, 0);
});

test("org: the auto switch flips optimistically and rolls back on a failed POST", async () => {
  const { slot, click } = mountOrg();
  Org.update({ agents: [agent("a", "acme.atlassian.net")], autoStartOrgs: {} });
  click("data-org-toggle", "");                          // the switches live in the menu
  const posts = [];
  global.fetch = (url, init) => {
    posts.push({ url, body: JSON.parse(init.body) });
    return Promise.resolve({ ok: false, status: 500 });
  };
  const p = Org.setAutoStart("acme.atlassian.net", true);
  // Painted before the POST settles, so the switch responds to the click at once.
  assert.match(slot.innerHTML, /org-chip-auto on/);
  await p;
  assert.deepEqual(posts, [{ url: "/api/jira/acme.atlassian.net/autostart", body: { enabled: true } }]);
  assert.doesNotMatch(slot.innerHTML, /org-chip-auto on/);
});

test("org: the hub's autoStartOrgs broadcast repaints the switches", () => {
  const { slot, click } = mountOrg();
  Org.update({ agents: [agent("a", "acme.atlassian.net")], autoStartOrgs: {} });
  click("data-org-toggle", "");                          // the switches live in the menu
  const handlers = {};
  Org.sse({ addEventListener: (t, fn) => { handlers[t] = fn; } });
  handlers.autoStartOrgs({ data: JSON.stringify({ "acme.atlassian.net": true }) });
  assert.match(slot.innerHTML, /org-chip-auto on/);
  // Malformed payloads are ignored rather than blanking the switches.
  handlers.autoStartOrgs({ data: "{" });
  assert.match(slot.innerHTML, /org-chip-auto on/);
});

// ---- wiring: every page must actually obey it -------------------------------

test("org: every page loads board.js, nav.js and org.js, in that order", () => {
  for (const f of PAGE_FILES) {
    const html = fs.readFileSync(path.join(PUBLIC, f), "utf8");
    const order = [...html.matchAll(/<script src="\/(board|nav|org)\.js"><\/script>/g)].map(m => m[1]);
    // board.js first (org.js reads its org vocabulary), nav.js before org.js
    // (it builds the #hdrOrg slot org.js mounts into).
    assert.deepEqual(order, ["board", "nav", "org"], f);
  }
});

test("org: the header carries the #hdrOrg slot, before the tabs", () => {
  const nav = require("../public/nav.js");
  const html = nav.siteHeaderHtml("board", "sub");
  assert.match(html, /id="hdrOrg"/);
  assert.ok(html.indexOf('id="hdrOrg"') < html.indexOf("<nav class=\"nav-tabs\">"),
    "the org slot must sit before the tabs — the header ends at the tabs");
});

test("org: the board no longer owns a chip strip of its own", () => {
  const html = fs.readFileSync(path.join(PUBLIC, "board.html"), "utf8");
  assert.doesNotMatch(html, /org-chips|org-chip-main|turma-board-org/);
  const css = fs.readFileSync(path.join(PUBLIC, "app.css"), "utf8");
  assert.doesNotMatch(css, /\.org-chips|\.org-chip-main/);
});
