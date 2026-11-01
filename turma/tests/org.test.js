// Unit tests for the shared org filter (public/org.js) — the header control
// that scopes EVERY page to a selected set of tracker orgs (XERK-62, multi-
// select per XERK-222), replacing the board's own chip strip.
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
const PAGE_FILES = ["index.html", "sessions.html", "board.html", "usage.html", "insights.html", "brief.html", "meetings.html"];

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
  // Non-strings are "no org", the same answer turma/server.js's siteKeyOf gives
  // — the two are a mirror and an object key compared by reference here while
  // the hub reads it as org-less is the two ends disagreeing about what an org is.
  assert.equal(Org.siteKeyOf({ jira: { siteKey: { o: 1 } } }), "");
  assert.equal(Org.siteKeyOf({ jira: { siteKey: ["a"] } }), "");
  assert.equal(Org.siteKeyOf({ jira: { siteKey: 5 } }), "");
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

test("org: a multi-org filter keeps every selected org's hosts (XERK-222)", () => {
  const a = agent("a", "acme.atlassian.net");
  const b = agent("b", "dev.azure.com/other");
  const c = agent("c", null);
  assert.deepEqual(Org.filterAgents([a, b, c], ["acme.atlassian.net", "dev.azure.com/other"]), [a, b]);
  assert.deepEqual(Org.filterAgents([a, b, c], ["dev.azure.com/other"]), [b]);
  // A Set works too, and an empty selection is every host.
  assert.deepEqual(Org.filterAgents([a, b, c], new Set(["acme.atlassian.net"])), [a]);
  assert.deepEqual(Org.filterAgents([a, b, c], []), [a, b, c]);
});

// ---- a stale pick self-heals ------------------------------------------------

test("org: a pick for an org nobody reports doesn't apply", () => {
  const sites = [site("acme.atlassian.net")];
  assert.deepEqual(Org.effectiveKeys(["acme.atlassian.net"], sites), ["acme.atlassian.net"]);
  // The whole fleet would otherwise vanish behind a filter with no chip left to
  // clear it — the one way an operator could lock themselves out of every page.
  assert.deepEqual(Org.effectiveKeys(["gone.atlassian.net"], sites), []);
  assert.deepEqual(Org.effectiveKeys(["acme.atlassian.net"], []), []);
  assert.deepEqual(Org.effectiveKeys([], sites), []);
  // Each key self-heals independently: the reported one keeps applying while
  // the gone one is dropped from the effective set.
  assert.deepEqual(Org.effectiveKeys(["gone.atlassian.net", "acme.atlassian.net"], sites),
    ["acme.atlassian.net"]);
  // A bare-string selection (the pre-multi shape) still resolves.
  assert.deepEqual(Org.effectiveKeys("acme.atlassian.net", sites), ["acme.atlassian.net"]);
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

test("org: several selected orgs read as a count, with one dot per org (XERK-222)", () => {
  const sites = [site("acme.atlassian.net", 3), site("dev.azure.com/xerk", 4)];
  const colors = window.TurmaBoard.orgColorMap(sites.map(s => s.siteKey));
  const multi = Org.buttonHtml(sites, ["acme.atlassian.net", "dev.azure.com/xerk"], colors, false);
  assert.match(multi, />2 orgs</);
  assert.match(multi, /class="org-btn scoped"/);
  assert.equal((multi.match(/class="org-dot"/g) || []).length, 2);
  // A selected org nobody reports contributes neither a dot nor the count.
  const one = Org.buttonHtml(sites, ["acme.atlassian.net"], colors, false);
  assert.match(one, />acme</);
  assert.equal((one.match(/class="org-dot"/g) || []).length, 1);
});

test("org: the menu lists All orgs plus every reporting org, with ticket counts", () => {
  const sites = [site("acme.atlassian.net", 3), site("dev.azure.com/xerk", 4)];
  const colors = window.TurmaBoard.orgColorMap(sites.map(s => s.siteKey));
  const html = Org.menuHtml(sites, "", colors, {}, {}, () => "");
  assert.equal((html.match(/data-org-key=/g) || []).length, 3);
  assert.match(html, /data-org-key=""[\s\S]*?All orgs[\s\S]*?<span class="chip-n">7<\/span>/);
  assert.match(html, /data-org-key="acme\.atlassian\.net"/);
  assert.match(html, /data-org-key="dev\.azure\.com\/xerk"/);
});

test("org: every selected org's row is checked and highlighted, none else (XERK-222)", () => {
  const sites = [site("acme.atlassian.net"), site("dev.azure.com/xerk")];
  const colors = window.TurmaBoard.orgColorMap(sites.map(s => s.siteKey));
  // Rows are checkboxes, not radios: any subset can be on at once.
  assert.doesNotMatch(Org.menuHtml(sites, [], colors, {}, {}, () => ""), /menuitemradio/);
  // Nothing selected: only the "All orgs" row is checked.
  const none = Org.menuHtml(sites, [], colors, {}, {}, () => "");
  assert.equal((none.match(/aria-checked="true"/g) || []).length, 1);
  assert.equal((none.match(/class="org-row active"/g) || []).length, 1);
  assert.match(none, /data-org-key="" role="menuitemcheckbox" aria-checked="true"/);
  // One selected: that row alone.
  const one = Org.menuHtml(sites, ["acme.atlassian.net"], colors, {}, {}, () => "");
  assert.equal((one.match(/aria-checked="true"/g) || []).length, 1);
  assert.match(one, /data-org-key="acme\.atlassian\.net"[^>]*aria-checked="true"/);
  assert.match(one, /data-org-key="" role="menuitemcheckbox" aria-checked="false"/);
  // Both selected: both rows checked and highlighted, All orgs not.
  const both = Org.menuHtml(sites, ["acme.atlassian.net", "dev.azure.com/xerk"], colors, {}, {}, () => "");
  assert.equal((both.match(/aria-checked="true"/g) || []).length, 2);
  assert.equal((both.match(/class="org-row active"/g) || []).length, 2);
  assert.match(both, /data-org-key="" role="menuitemcheckbox" aria-checked="false"/);
});

test("org: each org row carries its auto-start switch, reflecting the hub map", () => {
  const sites = [site("acme.atlassian.net"), site("dev.azure.com/xerk")];
  const colors = window.TurmaBoard.orgColorMap(sites.map(s => s.siteKey));
  const html = Org.menuHtml(sites, "", colors, { "acme.atlassian.net": true }, {}, () => "");
  // One switch per ORG — never on the "All orgs" row, which is a scope, not an
  // org the hub can be opted in for.
  assert.equal((html.match(/data-org-auto=/g) || []).length, 2);
  assert.match(html, /data-org-auto="acme\.atlassian\.net" aria-pressed="true"/);
  assert.match(html, /data-org-auto="dev\.azure\.com\/xerk" aria-pressed="false"/);
  assert.equal((html.match(/org-chip-auto on/g) || []).length, 1);
});

test("org: each org row carries its auto-merge switch, reflecting the hub map (XERK-550)", () => {
  const sites = [site("acme.atlassian.net"), site("dev.azure.com/xerk")];
  const colors = window.TurmaBoard.orgColorMap(sites.map(s => s.siteKey));
  // auto-start OFF for both; auto-merge ON only for acme — the two toggles are
  // independent maps, so the merge switch must read its OWN map, not autoMap.
  const html = Org.menuHtml(sites, "", colors, {}, { "acme.atlassian.net": true }, () => "");
  assert.equal((html.match(/data-org-merge=/g) || []).length, 2);
  assert.match(html, /data-org-merge="acme\.atlassian\.net" aria-pressed="true"/);
  assert.match(html, /data-org-merge="dev\.azure\.com\/xerk" aria-pressed="false"/);
  assert.equal((html.match(/org-chip-merge on/g) || []).length, 1);
  // The auto-start switches stay OFF — the merge map must not bleed into them.
  assert.doesNotMatch(html, /data-org-auto="[^"]*" aria-pressed="true"/);
});

test("org: an org with no online host is marked stale, with how old its report is", () => {
  const offline = Object.assign(site("acme.atlassian.net"), { online: false, lastFetched: "x" });
  const colors = window.TurmaBoard.orgColorMap(["acme.atlassian.net"]);
  const html = Org.menuHtml([offline, site("dev.azure.com/xerk")], "", colors, {}, {}, () => "4m");
  assert.match(html, /⚠ offline · synced 4m ago/);
  assert.equal((html.match(/chip-stale/g) || []).length, 1);
});

test("org: the menu only exists while it's open", () => {
  const sites = [site("acme.atlassian.net")];
  const colors = window.TurmaBoard.orgColorMap(["acme.atlassian.net"]);
  assert.doesNotMatch(Org.controlHtml(sites, "", colors, {}, {}, false, () => ""), /org-menu/);
  assert.match(Org.controlHtml(sites, "", colors, {}, {}, true, () => ""), /org-menu/);
});

test("org: org names and site keys are escaped into the markup", () => {
  const evil = Object.assign(site('a"><script>x</script>'), { orgName: "<b>boom</b>" });
  const colors = window.TurmaBoard.orgColorMap([evil.siteKey]);
  const html = Org.menuHtml([evil], "", colors, {}, {}, () => "");
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /<b>boom<\/b>/);
  assert.match(html, /&lt;b&gt;boom&lt;\/b&gt;/);
});

// ---- mounted behaviour ------------------------------------------------------

// The smallest document that org.js's mount() and paint() need: an #hdrOrg slot
// and the three listener registrations it makes.
function mountOrg({ storedOrg = null, storedBoardOrg = null, storedSites = null } = {}) {
  const store = {};
  if (storedSites !== null) store[Org.SITES_KEY] = storedSites;
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
  // to the element carrying the data attribute. `extra` merges further dataset
  // keys (the swatch buttons carry two).
  const click = (attr, value, extra = {}) => {
    const target = {
      dataset: Object.assign({ orgKey: value, orgAuto: value, orgColor: value }, extra),
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

test("org: the last fleet's orgs paint the button at mount, before any update (XERK-2432)", () => {
  // Every page change remounts the header. Without the cache the slot started
  // empty and the control popped in once the page's first fetch landed,
  // growing the header and shifting the page under it.
  const { slot, store } = mountOrg({ storedOrg: "acme.atlassian.net" });
  Org.update({ agents: [agent("a", "acme.atlassian.net")], orgColors: { "acme.atlassian.net": 3 } });
  const cached = JSON.parse(store[Org.SITES_KEY]);
  assert.deepEqual(cached.sites, [{ siteKey: "acme.atlassian.net", orgName: "", source: "jira" }]);
  assert.deepEqual(cached.colorPins, { "acme.atlassian.net": 3 });
  const painted = slot.innerHTML;
  // The next page: same storage, nothing fetched yet — same control, at once.
  const next = mountOrg({ storedOrg: "acme.atlassian.net", storedSites: store[Org.SITES_KEY] });
  assert.equal(next.slot.innerHTML, painted);
  assert.equal(Org.get(), "acme.atlassian.net");
  assert.deepEqual(Org.cachedSites(), cached.sites);
  // The cache carries no ticket counts or switches, so the menu waits for the
  // first real update rather than opening on a stub.
  next.click("data-org-toggle", "");
  assert.doesNotMatch(next.slot.innerHTML, /org-menu/);
  Org.update({ agents: [agent("a", "acme.atlassian.net")] });
  next.click("data-org-toggle", "");
  assert.match(next.slot.innerHTML, /org-menu/);
});

test("org: an unchanged fleet rewrites a cache another tab overwrote (XERK-2435)", () => {
  const { store } = mountOrg();
  const fleet = { agents: [agent("a", "acme.atlassian.net")] };
  Org.update(fleet);
  const mine = store[Org.SITES_KEY];
  // Another tab, seeing a different fleet, writes its own list.
  store[Org.SITES_KEY] = JSON.stringify({ sites: [{ siteKey: "other.atlassian.net" }], colorPins: {} });
  Org.update(fleet);
  assert.equal(store[Org.SITES_KEY], mine);
});

test("org: a settled fleet writes the cache once, not per beat (XERK-2435)", () => {
  mountOrg();
  const fleet = { agents: [agent("a", "acme.atlassian.net")] };
  Org.update(fleet);
  const setItem = global.localStorage.setItem;
  let writes = 0;
  global.localStorage.setItem = (k, v) => { if (k === Org.SITES_KEY) writes++; setItem(k, v); };
  Org.update(fleet);
  Org.update(fleet);
  assert.equal(writes, 0);
});

test("org: throwing storage leaves the cache write harmless (XERK-2435)", () => {
  const { slot } = mountOrg();
  const boom = () => { throw new Error("SecurityError"); };
  global.localStorage.getItem = boom;
  global.localStorage.setItem = boom;
  Org.update({ agents: [agent("a", "acme.atlassian.net")] });
  assert.match(slot.innerHTML, /org-btn/);
});

test("org: a cached org name is escaped into the button label", () => {
  // The cache is a second way an org name reaches the slot's innerHTML.
  const { slot } = mountOrg({
    storedOrg: "x.atlassian.net",
    storedSites: JSON.stringify({ sites: [{ siteKey: "x.atlassian.net", orgName: "<img src=x onerror=alert(1)>" }] }),
  });
  assert.doesNotMatch(slot.innerHTML, /<img/);
  assert.match(slot.innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test("org: a malformed org cache degrades to an empty slot", () => {
  for (const raw of ["not json", "[]", '{"sites":"x"}', '{"sites":[null,{"siteKey":5},{"siteKey":""}]}']) {
    const { slot } = mountOrg({ storedSites: raw });
    assert.equal(slot.innerHTML, "", raw);
    assert.deepEqual(Org.cachedSites(), []);
  }
  const { slot } = mountOrg({ storedSites: '{"sites":[{"siteKey":"a.atlassian.net","orgName":{"x":1}}],"colorPins":{"a.atlassian.net":"red"}}' });
  assert.match(slot.innerHTML, /org-btn/);
  assert.deepEqual(Org.cachedSites(), [{ siteKey: "a.atlassian.net", orgName: "", source: "" }]);
});

test("org: an existing board-only pick is migrated to the shared key", () => {
  const { store } = mountOrg({ storedBoardOrg: "acme.atlassian.net" });
  Org.update({ agents: [agent("a", "acme.atlassian.net")] });
  // The operator's board filter follows them onto every page instead of
  // silently resetting to "all orgs" on upgrade.
  assert.equal(Org.get(), "acme.atlassian.net");
  assert.equal(store[Org.KEY], "acme.atlassian.net");
});

test("org: picking orgs toggles them into the selection and notifies every page", () => {
  const { store, click } = mountOrg();
  const seen = [];
  Org.subscribe((k) => seen.push(k));
  Org.update({ agents: [agent("a", "acme.atlassian.net"), agent("b", "dev.azure.com/xerk")] });
  click("data-org-key", "acme.atlassian.net");
  assert.deepEqual(Org.getKeys(), ["acme.atlassian.net"]);
  assert.equal(Org.get(), "acme.atlassian.net");
  assert.equal(store[Org.KEY], JSON.stringify(["acme.atlassian.net"]));
  assert.deepEqual(seen, [["acme.atlassian.net"]]);
  // A second org joins the selection instead of replacing it (XERK-222)…
  click("data-org-key", "dev.azure.com/xerk");
  assert.deepEqual(Org.getKeys(), ["acme.atlassian.net", "dev.azure.com/xerk"]);
  assert.equal(Org.get(), "");           // the single-key read only answers for one
  assert.equal(store[Org.KEY], JSON.stringify(["acme.atlassian.net", "dev.azure.com/xerk"]));
  // …and re-picking a selected org toggles it back OUT (un-highlights).
  click("data-org-key", "acme.atlassian.net");
  assert.deepEqual(Org.getKeys(), ["dev.azure.com/xerk"]);
  assert.equal(store[Org.KEY], JSON.stringify(["dev.azure.com/xerk"]));
  assert.equal(seen.length, 3);
});

test("org: the All-orgs row clears the whole selection", () => {
  const { store, click } = mountOrg();
  Org.update({ agents: [agent("a", "acme.atlassian.net"), agent("b", "dev.azure.com/xerk")] });
  click("data-org-key", "acme.atlassian.net");
  click("data-org-key", "dev.azure.com/xerk");
  click("data-org-key", "");
  assert.deepEqual(Org.getKeys(), []);
  assert.equal(store[Org.KEY], "");
});

test("org: the stored selection round-trips as JSON; pre-multi and junk degrade sanely", () => {
  assert.deepEqual(Org.parseStored(""), []);
  // The pre-multi format was the bare siteKey — it reads as a one-org selection.
  assert.deepEqual(Org.parseStored("acme.atlassian.net"), ["acme.atlassian.net"]);
  assert.deepEqual(Org.parseStored('["a","b"]'), ["a", "b"]);
  // Malformed JSON and non-string members degrade to "no selection"/dropped,
  // never a throw — this runs at mount on whatever localStorage holds.
  assert.deepEqual(Org.parseStored("["), []);
  assert.deepEqual(Org.parseStored('[1,"a",null,""]'), ["a"]);
  assert.equal(Org.encodeStored([]), "");
  assert.deepEqual(Org.parseStored(Org.encodeStored(["a", "b"])), ["a", "b"]);
});

test("org: a pick whose org stops reporting stops applying, keeping the stored value", () => {
  const { store, click } = mountOrg();
  Org.update({ agents: [agent("a", "acme.atlassian.net"), agent("b", "dev.azure.com/xerk")] });
  click("data-org-key", "acme.atlassian.net");
  // That host goes away entirely (removed, not merely offline).
  Org.update({ agents: [agent("b", "dev.azure.com/xerk")] });
  assert.deepEqual(Org.getKeys(), []);
  // It comes back when the host does.
  assert.equal(store[Org.KEY], JSON.stringify(["acme.atlassian.net"]));
  Org.update({ agents: [agent("a", "acme.atlassian.net"), agent("b", "dev.azure.com/xerk")] });
  assert.deepEqual(Org.getKeys(), ["acme.atlassian.net"]);
});

test("org: the menu stays open across org toggles; All orgs closes it", () => {
  const { slot, click } = mountOrg();
  Org.update({ agents: [agent("a", "acme.atlassian.net"), agent("b", "dev.azure.com/xerk")] });
  assert.doesNotMatch(slot.innerHTML, /org-menu/);
  click("data-org-toggle", "");
  assert.match(slot.innerHTML, /org-menu/);
  // Multi-select means picking several in one visit, so a toggle must not
  // close the menu — the just-picked row shows highlighted in place.
  click("data-org-key", "acme.atlassian.net");
  assert.match(slot.innerHTML, /org-menu/);
  assert.match(slot.innerHTML, /data-org-key="acme\.atlassian\.net"[^>]*aria-checked="true"/);
  click("data-org-key", "dev.azure.com/xerk");
  assert.match(slot.innerHTML, /org-menu/);
  // "All orgs" is a terminal answer: clear and close.
  click("data-org-key", "");
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

// A long menu scrolls (XERK-1285), so a repaint (a ticket count, a "synced
// Nm ago" age) must keep the menu's scroll and the focused row, or a keyboard
// user deep in the list lands back at the top with focus on <body>.
test("org: a repaint keeps the menu's scroll and the focused control", () => {
  const { slot, click } = mountOrg();
  Org.update({ agents: [agent("a", "acme.atlassian.net")] });
  click("data-org-toggle", "");
  const focused = { attributes: [{ name: "class", value: "org-row-main" },
    { name: "data-org-key", value: "acme.atlassian.net" }] };
  const again = { focus(opts) { this.focusedWith = opts; } };
  let asked = null, wrapped = 0;
  slot.ownerDocument = { activeElement: focused };
  slot.querySelector = (sel) => { asked = sel; return again; };
  global.CSS = { escape: (s) => s.replace(/"/g, '\\"') };
  global.window.TurmaNav = { preserveScroll(container, paint) {
    assert.equal(container, slot); wrapped++; paint();
  } };
  try {
    Org.update({ agents: [{ ...agent("a", "acme.atlassian.net"),
      jira: { siteKey: "acme.atlassian.net", available: true, tickets: [{ key: "A-1" }] } }] });
    assert.equal(wrapped, 1, "the swap goes through preserveScroll");
    assert.match(slot.innerHTML, /org-menu/);
    assert.equal(asked, '[data-org-key="acme.atlassian.net"]');
    assert.deepEqual(again.focusedWith, { preventScroll: true }, "focus returns to the same row");
  } finally {
    delete global.window.TurmaNav; delete global.CSS;
  }
});

// XERK-1584 #4: closing the menu (All orgs, Escape) or losing a host drops the
// focused row; focus goes back to the menu button, never <body>.
test("org: a focused control the repaint drops hands focus to the menu button", () => {
  const { slot, click } = mountOrg();
  Org.update({ agents: [agent("a", "acme.atlassian.net")] });
  click("data-org-toggle", "");
  const focused = { attributes: [{ name: "data-org-key", value: "acme.atlassian.net" }] };
  const toggle = { focus(opts) { this.focusedWith = opts; } };
  const asked = [];
  slot.ownerDocument = { activeElement: focused };
  slot.querySelector = (sel) => { asked.push(sel); return sel === "[data-org-toggle]" ? toggle : null; };
  global.CSS = { escape: (s) => s };
  try {
    click("data-org-key", "");                           // "All orgs" closes the menu
    assert.doesNotMatch(slot.innerHTML, /org-menu/);
    assert.deepEqual(asked, ['[data-org-key="acme.atlassian.net"]', "[data-org-toggle]"]);
    assert.deepEqual(toggle.focusedWith, { preventScroll: true });
  } finally {
    delete global.CSS;
  }
});

// Nothing in the control had focus: a repaint moves no one's focus.
test("org: a repaint with no focused control focuses nothing", () => {
  const { slot, click } = mountOrg();
  Org.update({ agents: [agent("a", "acme.atlassian.net")] });
  let asked = 0;
  slot.ownerDocument = { activeElement: null };
  slot.querySelector = () => { asked++; return { focus() { throw new Error("focused"); } }; };
  click("data-org-toggle", "");
  assert.equal(asked, 0);
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

test("org: autoOn reads own keys only — prototype-member org names (XERK-1486)", () => {
  for (const k of ["constructor", "toString", "valueOf", "__proto__"]) {
    assert.equal(Org.autoOn({}, k), false, k);
    assert.equal(Org.autoOn(JSON.parse(`{${JSON.stringify(k)}:true}`), k), true, k);
  }
});

test("org: toggling a __proto__ / constructor org paints that org's switch (XERK-1486)", async () => {
  for (const k of ["__proto__", "constructor"]) {
    const { slot, click } = mountOrg();
    Org.update({ agents: [agent("a", k)], autoStartOrgs: {}, autoMergeOrgs: {} });
    click("data-org-toggle", "");
    assert.doesNotMatch(slot.innerHTML, /org-chip-auto on/, `${k}: hub has it OFF`);
    const posts = [];
    global.fetch = (url, init) => {
      posts.push(JSON.parse(init.body));
      return Promise.resolve({ ok: true, status: 200 });
    };
    await Org.setAutoStart(k, true);
    assert.deepEqual(posts, [{ enabled: true }], `${k}: an OFF org's click turns it ON`);
    assert.match(slot.innerHTML, /org-chip-auto on/, `${k}: the switch paints ON`);
    await Org.setAutoStart(k, false);
    assert.doesNotMatch(slot.innerHTML, /org-chip-auto on/, `${k}: and back OFF`);
  }
});

// ---- manual org colors (XERK-145) ------------------------------------------

test("org: each org row carries a color chip; the swatch strip only when expanded", () => {
  const sites = [site("acme.atlassian.net"), site("dev.azure.com/xerk")];
  const colors = window.TurmaBoard.orgColorMap(sites.map(s => s.siteKey));
  const closed = Org.menuHtml(sites, "", colors, {}, {}, () => "", {},null);
  assert.equal((closed.match(/data-org-color=/g) || []).length, 2);
  assert.doesNotMatch(closed, /org-swatch-row/);
  const open = Org.menuHtml(sites, "", colors, {}, {}, () => "", {},"acme.atlassian.net");
  assert.equal((open.match(/class="org-swatch-row"/g) || []).length, 1);
  // 8 slot swatches + the auto release, keyed to the expanded org.
  assert.equal((open.match(/data-org-swatch="\d+"/g) || []).length, 8);
  assert.match(open, /data-org-swatch="auto"/);
  assert.match(open, /data-org-swatch-key="acme\.atlassian\.net"/);
});

test("org: the swatch strip marks the pinned slot, else the auto release", () => {
  const sites = [site("acme.atlassian.net")];
  const colors = window.TurmaBoard.orgColorMap(["acme.atlassian.net"], { "acme.atlassian.net": 3 });
  const pinned = Org.menuHtml(sites, "", colors, {}, {}, () => "", { "acme.atlassian.net": 3 },"acme.atlassian.net");
  assert.match(pinned, /class="org-swatch picked"[^>]*data-org-swatch="3"/);
  assert.doesNotMatch(pinned, /org-swatch-auto picked/);
  const unpinned = Org.menuHtml(sites, "", colors, {}, {}, () => "", {},"acme.atlassian.net");
  assert.doesNotMatch(unpinned, /org-swatch picked/);
  assert.match(unpinned, /org-swatch-auto picked/);
});

test("org: a swatch pick paints optimistically, POSTs, and rolls back on failure", async () => {
  const { slot, click } = mountOrg();
  const seen = [];
  Org.subscribe(() => seen.push(1));
  Org.update({ agents: [agent("a", "acme.atlassian.net")], orgColors: {} });
  click("data-org-toggle", "");
  click("data-org-color", "acme.atlassian.net");         // expand the strip
  assert.match(slot.innerHTML, /org-swatch-row/);
  const posts = [];
  global.fetch = (url, init) => {
    posts.push({ url, body: JSON.parse(init.body) });
    return Promise.resolve({ ok: false, status: 500 });
  };
  const p = Org.setOrgColor("acme.atlassian.net", 5);
  // Painted (and pages notified, so their card tints follow) before the POST
  // settles; the strip closes on the pick.
  assert.deepEqual({ ...Org.orgColors() }, { "acme.atlassian.net": 5 });
  assert.doesNotMatch(slot.innerHTML, /org-swatch-row/);
  assert.ok(seen.length >= 1);
  await p;
  assert.deepEqual(posts, [{ url: "/api/jira/acme.atlassian.net/color", body: { slot: 5 } }]);
  assert.deepEqual({ ...Org.orgColors() }, {});
});

test("org: releasing a pin POSTs {auto:true}", async () => {
  mountOrg();
  Org.update({ agents: [agent("a", "acme.atlassian.net")], orgColors: { "acme.atlassian.net": 5 } });
  const posts = [];
  global.fetch = (url, init) => {
    posts.push({ url, body: JSON.parse(init.body) });
    return Promise.resolve({ ok: true, status: 200 });
  };
  await Org.setOrgColor("acme.atlassian.net", null);
  assert.deepEqual(posts, [{ url: "/api/jira/acme.atlassian.net/color", body: { auto: true } }]);
  assert.deepEqual({ ...Org.orgColors() }, {});
});

test("org: the hub's orgColors broadcast updates the pins and notifies the pages", () => {
  const { slot } = mountOrg();
  const seen = [];
  Org.subscribe(() => seen.push(1));
  Org.update({ agents: [agent("a", "acme.atlassian.net")] });
  const handlers = {};
  Org.sse({ addEventListener: (t, fn) => { handlers[t] = fn; } });
  handlers.orgColors({ data: JSON.stringify({ "acme.atlassian.net": 2 }) });
  assert.deepEqual(Org.orgColors(), { "acme.atlassian.net": 2 });
  assert.equal(seen.length, 1);
  // The button's dot follows the pin (the control repaints from the new map).
  assert.match(slot.innerHTML, /org-filter/);
  // Malformed payloads are ignored rather than blanking the pins.
  handlers.orgColors({ data: "{" });
  assert.deepEqual(Org.orgColors(), { "acme.atlassian.net": 2 });
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

test("XERK-2598: a re-render with the same stale cache never reverts an SSE-moved switch", () => {
  const { slot, click } = mountOrg();
  // A page's cache object, fetched once; no page writes autoStartOrgs back from SSE.
  const cache = { agents: [agent("a", "acme.atlassian.net")], autoStartOrgs: {}, autoMergeOrgs: {} };
  Org.update(cache);
  click("data-org-toggle", "");
  const handlers = {};
  Org.sse({ addEventListener: (t, fn) => { handlers[t] = fn; } });
  handlers.autoStartOrgs({ data: JSON.stringify({ "acme.atlassian.net": true }) });
  handlers.autoMergeOrgs({ data: JSON.stringify({ "acme.atlassian.net": true }) });
  Org.update(cache);                                     // the next beat's render
  assert.match(slot.innerHTML, /org-chip-auto on/);
  assert.match(slot.innerHTML, /org-chip-merge on/);
  // A NEW snapshot (a refetch) is still the hub's word and is adopted.
  Org.update({ ...cache, autoStartOrgs: {}, autoMergeOrgs: {} });
  assert.doesNotMatch(slot.innerHTML, /org-chip-auto on/);
  assert.doesNotMatch(slot.innerHTML, /org-chip-merge on/);
});

test("XERK-2598: an optimistic flip survives a re-render before the POST settles", async () => {
  const { slot, click } = mountOrg();
  const cache = { agents: [agent("a", "acme.atlassian.net")], autoStartOrgs: {} };
  Org.update(cache);
  click("data-org-toggle", "");
  let settle;
  global.fetch = () => new Promise((res) => { settle = res; });
  const p = Org.setAutoStart("acme.atlassian.net", true);
  Org.update(cache);                                     // a beat lands mid-POST
  assert.match(slot.innerHTML, /org-chip-auto on/);
  settle({ ok: true, status: 200 });
  await p;
  assert.match(slot.innerHTML, /org-chip-auto on/);
});

test("XERK-2598: a network-failed POST re-reads the hub instead of rolling back blindly", async () => {
  const { slot, click } = mountOrg();
  Org.update({ agents: [agent("a", "acme.atlassian.net")], autoStartOrgs: {}, orgColors: {} });
  click("data-org-toggle", "");
  const urls = [];
  global.fetch = (url) => {
    urls.push(url);
    // The hub applied the flip but the response was lost.
    if (url.endsWith("/autostart")) return Promise.reject(new TypeError("network"));
    return Promise.resolve({ ok: true, status: 200,
      json: async () => ({ agents: [], autoStartOrgs: { "acme.atlassian.net": true } }) });
  };
  await Org.setAutoStart("acme.atlassian.net", true);
  assert.deepEqual(urls, ["/api/jira/acme.atlassian.net/autostart", "/api/agents"]);
  assert.match(slot.innerHTML, /org-chip-auto on/);

  // The hub did NOT apply a color pin: the re-read says so, and the pin goes.
  global.fetch = (url) => url.endsWith("/color") ? Promise.reject(new TypeError("network"))
    : Promise.resolve({ ok: true, status: 200, json: async () => ({ agents: [], orgColors: {} }) });
  await Org.setOrgColor("acme.atlassian.net", 4);
  assert.deepEqual({ ...Org.orgColors() }, {});
});

test("XERK-2598: a slow re-read changes only the failed org, never another org's newer state", async () => {
  const { slot, click } = mountOrg();
  Org.update({ agents: [agent("a", "acme.atlassian.net"), agent("b", "beta.atlassian.net")],
    autoStartOrgs: {} });
  click("data-org-toggle", "");
  const handlers = {};
  Org.sse({ addEventListener: (t, fn) => { handlers[t] = fn; } });
  let release;
  global.fetch = (url) => url.endsWith("/autostart") ? Promise.reject(new TypeError("network"))
    : new Promise((res) => { release = res; });
  const p = Org.setAutoStart("acme.atlassian.net", true);
  await new Promise((r) => setImmediate(r));             // the re-read is now in flight
  handlers.autoStartOrgs({ data: JSON.stringify({ "acme.atlassian.net": true, "beta.atlassian.net": true }) });
  // The held body predates beta's change.
  release({ ok: true, status: 200, json: async () => ({ autoStartOrgs: { "acme.atlassian.net": true } }) });
  await p;
  const on = (k) => new RegExp(`org-chip-auto on" data-org-auto="${k.replace(/\./g, "\\.")}"`).test(slot.innerHTML);
  assert.ok(on("beta.atlassian.net"), "beta keeps the SSE state");
  assert.ok(on("acme.atlassian.net"), "acme takes the hub's word");
});

test("XERK-2598: a re-read saying the hub did NOT apply it repaints the switch off", async () => {
  const { slot, click } = mountOrg();
  Org.update({ agents: [agent("a", "acme.atlassian.net")], autoStartOrgs: {} });
  click("data-org-toggle", "");
  global.fetch = (url) => url.endsWith("/autostart") ? Promise.reject(new TypeError("network"))
    : Promise.resolve({ ok: true, status: 200, json: async () => ({ autoStartOrgs: {} }) });
  await Org.setAutoStart("acme.atlassian.net", true);
  assert.doesNotMatch(slot.innerHTML, /org-chip-auto on/);
});

test("XERK-2598: an HTTP refusal rolls back with no re-read; a refused re-read rolls back", async () => {
  const { slot, click } = mountOrg();
  Org.update({ agents: [agent("a", "acme.atlassian.net")], autoStartOrgs: {} });
  click("data-org-toggle", "");
  const urls = [];
  global.fetch = (url) => { urls.push(url);
    return Promise.resolve({ ok: false, status: 500, json: async () => ({ autoStartOrgs: { "acme.atlassian.net": true } }) }); };
  await Org.setAutoStart("acme.atlassian.net", true);
  assert.deepEqual(urls, ["/api/jira/acme.atlassian.net/autostart"]);
  assert.doesNotMatch(slot.innerHTML, /org-chip-auto on/);
  // Network-failed POST + a non-2xx re-read (a JSON error body) is no answer.
  global.fetch = (url) => url.endsWith("/autostart") ? Promise.reject(new TypeError("network"))
    : Promise.resolve({ ok: false, status: 503, json: async () => ({ autoStartOrgs: { "acme.atlassian.net": true } }) });
  await Org.setAutoStart("acme.atlassian.net", true);
  assert.doesNotMatch(slot.innerHTML, /org-chip-auto on/);
});

test("XERK-2598: re-rendering the same cache keeps an SSE-moved color pin", () => {
  mountOrg();
  const cache = { agents: [agent("a", "acme.atlassian.net")], orgColors: {} };
  Org.update(cache);
  const handlers = {};
  Org.sse({ addEventListener: (t, fn) => { handlers[t] = fn; } });
  handlers.orgColors({ data: JSON.stringify({ "acme.atlassian.net": 4 }) });
  Org.update(cache);
  assert.deepEqual({ ...Org.orgColors() }, { "acme.atlassian.net": 4 });
});

test("XERK-2598: a stale re-read never overrides a NEWER click on the same org", async () => {
  const { slot, click } = mountOrg();
  Org.update({ agents: [agent("a", "acme.atlassian.net")], autoStartOrgs: {} });
  click("data-org-toggle", "");
  let release;
  let n = 0;
  global.fetch = (url) => {
    if (url.endsWith("/autostart")) return ++n === 1 ? Promise.reject(new TypeError("network"))
      : Promise.resolve({ ok: true, status: 200 });
    return new Promise((res) => { release = res; });
  };
  const first = Org.setAutoStart("acme.atlassian.net", true);   // response lost; re-read held
  await new Promise((r) => setImmediate(r));
  await Org.setAutoStart("acme.atlassian.net", false);          // newer click, hub says OK
  release({ ok: true, status: 200, json: async () => ({ autoStartOrgs: { "acme.atlassian.net": true } }) });
  await first;
  assert.doesNotMatch(slot.innerHTML, /org-chip-auto on/);
});

test("XERK-2598: an SSE update to the failed org during the re-read is kept", async () => {
  const { slot, click } = mountOrg();
  Org.update({ agents: [agent("a", "acme.atlassian.net")], autoMergeOrgs: {} });
  click("data-org-toggle", "");
  const handlers = {};
  Org.sse({ addEventListener: (t, fn) => { handlers[t] = fn; } });
  let release;
  global.fetch = (url) => url.endsWith("/automerge") ? Promise.reject(new TypeError("network"))
    : new Promise((res) => { release = res; });
  const p = Org.setAutoMerge("acme.atlassian.net", true);
  await new Promise((r) => setImmediate(r));
  handlers.autoMergeOrgs({ data: "{}" });                       // the hub's newer word: off
  release({ ok: true, status: 200, json: async () => ({ autoMergeOrgs: { "acme.atlassian.net": true } }) });
  await p;
  assert.doesNotMatch(slot.innerHTML, /org-chip-merge on/);
});

test("XERK-2598: the auto-merge re-read takes the hub's word for that org only", async () => {
  const { slot, click } = mountOrg();
  Org.update({ agents: [agent("a", "acme.atlassian.net"), agent("b", "beta.atlassian.net")],
    autoMergeOrgs: {} });
  click("data-org-toggle", "");
  const handlers = {};
  Org.sse({ addEventListener: (t, fn) => { handlers[t] = fn; } });
  let release;
  global.fetch = (url) => url.endsWith("/automerge") ? Promise.reject(new TypeError("network"))
    : new Promise((res) => { release = res; });
  const p = Org.setAutoMerge("acme.atlassian.net", true);
  await new Promise((r) => setImmediate(r));
  handlers.autoMergeOrgs({ data: JSON.stringify({ "acme.atlassian.net": true, "beta.atlassian.net": true }) });
  release({ ok: true, status: 200, json: async () => ({ autoMergeOrgs: {} }) });  // older body
  await p;
  const on = (k) => new RegExp(`org-chip-merge on" data-org-merge="${k.replace(/\./g, "\\.")}"`).test(slot.innerHTML);
  assert.ok(on("beta.atlassian.net"), "beta keeps the SSE state");
  assert.ok(on("acme.atlassian.net"), "acme's SSE state is newer than the held body");
  // With no SSE in between, the re-read decides: the hub APPLIED this off-click
  // (its acme entry is gone), so the switch stays off rather than rolling back.
  global.fetch = (url) => url.endsWith("/automerge") ? Promise.reject(new TypeError("network"))
    : Promise.resolve({ ok: true, status: 200, json: async () => ({ autoMergeOrgs: {} }) });
  await Org.setAutoMerge("acme.atlassian.net", false);
  assert.ok(!on("acme.atlassian.net"), "the hub has acme off");
  assert.ok(on("beta.atlassian.net"), "beta is not in the body but is left alone");
});

test("XERK-2598: the color re-read takes that org's pin only, repaints and notifies", async () => {
  mountOrg();
  Org.update({ agents: [agent("a", "acme.atlassian.net"), agent("b", "beta.atlassian.net")], orgColors: {} });
  const handlers = {};
  Org.sse({ addEventListener: (t, fn) => { handlers[t] = fn; } });
  let seen = 0;
  Org.subscribe(() => { seen++; });
  let release;
  global.fetch = (url) => url.endsWith("/color") ? Promise.reject(new TypeError("network"))
    : new Promise((res) => { release = res; });
  const p = Org.setOrgColor("acme.atlassian.net", 4);
  await new Promise((r) => setImmediate(r));
  handlers.orgColors({ data: JSON.stringify({ "acme.atlassian.net": 4, "beta.atlassian.net": 6 }) });
  release({ ok: true, status: 200, json: async () => ({ orgColors: { "acme.atlassian.net": 2 } }) });
  await p;
  // acme's SSE pin (4) is newer than the held body; beta's SSE pin survives.
  assert.deepEqual({ ...Org.orgColors() }, { "acme.atlassian.net": 4, "beta.atlassian.net": 6 });
  // No SSE in between: the hub's word for acme wins, beta is left alone.
  global.fetch = (url) => url.endsWith("/color") ? Promise.reject(new TypeError("network"))
    : Promise.resolve({ ok: true, status: 200, json: async () => ({ orgColors: { "acme.atlassian.net": 2 } }) });
  const before = seen;
  await Org.setOrgColor("acme.atlassian.net", 7);
  assert.deepEqual({ ...Org.orgColors() }, { "acme.atlassian.net": 2, "beta.atlassian.net": 6 });
  assert.ok(seen >= before + 2, "notified on the flip AND on the hub's answer");
});

const autoIsOn = (slot, k) => new RegExp(`org-chip-auto on" data-org-auto="${k.replace(/\./g, "\\.")}"`).test(slot.innerHTML);
const tick = () => new Promise((r) => setImmediate(r));

test("XERK-2598: two failed clicks on one org end at the hub's word, in either order", async () => {
  for (const order of ["newer-fails-first", "older-fails-first"]) {
    const { slot, click } = mountOrg();
    Org.update({ agents: [agent("a", "acme.atlassian.net")], autoStartOrgs: {} });   // hub: off
    click("data-org-toggle", "");
    const pending = [];
    global.fetch = () => new Promise((res) => pending.push(res));
    const c1 = Org.setAutoStart("acme.atlassian.net", true);    // shows on, unconfirmed
    const c2 = Org.setAutoStart("acme.atlassian.net", false);
    const fail = (i) => pending[i]({ ok: false, status: 500 });
    if (order === "newer-fails-first") { fail(1); await c2; fail(0); await c1; }
    else { fail(0); await c1; fail(1); await c2; }
    assert.ok(!autoIsOn(slot, "acme.atlassian.net"), order);
  }
});

test("XERK-2598: the re-read's own org is taken; another org's pending flip is kept", async () => {
  const { slot, click } = mountOrg();
  Org.update({ agents: [agent("a", "acme.atlassian.net"), agent("b", "beta.atlassian.net")], autoStartOrgs: {} });
  click("data-org-toggle", "");
  global.fetch = (url) => {
    if (url.includes("beta")) return new Promise(() => {});                 // beta's POST still in flight
    if (url.endsWith("/autostart")) return Promise.reject(new TypeError("network"));
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ autoStartOrgs: { "acme.atlassian.net": true } }) });
  };
  Org.setAutoStart("beta.atlassian.net", true);
  await Org.setAutoStart("acme.atlassian.net", true);
  assert.ok(autoIsOn(slot, "acme.atlassian.net"), "acme: the hub applied it");
  assert.ok(autoIsOn(slot, "beta.atlassian.net"), "beta: its own click is still pending");
});

test("XERK-2598: an SSE frame landing during the re-read beats the re-read body", async () => {
  const { slot, click } = mountOrg();
  Org.update({ agents: [agent("a", "acme.atlassian.net")], autoStartOrgs: {} });
  click("data-org-toggle", "");
  const handlers = {};
  Org.sse({ addEventListener: (t, fn) => { handlers[t] = fn; } });
  let release;
  global.fetch = (url) => url.endsWith("/autostart") ? Promise.reject(new TypeError("network"))
    : new Promise((res) => { release = res; });
  const p = Org.setAutoStart("acme.atlassian.net", true);
  await tick();
  handlers.autoStartOrgs({ data: "{}" });                               // newer: off
  release({ ok: true, status: 200, json: async () => ({ autoStartOrgs: { "acme.atlassian.net": true } }) });
  await p;
  assert.ok(!autoIsOn(slot, "acme.atlassian.net"));
});

test("XERK-2598: a click on another org never suppresses this org's outcome", async () => {
  const { slot, click } = mountOrg();
  Org.update({ agents: [agent("a", "acme.atlassian.net"), agent("b", "beta.atlassian.net")], autoStartOrgs: {} });
  click("data-org-toggle", "");
  let release;
  global.fetch = (url) => {
    if (url.includes("beta")) return Promise.resolve({ ok: true, status: 200 });
    if (url.endsWith("/autostart")) return Promise.reject(new TypeError("network"));
    return new Promise((res) => { release = res; });
  };
  const p = Org.setAutoStart("acme.atlassian.net", true);
  await tick();
  await Org.setAutoStart("beta.atlassian.net", true);
  release({ ok: true, status: 200, json: async () => ({ autoStartOrgs: {} }) });    // acme not applied
  await p;
  assert.ok(!autoIsOn(slot, "acme.atlassian.net"), "acme resolves to the hub's word");
  assert.ok(autoIsOn(slot, "beta.atlassian.net"));
});

test("XERK-2598: an OK POST is the hub's word that a later failed click falls back to", async () => {
  const { slot, click } = mountOrg();
  Org.update({ agents: [agent("a", "acme.atlassian.net")], autoStartOrgs: {} });
  click("data-org-toggle", "");
  global.fetch = () => Promise.resolve({ ok: true, status: 200 });
  await Org.setAutoStart("acme.atlassian.net", true);              // the hub took it: on
  global.fetch = () => Promise.resolve({ ok: false, status: 500 });
  await Org.setAutoStart("acme.atlassian.net", false);             // refused
  assert.ok(autoIsOn(slot, "acme.atlassian.net"), "back to on, not to the stale snapshot's off");
});

const mergeIsOn = (slot, k) => new RegExp(`org-chip-merge on" data-org-merge="${k.replace(/\./g, "\\.")}"`).test(slot.innerHTML);

test("XERK-2598: a late 200 never outvotes a newer click or another client's SSE frame", async () => {
  for (const newer of ["same-tab click", "another client"]) {
    const { slot, click } = mountOrg();
    Org.update({ agents: [agent("a", "acme.atlassian.net")], autoMergeOrgs: { "acme.atlassian.net": true } });
    click("data-org-toggle", "");
    const handlers = {};
    Org.sse({ addEventListener: (t, fn) => { handlers[t] = fn; } });
    let release;
    global.fetch = () => new Promise((res) => { release = res; });
    const c1 = Org.setAutoMerge("acme.atlassian.net", false);          // hub applies it, 200 held
    await tick();
    const held = release;
    if (newer === "same-tab click") {
      global.fetch = () => Promise.resolve({ ok: true, status: 200 });
      await Org.setAutoMerge("acme.atlassian.net", true);             // hub: on again
    } else {
      handlers.autoMergeOrgs({ data: JSON.stringify({ "acme.atlassian.net": true }) });
    }
    held({ ok: true, status: 200 });                                   // the stale "off" lands
    await c1;
    global.fetch = () => Promise.resolve({ ok: false, status: 500 });
    await Org.setAutoMerge("acme.atlassian.net", false);              // refused
    assert.ok(mergeIsOn(slot, "acme.atlassian.net"), `${newer}: the hub still merges`);
  }
});

test("XERK-2598: an older click's late re-read never becomes the hub's word", async () => {
  const { slot, click } = mountOrg();
  Org.update({ agents: [agent("a", "acme.atlassian.net")], autoStartOrgs: {} });
  click("data-org-toggle", "");
  let release;
  global.fetch = (url) => url.endsWith("/autostart") ? Promise.reject(new TypeError("network"))
    : new Promise((res) => { release = res; });
  const c1 = Org.setAutoStart("acme.atlassian.net", true);             // lost; re-read held
  await tick();
  global.fetch = () => Promise.resolve({ ok: true, status: 200 });
  await Org.setAutoStart("acme.atlassian.net", false);                 // newer: hub off
  release({ ok: true, status: 200, json: async () => ({ autoStartOrgs: { "acme.atlassian.net": true } }) });
  await c1;
  global.fetch = () => Promise.resolve({ ok: false, status: 500 });
  await Org.setAutoStart("acme.atlassian.net", true);                  // refused
  assert.ok(!autoIsOn(slot, "acme.atlassian.net"), "the hub has it off");
});

test("XERK-2598: a new snapshot is the hub's word for auto-merge and colors too", async () => {
  const { slot, click } = mountOrg();
  Org.update({ agents: [agent("a", "snap.atlassian.net")], autoMergeOrgs: {}, orgColors: {} });
  Org.update({ agents: [agent("a", "snap.atlassian.net")],
    autoMergeOrgs: { "snap.atlassian.net": true }, orgColors: { "snap.atlassian.net": 3 } });
  click("data-org-toggle", "");
  global.fetch = () => Promise.resolve({ ok: false, status: 500 });
  await Org.setAutoMerge("snap.atlassian.net", false);
  assert.ok(mergeIsOn(slot, "snap.atlassian.net"));
  await Org.setOrgColor("snap.atlassian.net", 6);
  assert.deepEqual({ ...Org.orgColors() }, { "snap.atlassian.net": 3 });
});

test("XERK-2598: the re-read confirms only its own org, never another org's stale entry", async () => {
  const { slot, click } = mountOrg();
  Org.update({ agents: [agent("a", "acme.atlassian.net"), agent("b", "beta.atlassian.net")],
    autoStartOrgs: { "beta.atlassian.net": true } });
  click("data-org-toggle", "");
  // acme's lost POST re-reads a body that (stale or not) lacks beta.
  global.fetch = (url) => url.endsWith("/autostart") ? Promise.reject(new TypeError("network"))
    : Promise.resolve({ ok: true, status: 200, json: async () => ({ autoStartOrgs: { "acme.atlassian.net": true } }) });
  await Org.setAutoStart("acme.atlassian.net", true);
  // beta's next click is refused: it falls back to beta's confirmed "on".
  global.fetch = () => Promise.resolve({ ok: false, status: 500 });
  await Org.setAutoStart("beta.atlassian.net", false);
  assert.ok(autoIsOn(slot, "beta.atlassian.net"));
});

test("XERK-2598: with SSE down, an older click's late success still counts once the newer fails", async () => {
  for (const kind of ["auto", "merge", "color"]) {
    for (const order of ["older-first", "newer-first"]) {
      const { slot, click } = mountOrg();
      Org.update({ agents: [agent("a", "acme.atlassian.net")], autoStartOrgs: {}, autoMergeOrgs: {}, orgColors: {} });
      click("data-org-toggle", "");
      const pending = [];
      global.fetch = () => new Promise((res) => pending.push(res));
      const set = (on) => kind === "auto" ? Org.setAutoStart("acme.atlassian.net", on)
        : kind === "merge" ? Org.setAutoMerge("acme.atlassian.net", on)
        : Org.setOrgColor("acme.atlassian.net", on ? 3 : null);
      const a = set(true);                                             // hub applies it
      const b = set(false);                                            // hub refuses it
      const okA = () => pending[0]({ ok: true, status: 200 });
      const failB = () => pending[1]({ ok: false, status: 500 });
      if (order === "older-first") { okA(); await a; failB(); await b; }
      else { failB(); await b; okA(); await a; }
      const shown = kind === "auto" ? autoIsOn(slot, "acme.atlassian.net")
        : kind === "merge" ? mergeIsOn(slot, "acme.atlassian.net")
        : Org.orgColors()["acme.atlassian.net"] === 3;
      assert.ok(shown, `${kind} ${order}: the hub has it on`);
    }
  }
});

test("XERK-2598: an older click's lost response re-read counts when the newer click fails", async () => {
  const { slot, click } = mountOrg();
  Org.update({ agents: [agent("a", "acme.atlassian.net")], autoMergeOrgs: {} });
  click("data-org-toggle", "");
  let n = 0, releaseRead, failB;
  global.fetch = (url) => {
    if (url === "/api/agents") return new Promise((res) => { releaseRead = res; });
    return ++n === 1 ? Promise.reject(new TypeError("network"))       // A: applied, response lost
      : new Promise((res) => { failB = () => res({ ok: false, status: 500 }); });
  };
  const a = Org.setAutoMerge("acme.atlassian.net", true);
  await tick();
  const b = Org.setAutoMerge("acme.atlassian.net", false);
  releaseRead({ ok: true, status: 200, json: async () => ({ autoMergeOrgs: { "acme.atlassian.net": true } }) });
  await a;
  assert.ok(!mergeIsOn(slot, "acme.atlassian.net"), "B is still in flight: it shows B's off");
  failB();
  await b;
  assert.ok(mergeIsOn(slot, "acme.atlassian.net"), "B refused: the hub's on");
});

test("XERK-2598: an older click's failure never repaints over a newer pending click", async () => {
  const { slot, click } = mountOrg();
  Org.update({ agents: [agent("a", "acme.atlassian.net")], autoStartOrgs: {} });
  click("data-org-toggle", "");
  const pending = [];
  global.fetch = () => new Promise((res) => pending.push(res));
  const a = Org.setAutoStart("acme.atlassian.net", true);
  Org.setAutoStart("acme.atlassian.net", false);
  Org.setAutoStart("acme.atlassian.net", true);                        // newest, pending
  pending[0]({ ok: false, status: 500 });
  await a;
  assert.ok(autoIsOn(slot, "acme.atlassian.net"));
});

test("XERK-2598: a new snapshot is the hub's word for auto-start", async () => {
  const { slot, click } = mountOrg();
  Org.update({ agents: [agent("a", "solo.atlassian.net")], autoStartOrgs: {} });
  Org.update({ agents: [agent("a", "solo.atlassian.net")], autoStartOrgs: { "solo.atlassian.net": true } });
  click("data-org-toggle", "");
  global.fetch = () => Promise.resolve({ ok: false, status: 500 });
  await Org.setAutoStart("solo.atlassian.net", false);
  assert.ok(autoIsOn(slot, "solo.atlassian.net"));
});

test("XERK-2598: a newer click's OK wins over an older click still in flight", async () => {
  for (const kind of ["auto", "merge", "color"]) {
    for (const sse of ["down", "up"]) {
      const site = `d10-${kind}-${sse}.atlassian.net`;
      const { slot, click } = mountOrg();
      Org.update({ agents: [agent("a", site)], autoStartOrgs: {}, autoMergeOrgs: {}, orgColors: {} });
      click("data-org-toggle", "");
      const handlers = {};
      Org.sse({ addEventListener: (t, fn) => { handlers[t] = fn; } });
      let holdA;
      let call = 0;
      global.fetch = () => ++call === 1 ? new Promise((res) => { holdA = res; })
        : Promise.resolve({ ok: true, status: 200 });
      const set = (on) => kind === "auto" ? Org.setAutoStart(site, on)
        : kind === "merge" ? Org.setAutoMerge(site, on) : Org.setOrgColor(site, on ? 3 : null);
      const shown = () => kind === "auto" ? autoIsOn(slot, site)
        : kind === "merge" ? mergeIsOn(slot, site) : Org.orgColors()[site] === 3;
      const a = set(true);                                             // slow; the hub never applies it
      if (sse === "up") {                                              // B's own frame lands before its 200
        const ev = { auto: "autoStartOrgs", merge: "autoMergeOrgs", color: "orgColors" }[kind];
        const b = set(false);
        handlers[ev]({ data: "{}" });
        await b;
      } else await set(false);
      assert.ok(!shown(), `${kind} sse ${sse}: the newer click's OK shows at once`);
      holdA({ ok: false, status: 500 });
      await a;
      assert.ok(!shown(), `${kind} sse ${sse}: and still after the older one fails`);
    }
  }
});

test("XERK-2598: three clicks — the newest OK decides, whatever order the answers land", async () => {
  const site = "three.atlassian.net";
  const { slot, click } = mountOrg();
  Org.update({ agents: [agent("a", site)], autoStartOrgs: {} });
  click("data-org-toggle", "");
  const pending = [];
  global.fetch = () => new Promise((res) => pending.push(res));
  const c1 = Org.setAutoStart(site, true);
  const c2 = Org.setAutoStart(site, false);
  const c3 = Org.setAutoStart(site, true);
  pending[1]({ ok: true, status: 200 });  await c2;                    // off applied
  assert.ok(autoIsOn(slot, site), "c3 is newer and still in flight");
  pending[2]({ ok: false, status: 500 }); await c3;                    // c3 refused
  assert.ok(!autoIsOn(slot, site), "c2's off is the hub's word");
  pending[0]({ ok: true, status: 200 });  await c1;                    // c1's late OK is moot
  assert.ok(!autoIsOn(slot, site), "c1 is older than c2's OK");
});

test("XERK-2598: an older click's late OK never revives a click a newer OK made moot", async () => {
  const site = "moot.atlassian.net";
  const { slot, click } = mountOrg();
  Org.update({ agents: [agent("a", site)], autoStartOrgs: {} });
  click("data-org-toggle", "");
  const pending = [];
  global.fetch = () => new Promise((res) => pending.push(res));
  const c1 = Org.setAutoStart(site, true);
  Org.setAutoStart(site, false);                                       // c2, never answers
  const c3 = Org.setAutoStart(site, true);
  pending[2]({ ok: true, status: 200 }); await c3;                     // on applied, newest
  pending[0]({ ok: true, status: 200 }); await c1;                     // c1's late OK
  assert.ok(autoIsOn(slot, site), "c2 is older than c3's OK: it must not show");
});

test("XERK-2598: a refused click in the middle keeps the older click's late answer in order", async () => {
  const site = "mid.atlassian.net";
  const { slot, click } = mountOrg();
  Org.update({ agents: [agent("a", site)], autoStartOrgs: {} });
  click("data-org-toggle", "");
  const pending = [];
  global.fetch = () => new Promise((res) => pending.push(res));
  const c1 = Org.setAutoStart(site, true);
  const c2 = Org.setAutoStart(site, false);
  pending[1]({ ok: false, status: 500 }); await c2;                    // refused while c1 in flight
  const c3 = Org.setAutoStart(site, false);
  pending[2]({ ok: true, status: 200 }); await c3;                     // off applied, newest
  pending[0]({ ok: true, status: 200 }); await c1;                     // c1 is older than c3
  assert.ok(!autoIsOn(slot, site));
});

test("XERK-2598: a polled snapshot landing mid-POST never throws the POST's OK away", async () => {
  const site = "poll.atlassian.net";
  const { slot, click } = mountOrg();
  const ag = [agent("a", site)];
  Org.update({ agents: ag, autoStartOrgs: {} });
  click("data-org-toggle", "");
  let release;
  global.fetch = () => new Promise((res) => { release = res; });
  const p = Org.setAutoStart(site, true);
  Org.update({ agents: ag, autoStartOrgs: {} });                       // a poll fetched before the hub applied it
  release({ ok: true, status: 200 });
  await p;
  assert.ok(autoIsOn(slot, site), "the OK is the newer word");
  global.fetch = () => Promise.resolve({ ok: false, status: 500 });
  await Org.setAutoStart(site, false);
  assert.ok(autoIsOn(slot, site), "and a refused click falls back to it");
});

test("XERK-2598: two lost clicks' re-reads land in click order, whatever order they arrive", async () => {
  const site = "h2.atlassian.net";
  const { slot, click } = mountOrg();
  Org.update({ agents: [agent("a", site)], autoStartOrgs: {} });
  click("data-org-toggle", "");
  const reads = [];
  global.fetch = (url) => url === "/api/agents" ? new Promise((res) => reads.push(res))
    : Promise.reject(new TypeError("network"));                       // both applied, both responses lost
  const c1 = Org.setAutoStart(site, true);
  await tick();
  const c2 = Org.setAutoStart(site, false);
  await tick();
  reads[1]({ ok: true, status: 200, json: async () => ({ autoStartOrgs: {} }) });
  await c2;
  reads[0]({ ok: true, status: 200, json: async () => ({ autoStartOrgs: { [site]: true } }) });  // older body
  await c1;
  assert.ok(!autoIsOn(slot, site));
});

test("XERK-2598: an older click's late OK never overwrites a newer click's re-read", async () => {
  const site = "okvsread.atlassian.net";
  const { slot, click } = mountOrg();
  Org.update({ agents: [agent("a", site)], autoStartOrgs: {} });
  click("data-org-toggle", "");
  let holdA, call = 0;
  global.fetch = (url) => {
    if (url === "/api/agents") return Promise.resolve({ ok: true, status: 200, json: async () => ({ autoStartOrgs: {} }) });
    return ++call === 1 ? new Promise((res) => { holdA = res; }) : Promise.reject(new TypeError("network"));
  };
  const a = Org.setAutoStart(site, true);                              // applied, 200 held
  await Org.setAutoStart(site, false);                                 // applied, lost; re-read says off
  holdA({ ok: true, status: 200 });
  await a;
  assert.ok(!autoIsOn(slot, site));
});

test("XERK-2598: an SSE frame BEFORE the re-read was asked doesn't void the re-read", async () => {
  const site = "rrgen.atlassian.net";
  const { slot, click } = mountOrg();
  Org.update({ agents: [agent("a", site)], autoStartOrgs: {} });
  click("data-org-toggle", "");
  const handlers = {};
  Org.sse({ addEventListener: (t, fn) => { handlers[t] = fn; } });
  let failPost;
  global.fetch = (url) => url === "/api/agents"
    ? Promise.resolve({ ok: true, status: 200, json: async () => ({ autoStartOrgs: { [site]: true } }) })
    : new Promise((_, rej) => { failPost = () => rej(new TypeError("network")); });
  const p = Org.setAutoStart(site, true);
  handlers.autoStartOrgs({ data: "{}" });                              // a frame from before the hub applied it
  failPost();
  await p;
  assert.ok(autoIsOn(slot, site), "the re-read, asked after the frame, is the newer word");
});

test("XERK-2598: an older click's re-read never outvotes a newer click's OK", async () => {
  const site = "rrmaxok.atlassian.net";
  const { slot, click } = mountOrg();
  Org.update({ agents: [agent("a", site)], autoStartOrgs: {} });
  click("data-org-toggle", "");
  const handlers = {};
  Org.sse({ addEventListener: (t, fn) => { handlers[t] = fn; } });
  let failA, okB, readA, call = 0;
  global.fetch = (url) => {
    if (url === "/api/agents") return new Promise((res) => { readA = res; });
    return ++call === 1 ? new Promise((_, rej) => { failA = () => rej(new TypeError("network")); })
      : new Promise((res) => { okB = () => res({ ok: true, status: 200 }); });
  };
  const a = Org.setAutoStart(site, true);
  const b = Org.setAutoStart(site, false);
  handlers.autoStartOrgs({ data: "{}" });                              // B's own frame: off
  failA(); await tick();                                               // A lost; its re-read is asked
  okB(); await b;                                                      // B's OK (voided by the frame)
  readA({ ok: true, status: 200, json: async () => ({ autoStartOrgs: { [site]: true } }) });
  await a;
  assert.ok(!autoIsOn(slot, site), "B is newer and the hub took it");
});

test("XERK-2598: a failed color pick repaints the control back", async () => {
  const { slot } = mountOrg();
  Org.update({ agents: [agent("a", "acme.atlassian.net")], orgColors: {} });
  const before = slot.innerHTML;
  global.fetch = () => Promise.resolve({ ok: false, status: 500 });
  await Org.setOrgColor("acme.atlassian.net", 5);
  assert.equal(slot.innerHTML, before);
});

test("XERK-2598: with the re-read failing too, a network-failed POST rolls back", async () => {
  const { slot, click } = mountOrg();
  Org.update({ agents: [agent("a", "acme.atlassian.net")], autoMergeOrgs: {} });
  click("data-org-toggle", "");
  global.fetch = () => Promise.reject(new TypeError("network"));
  await Org.setAutoMerge("acme.atlassian.net", true);
  assert.doesNotMatch(slot.innerHTML, /org-chip-merge on/);
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
  const html = nav.siteHeaderHtml("board");
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
