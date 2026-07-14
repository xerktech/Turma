// Unit tests for the "Clone from GitHub" bar's client logic (the inline script
// in public/index.html): search filtering, multi-select accumulation, the live
// selected-count, and the multi-repo batch clone. That code lives inline (not a
// require-able module like chat.js), so the harness loads the page's <script>
// body under lightweight browser-global stubs and drives the real functions —
// node:test, no npm, matching this package's zero-dependency stance.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Load the page's inline script into a sandbox with just enough of the DOM/
// timer/network surface stubbed that the module body runs to its definitions.
// Returns the clone functions plus hooks to observe render()/post() and set the
// module's `cache`, and a getElementById-backed element registry.
function loadCloneModule() {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const src = html.match(/<script>([\s\S]*?)<\/script>/)[1];

  const els = new Map();                 // id -> fake element (for updateCloneButton)
  const store = {};
  const g = {
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    document: {
      getElementById: (id) => els.get(id) || null,
      querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
      get activeElement() { return null; },
      createElement: () => ({ style: {}, dataset: {}, classList: { add() {}, remove() {} }, setAttribute() {}, appendChild() {} }),
      body: {}, title: "",
    },
    EventSource: function () { this.addEventListener = () => {}; this.close = () => {}; },
    fetch: () => Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve({ agents: [] }), text: () => Promise.resolve("") }),
    setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
    location: { pathname: "/", href: "" },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
  };
  g.window = g; g.globalThis = g;

  // Expose the pieces we test and give the test a way to observe post()/render()
  // and seed `cache`, then evaluate under the stubs.
  const exportTail = `
    ;globalThis.__clone = { cloneBar, clonePick, clonePickCount, cloneRepo, cloneSearch, cloneText, updateCloneButton, cloneDraft, hostId };
    globalThis.__setRender = (f) => { render = f; };
    globalThis.__setPost = (f) => { post = f; };
    globalThis.__setCache = (c) => { cache = c; };
  `;
  const fn = new Function(
    "localStorage", "document", "window", "EventSource", "fetch",
    "setInterval", "clearInterval", "setTimeout", "clearTimeout", "location", "matchMedia", "globalThis",
    src + exportTail
  );
  fn(g.localStorage, g.document, g.window, g.EventSource, g.fetch,
     g.setInterval, g.clearInterval, g.setTimeout, g.clearTimeout, g.location, g.matchMedia, g);

  const api = g.__clone;
  const posts = [];
  g.__setRender(() => {});                       // suppress DOM re-render side-effects
  g.__setPost((url, body) => { posts.push({ url, body }); return Promise.resolve(); });
  return { ...api, posts, els, setCache: g.__setCache };
}

// A host with GitHub creds and a handful of repos, one of which is already
// present locally (so it should render disabled).
function sampleAgent() {
  return {
    key: "host1", online: true, repos: [{ name: "already" }],
    github: {
      available: true, login: "me", repos: [
        { name: "alpha", nameWithOwner: "me/alpha", isPrivate: false },
        { name: "beta", nameWithOwner: "me/beta", isPrivate: true },
        { name: "already", nameWithOwner: "me/already", isPrivate: false },
        { name: "gamma", nameWithOwner: "org/gamma", isPrivate: false },
      ],
    },
  };
}

test("cloneBar: renders a search box + one checkbox per repo, already-present disabled", () => {
  const m = loadCloneModule();
  const a = sampleAgent();
  m.setCache({ agents: [a] });
  const html = m.cloneBar(a);
  assert.ok(html.includes(`clone-search-${m.hostId(a.key)}`), "has a search input");
  assert.equal((html.match(/type="checkbox"/g) || []).length, 4, "one checkbox per repo");
  // The already-present repo is disabled and annotated.
  assert.match(html.replace(/\s+/g, " "), /me\/already.*already here/);
  assert.match(html, /me\/beta 🔒/, "private repos get a lock");
});

test("cloneBar: search box filters the list case-insensitively", () => {
  const m = loadCloneModule();
  const a = sampleAgent();
  m.setCache({ agents: [a] });
  m.cloneDraft.set(a.key, { search: "ME/" });
  const html = m.cloneBar(a);
  assert.ok(html.includes("me/alpha"), "keeps matches");
  assert.ok(!html.includes("org/gamma"), "drops non-matches");
  // No matches → an explanatory row, no checkboxes.
  m.cloneDraft.set(a.key, { search: "zzz" });
  const none = m.cloneBar(a);
  assert.ok(!none.includes('type="checkbox"'), "no checkboxes when nothing matches");
  assert.match(none, /No repos match/);
});

test("clonePick / clonePickCount: accumulate selections plus the free-text box", () => {
  const m = loadCloneModule();
  const a = sampleAgent();
  m.setCache({ agents: [a] });
  assert.equal(m.clonePickCount(a.key), 0);
  m.clonePick(a.key, "me/alpha", true);
  m.clonePick(a.key, "org/gamma", true);
  assert.equal(m.clonePickCount(a.key), 2, "two checked");
  m.clonePick(a.key, "org/gamma", false);
  assert.equal(m.clonePickCount(a.key), 1, "unchecking removes it");
  m.cloneText(a.key, "foo/bar");
  assert.equal(m.clonePickCount(a.key), 2, "free-text counts as one more");
  m.cloneText(a.key, "   ");
  assert.equal(m.clonePickCount(a.key), 1, "blank free-text does not count");
});

test("updateCloneButton: reflects the live count on the button + count span", () => {
  const m = loadCloneModule();
  const a = sampleAgent();
  m.setCache({ agents: [a] });
  const hid = m.hostId(a.key);
  const btn = { textContent: "", disabled: false, dataset: { off: "0" } };
  const cnt = { textContent: "" };
  m.els.set("clone-btn-" + hid, btn);
  m.els.set("clone-count-" + hid, cnt);
  m.clonePick(a.key, "me/alpha", true);       // clonePick calls updateCloneButton
  assert.equal(btn.textContent, "Clone");
  assert.equal(btn.disabled, false);
  assert.equal(cnt.textContent, "1 selected");
  m.clonePick(a.key, "me/beta", true);
  assert.equal(btn.textContent, "Clone 2");
  assert.equal(cnt.textContent, "2 selected");
  // Clearing all selections re-disables the button.
  m.clonePick(a.key, "me/alpha", false);
  m.clonePick(a.key, "me/beta", false);
  assert.equal(btn.disabled, true);
  assert.equal(cnt.textContent, "");
});

test("cloneRepo: fires one POST per selected repo plus the free-text box, then clears the draft", () => {
  const m = loadCloneModule();
  const a = sampleAgent();
  m.setCache({ agents: [a] });
  m.clonePick(a.key, "me/alpha", true);
  m.clonePick(a.key, "org/gamma", true);
  m.cloneText(a.key, "foo/bar");
  m.cloneRepo(a.key);
  assert.equal(m.posts.length, 3, "one clone POST per selection + free-text");
  assert.deepEqual(m.posts.map((p) => p.body.repo).sort(), ["foo/bar", "me/alpha", "org/gamma"]);
  assert.ok(m.posts.every((p) => p.url === "/api/agents/host1/clone"), "all hit the clone endpoint");
  assert.deepEqual(m.cloneDraft.get(a.key), {}, "draft cleared after cloning");
});

test("cloneRepo: no selection and empty box is a no-op", () => {
  const m = loadCloneModule();
  const a = sampleAgent();
  m.setCache({ agents: [a] });
  m.cloneRepo(a.key);
  assert.equal(m.posts.length, 0);
});

test("cloneBar: a host with no GitHub creds renders greyed out with no picker", () => {
  const m = loadCloneModule();
  const bare = { key: "h2", online: true, repos: [], github: { available: false } };
  m.setCache({ agents: [bare] });
  const html = m.cloneBar(bare);
  assert.match(html, /cloning unavailable/);
  assert.ok(!html.includes('type="checkbox"'), "no picker when creds are absent");
});
